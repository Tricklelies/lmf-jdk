import type { LevelsFrame } from './wire.ts';
import type { OiPart } from './oi-change.ts';
import type { TimeZone } from './format.ts';
import { HEAT_STYLES, type HeatStyleId } from './heatmap/lut.ts';
import { clampContrast } from './heatmap/window.ts';
import { LT_DEFAULTS, type LtParams } from './lt.ts';
import { resolveThemeId } from './theme.ts';
import { readStatOptions, type StatOptions } from './stat-options.ts';
import { readHighlight, type HighlightOptions } from './anomaly.ts';
import { DEFAULT_SOUNDS, readSounds, type SoundSettings } from './sound/rules.ts';
import { readCvd, type CvdSettings } from './cvd/settings.ts';
import { readAbsorption, type AbsorptionSettings } from './absorption.ts';
import { readBubbles, type BubbleSettings } from './prints.ts';
import { readLiquidations, type LiquidationSettings } from './liquidations.ts';
import { readKeyLevels, type KeyLevelSettings } from './keylevels/settings.ts';
import { readVwap, type VwapSettings } from './vwap/settings.ts';
import { readFootprint, type FootprintSettings } from './footprint/settings.ts';
import { readDelta, type DeltaSettings } from './delta/settings.ts';
import { isPhone } from './device.ts';
import { LS_METRICS, type LsMetric } from '../shared/long-short.ts';
import { readCustomMarkets, type CustomMarkets } from './market-choice.ts';
import { readPullWindow, type PullWindow } from './panes/pull-stack.ts';
import { readLadderCues, type LadderCues } from './panes/ladder-cue-settings.ts';
import type { EngineState } from './sound/engine.ts';
import type { RangeSelection } from './range/selection.ts';
import { hasTop, readTraded, topFromStrip, type TradedSettings } from './traded/settings.ts';
import { withTopOn } from './traded/profiles.ts';
import { t } from './i18n.ts';
import type { ReplayView } from './replay/clock.ts';

export type Layer = 'liquidity' | 'liquidation' | 'stopLoss' | 'takeProfit';
/** Layers that can be chosen today. The others are announced in the dropdown as upcoming and need a data source that is not connected yet. */
export const AVAILABLE_LAYERS: readonly Layer[] = ['liquidity'];
export type LadderMode = 'aggregated' | 'single' | 'compact';
export type LadderShow = 'levels' | 'cumulative' | 'both';
/** Which kind of market the liquidity views draw: spot books, perpetual books, or every enabled venue. */
export type Scope = 'all' | 'spot' | 'perp';
export interface Market { id?: string; instrumentId?: string; venue?: string; base?: string; quote?: string; marketType?: string; tickSize?: number; symbol?: string }
/**
 * [start, open, high, low, close, volume, sourceRows, takerBuys, trades, quoteVolume, quoteBought]: the taker buys only on the candles read with
 * them, where the venue reports them, and the trades and quote volumes (Binance's) only beside them (shared/series.ts `Candle`).
 */
export type CandleRow = [number, number, number, number, number, number, number?, number?, number?, number?, number?];
/** [start, open, high, low, close] */
export type OiBar = [number, number, number, number, number];
export interface LayerLevel { id: string; side: string; price: number; notionalUsd: number; active?: boolean; amount?: number }

/**
 * Which panes are on the first time. No pane under the map is (Karl, 2026-10-17: depth and open interest were, and no extra pane should be):
 * each is one switch away. The flow column and the book beside the map are on.
 */
export const DEFAULT_SHOW: AppState['show'] = { profile: true, traded: false, depth: false, oi: false, delta: false, ls: false, jdk: false, candles: true, footprint: false, stats: false, lt: false, mirror: true, volume: true, bubbles: true, cvd: true, book: true };
/**
 * The panes a first visit starts with. The flow column and the book each take a few hundred pixels beside the map, so on a window that is wide enough
 * for the map to stay readable with both (a phone has its tabs instead) they start on; a medium window (a tablet held sideways, a small laptop)
 * starts with the book only, and Flow is one click in the top bar.
 */
export function defaultShow(width: number = typeof window === 'undefined' ? 1920 : window.innerWidth): AppState['show'] {
  return { ...DEFAULT_SHOW, cvd: width <= 640 || width >= 1500 };
}

/** Statistics shown by default in the bar-stats strip (ids from panes/bar-stats.ts). */
export const DEFAULT_BAR_STATS: readonly string[] = ['vol', 'delta', 'cvd'];

export interface AppState {
  connected: boolean;
  status: string;
  markets: Market[];
  marketId: string;
  /** Instrument whose candles/OI are shown: the market itself, or the reference series when it has none. */
  seriesInstrument: string;
  mark: { price: number; asOf: number };
  levels: LevelsFrame | null;
  /** Venues whose book has left the map, with the frame time (`asOf`) they were last on it, for `BOOK_HOLD_MS` (`cvd/ids.ts`). */
  bookGone: Readonly<Record<string, number>>;
  timeframe: string;
  layer: Layer;
  layers: Record<string, LayerLevel[]>;
  candles: CandleRow[];
  oi: OiBar[];
  /** Instrument the OI bars belong to (the market's own, or a reference perp when the market has no OI history); empty while venues are added together. */
  oiInstrument: string;
  /**
   * Whose open interest the OI pane, the bar statistics and NL/NS count: every perpetual of the ALL VENUES lines added together (the default)
   * or the chart market's own (a reference perpetual standing in where it has none).
   */
  oiMarkets: 'all' | 'chart' | 'custom';
  /** The markets picked for the footprint and for the open interest when their choice is 'custom' (market-choice.ts: exchanges and kinds, never ids). */
  customMarkets: CustomMarkets;
  /** Each venue's bars while they are added together (`oi` is then their sum, oi-change.ts `sumOi`); empty for one market. */
  oiParts: OiPart[];
  /** One market's `oi` from an inverse market: the one price its coins are put at (its USD over it, `Hub.oiSeries`); 0 for a linear market. */
  oiPrice: number;
  show: { profile: boolean; /** The traded-volume column beside the profile (not on phones). */ traded: boolean; depth: boolean; oi: boolean; /** The Delta pane under the map (taker delta and CVD by candle). */ delta: boolean; /** The Long/Short pane (the venues' published long/short account ratios). */ ls: boolean; /** The JDK Signals pane (order-flow reads marked per candle). */ jdk: boolean; candles: boolean; footprint: boolean; /** The Bar stats table under the map (its own switch since 2026-10-20; it was the footprint's before). */ stats: boolean; lt: boolean; mirror: boolean; volume: boolean; bubbles: boolean; /** The taker-flow (CVD) column left of the map, and the order book column right of it. */ cvd: boolean; book: boolean };
  /** The CVD column's settings. */
  cvd: CvdSettings;
  /** What counts as standing out (anomalous volume, OI change, ...), shared by every pane. */
  highlight: HighlightOptions;
  /** Absorption marks on the map: whether they show, and the threshold they are judged at. */
  absorption: AbsorptionSettings;
  /** How the trade bubbles are drawn (whether they are is `show.bubbles`). */
  tradeBubbles: BubbleSettings;
  /** The liquidations drawn on the map (liquidations.ts). */
  liquidations: LiquidationSettings;
  /** The previous day's, week's and month's levels on the map (keylevels/). */
  keyLevels: KeyLevelSettings;
  /** The VWAP lines: the session's, its bands and the anchored ones (vwap/). */
  vwap: VwapSettings;
  /** The next click on the map places a VWAP anchor (not saved; arming the Range tool ends it). */
  vwapAnchoring: boolean;
  /** The footprint's own settings (whether it shows is `show.footprint`; its imbalance options are `barStatOptions`). */
  footprint: FootprintSettings;
  /** The Delta pane's settings: bars or CVD candles, where the CVD restarts, divergences. */
  delta: DeltaSettings;
  /** The Binance series the Long/Short pane shows: every account, its top traders' accounts or their positions (the other venues publish one each). */
  lsMetric: LsMetric;
  /** Sound notifications: master switch, volume, which trades count and the size tiers. */
  sounds: SoundSettings;
  /** Whether the browser lets sound play yet (it holds audio until a click or key press). */
  soundState: EngineState;
  /** Time of the last sound decision, so the toolbar can flash. */
  lastSound: number;
  /** Spot / perpetual / both filter on the enabled venues for the liquidity views. It never changes which venues are enabled. */
  scope: Scope;
  /** Enabled bar statistics in display order. */
  barStats: string[];
  /** Bar-stats options (imbalance thresholds, size buckets, units, cell style). */
  barStatOptions: StatOptions;
  /** Liquidity Tracker settings and which view of it the row draws. */
  lt: LtParams & { view: 'lines' | 'imbalance' };
  /** 'aggregated' draws every enabled venue; otherwise a single instrument id. */
  heatmapSource: string;
  disabledVenues: string[];
  /** Heatmap colouring: ramp style, one contrast slider (-100 to 100, 50 = percentile baseline; see heatmap/window.ts) and whether the baseline follows the data. */
  heat: { style: HeatStyleId; auto: boolean; contrast: number; smooth: 'auto' | 'off' };
  grouping: 'auto' | number;
  ladderMode: LadderMode;
  ladderShow: LadderShow;
  /** How many venue lines the Compact book draws over its running total (0: none; panes/ladder-curves.ts). */
  ladderCurves: LadderCurves;
  /** Replay (replay/clock.ts): what its controls show, null when live. Not saved: a page always opens live. */
  replay: ReplayView | null;
  /** The order book's pull/stack window in seconds (0: off). */
  pullStack: PullWindow;
  /** What lights in the order book when a venue's displayed depth changes, and the heat strip under each venue's part of a level (panes/ladder-cue-settings.ts). */
  ladderCues: LadderCues;
  ladderVenue: string;
  /** Instrument ids that get their own book in Single mode (empty = every enabled venue). */
  ladderVenues: string[];
  theme: string;
  /** Which revision of the first-visit defaults the saved settings were written under (`DEFAULTS_REV`). */
  defaultsRev: number;
  /** Whether the theme was picked from the menu: a saved one that was not is the page's default of the time, not a choice (`initialState`). */
  themePicked: boolean;
  /** What the chrome around the chart is made of, in any theme: solid, or glass that the market's large orders light (glass/ui-glass.ts). */
  material: 'solid' | 'glass';
  followLive: boolean;
  /** Keep the screen on while the page is open (a phone's screen sleeping stops the recording). */
  keepAwake: boolean;
  /**
   * The top bar folded away, the chart taking its room, as a browser's full screen does (a tablet's screen is short); a tab at the top
   * brings it back. Kept in this browser, never in a layout: it is about the screen, not about what the chart shows.
   */
  barCollapsed: boolean;
  /** The clock the page's times are on: the computer's own, or UTC. */
  timeZone: TimeZone;
  /**
   * Shared cursor: `t` is authoritative; each pane converts it to its own x. `price` is only set by the heatmap. `touch` marks a hover
   * that a finger pinned (it stays until the next tap or drag, and its readouts sit above the finger).
   */
  hover: { t: number; price: number | null; y: number; source: 'heat' | 'depth' | 'oi' | 'lt' | 'bars' | 'cvd' | 'delta' | 'ls' | 'jdk'; touch?: boolean } | null;
  /** The Range tool's selection (a box on the map, or a stretch of time), being dragged or made; and whether the next drag selects (range/). Not saved. */
  range: RangeSelection | null;
  rangeTool: boolean;
  /** The Traded feature's settings: its column's bars and markers, and the point-of-control lines on the chart (`show.traded` switches it). */
  traded: TradedSettings;
}

type Listener = (state: AppState, changed: ReadonlySet<keyof AppState>) => void;

const PERSISTED: (keyof AppState)[] = ['keepAwake', 'barCollapsed', 'material', 'timeZone', 'timeframe', 'layer', 'show', 'cvd', 'heatmapSource', 'disabledVenues', 'scope', 'highlight', 'absorption', 'tradeBubbles', 'liquidations', 'keyLevels', 'vwap', 'footprint', 'delta', 'sounds', 'heat', 'lt', 'barStats', 'barStatOptions', 'grouping', 'ladderMode', 'ladderShow', 'ladderCurves', 'pullStack', 'ladderCues', 'ladderVenue', 'ladderVenues', 'theme', 'themePicked', 'defaultsRev', 'traded', 'oiMarkets', 'lsMetric', 'customMarkets'];
function readSaved(): Partial<AppState> {
  try { const raw = window.localStorage.getItem('hlm-app-v2'); return raw ? JSON.parse(raw) as Partial<AppState> : {}; } catch { return {}; }
}

/** How many venue lines the Compact book may draw. */
export const LADDER_CURVES = [0, 3, 5, 8] as const;
export type LadderCurves = (typeof LADDER_CURVES)[number];

/** The settings a saved layout holds: what the chart shows and how, never the coin, the venues, the theme, the time zone or the sounds. */
export const LAYOUT_KEYS = ['timeframe', 'layer', 'show', 'cvd', 'scope', 'highlight', 'absorption', 'tradeBubbles', 'liquidations', 'keyLevels', 'vwap', 'footprint', 'delta',
  'heat', 'lt', 'barStats', 'barStatOptions', 'grouping', 'ladderMode', 'ladderShow', 'ladderCurves', 'pullStack', 'ladderCues', 'traded', 'oiMarkets', 'lsMetric', 'customMarkets'] as const satisfies readonly (keyof AppState)[];
export type Settings = Pick<AppState, (typeof LAYOUT_KEYS)[number]>;

/** The timeframes (hub.ts TIMEFRAMES; a test keeps the two the same). */
export const TIMEFRAME_IDS: readonly string[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
const HEAT_DEFAULTS: AppState['heat'] = { style: 'size', auto: true, contrast: 50, smooth: 'auto' };

/** A flat settings object from storage or a file: each field the defaults have, kept when it has the default's type (a number must be finite). */
export function sameShape<T extends object>(defaults: T, raw: unknown): T {
  const out = { ...defaults } as Record<string, unknown>;
  if (raw && typeof raw === 'object') {
    for (const [key, fallback] of Object.entries(defaults)) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === typeof fallback && (typeof value !== 'number' || Number.isFinite(value))) out[key] = value;
    }
  }
  return out as T;
}

/**
 * The settings of a saved page or a saved layout, field by field: anything missing or not valid gets its default. A layouts file can come
 * from anywhere, so nothing reaches the state without passing here.
 */
export function readSettings(saved: Partial<Record<keyof AppState, unknown>>): Settings {
  const heat = sameShape(HEAT_DEFAULTS, saved.heat), lt = saved.lt as { view?: unknown } | undefined;
  // A save or a layout from when the profile along the top was the measure strip (`measureStrip`): the strip becomes the profile along the
  // top (`readTraded`), and where it showed, the Volume profile it now belongs to is switched on, or the strip would be gone.
  const strip = hasTop(saved.traded) ? null : topFromStrip((saved as Record<string, unknown>).measureStrip);
  const traded = readTraded(saved.traded, strip), show = sameShape(defaultShow(), saved.show);
  // The Bar stats table showed with the footprint until it had its own switch: a save or a layout from before keeps it where the footprint was on.
  const oldShow = saved.show as Record<string, unknown> | undefined;
  if (oldShow && typeof oldShow === 'object' && typeof oldShow.stats !== 'boolean') show.stats = oldShow.footprint === true;
  return {
    timeframe: typeof saved.timeframe === 'string' && TIMEFRAME_IDS.includes(saved.timeframe) ? saved.timeframe : '1h',
    // A layer saved before it was withdrawn would otherwise open on an empty chart.
    layer: AVAILABLE_LAYERS.includes(saved.layer as Layer) ? saved.layer as Layer : 'liquidity',
    show: strip?.on ? { ...show, traded: true } : show,
    cvd: readCvd(saved.cvd), highlight: readHighlight(saved.highlight), absorption: readAbsorption(saved.absorption), tradeBubbles: readBubbles(saved.tradeBubbles),
    liquidations: readLiquidations(saved.liquidations), keyLevels: readKeyLevels(saved.keyLevels), vwap: readVwap(saved.vwap), footprint: readFootprint(saved.footprint),
    delta: readDelta(saved.delta), lsMetric: (LS_METRICS as readonly unknown[]).includes(saved.lsMetric) ? saved.lsMetric as LsMetric : 'accounts', pullStack: readPullWindow(saved.pullStack),
    ladderCues: readLadderCues(saved.ladderCues),
    traded,
    scope: saved.scope === 'spot' || saved.scope === 'perp' ? saved.scope : 'all',
    heat: { ...heat, style: HEAT_STYLES.some(style => style.id === heat.style) ? heat.style : 'size', smooth: heat.smooth === 'off' ? 'off' : 'auto', contrast: clampContrast(heat.contrast) },
    lt: { ...sameShape(LT_DEFAULTS, saved.lt), view: lt?.view === 'imbalance' ? 'imbalance' : 'lines' },
    barStats: Array.isArray(saved.barStats) ? saved.barStats.filter((id): id is string => typeof id === 'string').slice(0, 24) : [...DEFAULT_BAR_STATS],
    barStatOptions: readStatOptions(saved.barStatOptions),
    grouping: saved.grouping === 'auto' || (typeof saved.grouping === 'number' && Number.isFinite(saved.grouping) && saved.grouping > 0) ? saved.grouping : 'auto',
    // Compact is the default since 2026-10-12 (Aggregated before): a page that saved Aggregated keeps it, since a choice and the old default look the same.
    ladderMode: saved.ladderMode === 'single' || saved.ladderMode === 'aggregated' ? saved.ladderMode : 'compact',
    ladderCurves: LADDER_CURVES.includes(saved.ladderCurves as LadderCurves) ? saved.ladderCurves as LadderCurves : 5,
    ladderShow: saved.ladderShow === 'levels' || saved.ladderShow === 'cumulative' ? saved.ladderShow : 'both',
    oiMarkets: saved.oiMarkets === 'chart' || saved.oiMarkets === 'custom' ? saved.oiMarkets : 'all',
    customMarkets: readCustomMarkets(saved.customMarkets),
  };
}

/** The theme a page opens in, on a desktop and on a phone. */
export const DEFAULT_THEME = 'light';
/**
 * The revision of the first-visit defaults. The page saves its whole settings on any change, so a default is written down whether chosen
 * or not; when a default changes, a save from before it (an older or no revision) would keep the old one for ever. Revision 1: Depth and
 * Open interest start off. A save of that kind holding both on, the old default, has them turned off once; one that holds only one of
 * them on was a choice and is left. Revision 2 (2026-10-20): what was new that day shows, as Karl asked ("the UI needs to show the new"):
 * the volume profile's days are drawn on the chart, their lines and their profiles, where a save holds no period and no profile (never
 * chosen: the choice came that day), and the measure strip along the top of the map is on (on a desktop: a phone has no room for it).
 * Revision 3 (2026-10-20): the measure strip became the volume profile turned onto the time axis, set in the Volume profile's panel and
 * switched with it (Karl: "why not do basically exactly a clone of the profile, but at the top of the chart"). A save's strip is read into
 * the profile along the top by `readSettings` (saved layouts too; traded/profiles.ts since): its switch as it was, Delta as traded volume, OI change as open interest, and the
 * Volume profile switched on where the strip showed, or the strip would be gone. A save from before revision 2, and a first visit, had the
 * strip on (on a desktop): they get the profile along the top, and with it the Volume profile.
 */
export const DEFAULTS_REV = 3;

export function initialState(): AppState {
  const saved = readSaved();
  const state: AppState = {
    connected: false, status: t('connecting'), markets: [], marketId: '', seriesInstrument: '', mark: { price: 0, asOf: 0 }, levels: null, bookGone: {},
    layers: {}, candles: [], oi: [], oiInstrument: '', oiParts: [], oiPrice: 0, sounds: { ...DEFAULT_SOUNDS }, soundState: 'locked', lastSound: 0, vwapAnchoring: false, heatmapSource: 'aggregated', disabledVenues: [],
    ladderVenue: '', ladderVenues: [], replay: null, theme: DEFAULT_THEME, themePicked: false, defaultsRev: DEFAULTS_REV, material: 'solid', followLive: true, keepAwake: false, barCollapsed: false, timeZone: 'local', hover: null, range: null, rangeTool: false,
    ...saved, ...readSettings(saved),
  };
  // A save's measure strip was read into the profile along the top (`readSettings`): it is no setting of its own any more.
  delete (state as unknown as Record<string, unknown>).measureStrip;
  // The volume profile (the traded column, now with its lines on the chart) is off unless chosen: a save from before it had settings of its
  // own holds the column's old default, not a choice. (A page's save only: a saved layout always carries its own.) A measure strip that
  // showed is the exception: `readSettings` switched the Volume profile on for it, the profile along the top being part of it now.
  if (saved.traded === undefined && topFromStrip((saved as Record<string, unknown>).measureStrip)?.on !== true) state.show.traded = false;
  state.sounds = readSounds(saved.sounds);
  state.timeZone = saved.timeZone === 'utc' ? 'utc' : 'local';
  // Terminal was the default for a day (2026-10-17), and every save of that day wrote it down whether chosen or not: a saved Terminal that
  // was not picked from the menu goes back to the default, and the saves since carry the pick.
  state.themePicked = saved.themePicked === true;
  const rev = typeof saved.defaultsRev === 'number' ? saved.defaultsRev : 0;
  if (rev < 1 && state.show.depth && state.show.oi) state.show = { ...state.show, depth: false, oi: false };
  if (rev < 2) {
    if (!state.traded.lines.length && state.traded.profiles === null) state.traded = { ...state.traded, lines: ['day'], profiles: 'day' };
    // The strip revision 2 turned on is the profile along the top now, which shows with the Volume profile.
    if (!isPhone()) { state.traded = { ...state.traded, placements: withTopOn(state.traded.placements) }; state.show = { ...state.show, traded: true }; }
  }
  state.defaultsRev = DEFAULTS_REV;
  state.theme = resolveThemeId(state.theme);
  if (!state.themePicked && state.theme === 'terminal') state.theme = DEFAULT_THEME;
  state.material = saved.material === 'glass' ? 'glass' : 'solid';
  state.barCollapsed = saved.barCollapsed === true;
  state.replay = null;
  return state;
}

/** Minimal observable store; listeners receive the set of keys changed in one microtask batch. */
export class Store {
  state: AppState;
  #listeners = new Set<Listener>();
  #pending = new Set<keyof AppState>();
  #scheduled = false;
  constructor(state: AppState) { this.state = state; }
  subscribe(listener: Listener): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  set(patch: Partial<AppState>): void {
    for (const key of Object.keys(patch) as (keyof AppState)[]) { (this.state as unknown as Record<string, unknown>)[key] = patch[key]; this.#pending.add(key); }
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      const changed = this.#pending; this.#pending = new Set();
      for (const listener of this.#listeners) listener(this.state, changed);
      if ([...changed].some(key => PERSISTED.includes(key))) {
        try { window.localStorage.setItem('hlm-app-v2', JSON.stringify(Object.fromEntries(PERSISTED.map(key => [key, this.state[key]])))); } catch { /* storage unavailable */ }
      }
    });
  }
}
