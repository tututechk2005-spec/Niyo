'use strict';
require('dotenv').config();

const config = {
  bot: {
    token:       process.env.BOT_TOKEN       || '',
    adminChatId: process.env.ADMIN_CHAT_ID   || '',
  },
  encryption: {
    key: process.env.ENCRYPTION_KEY || 'default-32-byte-encryption-key!!',
  },
};

// ─── BINANCE ENDPOINTS ────────────────────────────────────────────────────────
const BINANCE_SPOT_URL           = 'https://api.binance.com';
const BINANCE_FUTURES_URL        = 'https://fapi.binance.com';
const BINANCE_SPOT_TESTNET_URL   = 'https://testnet.binance.vision';
const BINANCE_FUTURES_TESTNET_URL= 'https://testnet.binancefuture.com';

// ─── STRATEGY CONSTANTS ───────────────────────────────────────────────────────
const SCORE_MIN_TRADE   = 95;   // Minimum confidence for trade entry
const SCORE_MIN_DISPLAY = 70;   // Minimum confidence to display in scanner

const SIGNAL_WEIGHTS = {
  trend_4h:    20,
  trend_1h:    15,
  trend_15m:   8,
  bos:         10,
  choch:       8,
  order_block: 10,
  fvg:         7,
  liq_sweep:   5,
  volume_spike: 4,
  rsi:         5,
  macd:        4,
  atr_ok:      4,
};

// RR thresholds
const MIN_RR        = 2.0;
const STRONG_RR     = 3.0;

// ATR / volatility
const ATR_PERIOD    = 14;
const ATR_THRESHOLD = 0.003; // Minimum ATR as % of price (avoid dead markets)

// Trend EMA periods
const EMA_FAST      = 20;
const EMA_SLOW      = 50;

// MACD
const MACD_FAST     = 12;
const MACD_SLOW     = 26;
const MACD_SIGNAL   = 9;

// ADX — avoid ranging markets below this
const ADX_MIN       = 22;
const ADX_PERIOD    = 14;

// RSI
const RSI_PERIOD    = 14;
const RSI_OB        = 70;
const RSI_OS        = 30;

// Cooldown between trades on same symbol (hours)
const COOLDOWN_HOURS = 4;

// Scan interval
const SCAN_INTERVAL_MS = 60_000;

// Live PNL update interval (3 seconds)
const LIVE_PNL_INTERVAL_MS = 3_000;

// ─── ACCOUNT LIMITS (now admin-controlled, not hardcoded) ────────────────────
const DEFAULT_MAX_ACTIVE_TRADES = 5;

module.exports = {
  config,
  BINANCE_SPOT_URL,
  BINANCE_FUTURES_URL,
  BINANCE_SPOT_TESTNET_URL,
  BINANCE_FUTURES_TESTNET_URL,
  SCORE_MIN_TRADE,
  SCORE_MIN_DISPLAY,
  SIGNAL_WEIGHTS,
  MIN_RR,
  STRONG_RR,
  ATR_PERIOD,
  ATR_THRESHOLD,
  EMA_FAST,
  EMA_SLOW,
  MACD_FAST,
  MACD_SLOW,
  MACD_SIGNAL,
  ADX_MIN,
  ADX_PERIOD,
  RSI_PERIOD,
  RSI_OB,
  RSI_OS,
  COOLDOWN_HOURS,
  SCAN_INTERVAL_MS,
  LIVE_PNL_INTERVAL_MS,
  DEFAULT_MAX_ACTIVE_TRADES,
};
