/**
 * JDK Signals: the order-flow reads of the JDK study as one row per signal, one mark per candle. Pure: candles in, marks out.
 *
 * The rules are written once, in the study's specification (SIGNALS_SPEC.md beside the study), and twice in code: here for the pane
 * and in the history test (jdk_signals.py). The two must give the same marks on the same candles (tests/jdk-signals.test.mts holds a
 * table the test exported). Change a rule in all three places, or in none.
 *
 * Everything a signal on candle i uses is known when candle i closes.
 */

/** One candle of the chart's timeframe with the flow summed over the venues the pane reads. */
export interface FlowCandle {
  /** The candle's start, ms. */
  t: number;
  o: number; h: number; l: number; c: number;
  /** Perpetual market buys and sells, USD. */
  pb: number; ps: number;
  /** Spot market buys and sells, USD (NaN where no spot market was read). */
  sb: number; ss: number;
  /** Open interest of the perpetuals at the candle's close, coins (NaN where unknown). */
  oi: number;
  /**
   * The change of open interest over the candle, coins, where the source works it out itself (the page sums each venue's own change, so a
   * venue that joins or drops out is not a jump). Absent: the change of `oi` from the previous candle.
   */
  doi?: number;
}

export interface SignalParams {
  /** Candles in the "typical" baselines (medians of the previous N, the candle itself not included). */
  N: number;
  /** "Heavy": at least K times typical. */
  K: number;
  /** Candles a trap may take to spring, and the window the setups look back over. */
  W: number;
  /** Candles before the trapping candle that its low (high) is compared with. */
  X: number;
  /** How close to that extreme, in basis points, still counts as "into the low (high)". */
  NEAR: number;
}

export const DEFAULT_SIGNAL_PARAMS: Readonly<SignalParams> = { N: 96, K: 2, W: 6, X: 12, NEAR: 10 };

export const SIGNAL_IDS = [
  'long_setup', 'sellers_absorbed', 'shorts_trapped', 'long_flush', 'spot_buying',
  'spot_selling', 'short_covering', 'longs_trapped', 'buyers_absorbed', 'short_setup',
] as const;
export type SignalId = (typeof SIGNAL_IDS)[number];

/** Which way a signal leans: +1 bullish, -1 bearish. */
export const SIGNAL_SIDE: Readonly<Record<SignalId, 1 | -1>> = {
  long_setup: 1, sellers_absorbed: 1, shorts_trapped: 1, long_flush: 1, spot_buying: 1,
  spot_selling: -1, short_covering: -1, longs_trapped: -1, buyers_absorbed: -1, short_setup: -1,
};

/** The numbers behind each candle's marks (for the popup): the candle's flow and the typical sizes it was judged against. */
export interface SignalReadings {
  perpDelta: Float64Array; spotDelta: Float64Array; oiChange: Float64Array; rangeBp: Float64Array;
  typPerp: Float64Array; typSpot: Float64Array; typOi: Float64Array; typRange: Float64Array;
  /** For a trap that sprang on candle i: the candle where the trapped side opened (its index), else -1. */
  trapFrom: Int32Array;
}

export interface SignalResult {
  marks: Record<SignalId, Uint8Array>;
  readings: SignalReadings;
}

/** The median of the finite values of `x` over [from, to); NaN unless all of them are finite (as pandas' rolling median with min_periods = N). */
function windowMedian(x: Float64Array, from: number, to: number, scratch: Float64Array): number {
  let n = 0;
  for (let k = from; k < to; k++) {
    const v = x[k]!;
    if (!Number.isFinite(v)) return NaN;
    scratch[n++] = v;
  }
  if (n === 0) return NaN;
  const s = scratch.subarray(0, n).sort();
  return n % 2 ? s[(n - 1) >> 1]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

/** Medians of the previous N values (candle i not included): NaN for the first N candles. */
function typical(x: Float64Array, N: number): Float64Array {
  const out = new Float64Array(x.length).fill(NaN), scratch = new Float64Array(N);
  for (let i = N; i < x.length; i++) out[i] = windowMedian(x, i - N, i, scratch);
  return out;
}

/** The lowest low (or highest high) of the X candles before each candle; NaN until there are X. */
function priorExtreme(x: Float64Array, X: number, low: boolean): Float64Array {
  const out = new Float64Array(x.length).fill(NaN);
  for (let i = X; i < x.length; i++) {
    let m = low ? Infinity : -Infinity;
    for (let k = i - X; k < i; k++) m = low ? Math.min(m, x[k]!) : Math.max(m, x[k]!);
    out[i] = m;
  }
  return out;
}

export function computeSignals(candles: readonly FlowCandle[], params: SignalParams = DEFAULT_SIGNAL_PARAMS): SignalResult {
  const { N, K, W, X, NEAR } = params, n = candles.length;
  const col = (f: (q: FlowCandle) => number): Float64Array => Float64Array.from(candles, f);
  const o = col(q => q.o), h = col(q => q.h), l = col(q => q.l), c = col(q => q.c);
  const pd = col(q => q.pb - q.ps), sd = col(q => q.sb - q.ss), oi = col(q => q.oi);
  const doi = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const own = candles[i]!.doi;
    doi[i] = own !== undefined ? own : i > 0 ? oi[i]! - oi[i - 1]! : NaN;
  }
  const rng = col(q => (q.h - q.l) / q.c * 1e4);
  const abs = (x: Float64Array): Float64Array => x.map(Math.abs);
  const D = typical(abs(pd), N), S = typical(abs(sd), N), O = typical(abs(doi), N), R = typical(rng, N);

  const marks = Object.fromEntries(SIGNAL_IDS.map(id => [id, new Uint8Array(n)])) as Record<SignalId, Uint8Array>;
  const newShorts = new Uint8Array(n), newLongs = new Uint8Array(n);
  // What each signal needs: the perpetual flow and the range always; open interest for the ones about positions; spot for the ones about
  // spot. Where a source is missing (no spot market switched on, no open interest read) only the signals that need it go quiet.
  const flowOk = new Uint8Array(n), oiOk = new Uint8Array(n), spotOk = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!(D[i]! > 0 && R[i]! > 0)) continue;
    flowOk[i] = 1; if (O[i]! > 0) oiOk[i] = 1; if (S[i]! > 0) spotOk[i] = 1;
    const p = pd[i]!, s = sd[i]!, d = doi[i]!;
    const heavySell = p <= -K * D[i]!, heavyBuy = p >= K * D[i]!;
    const quiet = rng[i]! <= 0.5 * R[i]!;
    if (heavySell && (c[i]! >= o[i]! || quiet)) marks.sellers_absorbed[i] = 1;
    if (heavyBuy && (c[i]! <= o[i]! || quiet)) marks.buyers_absorbed[i] = 1;
    if (oiOk[i]) {
      const oiUp = d >= K * O[i]!, oiDown = d <= -K * O[i]!;
      if (oiUp && p < 0) newShorts[i] = 1;
      if (oiUp && p > 0) newLongs[i] = 1;
      if (oiDown && p < 0 && c[i]! < o[i]!) marks.long_flush[i] = 1;
      if (spotOk[i] && oiDown && p > 0 && c[i]! > o[i]! && s < 0.5 * S[i]!) marks.short_covering[i] = 1;
    }
    if (spotOk[i]) {
      if (s >= K * S[i]! && s / S[i]! > p / D[i]!) marks.spot_buying[i] = 1;
      if (s <= -K * S[i]! && -s / S[i]! > -p / D[i]!) marks.spot_selling[i] = 1;
    }
  }

  // Traps: positions opened into a new extreme (or within NEAR of it), then the first close beyond the opening candle within W.
  const trapFrom = new Int32Array(n).fill(-1);
  const lowBefore = priorExtreme(l, X, true), highBefore = priorExtreme(h, X, false);
  for (let j = 0; j < n; j++) {
    if (newShorts[j] && l[j]! <= lowBefore[j]! * (1 + NEAR / 1e4)) {
      for (let i = j + 1; i <= Math.min(j + W, n - 1); i++) if (c[i]! > h[j]!) { marks.shorts_trapped[i] = 1; trapFrom[i] = j; break; }
    }
    if (newLongs[j] && h[j]! >= highBefore[j]! * (1 - NEAR / 1e4)) {
      for (let i = j + 1; i <= Math.min(j + W, n - 1); i++) if (c[i]! < l[j]!) { marks.longs_trapped[i] = 1; trapFrom[i] = j; break; }
    }
  }

  // Setups: the trap, absorption within the last W candles (this one included), and spot not leaning the other way over them.
  const within = (m: Uint8Array, i: number): boolean => { for (let k = Math.max(0, i - W); k <= i; k++) if (m[k]) return true; return false; };
  for (let i = 0; i < n; i++) {
    // A setup needs spot read on its candle: "spot not leaning the other way" cannot be said without it.
    if (marks.shorts_trapped[i] && spotOk[i] && within(marks.sellers_absorbed, i) && !within(marks.spot_selling, i)) marks.long_setup[i] = 1;
    if (marks.longs_trapped[i] && spotOk[i] && within(marks.buyers_absorbed, i) && !within(marks.spot_buying, i)) marks.short_setup[i] = 1;
  }

  return {
    marks,
    readings: { perpDelta: pd, spotDelta: sd, oiChange: doi, rangeBp: rng, typPerp: D, typSpot: S, typOi: O, typRange: R, trapFrom },
  };
}
