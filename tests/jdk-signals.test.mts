import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { computeSignals, DEFAULT_SIGNAL_PARAMS, SIGNAL_IDS, type FlowCandle, type SignalId } from '../src/app/jdk/signals.ts';

const root = path.resolve(import.meta.dirname, '..', '..', '..');

/** The history test's own table for BTCUSDT 5m on 2026-10-22 (Binance perp and spot candles, Binance OI) with its marks. */
function fixture(): { candles: FlowCandle[]; marks: Record<SignalId, number[]>; warm: number } {
  const text = fs.readFileSync(path.join(root, 'tests', 'fixtures', 'jdk-signals-btcusdt-5m-2026-10-22.csv'), 'utf8').trim().split(/\r?\n/);
  const head = text[0]!.split(',');
  const at = (name: string): number => head.indexOf(name);
  const rows = text.slice(1).map(line => line.split(','));
  const num = (r: string[], name: string): number => { const v = r[at(name)]; return v === undefined || v === '' ? NaN : Number(v); };
  const candles = rows.map(r => ({
    t: Date.parse(r[0]!.replace(' ', 'T') + 'Z'),
    o: num(r, 'o'), h: num(r, 'h'), l: num(r, 'l'), c: num(r, 'c'),
    pb: num(r, 'pb'), ps: num(r, 'ps'), sb: num(r, 'sb'), ss: num(r, 'ss'), oi: num(r, 'oi'),
  }));
  const marks = Object.fromEntries(SIGNAL_IDS.map(id => [id, rows.map(r => num(r, id))])) as Record<SignalId, number[]>;
  const { N, X, W } = DEFAULT_SIGNAL_PARAMS;
  return { candles, marks, warm: N + X + W + 10 };
}

test('the pane marks the same candles as the history test (Oct 22, BTC 5m)', () => {
  const { candles, marks, warm } = fixture();
  const got = computeSignals(candles).marks;
  for (const id of SIGNAL_IDS) {
    const want = marks[id].slice(warm), have = Array.from(got[id].slice(warm));
    assert.deepEqual(have, want, `${id}: candles ${want.map((v, k) => v !== have[k] ? k + warm : -1).filter(k => k >= 0).join(', ')} differ`);
  }
  // The day must have something to compare: a table with no marks would pass any rule.
  const total = SIGNAL_IDS.reduce((s, id) => s + marks[id].slice(warm).reduce((a, b) => a + b, 0), 0);
  assert.ok(total > 20, `only ${total} marks in the fixture`);
});

test('nothing is marked before there is enough history for the baselines', () => {
  const { candles } = fixture();
  const got = computeSignals(candles.slice(0, DEFAULT_SIGNAL_PARAMS.N)).marks;
  for (const id of SIGNAL_IDS) assert.equal(got[id].reduce((a, b) => a + b, 0), 0, id);
});

test('a trap springs once, on the first close beyond the candle that opened it', () => {
  // 100 quiet candles, then new shorts into a fresh low (selling, OI jumps), then two closes above that candle's high.
  const base = Array.from({ length: 100 }, (_, i): FlowCandle => ({
    t: i * 300_000, o: 100, h: 100.2, l: 99.8, c: 100, pb: 1000 + (i % 7) * 10, ps: 1000 + (i % 5) * 10,
    sb: 100 + (i % 3) * 5, ss: 100 + (i % 4) * 5, oi: 5000 + (i % 2) * 3,
  }));
  const open: FlowCandle = { t: 100 * 300_000, o: 99.9, h: 100.0, l: 99.0, c: 99.2, pb: 500, ps: 5000, sb: 100, ss: 110, oi: 5050 };
  const up1: FlowCandle = { t: 101 * 300_000, o: 99.3, h: 100.4, l: 99.2, c: 100.3, pb: 3000, ps: 1000, sb: 120, ss: 100, oi: 5040 };
  const up2: FlowCandle = { t: 102 * 300_000, o: 100.3, h: 100.6, l: 100.2, c: 100.5, pb: 1200, ps: 1000, sb: 110, ss: 100, oi: 5041 };
  const m = computeSignals([...base, open, up1, up2]).marks;
  assert.equal(m.shorts_trapped[101], 1, 'springs on the first close above the opening candle\'s high');
  assert.equal(m.shorts_trapped[102], 0, 'and only once');
});
