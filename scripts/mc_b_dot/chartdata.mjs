// Pure helpers for the multi-window collector. No CDP here, so these run under node --test.
// Times are unix seconds unless a name says Ms.

const BAR_SECONDS = 60;

function requirePositive(name, v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new Error(`symbol info ${name} must be a finite number above 0, got ${v}`);
  }
  return v;
}

function requireFinite(name, v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${name} must be a finite number, got ${v}`);
  }
  return v;
}

// Contract spec from TradingView's symbolInfo. tick is minmov / pricescale, rounded to
// 10 decimals so that 1/10 is exactly 0.1.
export function specFromSymbolInfo({ minmov, pricescale, pointvalue } = {}) {
  requirePositive('minmov', minmov);
  requirePositive('pricescale', pricescale);
  requirePositive('pointvalue', pointvalue);
  const tick = Math.round((minmov / pricescale) * 1e10) / 1e10;
  if (!(tick > 0)) {
    throw new Error(`symbol info tick rounds to ${tick}; minmov ${minmov} and pricescale ${pricescale} are not usable`);
  }
  return { tick, pointValue: pointvalue };
}

// Replay start for the next, older window, in unix milliseconds. The new window ends
// overlapBars bars after the old one starts, so the warm-up of the two windows overlaps.
export function nextReplayPoint(firstBarT, overlapBars) {
  requireFinite('firstBarT', firstBarT);
  requireFinite('overlapBars', overlapBars);
  if (overlapBars < 0) throw new Error(`overlapBars must be a finite number of 0 or more, got ${overlapBars}`);
  return (firstBarT + overlapBars * BAR_SECONDS) * 1000;
}

// The same replay point counted in bars instead of clock minutes: the time of bar overlapBars of
// the current window, so the next window shares overlapBars bars with it even across a weekend or
// a daily close. bars are [t, o, h, l, c, v] rows, oldest first. An overlap that covers the whole
// window starts one bar past its last bar.
export function replayPointFromBars(bars, overlapBars) {
  if (!Array.isArray(bars) || bars.length === 0) throw new Error('replayPointFromBars got no bars');
  if (!Number.isInteger(overlapBars) || overlapBars < 0) {
    throw new Error(`overlapBars must be a whole number of 0 or more, got ${overlapBars}`);
  }
  if (overlapBars >= bars.length) return (requireFinite('last bar time', bars[bars.length - 1][0]) + BAR_SECONDS) * 1000;
  return requireFinite(`bar ${overlapBars} time`, bars[overlapBars][0]) * 1000;
}

// Compact UTC stamp, YYYYMMDDTHHMM, from unix seconds.
function utcStamp(t) {
  const iso = new Date(t * 1000).toISOString(); // 2026-10-11T22:00:00.000Z
  return iso.slice(0, 16).replace(/[-:]/g, '');
}

// Filesystem-safe window name: symbol with non-alphanumerics as "_", then first and last bar dates.
export function windowName(symbol, firstBarT, lastBarT) {
  requireFinite('firstBarT', firstBarT);
  requireFinite('lastBarT', lastBarT);
  const safe = String(symbol).replace(/[^A-Za-z0-9]/g, '_');
  return `${safe}_${utcStamp(firstBarT)}_${utcStamp(lastBarT)}`;
}

// Stop when there is no data, when older data did not come back, or when the window budget is spent.
export function shouldStop({ prevFirstT, firstT, windows, maxWindows }) {
  if (firstT == null) return true;
  if (prevFirstT != null && firstT >= prevFirstT) return true;
  if (windows >= maxWindows) return true;
  return false;
}
