'use strict';
const { Markup } = require('telegraf');
const db     = require('./database');
const logger = require('./logger');
const { config } = require('./config');

function isAdmin(ctx) {
  return String(ctx.from?.id) === String(config.bot.adminChatId);
}

// ─── ADMIN PANEL ──────────────────────────────────────────────────────────────
async function showAdminPanel(ctx, edit = false) {
  const users    = db.users.getAll();
  const active   = users.filter((u) => u.subscription === 'active').length;
  const autoOn   = users.filter((u) => u.auto_trading).length;
  const trades   = db.trades.allOpen();
  const settings = db.settings.get();
  const chCfg    = db.channel.get();

  const msg =
    `🔐 <b>Admin Panel</b>\n\n` +
    `👥 Users: <b>${users.length}</b>  |  Active subs: <b>${active}</b>\n` +
    `🤖 Auto-trading: <b>${autoOn}</b>  |  Open trades: <b>${trades.length}</b>\n\n` +
    `⚙️ <b>Trading Settings</b>\n` +
    `  Max Active Trades: <b>${settings.max_active_trades}</b>\n` +
    `  Min Signal Score: <b>${settings.min_signal_score}</b>\n` +
    `  Min RR: <b>${settings.min_rr}</b>\n` +
    `  Max Leverage: <b>${settings.max_leverage}x</b>\n` +
    `  Cooldown: <b>${settings.cooldown_hours}h</b>\n` +
    `  Scan Interval: <b>${settings.scan_interval_sec}s</b>\n` +
    `  Live PNL Update: <b>${settings.live_pnl_interval_sec}s</b>\n\n` +
    `📡 <b>Markets</b>\n` +
    `  Futures: <b>${settings.futures_enabled ? '✅' : '❌'}</b>  |  Spot: <b>${settings.spot_enabled ? '✅' : '❌'}</b>\n` +
    `  Real Trading: <b>${settings.real_trading_enabled ? '✅' : '❌'}</b>\n` +
    `  ADX Filter: <b>${settings.adx_filter ? '✅' : '❌'}</b>  ADX Min: <b>${settings.adx_min}</b>\n\n` +
    `📢 Channel: <b>${chCfg.enabled ? chCfg.channel_id || '?' : 'Disabled'}</b>`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('👥 Users',              'admin_users'),
     Markup.button.callback('📊 Trading Settings',   'admin_trade_settings')],
    [Markup.button.callback('📢 Channel Settings',   'admin_channel'),
     Markup.button.callback('📜 Recent Logs',        'admin_logs')],
    [Markup.button.callback('💰 Grant Subscription', 'admin_grant_sub'),
     Markup.button.callback('🚫 Revoke Sub',         'admin_revoke_sub')],
    [Markup.button.callback('📈 All Trades',         'admin_all_trades'),
     Markup.button.callback('💹 Statistics',         'admin_global_stats')],
    [Markup.button.callback('🔄 Refresh',            'admin_panel')],
  ]);

  try {
    if (edit && ctx.callbackQuery) await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb });
    else await ctx.reply(msg, { parse_mode: 'HTML', ...kb });
  } catch { await ctx.reply(msg, { parse_mode: 'HTML', ...kb }); }
}

// ─── TRADING SETTINGS PANEL ───────────────────────────────────────────────────
async function showTradingSettings(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.answerCbQuery('❌ Unauthorized', { show_alert: true });
  const s = db.settings.get();

  const msg =
    `⚙️ <b>Trading Settings</b>\n\n` +
    `📌 <b>Max Active Trades:</b> ${s.max_active_trades}\n` +
    `🎯 <b>Min Signal Score:</b> ${s.min_signal_score}/100\n` +
    `⚖️ <b>Min Risk/Reward:</b> 1:${s.min_rr}\n` +
    `📊 <b>Max Leverage:</b> ${s.max_leverage}x\n` +
    `⏳ <b>Cooldown per Symbol:</b> ${s.cooldown_hours}h\n` +
    `🔍 <b>Scan Interval:</b> ${s.scan_interval_sec}s\n` +
    `🔄 <b>Live PNL Refresh:</b> ${s.live_pnl_interval_sec}s\n\n` +
    `📡 <b>Markets Enabled:</b>\n` +
    `  Futures: ${s.futures_enabled ? '✅' : '❌'}  |  Spot: ${s.spot_enabled ? '✅' : '❌'}\n\n` +
    `🛡 <b>Filters:</b>\n` +
    `  ADX Filter: ${s.adx_filter ? '✅' : '❌'}  Min ADX: ${s.adx_min}\n` +
    `  ATR Filter: ${s.atr_filter ? '✅' : '❌'}\n\n` +
    `🔴 Real Trading: ${s.real_trading_enabled ? '✅ ON' : '❌ OFF'}`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Max Trades +1',     'admin_set_maxTrades_plus'),
     Markup.button.callback('➖ Max Trades -1',     'admin_set_maxTrades_minus')],
    [Markup.button.callback('➕ Score +1',          'admin_set_score_plus'),
     Markup.button.callback('➖ Score -1',          'admin_set_score_minus')],
    [Markup.button.callback('➕ Min RR +0.5',       'admin_set_rr_plus'),
     Markup.button.callback('➖ Min RR -0.5',       'admin_set_rr_minus')],
    [Markup.button.callback('➕ Max Lev +1',        'admin_set_lev_plus'),
     Markup.button.callback('➖ Max Lev -1',        'admin_set_lev_minus')],
    [Markup.button.callback('➕ Cooldown +1h',      'admin_set_cooldown_plus'),
     Markup.button.callback('➖ Cooldown -1h',      'admin_set_cooldown_minus')],
    [Markup.button.callback('📊 Toggle Futures',    'admin_toggle_futures'),
     Markup.button.callback('📈 Toggle Spot',       'admin_toggle_spot')],
    [Markup.button.callback('🛡 Toggle ADX Filter', 'admin_toggle_adx'),
     Markup.button.callback('🔄 Toggle ATR Filter', 'admin_toggle_atr')],
    [s.real_trading_enabled
      ? Markup.button.callback('🔴 Disable Real Trading', 'admin_toggle_real_trading')
      : Markup.button.callback('🟢 Enable Real Trading',  'admin_toggle_real_trading')],
    [Markup.button.callback('🔙 Admin Panel', 'admin_panel')],
  ]);

  try { await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb }); }
  catch { await ctx.reply(msg, { parse_mode: 'HTML', ...kb }); }
}

// ─── HANDLE SETTING ADJUSTMENTS ───────────────────────────────────────────────
async function handleSettingToggle(ctx, action) {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.answerCbQuery('❌ Unauthorized', { show_alert: true });
  const s = db.settings.get();

  switch (action) {
    case 'admin_set_maxTrades_plus':
      db.settings.setOne('max_active_trades', Math.min(s.max_active_trades + 1, 50));
      break;
    case 'admin_set_maxTrades_minus':
      db.settings.setOne('max_active_trades', Math.max(s.max_active_trades - 1, 1));
      break;
    case 'admin_set_score_plus':
      db.settings.setOne('min_signal_score', Math.min(s.min_signal_score + 1, 100));
      break;
    case 'admin_set_score_minus':
      db.settings.setOne('min_signal_score', Math.max(s.min_signal_score - 1, 50));
      break;
    case 'admin_set_rr_plus':
      db.settings.setOne('min_rr', Math.min(parseFloat((s.min_rr + 0.5).toFixed(1)), 10));
      break;
    case 'admin_set_rr_minus':
      db.settings.setOne('min_rr', Math.max(parseFloat((s.min_rr - 0.5).toFixed(1)), 0.5));
      break;
    case 'admin_set_lev_plus':
      db.settings.setOne('max_leverage', Math.min(s.max_leverage + 1, 125));
      break;
    case 'admin_set_lev_minus':
      db.settings.setOne('max_leverage', Math.max(s.max_leverage - 1, 1));
      break;
    case 'admin_set_cooldown_plus':
      db.settings.setOne('cooldown_hours', Math.min(s.cooldown_hours + 1, 48));
      break;
    case 'admin_set_cooldown_minus':
      db.settings.setOne('cooldown_hours', Math.max(s.cooldown_hours - 1, 0));
      break;
    case 'admin_toggle_futures':
      db.settings.setOne('futures_enabled', !s.futures_enabled);
      break;
    case 'admin_toggle_spot':
      db.settings.setOne('spot_enabled', !s.spot_enabled);
      break;
    case 'admin_toggle_adx':
      db.settings.setOne('adx_filter', !s.adx_filter);
      break;
    case 'admin_toggle_atr':
      db.settings.setOne('atr_filter', !s.atr_filter);
      break;
    case 'admin_toggle_real_trading':
      db.settings.setOne('real_trading_enabled', !s.real_trading_enabled);
      break;
  }

  await showTradingSettings(ctx);
}

// ─── USER LIST ────────────────────────────────────────────────────────────────
async function showAdminUsers(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.answerCbQuery('❌ Unauthorized', { show_alert: true });

  const users = db.users.getAll().slice(0, 20);
  if (!users.length) {
    const kb = Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin', 'admin_panel')]]);
    return ctx.editMessageText('No users yet.', kb).catch(() => ctx.reply('No users yet.'));
  }

  let msg = `👥 <b>Users (${users.length})</b>\n\n`;
  for (const u of users) {
    const sub   = u.subscription === 'active' ? '✅' : '❌';
    const auto  = u.auto_trading ? '🤖' : '⏹';
    const open  = db.trades.openForUser(u.telegram_id).length;
    const accs  = db.accounts.forUser(u.telegram_id).length;
    msg += `${sub} <b>${u.first_name || u.username || u.telegram_id}</b> ${auto}\n` +
           `  ID: <code>${u.telegram_id}</code>  |  Accs: ${accs}  |  Open: ${open}\n` +
           `  Trades: ${u.total_trades || 0}  |  WR: ${u.win_rate || 0}%  |  Net: ${(u.net_pnl || 0).toFixed(2)}\n\n`;
  }

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('💰 Grant Sub',    'admin_grant_sub'),
     Markup.button.callback('🚫 Revoke Sub',  'admin_revoke_sub')],
    [Markup.button.callback('🔙 Admin Panel', 'admin_panel')],
  ]);
  try { await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb }); }
  catch { await ctx.reply(msg, { parse_mode: 'HTML', ...kb }); }
}

// ─── GRANT SUBSCRIPTION ───────────────────────────────────────────────────────
async function handleGrantSub(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.answerCbQuery('❌ Unauthorized', { show_alert: true });
  try {
    await ctx.editMessageText(
      '💰 <b>Grant Subscription</b>\n\nSend:\n<code>grant [user_id] [plan] [days]</code>\n\nExample: <code>grant 123456789 pro 30</code>',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin', 'admin_panel')]]) }
    );
  } catch { await ctx.reply('Send: grant [user_id] [plan] [days]'); }
}

async function handleRevokeSub(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.answerCbQuery('❌ Unauthorized', { show_alert: true });
  try {
    await ctx.editMessageText(
      '🚫 <b>Revoke Subscription</b>\n\nSend:\n<code>revoke [user_id]</code>',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin', 'admin_panel')]]) }
    );
  } catch { await ctx.reply('Send: revoke [user_id]'); }
}

// ─── GRANT/REVOKE TEXT COMMANDS ───────────────────────────────────────────────
async function processAdminCommand(ctx, text) {
  if (!isAdmin(ctx)) return;
  const parts = text.trim().split(/\s+/);
  const cmd   = parts[0].toLowerCase();

  if (cmd === 'grant') {
    const userId = parts[1];
    const plan   = parts[2] || 'pro';
    const days   = parseInt(parts[3] || '30');
    const user   = db.users.findById(userId);
    if (!user) return ctx.reply(`❌ User ${userId} not found`);
    const end = new Date(Date.now() + days * 86400000).toISOString();
    db.users.update(userId, {
      subscription:       'active',
      plan,
      subscription_start: new Date().toISOString(),
      subscription_end:   end,
    });
    db.subscriptions.log({ user_id: userId, plan, start: new Date().toISOString(), end });
    try { await ctx.telegram.sendMessage(userId, `✅ <b>Subscription Activated!</b>\n\nPlan: <b>${plan.toUpperCase()}</b>\nExpires: ${new Date(end).toLocaleDateString()}\n\nYou can now use auto-trading! 🚀`, { parse_mode: 'HTML' }); } catch {}
    return ctx.reply(`✅ Granted ${days}-day ${plan} subscription to ${user.first_name || userId}`);
  }

  if (cmd === 'revoke') {
    const userId = parts[1];
    const user   = db.users.findById(userId);
    if (!user) return ctx.reply(`❌ User ${userId} not found`);
    db.users.update(userId, { subscription: 'inactive', auto_trading: false });
    try { await ctx.telegram.sendMessage(userId, '❌ <b>Subscription Revoked</b>\n\nContact admin for details.', { parse_mode: 'HTML' }); } catch {}
    return ctx.reply(`✅ Revoked subscription for ${user.first_name || userId}`);
  }

  if (cmd === 'broadcast') {
    const message = parts.slice(1).join(' ');
    if (!message) return ctx.reply('Usage: broadcast [message]');
    const users = db.users.getAll();
    let sent = 0;
    for (const u of users) {
      try { await ctx.telegram.sendMessage(u.telegram_id, `📢 <b>Announcement</b>\n\n${message}`, { parse_mode: 'HTML' }); sent++; } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    return ctx.reply(`✅ Broadcast sent to ${sent} users`);
  }

  if (cmd === 'setchannel') {
    const channelId = parts[1];
    if (!channelId) return ctx.reply('Usage: setchannel @channelname or -100...');
    db.channel.set({ channel_id: channelId, enabled: true });
    return ctx.reply(`✅ Channel set to ${channelId}`);
  }

  if (cmd === 'disablechannel') {
    db.channel.set({ enabled: false });
    return ctx.reply('✅ Channel disabled');
  }
}

// ─── ADMIN LOGS ───────────────────────────────────────────────────────────────
async function showAdminLogs(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.answerCbQuery('❌ Unauthorized', { show_alert: true });
  const logger = require('./logger');
  const lines  = logger.recentLines(30).join('\n');
  const msg    = `📜 <b>Recent Logs</b>\n\n<pre>${lines.slice(-3500)}</pre>`;
  const kb     = Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin Panel', 'admin_panel')]]);
  try { await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb }); }
  catch { await ctx.reply(msg.slice(0, 4000), { parse_mode: 'HTML', ...kb }); }
}

// ─── GLOBAL STATS ─────────────────────────────────────────────────────────────
async function showGlobalStats(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.answerCbQuery('❌ Unauthorized', { show_alert: true });

  const today = db.trades.todayStats();
  const week  = db.trades.weekStats();
  const month = db.trades.monthStats();
  const open  = db.trades.allOpen();
  const users = db.users.getAll();

  const msg =
    `💹 <b>Global Statistics</b>\n\n` +
    `👥 Total Users: <b>${users.length}</b>\n` +
    `🔓 Open Trades: <b>${open.length}</b>\n\n` +
    `📅 <b>Today</b>  ✅${today.wins} ❌${today.losses}\n` +
    `  PNL: <b>${today.pnl >= 0 ? '+' : ''}${today.pnl.toFixed(4)} USDT</b>\n\n` +
    `📆 <b>Week</b>  ✅${week.wins} ❌${week.losses}\n` +
    `  PNL: <b>${week.pnl >= 0 ? '+' : ''}${week.pnl.toFixed(4)} USDT</b>\n\n` +
    `🗓 <b>Month</b>  ✅${month.wins} ❌${month.losses}\n` +
    `  PNL: <b>${month.pnl >= 0 ? '+' : ''}${month.pnl.toFixed(4)} USDT</b>`;

  const kb = Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin Panel', 'admin_panel')]]);
  try { await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb }); }
  catch { await ctx.reply(msg, { parse_mode: 'HTML', ...kb }); }
}

// ─── ALL OPEN TRADES ──────────────────────────────────────────────────────────
async function showAllTrades(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.answerCbQuery('❌ Unauthorized', { show_alert: true });

  const open = db.trades.allOpen().slice(0, 15);
  if (!open.length) {
    const kb = Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin', 'admin_panel')]]);
    try { await ctx.editMessageText('No open trades.', kb); } catch { await ctx.reply('No open trades.'); }
    return;
  }

  let msg = `📈 <b>All Open Trades (${open.length})</b>\n\n`;
  for (const t of open) {
    const pnl = (t.profit || 0).toFixed(4);
    msg += `${t.side === 'BUY' ? '🟢' : '🔴'} <b>${t.side} ${t.symbol}</b>\n` +
           `  User: <code>${t.user_id}</code>  |  PNL: <b>${t.profit >= 0 ? '+' : ''}${pnl}</b>\n\n`;
  }

  const kb = Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin', 'admin_panel')]]);
  try { await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb }); }
  catch { await ctx.reply(msg, { parse_mode: 'HTML', ...kb }); }
}

// ─── CHANNEL SETTINGS ─────────────────────────────────────────────────────────
async function showChannelSettings(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.answerCbQuery('❌ Unauthorized', { show_alert: true });
  const ch = db.channel.get();
  const msg =
    `📢 <b>Channel Settings</b>\n\n` +
    `Status: <b>${ch.enabled ? '✅ Enabled' : '❌ Disabled'}</b>\n` +
    `Channel: <b>${ch.channel_id || 'Not set'}</b>\n\n` +
    `To set: <code>setchannel @channelname</code>\n` +
    `To disable: <code>disablechannel</code>`;

  const kb = Markup.inlineKeyboard([
    [ch.enabled
      ? Markup.button.callback('❌ Disable Channel', 'admin_channel_disable')
      : Markup.button.callback('✅ Enable Channel',  'admin_channel_enable')],
    [Markup.button.callback('🔙 Admin Panel', 'admin_panel')],
  ]);
  try { await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb }); }
  catch { await ctx.reply(msg, { parse_mode: 'HTML', ...kb }); }
}

module.exports = {
  isAdmin,
  showAdminPanel,
  showTradingSettings,
  handleSettingToggle,
  showAdminUsers,
  handleGrantSub,
  handleRevokeSub,
  processAdminCommand,
  showAdminLogs,
  showGlobalStats,
  showAllTrades,
  showChannelSettings,
};
