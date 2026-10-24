import { TIMEFRAMES, type Hub } from '../hub.ts';
import type { Store, AppState, OiBar } from '../store.ts';
import type { View } from '../view.ts';
import { helpButton } from '../help.ts';
import { setTip } from '../tip.ts';
import { t } from '../i18n.ts';
import { clock, usd } from '../format.ts';
import { el } from '../dom.ts';
import { HoverCard } from '../hovercard.ts';
import type { InfoLine } from '../infobox.ts';
import { flowIds, flowLoadIds } from '../cvd/ids.ts';
import { aggregateFamilies } from '../cvd/model.ts';
import { kindOf } from '../scope.ts';
import { TimePane, setHtml } from './lower-panes.ts';
import { FlowCache, type CandleFlow } from '../delta/candles.ts';
import { deltaFlows, ensureDeltaFlow } from '../delta/flows.ts';
import { oiChangeByTime, oiPartsUntil, type OiPart } from '../oi-change.ts';
import { pageNow, replaying } from '../replay/clock.ts';
import { computeSignals, DEFAULT_SIGNAL_PARAMS, SIGNAL_IDS, SIGNAL_SIDE, type FlowCandle, type SignalId, type SignalResult } from '../jdk/signals.ts';

/** The rows' names, top to bottom: the bullish reads, then the bearish ones, each side's setup on its outer edge. */
const NAMES: Readonly<Record<SignalId, () => string>> = {
  long_setup: () => t('LONG setup'), sellers_absorbed: () => t('Sellers absorbed'), shorts_trapped: () => t('Shorts trapped'),
  long_flush: () => t('Long flush'), spot_buying: () => t('Spot buying'), spot_selling: () => t('Spot selling'),
  short_covering: () => t('Short covering'), longs_trapped: () => t('Longs trapped'), buyers_absorbed: () => t('Buyers absorbed'),
  short_setup: () => t('SHORT setup'),
};
const MASTER = (id: SignalId): boolean => id === 'long_setup' || id === 'short_setup';
/** Candles needed before the first one in view, so every rule has its history (jdk/signals.ts). */
const LEAD = DEFAULT_SIGNAL_PARAMS.N + DEFAULT_SIGNAL_PARAMS.X + DEFAULT_SIGNAL_PARAMS.W + 2;
/** At most this many candles worked out at once (a week of one-minute candles). */
const MAX_CANDLES = 10_200;
/** A model whose data changed is worked out again at most this often (closed candles do not change; late readings do). */
const REFRESH_MS = 5_000;

const signedUsd = (v: number): string => !Number.isFinite(v) ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}$${usd(Math.abs(v))}`;
const times = (v: number, typical: number): string => Number.isFinite(v) && typical > 0 ? t('{x}× typical', { x: (Math.abs(v) / typical).toFixed(1) }) : '–';

interface Model {
  key: string; refs: readonly unknown[]; at: number;
  starts: number[]; candles: FlowCandle[]; result: SignalResult;
  perp: number; spot: number; oiVenues: number; earliest: number | null;
}

/** The popup of one candle: the signals it lit and the numbers they were judged on. */
export function jdkCardLines(m: Pick<Model, 'starts' | 'result'>, i: number, tf: string): InfoLine[] {
  const r = m.result.readings, lines: InfoLine[] = [{ text: `${clock(m.starts[i]!, true)} · ${tf}`, bold: true }];
  const lit = SIGNAL_IDS.filter(id => m.result.marks[id][i]);
  if (!lit.length) lines.push({ text: t('No signal on this candle.'), color: 'muted' });
  for (const id of lit) lines.push({ text: NAMES[id](), color: SIGNAL_SIDE[id] > 0 ? 'buy' : 'sell', bold: MASTER(id) });
  const from = r.trapFrom[i]!;
  if (from >= 0) lines.push({ label: t('Trapped since'), text: clock(m.starts[from]!, true), color: 'muted' });
  const coins = (v: number): string => !Number.isFinite(v) ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(Math.abs(v) >= 100 ? 0 : 1)}`;
  lines.push(
    { label: t('Perp delta'), text: `${signedUsd(r.perpDelta[i]!)} · ${times(r.perpDelta[i]!, r.typPerp[i]!)}`, color: r.perpDelta[i]! > 0 ? 'buy' : r.perpDelta[i]! < 0 ? 'sell' : 'text', rule: true },
    { label: t('Spot delta'), text: `${signedUsd(r.spotDelta[i]!)} · ${times(r.spotDelta[i]!, r.typSpot[i]!)}`, color: r.spotDelta[i]! > 0 ? 'buy' : r.spotDelta[i]! < 0 ? 'sell' : 'text' },
    { label: t('Open interest change'), text: `${coins(r.oiChange[i]!)} · ${times(r.oiChange[i]!, r.typOi[i]!)}`, color: 'text' },
    { label: t('Range'), text: Number.isFinite(r.rangeBp[i]!) ? `${r.rangeBp[i]!.toFixed(0)} bp · ${times(r.rangeBp[i]!, r.typRange[i]!)}` : '–', color: 'muted' },
  );
  return lines;
}

/**
 * JDK Signals: the order-flow reads of the JDK study (absorption, trapped traders, flushes, short covering, spot leading) as one row each,
 * a dot under each candle of the chart's timeframe where the read fired, so a signal stays where it happened and can be looked at again.
 * The flow is the Delta pane's (the flow column's ALL VENUES markets), split into perpetual and spot; open interest is the OI pane's.
 * Only closed candles are judged: a signal is known when its candle closes and never changes after.
 */
export class JdkPane extends TimePane {
  #card = new HoverCard();
  #lines: InfoLine[] | null = null;
  #perpCache = new FlowCache();
  #spotCache = new FlowCache();
  #model: Model | null = null;

  constructor(host: HTMLElement, store: Store, view: View, private hub: Hub) {
    super(host, store, view, 'jdk');
    this.head.innerHTML = `<strong>${t('JDK Signals')}</strong><span class="readout"></span>`;
    this.head.querySelector('strong')!.after(helpButton('jdkPane'));
    setTip(this.head.querySelector('strong')!, t('Absorption, trapped traders, flushes, short covering and spot leading, one row each, marked under the candle where each one fired.'));
    const group = document.createElement('span'); group.className = 'ctl ctl-group'; this.head.append(group);
    const exportButton = document.createElement('button'); exportButton.type = 'button'; exportButton.textContent = t('Export CSV');
    setTip(exportButton, t('Save the candles in view with their flow and the signals each one lit, one line per candle.'));
    exportButton.onclick = () => this.#export();
    group.append(exportButton);
  }

  protected draw(): void {
    this.#lines = null;
    this.#paint();
    const at = this.pointer;
    if (this.#lines && at) this.#card.show(this.#lines, at.x, at.y); else this.#card.hide();
  }
  protected override undrawn(): void { this.#lines = null; this.#card.hide(); }

  /** The candles from LEAD before the view to its right edge (closed ones only), their flow and open interest, and their signals. */
  #modelFor(state: AppState, now: number): Model | null {
    const v = this.view, tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, flow = this.hub.flow;
    const lastClosed = Math.floor(now / tf) * tf - tf;
    const last = Math.min(Math.floor(v.t1 / tf) * tf, lastClosed);
    const first = Math.max(Math.floor(v.t0 / tf) * tf - LEAD * tf, last - (MAX_CANDLES - 1) * tf);
    if (last < first) return null;
    const starts: number[] = [];
    for (let s = first; s <= last; s += tf) starts.push(s);
    ensureDeltaFlow(this.hub, flowLoadIds(state, flow.ids), starts[0]!, Date.now());
    const lanes = aggregateFamilies(flow, flowIds(state, flow.ids), id => kindOf(state.markets, id)).aggregate.flatMap(f => f.lanes);
    const perpIds = lanes.filter(l => l.kind === 'perp').map(l => l.id), spotIds = lanes.filter(l => l.kind === 'spot').map(l => l.id);
    const parts: readonly OiPart[] = replaying() ? oiPartsUntil(state.oiParts, tf, now) : state.oiParts;
    const oiBars: readonly OiBar[] = replaying() ? state.oi.filter(b => b[0] + tf <= now) : state.oi;
    const key = `${perpIds.join(',')}|${spotIds.join(',')}|${tf}|${first}|${last}|${flow.loads}`;
    const refs = [state.oi, state.oiParts, state.candles] as const;
    const held = this.#model, wall = Date.now();
    if (held && held.key === key && (held.refs.every((r, k) => r === refs[k]) || wall - held.at < REFRESH_MS)) return held;
    const perp = deltaFlows(this.#perpCache, flow, perpIds, starts, tf, now);
    const spot = deltaFlows(this.#spotCache, flow, spotIds, starts, tf, now);
    const doi = oiChangeByTime(oiBars, parts, tf);
    const bars = new Map(state.candles.map(c => [c[0], c] as const));
    const split = (f: CandleFlow | null | undefined): [number, number] => f ? [(f.gross + f.delta) / 2, (f.gross - f.delta) / 2] : [NaN, NaN];
    const candles: FlowCandle[] = starts.map((s, i) => {
      const c = bars.get(s), [pb, ps] = split(perp.flows[i]), [sb, ss] = spotIds.length ? split(spot.flows[i]) : [NaN, NaN];
      return { t: s, o: c?.[1] ?? NaN, h: c?.[2] ?? NaN, l: c?.[3] ?? NaN, c: c?.[4] ?? NaN, pb, ps, sb, ss, oi: NaN, doi: doi.get(s) ?? NaN };
    });
    const model: Model = {
      key, refs, at: wall, starts, candles, result: computeSignals(candles),
      perp: perpIds.length, spot: spotIds.length, oiVenues: Math.max(parts.length, oiBars.length ? 1 : 0), earliest: perp.earliest,
    };
    this.#model = model;
    return model;
  }

  #paint(): void {
    const { ctx, palette: p, view: v } = this, pw = this.plotW, ph = this.h, state = this.store.state, now = pageNow();
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, readout = this.head.querySelector('.readout');
    const m = this.#modelFor(state, now);
    const inView = m ? m.starts.map((s, i) => s + tf >= v.t0 && s <= v.t1 ? i : -1).filter(i => i >= 0) : [];
    const judged = m ? inView.filter(i => m.result.readings.typPerp[i]! > 0) : [];
    if (!m || !judged.length) {
      ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(!m || m.earliest === null ? t('No flow recorded for these candles yet.')
        : t('Signals start {n} candles after the flow does: each candle is judged against the ones before it.', { n: DEFAULT_SIGNAL_PARAMS.N }), 12, ph / 2);
      setHtml(readout, ''); return;
    }
    const rows = SIGNAL_IDS.length, top = 3, bottom = ph - 3, rowH = (bottom - top) / rows;
    const yOf = (r: number): number => top + rowH * (r + 0.5);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
    // Faint guides for the rows, and a firmer line between the bullish half and the bearish one.
    ctx.strokeStyle = p.line; ctx.lineWidth = 1;
    for (let r = 0; r < rows; r++) { ctx.globalAlpha = 0.25; ctx.beginPath(); ctx.moveTo(0, Math.round(yOf(r)) + 0.5); ctx.lineTo(pw, Math.round(yOf(r)) + 0.5); ctx.stroke(); }
    const half = SIGNAL_IDS.findIndex(id => SIGNAL_SIDE[id] < 0);
    ctx.globalAlpha = 0.9; ctx.beginPath(); ctx.moveTo(0, Math.round(top + rowH * half) + 0.5); ctx.lineTo(pw, Math.round(top + rowH * half) + 0.5); ctx.stroke(); ctx.globalAlpha = 1;
    for (const i of inView) {
      const s = m.starts[i]!, x0 = v.xOf(s, pw), x1 = v.xOf(s + tf, pw), xc = (x0 + x1) / 2, slot = x1 - x0;
      SIGNAL_IDS.forEach((id, r) => {
        if (!m.result.marks[id][i]) return;
        const master = MASTER(id), radius = Math.max(1.5, Math.min(master ? 5 : 3.5, slot * (master ? 0.45 : 0.32), rowH * 0.42));
        ctx.fillStyle = SIGNAL_SIDE[id] > 0 ? p.bid : p.ask;
        ctx.beginPath(); ctx.arc(xc, yOf(r), radius, 0, Math.PI * 2); ctx.fill();
        if (master) { ctx.strokeStyle = p.text; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(xc, yOf(r), radius + 1.5, 0, Math.PI * 2); ctx.stroke(); }
      });
    }
    // The rows' names at the left, on the panel's colour so the dots under them stay faintly visible.
    ctx.font = `${Math.max(8, Math.min(11, Math.floor(rowH * 0.85)))}px ui-sans-serif, system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const labelW = Math.max(...SIGNAL_IDS.map(id => ctx.measureText(NAMES[id]()).width)) + 10;
    ctx.globalAlpha = 0.8; ctx.fillStyle = p.panel; ctx.fillRect(0, top, labelW, bottom - top); ctx.globalAlpha = 1;
    SIGNAL_IDS.forEach((id, r) => { ctx.fillStyle = MASTER(id) ? (SIGNAL_SIDE[id] > 0 ? p.bid : p.ask) : p.muted; ctx.fillText(NAMES[id](), 5, yOf(r)); });
    ctx.restore();
    // Readout and popup: the candle under the pointer (past the newest closed one, that one), else the newest.
    const hover = state.hover, newest = inView[inView.length - 1]!;
    let shown = newest;
    if (hover) { const under = Math.floor((hover.t - m.starts[0]!) / tf); if (under >= 0 && under < m.starts.length) shown = under; else if (under >= m.starts.length) shown = m.starts.length - 1; }
    if (hover && this.pointer && hover.t >= m.starts[m.starts.length - 1]! + tf) this.cursorT = m.starts[m.starts.length - 1]! + tf / 2;
    if (hover && this.pointer) this.#lines = jdkCardLines(m, shown, state.timeframe);
    const lit = SIGNAL_IDS.filter(id => m.result.marks[id][shown]);
    const names = lit.length ? lit.map(id => `<b class="${SIGNAL_SIDE[id] > 0 ? 'bid' : 'ask'}">${NAMES[id]()}</b>`).join(' · ') : `<span class="muted">${t('none')}</span>`;
    const sources = t('{p} perpetual and {s} spot markets, open interest from {o}', { p: m.perp, s: m.spot, o: m.oiVenues });
    setHtml(readout, `${clock(m.starts[shown]!, true)} ${names} <span class="muted">${sources}</span>`);
  }

  /** Export CSV: the candles in view, one line each: the start, the close, the flow and open interest change, and each signal (1 = fired). */
  #export(): void {
    const m = this.#model, state = this.store.state, v = this.view, tf = TIMEFRAMES[state.timeframe] ?? 3_600_000;
    if (!m) return;
    const at = m.starts.map((s, i) => s + tf > v.t0 && s < v.t1 ? i : -1).filter(i => i >= 0);
    if (!at.length) return;
    const r = m.result.readings, num = (x: number): string => Number.isFinite(x) ? String(Math.round(x * 100) / 100) : '';
    const lines = [['candle_start_utc', 'close', 'perp_delta_usd', 'spot_delta_usd', 'oi_change', ...SIGNAL_IDS].join(',')];
    for (const i of at) lines.push([new Date(m.starts[i]!).toISOString(), num(m.candles[i]!.c), num(r.perpDelta[i]!), num(r.spotDelta[i]!), num(r.oiChange[i]!), ...SIGNAL_IDS.map(id => String(m.result.marks[id][i]))].join(','));
    const name = `jdk-signals-${state.marketId.replace(/[^A-Za-z0-9]+/g, '-')}-${state.timeframe}-${new Date(m.starts[at[at.length - 1]!]!).toISOString().slice(0, 16).replace(/[-:]/g, '')}Z.csv`;
    const url = URL.createObjectURL(new Blob([`﻿${lines.join('\n')}\n`], { type: 'text/csv' })), link = el('a', { href: url, download: name });
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
