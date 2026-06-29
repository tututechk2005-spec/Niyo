'use strict';
const logger = require('./logger');
const {
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
} = require('./config');

// ─── EMA ─────────────────────────────────────────────────────────────────────
function ema(values, period) {
  if (!values || values.length < period) return [];
  const k   = 2 / (period + 1);
  const res = [values.slice(0, period).reduce((a, b) => a + b, 0) / period];
  for (let i = period; i < values.length; i++) {
    res.push(values[i] * k + res[res.length - 1] * (1 - k));
  }
  return res;
}

// ─── RSI ─────────────────────────────────────────────────────────────────────
function rsi(closes, period = RSI_PERIOD) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// ─── ATR ─────────────────────────────────────────────────────────────────────
function atr(candles, period = ATR_PERIOD) {
  if (!candles || candles.length < period + 1) return null;
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i];
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
  if (trs.length < period) return null;
  let val = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    val = (val * (period - 1) + trs[i]) / period;
  }
  return val;
}

// ─── MACD ─────────────────────────────────────────────────────────────────────
function macd(closes, fast = MACD_FAST, slow = MACD_SLOW, signal = MACD_SIGNAL) {
  if (closes.length < slow + signal) return null;
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const offset  = fastEma.length - slowEma.length;
  const macdLine = slowEma.map((v, i) => fastEma[i + offset] - v);
  const sigLine  = ema(macdLine, signal);
  const hOffset  = macdLine.length - sigLine.length;
  const histogram = sigLine.map((v, i) => macdLine[i + hOffset] - v);
  return {
    macd:         macdLine.at(-1),
    signal:       sigLine.at(-1),
    histogram:    histogram.at(-1),
    prevHistogram:histogram.at(-2),
  };
}

// ─── ADX (simplified Wilder's) ───────────────────────────────────────────────
function adx(candles, period = ADX_PERIOD) {
  if (candles.length < period * 2 + 1) return null;
  const slice = candles.slice(-(period * 2 + 2));
  const trs = [], dmp = [], dmm = [];
  for (let i = 1; i < slice.length; i++) {
    const cur = slice[i], prev = slice[i - 1];
    const tr  = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    const up  = cur.high - prev.high;
    const dn  = prev.low  - cur.low;
    trs.push(tr);
    dmp.push(up > dn && up > 0 ? up : 0);
    dmm.push(dn > up && dn > 0 ? dn : 0);
  }

  function wilderSmooth(arr) {
    let v = arr.slice(0, period).reduce((a, b) => a + b, 0);
    const res = [v];
    for (let i = period; i < arr.length; i++) {
      v = v - v / period + arr[i];
      res.push(v);
    }
    return res;
  }

  const sTR  = wilderSmooth(trs);
  const sDMP = wilderSmooth(dmp);
  const sDMM = wilderSmooth(dmm);

  const diPlus  = sTR.map((tr, i) => tr > 0 ? 100 * sDMP[i] / tr : 0);
  const diMinus = sTR.map((tr, i) => tr > 0 ? 100 * sDMM[i] / tr : 0);

  const dxArr = diPlus.map((p, i) => {
    const sum = p + diMinus[i];
    return sum > 0 ? 100 * Math.abs(p - diMinus[i]) / sum : 0;
  });

  const adxVal = dxArr.slice(-period).reduce((a, b) => a + b, 0) / period;
  return { adx: adxVal, diPlus: diPlus.at(-1), diMinus: diMinus.at(-1) };
}

// ─── CANDLE HELPERS ───────────────────────────────────────────────────────────
function parseCandles(rawKlines) {
  return rawKlines.map((k) => ({
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
    time:   k[0],
  }));
}

function closes(candles) { return candles.map((c) => c.close); }

// ─── TREND (EMA20 vs EMA50) ───────────────────────────────────────────────────
function trendDirection(candles) {
  const cls   = closes(candles);
  const fast  = ema(cls, EMA_FAST);
  const slow  = ema(cls, EMA_SLOW);
  if (!fast.length || !slow.length) return 'neutral';
  const curFast = fast.at(-1), curSlow = slow.at(-1);
  const prevFast = fast.at(-3) || curFast;
  const lastClose = cls.at(-1);
  if (curFast > curSlow && lastClose > curFast && prevFast > slow.at(-3)) return 'bull';
  if (curFast < curSlow && lastClose < curFast && prevFast < slow.at(-3)) return 'bear';
  return 'neutral';
}

// ─── BOS / CHoCH (Break-of-Structure / Change-of-Character) ──────────────────
function detectBOS(candles, direction) {
  if (candles.length < 10) return false;
  const slice = candles.slice(-30);
  if (direction === 'bull') {
    let swingHigh = -Infinity;
    for (let i = 0; i < slice.length - 3; i++) {
      if (slice[i].high > slice[i - 1]?.high && slice[i].high > slice[i + 1]?.high) {
        swingHigh = Math.max(swingHigh, slice[i].high);
      }
    }
    return swingHigh > -Infinity && slice.at(-1).close > swingHigh;
  }
  if (direction === 'bear') {
    let swingLow = Infinity;
    for (let i = 0; i < slice.length - 3; i++) {
      if (slice[i].low < slice[i - 1]?.low && slice[i].low < slice[i + 1]?.low) {
        swingLow = Math.min(swingLow, slice[i].low);
      }
    }
    return swingLow < Infinity && slice.at(-1).close < swingLow;
  }
  return false;
}

function detectCHOCH(candles, direction) {
  if (candles.length < 15) return false;
  const slice = candles.slice(-20);
  const cls   = closes(slice);
  const fast  = ema(cls, 8);
  const slow  = ema(cls, 21);
  if (fast.length < 2 || slow.length < 2) return false;
  if (direction === 'bull') return fast.at(-1) > slow.at(-1) && fast.at(-2) <= slow.at(-2);
  if (direction === 'bear') return fast.at(-1) < slow.at(-1) && fast.at(-2) >= slow.at(-2);
  return false;
}

// ─── ORDER BLOCK ──────────────────────────────────────────────────────────────
function detectOrderBlock(candles, direction) {
  if (candles.length < 10) return { found: false };
  const slice = candles.slice(-15);
  const cur   = slice.at(-1);
  const obRange = 0.005;
  if (direction === 'bull') {
    for (let i = slice.length - 4; i >= 0; i--) {
      const c = slice[i];
      if (c.open > c.close) {
        const mid = (c.high + c.low) / 2;
        if (Math.abs(cur.low - mid) / mid < obRange) return { found: true, price: mid };
      }
    }
  }
  if (direction === 'bear') {
    for (let i = slice.length - 4; i >= 0; i--) {
      const c = slice[i];
      if (c.close > c.open) {
        const mid = (c.high + c.low) / 2;
        if (Math.abs(cur.high - mid) / mid < obRange) return { found: true, price: mid };
      }
    }
  }
  return { found: false };
}

// ─── FAIR VALUE GAP ───────────────────────────────────────────────────────────
function detectFVG(candles, direction) {
  if (candles.length < 5) return false;
  const slice = candles.slice(-10);
  for (let i = 2; i < slice.length; i++) {
    const prev2 = slice[i - 2], prev1 = slice[i - 1], cur = slice[i];
    if (direction === 'bull' && prev2.high < cur.low && prev1.close > prev1.open) return true;
    if (direction === 'bear' && prev2.low  > cur.high && prev1.close < prev1.open) return true;
  }
  return false;
}

// ─── LIQUIDITY SWEEP ──────────────────────────────────────────────────────────
function detectLiqSweep(candles, direction) {
  if (candles.length < 10) return false;
  const slice = candles.slice(-15);
  const last  = slice.at(-1);
  const highs = slice.slice(0, -1).map((c) => c.high);
  const lows  = slice.slice(0, -1).map((c) => c.low);
  if (direction === 'bull') {
    const prevLow = Math.min(...lows);
    return last.low < prevLow && last.close > prevLow;
  }
  if (direction === 'bear') {
    const prevHigh = Math.max(...highs);
    return last.high > prevHigh && last.close < prevHigh;
  }
  return false;
}

// ─── VOLUME SPIKE ─────────────────────────────────────────────────────────────
function detectVolumeSpike(candles, multiplier = 1.4) {
  if (candles.length < 10) return false;
  const vols   = candles.slice(-15, -1).map((c) => c.volume);
  const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length;
  return candles.at(-1).volume > avgVol * multiplier;
}

// ─── RSI CONFIRMATION ─────────────────────────────────────────────────────────
function rsiConfirms(rsiVal, direction) {
  if (rsiVal === null) return false;
  if (direction === 'bull') return rsiVal > 40 && rsiVal < RSI_OB;
  if (direction === 'bear') return rsiVal < 60 && rsiVal > RSI_OS;
  return false;
}

// ─── MACD CONFIRMATION ───────────────────────────────────────────────────────
function macdConfirms(macdData, direction) {
  if (!macdData) return false;
  if (direction === 'bull') {
    return macdData.macd > macdData.signal || (macdData.histogram > 0 && macdData.histogram > macdData.prevHistogram);
  }
  if (direction === 'bear') {
    return macdData.macd < macdData.signal || (macdData.histogram < 0 && macdData.histogram < macdData.prevHistogram);
  }
  return false;
}

// ─── FAKE BREAKOUT FILTER ──────────────────────────────────────────────────────
function isFakeBreakout(candles, direction) {
  if (candles.length < 5) return false;
  const last = candles.at(-1);
  const prev = candles.at(-2);
  const bodyPct = Math.abs(last.close - last.open) / (last.high - last.low + 1e-8);
  if (bodyPct < 0.25) return true;
  if (direction === 'bull' && last.close < prev.high * 0.998) return true;
  if (direction === 'bear' && last.close > prev.low  * 1.002) return true;
  return false;
}

// ─── SL / TP CALCULATION ──────────────────────────────────────────────────────
function calcTargets(candles, direction, atrValue, price) {
  const atrM  = atrValue || price * 0.005;
  const slDist = atrM * 1.5;
  const tpDist = slDist * 2.2;
  const sl = direction === 'bull' ? price - slDist : price + slDist;
  const tp = direction === 'bull' ? price + tpDist : price - tpDist;
  return { sl, tp };
}

// ─── SCORE CALCULATOR ─────────────────────────────────────────────────────────
function calcScore(confirmations) {
  let score = 0;
  for (const [key, weight] of Object.entries(SIGNAL_WEIGHTS)) {
    if (confirmations[key]) score += weight;
  }
  return Math.min(100, Math.round(score));
}

// ─── GRADE ────────────────────────────────────────────────────────────────────
function gradeSignal(score) {
  if (score >= 97) return 'PREMIUM';
  if (score >= 95) return 'STRONG';
  return 'NORMAL';
}

// ─── FULL ANALYSIS ────────────────────────────────────────────────────────────
/**
 * Analyze a symbol with multi-timeframe data (15m, 1H, 4H).
 * Returns signal or null if no high-confidence setup exists.
 */
async function analyzeSymbol(symbol, client, dbSettings = null) {
  try {
    const [raw4h, raw1h, raw15m] = await Promise.all([
      client.getKlines(symbol, '4h', 200),
      client.getKlines(symbol, '1h', 200),
      client.getKlines(symbol, '15m', 150),
    ]);

    if (!raw4h || raw4h.length < 60) return null;
    if (!raw1h || raw1h.length < 60) return null;
    if (!raw15m || raw15m.length < 50) return null;

    const c4h  = parseCandles(raw4h);
    const c1h  = parseCandles(raw1h);
    const c15m = parseCandles(raw15m);

    const trend4h  = trendDirection(c4h);
    const trend1h  = trendDirection(c1h);
    const trend15m = trendDirection(c15m);

    if (trend4h === 'neutral' || trend1h === 'neutral') return null;
    if (trend4h !== trend1h)                            return null;

    const direction = trend4h;

    if (trend15m !== direction && trend15m !== 'neutral') return null;

    const cls15m  = closes(c15m);
    const rsiVal  = rsi(cls15m);
    const macdVal = macd(cls15m);
    const atrVal  = atr(c15m);
    const adxVal  = adx(c15m);

    const price   = c15m.at(-1).close;

    if (!price || price <= 0) return null;

    if (atrVal && price > 0) {
      const minATR = price * ATR_THRESHOLD;
      if (dbSettings?.atr_filter !== false && atrVal < minATR) return null;
    }

    const minADX = dbSettings?.adx_min ?? ADX_MIN;
    if (dbSettings?.adx_filter !== false && adxVal && adxVal.adx < minADX) return null;

    if (isFakeBreakout(c15m, direction)) return null;

    const hasBOS     = detectBOS(c15m, direction);
    const hasCHOCH   = detectCHOCH(c15m, direction);
    const obResult   = detectOrderBlock(c15m, direction);
    const hasFVG     = detectFVG(c15m, direction);
    const hasLiq     = detectLiqSweep(c15m, direction);
    const hasVol     = detectVolumeSpike(c15m);
    const rsiOk      = rsiConfirms(rsiVal, direction);
    const macdOk     = macdConfirms(macdVal, direction);
    const atrOk      = !!atrVal && atrVal > (price * ATR_THRESHOLD);

    const confirmations = {
      trend_4h:    trend4h  === direction,
      trend_1h:    trend1h  === direction,
      trend_15m:   trend15m === direction,
      bos:         hasBOS,
      choch:       hasCHOCH,
      order_block: obResult.found,
      fvg:         hasFVG,
      liq_sweep:   hasLiq,
      volume_spike: hasVol,
      rsi:         rsiOk,
      macd:        macdOk,
      atr_ok:      atrOk,
    };

    const score = calcScore(confirmations);
    const minScore = dbSettings?.min_signal_score ?? SCORE_MIN_DISPLAY;
    if (score < minScore) return null;

    const { sl, tp } = calcTargets(c15m, direction, atrVal, price);
    const slDist = Math.abs(price - sl);
    const tpDist = Math.abs(tp - price);
    const rr     = slDist > 0 ? parseFloat((tpDist / slDist).toFixed(2)) : 0;

    const minRR = parseFloat(dbSettings?.min_rr ?? MIN_RR);
    if (rr < minRR) return null;

    const canTrade = (
      score >= (dbSettings?.min_signal_score ?? SCORE_MIN_TRADE) &&
      confirmations.trend_4h &&
      confirmations.trend_1h &&
      hasBOS &&
      hasVol &&
      rr >= minRR
    );

    return {
      symbol,
      signal:        direction === 'bull' ? 'BUY' : 'SELL',
      direction,
      score,
      grade:         gradeSignal(score),
      entry:         parseFloat(price.toFixed(8)),
      sl:            parseFloat(sl.toFixed(8)),
      tp:            parseFloat(tp.toFixed(8)),
      tp1:           parseFloat(tp.toFixed(8)),
      rr,
      confirmations,
      canTrade,
      atr:           atrVal ? parseFloat(atrVal.toFixed(8)) : null,
      adx:           adxVal ? parseFloat(adxVal.adx.toFixed(2)) : null,
      rsiValue:      rsiVal ? parseFloat(rsiVal.toFixed(2)) : null,
      timestamp:     Date.now(),
    };
  } catch (err) {
    logger.debug(`[STRATEGY] ${symbol} analysis error`, { err: err.message });
    return null;
  }
}

/**
 * Scan multiple symbols and return sorted signals.
 * Only returns canTrade=true signals if tradeMode=true.
 */
async function scanSymbols(symbols, client, { tradeMode = false, dbSettings = null } = {}) {
  const CONCURRENCY = 8;
  const results = [];

  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const batch  = symbols.slice(i, i + CONCURRENCY);
    const batchR = await Promise.allSettled(batch.map((sym) => analyzeSymbol(sym, client, dbSettings)));
    for (const r of batchR) {
      if (r.status === 'fulfilled' && r.value) {
        if (!tradeMode || r.value.canTrade) results.push(r.value);
      }
    }
    if (i + CONCURRENCY < symbols.length) await new Promise((res) => setTimeout(res, 200));
  }

  return results.sort((a, b) => b.score - a.score);
}

module.exports = {
  analyzeSymbol,
  scanSymbols,
  ema,
  rsi,
  atr,
  macd,
  adx,
  trendDirection,
  calcScore,
  gradeSignal,
};
