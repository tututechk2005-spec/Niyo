'use strict';
require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const db         = require('./database');
const logger     = require('./logger');
const { config } = require('./config');
const dashboard  = require('./dashboard');
const admin      = require('./admin');
const { handleReferral, processReferral, generateCode } = require('./referral');
const scheduler  = require('./scheduler');
const channel    = require('./channel');

if (!config.bot.token) { logger.error('BOT_TOKEN not set'); process.exit(1); }

const bot = new Telegraf(config.bot.token);

bot.use(session());

// ─── STATE MACHINE ────────────────────────────────────────────────────────────
// ctx.session.state: 'idle' | 'awaiting_api_key' | 'awaiting_api_secret' | 'awaiting_account_label' | ...
// ctx.session.pendingAccount: { label, market_type, testnet, api_key }

function getSession(ctx) {
  if (!ctx.session) ctx.session = {};
  return ctx.session;
}

// ─── SUBSCRIPTION PAGE ────────────────────────────────────────────────────────
async function showSubscription(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const user = db.users.findById(ctx.from.id);
  if (!user) return ctx.reply('Use /start first.');

  const sub      = user.subscription === 'active';
  const end      = user.subscription_end ? new Date(user.subscription_end).toLocaleDateString() : '—';
  const plan     = user.plan || '—';
  const refCode  = user.referral_code || generateCode(user.telegram_id);
  if (!user.referral_code) db.users.update(user.telegram_id, { referral_code: refCode });

  const msg =
    `💳 <b>Subscription</b>\n\n` +
    `Status: ${sub ? '✅ <b>ACTIVE</b>' : '❌ <b>Inactive</b>'}\n` +
    `Plan: <b>${plan.toUpperCase()}</b>\n` +
    `${sub ? `Expires: <b>${end}</b>\n` : ''}` +
    `\n📦 <b>Plans Available:</b>\n` +
    `  • Starter — 7 days\n` +
    `  • Pro — 30 days\n` +
    `  • Elite — 90 days\n\n` +
    `<i>Contact admin to activate your subscription.</i>\n\n` +
    `🎁 Your referral code: <code>${refCode}</code>`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('🎁 Referral Program', 'referral')],
    [Markup.button.callback('🔙 Dashboard',        'dashboard')],
  ]);
  try { await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb }); }
  catch { await ctx.reply(msg, { parse_mode: 'HTML', ...kb }); }
}

// ─── HELP ─────────────────────────────────────────────────────────────────────
async function showHelp(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const msg =
    `ℹ️ <b>Help</b>\n\n` +
    `<b>Commands:</b>\n` +
    `/start — Open Dashboard\n` +
    `/help  — Show this help\n\n` +
    `<b>How it works:</b>\n` +
    `1️⃣ Connect your Binance API (Settings → Switch Account → Add Account)\n` +
    `2️⃣ Get a subscription from admin\n` +
    `3️⃣ Enable Auto Trading from Dashboard\n` +
    `4️⃣ The bot scans markets 24/7 using 95%+ confidence AI signals\n\n` +
    `<b>Strategy: SMC/ICT Pro Sniper</b>\n` +
    `✅ Multi-timeframe: 15m, 1H, 4H\n` +
    `✅ MACD + RSI confirmation\n` +
    `✅ Smart Money Concepts (BOS, CHoCH, OB, FVG)\n` +
    `✅ Liquidity sweep detection\n` +
    `✅ ADX trend filter (no ranging markets)\n` +
    `✅ ATR volatility filter\n` +
    `✅ Minimum 95% confidence score\n\n` +
    `<b>Multi-Account:</b>\n` +
    `You can save multiple Binance accounts and switch between them instantly.\n\n` +
    `<b>Support:</b> Contact @admin`;

  const kb = Markup.inlineKeyboard([[Markup.button.callback('🔙 Dashboard', 'dashboard')]]);
  try { await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb }); }
  catch { await ctx.reply(msg, { parse_mode: 'HTML', ...kb }); }
}

// ─── /start ───────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const s = getSession(ctx);
  s.state = 'idle';

  const from = ctx.from;
  let user   = db.users.findById(from.id);

  let referralCode = null;
  const startPayload = ctx.startPayload;
  if (startPayload && startPayload.startsWith('REF')) referralCode = startPayload;

  if (!user) {
    const code = generateCode(from.id);
    user = db.users.create({
      telegram_id: from.id,
      username:    from.username || '',
      first_name:  from.first_name || '',
      last_name:   from.last_name || '',
      referral_code: code,
    });
    logger.info(`[BOT] New user: ${from.id}`);
    if (referralCode) await processReferral(user, referralCode);
  } else {
    db.users.update(from.id, {
      username:   from.username   || user.username,
      first_name: from.first_name || user.first_name,
      last_name:  from.last_name  || user.last_name,
    });
    user = db.users.findById(from.id);
  }

  scheduler.heartbeat();
  await dashboard.showDashboard(ctx, user, false);
});

// ─── /help ────────────────────────────────────────────────────────────────────
bot.help(async (ctx) => {
  const user = db.users.findById(ctx.from.id);
  if (!user) return ctx.reply('Use /start first.');
  await ctx.reply('ℹ️ Use /start to open Dashboard.');
});

// ─── /admin ───────────────────────────────────────────────────────────────────
bot.command('admin', async (ctx) => {
  if (!admin.isAdmin(ctx)) return ctx.reply('❌ Unauthorized');
  await admin.showAdminPanel(ctx, false);
});

// ─── TEXT HANDLER (state machine + admin commands) ────────────────────────────
bot.on('text', async (ctx) => {
  const s    = getSession(ctx);
  const text = ctx.message.text.trim();

  scheduler.heartbeat();

  if (admin.isAdmin(ctx) && /^(grant|revoke|broadcast|setchannel|disablechannel)\b/i.test(text)) {
    return admin.processAdminCommand(ctx, text);
  }

  const user = db.users.findById(ctx.from.id);
  if (!user) return ctx.reply('Use /start to begin.');

  // ── API Key entry flow ──
  if (s.state === 'awaiting_api_key') {
    const key = text.trim();
    if (key.length < 10) return ctx.reply('❌ Invalid API key. Please try again:');
    s.pendingAccount = { ...(s.pendingAccount || {}), api_key: key };
    s.state = 'awaiting_api_secret';
    return ctx.reply('🔐 Now paste your <b>API Secret</b>:', { parse_mode: 'HTML' });
  }

  if (s.state === 'awaiting_api_secret') {
    const secret = text.trim();
    if (secret.length < 10) return ctx.reply('❌ Invalid API secret. Please try again:');
    s.pendingAccount = { ...(s.pendingAccount || {}), api_secret: secret };
    s.state = 'verifying_api';

    await ctx.reply('⏳ Verifying credentials with Binance...');

    try {
      const { BinanceSpotClient, BinanceFuturesClient } = require('./binance');
      const mkt    = s.pendingAccount.market_type || 'futures';
      const testnet = s.pendingAccount.testnet || false;
      const client = mkt === 'futures'
        ? new BinanceFuturesClient(s.pendingAccount.api_key, s.pendingAccount.api_secret, testnet)
        : new BinanceSpotClient(s.pendingAccount.api_key, s.pendingAccount.api_secret, testnet);

      const verify = await client.verifyCredentials();
      if (!verify.valid) {
        s.state = 'idle';
        s.pendingAccount = null;
        return ctx.reply(
          `${verify.errorTitle}\n\n${verify.errorReason}\n\nPlease check your API key and try again via Settings → Add Account.`,
          { parse_mode: 'HTML' }
        );
      }

      const label = s.pendingAccount.label || `${mkt.toUpperCase()} Account`;
      const acc   = db.accounts.add(user.telegram_id, {
        label,
        market_type:  mkt,
        testnet,
        api_key:      s.pendingAccount.api_key,
        api_secret:   s.pendingAccount.api_secret,
      });

      db.users.update(user.telegram_id, {
        active_account_id: acc.id,
        market_type:       mkt,
        testnet,
        api_key:           s.pendingAccount.api_key,
        api_secret:        s.pendingAccount.api_secret,
      });

      s.state = 'idle';
      s.pendingAccount = null;

      const freshUser = db.users.findById(user.telegram_id);
      await ctx.reply(
        `✅ <b>Account Connected!</b>\n\n` +
        `📊 Type: <b>${verify.accountType}</b>\n` +
        `💵 Balance: <b>${(verify.usdtBalance || 0).toFixed(2)} USDT</b>\n` +
        `🔑 Label: <b>${label}</b>\n\n` +
        `You can now use auto trading!`,
        { parse_mode: 'HTML' }
      );
      await dashboard.showDashboard(ctx, freshUser, false);
    } catch (err) {
      s.state = 'idle';
      s.pendingAccount = null;
      logger.error('[BOT] API verify error', { err: err.message });
      await ctx.reply('❌ Error verifying credentials: ' + err.message);
    }
    return;
  }

  if (s.state === 'awaiting_account_label') {
    s.pendingAccount = { ...(s.pendingAccount || {}), label: text.trim() };
    s.state = 'awaiting_api_key';
    return ctx.reply('🔑 Paste your Binance <b>API Key</b>:', { parse_mode: 'HTML' });
  }

  await ctx.reply('Use /start to open the Dashboard.');
});

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
bot.action('dashboard', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  scheduler.heartbeat();
  const user = db.users.findById(ctx.from.id);
  if (!user) return ctx.reply('Use /start first.');
  await dashboard.showDashboard(ctx, user, true);
});

// ─── BALANCE ─────────────────────────────────────────────────────────────────
bot.action('balance', (ctx) => dashboard.handleBalance(ctx));

// ─── ACTIVE TRADES ────────────────────────────────────────────────────────────
bot.action('active_trades', (ctx) => dashboard.handleActiveTrades(ctx));

// ─── TRADE MANAGEMENT ────────────────────────────────────────────────────────
bot.action(/^manage_trade_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await dashboard.showTradeManagement(ctx, ctx.match[1]);
});

// ─── CLOSE TRADE ─────────────────────────────────────────────────────────────
bot.action(/^close_trade_(.+)$/, async (ctx) => {
  await dashboard.handleCloseTradeAction(ctx, ctx.match[1]);
});

// ─── PARTIAL CLOSE ────────────────────────────────────────────────────────────
bot.action(/^partial_close_(.+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery('Closing...').catch(() => {});
  const user  = db.users.findById(ctx.from.id);
  if (!user) return;
  const trade = db.trades.findById(ctx.match[1]);
  if (!trade || trade.status !== 'open') return ctx.answerCbQuery('Trade not found.', { show_alert: true });
  const pct = parseInt(ctx.match[2]);
  const { partialClose } = require('./trading');
  const result = await partialClose(user, trade, pct);
  if (!result.success) return ctx.reply('❌ ' + result.error);
  await ctx.reply(
    `✅ Closed <b>${pct}%</b> of ${trade.symbol}\n` +
    `PNL: <b>${result.profit >= 0 ? '+' : ''}${result.profit.toFixed(4)} USDT</b>\n` +
    `Remaining qty: ${result.newQty}`,
    { parse_mode: 'HTML' }
  );
  await dashboard.handleActiveTrades(ctx);
});

// ─── TRADE HISTORY ────────────────────────────────────────────────────────────
bot.action('trade_history', (ctx) => dashboard.handleTradeHistory(ctx));

// ─── STATISTICS ───────────────────────────────────────────────────────────────
bot.action('statistics', (ctx) => dashboard.handleStatistics(ctx));

// ─── AUTO TRADING ─────────────────────────────────────────────────────────────
bot.action('trading_on',  (ctx) => dashboard.handleAutoTradingOn(ctx));
bot.action('trading_off', (ctx) => dashboard.handleAutoTradingOff(ctx));

// ─── SETTINGS ────────────────────────────────────────────────────────────────
bot.action('user_settings', (ctx) => dashboard.handleUserSettings(ctx));

// ─── SWITCH ACCOUNT ───────────────────────────────────────────────────────────
bot.action('switch_account', (ctx) => dashboard.showSwitchAccount(ctx));

bot.action(/^set_account_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const user    = db.users.findById(ctx.from.id);
  if (!user) return;
  const accId   = ctx.match[1];
  const acc     = db.accounts.findById(accId);
  if (!acc || String(acc.user_id) !== String(user.telegram_id)) {
    return ctx.answerCbQuery('Account not found.', { show_alert: true });
  }
  const dec = db.accounts.getDecrypted(acc);
  db.users.update(user.telegram_id, {
    active_account_id: acc.id,
    market_type:       acc.market_type,
    testnet:           acc.testnet,
    api_key:           dec.api_key,
    api_secret:        dec.api_secret,
  });
  await ctx.answerCbQuery(`✅ Switched to ${acc.label}`, { show_alert: true });
  await dashboard.showSwitchAccount(ctx);
});

bot.action(/^del_account_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const user  = db.users.findById(ctx.from.id);
  if (!user) return;
  const accId = ctx.match[1];
  const acc   = db.accounts.findById(accId);
  if (!acc || String(acc.user_id) !== String(user.telegram_id)) return;

  db.accounts.remove(accId);
  if (user.active_account_id === accId) {
    const remaining = db.accounts.forUser(user.telegram_id);
    if (remaining.length) {
      const dec = db.accounts.getDecrypted(remaining[0]);
      db.users.update(user.telegram_id, {
        active_account_id: remaining[0].id,
        market_type:       remaining[0].market_type,
        testnet:           remaining[0].testnet,
        api_key:           dec.api_key,
        api_secret:        dec.api_secret,
      });
    } else {
      db.users.update(user.telegram_id, {
        active_account_id: null,
        api_key:           '',
        api_secret:        '',
      });
    }
  }
  await ctx.answerCbQuery('🗑 Account deleted', { show_alert: true });
  await dashboard.showSwitchAccount(ctx);
});

// ─── ADD ACCOUNT ──────────────────────────────────────────────────────────────
bot.action('add_account', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const s = getSession(ctx);

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('📊 Futures (USDT-M)',  'acct_type_futures'),
     Markup.button.callback('📈 Spot',              'acct_type_spot')],
    [Markup.button.callback('🔙 Cancel', 'user_settings')],
  ]);

  s.state = 'selecting_market_type';
  s.pendingAccount = {};

  try { await ctx.editMessageText('🔑 <b>Add New Account</b>\n\nSelect market type:', { parse_mode: 'HTML', ...kb }); }
  catch { await ctx.reply('Select market type:', kb); }
});

bot.action(/^acct_type_(futures|spot)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const s = getSession(ctx);
  const mkt = ctx.match[1];
  s.pendingAccount = { ...(s.pendingAccount || {}), market_type: mkt };

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('🌐 Real Account',  `acct_net_real`),
     Markup.button.callback('🧪 Testnet',       `acct_net_testnet`)],
    [Markup.button.callback('🔙 Cancel', 'user_settings')],
  ]);

  try { await ctx.editMessageText(`Market: <b>${mkt.toUpperCase()}</b>\n\nReal or testnet?`, { parse_mode: 'HTML', ...kb }); }
  catch { await ctx.reply('Real or testnet?', kb); }
});

bot.action(/^acct_net_(real|testnet)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const s = getSession(ctx);
  s.pendingAccount = { ...(s.pendingAccount || {}), testnet: ctx.match[1] === 'testnet' };
  s.state = 'awaiting_account_label';

  const mkt = s.pendingAccount.market_type || 'futures';
  const tn  = s.pendingAccount.testnet ? 'Testnet' : 'Real';

  try {
    await ctx.editMessageText(
      `📊 <b>${mkt.toUpperCase()} ${tn}</b>\n\n` +
      `Give this account a label (e.g. "Main Futures")\nor send /skip for default:`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('Skip', 'acct_label_skip')]]) }
    );
  } catch { await ctx.reply('Enter a label for this account or type /skip:'); }
});

bot.action('acct_label_skip', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const s = getSession(ctx);
  const mkt = s.pendingAccount?.market_type || 'futures';
  s.pendingAccount = { ...(s.pendingAccount || {}), label: `${mkt.toUpperCase()} Account` };
  s.state = 'awaiting_api_key';
  try { await ctx.editMessageText('🔑 Paste your Binance <b>API Key</b>:', { parse_mode: 'HTML' }); }
  catch { await ctx.reply('🔑 Paste your Binance API Key:'); }
});

// ─── SYNC BINANCE ─────────────────────────────────────────────────────────────
bot.action('sync_binance', async (ctx) => {
  await ctx.answerCbQuery('Syncing...').catch(() => {});
  const user = db.users.findById(ctx.from.id);
  if (!user) return;
  const { syncUserFromBinance } = require('./trading');
  await syncUserFromBinance(user);
  await ctx.answerCbQuery('✅ Synced!', { show_alert: true });
  await dashboard.handleUserSettings(ctx);
});

// ─── COPY ID ──────────────────────────────────────────────────────────────────
bot.action('copy_id', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const user = db.users.findById(ctx.from.id);
  if (!user) return;
  await ctx.reply(`Your Telegram ID:\n<code>${user.telegram_id}</code>`, { parse_mode: 'HTML' });
});

// ─── SUBSCRIPTION ─────────────────────────────────────────────────────────────
bot.action('subscription', showSubscription);

// ─── REFERRAL ────────────────────────────────────────────────────────────────
bot.action('referral', handleReferral);

// ─── HELP ─────────────────────────────────────────────────────────────────────
bot.action('help', showHelp);

// ─── MOVE SL / TP STUBS ──────────────────────────────────────────────────────
bot.action(/^move_sl_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply('📌 Send the new Stop Loss price:');
  const s = getSession(ctx); s.state = 'move_sl'; s.tradeId = ctx.match[1];
});
bot.action(/^move_tp_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply('📌 Send the new Take Profit price:');
  const s = getSession(ctx); s.state = 'move_tp'; s.tradeId = ctx.match[1];
});
bot.action(/^break_even_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const trade = db.trades.findById(ctx.match[1]);
  if (!trade) return ctx.answerCbQuery('Trade not found.', { show_alert: true });
  db.trades.update(trade.trade_id, { sl: trade.entry });
  await ctx.answerCbQuery('✅ SL moved to break-even entry', { show_alert: true });
});
bot.action(/^trailing_stop_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('⚠️ Trailing stop: monitor your trade manually for now.', { show_alert: true }).catch(() => {});
});

// ─── ADMIN ACTIONS ─────────────────────────────────────────────────────────────
bot.action('admin_panel',         async (ctx) => { await ctx.answerCbQuery().catch(() => {}); if (!admin.isAdmin(ctx)) return ctx.answerCbQuery('❌', { show_alert: true }); await admin.showAdminPanel(ctx, true); });
bot.action('admin_users',         (ctx) => admin.showAdminUsers(ctx));
bot.action('admin_trade_settings',(ctx) => admin.showTradingSettings(ctx));
bot.action('admin_channel',       (ctx) => admin.showChannelSettings(ctx));
bot.action('admin_logs',          (ctx) => admin.showAdminLogs(ctx));
bot.action('admin_grant_sub',     (ctx) => admin.handleGrantSub(ctx));
bot.action('admin_revoke_sub',    (ctx) => admin.handleRevokeSub(ctx));
bot.action('admin_all_trades',    (ctx) => admin.showAllTrades(ctx));
bot.action('admin_global_stats',  (ctx) => admin.showGlobalStats(ctx));

bot.action(/^admin_set_(.+)$/, async (ctx) => {
  await admin.handleSettingToggle(ctx, ctx.match[0]);
});
bot.action(/^admin_toggle_(.+)$/, async (ctx) => {
  await admin.handleSettingToggle(ctx, ctx.match[0]);
});

bot.action('admin_channel_enable',  async (ctx) => { await ctx.answerCbQuery().catch(() => {}); db.channel.set({ enabled: true }); await admin.showChannelSettings(ctx); });
bot.action('admin_channel_disable', async (ctx) => { await ctx.answerCbQuery().catch(() => {}); db.channel.set({ enabled: false }); await admin.showChannelSettings(ctx); });

// ─── CATCH-ALL ────────────────────────────────────────────────────────────────
bot.on('callback_query', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
});

// ─── ERROR HANDLER ────────────────────────────────────────────────────────────
bot.catch((err, ctx) => {
  const msg = err?.message || '';
  if (msg.includes('message is not modified')) return;
  if (msg.includes('query is too old'))        return;
  if (msg.includes('bot was blocked'))         return;
  logger.error('[BOT] Unhandled error', { err: msg, update: ctx?.update?.update_id });
});

module.exports = bot;
