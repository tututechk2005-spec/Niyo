'use strict';
const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { config } = require('./config');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── AES-256 ENCRYPTION FOR API KEYS ─────────────────────────────────────────
function getEncKey() {
  const raw = config.encryption.key;
  return crypto.scryptSync(raw, 'salt', 32);
}

function encrypt(text) {
  if (!text) return '';
  try {
    const key = getEncKey();
    const iv  = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const enc  = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return iv.toString('hex') + ':' + enc.toString('hex');
  } catch { return text; }
}

function decrypt(encoded) {
  if (!encoded || !encoded.includes(':')) return encoded || '';
  try {
    const key = getEncKey();
    const [ivHex, encHex] = encoded.split(':');
    const iv      = Buffer.from(ivHex, 'hex');
    const encBuf  = Buffer.from(encHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([decipher.update(encBuf), decipher.final()]).toString('utf8');
  } catch { return encoded; }
}

// ─── JSON FILE HELPERS ────────────────────────────────────────────────────────
function readJSON(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return null; }
}

function writeJSON(filePath, data) {
  try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2)); } catch {}
}

// ─── USERS ────────────────────────────────────────────────────────────────────
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const usersDB = {
  _cache: null,

  _load() {
    if (!this._cache) this._cache = readJSON(USERS_FILE) || [];
    return this._cache;
  },

  _save() { writeJSON(USERS_FILE, this._cache || []); },

  findById(telegramId) {
    return this._load().find((u) => String(u.telegram_id) === String(telegramId)) || null;
  },

  findByUsername(username) {
    return this._load().find((u) => u.username === username) || null;
  },

  getAll() { return this._load(); },

  create(data) {
    const users = this._load();
    const user = {
      telegram_id:          data.telegram_id,
      username:             data.username || '',
      first_name:           data.first_name || '',
      last_name:            data.last_name || '',
      join_date:            new Date().toISOString(),
      subscription:         'inactive',
      plan:                 null,
      subscription_start:   null,
      subscription_end:     null,
      auto_trading:         false,
      api_key:              data.api_key || '',
      api_secret:           data.api_secret || '',
      market_type:          data.market_type || 'futures',
      testnet:              data.testnet || false,
      active_account_id:    null,
      balance:              0,
      available_balance:    0,
      margin_balance:       0,
      unrealized_pnl:       0,
      total_trades:         0,
      wins:                 0,
      losses:               0,
      breakeven:            0,
      win_rate:             0,
      net_pnl:              0,
      total_profit:         0,
      total_loss:           0,
      avg_win:              0,
      avg_loss:             0,
      consecutive_wins:     0,
      consecutive_losses:   0,
      today_pnl:            0,
      daily_wins:           0,
      daily_losses:         0,
      weekly_pnl:           0,
      spot_trades:          0,
      futures_trades:       0,
      referred_by:          data.referred_by || null,
      referral_code:        data.referral_code || null,
      last_binance_sync:    null,
      last_trade_date:      null,
      live_message_id:      null,
      live_chat_id:         null,
    };
    users.push(user);
    this._cache = users;
    this._save();
    return user;
  },

  update(telegramId, updates) {
    const users = this._load();
    const idx = users.findIndex((u) => String(u.telegram_id) === String(telegramId));
    if (idx < 0) return null;
    users[idx] = { ...users[idx], ...updates };
    this._cache = users;
    this._save();
    return users[idx];
  },

  invalidateCache() { this._cache = null; },
};

// ─── ACCOUNTS (multi-account, encrypted) ─────────────────────────────────────
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

const accountsDB = {
  _cache: null,

  _load() {
    if (!this._cache) this._cache = readJSON(ACCOUNTS_FILE) || [];
    return this._cache;
  },

  _save() { writeJSON(ACCOUNTS_FILE, this._cache || []); },

  forUser(userId) {
    return this._load().filter((a) => String(a.user_id) === String(userId));
  },

  findById(accountId) {
    return this._load().find((a) => a.id === accountId) || null;
  },

  add(userId, { label, market_type, testnet, api_key, api_secret }) {
    const accounts = this._load();
    const account = {
      id:           uuidv4(),
      user_id:      String(userId),
      label:        label || `Account ${accounts.filter((a) => String(a.user_id) === String(userId)).length + 1}`,
      market_type:  market_type || 'futures',
      testnet:      testnet || false,
      api_key_enc:  encrypt(api_key),
      api_secret_enc: encrypt(api_secret),
      created_at:   new Date().toISOString(),
    };
    accounts.push(account);
    this._cache = accounts;
    this._save();
    return account;
  },

  remove(accountId) {
    const accounts = this._load();
    this._cache = accounts.filter((a) => a.id !== accountId);
    this._save();
  },

  getDecrypted(account) {
    if (!account) return null;
    return {
      ...account,
      api_key:    decrypt(account.api_key_enc),
      api_secret: decrypt(account.api_secret_enc),
    };
  },

  update(accountId, updates) {
    const accounts = this._load();
    const idx = accounts.findIndex((a) => a.id === accountId);
    if (idx < 0) return null;
    if (updates.api_key)    { updates.api_key_enc    = encrypt(updates.api_key);    delete updates.api_key;    }
    if (updates.api_secret) { updates.api_secret_enc = encrypt(updates.api_secret); delete updates.api_secret; }
    accounts[idx] = { ...accounts[idx], ...updates };
    this._cache = accounts;
    this._save();
    return accounts[idx];
  },
};

// ─── TRADES ───────────────────────────────────────────────────────────────────
const TRADES_FILE = path.join(DATA_DIR, 'trades.json');

const tradesDB = {
  _cache: null,

  _load() {
    if (!this._cache) this._cache = readJSON(TRADES_FILE) || [];
    return this._cache;
  },

  _save() { writeJSON(TRADES_FILE, this._cache || []); },

  findById(tradeId) {
    return this._load().find((t) => t.trade_id === tradeId) || null;
  },

  forUser(userId) {
    return this._load().filter((t) => String(t.user_id) === String(userId));
  },

  openForUser(userId) {
    return this._load().filter((t) => String(t.user_id) === String(userId) && t.status === 'open');
  },

  allOpen() {
    return this._load().filter((t) => t.status === 'open');
  },

  create(data) {
    const trades = this._load();
    const trade = {
      trade_id:           uuidv4(),
      user_id:            data.user_id,
      signal_id:          data.signal_id || null,
      symbol:             data.symbol,
      side:               data.side,
      market_type:        data.market_type || 'futures',
      testnet:            data.testnet || false,
      entry:              data.entry,
      quantity:           data.quantity,
      leverage:           data.leverage || 1,
      margin_used:        data.margin_used || 0,
      sl:                 data.sl || null,
      tp:                 data.tp || null,
      liquidation_price:  data.liquidation_price || null,
      status:             'open',
      imported:           data.imported || false,
      open_time:          new Date().toISOString(),
      close_time:         null,
      close_price:        null,
      close_reason:       null,
      profit:             0,
      profit_pct:         0,
      current_price:      data.entry,
      result:             null,
      unrealized_pnl:     0,
    };
    trades.push(trade);
    this._cache = trades;
    this._save();
    return trade;
  },

  update(tradeId, updates) {
    const trades = this._load();
    const idx = trades.findIndex((t) => t.trade_id === tradeId);
    if (idx < 0) return null;
    trades[idx] = { ...trades[idx], ...updates };
    this._cache = trades;
    this._save();
    return trades[idx];
  },

  todayStats(userId) {
    const now   = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const trades = (userId ? this.forUser(userId) : this._load())
      .filter((t) => t.status === 'closed' && new Date(t.close_time) >= start);
    const wins = trades.filter((t) => t.profit > 0).length;
    const losses = trades.filter((t) => t.profit < 0).length;
    const be = trades.filter((t) => t.profit === 0).length;
    return { wins, losses, breakeven: be, pnl: trades.reduce((s, t) => s + (t.profit || 0), 0), count: trades.length };
  },

  weekStats(userId) {
    const now   = new Date();
    const start = new Date(now); start.setDate(now.getDate() - 7);
    const trades = (userId ? this.forUser(userId) : this._load())
      .filter((t) => t.status === 'closed' && new Date(t.close_time) >= start);
    const wins = trades.filter((t) => t.profit > 0).length;
    const losses = trades.filter((t) => t.profit < 0).length;
    const be = trades.filter((t) => t.profit === 0).length;
    return { wins, losses, breakeven: be, pnl: trades.reduce((s, t) => s + (t.profit || 0), 0), count: trades.length };
  },

  monthStats(userId) {
    const now   = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const trades = (userId ? this.forUser(userId) : this._load())
      .filter((t) => t.status === 'closed' && new Date(t.close_time) >= start);
    const wins = trades.filter((t) => t.profit > 0).length;
    const losses = trades.filter((t) => t.profit < 0).length;
    const be = trades.filter((t) => t.profit === 0).length;
    return { wins, losses, breakeven: be, pnl: trades.reduce((s, t) => s + (t.profit || 0), 0), count: trades.length };
  },

  countBreakeven(userId) {
    return this.forUser(userId).filter((t) => t.status === 'closed' && t.result === 'BREAKEVEN').length;
  },

  invalidateCache() { this._cache = null; },
};

// ─── SIGNALS ──────────────────────────────────────────────────────────────────
const SIGNALS_FILE = path.join(DATA_DIR, 'signals.json');

const signalsDB = {
  _cache: null,

  _load() {
    if (!this._cache) this._cache = readJSON(SIGNALS_FILE) || [];
    return this._cache;
  },

  _save() { writeJSON(SIGNALS_FILE, this._cache || []); },

  findById(signalId) {
    return this._load().find((s) => s.signal_id === signalId) || null;
  },

  create(data) {
    const signals = this._load();
    const signal = {
      signal_id:     uuidv4(),
      symbol:        data.symbol,
      signal:        data.signal,
      market_type:   data.market_type || 'futures',
      score:         data.score,
      grade:         data.grade || 'STRONG',
      entry:         data.entry,
      sl:            data.sl,
      tp:            data.tp,
      tp1:           data.tp1 || data.tp,
      rr:            data.rr,
      confirmations: data.confirmations || {},
      status:        'active',
      created_at:    new Date().toISOString(),
      closed_at:     null,
      channel_message_id: null,
    };
    signals.push(signal);
    this._cache = signals;
    this._save();
    return signal;
  },

  update(signalId, updates) {
    const signals = this._load();
    const idx = signals.findIndex((s) => s.signal_id === signalId);
    if (idx < 0) return null;
    signals[idx] = { ...signals[idx], ...updates };
    this._cache = signals;
    this._save();
    return signals[idx];
  },
};

// ─── CHANNEL ──────────────────────────────────────────────────────────────────
const CHANNEL_FILE = path.join(DATA_DIR, 'channel.json');

const channelDB = {
  get() {
    return readJSON(CHANNEL_FILE) || { enabled: false, channel_id: null, message_ids: {} };
  },

  set(updates) {
    const cur = this.get();
    writeJSON(CHANNEL_FILE, { ...cur, ...updates });
  },

  saveMessageId(signalId, messageId) {
    const cur = this.get();
    if (!cur.message_ids) cur.message_ids = {};
    cur.message_ids[signalId] = messageId;
    writeJSON(CHANNEL_FILE, cur);
  },

  getMessageId(signalId) {
    return this.get().message_ids?.[signalId] || null;
  },
};

// ─── ADMIN SETTINGS ───────────────────────────────────────────────────────────
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const settingsDB = {
  _defaults: {
    max_active_trades:      5,
    scan_interval_sec:      60,
    min_signal_score:       95,
    min_rr:                 2.0,
    max_leverage:           10,
    cooldown_hours:         4,
    spot_enabled:           true,
    futures_enabled:        true,
    testnet_enabled:        true,
    real_trading_enabled:   true,
    live_pnl_interval_sec:  3,
    min_volume_usdt:        1000000,
    atr_filter:             true,
    adx_filter:             true,
    adx_min:                22,
  },

  get() {
    const saved = readJSON(SETTINGS_FILE) || {};
    return { ...this._defaults, ...saved };
  },

  set(updates) {
    const cur = this.get();
    writeJSON(SETTINGS_FILE, { ...cur, ...updates });
  },

  setOne(key, value) {
    const cur = this.get();
    cur[key] = value;
    writeJSON(SETTINGS_FILE, cur);
  },
};

// ─── REFERRALS ────────────────────────────────────────────────────────────────
const REFERRALS_FILE = path.join(DATA_DIR, 'referrals.json');

const referralsDB = {
  _cache: null,

  _load() {
    if (!this._cache) this._cache = readJSON(REFERRALS_FILE) || [];
    return this._cache;
  },

  _save() { writeJSON(REFERRALS_FILE, this._cache || []); },

  forReferrer(userId) {
    return this._load().filter((r) => String(r.referrer_id) === String(userId));
  },

  findByReferred(userId) {
    return this._load().find((r) => String(r.referred_id) === String(userId)) || null;
  },

  log(data) {
    const referrals = this._load();
    const entry = {
      id:           uuidv4(),
      referrer_id:  String(data.referrer_id),
      referred_id:  String(data.referred_id),
      referred_username: data.referred_username || '',
      bonus_granted: data.bonus_granted || false,
      bonus_days:   data.bonus_days || 0,
      created_at:   new Date().toISOString(),
    };
    referrals.push(entry);
    this._cache = referrals;
    this._save();
    return entry;
  },

  countForReferrer(userId) {
    return this.forReferrer(userId).length;
  },

  invalidateCache() { this._cache = null; },
};

// ─── SUBSCRIPTIONS ────────────────────────────────────────────────────────────
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'subscriptions.json');

const subscriptionsDB = {
  getAll() { return readJSON(SUBSCRIPTIONS_FILE) || []; },

  log(data) {
    const subs = this.getAll();
    subs.push({
      id:          uuidv4(),
      user_id:     String(data.user_id),
      plan:        data.plan,
      start:       data.start || new Date().toISOString(),
      end:         data.end   || null,
      granted_by:  data.granted_by || 'admin',
      created_at:  new Date().toISOString(),
    });
    writeJSON(SUBSCRIPTIONS_FILE, subs);
  },
};

// ─── LIVE MESSAGE STORE (in-memory, for 3s PNL updates) ──────────────────────
const liveMessages = new Map();

const liveMessagesDB = {
  set(userId, data) { liveMessages.set(String(userId), data); },
  get(userId)       { return liveMessages.get(String(userId)) || null; },
  delete(userId)    { liveMessages.delete(String(userId)); },
  all()             { return [...liveMessages.entries()]; },
};

// ─── DB FACADE ────────────────────────────────────────────────────────────────
const db = {
  users:         usersDB,
  accounts:      accountsDB,
  trades:        tradesDB,
  signals:       signalsDB,
  channel:       channelDB,
  settings:      settingsDB,
  referrals:     referralsDB,
  subscriptions: subscriptionsDB,
  liveMessages:  liveMessagesDB,
};

module.exports = db;
