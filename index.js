console.log(require.resolve("dotenv"));
require("dotenv").config();
'use strict';
require('dotenv').config();
const logger    = require('./logger');
const bot       = require('./bot');
const scheduler = require('./scheduler');
const channel   = require('./channel');
const { config } = require('./config');

logger.info('=================================================');
logger.info('  AI Crypto Trading Bot PRO v3.0 — Starting');
logger.info('=================================================');

if (!config.bot.token) {
  logger.error('FATAL: BOT_TOKEN not set in environment. Exiting.');
  process.exit(1);
}

// Wire up cross-module references
scheduler.setBot(bot);
channel.setBot(bot);

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
let shuttingDown = false;

async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[MAIN] Received ${sig} — shutting down gracefully`);
  try { scheduler.stop(); } catch {}
  try { bot.stop(sig); } catch {}
  process.exit(0);
}

process.once('SIGINT',  () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException',  (err) => logger.error('[MAIN] uncaughtException',  { err: err.message, stack: err.stack?.slice(0, 500) }));
process.on('unhandledRejection', (err) => logger.error('[MAIN] unhandledRejection', { err: String(err) }));

// ─── START ────────────────────────────────────────────────────────────────────
(async () => {
  try {
    scheduler.start();
    logger.info('[MAIN] Schedulers started');

    await bot.launch({
      dropPendingUpdates: true,
      allowedUpdates: ['message', 'callback_query'],
    });

    const me = await bot.telegram.getMe();
    logger.info(`[MAIN] Bot launched: @${me.username} (id=${me.id})`);
    logger.info(`[MAIN] Admin chat ID: ${config.bot.adminChatId || '(not set)'}`);

    try {
      await bot.telegram.sendMessage(
        config.bot.adminChatId,
        '✅ <b>Bot Started</b>\n\nAI Crypto Trading Bot PRO v3.0 is live.\n\n🤖 24/7 auto trading enabled\n🎯 95%+ confidence signals\n🔑 Multi-account support',
        { parse_mode: 'HTML' }
      );
    } catch {}

  } catch (err) {
    logger.error('[MAIN] Failed to start bot', { err: err.message });
    process.exit(1);
  }
})();
