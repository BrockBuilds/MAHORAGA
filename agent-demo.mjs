#!/usr/bin/env node

/**
 * MAHORAGA v1 - Demo Mode
 * Standalone trading agent for testing WITHOUT MCP server
 * Uses mock data and simulated trading
 */

import fs from "fs";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_CONFIG = {
  dashboard_port: 5000,

  // Trading parameters
  max_position_value: 2000,
  max_positions: 3,
  min_sentiment_score: 0.4,
  min_volume: 10,
  take_profit_pct: 8,
  stop_loss_pct: 4,
  trailing_stop_pct: 0,
  position_size_pct_of_cash: 20,
  volatility_scaling: false,
  daily_loss_limit_pct: 2,
  weekly_loss_limit_pct: 5,
  monthly_loss_limit_pct: 10,
  starting_equity: 100000,
};

// ============================================================================
// Mock Data Generator
// ============================================================================

const MOCK_STOCKS = ["AAPL", "TSLA", "NVDA", "AMD", "MSFT", "GOOGL", "AMZN", "META", "NFLX", "SPY"];

function generateMockSignals() {
  const signals = [];
  for (const symbol of MOCK_STOCKS.slice(0, 5)) {
    const sentiment = (Math.random() * 1.2 - 0.3);
    const volume = Math.floor(Math.random() * 50 + 10);
    const bullish = Math.floor(volume * (sentiment + 0.5));
    const bearish = volume - bullish;

    signals.push({
      symbol,
      source: "demo",
      sentiment,
      volume,
      bullish,
      bearish,
      reason: `Demo: ${bullish}B/${bearish}b (${(sentiment * 100).toFixed(0)}%)`,
      sources: ["demo"],
    });
  }
  return signals.sort((a, b) => b.sentiment - a.sentiment);
}

function generateMockAccount() {
  return {
    equity: 100000 + (Math.random() - 0.5) * 5000,
    cash: 70000 + (Math.random() - 0.5) * 10000,
    buying_power: 140000,
  };
}

function generateMockPositions() {
  const positions = [];
  const numPositions = Math.floor(Math.random() * 2);

  for (let i = 0; i < numPositions; i++) {
    const symbol = MOCK_STOCKS[Math.floor(Math.random() * MOCK_STOCKS.length)];
    const entryPrice = 100 + Math.random() * 200;
    const currentPrice = entryPrice * (1 + (Math.random() - 0.4) * 0.2);

    positions.push({
      symbol,
      qty: Math.floor(Math.random() * 10 + 1),
      avg_entry_price: entryPrice,
      current_price: currentPrice,
      market_value: (Math.floor(Math.random() * 10 + 1)) * currentPrice,
      unrealized_pl: (currentPrice - entryPrice) * Math.floor(Math.random() * 10 + 1),
    });
  }

  return positions;
}

// ============================================================================
// Dashboard API
// ============================================================================

function startDashboardAPI(config) {
  const PORT = config.dashboard_port;
  const signalCache = generateMockSignals();
  let account = generateMockAccount();
  let positions = generateMockPositions();

  // Update mock data periodically
  setInterval(() => {
    account = generateMockAccount();
    positions = generateMockPositions();
  }, 10000);

  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Content-Type", "application/json");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    try {
      if (url.pathname === "/api/status") {
        const dailyDrawdown = Math.random() * 1;
        const weeklyDrawdown = Math.random() * 3;
        const monthlyDrawdown = Math.random() * 5;

        res.writeHead(200);
        res.end(JSON.stringify({
          ok: true,
          data: {
            account,
            positions,
            clock: { is_open: true, next_open: new Date().toISOString(), next_close: new Date().toISOString() },
            config,
            signals: signalCache,
            logs: [{ timestamp: new Date().toISOString(), agent: "System", action: "demo_mode", message: "Running in demo mode" }],
            costs: { total_usd: 0, calls: 0 },
            lastAnalystRun: Date.now(),
            drawdown: {
              daily: dailyDrawdown,
              weekly: weeklyDrawdown,
              monthly: monthlyDrawdown,
              limits: {
                daily: config.daily_loss_limit_pct,
                weekly: config.weekly_loss_limit_pct,
                monthly: config.monthly_loss_limit_pct,
              },
            },
            positionTracking: {},
          },
        }));
      } else if (url.pathname === "/api/config") {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, data: config }));
      } else if (url.pathname === "/api/logs") {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, data: [] }));
      } else if (url.pathname === "/api/backtest" && req.method === "POST") {
        res.writeHead(200);
        res.end(JSON.stringify({
          ok: true,
          data: {
            symbol: "AAPL",
            period: { start: "2024-01-01", end: "2024-12-31" },
            initial_capital: 10000,
            final_capital: 11500,
            metrics: {
              total_return_pct: 15,
              trade_count: 45,
              win_rate: 0.55,
              avg_win_pct: 6.5,
              avg_loss_pct: -4.2,
              profit_factor: 1.8,
              max_drawdown_pct: 8.5,
              sharpe_ratio: 1.2,
            },
          },
        }));
      } else if (url.pathname === "/api/alerts/summary") {
        res.writeHead(200);
        res.end(JSON.stringify({
          ok: true,
          data: { total: 5, unread: 2, by_priority: { critical: 0, high: 1, medium: 2, low: 1, info: 1 } },
        }));
      } else if (url.pathname === "/api/alerts") {
        res.writeHead(200);
        res.end(JSON.stringify({
          ok: true,
          data: [
            { id: "1", type: "trade_executed", priority: "info", message: "BUY AAPL - $1500", timestamp: new Date().toISOString(), read: false },
            { id: "2", type: "llm_decision", priority: "info", message: "SKIP TSLA - Low confidence", timestamp: new Date().toISOString(), read: false },
            { id: "3", type: "drawdown_warning", priority: "high", message: "Daily drawdown at 1.5%", timestamp: new Date().toISOString(), read: true },
          ],
        }));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ ok: false, error: "Not found" }));
      }
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });

  server.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`  MAHORAGA v1 - DEMO MODE`);
    console.log(`========================================\n`);
    console.log(`Dashboard API: http://localhost:${PORT}`);
    console.log(`  GET  /api/status         - Full status (mock data)`);
    console.log(`  GET  /api/config         - Get config`);
    console.log(`  GET  /api/logs           - Activity logs`);
    console.log(`  POST /api/backtest       - Run backtest (mock)`);
    console.log(`  GET  /api/alerts         - Alerts (mock)`);
    console.log(`  GET  /api/alerts/summary - Alert summary\n`);
    console.log(`React Dashboard: http://localhost:5174\n`);
  });
}

// ============================================================================
// Entry Point
// ============================================================================

const config = { ...DEFAULT_CONFIG };

startDashboardAPI(config);

console.log("Press Ctrl+C to stop\n");
