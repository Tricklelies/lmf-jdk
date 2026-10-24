import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS_REV, DEFAULT_SHOW, LAYOUT_KEYS, defaultShow, initialState, type AppState } from '../src/app/store.ts';
import { COLUMN_SHARE, MIN_FLOW_W, MIN_SIDE_W, defaultColumns } from '../src/app/layouts/layouts.ts';

const saved = (blob: Record<string, unknown> | null, run: () => void): void => {
  const real = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { innerWidth: 1600, localStorage: { getItem: () => blob ? JSON.stringify(blob) : null, setItem: () => {} } };
  try { run(); } finally { if (real === undefined) delete (globalThis as { window?: unknown }).window; else (globalThis as { window?: unknown }).window = real; }
};

/** The profile along the top as the saves before the places held it (traded/profiles.ts): its measure, and whether it is on. */
const topOf = (traded: AppState['traded']): { on: boolean; metric: string } => {
  const p = traded.placements.instances.find(x => x.placement === 'top');
  return { on: p?.enabled === true, metric: p?.metric ?? '' };
};

test('a first visit starts with no pane under the map, and the flow column and the book beside it', () => {
  for (const key of ['depth', 'oi', 'delta', 'ls', 'jdk', 'lt', 'footprint'] as const) assert.equal(DEFAULT_SHOW[key], false, key);
  assert.equal(defaultShow(1920).cvd, true);
  assert.equal(defaultShow(1920).book, true);
});

test('a save written under the old defaults (Depth and Open interest both on, no revision) has them off once; a choice is kept', () => {
  saved(null, () => assert.deepEqual([initialState().show.depth, initialState().show.oi], [false, false]));
  saved({ show: { ...DEFAULT_SHOW, depth: true, oi: true } }, () => {
    const s = initialState();
    assert.deepEqual([s.show.depth, s.show.oi, s.defaultsRev], [false, false, DEFAULTS_REV]);
  });
  // Only one of them on was a choice, and so is anything saved under the new revision.
  saved({ show: { ...DEFAULT_SHOW, depth: true, oi: false } }, () => assert.deepEqual([initialState().show.depth, initialState().show.oi], [true, false]));
  saved({ defaultsRev: DEFAULTS_REV, show: { ...DEFAULT_SHOW, depth: true, oi: true } }, () => assert.deepEqual([initialState().show.depth, initialState().show.oi], [true, true]));
});

test('a save from before revision 2 shows what was new: days on the chart with their profiles, and the strip, now the profile along the top', () => {
  // A save of the day before: the volume profile off, no period on the chart and no profile (the choice came that day), the strip off.
  const before = { defaultsRev: 1, show: { ...DEFAULT_SHOW, traded: false }, traded: { lines: [], profiles: null, metrics: ['volume', 'oi'] }, measureStrip: { on: false, kind: 'oi' } };
  saved(before, () => {
    const s = initialState();
    assert.deepEqual([s.traded.lines, s.traded.profiles, topOf(s.traded), s.show.traded, s.defaultsRev], [['day'], 'day', { on: true, metric: 'oi' }, true, DEFAULTS_REV]);
    assert.deepEqual(s.traded.placements.instances.filter(p => p.placement === 'right' && p.enabled).map(p => p.metric), ['volume', 'oi'], 'the columns chosen stay, right of the map');
  });
  // Periods chosen before are kept as they were.
  saved({ ...before, traded: { lines: ['week'], profiles: null } }, () => assert.deepEqual([initialState().traded.lines, initialState().traded.profiles], [['week'], null]));
  // A first visit: the profile along the top on (a desktop), and with it the Volume profile and its days.
  saved(null, () => { const s = initialState(); assert.deepEqual([topOf(s.traded), s.show.traded, s.traded.lines, s.traded.profiles], [{ on: true, metric: 'volume' }, true, ['day'], 'day']); });
});

test('revision 3: a save of revision 2 carries its measure strip into the profile along the top, and the Volume profile where it showed', () => {
  const rev2 = { defaultsRev: 2, show: { ...DEFAULT_SHOW, traded: false }, traded: { lines: [], profiles: null, bars: 'delta' }, measureStrip: { on: true, kind: 'delta' } };
  saved(rev2, () => {
    const s = initialState();
    assert.deepEqual([topOf(s.traded), s.show.traded, s.traded.bars, s.traded.lines, s.defaultsRev], [{ on: true, metric: 'volume' }, true, 'delta', [], DEFAULTS_REV]);
    assert.ok(!('measureStrip' in s), 'the strip is not kept');
  });
  // A strip switched off stays off, and the Volume profile as it was; a save of revision 3 is read as it is.
  saved({ ...rev2, measureStrip: { on: false, kind: 'oi' } }, () => { const s = initialState(); assert.deepEqual([topOf(s.traded), s.show.traded], [{ on: false, metric: 'oi' }, false]); });
  saved({ ...rev2, defaultsRev: DEFAULTS_REV, measureStrip: undefined, traded: { top: { on: false, metric: 'absorption' } } }, () => { const s = initialState(); assert.deepEqual([topOf(s.traded), s.show.traded], [{ on: false, metric: 'absorption' }, false]); });
  // A save holding a strip that showed and no Volume profile settings at all keeps the profile along the top: the old "no settings, so
  // off" rule does not switch off what the strip carried in.
  saved({ defaultsRev: 2, show: { ...DEFAULT_SHOW, traded: false }, measureStrip: { on: true, kind: 'oi' } }, () => { const s = initialState(); assert.deepEqual([topOf(s.traded), s.show.traded], [{ on: true, metric: 'oi' }, true]); });
  saved({ defaultsRev: 2, show: { ...DEFAULT_SHOW, traded: true }, measureStrip: { on: false, kind: 'oi' } }, () => assert.equal(initialState().show.traded, false, 'with the strip off, the old rule stands'));
  assert.equal(DEFAULTS_REV, 3);
});

test('the columns begin at the golden section of the window, as wide as before at the least', () => {
  assert.ok(Math.abs(1 - 2 * COLUMN_SHARE - 0.618) < 0.001, 'the map keeps 61.8 %');
  assert.deepEqual(defaultColumns(1366), { flowW: MIN_FLOW_W, sideW: MIN_SIDE_W });
  assert.deepEqual(defaultColumns(1920), { flowW: 367, sideW: MIN_SIDE_W });
  assert.deepEqual(defaultColumns(2560), { flowW: 489, sideW: 489 });
  assert.deepEqual(defaultColumns(3840), { flowW: 733, sideW: 733 });
  assert.deepEqual(defaultColumns(0), { flowW: MIN_FLOW_W, sideW: MIN_SIDE_W });
});

test('the stylesheet sets the columns the same way before the page has run', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'styles.css'), 'utf8');
  const vw = `${(COLUMN_SHARE * 100).toFixed(1)}vw`;
  assert.ok(css.includes(`--side-w: max(${MIN_SIDE_W}px, ${vw})`), 'the book');
  assert.ok(css.includes(`--flow-w: max(${MIN_FLOW_W}px, ${vw})`), 'the flow column');
});

test('the top bar starts unfolded; a fold is kept in this browser, never in a layout, and anything but true reads as unfolded', () => {
  // Karl, 2026-10-24: collapse the header bar to give an iPad's short screen to the chart, as a browser's full screen does.
  saved(null, () => assert.equal(initialState().barCollapsed, false));
  saved({ barCollapsed: true }, () => assert.equal(initialState().barCollapsed, true));
  saved({ barCollapsed: 'yes' }, () => assert.equal(initialState().barCollapsed, false));
  assert.equal((LAYOUT_KEYS as readonly string[]).includes('barCollapsed'), false);
});
