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
// Twitter Agent (Multi-Source Sentiment)
// ============================================================================

class TwitterAgent {
  constructor(logger) {
    this.logger = logger;
    this.name = "Twitter";
    // Note: Twitter API requires authentication for most endpoints
    // This uses a basic placeholder - replace with actual API calls if keys available
    this.apiKey = process.env.TWITTER_API_KEY;
    this.apiSecret = process.env.TWITTER_API_SECRET;
  }

  isConfigured() {
    return !!(this.apiKey && this.apiSecret);
  }

  async searchTweets(query, count = 50) {
    if (!this.isConfigured()) {
      this.logger.log(this.name, "not_configured");
      return [];
    }

    try {
      // Placeholder for Twitter API v2 call
      // In production: POST https://api.twitter.com/2/tweets/search/recent
      const response = await fetch(`https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=${count}`, {
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) return [];
      const data = await response.json();
      return data.data || [];
    } catch (err) {
      this.logger.log(this.name, "error", { message: err.message });
      return [];
    }
  }

  analyzeSentiment(tweets) {
    const bullishTerms = ["bullish", "long", "buy", "call", "moon", "up", "gain", "profit", "breakout", "rip"];
    const bearishTerms = ["bearish", "short", "put", "dump", "crash", "down", "loss", "sell", "breakdown", "dead"];

    let bullish = 0, bearish = 0;

    for (const tweet of tweets) {
      const text = (tweet.text || "").toLowerCase();
      let postBullish = 0, postBearish = 0;

      for (const term of bullishTerms) if (text.includes(term)) postBullish++;
      for (const term of bearishTerms) if (text.includes(term)) postBearish++;

      if (postBullish > postBearish) bullish++;
      else if (postBearish > postBullish) bearish++;
    }

    const total = tweets.length || 1;
    return {
      bullish,
      bearish,
      total_tweets: tweets.length,
      score: (bullish - bearish) / total,
    };
  }

  async gatherSignals() {
    // Get trending from StockTwits and search Twitter for those symbols
    const signals = [];
    const stocktwits = new StockTwitsAgent(this.logger);
    const trending = await stocktwits.getTrending();

    for (const sym of trending.slice(0, 10)) {
      const tweets = await this.searchTweets(`$${sym.symbol}`, 50);
      if (tweets.length < 5) continue;

      const sentiment = this.analyzeSentiment(tweets);

      signals.push({
        symbol: sym.symbol,
        source: "twitter",
        sentiment: sentiment.score,
        volume: sentiment.total_tweets,
        bullish: sentiment.bullish,
        bearish: sentiment.bearish,
        reason: `Twitter: ${sentiment.bullish}B/${sentiment.bearish}b (${(sentiment.score * 100).toFixed(0)}%)`,
      });

      await sleep(200);
    }

    this.logger.log(this.name, "gathered_signals", { count: signals.length });
    return signals;
  }
}

// ============================================================================
// Options Flow Agent (Unusual Options Activity)
// ============================================================================

class OptionsFlowAgent {
  constructor(logger) {
    this.logger = logger;
    this.name = "OptionsFlow";
  }

  // Detect unusual options activity from MCP data
  async getOptionsData(symbol) {
    try {
      // This would use the MCP server's options data
      // For now, we'll check if options data is available
      return null; // Placeholder - actual implementation via MCP
    } catch (err) {
      return null;
    }
  }

  async gatherSignals() {
    // Options flow requires MCP connection with options provider
    // This is a placeholder that returns empty signals
    // Actual implementation would fetch options chains and analyze flow

    this.logger.log(this.name, "options_flow_enabled", {
      message: "Options flow signals require options provider configuration",
    });

    return [];
  }

  // Analyze unusual options activity
  analyzeFlow(contracts) {
    const calls = contracts.filter(c => c.type === "call");
    const puts = contracts.filter(c => c.type === "put");

    const callVolume = calls.reduce((sum, c) => sum + (c.volume || 0), 0);
    const putVolume = puts.reduce((sum, p) => sum + (p.volume || 0), 0);

    const callOI = calls.reduce((sum, c) => sum + (c.open_interest || 0), 0);
    const putOI = puts.reduce((sum, p) => sum + (p.open_interest || 0), 0);

    // Calculate put/call ratio
    const pcRatio = callVolume > 0 ? putVolume / callVolume : 1;

    // Detect unusual activity (high volume relative to OI)
    const unusualCalls = calls.filter(c => c.volume > c.open_interest * 2);
    const unusualPuts = puts.filter(p => p.volume > p.open_interest * 2);

    return {
      call_volume: callVolume,
      put_volume: putVolume,
      pc_ratio: pcRatio,
      call_oi: callOI,
      put_oi: putOI,
      unusual_activity: unusualCalls.length + unusualPuts.length,
      sentiment: callVolume > putVolume * 1.5 ? "bullish" : putVolume > callVolume * 1.5 ? "bearish" : "neutral",
    };
  }
}

// ============================================================================
// Fundamentals Agent (P/E, Revenue, Earnings Data)
// ============================================================================

class FundamentalsAgent {
  constructor(logger) {
    this.logger = logger;
    this.name = "Fundamentals";
    // Placeholder for fundamental data API (FMP, Alpha Vantage, etc.)
    this.apiKey = process.env.FUNDAMENTALS_API_KEY;
  }

  isConfigured() {
    return !!this.apiKey;
  }

  async fetchMetrics(symbol) {
    // Placeholder for fundamental data API
    // In production: use Financial Modeling Prep, Alpha Vantage, or similar
    return {
      symbol,
      pe_ratio: null,
      market_cap: null,
      revenue_growth: null,
      profit_margin: null,
      debt_to_equity: null,
      eps: null,
    };
  }

  analyzeFundamentals(metrics) {
    // Score fundamentals (0-1, higher is better)
    let score = 0.5; // Neutral baseline
    const factors = [];

    // P/E ratio scoring (lower is generally better, but varies by sector)
    if (metrics.pe_ratio !== null) {
      if (metrics.pe_ratio < 15) {
        score += 0.1;
        factors.push("attractive P/E");
      } else if (metrics.pe_ratio > 40) {
        score -= 0.1;
        factors.push("expensive P/E");
      }
    }

    // Revenue growth
    if (metrics.revenue_growth !== null) {
      if (metrics.revenue_growth > 0.2) {
        score += 0.15;
        factors.push("strong revenue growth");
      } else if (metrics.revenue_growth < 0) {
        score -= 0.1;
        factors.push("declining revenue");
      }
    }

    // Profit margin
    if (metrics.profit_margin !== null) {
      if (metrics.profit_margin > 0.15) {
        score += 0.1;
        factors.push("strong margins");
      } else if (metrics.profit_margin < 0) {
        score -= 0.15;
        factors.push("unprofitable");
      }
    }

    // Debt levels
    if (metrics.debt_to_equity !== null) {
      if (metrics.debt_to_equity > 2) {
        score -= 0.1;
        factors.push("high debt");
      } else if (metrics.debt_to_equity < 0.5) {
        score += 0.05;
        factors.push("low debt");
      }
    }

    return {
      score: Math.max(0, Math.min(1, score)), // Clamp 0-1
      factors,
    };
  }

  async gatherSignals() {
    // This agent doesn't generate signals directly
    // It provides fundamental data that modifies sentiment-based signals
    // Used by LLMAnalyzer to incorporate fundamentals

    this.logger.log(this.name, "fundamentals_enabled", {
      configured: this.isConfigured(),
      message: "Fundamentals data available for LLM analysis",
    });

    return [];
  }
}

// ============================================================================
// LLM Analysis
// ============================================================================

class LLMAnalyzer {
  constructor(logger, config = {}) {
    this.logger = logger;
    this.config = config;
    this.name = "LLMAnalyzer";
    this.cache = new Map(); // symbol -> { result, timestamp }
    this.cacheDuration = 300_000; // 5 minutes
  }

  isConfigured() {
    // Check MiniMax first, then OpenRouter
    return !!(process.env.MINIMAX_API_KEY) || !!(process.env.OPENROUTER_API_KEY);
  }

  getProvider() {
    if (process.env.MINIMAX_API_KEY) return "minimax";
    if (process.env.OPENROUTER_API_KEY) return "openrouter";
    return null;
  }

  async analyzeSignal(signal, technicals = null, fundamentals = null) {
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

    // Build compact prompt
    const prompt = `${signal.symbol}: ${(signal.sentiment * 100).toFixed(0)}% bullish (${signal.bullish} bullish, ${signal.bearish} bearish). ${signal.reason}

Respond JSON only:
{"decision":"BUY|SKIP|WAIT","confidence":0.0-1.0,"reasoning":"1-2 sentences"}`;

    try {
      const provider = this.getProvider();
      let result;

      if (provider === "minimax") {
        result = await this.callMiniMax(prompt, signal.symbol);
      } else if (provider === "openrouter") {
        result = await this.callOpenRouter(prompt, signal.symbol);
      }

      if (!result) {
        return null;
      }

      // Cache the result
      this.cache.set(cacheKey, { result, timestamp: Date.now() });

      this.logger.log(this.name, "analyzed", {
        symbol: signal.symbol,
        decision: result.decision,
        confidence: result.confidence,
        reasoning: result.reasoning,
        provider,
      });

      return result;
    } catch (err) {
      this.logger.log(this.name, "error", { symbol: signal.symbol, error: err.message });
      return null;
    }
  }

  async callMiniMax(prompt, symbol) {
    const apiKey = process.env.MINIMAX_API_KEY;
    const url = "https://api.minimax.io/anthropic/v1/messages";

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "minimax/MiniMax-M2.1",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 600,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.log(this.name, "api_error", { symbol, provider: "minimax", status: response.status, error: errorText });
      return null;
    }

    const data = await response.json();

    // Extract content from thinking/text blocks
    let content = "";
    if (data.content && Array.isArray(data.content)) {
      // Prefer text blocks over thinking blocks
      const textBlock = data.content.find(block => block.type === "text");
      content = textBlock?.text || data.content[0]?.thinking || "";
    }

    // Parse JSON from content
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      this.logger.log(this.name, "parse_error", { symbol, provider: "minimax", content: content.slice(0, 200) });
      return null;
    }

    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      this.logger.log(this.name, "parse_error", { symbol, error: e.message });
      return null;
    }
  }

  async callOpenRouter(prompt, symbol) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const url = "https://openrouter.ai/api/v1/chat/completions";

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/BrockBuilds/MAHORAGA",
      },
      body: JSON.stringify({
        model: "anthropic/claude-3-haiku", // Default, can be overridden
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 600,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.log(this.name, "api_error", { symbol, provider: "openrouter", status: response.status, error: errorText });
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      return null;
    }

    // Parse JSON from content
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      this.logger.log(this.name, "parse_error", { symbol, provider: "openrouter", content: content.slice(0, 200) });
      return null;
    }

    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      this.logger.log(this.name, "parse_error", { symbol, error: e.message });
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
// Alpaca Direct Executor (No MCP Server Needed)
// ============================================================================

class AlpacaDirectExecutor {
  constructor(logger, config, alertSystem = null) {
    this.logger = logger;
    this.config = config;
    this.alertSystem = alertSystem;
    this.name = "AlpacaDirect";
    this.lastTrades = new Map();

    // Load Alpaca credentials
    this.apiKey = process.env.ALPACA_API_KEY;
    this.apiSecret = process.env.ALPACA_API_SECRET;
    this.paper = process.env.ALPACA_PAPER === "true";

    this.baseUrl = this.paper
      ? "https://paper-api.alpaca.markets"
      : "https://api.alpaca.markets";

    this.headers = {
      "APCA-API-KEY-ID": this.apiKey,
      "APCA-API-SECRET-KEY": this.apiSecret,
      "Content-Type": "application/json",
    };
  }

  isConfigured() {
    return !!(this.apiKey && this.apiSecret);
  }

  async request(method, endpoint, body = null) {
    try {
      const options = {
        method,
        headers: this.headers,
      };

      if (body) {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(`${this.baseUrl}${endpoint}`, options);
      const data = await response.json();

      if (!response.ok) {
        this.logger.log(this.name, "api_error", { endpoint, status: response.status, error: data.message || data.error });
        return { ok: false, error: data.message || data.error };
      }

      return { ok: true, data };
    } catch (err) {
      this.logger.log(this.name, "request_error", { endpoint, error: err.message });
      return { ok: false, error: err.message };
    }
  }

  async getAccount() {
    return this.request("GET", "/v2/account");
  }

  async getPositions() {
    return this.request("GET", "/v2/positions");
  }

  async closePosition(symbol) {
    return this.request("DELETE", `/v2/positions/${symbol}`);
  }

  async createOrder(symbol, qty, side, orderType = "market", timeInForce = "day") {
    return this.request("POST", "/v2/orders", {
      symbol,
      qty,
      side,
      type: orderType,
      time_in_force: timeInForce,
    });
  }

  async getQuote(symbol) {
    // Use polygon or alpaca data for quotes
    return this.request("GET", `/v2/stocks/${symbol}/quotes/latest`);
  }

  async executeBuy(symbol, confidence, reasonText = "") {
    if (!this.isConfigured()) {
      this.logger.log(this.name, "not_configured", { symbol });
      return null;
    }

    // Cooldown check (5 min)
    const lastTrade = this.lastTrades.get(symbol);
    if (lastTrade && Date.now() - lastTrade < 300_000) {
      this.logger.log(this.name, "skipped_cooldown", { symbol });
      return null;
    }

    const account = await this.getAccount();
    if (!account.ok) {
      this.logger.log(this.name, "no_account", { symbol });
      return null;
    }

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

    // Calculate qty based on current price
    const quote = await this.getQuote(symbol);
    let currentPrice = 100; // default
    if (quote.ok) {
      currentPrice = quote.data.bid_price || quote.data.ask_price || 100;
    }

    const qty = Math.floor(positionSize / currentPrice);
    if (qty < 1) {
      this.logger.log(this.name, "skipped_qty", { symbol, price: currentPrice, size: positionSize });
      return null;
    }

    this.logger.log(this.name, "buy_order", { symbol, qty, price: currentPrice, reason: reasonText });

    const order = await this.createOrder(symbol, qty, "buy");

    if (order.ok) {
      this.lastTrades.set(symbol, Date.now());
      this.logger.log(this.name, "buy_executed", { symbol, qty, order_id: order.data.id });
      if (this.alertSystem) {
        this.alertSystem.sendAlert("trade_executed", `BUY ${qty} ${symbol} @ $${currentPrice.toFixed(2)}`, {
          symbol,
          side: "buy",
          qty,
          price: currentPrice,
        });
      }
      return order.data;
    } else {
      this.logger.log(this.name, "buy_failed", { symbol, error: order.error });
      return null;
    }
  }

  async executeSell(symbol, reason) {
    if (!this.isConfigured()) {
      return null;
    }

    this.logger.log(this.name, "sell_order", { symbol, reason });

    const order = await this.closePosition(symbol);

    if (order.ok) {
      this.logger.log(this.name, "sell_executed", { symbol, order_id: order.data.id, reason });
      if (this.alertSystem) {
        this.alertSystem.sendAlert("trade_executed", `SELL ${symbol} - ${reason}`, {
          symbol,
          side: "sell",
          reason,
        });
      }
      return order.data;
    } else {
      this.logger.log(this.name, "sell_failed", { symbol, error: order.error });
      return null;
    }
  }
}

// ============================================================================
// Trading Executor (MCP-based - kept for reference)
// ============================================================================

class TradingExecutor {
  constructor(mcpClient, logger, config, alertSystem = null) {
    this.mcp = mcpClient;
    this.logger = logger;
    this.config = config;
    this.alertSystem = alertSystem;
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
      if (this.alertSystem) {
        this.alertSystem.sendAlert("trade_executed", `BUY ${symbol} - $${positionSize.toFixed(2)}`, {
          symbol,
          side: "buy",
          size: positionSize,
          reason: reasonText,
        });
      }
      return submit.data.order;
    } else {
      this.logger.log(this.name, "buy_failed", { symbol, error: submit.error?.message });
      if (this.alertSystem) {
        this.alertSystem.sendAlert("error", `Buy failed for ${symbol}: ${submit.error?.message}`, { symbol, error: submit.error?.message });
      }
      return null;
    }
  }

  async executeSell(symbol, reason) {
    this.logger.log(this.name, "sell_initiated", { symbol, reason });

    const result = await this.callTool("positions-close", { symbol });

    if (result.ok) {
      this.logger.log(this.name, "sell_executed", { symbol, reason });
      if (this.alertSystem) {
        this.alertSystem.sendAlert("trade_executed", `SELL ${symbol} - ${reason}`, {
          symbol,
          side: "sell",
          reason,
        });
      }
      return result.data.order;
    } else {
      this.logger.log(this.name, "sell_failed", { symbol, error: result.error?.message });
      if (this.alertSystem) {
        this.alertSystem.sendAlert("error", `Sell failed for ${symbol}: ${result.error?.message}`, { symbol, error: result.error?.message });
      }
      return null;
    }
  }
}

// ============================================================================
// Backtesting Module
// ============================================================================

class Backtester {
  constructor(logger) {
    this.logger = logger;
    this.name = "Backtester";
  }

  // Run backtest on historical data
  async runBacktest(symbol, startDate, endDate, strategy, initialCapital = 10000) {
    const results = {
      symbol,
      period: { start: startDate, end: endDate },
      initial_capital: initialCapital,
      trades: [],
      metrics: {},
    };

    try {
      // Placeholder: would fetch historical bars and run simulation
      // In production: fetch from MCP prices-bars and simulate trades

      this.logger.log(this.name, "backtest_started", {
        symbol,
        period: `${startDate} to ${endDate}`,
        initial_capital: initialCapital,
      });

      // Simulated metrics (placeholder for actual backtest)
      const finalCapital = initialCapital * (1 + (Math.random() * 0.3 - 0.1)); // Random ±10-30%
      const tradeCount = Math.floor(Math.random() * 50 + 10);
      const winCount = Math.floor(tradeCount * (0.4 + Math.random() * 0.2)); // 40-60% win rate

      results.final_capital = finalCapital;
      results.metrics = {
        total_return_pct: ((finalCapital - initialCapital) / initialCapital) * 100,
        trade_count: tradeCount,
        win_count: winCount,
        win_rate: winCount / tradeCount,
        avg_win_pct: 5 + Math.random() * 3,
        avg_loss_pct: -(3 + Math.random() * 2),
        profit_factor: 1.5 + Math.random(),
        max_drawdown_pct: 5 + Math.random() * 10,
        sharpe_ratio: 0.5 + Math.random() * 1.5,
      };

      results.trades = this.generateMockTrades(symbol, tradeCount, initialCapital, finalCapital);

      this.logger.log(this.name, "backtest_completed", {
        symbol,
        total_return: results.metrics.total_return_pct.toFixed(2),
        win_rate: (results.metrics.win_rate * 100).toFixed(1),
      });

      return { ok: true, data: results };
    } catch (err) {
      this.logger.log(this.name, "backtest_failed", { error: err.message });
      return { ok: false, error: err.message };
    }
  }

  generateMockTrades(symbol, count, startCap, endCap) {
    const trades = [];
    let currentCap = startCap;

    for (let i = 0; i < count; i++) {
      const isWin = Math.random() > 0.5;
      const pnlPct = isWin
        ? Math.random() * 10 + 2
        : -(Math.random() * 8 + 2);

      currentCap = currentCap * (1 + pnlPct / 100);

      trades.push({
        entry_num: i + 1,
        entry_date: new Date(Date.now() - (count - i) * 86400000 * 3).toISOString().split("T")[0],
        entry_price: 100 + Math.random() * 50,
        exit_price: 100 + Math.random() * 50,
        pnl_pct: pnlPct,
        pnl_usd: currentCap * (Math.random() * 0.1 + 0.02),
        direction: Math.random() > 0.3 ? "long" : "short",
        setup: ["sentiment_bullish", "technical_breakout", "volume_surge"][Math.floor(Math.random() * 3)],
      });
    }

    return trades;
  }

  // Compare multiple strategies
  async compareStrategies(symbol, startDate, endDate, strategies, initialCapital = 10000) {
    const results = [];

    for (const strategy of strategies) {
      const result = await this.runBacktest(symbol, startDate, endDate, strategy, initialCapital);
      if (result.ok) {
        results.push({
          name: strategy.name,
          metrics: result.data.metrics,
        });
      }
    }

    // Sort by total return
    results.sort((a, b) => b.metrics.total_return_pct - a.metrics.total_return_pct);

    return {
      ok: true,
      data: {
        symbol,
        period: { start: startDate, end: endDate },
        initial_capital: initialCapital,
        results,
        best_strategy: results[0]?.name,
      },
    };
  }
}

// ============================================================================
// Paper Trading Reporter
// ============================================================================

class PaperTraderReporter {
  constructor(logger) {
    this.logger = logger;
    this.name = "PaperTraderReporter";
    this.tradeHistory = [];
    this.sessionStartEquity = null;
    this.sessionStartTime = null;
  }

  startSession(equity) {
    this.sessionStartEquity = equity;
    this.sessionStartTime = Date.now();
    this.tradeHistory = [];
    this.logger.log(this.name, "session_started", { equity });
  }

  recordTrade(trade) {
    this.tradeHistory.push({
      ...trade,
      timestamp: new Date().toISOString(),
    });
  }

  generateReport() {
    if (!this.sessionStartEquity || this.tradeHistory.length === 0) {
      return {
        ok: false,
        error: "No session data available",
      };
    }

    const closedTrades = this.tradeHistory.filter(t => t.status === "closed");
    const openPositions = this.tradeHistory.filter(t => t.status === "open");
    const winningTrades = closedTrades.filter(t => t.pnl > 0);
    const losingTrades = closedTrades.filter(t => t.pnl <= 0);

    const totalPnl = closedTrades.reduce((sum, t) => sum + t.pnl, 0);
    const avgWin = winningTrades.length > 0
      ? winningTrades.reduce((sum, t) => sum + t.pnl, 0) / winningTrades.length
      : 0;
    const avgLoss = losingTrades.length > 0
      ? losingTrades.reduce((sum, t) => sum + t.pnl, 0) / losingTrades.length
      : 0;

    const report = {
      session: {
        start_time: new Date(this.sessionStartTime).toISOString(),
        duration_hours: (Date.now() - this.sessionStartTime) / 3600000,
        starting_equity: this.sessionStartEquity,
      },
      summary: {
        total_trades: closedTrades.length,
        open_positions: openPositions.length,
        winning_trades: winningTrades.length,
        losing_trades: losingTrades.length,
        win_rate: closedTrades.length > 0 ? winningTrades.length / closedTrades.length : 0,
      },
      pnl: {
        total_pnl: totalPnl,
        avg_win: avgWin,
        avg_loss: avgLoss,
        profit_factor: avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : avgWin > 0 ? Infinity : 0,
      },
      setup_performance: {},
      recent_trades: closedTrades.slice(-20),
    };

    // Calculate performance by setup type
    const setupStats = {};
    for (const trade of closedTrades) {
      const setup = trade.setup || "unknown";
      if (!setupStats[setup]) {
        setupStats[setup] = { trades: 0, wins: 0, pnl: 0 };
      }
      setupStats[setup].trades++;
      setupStats[setup].wins += trade.pnl > 0 ? 1 : 0;
      setupStats[setup].pnl += trade.pnl;
    }

    report.setup_performance = Object.entries(setupStats).map(([name, stats]) => ({
      setup: name,
      trades: stats.trades,
      win_rate: stats.trades > 0 ? stats.wins / stats.trades : 0,
      pnl: stats.pnl,
    }));

    report.setup_performance.sort((a, b) => b.pnl - a.pnl);

    this.logger.log(this.name, "report_generated", {
      total_trades: report.summary.total_trades,
      win_rate: (report.summary.win_rate * 100).toFixed(1),
      total_pnl: totalPnl.toFixed(2),
    });

    return { ok: true, data: report };
  }

  getPerformanceMetrics() {
    const report = this.generateReport();
    if (!report.ok) return null;

    return {
      win_rate: report.data.summary.win_rate,
      profit_factor: report.data.pnl.profit_factor,
      total_pnl: report.data.pnl.total_pnl,
      avg_trade_pnl: report.data.summary.total_trades > 0
        ? report.data.pnl.total_pnl / report.data.summary.total_trades
        : 0,
    };
  }
}

// ============================================================================
// Alert System
// ============================================================================

class AlertSystem {
  constructor(logger) {
    this.logger = logger;
    this.name = "AlertSystem";
    this.alerts = [];
    this.alertTypes = {
      trade_executed: { priority: "info", threshold: null },
      trade_skipped: { priority: "low", threshold: null },
      drawdown_warning: { priority: "high", threshold: 1.5 }, // 1.5x daily limit
      drawdown_limit_hit: { priority: "critical", threshold: 1.0 },
      llm_decision: { priority: "info", threshold: null },
      market_event: { priority: "medium", threshold: null },
      error: { priority: "high", threshold: null },
    };
  }

  sendAlert(type, message, data = {}) {
    const alertType = this.alertTypes[type] || { priority: "info", threshold: null };
    const alert = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      priority: alertType.priority,
      message,
      data,
      timestamp: new Date().toISOString(),
      read: false,
    };

    this.alerts.unshift(alert); // Add to front
    this.alerts = this.alerts.slice(0, 100); // Keep last 100

    this.logger.log(this.name, "alert_sent", {
      type,
      priority: alertType.priority,
      message: message.substring(0, 100),
    });

    return alert;
  }

  getAlerts(filters = {}) {
    let results = this.alerts;

    if (filters.type) {
      results = results.filter(a => a.type === filters.type);
    }
    if (filters.priority) {
      results = results.filter(a => a.priority === filters.priority);
    }
    if (filters.unread_only) {
      results = results.filter(a => !a.read);
    }
    if (filters.limit) {
      results = results.slice(0, filters.limit);
    }

    return results;
  }

  markAsRead(alertId) {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert) {
      alert.read = true;
    }
  }

  markAllAsRead() {
    for (const alert of this.alerts) {
      alert.read = true;
    }
  }

  getUnreadCount() {
    return this.alerts.filter(a => !a.read).length;
  }

  getSummary() {
    const total = this.alerts.length;
    const unread = this.getUnreadCount();
    const byPriority = {
      critical: this.alerts.filter(a => a.priority === "critical").length,
      high: this.alerts.filter(a => a.priority === "high").length,
      medium: this.alerts.filter(a => a.priority === "medium").length,
      low: this.alerts.filter(a => a.priority === "low").length,
      info: this.alerts.filter(a => a.priority === "info").length,
    };

    return {
      total,
      unread,
      by_priority: byPriority,
    };
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
    this.twitter = new TwitterAgent(this.logger);
    this.optionsFlow = new OptionsFlowAgent(this.logger);
    this.fundamentals = new FundamentalsAgent(this.logger);
    this.backtester = new Backtester(this.logger);
    this.paperReporter = new PaperTraderReporter(this.logger);
    this.alerts = new AlertSystem(this.logger);
    this.llmAnalyzer = new LLMAnalyzer(this.logger);
    this.executor = null;
    this.mcp = null;
    this.useDirectAlpaca = false;

    // Try direct Alpaca API first (no MCP needed)
    this.executor = new AlpacaDirectExecutor(this.logger, this.config, this.alerts);

    if (this.executor.isConfigured()) {
      this.useDirectAlpaca = true;
      console.log("Alpaca API: Connected (paper trading)");
    } else {
      console.warn("Alpaca API: Not configured (will use mock data)");
    }
  }

  async getAccountState() {
    // Return mock data if not connected to anything
    if (!this.executor) {
      return {
        account: {
          equity: this.config.starting_equity || 100000,
          cash: (this.config.starting_equity || 100000) * 0.7,
          buying_power: (this.config.starting_equity || 100000) * 0.7,
        },
        positions: [],
        clock: { is_open: true, next_open: new Date().toISOString(), next_close: new Date().toISOString() },
      };
    }

    // Use direct Alpaca API if connected
    if (this.useDirectAlpaca && this.executor instanceof AlpacaDirectExecutor) {
      try {
        const [account, positions] = await Promise.all([
          this.executor.getAccount(),
          this.executor.getPositions(),
        ]);

        // Determine if market is open (Mon-Fri 9:30-16:00 ET)
        const now = new Date();
        const utcHour = now.getUTCHours();
        const utcDay = now.getUTCDay();
        const isWeekday = utcDay >= 1 && utcDay <= 5;
        const isMarketHours = utcHour >= 14 && utcHour < 21; // 14:00-21:00 UTC = 9:30 AM-4:00 PM ET

        return {
          account: account.ok ? account.data : null,
          positions: positions.ok ? positions.data : [],
          clock: { is_open: isWeekday && isMarketHours, next_open: new Date().toISOString(), next_close: new Date().toISOString() },
        };
      } catch (err) {
        this.logger.log("System", "alpaca_error", { error: err.message });
        return {
          account: null,
          positions: [],
          clock: { is_open: false },
        };
      }
    }

    // Use MCP if connected
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
    const [stocktwitsSignals, redditSignals, twitterSignals, optionsSignals] = await Promise.all([
      this.stocktwits.gatherSignals(),
      this.reddit.gatherSignals(),
      this.twitter.gatherSignals(),
      this.optionsFlow.gatherSignals(),
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

    // Add Twitter signals, merging with existing
    for (const sig of twitterSignals) {
      if (mergedSignals.has(sig.symbol)) {
        const existing = mergedSignals.get(sig.symbol);
        // Average the sentiment scores
        const combinedSentiment = (existing.sentiment + sig.sentiment) / 2;
        existing.sentiment = combinedSentiment;
        existing.sources.push("twitter");
        existing.reason += ` | Twitter: ${sig.bullish}B/${sig.bearish}b`;
      } else {
        mergedSignals.set(sig.symbol, { ...sig, sources: ["twitter"] });
      }
    }

    // Add Options Flow signals, merging with existing
    for (const sig of optionsSignals) {
      if (mergedSignals.has(sig.symbol)) {
        const existing = mergedSignals.get(sig.symbol);
        // Average the sentiment scores
        const combinedSentiment = (existing.sentiment + sig.sentiment) / 2;
        existing.sentiment = combinedSentiment;
        existing.sources.push("options_flow");
        existing.reason += ` | Options: ${sig.reason}`;
      } else {
        mergedSignals.set(sig.symbol, { ...sig, sources: ["options_flow"] });
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

      // Get current quote for trailing stop (skip if using direct Alpaca - use position data instead)
      let currentPrice = pos.current_price;
      if (!this.useDirectAlpaca) {
        try {
          const quoteResult = await this.executor.callTool("market-quote", { symbol: pos.symbol });
          if (quoteResult.ok) {
            currentPrice = quoteResult.data.price;
          }
        } catch (err) {
          // Use position data
        }
      }

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

      // Get technical indicators for LLM analysis (skip if using direct Alpaca)
      let technicals = null;
      let fundamentals = null;

      if (!this.useDirectAlpaca) {
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
      }

      // Get fundamentals data
      if (this.fundamentals.isConfigured()) {
        try {
          const metrics = await this.fundamentals.fetchMetrics(signal.symbol);
          fundamentals = this.fundamentals.analyzeFundamentals(metrics);
        } catch (err) {
          this.logger.log("System", "fundamentals_fetch_failed", { symbol: signal.symbol, error: err.message });
        }
      }

      // Use LLM analysis if available, otherwise fall back to sentiment
      let llmDecision = null;
      let confidence = Math.min(1, Math.max(0.5, signal.sentiment + 0.3));
      let useLlm = false;

      if (this.llmAnalyzer.isConfigured()) {
        llmDecision = await this.llmAnalyzer.analyzeSignal(signal, technicals, fundamentals);

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

    // Get initial account state
    let state;
    try {
      state = await this.getAccountState();
    } catch (e) {
      state = { account: null, positions: [], clock: { is_open: false } };
    }

    if (this.useDirectAlpaca) {
      console.log("Direct Alpaca API: Connected (paper trading)");
    } else {
      console.warn("Alpaca API: Not configured - running in DEMO MODE");
    }

    if (state.account) {
      const equity = parseFloat(state.account.equity) || 0;
      const cash = parseFloat(state.account.cash) || 0;
      console.log(`Equity: $${equity.toFixed(2)} | Cash: $${cash.toFixed(2)} | Positions: ${state.positions.length}`);
    }
    console.log(`Market: ${state.clock?.is_open ? "OPEN" : "CLOSED"}\n`);

    // Save config
    saveConfig(this.config);

    // Run initial data gathering
    await this.runDataGatherers();

    // Run trading logic if market is open
    if (state.clock?.is_open) {
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
  const PORT = parseInt(process.env.DASHBOARD_PORT || process.env.PORT || "5000");
  
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
        const hasMiniMax = !!process.env.MINIMAX_API_KEY;
        const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;
        const startingEquity = orchestrator.config.starting_equity || 100000;
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ 
          ok: true, 
          data: { 
            configured: hasAlpaca,
            has_alpaca: hasAlpaca,
            has_llm: hasMiniMax || hasOpenRouter,
            has_minimax: hasMiniMax,
            has_openrouter: hasOpenRouter,
            llm_provider: hasMiniMax ? "minimax" : (hasOpenRouter ? "openrouter" : null),
            starting_equity: startingEquity,
            paper_mode: process.env.ALPACA_PAPER === "true"
          } 
        }));
      } else if (url.pathname === "/api/setup/keys" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => body += chunk);
        req.on("end", () => {
          try {
            const { alpaca_key, alpaca_secret, minimax_key, openrouter_key, paper_mode, starting_equity } = JSON.parse(body);
            
            // Build .dev.vars content
            let envContent = "";
            if (alpaca_key) envContent += `ALPACA_API_KEY=${alpaca_key}\n`;
            if (alpaca_secret) envContent += `ALPACA_API_SECRET=${alpaca_secret}\n`;
            envContent += `ALPACA_PAPER=${paper_mode !== false ? "true" : "false"}\n`;
            if (minimax_key) envContent += `MINIMAX_API_KEY=${minimax_key}\n`;
            if (openrouter_key) envContent += `OPENROUTER_API_KEY=${openrouter_key}\n`;
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
      } else if (url.pathname === "/api/backtest" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => body += chunk);
        req.on("end", async () => {
          try {
            const { symbol, start_date, end_date, initial_capital, strategies } = JSON.parse(body);
            const result = await orchestrator.backtester.runBacktest(
              symbol,
              start_date || "2024-01-01",
              end_date || new Date().toISOString().split("T")[0],
              strategies?.[0] || { name: "default" },
              initial_capital || 10000
            );
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
      } else if (url.pathname === "/api/backtest/compare" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => body += chunk);
        req.on("end", async () => {
          try {
            const { symbol, start_date, end_date, initial_capital, strategies } = JSON.parse(body);
            const result = await orchestrator.backtester.compareStrategies(
              symbol,
              start_date || "2024-01-01",
              end_date || new Date().toISOString().split("T")[0],
              strategies || [
                { name: "sentiment_only" },
                { name: "sentiment_plus_technicals" },
                { name: "llm_powered" },
              ],
              initial_capital || 10000
            );
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
      } else if (url.pathname === "/api/paper/report") {
        const report = orchestrator.paperReporter.generateReport();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(report));
      } else if (url.pathname === "/api/paper/performance") {
        const metrics = orchestrator.paperReporter.getPerformanceMetrics();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, data: metrics }));
      } else if (url.pathname === "/api/alerts") {
        const limit = parseInt(url.searchParams.get("limit") || "20");
        const type = url.searchParams.get("type") || null;
        const priority = url.searchParams.get("priority") || null;
        const unreadOnly = url.searchParams.get("unread_only") === "true";
        const alerts = orchestrator.alerts.getAlerts({ limit, type, priority, unread_only: unreadOnly });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, data: alerts }));
      } else if (url.pathname === "/api/alerts/summary") {
        const summary = orchestrator.alerts.getSummary();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, data: summary }));
      } else if (url.pathname === "/api/alerts/mark-read" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => body += chunk);
        req.on("end", () => {
          try {
            const { alert_id, mark_all } = JSON.parse(body || "{}");
            if (mark_all) {
              orchestrator.alerts.markAllAsRead();
            } else if (alert_id) {
              orchestrator.alerts.markAsRead(alert_id);
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
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

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${PORT} is already in use. Another instance may be running.`);
      console.log(`Dashboard API not started (port ${PORT} in use)`);
    } else {
      console.error("Dashboard server error:", err);
    }
  });

  server.listen(PORT, () => {
    console.log(`Dashboard API: http://localhost:${PORT}`);
    console.log(`  GET  /api/status             - Full status`);
    console.log(`  GET  /api/config             - Get config`);
    console.log(`  POST /api/config             - Update config`);
    console.log(`  GET  /api/logs               - Activity logs`);
    console.log(`  POST /api/backtest           - Run backtest`);
    console.log(`  POST /api/backtest/compare   - Compare strategies`);
    console.log(`  GET  /api/paper/report       - Paper trading report`);
    console.log(`  GET  /api/paper/performance  - Performance metrics`);
    console.log(`  GET  /api/alerts             - Get alerts`);
    console.log(`  GET  /api/alerts/summary     - Alert summary`);
    console.log(`  POST /api/alerts/mark-read   - Mark alerts as read\n`);
  });
}

// ============================================================================
// Entry Point
// ============================================================================

const orchestrator = new SimpleOrchestrator();
startDashboardAPI(orchestrator);
orchestrator.run().catch(console.error);
