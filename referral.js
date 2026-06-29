'use strict';
const { Markup } = require('telegraf');
const db         = require('./database');
const logger     = require('./logger');

// ─── GENERATE REFERRAL CODE ───────────────────────────────────────────────────
function generateCode(telegramId) {
  return `REF${String(telegramId).slice(-6)}`;
}

// ─── HANDLE /start WITH REFERRAL CODE ────────────────────────────────────────
async function processReferral(newUser, referralCode) {
  if (!referralCode || !newUser) return;
  try {
    const allUsers = db.users.getAll();
    const referrer = allUsers.find((u) => u.referral_code === referralCode);
    if (!referrer) return;
    if (String(referrer.telegram_id) === String(newUser.telegram_id)) return;

    const existing = db.referrals.findByReferred(newUser.telegram_id);
    if (existing) return;

    db.referrals.log({
      referrer_id:       referrer.telegram_id,
      referred_id:       newUser.telegram_id,
      referred_username: newUser.username || '',
      bonus_granted:     false,
      bonus_days:        0,
    });

    logger.info('[REFERRAL] Logged referral', {
      referrer: referrer.telegram_id,
      referred: newUser.telegram_id,
    });
  } catch (err) {
    logger.error('[REFERRAL] processReferral error', { err: err.message });
  }
}

// ─── GRANT REFERRAL BONUS ─────────────────────────────────────────────────────
async function grantReferralBonus(referrerId, bonusDays = 3) {
  try {
    const referrer = db.users.findById(referrerId);
    if (!referrer) return;

    const newEnd = referrer.subscription_end
      ? new Date(new Date(referrer.subscription_end).getTime() + bonusDays * 86400000).toISOString()
      : new Date(Date.now() + bonusDays * 86400000).toISOString();

    await db.users.update(referrerId, {
      subscription:     'active',
      subscription_end: newEnd,
    });

    const refs = db.referrals.forReferrer(referrerId);
    for (const r of refs) {
      if (!r.bonus_granted) {
        const updated = db.referrals._load().map((x) =>
          x.id === r.id ? { ...x, bonus_granted: true, bonus_days: bonusDays } : x
        );
        db.referrals._cache = updated;
        db.referrals._save();
        break;
      }
    }

    logger.info('[REFERRAL] Bonus granted', { referrer: referrerId, days: bonusDays });
  } catch (err) {
    logger.error('[REFERRAL] grantReferralBonus error', { err: err.message });
  }
}

// ─── SHOW REFERRAL PAGE ────────────────────────────────────────────────────────
async function handleReferral(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const user = db.users.findById(ctx.from.id);
  if (!user) return ctx.reply('Use /start first.');

  if (!user.referral_code) {
    const code = generateCode(user.telegram_id);
    await db.users.update(user.telegram_id, { referral_code: code });
    user.referral_code = code;
  }

  const referrals = db.referrals.forReferrer(user.telegram_id);
  const total     = referrals.length;
  const bonused   = referrals.filter((r) => r.bonus_granted).length;
  const pending   = total - bonused;
  const totalDays = referrals.reduce((s, r) => s + (r.bonus_days || 0), 0);

  const botUsername = ctx.botInfo?.username || 'YourBot';
  const link = `https://t.me/${botUsername}?start=${user.referral_code}`;

  const msg =
    `🎁 <b>Referral Program</b>\n\n` +
    `Share your link and earn <b>3 days FREE</b> subscription for each referred user!\n\n` +
    `🔗 Your Link:\n<code>${link}</code>\n\n` +
    `📊 <b>Your Stats</b>\n` +
    `  Total Referred: <b>${total}</b>\n` +
    `  Bonuses Earned: <b>${bonused}</b>  (${totalDays} days)\n` +
    `  Pending Review: <b>${pending}</b>\n\n` +
    `💡 <i>Bonus is credited after your referral subscribes.</i>`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Dashboard', 'dashboard')],
  ]);

  try { await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb }); }
  catch { await ctx.reply(msg, { parse_mode: 'HTML', ...kb }); }
}

module.exports = {
  generateCode,
  processReferral,
  grantReferralBonus,
  handleReferral,
};
