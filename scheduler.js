'use strict';
const db     = require('./database');
const logger = require('./logger');
const { scanSymbols }    = require('./strategy');
const { getUserClient, executeTrade, updateLivePnl, syncUserFromBinance } = require('./trading');
const { publicFutures, publicSpot } = require('./binance');
const { LIVE_PNL_INTERVAL_MS } = require('./config');

let botRef       = null;
let scanning     = false;
let timers       = [];

function setBot(bot) { botRef = bot; }

// ─── SEND TRADE NOTIFICATION ──────────────────────────────────────────────────
async function notifyTrade(userId, signal, trade) {
  if (!botRef) return;
  try {
    const e = signal.signal === 'BUY' ? '🟢' : '🔴';
    const msg =
      `${e} <b>Trade Opened — ${signal.grade} Signal</b>\n\n` +
      `📌 <b>${signal.signal} ${signal.symbol}</b>\n` +
      `🎯 Confidence: <b>${signal.score}/100</b>\n` +
      `📍 Entry: <code>${trade.entry}</code>\n` +
      `🛡 SL: <code>${trade.sl}</code>\n` +
      `🎯 TP: <code>${trade.tp}</code>\n` +
      `⚖️ RR: <b>1:${signal.rr}</b>\n` +
      `📊 Market: <b>${(trade.market_type || 'FUTURES').toUpperCase()}</b>\n` +
      `📦 Qty: <code>${trade.quantity}</code>  |  Lev: <b>${trade.leverage}x</b>`;
    await botRef.telegram.sendMessage(userId, msg, { parse_mode: 'HTML' });
  } catch (err) {
    logger.debug('[SCHEDULER] notifyTrade error', { err: err.message });
  }
}

async function notifyClose(userId, trade, result) {
  if (!botRef) return;
  try {
    const emoji = result.result_label === 'WIN' ? '✅' : result.result_label === 'BREAKEVEN' ? '⚖️' : '❌';
    const msg =
      `${emoji} <b>Trade Closed — ${result.result_label}</b>\n\n` +
      `📌 ${trade.side} <b>${trade.symbol}</b>\n` +
      `📍 Entry: <code>${trade.entry}</code>  →  Exit: <code>${result.closePrice?.toFixed(8) || 'N/A'}</code>\n` +
      `💰 PNL: <b>${result.profit >= 0 ? '+' : ''}${result.profit?.toFixed(4)} USDT</b>  (${result.profitPct >= 0 ? '+' : ''}${result.profitPct?.toFixed(2)}%)\n` +
      `📋 Reason: ${trade.close_reason || 'AUTO'}`;
    await botRef.telegram.sendMessage(userId, msg, { parse_mode: 'HTML' });
  } catch {}
}

// ─── RESET DAILY STATS (midnight) ─────────────────────────────────────────────
function scheduleDailyReset() {
  const now  = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const ms   = next.getTime() - now.getTime();

  const t = setTimeout(async () => {
    logger.info('[SCHEDULER] Daily reset running');
    const users = db.users.getAll();
    for (const user of users) {
      db.users.update(user.telegram_id, {
        today_pnl:   0,
        daily_wins:  0,
        daily_losses:0,
      });
    }
    db.users.invalidateCache();
    scheduleDailyReset();
  }, ms);

  timers.push(t);
}

// ─── WEEKLY PNL RESET (Monday midnight) ───────────────────────────────────────
function scheduleWeeklyReset() {
  const now     = new Date();
  const day     = now.getDay();
  const daysUntilMonday = (8 - day) % 7 || 7;
  const next    = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysUntilMonday);
  const ms      = next.getTime() - now.getTime();

  const t = setTimeout(async () => {
    logger.info('[SCHEDULER] Weekly reset running');
    const users = db.users.getAll();
    for (const u of users) {
      db.users.update(u.telegram_id, { weekly_pnl: 0 });
    }
    db.users.invalidateCache();
    scheduleWeeklyReset();
  }, ms);

  timers.push(t);
}

// ─── LIVE PNL UPDATE (every 3 seconds) ───────────────────────────────────────
async function runLivePnlUpdate() {
  const users = db.users.getAll().filter((u) => u.auto_trading || db.trades.openForUser(u.telegram_id).length > 0);
  await Promise.allSettled(users.map((u) => updateLivePnl(u)));
  await updateLiveMessages();
}

async function updateLiveMessages() {
  if (!botRef) return;
  const all = db.liveMessages.all();
  for (const [userId, data] of all) {
    try {
      const user = db.users.findById(userId);
      if (!user) continue;
      const openTrades = db.trades.openForUser(userId);
      if (!openTrades.length) {
        db.liveMessages.delete(userId);
        continue;
      }
      const totalPnl = openTrades.reduce((s, t) => s + (t.profit || 0), 0);
      const msgText  =
        `📊 <b>Live Trading Monitor</b>\n` +
        `🔄 Updated: ${new Date().toLocaleTimeString()}\n\n` +
        `🔓 Open Trades: <b>${openTrades.length}</b>\n` +
        `💰 Live PNL: <b>${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} USDT</b>`;
      await botRef.telegram.editMessageText(data.chatId, data.messageId, null, msgText, { parse_mode: 'HTML' });
    } catch (err) {
      if (err.message?.includes('message is not modified')) continue;
      db.liveMessages.delete(userId);
    }
  }
}

// ─── BINANCE SYNC (every 25 seconds) ─────────────────────────────────────────
async function runBinanceSync() {
  const users = db.users.getAll().filter((u) => u.api_key || u.active_account_id);
  await Promise.allSettled(users.map((u) => syncUserFromBinance(u)));
  db.users.invalidateCache();
  db.trades.invalidateCache();
}

// ─── TRADING SCAN ─────────────────────────────────────────────────────────────
async function runTradingScan() {
  if (scanning) return;
  scanning = true;
  try {
    const settings  = db.settings.get();
    if (!settings.real_trading_enabled) { scanning = false; return; }

    const autoUsers = db.users.getAll().filter(
      (u) => u.auto_trading && u.subscription === 'active' && (u.api_key || u.active_account_id)
    );
    if (!autoUsers.length) { scanning = false; return; }

    logger.info(`[SCAN] Starting scan for ${autoUsers.length} active users`);

    const futClient  = publicFutures;
    const spotClient = publicSpot;

    const [futPairs, spotPairs] = await Promise.all([
      settings.futures_enabled ? futClient.getActivePairs(settings.min_volume_usdt || 1000000) : Promise.resolve([]),
      settings.spot_enabled    ? spotClient.getActivePairs(settings.min_volume_usdt || 500000)  : Promise.resolve([]),
    ]);

    const futSymbols  = futPairs.slice(0, 50).map((p) => p.symbol);
    const spotSymbols = spotPairs.slice(0, 30).map((p) => p.symbol);

    const [futSignals, spotSignals] = await Promise.all([
      futSymbols.length  ? scanSymbols(futSymbols,  futClient,  { tradeMode: true, dbSettings: settings }) : Promise.resolve([]),
      spotSymbols.length ? scanSymbols(spotSymbols, spotClient, { tradeMode: true, dbSettings: settings }) : Promise.resolve([]),
    ]);

    const allSignals = [...futSignals, ...spotSignals].sort((a, b) => b.score - a.score);
    logger.info(`[SCAN] Found ${allSignals.length} tradeable signals`);

    for (const user of autoUsers) {
      const client = getUserClient(user);
      if (!client) continue;

      const marketSignals = allSignals.filter((s) => {
        const userMkt = user.market_type || 'futures';
        return s.signal === (userMkt === 'futures' ? 'BUY' : 'BUY') ||
               true; // accept all directions
      });

      for (const signal of marketSignals.slice(0, 3)) {
        try {
          const result = await executeTrade(user, signal);
          if (result.success) {
            logger.info('[SCAN] Trade executed', { user: user.telegram_id, symbol: signal.symbol });
            await notifyTrade(user.telegram_id, signal, result.trade);

            const { postSignalToChannel } = require('./channel');
            const dbSignal = db.signals.create({
              symbol:        signal.symbol,
              signal:        signal.signal,
              market_type:   result.trade.market_type,
              score:         signal.score,
              grade:         signal.grade,
              entry:         signal.entry,
              sl:            signal.sl,
              tp:            signal.tp,
              rr:            signal.rr,
              confirmations: signal.confirmations,
            });
            await postSignalToChannel(dbSignal);
            break;
          }
        } catch (err) {
          logger.error('[SCAN] executeTrade error', { err: err.message, symbol: signal.symbol });
        }
      }
    }
  } catch (err) {
    logger.error('[SCAN] runTradingScan error', { err: err.message });
  } finally {
    scanning = false;
  }
}

// ─── RECONNECT WATCHDOG ───────────────────────────────────────────────────────
let lastHeartbeat = Date.now();

function heartbeat() { lastHeartbeat = Date.now(); }

async function reconnectWatchdog() {
  const elapsed = Date.now() - lastHeartbeat;
  if (elapsed > 120_000) {
    logger.warn('[WATCHDOG] Heartbeat stale — bot may be disconnected, restarting polling');
    try {
      if (botRef) {
        await botRef.telegram.getMe();
        heartbeat();
      }
    } catch (err) {
      logger.error('[WATCHDOG] Telegram ping failed', { err: err.message });
    }
  }
}

// ─── START ALL SCHEDULERS ─────────────────────────────────────────────────────
function start() {
  const settings = db.settings.get();
  const scanIntervalMs = (settings.scan_interval_sec || 60) * 1000;

  logger.info('[SCHEDULER] Starting schedulers', {
    scanInterval:   scanIntervalMs / 1000 + 's',
    livePnlInterval: LIVE_PNL_INTERVAL_MS / 1000 + 's',
  });

  const livePnlTimer    = setInterval(runLivePnlUpdate,  LIVE_PNL_INTERVAL_MS);
  const syncTimer       = setInterval(runBinanceSync,    25_000);
  const scanTimer       = setInterval(runTradingScan,    scanIntervalMs);
  const watchdogTimer   = setInterval(reconnectWatchdog, 60_000);

  timers.push(livePnlTimer, syncTimer, scanTimer, watchdogTimer);

  scheduleDailyReset();
  scheduleWeeklyReset();

  setTimeout(runBinanceSync, 5_000);
  setTimeout(runTradingScan, 15_000);

  logger.info('[SCHEDULER] All schedulers started');
}

function stop() {
  for (const t of timers) clearInterval(t);
  timers = [];
  logger.info('[SCHEDULER] All schedulers stopped');
}

module.exports = { start, stop, setBot, heartbeat, notifyTrade, notifyClose };
