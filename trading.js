'use strict';
const db     = require('./database');
const logger = require('./logger');
const { createClient } = require('./binance');
const { COOLDOWN_HOURS } = require('./config');

// ─── GET ACTIVE CLIENT FOR USER ───────────────────────────────────────────────
function getUserClient(user) {
  if (!user) return null;
  if (user.active_account_id) {
    const acc = db.accounts.findById(user.active_account_id);
    if (acc) {
      const dec = db.accounts.getDecrypted(acc);
      const proxy = {
        ...user,
        api_key:     dec.api_key,
        api_secret:  dec.api_secret,
        market_type: dec.market_type,
        testnet:     dec.testnet,
      };
      return createClient(proxy);
    }
  }
  if (user.api_key) return createClient(user);
  return null;
}

// ─── CHECK IF USER CAN OPEN NEW TRADE ─────────────────────────────────────────
function canOpenTrade(user, symbol = null) {
  const settings = db.settings.get();
  const maxActive = settings.max_active_trades ?? 5;

  const openTrades = db.trades.openForUser(user.telegram_id);
  if (openTrades.length >= maxActive) {
    return { ok: false, reason: `Max active trades reached (${maxActive})` };
  }

  if (symbol) {
    const cooldownHours = settings.cooldown_hours ?? COOLDOWN_HOURS;
    const cooldownMs    = cooldownHours * 60 * 60 * 1000;
    const recent = openTrades.find((t) => t.symbol === symbol);
    if (recent) return { ok: false, reason: `Already have open trade on ${symbol}` };

    const lastClosed = db.trades.forUser(user.telegram_id)
      .filter((t) => t.status === 'closed' && t.symbol === symbol)
      .sort((a, b) => new Date(b.close_time) - new Date(a.close_time))
      .at(0);

    if (lastClosed && Date.now() - new Date(lastClosed.close_time).getTime() < cooldownMs) {
      return { ok: false, reason: `Cooldown active for ${symbol}` };
    }
  }

  return { ok: true };
}

// ─── SYNC USER FROM BINANCE ───────────────────────────────────────────────────
async function syncUserFromBinance(user) {
  const client = getUserClient(user);
  if (!client) return;

  try {
    const [bal, positions] = await Promise.all([
      client.getBalance(),
      client.getOpenPositions(),
    ]);

    await db.users.update(user.telegram_id, {
      balance:           bal.free,
      available_balance: bal.available ?? bal.free,
      margin_balance:    bal.margin_balance ?? bal.total,
      unrealized_pnl:    bal.unrealized_pnl ?? 0,
      last_binance_sync: new Date().toISOString(),
    });

    if (positions.length > 0) {
      await importOrUpdatePositions(user, positions, client);
    }

  } catch (err) {
    logger.debug('[SYNC] syncUserFromBinance error', { user: user.telegram_id, err: err.message });
  }
}

// ─── IMPORT / UPDATE OPEN POSITIONS ──────────────────────────────────────────
async function importOrUpdatePositions(user, positions, client) {
  const openTrades = db.trades.openForUser(user.telegram_id);

  for (const pos of positions) {
    const existing = openTrades.find((t) => t.symbol === pos.symbol && t.status === 'open');
    if (existing) {
      db.trades.update(existing.trade_id, {
        current_price:     pos.current_price,
        profit:            pos.profit,
        profit_pct:        pos.profit_pct,
        unrealized_pnl:    pos.unrealized_pnl,
        liquidation_price: pos.liquidation_price,
        margin_used:       pos.margin_used,
      });
    } else {
      db.trades.create({
        user_id:           user.telegram_id,
        symbol:            pos.symbol,
        side:              pos.side,
        market_type:       user.market_type || 'futures',
        testnet:           user.testnet || false,
        entry:             pos.entry,
        quantity:          pos.quantity,
        leverage:          pos.leverage,
        margin_used:       pos.margin_used,
        liquidation_price: pos.liquidation_price,
        current_price:     pos.current_price,
        profit:            pos.profit,
        profit_pct:        pos.profit_pct,
        unrealized_pnl:    pos.unrealized_pnl,
        imported:          true,
      });
    }
  }

  for (const trade of openTrades) {
    const stillOpen = positions.find((p) => p.symbol === trade.symbol);
    if (!stillOpen && !trade.imported) {
      // Position was closed externally — mark closed
      await closeTradeFromExternal(user, trade, client);
    }
  }
}

// ─── EXECUTE TRADE ────────────────────────────────────────────────────────────
async function executeTrade(user, signal) {
  const client = getUserClient(user);
  if (!client) return { success: false, error: 'No Binance client' };

  try {
    const settings  = db.settings.get();
    const check     = canOpenTrade(user, signal.symbol);
    if (!check.ok)  return { success: false, error: check.reason };

    const bal     = await client.getBalance();
    const avail   = bal.available ?? bal.free;

    if (avail < 10) return { success: false, error: 'Insufficient balance (< 10 USDT)' };

    const leverage  = Math.min(signal.leverage || 10, settings.max_leverage || 10);
    const riskPct   = 0.02;
    const riskUSDT  = avail * riskPct;
    const quantity  = parseFloat((riskUSDT * leverage / signal.entry).toFixed(3));

    if (quantity <= 0) return { success: false, error: 'Calculated quantity too small' };

    if (client.marketType === 'futures') {
      try { await client.setLeverage(signal.symbol, leverage); } catch {}
      try { await client.setMarginType(signal.symbol, 'ISOLATED'); } catch {}
    }

    const side  = signal.signal === 'BUY' ? 'BUY' : 'SELL';
    const order = await client.placeMarketOrder(signal.symbol, side, quantity);
    const fillPrice = parseFloat(order.avgPrice || order.price || signal.entry);

    const atrVal    = signal.atr || Math.abs(fillPrice - signal.sl) / 1.5;
    const slDist    = atrVal * 1.5;
    const tpDist    = slDist * 2.2;
    const sl = side === 'BUY' ? fillPrice - slDist : fillPrice + slDist;
    const tp = side === 'BUY' ? fillPrice + tpDist : fillPrice - tpDist;

    const marginUsed = parseFloat(((quantity * fillPrice) / leverage).toFixed(4));

    const trade = db.trades.create({
      user_id:     user.telegram_id,
      signal_id:   signal.signal_id || null,
      symbol:      signal.symbol,
      side,
      market_type: client.marketType || user.market_type || 'futures',
      testnet:     user.testnet || false,
      entry:       fillPrice,
      quantity,
      leverage,
      margin_used: marginUsed,
      sl:          parseFloat(sl.toFixed(8)),
      tp:          parseFloat(tp.toFixed(8)),
    });

    logger.info(`[TRADE] Opened ${side} ${signal.symbol}`, {
      user: user.telegram_id, entry: fillPrice, qty: quantity, score: signal.score,
    });

    return { success: true, trade, order };
  } catch (err) {
    logger.error('[TRADE] executeTrade failed', { err: err.message, symbol: signal.symbol });
    return { success: false, error: err.message };
  }
}

// ─── CLOSE TRADE ──────────────────────────────────────────────────────────────
async function closeTrade(user, trade, reason = 'MANUAL') {
  const client = getUserClient(user);
  if (!client) return { success: false, error: 'No Binance client' };

  try {
    const closeSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
    let order;
    try {
      order = await client.placeMarketOrder(trade.symbol, closeSide, trade.quantity);
    } catch (err) {
      logger.warn('[CLOSE] Market order failed, recording manual close', { err: err.message });
      order = null;
    }

    let closePrice = null;
    if (order) {
      closePrice = parseFloat(order.avgPrice || order.price || 0);
    }

    if (!closePrice && client.marketType === 'futures') {
      try {
        const fp = await client.getActualFillPrice(trade.symbol, trade.open_time, closeSide);
        closePrice = fp;
      } catch {}
    }

    if (!closePrice) {
      try {
        const px = await client.getPrice(trade.symbol);
        closePrice = parseFloat(px.price || px.lastPrice || 0);
      } catch {}
    }

    if (!closePrice) closePrice = trade.entry;

    const priceDiff = trade.side === 'BUY' ? closePrice - trade.entry : trade.entry - closePrice;
    const profit    = parseFloat((priceDiff * trade.quantity).toFixed(4));
    const profitPct = trade.entry > 0
      ? parseFloat(((priceDiff / trade.entry) * 100 * (trade.leverage || 1)).toFixed(2))
      : 0;

    const result_label = profit > 0.01 ? 'WIN' : profit < -0.01 ? 'LOSS' : 'BREAKEVEN';
    const isWin        = result_label === 'WIN';

    db.trades.update(trade.trade_id, {
      status:       'closed',
      close_time:   new Date().toISOString(),
      close_price:  closePrice,
      close_reason: reason,
      profit,
      profit_pct:   profitPct,
      result:       result_label,
    });

    updateUserStats(user, { profit, isWin, result_label });

    logger.info(`[CLOSE] ${result_label} ${trade.side} ${trade.symbol}`, {
      user: user.telegram_id, profit, closePrice, reason,
    });

    return { success: true, profit, profitPct, closePrice, result_label, isWin };
  } catch (err) {
    logger.error('[CLOSE] closeTrade failed', { err: err.message });
    return { success: false, error: err.message };
  }
}

// ─── CLOSE TRADE WITHOUT EXECUTING ORDER (external close detected) ──────────
async function closeTradeFromExternal(user, trade, client) {
  let closePrice = null;
  try {
    const px    = await client.getPrice(trade.symbol);
    closePrice  = parseFloat(px.price || px.lastPrice || trade.entry);
  } catch { closePrice = trade.entry; }

  const priceDiff = trade.side === 'BUY' ? closePrice - trade.entry : trade.entry - closePrice;
  const profit    = parseFloat((priceDiff * trade.quantity).toFixed(4));
  const profitPct = trade.entry > 0
    ? parseFloat(((priceDiff / trade.entry) * 100 * (trade.leverage || 1)).toFixed(2))
    : 0;

  const result_label = profit > 0.01 ? 'WIN' : profit < -0.01 ? 'LOSS' : 'BREAKEVEN';
  const isWin        = result_label === 'WIN';

  db.trades.update(trade.trade_id, {
    status:       'closed',
    close_time:   new Date().toISOString(),
    close_price:  closePrice,
    close_reason: 'SL/TP_HIT',
    profit,
    profit_pct:   profitPct,
    result:       result_label,
  });

  updateUserStats(user, { profit, isWin, result_label });
}

// ─── UPDATE USER STATS ────────────────────────────────────────────────────────
function updateUserStats(user, { profit, isWin, result_label }) {
  const fresh = db.users.findById(user.telegram_id);
  if (!fresh) return;

  const totalTrades    = (fresh.total_trades || 0) + 1;
  const wins           = (fresh.wins  || 0) + (isWin ? 1 : 0);
  const losses         = (fresh.losses|| 0) + (result_label === 'LOSS' ? 1 : 0);
  const breakeven      = (fresh.breakeven || 0) + (result_label === 'BREAKEVEN' ? 1 : 0);
  const winRate        = totalTrades > 0 ? parseFloat(((wins / totalTrades) * 100).toFixed(1)) : 0;

  const totalProfit    = (fresh.total_profit || 0) + (profit > 0 ? profit : 0);
  const totalLoss      = (fresh.total_loss   || 0) + (profit < 0 ? Math.abs(profit) : 0);
  const netPnl         = (fresh.net_pnl      || 0) + profit;

  const avgWin  = wins > 0   ? parseFloat((totalProfit / wins).toFixed(4))  : 0;
  const avgLoss = losses > 0 ? parseFloat((totalLoss   / losses).toFixed(4)): 0;

  const consWins   = isWin ? (fresh.consecutive_wins || 0) + 1 : 0;
  const consLosses = result_label === 'LOSS' ? (fresh.consecutive_losses || 0) + 1 : 0;

  const todayPnl   = (fresh.today_pnl   || 0) + profit;
  const dailyWins  = (fresh.daily_wins  || 0) + (isWin ? 1 : 0);
  const dailyLosses= (fresh.daily_losses|| 0) + (result_label === 'LOSS' ? 1 : 0);
  const weeklyPnl  = (fresh.weekly_pnl  || 0) + profit;

  const spotFut = (fresh.market_type || user.market_type || 'futures') === 'spot'
    ? { spot_trades: (fresh.spot_trades || 0) + 1 }
    : { futures_trades: (fresh.futures_trades || 0) + 1 };

  db.users.update(user.telegram_id, {
    total_trades:        totalTrades,
    wins,
    losses,
    breakeven,
    win_rate:            winRate,
    total_profit:        parseFloat(totalProfit.toFixed(4)),
    total_loss:          parseFloat(totalLoss.toFixed(4)),
    net_pnl:             parseFloat(netPnl.toFixed(4)),
    avg_win:             avgWin,
    avg_loss:            avgLoss,
    consecutive_wins:    consWins,
    consecutive_losses:  consLosses,
    today_pnl:           parseFloat(todayPnl.toFixed(4)),
    daily_wins:          dailyWins,
    daily_losses:        dailyLosses,
    weekly_pnl:          parseFloat(weeklyPnl.toFixed(4)),
    last_trade_date:     new Date().toISOString(),
    ...spotFut,
  });
}

// ─── PARTIAL CLOSE ────────────────────────────────────────────────────────────
async function partialClose(user, trade, pct = 50) {
  const client = getUserClient(user);
  if (!client) return { success: false, error: 'No client' };

  try {
    const closeQty  = parseFloat((trade.quantity * pct / 100).toFixed(3));
    if (closeQty <= 0) return { success: false, error: 'Quantity too small' };
    const closeSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
    const order = await client.placeMarketOrder(trade.symbol, closeSide, closeQty);
    const closePrice = parseFloat(order.avgPrice || order.price || trade.entry);

    const priceDiff = trade.side === 'BUY' ? closePrice - trade.entry : trade.entry - closePrice;
    const partialProfit = parseFloat((priceDiff * closeQty).toFixed(4));
    const newQty = parseFloat((trade.quantity - closeQty).toFixed(3));

    if (newQty <= 0) {
      return closeTrade(user, trade, 'PARTIAL_FULL');
    }

    db.trades.update(trade.trade_id, { quantity: newQty });
    updateUserStats(user, { profit: partialProfit, isWin: partialProfit > 0, result_label: partialProfit > 0 ? 'WIN' : 'LOSS' });

    return { success: true, profit: partialProfit, closePrice, newQty, pct };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── UPDATE LIVE PNL FOR ALL OPEN TRADES ──────────────────────────────────────
async function updateLivePnl(user) {
  const client = getUserClient(user);
  if (!client) return;

  try {
    const openTrades = db.trades.openForUser(user.telegram_id);
    if (!openTrades.length) return;

    const prices = await Promise.allSettled(
      [...new Set(openTrades.map((t) => t.symbol))].map(async (sym) => {
        const px = await client.getPrice(sym);
        return { sym, price: parseFloat(px.price || px.lastPrice || 0) };
      })
    );

    const priceMap = {};
    for (const r of prices) {
      if (r.status === 'fulfilled') priceMap[r.value.sym] = r.value.price;
    }

    for (const trade of openTrades) {
      const curPrice = priceMap[trade.symbol];
      if (!curPrice) continue;
      const diff     = trade.side === 'BUY' ? curPrice - trade.entry : trade.entry - curPrice;
      const profit   = parseFloat((diff * trade.quantity).toFixed(4));
      const profitPct = trade.entry > 0
        ? parseFloat(((diff / trade.entry) * 100 * (trade.leverage || 1)).toFixed(2))
        : 0;
      db.trades.update(trade.trade_id, { current_price: curPrice, profit, profit_pct: profitPct });
    }
  } catch (err) {
    logger.debug('[LIVE-PNL] updateLivePnl error', { err: err.message });
  }
}

module.exports = {
  getUserClient,
  canOpenTrade,
  syncUserFromBinance,
  executeTrade,
  closeTrade,
  partialClose,
  updateLivePnl,
  updateUserStats,
  importOrUpdatePositions,
};
