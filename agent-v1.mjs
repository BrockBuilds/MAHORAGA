#!/usr/bin/env node

/**
 * Mahoraga v1 - Simple Trading Agent
 * 
 * COPY THIS FILE and modify it for your own strategy.
 * 
 * The file has three sections:
 * 
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  SECTION 1: DATA SOURCE (line ~150)                             │
 * │  - StockTwitsAgent class - fetches sentiment data               │
 * │  - CUSTOMIZE: Add Reddit, Twitter, news APIs, etc.              │
 * ├─────────────────────────────────────────────────────────────────┤
 * │  SECTION 2: TRADING STRATEGY (line ~380)                        │
 * │  - runTradingLogic() method - decides when to buy/sell          │
 * │  - CUSTOMIZE: Change buy/sell rules, add indicators, etc.       │
 * ├─────────────────────────────────────────────────────────────────┤
 * │  SECTION 3: HARNESS (line ~450+)                                │
 * │  - MCP connection, order execution, dashboard API               │
 * │  - PROBABLY DON'T TOUCH unless you know what you're doing       │
 * └─────────────────────────────────────────────────────────────────┘
 * 
 * MIT License - Free for personal and commercial use
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables from .dev.vars
function loadEnvFile() {
  const envPath = path.join(__dirname, ".dev.vars");
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const [key, ...valueParts] = trimmed.split("=");
        const value = valueParts.join("=").trim();
        if (key && value && !process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
}

loadEnvFile();

// ============================================================================
// Configuration
// ============================================================================

const CONFIG_PATH = path.join(process.cwd(), "agent-config.json");
const LOG_PATH = path.join(process.cwd(), "agent-logs.json");

const DEFAULT_CONFIG = {
  mcp_url: process.env.MCP_URL || "http://localhost:8787/mcp",

  // Polling intervals
  data_poll_interval_ms: 60_000,      // Data gatherer polls every 60s
  analyst_interval_ms: 120_000,        // Trading logic runs every 2 min

  // Trading parameters
  max_position_value: 2000,            // Max $ per position
  max_positions: 3,                    // Max concurrent positions
  min_sentiment_score: 0.4,            // Minimum bullish sentiment to buy
  min_volume: 10,                      // Minimum message volume

  // Risk management
  take_profit_pct: 8,                  // Auto-sell at this % profit
  stop_loss_pct: 4,                    // Auto-sell at this % loss
  trailing_stop_pct: 0,                // Trailing stop (0 = disabled, e.g., 5 = 5% trailing)
  position_size_pct_of_cash: 20,       // Max % of cash per position
  volatility_scaling: false,           // Scale positions by volatility (ATR-based)
  atr_period: 14,                      // ATR period for volatility calculation
  max_volatility_pct: 5,               // Max ATR % of price for position sizing

  // Drawdown limits
  daily_loss_limit_pct: 2,             // Stop trading after X% daily loss
  weekly_loss_limit_pct: 5,            // Stop trading after X% weekly loss
  monthly_loss_limit_pct: 10,          // Stop trading after X% monthly loss

  // Account config
  starting_equity: 100000,             // Starting equity for P&L calculation
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      return { ...DEFAULT_CONFIG, ...saved };
    }
  } catch (e) {
    console.error("Failed to load config:", e.message);
  }
  return DEFAULT_CONFIG;
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ============================================================================
// Activity Logger
// ============================================================================

class ActivityLogger {
  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
    this.entries = [];
    this.costTracker = { total_usd: 0, calls: 0, tokens_in: 0, tokens_out: 0 };
    this.drawdownTracking = {
      daily: { startEquity: null, startDate: null, peakEquity: null },
      weekly: { startEquity: null, startDate: null, peakEquity: null },
      monthly: { startEquity: null, startDate: null, peakEquity: null },
    };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(LOG_PATH)) {
        const data = JSON.parse(fs.readFileSync(LOG_PATH, "utf-8"));
        this.entries = data.entries || [];
        this.costTracker = data.costTracker || this.costTracker;
        this.drawdownTracking = data.drawdownTracking || this.drawdownTracking;
      }
    } catch (e) {
      console.error("Failed to load logs:", e.message);
    }
  }

  save() {
    const data = {
      entries: this.entries.slice(-this.maxEntries),
      costTracker: this.costTracker,
      drawdownTracking: this.drawdownTracking,
    };
    fs.writeFileSync(LOG_PATH, JSON.stringify(data, null, 2));
  }

  log(agent, action, details = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      agent,
      action,
      ...details,
    };
    this.entries.push(entry);
    console.log(`[${entry.timestamp}] [${agent}] ${action}`, details.symbol ? `(${details.symbol})` : "");

    if (this.entries.length % 10 === 0) {
      this.save();
    }
    return entry;
  }

  getRecentLogs(limit = 50) {
    return this.entries.slice(-limit);
  }

  getCosts() {
    return this.costTracker;
  }

  // Drawdown tracking
  initDrawdownTracking(equity) {
    const now = new Date();
    const today = now.toISOString().split("T")[0];
    const weekStart = this.getWeekStart(now);
    const monthStart = this.getMonthStart(now);

    // Initialize if new period
    if (this.drawdownTracking.daily.startDate !== today) {
      this.drawdownTracking.daily = { startEquity: equity, startDate: today, peakEquity: equity };
    }
    if (this.drawdownTracking.weekly.startDate !== weekStart) {
      this.drawdownTracking.weekly = { startEquity: equity, startDate: weekStart, peakEquity: equity };
    }
    if (this.drawdownTracking.monthly.startDate !== monthStart) {
      this.drawdownTracking.monthly = { startEquity: equity, startDate: monthStart, peakEquity: equity };
    }

    // Update peak equity
    this.drawdownTracking.daily.peakEquity = Math.max(this.drawdownTracking.daily.peakEquity, equity);
    this.drawdownTracking.weekly.peakEquity = Math.max(this.drawdownTracking.weekly.peakEquity, equity);
    this.drawdownTracking.monthly.peakEquity = Math.max(this.drawdownTracking.monthly.peakEquity, equity);
  }

  getDrawdownPct(period, currentEquity) {
    const tracking = this.drawdownTracking[period];
    if (!tracking || !tracking.peakEquity || tracking.peakEquity === 0) return 0;
    return ((tracking.peakEquity - currentEquity) / tracking.peakEquity) * 100;
  }

  getWeekStart(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    return d.toISOString().split("T")[0];
  }

  getMonthStart(date) {
    return date.toISOString().slice(0, 7) + "-01";
  }
}

// ============================================================================
// ============================================================================
//
//   SECTION 1: DATA SOURCE
//
//   This is where signals come from. Currently uses StockTwits (free, no API key).
//   
//   TO CUSTOMIZE: Add your own data sources here. Examples:
//   - News APIs (NewsAPI, Polygon, Alpha Vantage)
//   - Your own proprietary signals
//
//   Each source should return signals in this format:
//   { symbol, source, sentiment (-1 to 1), volume, reason }
//
// ============================================================================
// ============================================================================

class StockTwitsAgent {
  constructor(logger) {
    this.logger = logger;
    this.name = "StockTwits";
  }

  async getTrending() {
    try {
      const res = await fetch("https://api.stocktwits.com/api/2/trending/symbols.json");
      if (!res.ok) return [];
      const data = await res.json();
      this.logger.log(this.name, "fetched_trending", { count: data.symbols?.length || 0 });
      return data.symbols || [];
    } catch (err) {
      this.logger.log(this.name, "error", { message: err.message });
      return [];
    }
  }

  async getStream(symbol) {
    try {
      const res = await fetch(`https://api.stocktwits.com/api/2/streams/symbol/${symbol}.json?limit=30`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.messages || [];
    } catch (err) {
      return [];
    }
  }

  analyzeSentiment(messages) {
    let bullish = 0, bearish = 0;
    
    for (const msg of messages) {
      const sentiment = msg.entities?.sentiment?.basic;
      if (sentiment === "Bullish") bullish++;
      else if (sentiment === "Bearish") bearish++;
    }
    
    const total = messages.length;
    return {
      bullish,
      bearish,
      total,
      score: total > 0 ? (bullish - bearish) / total : 0,
    };
  }

  async gatherSignals() {
    const signals = [];
    const trending = await this.getTrending();
    
    for (const sym of trending.slice(0, 10)) {
      const messages = await this.getStream(sym.symbol);
      const sentiment = this.analyzeSentiment(messages);
      
      if (sentiment.total >= 5) {
        signals.push({
          symbol: sym.symbol,
          source: "stocktwits",
          sentiment: sentiment.score,
          volume: sentiment.total,
          bullish: sentiment.bullish,
          bearish: sentiment.bearish,
          reason: `StockTwits: ${sentiment.bullish}B/${sentiment.bearish}b (${(sentiment.score * 100).toFixed(0)}%)`,
        });
      }
      await sleep(300);
    }
    
    this.logger.log(this.name, "gathered_signals", { count: signals.length });
    return signals;
  }
}

// ============================================================================
// Reddit Agent (Multi-Source Sentiment)
// ============================================================================

class RedditAgent {
  constructor(logger) {
    this.logger = logger;
    this.name = "Reddit";
    this.subreddits = ["wallstreetbets", "stocks", "investing", "options"];
  }

  // Basic keyword matching for sentiment (no API key needed)
  async fetchSubredditPosts(subreddit, keywords, limit = 25) {
    try {
      // Use Reddit's public JSON API
      const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${encodeURIComponent(keywords.join(" OR "))}&restrict_sr=true&limit=${limit}&sort=hot`;
      const res = await fetch(url, {
        headers: { "User-Agent": "MahoragaTradingAgent/1.0" },
      });

      if (!res.ok) return [];
      const data = await res.json();
      return data.data?.children || [];
    } catch (err) {
      this.logger.log(this.name, "error", { subreddit, message: err.message });
      return [];
    }
  }

  async searchSymbol(symbol) {
    // Search for symbol mentions across subreddits
    const results = [];

    for (const sub of this.subreddits) {
      const posts = await this.fetchSubredditPosts(sub, [symbol, `$${symbol}`], 20);
      results.push(...posts.map(p => ({
        subreddit: sub,
        title: p.data?.title || "",
        selftext: p.data?.selftext || "",
        score: p.data?.score || 0,
        num_comments: p.data?.num_comments || 0,
        created_utc: p.data?.created_utc,
      })));
      await sleep(200); // Rate limit
    }

    return results;
  }

  analyzeSentimentFromPosts(posts) {
    const bullishTerms = ["bullish", "long", "buy", "call", "moon", "rip", "up", "gain", "profit", "breakout"];
    const bearishTerms = ["bearish", "short", "put", "dump", "crash", "dead", "down", "loss", "sell", "breakdown"];

    let bullish = 0, bearish = 0;
    let totalScore = 0;

    for (const post of posts) {
      const text = `${post.title} ${post.selftext}`.toLowerCase();
      const score = Math.log10(Math.max(1, post.score + 1)); // Log scale for score weight

      let postBullish = 0, postBearish = 0;
      for (const term of bullishTerms) if (text.includes(term)) postBullish++;
      for (const term of bearishTerms) if (text.includes(term)) postBearish++;

      if (postBullish > postBearish) bullish += score;
      else if (postBearish > postBullish) bearish += score;

      totalScore += score;
    }

    const total = totalScore || 1;
    return {
      bullish,
      bearish,
      total_posts: posts.length,
      score: (bullish - bearish) / Math.sqrt(total), // Normalized sentiment score
    };
  }

  async gatherSignals() {
    // Get trending tickers from StockTwits first, then search Reddit
    // This avoids searching for every stock blindly
    const signals = [];
    const testedSymbols = new Set();

    // Fetch a small sample of trending stocks to test on Reddit
    const stocktwits = new StockTwitsAgent(this.logger);
    const trending = await stocktwits.getTrending();

    for (const sym of trending.slice(0, 10)) {
      const symbol = sym.symbol;
      if (testedSymbols.has(symbol)) continue;
      testedSymbols.add(symbol);

      const posts = await this.searchSymbol(symbol);
      if (posts.length < 3) continue; // Need some discussion

      const sentiment = this.analyzeSentimentFromPosts(posts);

      if (posts.length >= 3) {
        signals.push({
          symbol: symbol,
          source: "reddit",
          sentiment: sentiment.score,
          volume: posts.length,
          bullish: Math.round(sentiment.bullish),
          bearish: Math.round(sentiment.bearish),
          reason: `Reddit: ${posts.length} posts, ${sentiment.bullish.toFixed(1)}B/${sentiment.bearish.toFixed(1)}b`,
          subreddits: [...new Set(posts.map(p => p.subreddit))].join(","),
        });
      }

      await sleep(300);
    }

    this.logger.log(this.name, "gathered_signals", { count: signals.length });
    return signals;
  }
}

// ============================================================================
// LLM Analysis
// ============================================================================

class LLMAnalyzer {
  constructor(logger, apiKey = null) {
    this.logger = logger;
    this.apiKey = apiKey || process.env.OPENAI_API_KEY;
    this.name = "LLMAnalyzer";
    this.model = "gpt-4o-mini";
    this.cache = new Map(); // symbol -> { result, timestamp }
    this.cacheDuration = 300_000; // 5 minutes
  }

  isConfigured() {
    return !!this.apiKey;
  }

  async analyzeSignal(signal, technicals = null) {
    const cacheKey = signal.symbol;
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.cacheDuration) {
      this.logger.log(this.name, "cache_hit", { symbol: signal.symbol });
      return cached.result;
    }

    if (!this.isConfigured()) {
      this.logger.log(this.name, "not_configured", { symbol: signal.symbol });
      return null;
    }

    // Build technical context
    let technicalContext = "";
    if (technicals) {
      technicalContext = `
TECHNICAL INDICATORS:
- RSI: ${technicals.rsi?.toFixed(2) || "N/A"} (${this.interpretRsi(technicals.rsi)})
- MACD: ${technicals.macd?.toFixed(2) || "N/A"} (${this.interpretMacd(technicals.macd, technicals.macd_signal)})
- ATR %: ${technicals.atr_pct?.toFixed(2) || "N/A"}% (volatility)
- Price vs 50 SMA: ${this.priceVsSma(technicals.price, technicals.sma_50)}%
- Volume: ${technicals.volume?.toFixed(0) || "N/A"}
`;
    }

    const prompt = `Analyze this trading signal and provide a recommendation.

IMPORTANT: You must identify counterarguments before making a decision. Trading against the crowd can be profitable, but you need to understand what the bears are thinking.

SENTIMENT DATA:
- Symbol: ${signal.symbol}
- Source: ${signal.source}
- Bullish messages: ${signal.bullish}
- Bearish messages: ${signal.bearish}
- Sentiment score: ${(signal.sentiment * 100).toFixed(0)}% (range: -100% to +100%)
- Message volume: ${signal.volume}
- Sentiment reason: ${signal.reason}
${technicalContext}

YOUR TASK:
1. First, identify 2-3 BEARISH arguments for this symbol (even if sentiment is bullish)
2. Identify 2-3 BULLISH arguments for this symbol (even if sentiment is bearish)
3. Weigh the evidence and make a final decision

Respond with a JSON object (no markdown, just the JSON):
{
  "bullish_arguments": ["arg1", "arg2", "arg3"],
  "bearish_arguments": ["arg1", "arg2", "arg3"],
  "decision": "BUY" | "SKIP" | "WAIT",
  "confidence": 0.0 to 1.0,
  "reasoning": "2-3 sentence summary weighing both sides",
  "risks": "key risks to consider"
}

Guidelines:
- If sentiment is strongly bullish (>70%), the bearish arguments should be especially compelling to override
- If sentiment is mixed or slightly bullish, look for confirmation from technicals
- SKIP if you cannot find enough information to make a confident decision
- WAIT if the timing seems wrong but the thesis is sound`;

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3,
          max_tokens: 200,
        }),
      });

      if (!response.ok) {
        this.logger.log(this.name, "api_error", { symbol: signal.symbol, status: response.status });
        return null;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;

      if (!content) {
        return null;
      }

      // Parse JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.logger.log(this.name, "parse_error", { symbol: signal.symbol, content });
        return null;
      }

      const result = JSON.parse(jsonMatch[0]);

      // Cache the result
      this.cache.set(cacheKey, { result, timestamp: Date.now() });

      this.logger.log(this.name, "analyzed", {
        symbol: signal.symbol,
        decision: result.decision,
        confidence: result.confidence,
        bullish_args_count: result.bullish_arguments?.length || 0,
        bearish_args_count: result.bearish_arguments?.length || 0,
        reasoning: result.reasoning,
      });

      return result;
    } catch (err) {
      this.logger.log(this.name, "error", { symbol: signal.symbol, error: err.message });
      return null;
    }
  }

  interpretRsi(rsi) {
    if (!rsi) return "N/A";
    if (rsi > 70) return "overbought";
    if (rsi < 30) return "oversold";
    if (rsi > 50) return "bullish";
    if (rsi < 50) return "bearish";
    return "neutral";
  }

  interpretMacd(macd, signal) {
    if (!macd || !signal) return "N/A";
    const diff = macd - signal;
    if (diff > 0) return "bullish crossover";
    if (diff < 0) return "bearish";
    return "neutral";
  }

  priceVsSma(price, sma) {
    if (!price || !sma) return 0;
    return ((price - sma) / sma) * 100;
  }
}

// ============================================================================
// Trading Executor
// ============================================================================

class TradingExecutor {
  constructor(mcpClient, logger, config) {
    this.mcp = mcpClient;
    this.logger = logger;
    this.config = config;
    this.name = "Executor";
    this.lastTrades = new Map();
  }

  async callTool(name, args = {}) {
    const result = await this.mcp.callTool({ name, arguments: args });
    return JSON.parse(result.content[0].text);
  }

  async executeBuy(symbol, confidence, reasonText = "") {
    // Cooldown check (5 min)
    const lastTrade = this.lastTrades.get(symbol);
    if (lastTrade && Date.now() - lastTrade < 300_000) {
      this.logger.log(this.name, "skipped_cooldown", { symbol });
      return null;
    }

    const account = await this.callTool("accounts-get");
    if (!account.ok) return null;

    // Calculate position size
    const sizePct = this.config.position_size_pct_of_cash;
    const positionSize = Math.min(
      account.data.cash * (sizePct / 100) * confidence,
      this.config.max_position_value
    );

    if (positionSize < 100) {
      this.logger.log(this.name, "skipped_size", { symbol, size: positionSize });
      return null;
    }

    this.logger.log(this.name, "preview_buy", { symbol, size: positionSize.toFixed(2) });

    const preview = await this.callTool("orders-preview", {
      symbol,
      side: "buy",
      notional: Math.round(positionSize * 100) / 100,
      order_type: "market",
      time_in_force: "day",
    });

    if (!preview.ok) {
      this.logger.log(this.name, "preview_failed", { symbol, error: preview.error?.message });
      return null;
    }

    if (!preview.data.policy.allowed) {
      const violationMsgs = (preview.data.policy.violations || []).map(v => v.message || v.rule).join("; ");
      this.logger.log(this.name, "policy_rejected", { symbol, violations: violationMsgs });
      return null;
    }

    const submit = await this.callTool("orders-submit", {
      approval_token: preview.data.policy.approval_token,
    });

    if (submit.ok) {
      this.lastTrades.set(symbol, Date.now());
      this.logger.log(this.name, "buy_executed", {
        symbol,
        status: submit.data.order.status,
        size: positionSize.toFixed(2),
        reason: reasonText,
      });
      return submit.data.order;
    } else {
      this.logger.log(this.name, "buy_failed", { symbol, error: submit.error?.message });
      return null;
    }
  }

  async executeSell(symbol, reason) {
    this.logger.log(this.name, "sell_initiated", { symbol, reason });
    
    const result = await this.callTool("positions-close", { symbol });
    
    if (result.ok) {
      this.logger.log(this.name, "sell_executed", { symbol, reason });
      return result.data.order;
    } else {
      this.logger.log(this.name, "sell_failed", { symbol, error: result.error?.message });
      return null;
    }
  }
}

// ============================================================================
// Main Orchestrator
// ============================================================================

class SimpleOrchestrator {
  constructor() {
    this.config = loadConfig();
    this.logger = new ActivityLogger();
    this.signalCache = [];
    this.lastAnalystRun = 0;

    // Position tracking for trailing stops and volatility
    this.positionTracking = new Map(); // symbol -> { entryPrice, peakPrice, avgPrice, lastQuote }

    this.stocktwits = new StockTwitsAgent(this.logger);
    this.reddit = new RedditAgent(this.logger);
    this.llmAnalyzer = new LLMAnalyzer(this.logger);
    this.executor = null;
    this.mcp = null;
  }

  async connect() {
    const url = this.config.mcp_url;
    console.log(`Connecting to MCP server at ${url}...`);
    
    try {
      const transport = new SSEClientTransport(new URL(url));
      this.mcp = new Client({ name: "mahoraga-v1", version: "1.0" }, { capabilities: {} });
      await this.mcp.connect(transport);
      this.executor = new TradingExecutor(this.mcp, this.logger, this.config);
      this.logger.log("System", "connected", { url });
      return true;
    } catch (err) {
      console.error("Connection error:", err);
      this.logger.log("System", "connection_failed", { error: err.message });
      return false;
    }
  }

  async getAccountState() {
    const [account, positions, clock] = await Promise.all([
      this.executor.callTool("accounts-get"),
      this.executor.callTool("positions-list"),
      this.executor.callTool("market-clock"),
    ]);
    return {
      account: account.ok ? account.data : null,
      positions: positions.ok ? positions.data.positions : [],
      clock: clock.ok ? clock.data : null,
    };
  }

  async runDataGatherers() {
    this.logger.log("System", "gathering_data from all sources");

    // Gather in parallel
    const [stocktwitsSignals, redditSignals] = await Promise.all([
      this.stocktwits.gatherSignals(),
      this.reddit.gatherSignals(),
    ]);

    // Merge signals by symbol, averaging sentiment
    const mergedSignals = new Map();

    // Add StockTwits signals
    for (const sig of stocktwitsSignals) {
      mergedSignals.set(sig.symbol, { ...sig, sources: ["stocktwits"] });
    }

    // Add Reddit signals, merging with existing
    for (const sig of redditSignals) {
      if (mergedSignals.has(sig.symbol)) {
        const existing = mergedSignals.get(sig.symbol);
        // Average the sentiment scores
        const combinedSentiment = (existing.sentiment + sig.sentiment) / 2;
        existing.sentiment = combinedSentiment;
        existing.sources.push("reddit");
        existing.reason += ` | Reddit: ${sig.bullish}B/${sig.bearish}b`;
      } else {
        mergedSignals.set(sig.symbol, { ...sig, sources: ["reddit"] });
      }
    }

    this.signalCache = Array.from(mergedSignals.values());

    // Cleanup stale position tracking (positions no longer held)
    const { positions } = await this.getAccountState();
    const heldSymbols = new Set(positions.map(p => p.symbol));
    for (const symbol of this.positionTracking.keys()) {
      if (!heldSymbols.has(symbol)) {
        this.positionTracking.delete(symbol);
      }
    }

    this.logger.log("System", "data_gathered", {
      stocktwits: stocktwitsSignals.length,
      reddit: redditSignals.length,
      total: this.signalCache.length,
    });

    return this.signalCache;
  }

  // ==========================================================================
  // ==========================================================================
  //
  //   SECTION 2: TRADING STRATEGY  
  //
  //   This is the brain - decides when to buy and sell.
  //
  //   TO CUSTOMIZE:
  //   - Change the buy conditions (sentiment thresholds, volume, etc.)
  //   - Change the sell conditions (take profit, stop loss, etc.)
  //   - Add technical indicators using MCP's "technicals-get" tool
  //   - Add LLM analysis using MCP's "symbol-research" tool
  //   - Require multiple data sources to agree before trading
  //
  // ==========================================================================
  // ==========================================================================

  async runTradingLogic() {
    const { account, positions, clock } = await this.getAccountState();

    if (!account) {
      this.logger.log("System", "skipped_trading", { reason: "No account data" });
      return { allowed: false, reason: "No account data" };
    }

    if (!clock?.is_open) {
      this.logger.log("System", "market_closed");
      return { allowed: false, reason: "Market closed" };
    }

    // Initialize drawdown tracking if needed
    this.logger.initDrawdownTracking(account.equity);

    // Check drawdown limits
    const dailyDrawdown = this.logger.getDrawdownPct("daily", account.equity);
    const weeklyDrawdown = this.logger.getDrawdownPct("weekly", account.equity);
    const monthlyDrawdown = this.logger.getDrawdownPct("monthly", account.equity);

    if (dailyDrawdown >= this.config.daily_loss_limit_pct) {
      this.logger.log("System", "trading_paused_daily_drawdown", {
        drawdown: dailyDrawdown.toFixed(2),
        limit: this.config.daily_loss_limit_pct,
      });
      return { allowed: false, reason: `Daily drawlimit hit: ${dailyDrawdown.toFixed(2)}%` };
    }

    if (weeklyDrawdown >= this.config.weekly_loss_limit_pct) {
      this.logger.log("System", "trading_paused_weekly_drawdown", {
        drawdown: weeklyDrawdown.toFixed(2),
        limit: this.config.weekly_loss_limit_pct,
      });
      return { allowed: false, reason: `Weekly drawlimit hit: ${weeklyDrawdown.toFixed(2)}%` };
    }

    if (monthlyDrawdown >= this.config.monthly_loss_limit_pct) {
      this.logger.log("System", "trading_paused_monthly_drawdown", {
        drawdown: monthlyDrawdown.toFixed(2),
        limit: this.config.monthly_loss_limit_pct,
      });
      return { allowed: false, reason: `Monthly drawlimit hit: ${monthlyDrawdown.toFixed(2)}%` };
    }

    const heldSymbols = new Set(positions.map(p => p.symbol));

    // ========================================================================
    // STEP 1: Check existing positions for exit signals
    // ========================================================================
    for (const pos of positions) {
      // Update position tracking
      let tracking = this.positionTracking.get(pos.symbol);
      if (!tracking) {
        tracking = {
          entryPrice: pos.avg_entry_price,
          peakPrice: pos.avg_entry_price,
          entryTime: Date.now(),
        };
        this.positionTracking.set(pos.symbol, tracking);
      }

      // Get current quote for trailing stop
      const quoteResult = await this.executor.callTool("market-quote", { symbol: pos.symbol });
      const currentPrice = quoteResult.ok ? quoteResult.data.price : pos.current_price;
      tracking.peakPrice = Math.max(tracking.peakPrice, currentPrice);

      const plPct = (pos.unrealized_pl / (pos.market_value - pos.unrealized_pl)) * 100;

      // Trailing stop check
      if (this.config.trailing_stop_pct > 0 && currentPrice > tracking.entryPrice) {
        const trailingDistancePct = ((tracking.peakPrice - currentPrice) / tracking.peakPrice) * 100;
        if (trailingDistancePct >= this.config.trailing_stop_pct) {
          this.logger.log("System", "trailing_stop_triggered", {
            symbol: pos.symbol,
            peakPrice: tracking.peakPrice.toFixed(2),
            currentPrice: currentPrice.toFixed(2),
            trailingDrop: trailingDistancePct.toFixed(2),
          });
          await this.executor.executeSell(pos.symbol, `Trailing stop at -${this.config.trailing_stop_pct}% from peak`);
          this.positionTracking.delete(pos.symbol);
          continue;
        }
      }

      // Take profit
      if (plPct >= this.config.take_profit_pct) {
        this.logger.log("System", "take_profit_triggered", { symbol: pos.symbol, pnl: plPct.toFixed(2) });
        await this.executor.executeSell(pos.symbol, `Take profit at +${plPct.toFixed(1)}%`);
        this.positionTracking.delete(pos.symbol);
        continue;
      }

      // Stop loss
      if (plPct <= -this.config.stop_loss_pct) {
        this.logger.log("System", "stop_loss_triggered", { symbol: pos.symbol, pnl: plPct.toFixed(2) });
        await this.executor.executeSell(pos.symbol, `Stop loss at ${plPct.toFixed(1)}%`);
        this.positionTracking.delete(pos.symbol);
        continue;
      }
    }

    // ========================================================================
    // STEP 2: Look for new buy opportunities
    // ========================================================================
    if (positions.length >= this.config.max_positions) {
      this.logger.log("System", "max_positions_reached", { count: positions.length });
      return { allowed: true, paused: "max_positions" };
    }

    // Filter signals to find buy candidates
    const buyCandidates = this.signalCache
      .filter(s => !heldSymbols.has(s.symbol))
      .filter(s => s.sentiment >= this.config.min_sentiment_score)
      .filter(s => s.volume >= this.config.min_volume)
      .sort((a, b) => b.sentiment - a.sentiment);

    this.logger.log("System", "buy_candidates", { count: buyCandidates.length });

    // Try to buy top candidates
    for (const signal of buyCandidates.slice(0, 3)) {
      if (positions.length >= this.config.max_positions) break;

      // Get technical indicators for LLM analysis
      let technicals = null;
      try {
        const techResult = await this.executor.callTool("technicals-get", {
          symbol: signal.symbol,
          timeframe: "1Day",
        });
        if (techResult.ok) {
          technicals = techResult.data;
        }
      } catch (err) {
        this.logger.log("System", "technicals_fetch_failed", { symbol: signal.symbol, error: err.message });
      }

      // Use LLM analysis if available, otherwise fall back to sentiment
      let llmDecision = null;
      let confidence = Math.min(1, Math.max(0.5, signal.sentiment + 0.3));
      let useLlm = false;

      if (this.llmAnalyzer.isConfigured()) {
        llmDecision = await this.llmAnalyzer.analyzeSignal(signal, technicals);

        if (llmDecision) {
          useLlm = true;
          // Use LLM decision and confidence
          if (llmDecision.decision === "SKIP") {
            this.logger.log("System", "llm_skipped", {
              symbol: signal.symbol,
              reasoning: llmDecision.reasoning,
            });
            continue; // Skip this candidate
          }

          // Use LLM confidence if available, otherwise use sentiment-based
          if (llmDecision.confidence !== undefined) {
            confidence = llmDecision.confidence;
          }

          this.logger.log("System", "llm_analyzed", {
            symbol: signal.symbol,
            decision: llmDecision.decision,
            confidence: confidence.toFixed(2),
            reasoning: llmDecision.reasoning,
          });
        }
      }

      // Apply volatility-based position sizing
      let volatilityMultiplier = 1;
      if (this.config.volatility_scaling && technicals?.atr_pct) {
        const atrPct = technicals.atr_pct;
        if (atrPct > this.config.max_volatility_pct) {
          volatilityMultiplier = this.config.max_volatility_pct / atrPct;
          confidence *= volatilityMultiplier;
          this.logger.log("System", "volatility_adjustment", {
            symbol: signal.symbol,
            atrPct: atrPct.toFixed(2),
            multiplier: volatilityMultiplier.toFixed(2),
          });
        }
      }

      this.logger.log("System", "considering_buy", {
        symbol: signal.symbol,
        sentiment: signal.sentiment.toFixed(2),
        volume: signal.volume,
        confidence: confidence.toFixed(2),
        useLlm,
        llmDecision: llmDecision?.decision || null,
      });

      const result = await this.executor.executeBuy(signal.symbol, confidence, signal.reason);

      if (result) {
        heldSymbols.add(signal.symbol);
        // Don't spam - one buy per cycle
        break;
      }
    }

    this.lastAnalystRun = Date.now();
    return { allowed: true };
  }

  // ==========================================================================
  // ==========================================================================
  //
  //   SECTION 3: HARNESS (you probably don't need to modify this)
  //
  //   This handles:
  //   - MCP server connection
  //   - Scheduling data gathering and trading loops
  //   - Dashboard API for the React frontend
  //   - Logging and config persistence
  //
  // ==========================================================================
  // ==========================================================================

  async run() {
    console.log("\n========================================");
    console.log("  MAHORAGA v1 - Simple Trading Agent");
    console.log("========================================\n");
    
    if (!(await this.connect())) {
      console.error("Failed to connect. Make sure MCP server is running: npm run dev");
      process.exit(1);
    }

    // Initial state
    const { account, positions, clock } = await this.getAccountState();
    if (account) {
      console.log(`Equity: $${account.equity.toFixed(2)} | Cash: $${account.cash.toFixed(2)} | Positions: ${positions.length}`);
    }
    console.log(`Market: ${clock?.is_open ? "OPEN" : "CLOSED"}\n`);

    // Save config
    saveConfig(this.config);

    // Run initial data gathering
    await this.runDataGatherers();
    
    if (clock?.is_open) {
      await this.runTradingLogic();
    }

    // Schedule recurring runs
    console.log(`Data gathering: every ${this.config.data_poll_interval_ms / 1000}s`);
    console.log(`Trading logic: every ${this.config.analyst_interval_ms / 1000}s (market hours only)\n`);

    // Data gatherers (runs 24/7)
    setInterval(async () => {
      try {
        await this.runDataGatherers();
      } catch (err) {
        this.logger.log("System", "error", { phase: "data_gathering", error: err.message });
      }
    }, this.config.data_poll_interval_ms);

    // Trading logic (only during market hours)
    setInterval(async () => {
      try {
        const { clock } = await this.getAccountState();
        if (!clock?.is_open) {
          return;
        }
        await this.runTradingLogic();
      } catch (err) {
        this.logger.log("System", "error", { phase: "trading", error: err.message });
      }
    }, this.config.analyst_interval_ms);

    // Save state periodically
    setInterval(() => {
      this.logger.save();
      saveConfig(this.config);
    }, 60_000);
  }

  async getStatus() {
    const { account, positions, clock } = await this.getAccountState();

    // Calculate current drawdowns
    let dailyDrawdown = 0, weeklyDrawdown = 0, monthlyDrawdown = 0;
    if (account?.equity) {
      dailyDrawdown = this.logger.getDrawdownPct("daily", account.equity);
      weeklyDrawdown = this.logger.getDrawdownPct("weekly", account.equity);
      monthlyDrawdown = this.logger.getDrawdownPct("monthly", account.equity);
    }

    return {
      config: this.config,
      signals: this.signalCache,
      logs: this.logger.getRecentLogs(100),
      costs: this.logger.getCosts(),
      lastAnalystRun: this.lastAnalystRun,
      drawdown: {
        daily: dailyDrawdown,
        weekly: weeklyDrawdown,
        monthly: monthlyDrawdown,
        limits: {
          daily: this.config.daily_loss_limit_pct,
          weekly: this.config.weekly_loss_limit_pct,
          monthly: this.config.monthly_loss_limit_pct,
        },
      },
      // v1 doesn't have advanced features
      signalResearch: {},
      positionResearch: {},
      stalenessAnalysis: {},
      positionTracking: Object.fromEntries(this.positionTracking),
      optionsEnabled: false,
    };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// HTTP API for Dashboard
// ============================================================================

function startDashboardAPI(orchestrator) {
  const PORT = orchestrator.config.dashboard_port || process.env.DASHBOARD_PORT || 3001;
  
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    
    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    
    try {
      if (url.pathname === "/api/status") {
        const { account, positions, clock } = await orchestrator.getAccountState();
        const status = await orchestrator.getStatus();

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          data: {
            account,
            positions,
            clock,
            ...status,
          },
        }));
      } else if (url.pathname === "/api/config" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, data: orchestrator.config }));
      } else if (url.pathname === "/api/config" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => body += chunk);
        req.on("end", () => {
          try {
            const newConfig = JSON.parse(body);
            orchestrator.config = { ...orchestrator.config, ...newConfig };
            saveConfig(orchestrator.config);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, data: orchestrator.config }));
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
      } else if (url.pathname === "/api/logs") {
        const limit = parseInt(url.searchParams.get("limit") || "100");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, data: orchestrator.logger.getRecentLogs(limit) }));
      } else if (url.pathname === "/api/costs") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, data: orchestrator.logger.getCosts() }));
      } else if (url.pathname === "/api/setup/status") {
        const hasAlpaca = !!(process.env.ALPACA_API_KEY && process.env.ALPACA_API_SECRET);
        const hasOpenAI = !!process.env.OPENAI_API_KEY;
        const startingEquity = orchestrator.config.starting_equity || 100000;
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ 
          ok: true, 
          data: { 
            configured: hasAlpaca,
            has_alpaca: hasAlpaca,
            has_openai: hasOpenAI,
            starting_equity: startingEquity,
            paper_mode: process.env.ALPACA_PAPER === "true"
          } 
        }));
      } else if (url.pathname === "/api/setup/keys" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => body += chunk);
        req.on("end", () => {
          try {
            const { alpaca_key, alpaca_secret, openai_key, paper_mode, starting_equity } = JSON.parse(body);
            
            // Build .dev.vars content
            let envContent = "";
            if (alpaca_key) envContent += `ALPACA_API_KEY=${alpaca_key}\n`;
            if (alpaca_secret) envContent += `ALPACA_API_SECRET=${alpaca_secret}\n`;
            envContent += `ALPACA_PAPER=${paper_mode !== false ? "true" : "false"}\n`;
            if (openai_key) envContent += `OPENAI_API_KEY=${openai_key}\n`;
            envContent += `KILL_SWITCH_SECRET=mahoraga_kill_${Date.now()}\n`;
            
            // Write to .dev.vars
            const envPath = path.join(__dirname, ".dev.vars");
            fs.writeFileSync(envPath, envContent);
            
            // Update config with starting equity
            if (starting_equity) {
              orchestrator.config.starting_equity = starting_equity;
              saveConfig(orchestrator.config);
            }
            
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ 
              ok: true, 
              message: "Configuration saved. Please restart the agent." 
            }));
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Not found" }));
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });

  server.listen(PORT, () => {
    console.log(`Dashboard API: http://localhost:${PORT}`);
    console.log(`  GET  /api/status  - Full status`);
    console.log(`  GET  /api/config  - Get config`);
    console.log(`  POST /api/config  - Update config`);
    console.log(`  GET  /api/logs    - Activity logs\n`);
  });
}

// ============================================================================
// Entry Point
// ============================================================================

const orchestrator = new SimpleOrchestrator();
startDashboardAPI(orchestrator);
orchestrator.run().catch(console.error);
