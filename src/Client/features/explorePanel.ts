// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * The Explore panel — a singleton webview that opens a spatial, balloon-style
 * exploration of a table. It shows a "drill spine": a root hub bubble (the
 * source table) on top, locked aggregate bubbles stacking below, and a live
 * cloud of child aggregate bubbles you drag down to drill. Each hub bubble
 * carries an in-circle dimension facet at its bottom edge: drag it sideways to
 * scrub candidate dimensions, then fling down to group (Shift to accumulate a
 * combined grouping). Active groupings show as removable chips below the hub.
 *
 * The extension owns all state and generates the card/bubble HTML as strings.
 * The webview is a thin shell: it acquires the VS Code API, uses event
 * delegation so handlers survive innerHTML swaps, and posts intent messages
 * (groupDimension / removeDimension / focusBubble / clearGrouping) back to the
 * extension.
 *
 * Rendering is intentionally canvas-host-agnostic (plain HTML + flex/SVG) so
 * the card interior stays decoupled from any future pan/zoom canvas.
 */

import * as vscode from 'vscode';
import { IServer } from './server';
import type { DatabaseColumnInfo, DatabaseTableInfo } from './server';
import {
    classifyColumns,
    refineClassification,
    selectDimensionNubs,
    selectMeasureNubs,
    selectBinnableColumns,
    binKindForColumn,
    MAX_MEASURE_NUBS,
    type ClassifiedColumn,
    type ProfileStats,
} from './columnClassifier';

/** A tree item carrying enough context to explore a table. */
export interface ExploreTarget {
    clusterName: string;
    databaseName: string;
    tableInfo: DatabaseTableInfo;
}

/**
 * One locked level in the drill chain: the focused bubble's grouping
 * dimension(s) pinned to its value(s). Each lock contributes a `where`
 * predicate; `fromDimensions` remembers the grouping that was active at this
 * level so popping the crumb restores it.
 */
interface DrillCrumb {
    locks: Array<{ dimension: string; value: unknown; binSize?: string; values?: unknown[] }>;
    fromDimensions: string[];
    /** Bin sizes for any of `fromDimensions` that were BINNED keys (col → size
     *  token), so reopening this cloud restores the binning, not just the column. */
    fromBinKeys: Record<string, string>;
    display: string;
    /** Snapshot of the focused bubble's result row, so the locked node can be
     *  re-rendered as a bubble identical to how it looked when picked. */
    columns: string[];
    row: unknown[];
    /** Snapshot of the ENTIRE sibling cloud this bubble was chosen from, captured
     *  at descend time so the prior level can be left on screen as a receded ghost
     *  layer (the depth stack) instead of being discarded. Optional: crumbs created
     *  before this snapshotting existed simply render no ghost. */
    cloud?: CloudSnapshot;
}

/** Everything needed to re-render a past level's cloud as a static ghost layer:
 *  the grouped result plus the grouping/measure context it was rendered under.
 *  Column classifications (types) come from the live state, which is stable. */
interface CloudSnapshot {
    result: { columns: string[]; rows: unknown[][] };
    selectedDimensions: string[];
    binKeys: Record<string, string>;
    selectedMeasures: string[];
    selectedAggregate: AggKind;
}

/** A category of nubs (dimension / measure) that blooms its members on hover. */
interface NubCategory {
    key: string;
    title: string;
    action: string;
    members: ClassifiedColumn[];
    selected: string[];
    /** A static category just shows its chosen name(s) as a lit nub with no
     *  interactive member bloom (e.g. the root's locked-in grouping once drilled). */
    static?: boolean;
}

/** The current exploration state for the single MVP card. */
interface ExploreState {
    source: string;
    cluster: string;
    database: string;
    columns: ClassifiedColumn[];
    selectedDimensions: string[];
    /** For any selected group key that is a BINNED continuous column, its bin size
     *  token (col name → e.g. '1h', '100'). A selected dimension absent from this
     *  map is a plain discrete grouping; present means `summarize by bin(col,size)`. */
    binKeys: Record<string, string>;
    selectedMeasures: string[];
    /** How the selected numeric measure is aggregated (sum/avg/min/max). Ignored
     *  while measuring rows (count); preserved so switching back to a column
     *  restores the last-used function. */
    selectedAggregate: AggKind;
    totalCount: number | null;
    /** Whole-table sum of the primary selected measure (the root bubble's value),
     *  or null when no measure is selected / not yet computed. */
    totalMeasure: number | null;
    /** Result of the current summarize, as a flat table. */
    result: { columns: string[]; rows: unknown[][] } | null;
    /** Accumulated locked-in ancestor bubbles (the drill breadcrumb spine). */
    drillChain: DrillCrumb[];
    /** Row index (as string) of the focused-but-not-committed bubble, or null. */
    focusKey: string | null;
    /** Shift multi-select: the set of selected cloud bubbles (row indices as
     *  strings). Empty = no selection. When non-empty the cloud is in SELECTION
     *  mode (flat band highlight, no enlargement); a plain click clears it. For an
     *  ORDERED (binned) dimension this is always a contiguous run by bin order; for
     *  a DISCRETE dimension it's an arbitrary set toggled one at a time. */
    selectionKeys: string[];
    /** The anchor the binned contiguous run extends FROM (the first selected
     *  bubble), so successive shift-clicks re-extend from it. */
    selectionAnchor: string | null;
    /** Cloud presentation: 'auto' picks the LOD tier from the row count (and falls
     *  back to the table when too dense); 'table' forces the table regardless. */
    viewMode: 'auto' | 'table';
    /** When the current grouping has more distinct combinations than the explorer
     *  ceiling, the estimated group count (so we show a guidance card instead of a
     *  field and don't query the cloud); null when within the ceiling. */
    tooManyGroups: number | null;
    /** Record lens: whether the user has opened the top-N raw rows for the current
     *  (ungrouped) bubble's scope. The affordance is only offered when ungrouped;
     *  this stays false until the user explicitly toggles it (lazy — no query runs
     *  until then). */
    showRecords: boolean;
    /** The fetched record sample (raw rows of the current scope), or null when not
     *  loaded. `total` is the full scope row count so we can label it as a sample. */
    records: { columns: string[]; rows: unknown[][]; total: number | null } | null;
    /** True while the record sample is being fetched. */
    recordsLoading: boolean;
    loading: boolean;
    error?: string;
}

/** Row-count thresholds for the view. At/below FULL we draw the full three-line
 * bubbles; up to NUMERIC, compact value-only heat circles; up to DOT, bare heat
 * dots. The DOT ceiling is also the EXPLORER CEILING: a grouping with more than
 * this many distinct combinations can't be shown as a readable field at all, so we
 * refuse to query the cloud and show a guidance card instead (see runGrouping's
 * cardinality probe). The table view is just an alternative rendering of the SAME
 * ≤ceiling rows — never a way to see more. */
const LOD_FULL_MAX = 60;
const LOD_NUMERIC_MAX = 500;
const LOD_DOT_MAX = 2000;

/** The most groups we'll ever fetch/show — equals the heat-map (dot) ceiling. A
 * grouping estimated above this is blocked with guidance, not truncated silently,
 * so we never pull a huge result for a high-cardinality dimension. */
const MAX_GROUP_ROWS = LOD_DOT_MAX;

/** How many raw rows the record lens fetches for a bubble's scope. Records are
 * always a bounded, ordered SAMPLE (never "all rows"), labeled "N of <total>" so
 * the user knows it's a slice — same honesty rule as the cardinality guard. */
const RECORD_LIMIT = 100;

/** The flex footprint each tier's bubble occupies, so a focused (always-full)
 *  bubble can keep its tier-mate's slot size and not open gaps in a dense cloud. */
const LOD_SLOT_PX: Record<'full' | 'numeric' | 'dot', number> = { full: 96, numeric: 46, dot: 18 };

/** The aggregate functions a numeric measure can be summarized with. The dial on
 *  the caption glyph scrubs through these in order. Each maps to its Kusto function,
 *  the result-column header prefix that encodes the choice (parsed back by
 *  parseMeasureHeader for the glyph), a compact glyph, and a human label. */
type AggKind = 'sum' | 'avg' | 'min' | 'max';
const AGGREGATES: Record<AggKind, { func: string; prefix: string; glyph: string; label: string }> = {
    sum: { func: 'sum', prefix: 'Sum of ', glyph: 'Σ', label: 'Sum' },
    avg: { func: 'avg', prefix: 'Avg of ', glyph: 'x̄', label: 'Avg' },
    min: { func: 'min', prefix: 'Min of ', glyph: '↓', label: 'Min' },
    max: { func: 'max', prefix: 'Max of ', glyph: '↑', label: 'Max' },
};
const AGG_ORDER: AggKind[] = ['sum', 'avg', 'min', 'max'];
/** True when a result-column header is an aggregated measure (any agg prefix), as
 *  opposed to the fixed `Count` column or a grouping dimension. */
function isMeasureHeader(name: string): boolean {
    return AGG_ORDER.some(k => name.startsWith(AGGREGATES[k].prefix));
}
/** Maps a human aggregate label (as shown on the dial) back to its kind. */
function aggKindFromLabel(label: string): AggKind {
    const found = AGG_ORDER.find(k => AGGREGATES[k].label === label);
    return found ?? 'sum';
}
/** Maps a compact glyph back to its human aggregate label (for the hover-expand
 *  affordance on the glyph dial). Returns '' for the non-aggregate '#' (rows). */
function aggLabelFromGlyph(glyph: string): string {
    const found = AGG_ORDER.find(k => AGGREGATES[k].glyph === glyph);
    return found ? AGGREGATES[found].label : '';
}

/** Max dimension nubs offered in the dimension category bloom. */
const MAX_DIMENSION_NUBS = 5;

/** Radius of the hub bubbles (root/focus are 180px wide → 90px radius). */
const BUBBLE_RADIUS = 90;
/** Distance from hub center to a category nub's center — on the bubble edge. */
const NUB_RADIUS = BUBBLE_RADIUS;
/** Fixed angular gap (degrees) between adjacent member dots along their arc. */
const MEMBER_ARC_GAP = 22;
/** Each category kind has a FIXED angle on the bubble so it never moves with count
 *  (0° = right, 90° = straight down, in screen coords). */
const CATEGORY_ANGLE: Record<string, number> = { dimension: 130, measure: 50 };
function categoryAngle(key: string): number { return CATEGORY_ANGLE[key] ?? 90; }

/**
 * True when the user has drilled (locked at least one bubble) but not yet chosen
 * a grouping for the slice — the drag-to-stack state. The deepest locked bubble
 * is then the "active" hub awaiting a grouping choice, and no cloud is shown.
 */
function isActiveStacked(state: ExploreState): boolean {
    return state.drillChain.length > 0 && state.selectedDimensions.length === 0;
}
/** Max characters of a measure column name shown inside a bubble value line. */
const MAX_MEASURE_NAME_LEN = 12;

export class ExplorePanel {
    private panel: vscode.WebviewPanel | undefined;
    private state: ExploreState | undefined;
    private ready = false;
    /** Monotonic token so stale async query results are ignored. */
    private renderToken = 0;
    /** When set, the NEXT render tells the webview to play a depth-stack transition:
     *  'drill' = layers step back (we descended); 'back' = layers step forward (we
     *  reopened a prior cloud). Consumed (cleared) by render(). Post-drop only — the
     *  drag itself is not animated. */
    private pendingTransition: 'drill' | 'back' | null = null;
    /** When set, the NEXT settled render tells the webview to BLOOM the freshly
     *  grouped cloud — each child bubble emanates (scale + fade) out of the parent
     *  hub to its place. Set when a grouping is picked (applyGroupKey); consumed
     *  (cleared) by render() on the settled render. Independent of pendingTransition
     *  (a grouping pick is not a depth-stack step). */
    private pendingBloom = false;
    /** When set, the NEXT render tells the webview to COLLAPSE the open cloud back
     *  into the parent hub — the inverse of the bloom: each child bubble recedes
     *  (translate toward the hub + scale + fade) before the level falls back to a
     *  single ungrouped bubble. Set when removing the chip(s) that close the cloud
     *  (removeDimension/clearGrouping landing on zero dimensions). Consumed (cleared)
     *  by render() on the FIRST following render (the loading one, while the old
     *  cloud is still in the client DOM to be snapshotted). */
    private pendingCollapse = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly server: IServer,
    ) {}

    /** Entry point: open (or reuse) the panel and explore the given table. */
    public async exploreTable(target: ExploreTarget): Promise<void> {
        if (!target?.tableInfo) { return; }

        const columns: DatabaseColumnInfo[] = target.tableInfo.columns ?? [];
        this.state = {
            source: target.tableInfo.name,
            cluster: target.clusterName,
            database: target.databaseName,
            columns: classifyColumns(columns),
            selectedDimensions: [],
            binKeys: {},
            selectedMeasures: [],
            selectedAggregate: 'sum',
            totalCount: null,
            totalMeasure: null,
            result: null,
            drillChain: [],
            focusKey: null,
            selectionKeys: [],
            selectionAnchor: null,
            viewMode: 'auto',
            tooManyGroups: null,
            showRecords: false,
            records: null,
            recordsLoading: false,
            loading: true,
        };

        this.ensurePanel();
        this.panel!.title = `Explore: ${target.tableInfo.name}`;
        this.panel!.reveal(vscode.ViewColumn.Active, false);
        this.render();

        await this.loadOverview();
    }

    // ─── Webview lifecycle ──────────────────────────────────────────────

    private ensurePanel(): void {
        if (this.panel) { return; }

        this.panel = vscode.window.createWebviewPanel(
            'msKustoExplorer_explore',
            'Explore',
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
            { enableScripts: true, retainContextWhenHidden: true },
        );

        this.panel.webview.html = this.shellHtml();

        this.panel.webview.onDidReceiveMessage(
            (message) => this.handleMessage(message),
            undefined,
            this.context.subscriptions,
        );

        this.panel.onDidDispose(
            () => {
                this.panel = undefined;
                this.state = undefined;
                this.ready = false;
            },
            undefined,
            this.context.subscriptions,
        );
    }

    private handleMessage(message: { command?: string; column?: string; key?: string; index?: string; agg?: string; accumulate?: boolean; mode?: string; size?: string; shift?: boolean }): void {
        switch (message?.command) {
            case 'ready':
                this.ready = true;
                this.render();
                break;
            case 'toggleDimension':
                if (this.state && typeof message.column === 'string') {
                    this.toggleSelection(this.state.selectedDimensions, message.column);
                }
                break;
            case 'toggleMeasure':
                if (this.state && typeof message.column === 'string') {
                    this.toggleSelection(this.state.selectedMeasures, message.column);
                }
                break;
            case 'setMeasure':
                if (this.state && typeof message.column === 'string') {
                    // Measure dial (single-select): empty column = "rows" (count),
                    // otherwise the chosen numeric column. Replaces the whole
                    // selection — only one measure is shown at a time now.
                    this.state.selectedMeasures = message.column ? [message.column] : [];
                    void this.runGrouping();
                }
                break;
            case 'setAggregate':
                if (this.state && typeof message.agg === 'string' && message.agg in AGGREGATES) {
                    // Aggregate dial (single-select). Only meaningful with a column
                    // measure selected; while measuring rows it's a no-op (count).
                    this.state.selectedAggregate = message.agg as AggKind;
                    if (this.state.selectedMeasures.length > 0) { void this.runGrouping(); }
                }
                break;
            case 'focusBubble':
                if (this.state && typeof message.key === 'string') {
                    if (message.shift) {
                        // Shift-click: enter/extend SELECTION mode (no enlargement).
                        // Ordered (binned) dimension → contiguous run; discrete →
                        // toggle membership.
                        this.selectBubble(message.key);
                    } else {
                        // Plain click: single-inspect focus. Clears any selection.
                        this.state.selectionKeys = [];
                        this.state.selectionAnchor = null;
                        // Toggle focus: clicking the focused bubble again clears it.
                        this.state.focusKey = this.state.focusKey === message.key ? null : message.key;
                    }
                    this.render();
                }
                break;
            case 'clearFocus':
                if (this.state) {
                    this.state.focusKey = null;
                    this.state.selectionKeys = [];
                    this.state.selectionAnchor = null;
                    this.render();
                }
                break;
            case 'setViewMode':
                if (this.state && (message.mode === 'auto' || message.mode === 'table')) {
                    this.state.viewMode = message.mode;
                    // Switching presentation drops any pending focus (a table has
                    // no focused-bubble concept) and just re-renders the same data.
                    this.state.focusKey = null;
                    this.render();
                }
                break;
            case 'setBinSize':
                if (this.state && typeof message.column === 'string' && typeof message.size === 'string'
                    && this.state.binKeys[message.column]) {
                    // The binned chip's dial picked a new bucket size: re-bin that
                    // key and re-run the grouping (cloud re-blooms at the new factor).
                    this.state.binKeys[message.column] = message.size;
                    this.state.focusKey = null;
                    void this.runGrouping();
                }
                break;
            case 'toggleRecords':
                if (this.state) {
                    // The record lens for the current ungrouped bubble: flip it, and
                    // on opening fetch the top-N rows of the scope (lazy — no query
                    // runs until the user asks). Closing keeps nothing pending.
                    this.state.showRecords = !this.state.showRecords;
                    if (this.state.showRecords) {
                        void this.loadRecords();
                    } else {
                        this.render();
                    }
                }
                break;
            case 'drillDimension':
                if (this.state && typeof message.column === 'string') {
                    this.descend(message.column);
                }
                break;
            case 'descendBubble':
                if (this.state) {
                    // Drag gesture: stack the dragged bubble with no grouping yet.
                    // An explicit key (direct drag of a cloud bubble) takes
                    // precedence over the focused bubble.
                    this.descend(undefined, typeof message.key === 'string' ? message.key : undefined);
                }
                break;
            case 'popDrill':
                if (this.state && typeof message.index === 'string') {
                    this.popDrill(Number(message.index));
                }
                break;
            case 'reopenCloud':
                if (this.state && typeof message.index === 'string') {
                    this.reopenCloud(Number(message.index));
                }
                break;
            case 'focusLayer':
                if (this.state && typeof message.index === 'string') {
                    this.focusLayerCloud(Number(message.index));
                }
                break;
            case 'popToRoot':
                if (this.state) {
                    this.popToRoot();
                }
                break;
            case 'goBack':
                if (this.state && this.state.drillChain.length > 0) {
                    // "Put it back": the current working bubble is dragged up-left to
                    // rejoin the prior faded cloud. That's reopening the cloud the
                    // deepest bubble was picked from. Falls back to popToRoot if that
                    // crumb has no remembered grouping (shouldn't normally happen).
                    const last = this.state.drillChain.length - 1;
                    const crumb = this.state.drillChain[last];
                    if (crumb && crumb.fromDimensions.length > 0) {
                        this.reopenCloud(last);
                    } else {
                        this.popToRoot();
                    }
                }
                break;
            case 'clearGrouping':
                if (this.state) {
                    // Clicking the bubble that owns the open cloud undoes its
                    // dimension selection: the cloud collapses and the level falls
                    // back to a single ungrouped bubble.
                    this.state.selectedDimensions = [];
                    this.state.binKeys = {};
                    this.state.focusKey = null;
                    // The cloud is closing — recede its bubbles back into the hub.
                    this.pendingCollapse = true;
                    void this.runGrouping();
                }
                break;
            case 'groupDimension':
                if (this.state && typeof message.column === 'string' && message.column) {
                    // The bottom dimension facet flung a column down onto the drop
                    // zone. Plain fling REPLACES the grouping; Shift+fling ACCUMULATES
                    // (adds another grouping dimension), preserving combined grouping.
                    // A binnable column auto-bins; a dimension groups discretely.
                    void this.applyGroupKey(message.column, !!message.accumulate);
                }
                break;
            case 'removeDimension':
                if (this.state && typeof message.column === 'string') {
                    // Removing one chip from the active dimension set (the × on a
                    // dim chip). Collapses to ungrouped when the last one goes.
                    const i = this.state.selectedDimensions.indexOf(message.column);
                    if (i >= 0) { this.state.selectedDimensions.splice(i, 1); }
                    delete this.state.binKeys[message.column];
                    this.state.focusKey = null;
                    // If that was the last chip the cloud fully closes — recede its
                    // bubbles back into the hub (the inverse of the bloom). Removing
                    // one of several dims instead RE-AGGREGATES into a coarser cloud,
                    // so just bloom the recomputed set out of the hub (same as adding
                    // a dim) — any grouping change blooms, only the full close recedes.
                    if (this.state.selectedDimensions.length === 0) {
                        this.pendingCollapse = true;
                    } else {
                        this.pendingBloom = true;
                    }
                    void this.runGrouping();
                }
                break;
            default:
                break;
        }
    }

    // ─── Data loading ───────────────────────────────────────────────────

    /** Loads the total count and refines classification via cheap profiling. */
    private async loadOverview(): Promise<void> {
        if (!this.state) { return; }
        const token = ++this.renderToken;
        const { source, cluster, database } = this.state;

        try {
            const total = await this.runScalarCount(`${bracket(source)} | count`, cluster, database);
            if (token !== this.renderToken || !this.state) { return; }
            this.state.totalCount = total;

            const stats = await this.profile(this.state.columns, source, cluster, database, total);
            if (token !== this.renderToken || !this.state) { return; }
            if (stats) {
                this.state.columns = refineClassification(this.state.columns, stats);
            }
        } catch (err) {
            if (token === this.renderToken && this.state) {
                this.state.error = err instanceof Error ? err.message : String(err);
            }
        } finally {
            if (token === this.renderToken && this.state) {
                this.state.loading = false;
                this.render();
            }
        }
    }

    /** Toggles a column in/out of a selection list, then re-runs the grouping. */
    private toggleSelection(list: string[], column: string): void {
        if (!this.state) { return; }
        const idx = list.indexOf(column);
        if (idx >= 0) {
            list.splice(idx, 1);
        } else {
            list.push(column);
        }
        void this.runGrouping();
    }

    /**
     * Descends a level: locks the currently-focused bubble's grouping value(s)
     * into the drill chain and re-flowers by the newly-picked dimension within
     * that slice. With no current grouping (the single "All" bubble) it simply
     * starts grouping by the picked dimension — there's no value to lock.
     *
     * Called with no `newDim` (the drag gesture) it stacks the focused bubble but
     * picks NO grouping yet: the slice becomes a fresh "active" stacked bubble
     * (like the root started) whose own nubs choose the next grouping.
     */
    private descend(newDim?: string, explicitKey?: string): void {
        if (!this.state) { return; }
        const key = explicitKey ?? this.state.focusKey;
        if (key === null || key === undefined) { return; }
        const rowIdx = Number(key);
        const result = this.state.result;
        const row = result?.rows[rowIdx];
        const fromDimensions = [...this.state.selectedDimensions];

        // If the dragged bubble is part of an active multi-selection, lock the
        // WHOLE set as one crumb (a range for an ordered/binned axis, an `in (...)`
        // set for a discrete one). Otherwise it's the single dragged/focused bubble.
        const sel = this.state.selectionKeys;
        const isMulti = sel.length > 1 && sel.includes(key) && fromDimensions.length === 1;

        if (row && fromDimensions.length > 0) {
            const locks = fromDimensions.map(dim => {
                const colIdx = result!.columns.indexOf(dim);
                const lock: { dimension: string; value: unknown; binSize?: string; values?: unknown[] } = {
                    dimension: dim,
                    value: row[colIdx],
                };
                // A binned key locks as a RANGE (bucket start + size), not a point.
                if (this.state!.binKeys[dim]) { lock.binSize = this.state!.binKeys[dim]; }
                // Multi-select: capture every selected bubble's value for this dim.
                if (isMulti) {
                    lock.values = sel
                        .map(k => result!.rows[Number(k)])
                        .filter((r): r is unknown[] => !!r)
                        .map(r => r[colIdx]);
                }
                return lock;
            });
            const display = locks.map(l => this.lockDisplay(l)).join(' · ');
            this.state.drillChain.push({
                locks, fromDimensions,
                fromBinKeys: { ...this.state.binKeys },
                display,
                columns: [...result!.columns], row: [...row],
                // Snapshot the whole sibling cloud so this level can stay on screen
                // as a receded ghost layer (the depth stack) rather than vanishing.
                cloud: {
                    result: {
                        columns: [...result!.columns],
                        rows: result!.rows.map(r => [...r]),
                    },
                    selectedDimensions: [...this.state.selectedDimensions],
                    binKeys: { ...this.state.binKeys },
                    selectedMeasures: [...this.state.selectedMeasures],
                    selectedAggregate: this.state.selectedAggregate,
                },
            });
        }

        this.state.selectedDimensions = newDim ? [newDim] : [];
        this.state.binKeys = {};
        this.state.focusKey = null;
        this.state.selectionKeys = [];
        this.state.selectionAnchor = null;
        // Post-drop: the cloud we just left recedes into the depth stack — tell the
        // next render to play the "layers step back" transition.
        this.pendingTransition = 'drill';
        void this.runGrouping();
    }

    /** The compact label for a single lock: a binned range (start–end), a discrete
     *  set ("a, b +N"), or a single value. Used for the crumb body display. */
    private lockDisplay(l: { dimension: string; value: unknown; binSize?: string; values?: unknown[] }): string {
        const type = this.state?.columns.find(c => c.name === l.dimension)?.type;
        if (l.values && l.values.length > 1) {
            if (l.binSize) {
                // Ordered range: first bucket start – last bucket end. Datetime
                // ranges elide the end's shared leading components (don't repeat the
                // year/month when both ends share them).
                const { lo, hi } = orderedBounds(l.values, type);
                if (/datetime|date/.test((type ?? '').toLowerCase())) {
                    return binSpanRangeDatetime(lo, hi, l.binSize);
                }
                return `${binRangeLabel(lo, l.binSize, type)} – ${binRangeEndLabel(hi, l.binSize, type)}`;
            }
            // Discrete set: first few values, then "+N".
            const shown = l.values.slice(0, 2).map(v => formatCell(v));
            const extra = l.values.length - shown.length;
            return extra > 0 ? `${shown.join(', ')} +${extra}` : shown.join(', ');
        }
        // A single binned bucket shows its FULL RANGE (start – end), not just the
        // bucket start — so the locked bubble conveys the bin WIDTH on its face
        // instead of hiding it behind the hover title. (Matches the multi-select
        // range above.)
        return l.binSize
            ? binRangeFull(l.value, l.binSize, type)
            : formatCell(l.value);
    }

    /** Updates the shift multi-selection for a clicked bubble. For an ORDERED
     *  (single binned dimension) cloud the selection is the contiguous run between
     *  the anchor and the clicked bubble in bin order; for a DISCRETE cloud it
     *  toggles the clicked bubble in/out of an arbitrary set. Seeds from the
     *  current focus so plain-click-then-shift-click grows a selection naturally. */
    private selectBubble(key: string): void {
        if (!this.state) { return; }
        // Selection mode supersedes single-inspect: the anchor is whatever was
        // focused/anchored before, falling back to the clicked bubble.
        const anchor = this.state.selectionAnchor ?? this.state.focusKey ?? key;
        this.state.focusKey = null;

        const ordered = this.state.selectedDimensions.length === 1
            && !!this.state.binKeys[this.state.selectedDimensions[0]!];

        if (ordered) {
            // Contiguous run between anchor and key in the laid-out bin order.
            const order = this.orderedRowIndices(this.state).map(String);
            const ai = order.indexOf(anchor);
            const ki = order.indexOf(key);
            if (ai < 0 || ki < 0) { this.state.selectionKeys = [key]; }
            else {
                const [a, b] = ai <= ki ? [ai, ki] : [ki, ai];
                this.state.selectionKeys = order.slice(a, b + 1);
            }
        } else {
            // Discrete: toggle membership, seeding with the anchor.
            const set = this.state.selectionKeys.length
                ? [...this.state.selectionKeys]
                : (anchor !== key ? [anchor] : []);
            const idx = set.indexOf(key);
            if (idx >= 0) { set.splice(idx, 1); } else { set.push(key); }
            this.state.selectionKeys = set;
        }
        this.state.selectionAnchor = this.state.selectionKeys.length ? anchor : null;
    }

    /** Returns to the clicked level: keeps that bubble (and all above it) and drops
     *  everything below, restoring the grouping that was active when it was the
     *  current/bottom level. */
    private popDrill(index: number): void {
        if (!this.state) { return; }
        const crumb = this.state.drillChain[index];
        if (!crumb) { return; }
        // Returning to a previous level lands it ungrouped (cloud closed): the
        // dimension selection is cleared so you re-pick how to explore from there.
        // The record table also closes — it belonged to the deeper scope.
        this.state.drillChain = this.state.drillChain.slice(0, index + 1);
        this.state.selectedDimensions = [];
        this.state.binKeys = {};
        this.state.focusKey = null;
        this.closeRecords();
        void this.runGrouping();
    }

    /** Re-opens the cloud a locked bubble was picked FROM: drops that bubble (and
     *  everything below it) and restores the grouping that produced it, landing
     *  you back on the field of sibling bubbles you chose it from. This is the
     *  inverse of a descend — the connector label naming the locked dimension is
     *  the affordance for it. */
    private reopenCloud(index: number): void {
        if (!this.state) { return; }
        const crumb = this.state.drillChain[index];
        if (!crumb || crumb.fromDimensions.length === 0) { return; }
        const snap = crumb.cloud;
        this.state.drillChain = this.state.drillChain.slice(0, index);
        this.state.selectedDimensions = [...crumb.fromDimensions];
        this.state.binKeys = { ...crumb.fromBinKeys };
        this.state.focusKey = null;
        this.state.selectionKeys = [];
        this.state.selectionAnchor = null;
        this.closeRecords();
        if (snap) {
            // The ghost cloud is already LIVE — refreshGhostClouds keeps its rows in
            // sync with the current measure/aggregate, so it's the very same data the
            // live cloud would produce. Bringing it forward therefore just reuses it
            // directly: restore the result + grouping context and render. No clear,
            // no requery, no loading flash — it simply moves forward into place.
            this.state.selectedMeasures = [...snap.selectedMeasures];
            this.state.selectedAggregate = snap.selectedAggregate;
            this.state.result = {
                columns: [...snap.result.columns],
                rows: snap.result.rows.map(r => [...r]),
            };
            this.state.tooManyGroups = null;
            this.state.loading = false;
            this.state.error = undefined;
            // Post-drop: the prior cloud comes forward out of the depth stack — tell
            // the render to play the "layers step forward" transition.
            this.pendingTransition = 'back';
            this.render();
            return;
        }
        // Legacy crumb with no captured cloud (pre-snapshot): fall back to a requery.
        void this.runGrouping();
    }

    /** Path-strip navigation: focus the clicked layer `index`, keeping it and its
     *  ancestors locked while pruning everything deeper, and re-open ITS cloud —
     *  the field of child groupings this layer opened. That child cloud was
     *  snapshotted on the NEXT crumb (captured the moment we descended from this
     *  layer into it), so reopening at `index + 1` lands us back on `index` as the
     *  current hub with its children spread out. Clicking the deepest layer (which
     *  has no child crumb) is a no-op — you're already there. (This differs from
     *  reopenCloud, which steps to the layer a bubble was picked FROM; the path
     *  strip instead focuses the layer the user clicked.) */
    private focusLayerCloud(index: number): void {
        this.reopenCloud(index + 1);
    }

    /** Pops all the way back to the root, ungrouped (the dimension selection is
     *  cleared so the root falls back to a single bubble). */
    private popToRoot(): void {
        if (!this.state || this.state.drillChain.length === 0) { return; }
        this.state.selectedDimensions = [];
        this.state.binKeys = {};
        this.state.drillChain = [];
        this.state.focusKey = null;
        this.closeRecords();
        void this.runGrouping();
    }

    /** Closes the record lens, discarding any loaded rows. Used when navigating
     *  back to a prior bubble — the table belonged to the deeper scope. */
    private closeRecords(): void {
        if (!this.state) { return; }
        this.state.showRecords = false;
        this.state.records = null;
        this.state.recordsLoading = false;
    }

    /** Builds the ` | where ...` clause that scopes the cloud to the drill chain.
     *  With `limit` it only includes the first `limit` crumbs (used to recompute a
     *  single locked level's value). */
    private buildWhereClause(limit?: number): string {
        if (!this.state || this.state.drillChain.length === 0) { return ''; }
        const end = limit ?? this.state.drillChain.length;
        const predicates: string[] = [];
        for (let i = 0; i < end && i < this.state.drillChain.length; i++) {
            const crumb = this.state.drillChain[i];
            if (!crumb) { continue; }
            for (const lock of crumb.locks) {
                const col = bracket(lock.dimension);
                const type = this.state.columns.find(c => c.name === lock.dimension)?.type;
                // Multi-select lock: an ordered RANGE (binned) or a discrete SET.
                if (lock.values && lock.values.length > 1) {
                    if (lock.binSize) {
                        // The selected buckets are contiguous; scope from the first
                        // bucket's start to the last bucket's END (start + size).
                        const { lo, hi } = orderedBounds(lock.values, type);
                        const loLit = kustoLiteral(lo, type);
                        const hiLit = kustoLiteral(hi, type);
                        predicates.push(`${col} >= ${loLit} and ${col} < ${hiLit} + ${lock.binSize}`);
                    } else {
                        const lits = lock.values.map(v => kustoLiteral(v, type)).join(', ');
                        predicates.push(`${col} in (${lits})`);
                    }
                    continue;
                }
                if (lock.value === null || lock.value === undefined) {
                    predicates.push(`isnull(${col})`);
                } else {
                    const lo = kustoLiteral(lock.value, type);
                    if (lock.binSize) {
                        // A binned lock scopes to the whole bucket: [lo, lo + size).
                        // The size token (e.g. 1h / 100) adds directly to a datetime
                        // or number, so `col >= lo and col < lo + size`.
                        predicates.push(`${col} >= ${lo} and ${col} < ${lo} + ${lock.binSize}`);
                    } else {
                        predicates.push(`${col} == ${lo}`);
                    }
                }
            }
        }
        return predicates.length > 0 ? ` | where ${predicates.join(' and ')}` : '';
    }

    /** The summarize group expression for a selected key: a plain bracketed column
     *  for a discrete dimension, or `bin(col, size)` for a binned continuous key.
     *  bin() keeps the original column name, so result-column handling is unchanged. */
    private groupExpr(dim: string): string {
        const size = this.state?.binKeys[dim];
        return size ? `bin(${bracket(dim)}, ${size})` : bracket(dim);
    }

    /** Picks a group key from the wheel. A discrete dimension groups as-is; a
     *  binnable continuous column (time or numeric measure) gets an auto bin size
     *  probed from the data's range in the current scope, then groups via bin().
     *  Plain pick REPLACES the grouping; accumulate ADDS another key. */
    private async applyGroupKey(column: string, accumulate: boolean): Promise<void> {
        if (!this.state) { return; }
        const col = this.state.columns.find(c => c.name === column);
        const kind = col ? binKindForColumn(col) : null;

        if (kind) {
            // Probe min/max over the current drill scope to size the buckets.
            const size = await this.computeBinSize(column, kind);
            if (!this.state) { return; }
            this.state.binKeys[column] = size;
        } else {
            delete this.state.binKeys[column];
        }

        if (accumulate) {
            if (!this.state.selectedDimensions.includes(column)) {
                this.state.selectedDimensions.push(column);
            }
        } else {
            this.state.selectedDimensions = [column];
            // Replacing the grouping drops any bin sizes for keys no longer selected.
            for (const k of Object.keys(this.state.binKeys)) {
                if (k !== column) { delete this.state.binKeys[k]; }
            }
        }
        this.state.focusKey = null;
        // Picking a grouping makes a fresh child cloud appear — bloom it out of the
        // parent hub on the settled render.
        this.pendingBloom = true;
        void this.runGrouping();
    }

    /** Probes the data range of a binnable column in the current scope and snaps a
     *  bin size to a "nice" step targeting ~24-40 buckets. Time columns snap to a
     *  timespan ladder (1m…365d); numeric columns to a 1-2-5×10ⁿ ladder. Falls back
     *  to a sane default if the probe fails or the range is degenerate. */
    private async computeBinSize(column: string, kind: 'time' | 'numeric'): Promise<string> {
        const fallback = kind === 'time' ? '1h' : '1';
        if (!this.state) { return fallback; }
        const { source, cluster, database } = this.state;
        const where = this.buildWhereClause();
        const q = `${bracket(source)}${where} | summarize mn=min(${bracket(column)}), mx=max(${bracket(column)})`;
        try {
            const res = await this.server.runQuery(q, cluster, database, true, 1);
            const row = res?.data?.tables?.[0]?.rows?.[0];
            if (!row || row[0] === null || row[1] === null) { return fallback; }
            if (kind === 'time') {
                const lo = Date.parse(String(row[0]));
                const hi = Date.parse(String(row[1]));
                if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) { return fallback; }
                return pickTimeBin(hi - lo);
            }
            const lo = Number(row[0]);
            const hi = Number(row[1]);
            if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) { return fallback; }
            return pickNumericBin(hi - lo);
        } catch {
            return fallback;
        }
    }

    /** The result-column header for an aggregated measure, e.g. "Avg of price".
     *  Encodes the current aggregate so parseMeasureHeader can recover the glyph. */
    private measureHeader(column: string): string {
        return AGGREGATES[this.state!.selectedAggregate].prefix + column;
    }

    /** The summarize expression for an aggregated measure, e.g.
     *  `["Avg of price"]=avg([price])`, using the current aggregate function. */
    private measureExpr(column: string): string {
        const a = AGGREGATES[this.state!.selectedAggregate];
        return `${bracket(a.prefix + column)}=${a.func}(${bracket(column)})`;
    }

    /**
     * Recomputes each locked bubble's snapshot value with the CURRENT measures, so
     * the displayed value on every related bubble (locked + active) reflects the
     * selected measure — selecting/clearing a measure adjusts them all, not just
     * the live cloud. Each crumb is the aggregate of its locked slice.
     */
    private async refreshSnapshots(token: number): Promise<void> {
        if (!this.state) { return; }
        const measures = [...this.state.selectedMeasures];
        const { source, cluster, database } = this.state;
        const aggs = [`${bracket('Count')}=count()`,
            ...measures.map(m => this.measureExpr(m))];

        // The root bubble (whole table) shows the same aggregate of the primary
        // measure too, so selecting a measure updates the top bubble like all the others.
        const primary = measures[0];
        const rootPromise = primary
            ? (async () => {
                const query = `${bracket(source)} | summarize ${this.measureExpr(primary)}`;
                try {
                    const result = await this.server.runQuery(query, cluster, database, true, 1);
                    if (token !== this.renderToken || !this.state) { return; }
                    const cell = result?.data?.tables?.[0]?.rows?.[0]?.[0];
                    const n = typeof cell === 'number' ? cell : Number(cell);
                    this.state.totalMeasure = Number.isFinite(n) ? n : null;
                } catch { /* keep previous */ }
            })()
            : Promise.resolve((() => { if (this.state) { this.state.totalMeasure = null; } })());

        const crumbPromises = this.state.drillChain.map(async (crumb, i) => {
            const where = this.buildWhereClause(i + 1);
            // Group by the SAME expression that produced this bucket: a binned key
            // must re-bin (bin(col,size)) so the scoped slice collapses to its one
            // bucket. Plain bracket() here would re-split a binned range into every
            // raw value and snapshot only the first — the wrong (tiny) aggregate.
            // A MULTI-SELECT crumb (range / set) spans MANY buckets, so we omit the
            // `by` entirely: the where clause already scopes to the whole selection,
            // and we want its combined aggregate as the single locked-bubble value.
            const isMultiCrumb = crumb.locks.some(l => l.values && l.values.length > 1);
            const by = (!isMultiCrumb && crumb.fromDimensions.length > 0)
                ? ` by ${crumb.fromDimensions.map(d => {
                    const size = crumb.fromBinKeys[d];
                    return size ? `bin(${bracket(d)}, ${size})` : bracket(d);
                }).join(', ')}` : '';
            const query = `${bracket(source)}${where} | summarize ${aggs.join(', ')}${by}`;
            try {
                const result = await this.server.runQuery(query, cluster, database, true, 1);
                if (token !== this.renderToken || !this.state) { return; }
                const table = result?.data?.tables?.[0];
                if (table && table.rows[0]) {
                    crumb.columns = table.columns.map(c => c.name);
                    crumb.row = table.rows[0];
                }
            } catch {
                /* keep the previous snapshot if the refresh query fails */
            }
        });
        await Promise.all([rootPromise, ...crumbPromises, this.refreshGhostClouds(token)]);
    }

    /**
     * Re-queries each past level's FULL sibling cloud under the CURRENT measure and
     * aggregate, so the receded ghost layers stay live (they update when you change
     * the measure/aggregate, exactly like the live cloud and the locked bubbles do
     * — they're the same rendering, just pushed back into depth). Mirrors the cloud
     * query runGrouping builds: scope to that level's ancestors, group by the keys
     * the level was opened with, order by the active metric. Runs in parallel with
     * the snapshot refresh. A failed level keeps its previous snapshot.
     */
    private async refreshGhostClouds(token: number): Promise<void> {
        if (!this.state) { return; }
        const { source, cluster, database } = this.state;
        const measures = [...this.state.selectedMeasures];
        const aggExprs = [`${bracket('Count')}=count()`, ...measures.map(m => this.measureExpr(m))];
        const metricCol = measures.length > 0
            ? bracket(this.measureHeader(measures[0]!)) : bracket('Count');
        const tasks = this.state.drillChain.map(async (crumb, i) => {
            if (!crumb.cloud || crumb.fromDimensions.length === 0) { return; }
            const where = this.buildWhereClause(i); // scope to ancestors (locks 0..i-1)
            const byExprs = crumb.fromDimensions.map(d => {
                const size = crumb.fromBinKeys[d];
                return size ? `bin(${bracket(d)}, ${size})` : bracket(d);
            });
            const binnedAxis = crumb.fromDimensions.length === 1
                && !!crumb.fromBinKeys[crumb.fromDimensions[0]!];
            const order = binnedAxis
                ? ` | top ${MAX_GROUP_ROWS} by ${metricCol} desc | order by ${byExprs[0]} asc`
                : ` | top ${MAX_GROUP_ROWS} by ${metricCol} desc`;
            const query = `${bracket(source)}${where} | summarize ${aggExprs.join(', ')} by ${byExprs.join(', ')}${order}`;
            try {
                const result = await this.server.runQuery(query, cluster, database, true, MAX_GROUP_ROWS);
                if (token !== this.renderToken || !this.state) { return; }
                const table = result?.data?.tables?.[0];
                if (table && crumb.cloud) {
                    crumb.cloud.result = { columns: table.columns.map(c => c.name), rows: table.rows };
                    crumb.cloud.selectedMeasures = measures;
                    crumb.cloud.selectedAggregate = this.state.selectedAggregate;
                }
            } catch { /* keep the previous cloud snapshot on failure */ }
        });
        await Promise.all(tasks);
    }

    /**
     * Runs the current summarize given the selected dimensions and measures and
     * renders the flowering of bubbles. When a measure is selected it becomes
     * the PRIMARY metric (sizes the bubbles and shows the big number) and Count
     * is demoted to a secondary line; otherwise Count is primary. Each measure
     * adds a sum() column — the sum/avg/min/max picker is a later disclosure
     * layer that will switch a measure's function.
     */
    private async runGrouping(): Promise<void> {
        if (!this.state) { return; }

        const token = ++this.renderToken;
        const dims = [...this.state.selectedDimensions];
        const measures = [...this.state.selectedMeasures];
        const { source, cluster, database } = this.state;

        // A new cloud is being computed; any focus on the old one is stale.
        this.state.focusKey = null;
        // Likewise any shift-selection belonged to the OLD cloud's row indices —
        // carrying it over would pre-select an unrelated bubble in the new field.
        this.state.selectionKeys = [];
        this.state.selectionAnchor = null;
        // The record lens follows the same rule as the cloud: if only the measure
        // or ordering changed (we're still UNGROUPED — dims empty), keep it showing
        // and requery, dimming it while the new rows land. It's only stale when the
        // SCOPE changes (a grouping appears), which hides it anyway.
        const keepRecords = this.state.showRecords && dims.length === 0;
        if (keepRecords) {
            this.state.recordsLoading = true;
        } else {
            this.state.showRecords = false;
            this.state.records = null;
            this.state.recordsLoading = false;
        }

        if (dims.length === 0 && measures.length === 0) {
            this.state.result = null;
            // Snapshots may still need to drop a previously-shown measure.
            await this.refreshSnapshots(token);
            if (token !== this.renderToken || !this.state) { return; }
            this.state.loading = false;
            this.render();
            if (keepRecords) { void this.loadRecords(); }
            return;
        }

        this.state.loading = true;
        this.state.error = undefined;
        this.state.tooManyGroups = null;
        // A fresh grouping is incoming and will BLOOM out of the hub. The old result
        // (e.g. the single ungrouped "All" aggregate, or a different-shaped prior
        // cloud) is not representative of the new field, so drop it now — otherwise
        // the loading render flashes that stale bubble in the value area just before
        // the bloom, undercutting the animation. With it cleared, the loading render
        // shows the bare "Querying…" hint and the cloud blooms in from nothing.
        // (Measure/order/bin-size requeries don't set pendingBloom, so they keep the
        // result and dim it in place via is-refreshing — no flash there.)
        if (this.pendingBloom) { this.state.result = null; }
        this.render();

        // Drill chain → a `where` that scopes the cloud to the locked-in ancestor
        // bubble values, so each descend narrows to one slice (bounded) rather
        // than exploding the grouping (a cartesian product of dimensions).
        const whereClause = this.buildWhereClause();

        // CARDINALITY GUARD: before pulling the cloud, cheaply estimate how many
        // distinct groups the dimension(s) produce in this scope. A high-cardinality
        // dimension (e.g. an id) can't be shown as a readable field — neither as a
        // cloud nor as an equivalent table — so we refuse to query it and surface a
        // guidance card instead of silently truncating. dcount is an HLL estimate,
        // so it stays cheap even for pathological columns.
        if (dims.length > 0) {
            const dcountExpr = dims.length === 1
                ? `dcount(${this.groupExpr(dims[0]!)})`
                : `dcount(strcat(${dims.map(d => `tostring(${this.groupExpr(d)})`).join(`, " ~|~ ", `)}))`;
            const cardQuery = `${bracket(source)}${whereClause} | summarize Groups = ${dcountExpr}`;
            let groupCount: number | null = null;
            try {
                groupCount = await this.runScalarCount(cardQuery, cluster, database);
            } catch { /* fall through and let the grouping query surface any error */ }
            if (token !== this.renderToken || !this.state) { return; }
            if (groupCount !== null && groupCount > MAX_GROUP_ROWS) {
                this.state.tooManyGroups = groupCount;
                this.state.result = null;
                this.state.focusKey = null;
                await this.refreshSnapshots(token);
                if (token !== this.renderToken || !this.state) { return; }
                this.state.loading = false;
                this.render();
                return;
            }
        }

        const aggs = [`${bracket('Count')}=count()`,
            ...measures.map(m => this.measureExpr(m))];
        const byClause = dims.length > 0 ? ` by ${dims.map(d => this.groupExpr(d)).join(', ')}` : '';
        // Fetch up to the ceiling, ordered by the metric so any boundary truncation
        // keeps the most significant groups. The VIEW (cloud tier or table) is
        // chosen from the actual row count in valueAreaHtml; cloud tiers re-sort by
        // identity client-side so a bubble keeps its place when only the measure
        // changes. With no dimension it's a single bubble.
        const metricCol = measures.length > 0
            ? bracket(this.measureHeader(measures[0]!)) : bracket('Count');
        // A single binned key reads as an axis: order by the bucket (chronological /
        // ascending) so the cloud lays out as a continuous strip, not by magnitude.
        const binnedAxis = dims.length === 1 && this.state.binKeys[dims[0]!];
        const orderClause = dims.length > 0
            ? (binnedAxis
                ? ` | top ${MAX_GROUP_ROWS} by ${metricCol} desc | order by ${this.groupExpr(dims[0]!)} asc`
                : ` | top ${MAX_GROUP_ROWS} by ${metricCol} desc`)
            : ` | order by ${metricCol} desc`;
        const query = `${bracket(source)}${whereClause} | summarize ${aggs.join(', ')}${byClause}${orderClause}`;

        try {
            const result = await this.server.runQuery(
                query, cluster, database, true, MAX_GROUP_ROWS,
            );
            if (token !== this.renderToken || !this.state) { return; }
            const table = result?.data?.tables?.[0];
            if (result?.error) {
                this.state.error = result.error.message;
                this.state.result = null;
            } else if (table) {
                this.state.result = {
                    columns: table.columns.map(c => c.name),
                    rows: table.rows,
                };
            }
            // Keep the locked/active bubble values in sync with the current measure.
            await this.refreshSnapshots(token);
        } catch (err) {
            if (token === this.renderToken && this.state) {
                this.state.error = err instanceof Error ? err.message : String(err);
                this.state.result = null;
            }
        } finally {
            if (token === this.renderToken && this.state) {
                this.state.loading = false;
                this.render();
                // The record lens (if kept open across a measure/order change)
                // requeries after the bubble value settles, staying visible and
                // just dimming until the reordered rows land.
                if (keepRecords) { void this.loadRecords(); }
            }
        }
    }

    private async runScalarCount(query: string, cluster: string, database: string): Promise<number | null> {
        const result = await this.server.runQuery(
            query, cluster, database, true, 1,
        );
        const cell = result?.data?.tables?.[0]?.rows?.[0]?.[0];
        const n = typeof cell === 'number' ? cell : Number(cell);
        return Number.isFinite(n) ? n : null;
    }

    /**
     * Fetches the record lens for the current ungrouped bubble: a bounded, ordered
     * sample of the actual rows in the bubble's scope (the drill-chain `where`).
     * Column selection follows the design rule — locked drill-chain dimensions are
     * CONSTANT across the scope, so they're dropped from the projection (lifted to
     * a scope header instead); dynamic/blob columns are suppressed. Ordering is by
     * the selected measure (desc), falling back to the time column (newest first),
     * else an arbitrary take. The full scope count is fetched too so the sample can
     * be labeled "N of <total>".
     */
    private async loadRecords(): Promise<void> {
        if (!this.state) { return; }
        const token = ++this.renderToken;
        const { source, cluster, database } = this.state;
        this.state.recordsLoading = true;
        // Keep any existing rows on screen and just dim them (is-refreshing) while
        // the new sample lands — same no-flash behavior as the cloud. The "Loading
        // rows…" message only appears on the FIRST open (records still null).
        this.render();

        const whereClause = this.buildWhereClause();

        // Columns locked to a single value by the drill chain are constant here, so
        // drop them from the projection (they're shown in the scope header). Dynamic
        // (JSON/blob) columns aren't scannable in a grid, so suppress them too.
        const lockedDims = new Set<string>();
        for (const crumb of this.state.drillChain) {
            for (const lock of crumb.locks) { lockedDims.add(lock.dimension); }
        }
        const projectCols = this.state.columns
            .filter(c => !lockedDims.has(c.name) && c.type !== 'dynamic' && c.role !== 'other')
            .map(c => c.name);

        // Order by the selected measure (what makes a row "interesting"), else the
        // time column (newest first — the log-explorer default), else just take N.
        const measure = this.state.selectedMeasures[0];
        const timeCol = this.state.columns.find(c => c.role === 'time');
        const orderClause = measure
            ? ` | top ${RECORD_LIMIT} by ${bracket(measure)} desc`
            : (timeCol ? ` | top ${RECORD_LIMIT} by ${bracket(timeCol.name)} desc` : ` | take ${RECORD_LIMIT}`);
        const projectClause = projectCols.length > 0
            ? ` | project ${projectCols.map(bracket).join(', ')}` : '';
        const query = `${bracket(source)}${whereClause}${orderClause}${projectClause}`;

        try {
            const result = await this.server.runQuery(query, cluster, database, true, RECORD_LIMIT);
            if (token !== this.renderToken || !this.state) { return; }
            if (result?.error) {
                this.state.error = result.error.message;
            } else {
                const table = result?.data?.tables?.[0];
                const total = await this.runScalarCount(`${bracket(source)}${whereClause} | count`, cluster, database);
                if (token !== this.renderToken || !this.state) { return; }
                this.state.records = table
                    ? { columns: table.columns.map(c => c.name), rows: table.rows, total }
                    : { columns: [], rows: [], total };
            }
        } catch (err) {
            if (token === this.renderToken && this.state) {
                this.state.error = err instanceof Error ? err.message : String(err);
            }
        } finally {
            if (token === this.renderToken && this.state) {
                this.state.recordsLoading = false;
                this.render();
            }
        }
    }

    /**
     * Issues ONE cheap profiling query computing dcount per candidate column,
     * then maps results back to refine classification. Skips dynamic/other and
     * time columns to avoid dcount errors and unnecessary work.
     */
    private async profile(
        columns: ClassifiedColumn[],
        source: string,
        cluster: string,
        database: string,
        totalCount: number | null,
    ): Promise<ProfileStats | null> {
        const candidates = columns.filter(c => c.role === 'dimension' || c.role === 'measure' || c.role === 'id');
        if (candidates.length === 0) { return null; }

        const aggs = candidates.map((c, i) => `${bracket('dc_' + i)}=dcount(${bracket(c.name)})`);
        const query = `${bracket(source)} | summarize ${aggs.join(', ')}`;

        const result = await this.server.runQuery(
            query, cluster, database, true, 1,
        );
        const table = result?.data?.tables?.[0];
        if (result?.error || !table?.rows?.[0]) { return null; }

        const row = table.rows[0];
        const dcounts: Record<string, number> = {};
        candidates.forEach((c, i) => {
            const idx = table.columns.findIndex(tc => tc.name === `dc_${i}`);
            const value = idx >= 0 ? row[idx] : undefined;
            const n = typeof value === 'number' ? value : Number(value);
            if (Number.isFinite(n)) { dcounts[c.name] = n; }
        });

        return { totalCount: totalCount ?? 0, dcounts };
    }

    // ─── Rendering ──────────────────────────────────────────────────────

    private render(): void {
        if (!this.panel || !this.ready || !this.state) { return; }
        // The depth-stack transition plays on the SETTLED (non-loading) render only.
        // A drill is loading-render → query → settled-render; playing on the loading
        // render lets the settled DOM swap interrupt it mid-flight (the chunky/jittery
        // recede). So while loading we KEEP the flag — ghostLayersHtml parks the
        // ghosts at their FROM position — and only the settled render emits the
        // transition and animates once. A put-back is a single settled render.
        const settled = !this.state.loading;
        const transition = settled ? this.pendingTransition : null;
        // Bloom (grouped-cloud entrance) plays on the SETTLED render too — the cloud
        // bubbles only exist once the query lands. Keep the flag across the loading
        // render, emit + clear on the settled one.
        const bloom = settled ? this.pendingBloom : false;
        // Collapse (cloud closing) plays on the FIRST render after the chip is
        // removed — the LOADING one — because that's when the old cloud is still in
        // the client DOM to be snapshotted before it's swapped away. Consume it on
        // whichever render comes next (loading or, if there's none, settled).
        const collapse = this.pendingCollapse;
        const html = this.bodyHtml(this.state);
        if (settled) { this.pendingTransition = null; this.pendingBloom = false; }
        this.pendingCollapse = false;
        this.panel.webview.postMessage({ command: 'render', html, transition, bloom, collapse });
    }

    private bodyHtml(state: ExploreState): string {
        return this.collapsedHtml(state);
    }

    private collapsedHtml(state: ExploreState): string {
        // Count uses the SAME compact format as every other bubble (locked, active,
        // cloud) — they're all the same 120px size, so the root must not show a
        // long localized number where the others show "1.2M".
        const count = state.loading && state.totalCount === null
            ? '…'
            : state.totalCount === null ? '—' : formatCompact(state.totalCount);


        // Single measure shown: the selected numeric column (whole-table sum) or,
        // with none, the row count shown as "# rows". The body is the same three
        // lines as every other bubble.
        const hasMeasure = state.selectedMeasures.length > 0;
        const measureName = hasMeasure ? state.selectedMeasures[0]! : 'rows';
        const aggGlyph = hasMeasure ? AGGREGATES[state.selectedAggregate].glyph : '#';
        const rootValue = hasMeasure
            ? (state.totalMeasure === null ? '…' : formatMeasureValue(state.totalMeasure))
            : count;

        const drilled = state.drillChain.length > 0;
        // The cloud (and its drop zone) only makes sense once a DIMENSION groups
        // the data into bubbles. With only a measure selected there's a single
        // "All" group that just duplicates the root bubble, so suppress it.
        const hasGroups = state.selectedDimensions.length > 0;
        // When drilled, the root bubble is a "previous" bubble: clicking it unlocks
        // the whole chain and returns to the root level (ungrouped). When not
        // drilled but a dimension groups the data, clicking it clears that grouping
        // (collapses the cloud back to the single source bubble).
        const rootAction = drilled
            ? ` data-action="popToRoot"`
            : (hasGroups ? ` data-action="clearGrouping"` : '');
        const rootClickable = drilled || hasGroups;
        const rootBubbleClass = rootClickable ? 'bubble bubble-root clickable' : 'bubble bubble-root';
        const rootTitle = drilled
            ? 'Back to ' + state.source
            : state.source;
        // The root carries the measure dial only while it owns the measure choice
        // (i.e. before drilling — once drilled, the deepest bubble owns it).
        const rootDial = drilled ? '' : this.dialAttrs(state, hasMeasure ? measureName : null);
        const rootAggDial = drilled ? '' : this.aggDialAttrs(state);
        // The dimension facet (scrub + fling-to-group) and the active-dimension
        // chips live on the root only while it owns the grouping (before drilling).
        const rootFacet = drilled ? '' : this.dimFacetHtml(state);
        const rootChips = drilled ? '' : this.dimChipsHtml(state);
        // The record-lens toggle lives inside the root bubble (beside the facet)
        // only while the root is the ungrouped bubble you're looking at — i.e. not
        // drilled (a deeper bubble owns it then) and not grouped (the cloud owns
        // the "below" slot then).
        const rootRecords = (!drilled && !hasGroups) ? this.recordsToggleHtml(state) : '';
        const rootBubbleExtra = `${rootFacet ? ' has-facet' : ''}${rootRecords ? ' has-records' : ''}`;
        const rootHub = `
                <div class="bubble-hub">
                    <div class="${rootBubbleClass}${rootBubbleExtra}"${rootAction}
                        title="${escapeAttr(rootTitle)}">
                        ${bubbleBody(state.source, rootValue, aggGlyph, measureName, rootDial, rootAggDial)}
                        ${rootFacet}
                        ${rootRecords}
                    </div>
                    ${rootChips}
                </div>`;
        // The drop zone is rendered whenever there are cloud bubbles to drag (a
        // dimension grouping exists), not only when one is focused — CSS keeps it
        // hidden until a drag is in flight. This lets you press-and-drag a bubble
        // directly without a focus click first.
        // Two-plane layout (Stage 0 of the depth redesign):
        //  • SCENE plane — the clouds/spine/value-area. This is the single unit that
        //    will later translate/scale/recede into depth as you drill. Wrapping it
        //    now (even though it doesn't move yet) gives every later stage one
        //    transform handle (.scene) and one perspective room (.scene-plane).
        //  • GLASS plane — fixed to the viewport, OUTSIDE the scene so a transform on
        //    .scene never drags it along. Empty for now; Stage 1 lands the bottom
        //    path strip (and eventually the forward controls) here. Kept as a sibling
        //    of the scene, not a child, precisely so it stays put while the scene moves.
        return `
            <div class="scene-plane">
                <div class="scene${drilled ? ' drilled' : ''}">
                    ${this.ghostLayersHtml(state)}
                    <div class="card"${this.cardFromAttr(state)}>
                        ${this.drillSpineHtml(state, rootHub)}
                        ${hasGroups && !isActiveStacked(state) ? `<div class="value-area">${this.valueAreaHtml(state)}</div>` : ''}
                        ${!hasGroups ? this.recordsPanelHtml(state) : ''}
                        ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
                    </div>
                </div>
            </div>
            <div class="glass-plane">${this.pathStripHtml(state)}</div>`;
    }

    /**
     * Attributes that turn a bubble surface into the measure dial: the ordered
     * option list (["rows", ...numeric columns]) and the current selection.
     * Returns '' when the table has no numeric measure columns (nothing to dial).
     */
    private dialAttrs(state: ExploreState, current: string | null): string {
        const cols = selectMeasureNubs(state.columns, MAX_MEASURE_NUBS).map(c => c.name);
        if (cols.length === 0) { return ''; }
        const options = ['rows', ...cols];
        return ` data-dial="${escapeAttr(JSON.stringify(options))}" data-dial-current="${escapeAttr(current ?? 'rows')}" data-dial-kind="measure"`;
    }

    /**
     * Attributes that turn the caption GLYPH into the aggregate dial: the ordered
     * aggregate labels (Sum/Avg/Min/Max) and the current one. Returns '' unless a
     * column measure is selected — "# rows" can only be counted, so there's no
     * aggregate to scrub.
     */
    private aggDialAttrs(state: ExploreState): string {
        if (state.selectedMeasures.length === 0) { return ''; }
        const options = AGG_ORDER.map(k => AGGREGATES[k].label);
        const current = AGGREGATES[state.selectedAggregate].label;
        return ` data-dial="${escapeAttr(JSON.stringify(options))}" data-dial-current="${escapeAttr(current)}" data-dial-kind="aggregate"`;
    }

    /**
     * Candidate dimensions the bottom facet can scrub through: all eligible
     * dimension columns (option A — the full inventory, no nub cap) minus any
     * already locked up the drill chain and any already in the active grouping.
     */
    private candidateDims(state: ExploreState): string[] {
        const used = new Set<string>();
        for (const crumb of state.drillChain) {
            for (const lock of crumb.locks) { used.add(lock.dimension); }
        }
        return selectDimensionNubs(state.columns, state.columns.length)
            .map(c => c.name)
            .filter(n => !used.has(n) && !state.selectedDimensions.includes(n));
    }

    /**
     * The in-circle dimension facet, anchored at the bottom interior of a hub
     * bubble. Click it to open a vertical wheel of candidate fields; scroll to
     * choose. When a grouping is already active its current field stays in the
     * list (and the wheel opens on it) so it can be changed in place. Returns ''
     * when there's nothing left to group by.
     */
    private dimFacetHtml(state: ExploreState): string {
        const used = new Set<string>();
        for (const crumb of state.drillChain) {
            for (const lock of crumb.locks) { used.add(lock.dimension); }
        }
        const selected = state.selectedDimensions;
        const current = selected.length > 0 ? selected[selected.length - 1] : null;
        // The wheel offers BOTH discrete dimensions and binnable continuous columns
        // (time + numeric measures). The tool decides what to DO on pick from the
        // column's known role: a dimension groups discretely; a binnable column
        // auto-bins (see applyGroupKey). Binnable names are passed separately so the
        // client can mark them in the wheel.
        const binnable = selectBinnableColumns(state.columns)
            .map(c => c.name)
            .filter(n => !used.has(n));
        const binnableSet = new Set(binnable);
        const discrete = selectDimensionNubs(state.columns, state.columns.length)
            .map(c => c.name)
            .filter(n => !used.has(n) && !binnableSet.has(n));
        const allDims = [...discrete, ...binnable];
        // Two lists drive the wheel depending on intent at open time:
        //  • REPLACEMENT (no Shift): every available field — the current one stays
        //    in so it can be changed in place; the pick replaces the whole grouping.
        //  • ACCUMULATE (Shift held): only fields NOT already in use, since those
        //    are the only ones that add a new breakdown to the combined grouping.
        const selectedSet = new Set(selected);
        const replaceOptions = allDims;
        const accumulateOptions = allDims.filter(n => !selectedSet.has(n));
        if (replaceOptions.length === 0) { return ''; }
        const accumulating = selected.length > 0;
        const tip = 'Break down';
        // A 2x2 cluster of tiny heat-tinted dots — a glyph for the bubble cloud
        // this control blooms (cold→hot across the grid).
        const dots = `<svg class="dim-facet-mark" viewBox="0 0 16 16" aria-hidden="true">`
            + `<circle cx="5.4" cy="5.4" r="2.5" fill="hsl(212,70%,55%)"/>`
            + `<circle cx="10.6" cy="5.4" r="2.5" fill="hsl(150,62%,48%)"/>`
            + `<circle cx="5.4" cy="10.6" r="2.5" fill="hsl(40,85%,55%)"/>`
            + `<circle cx="10.6" cy="10.6" r="2.5" fill="hsl(2,72%,55%)"/></svg>`;
        return `<div class="dim-facet${accumulating ? ' is-accumulating' : ''}"`
            + ` data-dimfacet="${escapeAttr(JSON.stringify(replaceOptions))}"`
            + ` data-dimfacet-accumulate="${escapeAttr(JSON.stringify(accumulateOptions))}"`
            + ` data-dimfacet-bins="${escapeAttr(JSON.stringify(binnable))}"`
            + (current ? ` data-dimfacet-current="${escapeAttr(current)}"` : '')
            + ` title="${escapeAttr(tip)}">`
            + `${dots}</div>`;
    }

    /**
     * The active grouping shown as a row of removable chips just below the hub
     * bubble (in the bloom-reserve space). Each chip's × removes that dimension,
     * so accumulated (combined) groupings can be pruned one at a time.
     */
    private dimChipsHtml(state: ExploreState): string {
        if (state.selectedDimensions.length === 0) { return ''; }
        const chips = state.selectedDimensions.map(d => {
            const size = state.binKeys[d];
            // A binned key shows a ruler glyph + its bucket size so it reads as a
            // continuous axis, not a discrete dimension.
            const label = size ? `${truncateLabel(d, 12)} \u00b7 ${size}` : truncateLabel(d, 14);
            const cls = size ? 'dim-chip is-bin' : 'dim-chip';
            // For a binned chip the label doubles as a bin-size dial: click it to
            // bring up the same scroll-wheel the measure/aggregate dials use, scrub
            // to a different bucket size, and the cloud re-bins. Options are the
            // type's bin ladder (timespans for time, a 1-2-5 ladder for numbers).
            let labelAttrs = '';
            let labelTip = '';
            if (size) {
                const type = state.columns.find(c => c.name === d)?.type;
                const options = binSizeOptions(type, size);
                labelAttrs = ` data-dial="${escapeAttr(JSON.stringify(options))}"`
                    + ` data-dial-current="${escapeAttr(size)}" data-dial-kind="bin"`
                    + ` data-dial-col="${escapeAttr(d)}"`;
                labelTip = ` title="${escapeAttr(`${d} — binned by ${size} (click to change)`)}"`;
            }
            const tip = size ? '' : ` title="${escapeAttr(d)}"`;
            return `<span class="${cls}"${tip}>`
                + `<span class="dim-chip-label${size ? ' is-dial' : ''}"${labelAttrs}${labelTip}>${escapeHtml(label)}</span>`
                + `<button class="dim-chip-x" data-action="removeDimension" data-col="${escapeAttr(d)}"`
                + ` title="Remove ${escapeAttr(d)}">\u00d7</button></span>`;
        }).join('');
        return `<div class="dim-chips">${chips}</div>`;
    }

    /**
     * The drill spine: each locked ancestor bubble rendered as a real bubble in
     * a vertical, centered column (with connector lines), so the path you drilled
     * stays visible. Clicking a locked bubble pops back to that level. The caller
     * supplies the root hub html as the first node (collapsed view); the expanded
     * view passes none and just shows the locked bubbles.
     */
    private drillSpineHtml(state: ExploreState, rootHub?: string): string {
        const chain = state.drillChain;
        // Not drilled: the live hub is the root (ungrouped or grouping the source).
        if (chain.length === 0) {
            return rootHub ? `<div class="drill-spine"><div class="spine-node">${rootHub}</div></div>` : '';
        }
        // Drilled: only the CURRENT (deepest) hub stays live and forward. The
        // ancestors — including the root — now recede with their clouds as ghost
        // layers (ghostLayersHtml), and the full provenance lives on the bottom
        // path strip, so the vertical spine of locked bubbles + connector lines is
        // gone. We render just the one hub you're working on.
        const i = chain.length - 1;
        const crumb = chain[i]!;
        const node = isActiveStacked(state)
            ? this.activeBubbleHtml(state, crumb)
            : this.lockedBubbleHtml(state, crumb, i, true);
        return `<div class="drill-spine"><div class="spine-node">${node}</div></div>`;
    }

    /**
     * The fixed bottom "path strip" (glass plane): the full chain of drill choices,
     * one segment per locked level — the dimension column drilled and the value (or
     * range/set) chosen — oldest at the left, newest at the right, after the source
     * origin. Each segment re-opens that level's sibling cloud (reopenCloud), so the
     * strip is both the always-legible record of the query AND the portal back to any
     * decision point. It lives on the glass plane and never recedes with the scene.
     * Returns '' until at least one level is locked.
     */
    private pathStripHtml(state: ExploreState): string {
        if (state.drillChain.length === 0) { return ''; }
        const steps = state.drillChain.map((crumb, i) => {
            const dim = crumb.fromDimensions.join(' · ');
            const full = this.crumbFullDisplay(crumb);
            const tip = dim ? `${dim} = ${full} — reopen these groups` : full;
            const dimSpan = dim ? `<span class="path-step-dim">${escapeHtml(dim)}</span>` : '';
            return `<button class="path-step" data-action="focusLayer" data-index="${i}"`
                + ` title="${escapeAttr(tip)}">${dimSpan}`
                + `<span class="path-step-val">${escapeHtml(crumb.display)}</span></button>`;
        }).join('<span class="path-sep">›</span>');
        const origin = `<button class="path-origin" data-action="popToRoot"`
            + ` title="${escapeAttr('Back to ' + state.source)}">${escapeHtml(state.source)}</button>`;
        return `<div class="path-strip" data-path-strip="1">${origin}`
            + `<span class="path-sep">›</span>${steps}</div>`;
    }

    /** The label shown on the connector leading into a bubble: the dimension
     *  column name(s) that were locked in to reach that bubble. It doubles as a
     *  "back to that cloud" button — clicking it drops this bubble and re-opens the
     *  field of siblings it was picked from (reopenCloud). */
    private linkLabelHtml(crumb: DrillCrumb, index: number): string {
        // Stage 1 of the depth redesign: the per-step choice (column + value) and
        // its "reopen these groups" action now live on the fixed bottom path strip
        // (pathStripHtml), not on the inter-bubble connector. The connector is left
        // as a bare line — relatedness will be carried by depth in a later stage.
        void crumb; void index;
        return '';
    }

    /**
     * The deepest stacked bubble after a drag gesture: rendered as a collapsed hub
     * (like the root) whose bottom dimension facet picks the next grouping
     * (groupDimension, not a further descent — this bubble is already locked). It
     * is the bottom of the stack — the level you're currently on — so clicking its
     * body does nothing. Already-locked dimensions are excluded from the facet. Its
     * incoming connector (with the "back to that cloud" label) is drawn by the spine
     * like every other node.
     */
    /** The cloud layout order (row indices into `state.result.rows`): binned/
     *  continuous dimensions sort by bucket value (numeric/chronological), discrete
     *  dimensions sort alphabetically. Shared by the cloud render and the shift-
     *  select contiguous-run math so "between" always matches what's on screen. */
    private orderedRowIndices(state: ExploreState): number[] {
        const result = state.result;
        if (!result) { return []; }
        const dimIdxs = result.columns
            .map((name, i) => ({ name, i }))
            .filter(c => c.name !== 'Count' && !isMeasureHeader(c.name))
            .map(c => c.i);
        const order = result.rows.map((_r, i) => i);
        if (dimIdxs.length === 0) { return order; }
        const binnedIdx = new Set(dimIdxs.filter(i => state.binKeys[result.columns[i] ?? '']));
        order.sort((a, b) => {
            for (const di of dimIdxs) {
                const ra = result.rows[a]![di];
                const rb = result.rows[b]![di];
                if (binnedIdx.has(di)) {
                    const na = Number(ra); const nb = Number(rb);
                    if (Number.isFinite(na) && Number.isFinite(nb)) {
                        if (na !== nb) { return na - nb; }
                        continue;
                    }
                    const ta = Date.parse(String(ra)); const tb = Date.parse(String(rb));
                    if (Number.isFinite(ta) && Number.isFinite(tb)) {
                        if (ta !== tb) { return ta - tb; }
                        continue;
                    }
                }
                const av = formatCell(ra);
                const bv = formatCell(rb);
                if (av < bv) { return -1; }
                if (av > bv) { return 1; }
            }
            return 0;
        });
        return order;
    }

    /** The FULL display for a locked crumb's value(s): for a binned key the whole
     *  bucket range (start – end), otherwise the plain value. Used for the hover
     *  title so the complete window is available even though the bubble body shows
     *  the compact start. */
    private crumbFullDisplay(crumb: DrillCrumb): string {
        return crumb.locks.map(l => {
            const type = this.state?.columns.find(c => c.name === l.dimension)?.type;
            if (l.values && l.values.length > 1) {
                if (l.binSize) {
                    const { lo, hi } = orderedBounds(l.values, type);
                    return `${binRangeLabel(lo, l.binSize, type)} – ${binRangeEndLabel(hi, l.binSize, type)}`;
                }
                return l.values.map(v => formatCell(v)).join(', ');
            }
            return l.binSize ? binRangeFull(l.value, l.binSize, type) : formatCell(l.value);
        }).join(' · ');
    }

    private activeBubbleHtml(state: ExploreState, crumb: DrillCrumb): string {
        const m = extractBubbleMetric(crumb.columns, crumb.row);
        const dial = this.dialAttrs(state, state.selectedMeasures[0] ?? null);
        const aggDial = this.aggDialAttrs(state);
        // The active stacked bubble is always ungrouped (no dimension yet), so it
        // owns the record lens — its toggle sits inside, beside the dim facet.
        const facet = this.dimFacetHtml(state);
        const records = this.recordsToggleHtml(state);
        const bubbleExtra = `${facet ? ' has-facet' : ''}${records ? ' has-records' : ''}`;
        return `
            <div class="bubble-hub bubble-hub-active">
                <div class="bubble bubble-locked bubble-active${bubbleExtra}" data-hubdrag="1"
                    title="${escapeAttr(this.crumbFullDisplay(crumb))}">
                    ${bubbleBody(crumb.display, m.valueText, m.aggGlyph, m.measureName, dial, aggDial, true, crumb.fromDimensions.join(' · '))}
                    ${facet}
                    ${records}
                </div>
                ${this.dimChipsHtml(state)}
            </div>`;
    }

    /**
     * Renders a locked drill node as a bubble (from the snapshot captured when it
     * was picked), clickable to pop back to that level. Only the deepest (bottom)
     * bubble carries the dimension facet — ancestors are bare, their locked
     * dimension shown on the connector line above them instead.
     */
    private lockedBubbleHtml(state: ExploreState, crumb: DrillCrumb, index: number, isDeepest: boolean): string {
        const m = extractBubbleMetric(crumb.columns, crumb.row);
        // Only the deepest locked bubble carries the dimension facet (pick the next
        // grouping) and the active-dimension chips.
        const facet = isDeepest ? this.dimFacetHtml(state) : '';
        const chips = isDeepest ? this.dimChipsHtml(state) : '';
        // Only the deepest locked bubble owns the live measure choice → only it
        // gets the dial.
        const dial = isDeepest ? this.dialAttrs(state, state.selectedMeasures[0] ?? null) : '';
        const aggDial = isDeepest ? this.aggDialAttrs(state) : '';
        // The deepest locked bubble owns the open cloud → clicking it clears that
        // grouping (collapses the cloud). Ancestor bubbles pop the chain back to
        // their level (ungrouped).
        const action = isDeepest
            ? ` data-action="clearGrouping"`
            : ` data-action="popDrill" data-index="${index}"`;
        const title = isDeepest ? this.crumbFullDisplay(crumb) : 'Back to ' + this.crumbFullDisplay(crumb);
        // The deepest (current working) hub is the bubble you just pulled forward;
        // it can be dragged back up-left to "put it back" — return to the prior
        // cloud (handled by the client's hub-drag gesture → goBack).
        const hubDrag = isDeepest ? ' data-hubdrag="1"' : '';
        return `
            <div class="locked-hub">
                <div class="bubble bubble-locked clickable"${action}${hubDrag}
                    title="${escapeAttr(title)}">
                    ${bubbleBody(crumb.display, m.valueText, m.aggGlyph, m.measureName, dial, aggDial, true, crumb.fromDimensions.join(' · '))}
                    ${facet}
                </div>
                ${chips}
            </div>`;
    }

    /**
     * Synthesize a render-only state from a captured cloud snapshot, so a past
     * level's cloud can be drawn by the SAME valueAreaHtml as the live one (pixel
     * fidelity, zero duplication). Interactive/selection fields are neutralized —
     * the ghost is decorative depth, made inert by `pointer-events:none` on its
     * wrapper.
     */
    private ghostState(base: ExploreState, snap: CloudSnapshot): ExploreState {
        return {
            ...base,
            result: snap.result,
            selectedDimensions: snap.selectedDimensions,
            binKeys: snap.binKeys,
            selectedMeasures: snap.selectedMeasures,
            selectedAggregate: snap.selectedAggregate,
            focusKey: null,
            selectionKeys: [],
            selectionAnchor: null,
            viewMode: 'auto',
            loading: false,
            tooManyGroups: null,
            showRecords: false,
            records: null,
            recordsLoading: false,
        };
    }

    /**
     * The hub bubble that sat ABOVE a past cloud, so the bubble recedes together
     * with its cloud (not just the field of siblings). For ghost of chain level
     * `ci`, the owning hub is the bubble you had drilled into to open that cloud:
     * the previous crumb (`ci-1`), or the root/source bubble for the first level.
     * Static and inert — pure depth context.
     */
    private ghostHubHtml(state: ExploreState, ci: number): string {
        let body: string;
        if (ci === 0) {
            const hasMeasure = state.selectedMeasures.length > 0;
            const measureName = hasMeasure ? state.selectedMeasures[0]! : 'rows';
            const aggGlyph = hasMeasure ? AGGREGATES[state.selectedAggregate].glyph : '#';
            const val = hasMeasure
                ? (state.totalMeasure === null ? '—' : formatMeasureValue(state.totalMeasure))
                : (state.totalCount === null ? '—' : formatCompact(state.totalCount));
            body = bubbleBody(state.source, val, aggGlyph, measureName);
        } else {
            const p = state.drillChain[ci - 1]!;
            const m = extractBubbleMetric(p.columns, p.row);
            body = bubbleBody(p.display, m.valueText, m.aggGlyph, m.measureName);
        }
        return `<div class="bubble-hub"><div class="bubble bubble-locked">${body}</div></div>`;
    }

    /**
     * The depth stack: the prior levels' clouds (each with the hub bubble it hung
     * under), left on screen and pushed back into depth behind the live cloud. The
     * nearest (most recent) ghost is sharp; deeper ones shrink, darken, fade and
     * blur, drifting toward the upper-LEFT — so you see "where you came from"
     * trailing off into the dark. Only the last few levels are drawn. Static for
     * now (Stage 2): driven purely by drill depth, no drag/animation yet. All the
     * recede magnitudes here are deliberately tunable constants.
     */
    private ghostLayersHtml(state: ExploreState): string {
        const GHOST_MAX = 3;                 // how many prior layers stay visible
        const chain = state.drillChain;
        const start = Math.max(0, chain.length - GHOST_MAX);
        const layers: string[] = [];
        // A post-drop transition makes the layers visibly step into their new depth:
        // on a drill they animate FROM one level closer (depth-1); on a back they
        // animate FROM one level further (depth+1). The webview applies the FROM
        // geometry, forces a reflow, then lets CSS transition to the target.
        //
        // A drill renders TWICE (loading → settled). To avoid the settled DOM swap
        // snapping the recede mid-flight, while LOADING we hold each ghost STILL at
        // its FROM position (no data-from); only the SETTLED render emits data-from
        // and plays the single clean animation. A put-back is one settled render.
        const trans = this.pendingTransition;
        const holding = trans !== null && state.loading; // pre-settle: park at FROM
        for (let ci = start; ci < chain.length; ci++) {
            const crumb = chain[ci]!;
            if (!crumb.cloud) { continue; }  // legacy crumbs (no snapshot) render no ghost
            const depth = chain.length - ci; // 1 = nearest ghost (the level you just left)
            const fromDepth = trans === 'drill' ? depth - 1 : depth + 1;
            const g = this.depthGeom(holding ? fromDepth : depth);
            const z = 10 - depth;                                // nearer ghost higher (still behind card)
            const hub = this.ghostHubHtml(state, ci);
            const cloud = this.valueAreaHtml(this.ghostState(state, crumb.cloud));
            // Emit the FROM geometry only on the SETTLED render so the webview plays
            // the step-back / step-forward animation once. Packed transform|filter|opacity.
            let fromAttr = '';
            if (trans && !holding) {
                const f = this.depthGeom(fromDepth);
                fromAttr = ` data-from="${escapeAttr(`${f.transform}|${f.filter}|${f.opacity}`)}"`;
            }
            // The whole layer is a click target that brings this level forward
            // (reopenCloud): the clicked cloud becomes live and the remaining ghosts
            // shift forward. Inner bubbles are made inert via CSS so the click always
            // resolves to the layer, not a stale bubble. aria-hidden keeps the depth
            // decoration out of the a11y tree.
            const tip = `Return to ${crumb.fromDimensions.join(' · ') || state.source} groups`;
            layers.push(`<div class="ghost-layer clickable" data-action="reopenCloud" data-index="${ci}"`
                + ` title="${escapeAttr(tip)}"${fromAttr}`
                + ` style="transform:${g.transform};${g.filter ? `filter:${g.filter};` : ''}opacity:${g.opacity};z-index:${z};">${hub}${cloud}</div>`);
        }
        if (layers.length === 0) { return ''; }
        return `<div class="layer-stack" aria-hidden="true">${layers.join('')}</div>`;
    }

    /** The depth-stack geometry for a layer at the given depth (1 = nearest ghost,
     *  0 = front/live-ish, higher = further into the fog). Shared by the rendered
     *  target position AND the transition's FROM position (depth±1) so a step looks
     *  consistent. All the recede magnitudes are deliberately tunable constants. */
    private depthGeom(depth: number): { transform: string; filter: string; opacity: number } {
        const scale = Math.max(0.34, 1 - 0.24 * depth);      // shrink HARDER with distance
        // Drift LEFT as a PERCENTAGE of the layer width, not fixed px. With
        // transform-origin:center top, scaling pulls a layer's left edge back toward
        // its centre by (1-scale)·width/2; a fixed-px tx gets swallowed by that on a
        // wide panel, so the deeper (smaller) layer's left edge re-aligns with the
        // nearer one. A %-of-width drift is proportional and survives the shrink, so
        // each deeper layer is reliably MORE to the left at any panel width — and the
        // hub still stays on screen on a narrow side panel.
        const txPct = -15 * depth;                           // % of layer width, compounding per level
        // Drift UP with DIMINISHING returns so deeper layers don't fly off the top —
        // they stay inside the panel and read as "further" via shrink/fade instead.
        const ty = -150 - 70 * (depth - 1);
        // FOG via OPACITY, not a scrim: the ghosts sit behind the live card with only
        // the (editor-background) body behind them, so simply lowering their opacity
        // dissolves them TOWARD the background — theme-correct fog — without painting
        // a rectangle. (A bg-coloured scrim used to leave a muddy rectangle because it
        // filled the layer's whole box and composited with the bubbles' widget-bg.)
        const opacity = Math.max(0.3, 1 - 0.32 * depth);     // fade into the fog with distance
        const blur = depth * 1.6;                            // soft from the FIRST ghost back
        // DESATURATE with distance so the receded clouds read as muted/greyed memory
        // rather than vivid competing colour — WITHOUT darkening them (brightness is
        // left alone; only the colour intensity drains). Floors so the deepest ghost
        // keeps a hint of its heat hue.
        const sat = Math.max(0.45, 1 - 0.3 * depth);         // 1=full colour, lower=greyer
        const filter = [blur > 0 ? `blur(${blur}px)` : '', `saturate(${sat})`]
            .filter(Boolean).join(' ');
        return {
            transform: `translate(${txPct}%, ${ty}px) scale(${scale})`,
            filter,
            opacity,
        };
    }

    /** On a 'back' (put-it-back) transition, the cloud being brought forward becomes
     *  the LIVE card — not a ghost layer — so without help it would just pop into
     *  the front. We give the card a FROM geometry (the nearest-ghost depth it's
     *  emerging from) so the webview can animate it forward into its resting (front)
     *  position, mirroring the ghosts' step-forward. Returns '' otherwise. Only on
     *  the settled render (put-back is a single synchronous render, never loading). */
    private cardFromAttr(state: ExploreState): string {
        if (this.pendingTransition !== 'back' || state.loading) { return ''; }
        const f = this.depthGeom(1); // emerge from where the nearest ghost sat
        return ` data-card-from="${escapeAttr(`${f.transform}|${f.filter}|${f.opacity}`)}"`;
    }

    private valueAreaHtml(state: ExploreState): string {
        // Only show the bare "Loading…" hint on a COLD load (no cloud to show yet).
        // When a cloud is already on screen — e.g. switching the measure re-runs the
        // query — we keep the existing bubbles up and just dim them (`is-refreshing`)
        // so they update in place instead of flashing off to "Loading…" and back.
        if (state.loading && !state.result) {
            return `<div class="hint">Querying…</div>`;
        }
        if (state.selectedDimensions.length === 0 && state.selectedMeasures.length === 0) {
            // No grouping yet: a single total bubble in the same three-line layout.
            return `
                <div class="flower">
                    <div class="bubble">
                        ${bubbleBody('All', state.totalCount === null ? '—' : formatCompact(state.totalCount), '#', 'rows')}
                    </div>
                </div>
                <div class="hint">Pick a dimension to flower into groups, or a measure to add values.</div>`;
        }

        // CARDINALITY GUARD: the grouping has more distinct combinations than the
        // explorer can render as a field. We didn't query the cloud; show guidance.
        if (state.tooManyGroups !== null) {
            return this.tooManyGroupsHtml(state);
        }

        const result = state.result;
        if (!result || result.rows.length === 0) {
            return `<div class="hint">No groups.</div>`;
        }

        const countIdx = result.columns.indexOf('Count');
        const measureCols = result.columns
            .map((name, i) => ({ name, i }))
            .filter(c => isMeasureHeader(c.name));
        const dimIdxs = result.columns
            .map((name, i) => ({ name, i }))
            .filter(c => c.name !== 'Count' && !isMeasureHeader(c.name))
            .map(c => c.i);

        // Single measure: the selected numeric column (promoted to the big value
        // and the heat channel) or, with none, the row count. Only one measure is
        // shown at a time now.
        const primaryMeasure = measureCols[0];

        const metricOf = (row: unknown[]): number => primaryMeasure
            ? Number(row[primaryMeasure.i]) || 0
            : Number(row[countIdx]) || 0;

        // Heat is the SOLE magnitude channel (we deliberately keep every bubble
        // the SAME SIZE so focusing/ghosting doesn't reflow the layout — size
        // variation perturbed spacing on every select). Normalized by VALUE (log
        // scale) so the spread reflects real magnitude, not item count, and the
        // minimum (usually 0) maps to the cold end.
        const heatRank = computeHeatValues(result.rows.map(r => metricOf(r)));

        // Level-of-detail by cardinality: as the cloud grows we degrade from full
        // three-line bubbles → compact value-only heat circles → bare heat dots,
        // and BEYOND that fall back to the catch-all table (the cloud is no longer a
        // readable field). Focus/click/drag are identical across the cloud tiers.
        const autoTier = result.rows.length <= LOD_FULL_MAX ? 'full'
            : (result.rows.length <= LOD_NUMERIC_MAX ? 'numeric'
                : (result.rows.length <= LOD_DOT_MAX ? 'dot' : 'table'));
        // The view-mode toggle can FORCE the table; 'auto' honours the LOD tier.
        const tier = state.viewMode === 'table' ? 'table' : autoTier;

        // A small toggle sits at the top-left of the cloud: cloud (auto) ↔ table.
        // It's only useful once the data is grouped (it is, here).
        const toggle = this.viewToggleHtml(state, autoTier);

        // Too dense to visualize, or table forced → the table catch-all.
        if (tier === 'table') {
            return toggle + this.cloudTableHtml(state, result, dimIdxs, primaryMeasure, countIdx, metricOf);
        }

        // Cloud layout is keyed to GROUP IDENTITY, not value, so a bubble keeps its
        // place when only the measure changes (size/heat carry magnitude). Order is
        // computed once (shared with the shift-select contiguous-run math) so the
        // "between" run always matches the visible layout.
        const order = this.orderedRowIndices(state);

        // SELECTION MODE: a shift-select is in progress (one or more bubbles picked
        // as a range/set). We suppress the focus enlarge (selectBubble clears
        // focusKey) and instead paint selected bubbles at full strength with a flat
        // band highlight while dimming the rest — a calm "these are chosen" read.
        const selecting = state.selectionKeys.length > 0;

        const bubbles = order.map((rowIdx) => {
            const row = result.rows[rowIdx]!;
            const count = Number(row[countIdx]) || 0;
            const label = dimIdxs.length > 0
                ? dimIdxs.map(i => {
                    const name = result.columns[i] ?? '';
                    const size = state.binKeys[name];
                    return size
                        ? binRangeLabel(row[i], size, state.columns.find(c => c.name === name)?.type)
                        : formatCell(row[i]);
                }).join(' · ')
                : 'All';

            // The three-line body: big value + "glyph column" caption (or "# rows").
            let valueText: string;
            let aggGlyph: string;
            let measureName: string;
            if (primaryMeasure) {
                const pm = parseMeasureHeader(primaryMeasure.name);
                valueText = formatMeasureValue(row[primaryMeasure.i]);
                aggGlyph = pm.glyph;
                measureName = pm.column;
            } else {
                valueText = formatCompact(count);
                aggGlyph = '#';
                measureName = 'rows';
            }

            // Heat is the magnitude channel. The compact tiers lean on it harder:
            // the dot is a pure heat puck, the numeric circle a strong tint. The
            // soft 16% wash is the "full bubble" look — also reused by the focused
            // bubble so a promoted dot/number reads identically to a full bubble.
            const heat = heatColor(heatRank[rowIdx] ?? 0);
            const fullFill = `background:color-mix(in srgb, ${heat} 16%, var(--vscode-editorWidget-background));`;
            const fill = tier === 'dot'
                ? `background:${heat};`
                : (tier === 'numeric'
                    ? `background:color-mix(in srgb, ${heat} 38%, var(--vscode-editorWidget-background));`
                    : fullFill);
            const heatStyle = `border-color:${heat};` + fill;

            const key = String(rowIdx);

            // The focused bubble is enlarged (object permanence: its peers stay
            // visible but fade). It ALWAYS renders the full three-line hub, even in
            // the compact tiers — focusing is how you read a dense field — so it also
            // wears the SAME soft 16% fill a full bubble would have, not the solid/
            // strong heat of its compact tier. It carries NO drill nubs — to descend
            // you DRAG it onto the drop zone below the stack (an intentional "link"
            // gesture); dropping elsewhere deselects it.
            if (state.focusKey === key) {
                const inner = bubbleBody(label, valueText, aggGlyph, measureName, '', '', false);
                const focusStyle = `border-color:${heat};` + fullFill;
                // The focus slot keeps the SAME footprint as the bubble it replaced
                // (tier-sized) so peers don't shift and no gaps open in a dense
                // cloud; the enlarged hub is an overlay drawn on top of the
                // (already faded) neighbours.
                const slot = LOD_SLOT_PX[tier];
                return `
                    <div class="focus-slot" style="width:${slot}px;height:${slot}px;">
                        <div class="bubble-hub bubble-hub-focus">
                            <div class="bubble bubble-focus" data-action="clearFocus" style="${focusStyle}" title="${escapeAttr(label)}">${inner}</div>
                        </div>
                    </div>`;
            }

            // In SELECTION mode the unselected bubbles get a GENTLE fade (not the deep
            // single-focus dim): the selected ones already stand out via the filled tile
            // + full color, but a light de-emphasis of the rest helps them pop in denser
            // views — while a set/range is a comparison among ALL of them, so we keep the
            // others clearly legible. (Single-focus still fades peers hard — there one
            // bubble is the whole point.)
            const isSelected = selecting && state.selectionKeys.includes(key);
            const faded = !selecting && state.focusKey !== null ? ' faded'
                : selecting && !isSelected ? ' faded-soft' : '';
            const selectedCls = isSelected ? ' selected' : '';

            if (tier === 'full') {
                const inner = bubbleBody(label, valueText, aggGlyph, measureName, '', '', false);
                return `
                    <div class="bubble clickable${faded}${selectedCls}" style="${heatStyle}" data-action="focusBubble" data-key="${key}" title="${escapeAttr(label)}">
                        ${inner}
                    </div>`;
            }

            // Compact tiers: a heat circle. The numeric tier shows the DIMENSION
            // LABEL (the value is already encoded by the heat color, and the name is
            // what you need to choose which group to drill into); the dot tier shows
            // nothing and relies on hover. Hover surfaces the full label + value in
            // both; click still focuses, drag still drills.
            const hover = `${label} — ${aggGlyph} ${measureName}: ${valueText}`;
            const body = tier === 'numeric'
                ? `<span class="bubble-mini-num">${escapeHtml(label)}</span>` : '';
            return `<div class="bubble bubble-${tier} clickable${faded}${selectedCls}" style="${heatStyle}" data-action="focusBubble" data-key="${key}" title="${escapeAttr(hover)}">${body}</div>`;
        }).join('');

        const refreshing = state.loading ? ' is-refreshing' : '';
        return toggle + `<div class="flower tier-${tier}${refreshing}">${bubbles}</div>`;
    }

    /** Guidance card shown when the current grouping has too many distinct
     *  combinations to render as a field (cloud or its equivalent table). We don't
     *  query the cloud at all in this state — the dimension is too high-cardinality
     *  to be useful here, so we point at the ways to make it tractable. */
    private tooManyGroupsHtml(state: ExploreState): string {
        const count = state.tooManyGroups ?? 0;
        const dims = state.selectedDimensions.map(escapeHtml).join(' · ') || '(none)';
        return `
            <div class="too-many">
                <div class="too-many-figure">≈${escapeHtml(count.toLocaleString())}</div>
                <div class="too-many-title">Too many groups to explore</div>
                <div class="too-many-body">
                    Grouping by <strong>${dims}</strong> makes about
                    ${escapeHtml(count.toLocaleString())} distinct combinations — more than the
                    ${MAX_GROUP_ROWS.toLocaleString()} this view can show. To make it tractable:
                </div>
                <ul class="too-many-tips">
                    <li>Pick a <strong>coarser dimension</strong> (fewer distinct values).</li>
                    <li><strong>Drill into a slice</strong> first to narrow the scope.</li>
                    <li>Add a <strong>filter</strong> to the query before exploring.</li>
                </ul>
            </div>`;
    }

    /** The record lens for an UNGROUPED bubble: a quiet toggle that, when on,
     *  reveals a bounded sample of the actual rows in this bubble's scope below it.
     *  The aggregate cloud and the record lens are mutually exclusive by state —
     *  this is only ever rendered when there's no grouping (no cloud). */
    private recordsToggleHtml(state: ExploreState): string {
        const open = state.showRecords;
        const title = `Top ${RECORD_LIMIT} rows`;
        // Lives INSIDE the bubble, at the bottom beside the cloud-bloom dots — the
        // two "open this bubble" affordances: bloom an aggregate cloud, or reveal
        // the raw rows. Calm at rest, brightens on hub hover (like the dim facet).
        return `<button class="records-facet${open ? ' active' : ''}"`
            + ` data-action="toggleRecords" title="${escapeAttr(title)}"`
            + ` aria-label="${escapeAttr(title)}" role="switch" aria-checked="${open ? 'true' : 'false'}">\u2630</button>`;
    }

    /** The record-lens panel (scope header + rows table), rendered BELOW the card.
     *  Only present while the lens is open; the toggle that opens it lives inside
     *  the bubble (recordsToggleHtml). */
    private recordsPanelHtml(state: ExploreState): string {
        if (!state.showRecords) { return ''; }

        // Scope header: the locked drill-chain values, constant across every row
        // here, shown once instead of repeated as columns.
        const scope = state.drillChain.map(c => c.display).join(' · ');
        const scopeHtml = scope
            ? `<div class="records-scope">${escapeHtml(scope)}</div>` : '';

        let body: string;
        if (state.recordsLoading && !state.records) {
            body = `<div class="records-loading">Loading rows…</div>`;
        } else if (!state.records || state.records.rows.length === 0) {
            body = `<div class="hint">No rows in this scope.</div>`;
        } else {
            body = this.recordsTableHtml(state.records);
        }
        const refreshing = state.recordsLoading ? ' is-refreshing' : '';
        return `<div class="records-panel${refreshing}">${scopeHtml}${body}</div>`;
    }

    /** Renders the fetched record sample as a scrollable table. Columns that are
     *  entirely null across the sample are pruned (a wide log table's sparse
     *  columns add nothing). The sample is labeled "N of <total>" to stay honest
     *  that it's a slice, not the whole scope. */
    private recordsTableHtml(records: { columns: string[]; rows: unknown[][]; total: number | null }): string {
        const { columns, rows, total } = records;
        // Prune columns that are null/empty for every row in the sample.
        const keptIdx = columns
            .map((_c, i) => i)
            .filter(i => rows.some(r => r[i] !== null && r[i] !== undefined && r[i] !== ''));
        const cols = keptIdx.length > 0 ? keptIdx : columns.map((_c, i) => i);

        const heads = cols.map(i => `<th>${escapeHtml(columns[i] ?? '')}</th>`).join('');
        const body = rows.map(r =>
            `<tr>${cols.map(i => `<td>${escapeHtml(formatCell(r[i]))}</td>`).join('')}</tr>`,
        ).join('');

        const shown = rows.length.toLocaleString();
        const label = total !== null && total > rows.length
            ? `${shown} of ${total.toLocaleString()} rows`
            : `${shown} ${rows.length === 1 ? 'row' : 'rows'}`;
        return `
            <div class="records-count">${escapeHtml(label)}</div>
            <div class="cloud-table-wrap">
                <table class="cloud-table">
                    <thead><tr>${heads}</tr></thead>
                    <tbody>${body}</tbody>
                </table>
            </div>`;
    }

    /** The cloud/table view toggle, anchored top-left of the value area. Shows the
     *  two modes; the active one is highlighted. When the auto tier would itself be
     *  the table (too dense to plot), the "cloud" option is disabled with a hint. */
    private viewToggleHtml(state: ExploreState, autoTier: string): string {
        const tableActive = state.viewMode === 'table' || autoTier === 'table';
        // Toggling back to 'auto' restores the default (bubble) view.
        const nextMode = tableActive ? 'auto' : 'table';
        const title = tableActive ? 'Switch back to the bubble view' : 'Show as a table';
        return `
            <div class="view-toggle">
                <button class="view-toggle-btn${tableActive ? ' active' : ''}"
                    data-action="setViewMode" data-mode="${nextMode}" title="${escapeAttr(title)}"
                    aria-label="${escapeAttr(title)}" role="switch" aria-checked="${tableActive ? 'true' : 'false'}">▤</button>
            </div>`;
    }

    /** The catch-all view for a grouping with too many distinct combinations to
     *  read as a cloud (even as dots): a scrollable table listing every group,
     *  most-significant first (the query already returns metric desc). Each row
     *  carries the same key/heat as a bubble would; clicking a row focuses it and
     *  drilling works via the focused row's "drill in" affordance — but at this
     *  density the table's job is to FIND a group, so a row click drills straight
     *  in (the efficient navigation move for thousands of groups). */
    private cloudTableHtml(
        state: ExploreState,
        result: { columns: string[]; rows: unknown[][] },
        dimIdxs: number[],
        primaryMeasure: { name: string; i: number } | undefined,
        countIdx: number,
        metricOf: (row: unknown[]) => number,
    ): string {
        const heatRank = computeHeatValues(result.rows.map(r => metricOf(r)));
        const measureLabel = primaryMeasure
            ? (() => { const pm = parseMeasureHeader(primaryMeasure.name); return `${pm.glyph} ${pm.column}`; })()
            : '# rows';
        const dimHeads = dimIdxs.map(i => `<th>${escapeHtml(result.columns[i] ?? '')}</th>`).join('');

        const rows = result.rows.map((row, rowIdx) => {
            const heat = heatColor(heatRank[rowIdx] ?? 0);
            const valueText = primaryMeasure
                ? formatMeasureValue(row[primaryMeasure.i])
                : formatCompact(Number(row[countIdx]) || 0);
            const cells = dimIdxs.map(i => `<td>${escapeHtml(formatCell(row[i]))}</td>`).join('');
            return `<tr class="cloud-row" data-action="descendBubble" data-key="${rowIdx}" title="Drill in">
                ${cells}
                <td class="cloud-row-metric"><span class="cloud-row-heat" style="background:${heat};"></span>${escapeHtml(valueText)}</td>
            </tr>`;
        }).join('');

        // The cardinality guard blocks anything over the ceiling, so the table
        // always holds the COMPLETE set of groups here — never truncated. Order is
        // metric-desc (most significant first); click a row to drill in.
        const hint = `<div class="hint">${result.rows.length.toLocaleString()} groups, ordered by ${escapeHtml(measureLabel)}. Click a row to drill in.</div>`;
        const refreshing = state.loading ? ' is-refreshing' : '';
        return `
            <div class="cloud-table-wrap${refreshing}">
                <table class="cloud-table">
                    <thead><tr>${dimHeads}<th class="cloud-row-metric">${escapeHtml(measureLabel)}</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            ${hint}`;
    }

    // ─── Static shell ───────────────────────────────────────────────────

    private shellHtml(): string {
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px;
        /* Explicit backdrop = the colour the receding ghosts fade toward (their
           opacity dissolves them into whatever is behind, which is this body). Pin it
           to editor-background so the fog reads as the true background everywhere. */
        background: var(--vscode-editor-background); }
    /* Role palette — single source of truth so the card chips and the bubble
       category/member nubs always share the same colors. */
    :root {
        --role-time: #d19a66;
        --role-measure: #56b6c2;
        --role-dimension: #98c379;
        --role-id: #c678dd;
        --role-other: #888;
        /* The source/entity hub bubble — purple, distinct from the teal measure
           and the blue selection accent. */
        --root-accent: #a371f7;
        /* A focused (drilled-into) bubble — gold, distinct from the purple root
           so a sub-root reads as "you are here", not "the table". */
        --focus-accent: #e5c07b;
    }
    #app { display: flex; flex-direction: column; gap: 12px; }
    /* SCENE plane — the "room" the clouds live in. .scene-plane is the perspective
       context (the depth the layers will recede into); .scene is the single
       transformable unit (Stage 2+ will translate/scale/fade it). For Stage 0 both
       are inert pass-through wrappers, so the card renders exactly as before. */
    .scene-plane { position: relative; perspective: 1400px; }
    .scene { transform-origin: center top; position: relative; padding-top: 180px; }
    /* Drilled or not, the working hub sits low (toward the panel's vertical middle)
       so it reads consistently and the receding ghosts have room to rise UP above it
       (and clip out the top) — that upward travel is what sells "moving back into
       depth". A touch MORE headroom once drilled, since the ghost stack lives there.
       The cloud blooms below the hub, so the panel scrolls if it runs long. */
    .scene.drilled { padding-top: 240px; }
    /* The depth stack of receded prior clouds. Fills the scene, sits behind the
       live card, and is clickable per-layer (return to that level). Each
       .ghost-layer is transformed/darkened/blurred per its depth by inline style
       (tuned in ghostLayersHtml). Anchored at the live hub's vertical position,
       then drifting up-left as it recedes. */
    .layer-stack { position: absolute; inset: 0; pointer-events: none; z-index: 0; }
    .ghost-layer {
        position: absolute; left: 0; right: 0; top: 240px;
        transform-origin: center top;
        transition: transform .35s ease, filter .35s ease, opacity .35s ease;
        pointer-events: none;
    }
    /* Only the ghost's HUB BUBBLE is the click target (return to that level): it's
       the visible, un-occluded representative of the level. The cloud below it sits
       behind the live working card, so making it clickable would just be invisible
       dead zones. The click bubbles up to the layer's data-action via closest(). */
    .ghost-layer .bubble-hub { pointer-events: auto; cursor: pointer; }
    .ghost-layer .bubble-hub:hover .bubble { outline: 2px solid var(--vscode-focusBorder); }
    /* Ghosts are context, not controls — hide the per-cloud chrome that would
       otherwise repeat behind the live one. */
    .ghost-layer .view-toggle, .ghost-layer .hint { display: none !important; }
    /* Inside a blurred, faded ghost every HARD EDGE smears into an artifact: drop
       shadows bleed into a dark halo "around the cloud" (the root/hub bubble's
       shadow, closest in), and the scrollable table frame — its 1px border, its
       sticky-header band, its row rules and its own scrollbar — smears into stray
       horizontal smudge lines that track the scrollbar as the ghost moves. The
       ghost is pure depth context, so strip those edges: no shadows, no table
       chrome. The soft bubble field alone carries the recede. */
    .ghost-layer .bubble, .ghost-layer .bubble-root, .ghost-layer .bubble-locked,
    .ghost-layer .records-facet, .ghost-layer .cat-nub { box-shadow: none !important; }
    .ghost-layer .cloud-table-wrap { border: none; overflow: hidden; }
    .ghost-layer .cloud-table th, .ghost-layer .cloud-table td { border-bottom: none; }
    .ghost-layer .cloud-table thead th { position: static; background: transparent; }
    /* Lift the live card above the depth stack. */
    .card { position: relative; z-index: 5; display: flex; flex-direction: column; gap: 10px;
        transform-origin: center top;
        transition: transform .35s ease, filter .35s ease, opacity .35s ease; }
    /* GLASS plane — fixed HUD layer pinned to the viewport, above the scene and
       outside its transform. Empty until Stage 1 (bottom path strip). pointer-events
       pass through while it holds nothing so it can't intercept clicks. */
    .glass-plane {
        position: fixed; left: 0; right: 0; bottom: 0;
        z-index: 10; pointer-events: none;
    }
    /* The fixed bottom path strip — the always-legible record of the drill chain.
       Lives on the glass plane (re-enables pointer events for itself), scrolls its
       contents horizontally when the chain outgrows the rail (the rail itself never
       moves), and the render handler keeps the newest step (right edge) in view. */
    .path-strip {
        pointer-events: auto;
        display: flex; align-items: center; gap: 2px;
        overflow-x: auto; overflow-y: hidden;
        padding: 6px 12px;
        background: color-mix(in srgb, var(--vscode-editor-background) 85%, transparent);
        border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
        backdrop-filter: blur(6px);
        scrollbar-width: thin;
        white-space: nowrap;
    }
    .path-origin { flex: 0 0 auto; font-weight: 600; color: var(--root-accent); padding: 2px 6px;
        background: transparent; border: 1px solid transparent; border-radius: 6px;
        cursor: pointer; font-family: inherit; font-size: 0.95em; }
    .path-origin:hover, .path-origin:focus {
        border-color: var(--vscode-focusBorder);
        background: var(--vscode-list-hoverBackground); outline: none; }
    .path-sep { flex: 0 0 auto; opacity: 0.4; padding: 0 1px; }
    .path-step {
        flex: 0 0 auto;
        display: inline-flex; align-items: baseline; gap: 5px;
        background: transparent; border: 1px solid transparent; border-radius: 6px;
        color: var(--vscode-foreground); cursor: pointer;
        padding: 2px 8px; font-size: 0.9em; font-family: inherit; line-height: 1.4;
    }
    .path-step:hover, .path-step:focus {
        border-color: var(--vscode-focusBorder);
        background: var(--vscode-list-hoverBackground); outline: none;
    }
    .path-step-dim { opacity: 0.6; font-size: 0.85em; }
    .path-step-val { font-weight: 600; }
    /* Reserve room so the bottom of the scene can scroll clear of the fixed strip. */
    #app { padding-bottom: 52px; }
    .card { display: flex; flex-direction: column; gap: 10px; }
    /* Until the full pan/zoom canvas exists, center the hub (and its flowering
       value area) along the panel width instead of hugging the left. */
    .card { align-items: center; }
    .card .value-area { align-self: stretch; }
    .card .flower { justify-content: center; }
    .card-header { display: flex; align-items: center; gap: 8px; }
    .card-title { font-weight: 600; font-size: 1.1em; }
    .card-total { opacity: 0.7; font-size: 0.85em; }
    .collapse-btn {
        background: transparent; color: var(--vscode-foreground); border: none;
        cursor: pointer; font-size: 1em;
    }
    .columns { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 3px 8px; border-radius: 12px; font-size: 0.85em;
        border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.4));
        background: var(--vscode-editorWidget-background);
        user-select: none;
    }
    .chip.selectable { cursor: pointer; }
    .chip.selectable:hover { border-color: var(--vscode-focusBorder); }
    .chip.selected {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border-color: var(--vscode-button-background);
    }
    .chip.static { opacity: 0.7; }
    .chip.role-time { border-left: 3px solid var(--role-time); }
    .chip.role-measure { border-left: 3px solid var(--role-measure); }
    .chip.role-dimension { border-left: 3px solid var(--role-dimension); }
    .chip.role-id { border-left: 3px solid var(--role-id); }
    .chip.role-other { border-left: 3px solid var(--role-other); }
    .chip-dc { opacity: 0.6; font-size: 0.85em; }
    /* The cloud sits below the spine at the card's normal gap — the hub no longer
       reserves empty bloom space, so no negative-margin pull-up is needed. */
    .value-area { margin-top: 0; }
    .flower { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: center; }
    /* The compact tiers degrade into a dense heat-field; left edge-to-edge they
       read as a wall of text/dots. Constraining them to a centered column with
       generous side margins implies a "canvas" the field sits on (even though we
       don't draw one) and keeps the cloud feeling like an object, not a fill. The
       cap is generous so a wide panel gets more room, but it never goes full-bleed:
       min() keeps comfortable side gutters on narrow panels. */
    .flower.tier-full, .flower.tier-numeric, .flower.tier-dot {
        max-width: min(840px, calc(100% - 64px));
        margin-left: auto; margin-right: auto; padding: 8px 24px;
    }
    /* A re-running query (e.g. a measure change) keeps the current cloud on screen
       and just dims it while the new values land — avoids the off/on flash. */
    .flower.is-refreshing { opacity: 0.55; transition: opacity 0.12s ease-out; }
    .bubble {
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        width: 96px; height: 96px; flex: 0 0 auto; box-sizing: border-box;
        padding: 8px; border-radius: 50%;
        background: var(--vscode-editorWidget-background);
        border: 2px solid var(--role-other);
        text-align: center; overflow: hidden; user-select: none;
    }
    /* The root/source bubble is the ENTITY hub the groups flower from — give it a
       solid accent ring, a faint accent-tinted fill and a lift so it reads as the
       anchor, while the derived aggregate bubbles stay as lighter neutral satellites. */
    .bubble-root {
        cursor: default; width: 180px; height: 180px; position: relative;
        font-size: 1.35em;
        border: 3px solid var(--root-accent);
        background:
            color-mix(in srgb, var(--root-accent) 14%, var(--vscode-editorWidget-background));
        box-shadow: 0 1px 6px rgba(0, 0, 0, 0.35);
    }
    /* Aggregate bubbles are clickable to focus; focusing one fades its peers
       (object permanence — they're still computed, just receded). */
    .bubble.clickable { cursor: pointer; transition: opacity 0.12s; }
    .bubble.clickable:hover { opacity: 1; }
    .bubble.faded { opacity: 0.22; filter: saturate(0.6); }
    .bubble.faded:hover { opacity: 0.6; }
    .bubble.faded-soft { opacity: 0.62; filter: saturate(0.85); }
    .bubble.faded-soft:hover { opacity: 0.9; }
    /* A shift-selected bubble (part of a range/set): the SQUARE CELL the circle
       sits in is filled with the selection color (a backing tile behind the heat
       circle, its corners showing around the circle). In a dense heat-field the
       circles are already saturated, so a ring alone disappears — a filled tile
       reads clearly. NO enlargement, so the field stays steady while you sweep. */
    .bubble.selected {
        opacity: 1; position: relative; overflow: visible;
    }
    .bubble.selected::before {
        content: ''; position: absolute; inset: -2px; z-index: -1;
        border-radius: 7px; pointer-events: none;
        background: color-mix(in srgb, var(--vscode-focusBorder) 42%, transparent);
        box-shadow: 0 0 0 1.5px var(--vscode-focusBorder);
    }
    /* ── Level-of-detail tiers for a dense cloud ──
       As cardinality climbs the flower packs tighter and the bubbles shrink:
       NUMERIC = a compact heat circle labelled with the DIMENSION VALUE (its
       magnitude is the heat color; the name is what you drill on); DOT = a bare
       heat puck. Both stay clickable (focus) and draggable (drill); hover reveals
       the full label + value. */
    .flower.tier-numeric { gap: 8px; }
    .flower.tier-dot { gap: 4px; }
    .bubble-numeric {
        width: 46px; height: 46px; padding: 3px; border-width: 1px;
        font-size: 0.62em; overflow: hidden;
    }
    /* The label wraps inside the circle for up to three lines, then crops; the
       full value lives in the hover title. */
    .bubble-mini-num {
        font-weight: 600; line-height: 1.05; text-align: center;
        overflow: hidden; word-break: break-word; overflow-wrap: anywhere;
        display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
    }
    .bubble-dot {
        width: 18px; height: 18px; padding: 0; border-width: 1px;
    }
    .bubble-dot:hover { transform: scale(1.25); }
    /* ── Table view toggle: a small icon-only button pinned to the top-RIGHT
       corner of the value-area canvas. Right alignment (rather than left) keeps it
       at a consistent, intentional-looking position whether the centered cloud or
       the full-width table is shown — it lines up with the table's right edge and
       reads as a corner control over the cloud. ── */
    .view-toggle {
        display: flex; justify-content: flex-end; width: min(840px, calc(100% - 16px));
        margin: 0 auto 6px; padding: 0 2px;
    }
    .view-toggle-btn {
        font: inherit; font-size: 0.9em; line-height: 1; cursor: pointer;
        width: 24px; height: 22px; display: flex; align-items: center; justify-content: center;
        border-radius: 6px;
        color: var(--vscode-foreground);
        border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
        background: var(--vscode-editorWidget-background);
        opacity: 0.55;
    }
    .view-toggle-btn:hover:not(:disabled) { opacity: 1; border-color: var(--vscode-focusBorder); }
    .view-toggle-btn.active {
        opacity: 1;
        background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
        color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
        border-color: transparent;
    }
    .view-toggle-btn:disabled { opacity: 0.35; cursor: default; }
    /* ── Cardinality guard card: shown instead of a field when the grouping has
       more distinct combinations than the explorer ceiling. ── */
    .too-many {
        max-width: min(560px, calc(100% - 32px)); margin: 12px auto 0;
        padding: 20px 24px; text-align: center;
        border: 1px dashed var(--vscode-widget-border, rgba(128,128,128,0.4));
        border-radius: 12px;
        background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent);
    }
    .too-many-figure {
        font-size: 2.2em; font-weight: 700; line-height: 1;
        color: var(--role-other); opacity: 0.85;
    }
    .too-many-title { font-size: 1.05em; font-weight: 600; margin-top: 8px; }
    .too-many-body { font-size: 0.9em; opacity: 0.85; margin-top: 8px; }
    .too-many-tips {
        text-align: left; font-size: 0.88em; opacity: 0.9;
        margin: 10px auto 0; max-width: 420px; padding-left: 20px;
    }
    .too-many-tips li { margin: 3px 0; }
    /* ── Table tier: the catch-all when a grouping has too many distinct
       combinations to read as a cloud. A scrollable list of every group,
       most-significant first; click a row to drill in. ── */
    .cloud-table-wrap {
        max-width: min(840px, calc(100% - 16px)); margin: 4px auto 0;
        max-height: 60vh; overflow: auto;
        border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
        border-radius: 8px;
    }
    .cloud-table-wrap.is-refreshing { opacity: 0.55; transition: opacity 0.12s ease-out; }
    .cloud-table { border-collapse: collapse; width: 100%; font-size: 0.85em; }
    .cloud-table th, .cloud-table td {
        text-align: left; padding: 5px 12px; white-space: nowrap;
        border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.18));
    }
    .cloud-table thead th {
        position: sticky; top: 0; z-index: 1;
        background: var(--vscode-editorWidget-background);
        font-weight: 600; opacity: 0.85;
    }
    .cloud-table .cloud-row-metric { text-align: right; font-variant-numeric: tabular-nums; }
    .cloud-row-heat {
        display: inline-block; width: 9px; height: 9px; border-radius: 50%;
        margin-right: 7px; vertical-align: baseline;
    }
    .cloud-row { cursor: pointer; }
    .cloud-row:hover td { background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); }
    /* ── Record lens: a quiet ☰ disclosure that lives INSIDE an ungrouped bubble,
       at the bottom beside the cloud-bloom dots. The two are the bubble's "open
       me" affordances — bloom an aggregate cloud, or reveal the raw rows. When
       both are present they sit as a balanced centered pair; a lone control stays
       centered. The cloud (table) styles above are reused for the rows table. ── */
    .records-facet {
        position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%);
        display: inline-flex; align-items: center; justify-content: center; z-index: 2;
        width: 22px; height: 22px; border-radius: 50%; padding: 0;
        font: inherit; font-size: 0.95em; line-height: 1;
        color: var(--vscode-foreground); border: none; background: transparent;
        opacity: 0.55; cursor: pointer; user-select: none;
        transition: opacity 0.12s ease-out, background 0.12s ease-out, box-shadow 0.12s ease-out;
    }
    .bubble-hub:hover .records-facet, .locked-hub:hover .records-facet { opacity: 0.95; }
    .records-facet:hover {
        opacity: 1;
        background: color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-foreground) 32%, transparent);
    }
    /* ON state: a solid, inverted disc (filled foreground, glyph punched out in the
       editor background) so it reads unmistakably as a pressed/active toggle — not
       the translucent wash that hover gives. Click again to toggle off. */
    .records-facet.active {
        opacity: 1;
        color: var(--vscode-editorWidget-background);
        background: var(--vscode-foreground);
        box-shadow: none;
    }
    .records-facet.active:hover {
        background: color-mix(in srgb, var(--vscode-foreground) 88%, transparent);
    }
    /* When the bubble carries BOTH controls, nudge each off-center so they read as
       a pair; alone, each stays centered (the default transform above). */
    .bubble.has-facet.has-records .dim-facet { transform: translateX(calc(-50% - 14px)); }
    .bubble.has-facet.has-records .records-facet { transform: translateX(calc(-50% + 14px)); }

    .card .records-panel { align-self: stretch; }
    /* The record lens sits below the spine at the same card gap as the cloud — both
       are card children with no special margin, so they land identically whether or
       not you've drilled. (The old per-host negative margins are gone with the hub's
       reserved space.) */
    .records-panel { margin-top: 0; }
    .records-panel.is-refreshing { opacity: 0.55; transition: opacity 0.12s ease-out; }
    .records-scope {
        max-width: min(840px, calc(100% - 16px)); margin: 0 auto;
        font-size: 0.85em; opacity: 0.8; text-align: center;
    }
    .records-count {
        max-width: min(840px, calc(100% - 16px)); margin: 4px auto 0;
        font-size: 0.78em; opacity: 0.6;
    }
    .records-loading {
        max-width: min(840px, calc(100% - 16px)); margin: 8px auto 0;
        font-size: 0.85em; opacity: 0.7; text-align: center;
    }
    /* The focused bubble is promoted to a sub-root hub with a gold ring + lift. */
    .bubble-focus {
        cursor: pointer; width: 180px; height: 180px; position: relative;
        font-size: 1.35em;
        border-width: 3px; box-shadow: 0 1px 8px rgba(0, 0, 0, 0.45);
        outline: 2px solid var(--focus-accent); outline-offset: 2px;
    }
    /* While dragging the focused bubble (the stack gesture), hint with a grab
       cursor and a touch more lift so the gesture feels physical. */
    #app.dragging-bubble .bubble-focus { cursor: grabbing; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5); }

    /* "Put it back" gesture: while dragging the current working hub up-left to
       return to the prior cloud, light the nearest ghost (release-to-land). The
       drag ghost itself is tinted inline (purple -> target cloud heat) in script. */
    #app.dragging-bubble.arming-back .ghost-layer:last-of-type .bubble {
        outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px;
    }

    /* Cursor-following ghost shown during the drag, so the bubble visibly moves
       away from the cloud as you pull it apart. Its SIZE animates with the gesture
       (set inline in script): a detach grows toward the full hub size as it arms
       (feels like picking it up); a put-back starts hub-size and shrinks to the
       cloud-circle size as it arms (feels like setting it back down). */
    .drag-ghost {
        position: fixed; z-index: 1000; left: 0; top: 0;
        transform: translate(-50%, -50%);
        width: 96px; height: 96px; box-sizing: border-box; padding: 8px 10px;
        border-radius: 50%;
        display: flex; align-items: center; justify-content: center; text-align: center;
        font-size: 0.78em; overflow: hidden;
        border: 2px solid var(--focus-accent);
        background: color-mix(in srgb, var(--focus-accent) 18%, var(--vscode-editorWidget-background));
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5);
        pointer-events: none; opacity: 0.92;
        transition: border-color 0.18s ease, background 0.18s ease, box-shadow 0.18s ease,
                    width 0.22s ease, height 0.22s ease;
    }
    /* Armed "drag it apart" state: the bubble has been pulled far enough that a
       release will drill in. Brighten the ghost with the drill accent so the commit
       is unmistakable. */
    #app.dragging-bubble.arming-apart .drag-ghost {
        border-color: var(--root-accent);
        background: color-mix(in srgb, var(--root-accent) 30%, var(--vscode-editorWidget-background));
        box-shadow: 0 8px 22px rgba(0, 0, 0, 0.6);
    }
    /* The focused bubble occupies a normal 96px slot in the flow so its peers stay
       put; the enlarged 180px hub is overlaid on top, centered on the slot. */
    .focus-slot { width: 96px; height: 96px; flex: 0 0 auto; position: relative; }
    .bubble-hub-focus {
        position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
        z-index: 5; pointer-events: none;
    }
    .bubble-hub-focus .bubble-focus { pointer-events: auto; }
    /* Drill spine: the locked ancestor bubbles stacked vertically, centered,
       with a connector line between them — the path you've drilled stays on
       screen as real bubbles (click one to pop back to that level). Locked
       bubbles match the root's purple — they ARE sub-roots of the lineage — and
       carry no heat color (heat belongs to the live cloud you're comparing). */
    .drill-spine { display: flex; flex-direction: column; align-items: center; margin-bottom: 10px; }
    .spine-node { display: flex; justify-content: center; }
    .spine-link { position: relative; width: 2px; height: 26px; background: color-mix(in srgb, var(--root-accent) 50%, transparent); }
    /* The dimension(s) locked in to reach the bubble below, shown beside the
       connector line (the bubbles no longer carry this as a nub). */
    .spine-link-label {
        position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
        white-space: nowrap; max-width: 160px; overflow: hidden; text-overflow: ellipsis;
        font-size: 0.7em; color: var(--role-dimension); pointer-events: none;
    }
    /* The connector label doubles as a "return to that cloud" button. Quiet at
       rest (it reads as a caption), it lights up and underlines on hover so the
       affordance is discoverable without shouting. */
    .spine-link-label.clickable {
        pointer-events: auto; cursor: pointer;
        border-bottom: 1px dashed transparent; transition: color 0.12s, border-color 0.12s;
    }
    .spine-link-label.clickable:hover, .spine-link-label.clickable:focus {
        color: var(--vscode-foreground); border-bottom-color: currentColor; outline: none;
    }
    /* Every spine connector is a uniform 26px line spanning the whole gap between
       bubbles, so its centered label sits exactly midway in every gap (no per-hub
       margin to push it off-center). The trailing gap to the cloud lives on the
       .drill-spine margin-bottom. */
    .bubble-locked {
        position: relative;
        width: 180px; height: 180px;
        font-size: 1.35em;
        border: 3px solid var(--root-accent);
        background: color-mix(in srgb, var(--root-accent) 14%, var(--vscode-editorWidget-background));
    }
    .bubble-locked:hover { box-shadow: 0 1px 6px rgba(0, 0, 0, 0.35); }
    /* A locked spine node: the 180px bubble. Spacing to the next bubble lives
       entirely in the following 26px spine-link (no margin here), so every gap is
       uniform and the connector label centers in it. */
    .locked-hub { position: relative; width: 180px; height: 180px; }
    .locked-hub .bubble-locked { position: relative; z-index: 1; }
    .locked-cat { cursor: default; }
    /* Locked bubbles reveal their interactive nubs on hover, like the big hubs. */
    .locked-hub:hover .cat-nub, .locked-hub .cat-nub.has-selection, .locked-hub .cat-nub:focus {
        opacity: 1; pointer-events: auto; outline: none;
    }
    .bubble-label { font-size: 0.85em; opacity: 0.85; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* The dimension column name as an eyebrow above a spine bubble's range/value
       so a standalone range says WHAT it ranges over (cloud bubbles use their
       floating pill instead). Tinted toward the bubble's purple accent to bind it
       to the bubble that owns it, but muted (mixed with the normal fg) so it reads
       as a quiet label, not a bright link. Real column casing is preserved. */
    .bubble-context { font-size: 0.68em; letter-spacing: 0.02em;
        color: color-mix(in srgb, var(--root-accent) 55%, var(--vscode-foreground));
        max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* Caption-less cloud bubbles let the title wrap to two lines for long
       bin-range / dimension labels (the agg/column line is omitted there). */
    .bubble-label-2 { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.15; }
    .bubble-primary { display: flex; flex-direction: column; align-items: center; line-height: 1.1; }
    .bubble-primary-num { font-weight: 700; font-size: 1.7em; font-variant-numeric: tabular-nums; }
    .bubble-primary-cap { font-size: 0.72em; opacity: 0.7; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bubble-value { font-size: 0.9em; opacity: 0.8; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: baseline; justify-content: center; gap: 3px; }
    .bubble-agg { opacity: 0.7; font-weight: 600; }
    .bubble-value-name { opacity: 0.7; overflow: hidden; text-overflow: ellipsis; }
    .bubble-value-num { font-variant-numeric: tabular-nums; }
    .bubble-more { font-size: 0.8em; opacity: 0.6; line-height: 0.8; }
    /* Caption under the value: the aggregate glyph + the measure column name (or
       "# rows"). The whole bubble surface is the measure dial. */
    .bubble-cap { font-size: 0.72em; opacity: 0.7; max-width: 100%; display: flex; align-items: baseline; justify-content: center; gap: 4px; }
    .bubble-cap-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* A bubble whose surface is the measure dial: click or drag to scrub measures.
       The capsule highlight (below) is the affordance now, so keep the normal
       cursor. */
    [data-dial] { cursor: default; }
    /* The glyph (aggregate dial) and the name (measure dial) sit side by side, so the
       ns-resize cursor alone can't tell them apart. On hover each lights up as its own
       little pill — independently — so you can see they are two separate controls. */
    .bubble-cap [data-dial] { border-radius: 5px; padding: 0 3px; margin: 0 -1px; transition: background 0.1s ease-out, box-shadow 0.1s ease-out; }
    .bubble-cap .bubble-agg[data-dial]:hover { background: color-mix(in srgb, var(--role-measure) 22%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--role-measure) 45%, transparent); opacity: 1; }
    .bubble-cap .bubble-cap-name[data-dial]:hover { background: color-mix(in srgb, var(--role-measure) 14%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--role-measure) 35%, transparent); opacity: 1; }
    /* The glyph is tiny and easy to miss, so on hover the aggregate dial expands from
       its glyph (e.g. Σ) into its full label (e.g. "Sum") — telling you what it is and
       that it's an interactive handle. The label is hidden (not display:none) when idle
       so it doesn't affect layout width until you actually hover. */
    .bubble-agg .agg-label { display: none; }
    .bubble-agg[data-dial]:hover .agg-glyph { display: none; }
    .bubble-agg[data-dial]:hover .agg-label { display: inline; font-weight: 600; }

    /* Measure dial: a translucent, finger-following scroll wheel of measure names
       that appears over the dialed bubble while you drag vertically. The centered
       item is the live pick; release snaps to it. Built/positioned by the script. */
    .measure-dial-popup {
        position: fixed; z-index: 50; width: 150px; height: 132px;
        transform: translate(-50%, -50%); border-radius: 14px; overflow: hidden;
        background: color-mix(in srgb, var(--vscode-editor-background) 72%, transparent);
        backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
        border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
        box-shadow: 0 6px 20px rgba(0,0,0,0.4);
        -webkit-mask-image: linear-gradient(transparent, #000 28%, #000 72%, transparent);
                mask-image: linear-gradient(transparent, #000 28%, #000 72%, transparent);
        pointer-events: none;
    }
    .measure-dial-list { position: absolute; left: 0; right: 0; top: 50%; will-change: transform; }
    .measure-dial-item {
        height: 26px; line-height: 26px; text-align: center; font-size: 0.82em;
        color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden;
        text-overflow: ellipsis; padding: 0 10px; opacity: 0.65; transition: opacity 0.08s, transform 0.08s;
    }
    .measure-dial-item.current { color: var(--role-measure); opacity: 1; font-weight: 600; transform: scale(1.1); }
    .measure-dial-center {
        position: absolute; left: 10px; right: 10px; top: 50%; height: 26px; transform: translateY(-50%);
        border-top: 1px solid var(--role-measure); border-bottom: 1px solid var(--role-measure);
        opacity: 0.35; pointer-events: none;
    }
    /* A click on a dial capsule opens the SAME wheel popup, but kept on screen and
       draggable (pointer-events on) so you can scrub it without holding from the
       capsule. Release snaps + commits; click away dismisses. */
    .measure-dial-popup.is-open { pointer-events: auto; cursor: ns-resize; }

    /* Dimension wheel: the VERTICAL twin of the measure dial. Appears centered on
       the hub bubble when you click its facet; scroll (or drag) to scrub field
       names. The centered item is the live pick. Built/positioned by the script. */
    .dim-dial-popup {
        position: fixed; z-index: 50; width: 160px; height: 132px;
        transform: translate(-50%, -50%); border-radius: 14px; overflow: hidden;
        background: color-mix(in srgb, var(--vscode-editor-background) 72%, transparent);
        backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
        border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
        box-shadow: 0 6px 20px rgba(0,0,0,0.4);
        -webkit-mask-image: linear-gradient(transparent, #000 28%, #000 72%, transparent);
                mask-image: linear-gradient(transparent, #000 28%, #000 72%, transparent);
        pointer-events: none;
    }
    .dim-dial-popup.is-open { pointer-events: auto; cursor: ns-resize; }
    .dim-dial-list { position: absolute; left: 0; right: 0; top: 50%; will-change: transform; }
    .dim-dial-item {
        height: 26px; line-height: 26px; text-align: center; font-size: 0.82em;
        color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden;
        text-overflow: ellipsis; padding: 0 10px; opacity: 0.65; transition: opacity 0.08s, transform 0.08s;
    }
    .dim-dial-item.current { color: var(--role-dimension); opacity: 1; font-weight: 600; transform: scale(1.1); }
    /* A binnable (continuous) field is marked with a leading ruler glyph + a tint
       so it reads as "this one buckets into ranges" vs a discrete dimension. */
    .dim-dial-item.dim-dial-bin { color: var(--role-time); }
    .dim-dial-item.dim-dial-bin::before { content: '\\1F4CF\\00a0'; opacity: 0.8; }
    .dim-dial-item.dim-dial-bin.current { color: var(--role-time); }
    .dim-dial-center {
        position: absolute; left: 10px; right: 10px; top: 50%; height: 26px; transform: translateY(-50%);
        border-top: 1px solid var(--role-dimension); border-bottom: 1px solid var(--role-dimension);
        opacity: 0.35; pointer-events: none;
    }

    /* ── Dimension facet: the in-circle, bottom-interior dimension control ──
       Icon-only — a 2x2 cluster of heat-tinted dots that hints at the bubble
       cloud this control blooms — so the primary surface stays gesture-led, not
       jargon. Calm at rest, brightens on hub hover. Click to open the field
       scroller; while accumulating it shows a small "+" cue. */
    .dim-facet {
        position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%);
        display: inline-flex; align-items: center; justify-content: center; z-index: 2;
        width: 22px; height: 22px; border-radius: 50%;
        user-select: none;
        background: transparent;
        box-shadow: none;
        opacity: 0.55; cursor: pointer; touch-action: none;
        transition: opacity 0.12s ease-out, background 0.12s ease-out, box-shadow 0.12s ease-out;
    }
    .bubble-hub:hover .dim-facet, .locked-hub:hover .dim-facet { opacity: 0.95; }
    .dim-facet:hover {
        opacity: 1;
        background: color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-foreground) 32%, transparent);
    }
    .dim-facet-mark { display: block; width: 15px; height: 15px; }

    /* Active grouping chips: shown just below the hub bubble (in the bloom-reserve
       space). The × prunes one dimension at a time so accumulated (combined)
       groupings can be trimmed without losing the rest. */
    .dim-chips {
        margin-top: 8px;
        display: flex; flex-wrap: wrap; gap: 4px; justify-content: center;
        max-width: 260px;
    }
    .dim-chip {
        display: inline-flex; align-items: center; gap: 2px;
        padding: 1px 4px 1px 8px; border-radius: 10px; font-size: 0.7em;
        color: var(--vscode-foreground);
        background: color-mix(in srgb, var(--role-dimension) 18%, var(--vscode-editorWidget-background));
        border: 1px solid color-mix(in srgb, var(--role-dimension) 50%, transparent);
        white-space: nowrap; user-select: none;
    }
    .dim-chip-label { overflow: hidden; text-overflow: ellipsis; max-width: 120px; }
    /* A binned key chip is tinted with the time role and prefixed with a ruler so
       it reads as a continuous (bucketed) axis vs a discrete dimension. */
    .dim-chip.is-bin {
        background: color-mix(in srgb, var(--role-time) 18%, var(--vscode-editorWidget-background));
        border-color: color-mix(in srgb, var(--role-time) 50%, transparent);
    }
    .dim-chip.is-bin .dim-chip-label::before { content: '\\1F4CF\\00a0'; opacity: 0.8; }
    /* The binned chip's label is a bin-size dial: click it to scrub bucket sizes. */
    .dim-chip-label.is-dial { cursor: pointer; border-radius: 6px; padding: 0 2px; }
    .dim-chip-label.is-dial:hover { background: color-mix(in srgb, var(--role-time) 28%, transparent); }
    .dim-chip-x {
        display: inline-flex; align-items: center; justify-content: center;
        width: 14px; height: 14px; padding: 0; border: none; border-radius: 50%;
        background: transparent; color: inherit; opacity: 0.6; cursor: pointer;
        font-size: 1.1em; line-height: 1;
    }
    .dim-chip-x:hover { opacity: 1; background: color-mix(in srgb, var(--role-dimension) 30%, transparent); }

    /* Collapsed bubble "hub": the bubble centered, with category nubs around it. */
    /* The hub fits its content: the bubble flows at the top, the active-grouping
       chips flow directly beneath it. No oversized box, so nothing below needs a
       negative-margin pull-up. (The old 420px hub existed only to reserve room for
       the member-dot bloom, which no longer exists.) */
    .bubble-hub {
        position: relative;
        display: flex; flex-direction: column; align-items: center;
    }

    /* Category nub: a stable colored dot that blooms its members on hover. */
    .cat-nub {
        position: absolute; transform: translate(-50%, -50%);
        width: 28px; height: 28px; border-radius: 50%;
        background: var(--vscode-editorWidget-background);
        border: 2px solid #888; cursor: pointer; user-select: none;
        opacity: 0; pointer-events: none;
        transition: opacity 0.12s;
    }
    /* Sticky reveal: category nubs appear on hub hover; a category with an
       active selection stays lit at rest so the choice is always discoverable.
       The nub keeps z-index:auto so it never creates a stacking context — that
       lets it stay tucked behind the bubble (z-index:1) even while open, while
       its member dots (z-index:4) still rise above the bubble. */
    .bubble-hub:hover .cat-nub, .cat-nub.has-selection, .cat-nub:focus { opacity: 1; pointer-events: auto; outline: none; }
    .cat-dimension { border-color: var(--role-dimension); }
    .cat-dimension.has-selection { background: var(--role-dimension); }
    .cat-measure { border-color: var(--role-measure); }
    .cat-measure.has-selection { background: var(--role-measure); }
    /* Pinned label: the single selected member's name, shown below the hub. */
    .cat-pinned {
        position: absolute; left: 50%; top: 130%; transform: translateX(-50%);
        white-space: nowrap; font-size: 0.7em; padding: 1px 6px; border-radius: 8px;
        background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background));
        color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
        border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.4));
        pointer-events: none;
    }
    .cat-badge {
        position: absolute; top: -4px; right: -4px;
        font-size: 0.62em; line-height: 1; padding: 1px 4px; border-radius: 8px;
        background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    }

    /* Bloom: member dots riding a circle centered on the bubble. The category's
       members are revealed while the category is "open" (sticky hover, set by
       the shell script) — once open they stay until another category or the
       hub is left, so you can cross empty space to reach a member. */
    .cat-bloom { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
    /* Invisible disc centered on the bubble that, only while the category is open,
       catches pointer events across the whole bloom region so the bloom stays
       sticky even over a click-through hub (the focused aggregate overlay). It
       sits below the member dots so they remain hoverable/clickable. */
    .bloom-catch {
        position: absolute; transform: translate(-50%, -50%);
        width: 390px; height: 390px; border-radius: 50%;
        z-index: 0; pointer-events: none;
    }
    .cat-nub.open .bloom-catch { pointer-events: auto; }
    .member {
        position: absolute; transform: translate(-50%, -50%);
        width: 16px; height: 16px; padding: 0; border-radius: 50%;
        cursor: pointer; user-select: none; z-index: 4;
        background: var(--vscode-editorWidget-background);
        border: 2px solid var(--role-other);
        opacity: 0; pointer-events: none; transition: opacity 0.1s, width 0.1s, height 0.1s;
    }
    .cat-nub.open .member { opacity: 1; pointer-events: auto; }
    /* Hover enlarges and adds a soft ring but PRESERVES the member's role color
       (don't recolor the border to focusBorder — that read as the wrong/teal hue). */
    .member:hover, .member:focus { width: 20px; height: 20px; z-index: 5; outline: none; box-shadow: 0 0 0 2px var(--vscode-focusBorder); }
    .m-dimension { border-color: var(--role-dimension); }
    .m-measure { border-color: var(--role-measure); }
    .m-dimension.selected { background: var(--role-dimension); }
    .m-measure.selected { background: var(--role-measure); }
    .member-label {
        position: absolute; left: 50%; top: 130%; transform: translateX(-50%);
        white-space: nowrap; font-size: 0.72em; padding: 1px 6px; border-radius: 8px;
        background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background));
        color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
        border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.4));
        pointer-events: none; opacity: 0; transition: opacity 0.1s;
    }
    .member:hover .member-label, .member:focus .member-label, .member.selected .member-label { opacity: 1; }

    /* The "thumb" grip: lift-the-hood handle at the bottom-inside of the bubble. */
    .thumb {
        position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%);
        display: inline-flex; align-items: center; gap: 4px;
        background: transparent; border: none; cursor: pointer; padding: 4px;
        opacity: 0.55;
    }
    .thumb:hover { opacity: 1; }
    .thumb-grip {
        display: block; width: 22px; height: 10px;
        background:
            linear-gradient(currentColor, currentColor) 0 1px/100% 2px no-repeat,
            linear-gradient(currentColor, currentColor) 0 4px/100% 2px no-repeat,
            linear-gradient(currentColor, currentColor) 0 7px/100% 2px no-repeat;
        color: var(--vscode-foreground);
    }

    .hint { opacity: 0.6; font-size: 0.85em; margin-top: 8px; }
    .error { color: var(--vscode-errorForeground); font-size: 0.85em; white-space: pre-wrap; }
</style>
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>
<div id="app"></div>
<script>
(function() {
    const vscodeApi = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
    if (!vscodeApi) { return; }
    const app = document.getElementById('app');

    // Drag-to-drill gesture: press a cloud aggregate bubble and drag it AWAY from
    // where it sits — in any direction — past a small commit distance, then drop.
    // There is no drop target; pulling the bubble apart from the cloud IS the
    // gesture ("drag it apart"). A cursor-following ghost makes it feel deliberate.
    // A press that barely moves is treated as a click (deselect); the trailing
    // click is suppressed so a real drag release doesn't also clear focus.
    let dragState = null;      // { x, y, dragging, ghost }
    let suppressClick = false;
    // The viewport point where a detach drop was released. Stashed at pointerup so
    // the SETTLED drill render can grow the new purple hub bubble OUT of that spot
    // (a FLIP), tying the gesture's end to the new bubble's arrival. Consumed (and
    // cleared) by the render handler. Survives the intermediate loading render
    // because that render carries no transition.
    let pendingDrop = null;    // { x, y } or null
    const DRAG_THRESHOLD = 6;
    // How far the bubble must travel from its origin (in any direction) before the
    // drill commits on release. Larger than DRAG_THRESHOLD so a tiny nudge reads as
    // a click, not a drill.
    const APART_COMMIT = 56;
    function apartArmed(dx, dy) {
        return (dx * dx + dy * dy) >= APART_COMMIT * APART_COMMIT;
    }
    // The dragged bubble's heat colour seeds the ghost so it visibly "lifts off"
    // the cloud as the same circle, then morphs to the layer accent (purple) once
    // it's far enough to commit. Read the bubble's computed border colour (that's
    // where the heat hue lives). With a multi-selection, blend all the selected
    // bubbles' heats so the ghost reads as "this whole set".
    function readHeat(el) {
        const c = getComputedStyle(el).borderTopColor; // e.g. "rgb(r, g, b)"
        const lp = c.indexOf('('), rp = c.indexOf(')');
        if (lp < 0 || rp < 0) { return null; }
        const p = c.substring(lp + 1, rp).split(',').map(function(s) { return parseFloat(s); });
        return { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0 };
    }
    function blendHeats(els) {
        let r = 0, g = 0, b = 0, n = 0;
        els.forEach(function(el) {
            const h = readHeat(el);
            if (h) { r += h.r; g += h.g; b += h.b; n++; }
        });
        if (!n) { return null; }
        return 'rgb(' + Math.round(r / n) + ', ' + Math.round(g / n) + ', ' + Math.round(b / n) + ')';
    }
    // The label a cloud bubble represents, however it's drawn: the full tier carries
    // a .bubble-label and title=label; the numeric tier a .bubble-mini-num; the dot
    // tier only a "label — agg measure: value" hover title. Normalise to the bare
    // dimension label so we can match it against the dragged hub's label.
    function bubbleLabelOf(el) {
        const full = el.querySelector('.bubble-label');
        if (full) { return full.textContent.trim(); }
        const mini = el.querySelector('.bubble-mini-num');
        if (mini) { return mini.textContent.trim(); }
        const t = el.getAttribute('title') || '';
        const dash = t.indexOf(' \\u2014 '); // " — "
        return (dash >= 0 ? t.substring(0, dash) : t).trim();
    }
    // Find the heat of the ONE bubble in a cloud whose label matches the given
    // label — i.e. the specific group the hub came from — so "put it back" returns
    // to that exact colour rather than the cloud's average.
    function heatOfLabel(els, label) {
        for (let i = 0; i < els.length; i++) {
            if (bubbleLabelOf(els[i]) === label) { return blendHeats([els[i]]); }
        }
        return null;
    }
    // Paint the ghost with a tint (heat or the purple commit accent). Border is the
    // solid tint; the fill is a soft wash of it over the widget background. The
    // .drag-ghost transition makes the heat->purple swap a smooth morph.
    function tintGhost(g, color, pct) {
        g.style.borderColor = color;
        g.style.background = 'color-mix(in srgb, ' + color + ' ' + pct + '%, var(--vscode-editorWidget-background))';
    }
    // The drag-ghost SIZE morphs with the gesture to reinforce the metaphor:
    // CLOUD = the larger cloud-circle size (a satellite bubble), HUB = the full
    // working-hub size. Detach grows CLOUD -> HUB on arm (pick it up); put-back
    // starts HUB and shrinks HUB -> CLOUD on arm (set it back down on the cloud).
    const GHOST_CLOUD_SIZE = 96;
    const GHOST_HUB_SIZE = 180;
    function sizeGhost(g, px) { g.style.width = px + 'px'; g.style.height = px + 'px'; }
    // Multi-select tear: the whole selected set collapses into the single drag ghost
    // so the group reads as "becoming one thing". Each selected bubble emits a
    // position:fixed CLONE on <body> (viewport space, survives the later render swap,
    // same trick as the bloom/collapse) that flies into the ghost's birth point while
    // shrinking + fading. The real bubbles STAY PUT (the clone starts exactly atop its
    // original, so you just see a copy peel off toward the pointer) — the cloud stays
    // whole and recedes whole, matching the single-drag (no torn holes) and the
    // "nothing is destroyed, you can always go back" model. Fire-once at tear; clones
    // self-remove when they land.
    function playSelectionCoalesce(els, cx, cy) {
        const clones = [];
        for (let i = 0; i < els.length; i++) {
            const el = els[i];
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) { continue; }
            const clone = el.cloneNode(true);
            clone.classList.remove('selected');   // drop the selection tile chrome
            clone.style.position = 'fixed';
            clone.style.margin = '0';
            clone.style.left = r.left + 'px';
            clone.style.top = r.top + 'px';
            clone.style.width = r.width + 'px';
            clone.style.height = r.height + 'px';
            clone.style.zIndex = '990';   // just under the ghost (1000)
            clone.style.pointerEvents = 'none';
            clone.style.transformOrigin = 'center center';
            clone.style.transition = 'none';
            clone.style.transform = 'translate(0,0) scale(1)';
            document.body.appendChild(clone);
            clones.push({
                el: clone,
                dx: cx - (r.left + r.width / 2),
                dy: cy - (r.top + r.height / 2),
            });
        }
        if (!clones.length) { return; }
        void document.body.offsetWidth;   // commit the FROM state for all at once
        clones.forEach(function(c) {
            c.el.style.transition = 'transform .28s cubic-bezier(.4,0,.2,1), opacity .28s ease-in';
            c.el.style.transform = 'translate(' + c.dx + 'px,' + c.dy + 'px) scale(0.25)';
            c.el.style.opacity = '0';
            let finished = false;
            const done = function() {
                if (finished) { return; }
                finished = true;
                if (c.el.parentNode) { c.el.parentNode.removeChild(c.el); }
            };
            c.el.addEventListener('transitionend', done);
            setTimeout(done, 500);   // safety net
        });
    }
    // The "put it back" commit test: like the detach gesture, pulling the current
    // hub bubble AWAY from where it sits — in ANY direction — past a small commit
    // distance arms the return to the prior cloud. Direction-agnostic so it feels
    // identical to "drag it apart"; the colour morph signals droppability.
    const BACK_COMMIT = 56;
    function backArmed(dx, dy) {
        return (dx * dx + dy * dy) >= BACK_COMMIT * BACK_COMMIT;
    }
    app.addEventListener('pointerdown', function(e) {
        if (!e.target.closest) { return; }
        // A press starting on a dial capsule or the dim facet belongs to those
        // controls (handled separately), never the drag gestures.
        if (e.target.closest('[data-dial]') || e.target.closest('.dim-facet')) { return; }
        // Either the already-focused aggregate (legacy gesture) OR any cloud
        // bubble directly — press and drag without a focus click first. The cloud
        // bubble carries its row key so the drop can drill straight into it.
        const focus = e.target.closest('.bubble-focus');
        const cloud = e.target.closest('.bubble[data-action="focusBubble"]');
        // The current working hub bubble: dragging it up-left "puts it back" — i.e.
        // returns to the prior (faded) cloud. Distinct object, distinct meaning from
        // the cloud bubbles (which drag FORWARD to drill in).
        const hub = e.target.closest('.bubble[data-hubdrag]');
        const target = focus || cloud || hub;
        if (target) {
            // Stop the browser from starting a text selection on the bubble's
            // label/numbers as the pointer drags.
            e.preventDefault();
            dragState = { x: e.clientX, y: e.clientY, dragging: false, ghost: null, label: '',
                key: cloud ? cloud.getAttribute('data-key') : null,
                hub: !cloud && !focus && !!hub };
            // The dragged bubble's label, however its tier draws it (full label,
            // numeric mini, or dot hover-title) — so a smaller-tier bubble's ghost
            // still carries its name instead of coming up blank.
            dragState.label = bubbleLabelOf(target);
            // Seed the ghost with the dragged bubble's heat hue so it reads as the
            // SAME circle lifting off the cloud. If a multi-selection is being
            // dragged, blend every selected bubble's heat. Hubs keep the neutral
            // ghost (they aren't heat-coloured cloud bubbles).
            if (!dragState.hub) {
                const selected = app.querySelectorAll('.bubble.selected');
                const multi = selected.length > 1 && target.classList.contains('selected');
                dragState.multi = multi;
                // Stash the selected elements so the tear can coalesce the whole set
                // into the single ghost ("becoming one thing").
                if (multi) { dragState.selectedEls = Array.prototype.slice.call(selected); }
                dragState.heat = multi
                    ? blendHeats(Array.prototype.slice.call(selected))
                    : blendHeats([target]);
            } else {
                // The hub ghost is the MIRROR: it starts as the layer accent (purple)
                // and morphs to the HEAT of the prior faded cloud it'll rejoin, so
                // "drop here = back into that cloud" reads. Use the heat of the ONE
                // ghost bubble matching the hub's label (the exact group it came
                // from) so red returns to red; fall back to the cloud's blended heat.
                const ghostCloud = Array.prototype.slice.call(
                    app.querySelectorAll('.ghost-layer:last-of-type .bubble:not(.bubble-locked)'));
                dragState.targetHeat = heatOfLabel(ghostCloud, dragState.label)
                    || (ghostCloud.length ? blendHeats(ghostCloud) : null);
            }
        }
    });
    window.addEventListener('pointermove', function(e) {
        if (!dragState) { return; }
        const dx = e.clientX - dragState.x;
        const dy = e.clientY - dragState.y;
        if (!dragState.dragging) {
            if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) { return; }
            dragState.dragging = true;
            app.classList.add('dragging-bubble');
            const g = document.createElement('div');
            g.className = 'drag-ghost';
            g.textContent = dragState.label;
            // Forward-drill ghosts start in the bubble's own heat colour (so it's
            // visibly the same circle) and will morph to the commit accent below.
            // The hub ghost is the mirror: it starts as the layer accent (purple)
            // and morphs to the target cloud's heat when armed.
            // Base SIZE (no transition on this first set — it's the element's initial
            // style): a detach starts at the cloud-circle size and grows on arm; a
            // put-back starts at the full hub size and shrinks on arm.
            if (dragState.heat) { tintGhost(g, dragState.heat, 18); dragState.armed = false; sizeGhost(g, GHOST_CLOUD_SIZE); }
            else if (dragState.hub) { tintGhost(g, 'var(--root-accent)', 24); dragState.armed = false; sizeGhost(g, GHOST_HUB_SIZE); }
            document.body.appendChild(g);
            dragState.ghost = g;
            // Multi-select: the selected bubbles tear away and coalesce into this one
            // ghost, converging on its birth point (the current pointer) as it lifts.
            if (dragState.multi && dragState.selectedEls) {
                playSelectionCoalesce(dragState.selectedEls, e.clientX, e.clientY);
            }
        }
        if (dragState.ghost) {
            dragState.ghost.style.left = e.clientX + 'px';
            dragState.ghost.style.top = e.clientY + 'px';
        }
        if (dragState.hub) {
            // "Put it back" gesture: the prior cloud sits behind this bubble, mostly
            // up and to the LEFT. So a drag whose net direction is left (or up-left)
            // past a small commit distance means "return to it". Reflect the armed
            // state — and morph the ghost from the layer accent (purple) to the prior
            // cloud's HEAT so "drop here = back into that cloud" reads (mirror of the
            // forward gesture's heat->purple).
            const armed = backArmed(dx, dy);
            app.classList.toggle('arming-back', armed);
            if (armed !== dragState.armed) {
                dragState.armed = armed;
                if (armed && dragState.targetHeat) { tintGhost(dragState.ghost, dragState.targetHeat, 30); }
                else { tintGhost(dragState.ghost, 'var(--root-accent)', 24); }
                // Settle down onto the cloud (shrink to cloud-circle size) when armed;
                // swell back to the full hub size when disarmed.
                sizeGhost(dragState.ghost, armed ? GHOST_CLOUD_SIZE : GHOST_HUB_SIZE);
            }
        } else {
            // "Drag it apart" gesture: pulling the cloud bubble away from its origin
            // in ANY direction past the commit distance drills into it. Reflect the
            // armed state so the user sees it'll commit on release — and morph the
            // ghost from its heat hue to the layer accent (purple) so "drop here =
            // becomes its own layer" is unmistakable.
            const armed = apartArmed(dx, dy);
            app.classList.toggle('arming-apart', armed);
            if (dragState.heat && armed !== dragState.armed) {
                dragState.armed = armed;
                if (armed) { tintGhost(dragState.ghost, 'var(--root-accent)', 32); }
                else { tintGhost(dragState.ghost, dragState.heat, 18); }
                // Pick it up (grow to the full hub size) when armed; settle back to
                // the cloud-circle size when disarmed.
                sizeGhost(dragState.ghost, armed ? GHOST_HUB_SIZE : GHOST_CLOUD_SIZE);
            }
        }
    });
    window.addEventListener('pointerup', function(e) {
        if (dragState && dragState.dragging) {
            if (dragState.hub) {
                const dx = e.clientX - dragState.x;
                const dy = e.clientY - dragState.y;
                const armed = backArmed(dx, dy);
                if (dragState.ghost) { dragState.ghost.remove(); }
                app.classList.remove('dragging-bubble', 'arming-back');
                suppressClick = true;
                // Dragged up-left past the commit → return to the prior cloud
                // ("put it back"). Anything else → no-op (just settles back).
                if (armed) { vscodeApi.postMessage({ command: 'goBack' }); }
            } else {
                const dx = e.clientX - dragState.x;
                const dy = e.clientY - dragState.y;
                const armed = apartArmed(dx, dy);
                if (dragState.ghost) { dragState.ghost.remove(); }
                app.classList.remove('dragging-bubble', 'arming-apart');
                suppressClick = true;
                // Dragged apart past the commit → drill in, carrying the dragged
                // bubble's key (null = the already-focused bubble). Barely moved →
                // deselect (clear focus).
                if (armed) {
                    // Remember the release point so the new hub bubble can grow out
                    // of exactly where the dragged bubble was let go. VIEWPORT coords
                    // (clientX/Y) = the physical release pixel, independent of scroll
                    // and of which element scrolls. The hub rect we measure later is
                    // also viewport-relative, so the delta is correct in any scroll
                    // state without any page-coord/scroll bookkeeping.
                    pendingDrop = { x: e.clientX, y: e.clientY };
                    vscodeApi.postMessage({ command: 'descendBubble', key: dragState.key });
                } else {
                    vscodeApi.postMessage({ command: 'clearFocus' });
                }
            }
        }
        dragState = null;
    });

    // Measure dial: vertical drag on the caption NAME of a dial-capable bubble
    // (root / active / deepest-locked) scrubs through ["rows", ...numeric columns].
    // A translucent wheel follows the finger; releasing snaps to the centered item
    // and selects it. Independent of the drill drag (those are the cloud bubbles).
    let dialState = null;   // { el, startY, options, index, dragging, popup, list }
    const DIAL_ROW_H = 26;
    // The wheel travels faster than the finger so the whole list is reachable in a
    // short drag — important when the dialed bubble sits near the top edge of the
    // viewport and there's little room to drag upward.
    const DIAL_GAIN = 2.2;
    function dialSelectedIndex(s, dy) {
        // Drag UP (dy<0) advances toward later options.
        let sel = Math.round(s.index - (dy * DIAL_GAIN) / DIAL_ROW_H);
        if (sel < 0) { sel = 0; }
        if (sel > s.options.length - 1) { sel = s.options.length - 1; }
        return sel;
    }
    function buildDialPopup(s) {
        const p = document.createElement('div');
        p.className = 'measure-dial-popup';
        const list = document.createElement('div');
        list.className = 'measure-dial-list';
        s.options.forEach(function(opt) {
            const item = document.createElement('div');
            item.className = 'measure-dial-item';
            item.textContent = opt;
            list.appendChild(item);
        });
        p.appendChild(list);
        const center = document.createElement('div');
        center.className = 'measure-dial-center';
        p.appendChild(center);
        const r = s.el.getBoundingClientRect();
        p.style.left = (r.left + r.width / 2) + 'px';
        p.style.top = (r.top + r.height / 2) + 'px';
        document.body.appendChild(p);
        s.popup = p; s.list = list;
    }
    function updateDial(s, dy) {
        const sel = dialSelectedIndex(s, dy);
        const ty = -(s.index * DIAL_ROW_H + DIAL_ROW_H / 2) + dy * DIAL_GAIN;
        s.list.style.transform = 'translateY(' + ty + 'px)';
        const items = s.list.children;
        for (let i = 0; i < items.length; i++) {
            items[i].classList.toggle('current', i === sel);
        }
    }
    // Posts the chosen option back to the extension (shared by the capsule drag,
    // the open-wheel scrub, and a plain commit). kind = 'aggregate' | 'measure' | 'bin'.
    function commitDialChoice(kind, chosen, el) {
        if (kind === 'aggregate') {
            // Dial labels are Sum/Avg/Min/Max → lowercase to the agg kind.
            vscodeApi.postMessage({ command: 'setAggregate', agg: chosen.toLowerCase() });
        } else if (kind === 'bin') {
            // The binned chip's dial: change just the bucket size of its column.
            var col = el && el.getAttribute ? el.getAttribute('data-dial-col') : null;
            if (col) { vscodeApi.postMessage({ command: 'setBinSize', column: col, size: chosen }); }
        } else {
            // "rows" → empty column (count); a real column → that measure.
            vscodeApi.postMessage({ command: 'setMeasure', column: chosen === 'rows' ? '' : chosen });
        }
    }
    // The open click-wheel: a plain click on a dial capsule brings up the SAME
    // translucent wheel popup, kept on screen. PRIMARY gesture = MOUSE WHEEL: spin
    // the scroll wheel to bring your choice to the center (under the cursor), then
    // CLICK to select it. ALTERNATIVE = drag the wheel (good for touch): drag +
    // release snaps/commits. Clicking away (or Escape) dismisses it.
    let openWheel = null;
    let dialCommitTimer = null;
    function clearDialCommit() {
        if (dialCommitTimer) { clearTimeout(dialCommitTimer); dialCommitTimer = null; }
    }
    function closeDialWheel() {
        clearDialCommit();
        if (openWheel) { if (openWheel.popup) { openWheel.popup.remove(); } openWheel = null; }
    }
    // Spin the open wheel by whole steps (mouse-wheel notches). Does NOT commit;
    // a click on the wheel selects the centered item.
    function scrollOpenWheel(s, dir) {
        let idx = s.index + dir;
        if (idx < 0) { idx = 0; }
        if (idx > s.options.length - 1) { idx = s.options.length - 1; }
        s.index = idx;
        updateDial(s, 0);
    }
    function openDialWheel(el, options, kind, current) {
        closeDialWheel();
        let idx = options.indexOf(current);
        if (idx < 0) { idx = 0; }
        const s = { el: el, options: options, index: idx, kind: kind, current: current, popup: null, list: null };
        buildDialPopup(s);
        s.popup.classList.add('is-open');
        updateDial(s, 0); // show the current pick centered
        // PRIMARY: mouse-wheel scroll moves the menu (no auto-commit).
        s.popup.addEventListener('wheel', function(ev) {
            ev.preventDefault();
            ev.stopPropagation();
            scrollOpenWheel(s, ev.deltaY > 0 ? 1 : -1);
        }, { passive: false });
        // A pointerdown on the open wheel begins either a click (select) or a
        // vertical drag-scrub (touch); the pointerup resolves which.
        s.popup.addEventListener('pointerdown', function(ev) {
            ev.stopPropagation();
            clearDialCommit();
            dialState = { el: el, startY: ev.clientY, options: options, index: s.index, kind: kind, current: current, dragging: false, popup: s.popup, list: s.list, floating: true };
        });
        openWheel = s;
    }
    app.addEventListener('pointerdown', function(e) {
        if (!e.target.closest) { return; }
        const el = e.target.closest('[data-dial]');
        if (!el) { return; }
        let options;
        try { options = JSON.parse(el.getAttribute('data-dial')); } catch (_) { return; }
        if (!options || options.length < 2) { return; }
        const kind = el.getAttribute('data-dial-kind') || 'measure';
        const current = el.getAttribute('data-dial-current') || 'rows';
        let idx = options.indexOf(current);
        if (idx < 0) { idx = 0; }
        dialState = { el: el, startY: e.clientY, options: options, index: idx, kind: kind, current: current, dragging: false, popup: null, list: null };
    });
    window.addEventListener('pointermove', function(e) {
        if (!dialState) { return; }
        const dy = e.clientY - dialState.startY;
        if (!dialState.dragging) {
            if (Math.abs(dy) < DRAG_THRESHOLD) { return; }
            dialState.dragging = true;
            e.preventDefault();
            buildDialPopup(dialState);
        }
        updateDial(dialState, dy);
    });
    window.addEventListener('pointerup', function(e) {
        if (!dialState) { return; }
        const wasFloating = dialState.floating;
        if (dialState.dragging) {
            // Drag gesture (from the capsule, or scrubbing the open wheel): snap
            // the finger-wheel to the centered item and commit.
            const sel = dialSelectedIndex(dialState, e.clientY - dialState.startY);
            const chosen = dialState.options[sel];
            if (dialState.popup) { dialState.popup.remove(); }
            if (wasFloating) { openWheel = null; }
            suppressClick = true;
            commitDialChoice(dialState.kind, chosen, dialState.el);
        } else if (wasFloating) {
            // A click on the open wheel = select. Pick whichever item was clicked
            // (the centered one sits under the cursor; clicking another picks it).
            const item = e.target.closest && e.target.closest('.measure-dial-item');
            let sel = dialState.index;
            if (item && dialState.list) {
                const items = dialState.list.children;
                for (let i = 0; i < items.length; i++) {
                    if (items[i] === item) { sel = i; break; }
                }
            }
            const chosen = dialState.options[sel];
            suppressClick = true;
            closeDialWheel();
            commitDialChoice(dialState.kind, chosen, dialState.el);
        } else {
            // No drag from a capsule = a click: bring up the draggable wheel.
            suppressClick = true;
            openDialWheel(dialState.el, dialState.options, dialState.kind, dialState.current);
        }
        dialState = null;
    });
    // Click anywhere outside the open wheel (or pressing Escape) dismisses it.
    window.addEventListener('pointerdown', function(e) {
        const onDial = e.target.closest && (e.target.closest('.measure-dial-popup') || e.target.closest('[data-dial]'));
        if (openWheel && !onDial) { closeDialWheel(); }
        const onDim = e.target.closest && (e.target.closest('.dim-dial-popup') || e.target.closest('[data-dimfacet]'));
        if (openDim && !onDim) { closeDimWheel(); }
    });
    window.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') { closeDialWheel(); closeDimWheel(); }
    });

    // ── Dimension facet: click the icon to open, scroll to pick (auto-applies) ──
    // CLICK the bottom-interior icon of a hub bubble → a VERTICAL scroll wheel of
    // candidate field names opens centered on the bubble (the twin of the measure/
    // aggregate dials). PRIMARY = MOUSE WHEEL: spin to move the menu; it AUTO-
    // APPLIES the centered field a moment after you settle (the cloud blooms).
    // ALT = drag the wheel vertically (touch); release applies. Hold SHIFT while
    // it applies to ADD a breakdown (combined grouping) instead of replacing.
    // Click the icon again, click away, or Escape to dismiss without changing.
    let openDim = null;     // persistent wheel: { facetEl, options, index, rect, popup, list }
    let dimDrag = null;     // active drag on the open wheel: { startY, startIndex, dragging, shift }
    let dimPress = null;    // facet press waiting to resolve into an open-tap
    let dimCommitTimer = null;
    const DIM_ROW_H = 26;   // px height of one wheel item (matches CSS)
    const DIM_GAIN = 2.2;   // drag-scrub travels a little faster than the finger
    function clearDimCommit() {
        if (dimCommitTimer) { clearTimeout(dimCommitTimer); dimCommitTimer = null; }
    }
    function buildDimPopup(s) {
        const p = document.createElement('div');
        p.className = 'dim-dial-popup is-open';
        const list = document.createElement('div');
        list.className = 'dim-dial-list';
        const bins = s.bins || [];
        s.options.forEach(function(opt) {
            const item = document.createElement('div');
            item.className = 'dim-dial-item' + (bins.indexOf(opt) >= 0 ? ' dim-dial-bin' : '');
            item.textContent = opt;
            list.appendChild(item);
        });
        p.appendChild(list);
        const center = document.createElement('div');
        center.className = 'dim-dial-center';
        p.appendChild(center);
        const r = s.rect;
        // Center the wheel horizontally on the facet button, and vertically on
        // the cursor that opened it — so the current (centered) item sits right
        // under the pointer, and scrolling keeps the new pick under the pointer.
        p.style.left = (r.left + r.width / 2) + 'px';
        p.style.top = s.cursorY + 'px';
        document.body.appendChild(p);
        s.popup = p; s.list = list;
    }
    function updateDimWheel(s) {
        const ty = -(s.index * DIM_ROW_H + DIM_ROW_H / 2);
        s.list.style.transform = 'translateY(' + ty + 'px)';
        const items = s.list.children;
        for (let i = 0; i < items.length; i++) {
            items[i].classList.toggle('current', i === s.index);
        }
    }
    function setDimIndex(s, idx) {
        if (idx < 0) { idx = 0; }
        if (idx > s.options.length - 1) { idx = s.options.length - 1; }
        s.index = idx;
        updateDimWheel(s);
    }
    function closeDimWheel() {
        clearDimCommit();
        if (openDim) {
            if (openDim.popup) { openDim.popup.remove(); }
            openDim = null;
        }
        dimDrag = null;
    }
    // Apply the field the wheel is on. The mode (replace vs accumulate) was fixed
    // when the wheel opened, from whether Shift was held on the facet press.
    function commitDim(s) {
        const column = s.options[s.index];
        const accumulate = s.accumulate;
        closeDimWheel();
        vscodeApi.postMessage({ command: 'groupDimension', column: column, accumulate: !!accumulate });
    }
    function openDimFacet(facetEl, cursorX, cursorY, accumulate) {
        closeDimWheel();
        // Shift held on the facet press = ACCUMULATE: only fields not already in
        // use. No Shift = REPLACE: every available field (current included).
        const attr = accumulate ? 'data-dimfacet-accumulate' : 'data-dimfacet';
        let options;
        try { options = JSON.parse(facetEl.getAttribute(attr)); } catch (_) { return; }
        if (!options || options.length === 0) { return; }
        let bins;
        try { bins = JSON.parse(facetEl.getAttribute('data-dimfacet-bins')) || []; } catch (_) { bins = []; }
        const rect = facetEl.getBoundingClientRect();
        // Fall back to the facet center if no cursor was supplied (e.g. keyboard).
        const cy = (typeof cursorY === 'number') ? cursorY : (rect.top + rect.height / 2);
        // In replace mode, open the wheel ON the current field so it can be changed
        // in place. In accumulate mode the current field isn't listed; start at top.
        const current = accumulate ? null : facetEl.getAttribute('data-dimfacet-current');
        let startIndex = current ? options.indexOf(current) : 0;
        if (startIndex < 0) { startIndex = 0; }
        const s = { facetEl: facetEl, options: options, bins: bins, index: startIndex, rect: rect, cursorY: cy, accumulate: !!accumulate, popup: null, list: null };
        buildDimPopup(s);
        updateDimWheel(s);
        // PRIMARY: mouse-wheel scroll moves the wheel; it does NOT auto-apply.
        // Spin to bring the field you want to the center (under the cursor), then
        // CLICK to select it (handled in the window pointerup below).
        s.popup.addEventListener('wheel', function(ev) {
            ev.preventDefault();
            ev.stopPropagation();
            setDimIndex(s, s.index + (ev.deltaY > 0 ? 1 : -1));
        }, { passive: false });
        // A pointerdown on the wheel begins either a click (select) or a vertical
        // drag-scrub (touch). The pointerup resolves which.
        s.popup.addEventListener('pointerdown', function(ev) {
            ev.stopPropagation();
            clearDimCommit();
            dimDrag = { startY: ev.clientY, startIndex: s.index, dragging: false, shift: ev.shiftKey };
        });
        openDim = s;
    }
    // Press the facet icon → resolve to an open/close tap on release.
    app.addEventListener('pointerdown', function(e) {
        if (!e.target.closest) { return; }
        // The × on a dim chip removes it via the click handler — never open.
        if (e.target.closest('.dim-chip-x')) { return; }
        const fac = e.target.closest('[data-dimfacet]');
        if (!fac) { return; }
        e.preventDefault();
        // Capture Shift NOW: it picks REPLACE vs ACCUMULATE (and which field list)
        // for the wheel this press opens.
        dimPress = { el: fac, x: e.clientX, y: e.clientY, shift: e.shiftKey };
    });
    window.addEventListener('pointermove', function(e) {
        if (!dimDrag || !openDim) { return; }
        const s = openDim;
        const dy = e.clientY - dimDrag.startY;
        if (!dimDrag.dragging) {
            if (Math.abs(dy) < DRAG_THRESHOLD) { return; }
            dimDrag.dragging = true;
        }
        dimDrag.shift = e.shiftKey;
        // Drag UP advances toward later options (matches the measure dial).
        setDimIndex(s, dimDrag.startIndex - Math.round(dy * DIM_GAIN / DIM_ROW_H));
    });
    window.addEventListener('pointerup', function(e) {
        // Facet icon tap → toggle the wheel open/closed.
        if (dimPress) {
            const moved = Math.abs(e.clientX - dimPress.x) > DRAG_THRESHOLD
                || Math.abs(e.clientY - dimPress.y) > DRAG_THRESHOLD;
            const el = dimPress.el;
            const dimPressShift = dimPress.shift;
            dimPress = null;
            // Swallow the trailing click so the facet press never triggers the
            // bubble's own action (clear grouping / pop to root).
            suppressClick = true;
            if (!moved) {
                if (openDim && openDim.facetEl === el) { closeDimWheel(); }
                else { openDimFacet(el, e.clientX, e.clientY, dimPressShift); }
                return;
            }
        }
        // Pointerup on the open wheel: a CLICK selects the field, a DRAG (touch)
        // releases onto the centered field.
        if (dimDrag) {
            const s = openDim;
            const wasDragging = dimDrag.dragging;
            dimDrag = null;
            if (s) {
                if (!wasDragging) {
                    // A click — select whichever item was clicked (the centered one
                    // sits under the cursor; clicking another picks it directly).
                    const item = e.target.closest && e.target.closest('.dim-dial-item');
                    if (item) {
                        const items = s.list.children;
                        for (let i = 0; i < items.length; i++) {
                            if (items[i] === item) { setDimIndex(s, i); break; }
                        }
                    }
                }
                commitDim(s);
            }
        }
    });

    // Event delegation survives innerHTML swaps.
    app.addEventListener('click', function(e) {
        if (suppressClick) { suppressClick = false; return; }
        const el = e.target.closest ? e.target.closest('[data-action]') : null;
        if (!el) {
            // A click that hit no actionable element = clicking "nothing":
            // clear any current focus (so you can deselect without re-clicking
            // the exact bubble). The extension ignores this when nothing's focused.
            vscodeApi.postMessage({ command: 'clearFocus' });
            return;
        }
        const action = el.getAttribute('data-action');
        if (action === 'removeDimension') {
            vscodeApi.postMessage({ command: 'removeDimension', column: el.getAttribute('data-col') });
        } else if (action === 'toggleDimension') {
            vscodeApi.postMessage({ command: 'toggleDimension', column: el.getAttribute('data-col') });
        } else if (action === 'toggleMeasure') {
            vscodeApi.postMessage({ command: 'toggleMeasure', column: el.getAttribute('data-col') });
        } else if (action === 'focusBubble') {
            vscodeApi.postMessage({ command: 'focusBubble', key: el.getAttribute('data-key'), shift: e.shiftKey });
        } else if (action === 'descendBubble') {
            vscodeApi.postMessage({ command: 'descendBubble', key: el.getAttribute('data-key') });
        } else if (action === 'clearFocus') {
            vscodeApi.postMessage({ command: 'clearFocus' });
        } else if (action === 'drillDimension') {
            vscodeApi.postMessage({ command: 'drillDimension', column: el.getAttribute('data-col') });
        } else if (action === 'popDrill') {
            vscodeApi.postMessage({ command: 'popDrill', index: el.getAttribute('data-index') });
        } else if (action === 'reopenCloud') {
            vscodeApi.postMessage({ command: 'reopenCloud', index: el.getAttribute('data-index') });
        } else if (action === 'focusLayer') {
            vscodeApi.postMessage({ command: 'focusLayer', index: el.getAttribute('data-index') });
        } else if (action === 'popToRoot') {
            vscodeApi.postMessage({ command: 'popToRoot' });
        } else if (action === 'setViewMode') {
            vscodeApi.postMessage({ command: 'setViewMode', mode: el.getAttribute('data-mode') });
        } else if (action === 'toggleRecords') {
            vscodeApi.postMessage({ command: 'toggleRecords' });
        }
    });

    // Sticky bloom: hovering a category opens it and it stays open (so you can
    // cross empty space to reach its member dots) until another category is
    // hovered, the hub is left, or a selection re-renders the body.
    let openCat = null;
    function closeBloom() {
        if (openCat) { openCat.classList.remove('open'); openCat = null; }
    }
    app.addEventListener('mouseover', function(e) {
        const cat = e.target.closest ? e.target.closest('.cat-nub') : null;
        if (cat) {
            if (openCat !== cat) { closeBloom(); cat.classList.add('open'); openCat = cat; }
            return;
        }
        // Hovering anything outside the open category, but still inside its hub,
        // keeps it open; leaving the hub entirely closes it.
        if (openCat) {
            const hub = e.target.closest ? e.target.closest('.bubble-hub, .locked-hub') : null;
            if (!hub) { closeBloom(); }
        }
    });
    app.addEventListener('mouseleave', function() { closeBloom(); });

    // Plays the post-drop depth-stack transition: place each ghost layer at its
    // FROM geometry (one level closer on a drill, one further on a back), flush the
    // layout, then restore the target geometry so the CSS transition eases each
    // layer into its new depth. The drag itself stays un-animated.
    //
    // delay (ms) holds the layers parked at FROM before releasing, so on a detach
    // drill the bubble-emerge can lead and the receding background doesn't compete
    // with (and visually skew) where the grow appears to start.
    function playGhostTransition(delay) {
        const layers = app.querySelectorAll('.ghost-layer[data-from]');
        if (!layers.length) { return; }
        const items = [];
        for (let i = 0; i < layers.length; i++) {
            const el = layers[i];
            const parts = (el.getAttribute('data-from') || '').split('|');
            // Stash the TARGET (already in the inline style) before overwriting it.
            items.push({
                el: el,
                toTransform: el.style.transform, toFilter: el.style.filter, toOpacity: el.style.opacity,
                fromTransform: parts[0] || '', fromFilter: parts[1] || '', fromOpacity: parts[2] || '1'
            });
        }
        // 1) Jump to FROM with transitions suppressed.
        items.forEach(function(it) {
            it.el.style.transition = 'none';
            it.el.style.transform = it.fromTransform;
            it.el.style.filter = it.fromFilter;
            it.el.style.opacity = it.fromOpacity;
        });
        // 2) Force a reflow so the FROM values are committed as the starting point.
        void app.offsetWidth;
        // 3) Release to TARGET — clearing the inline transition restores the CSS
        //    rule (.ghost-layer transitions over .35s), which eases. Optionally
        //    after a short hold so the bubble-emerge leads.
        const release = function() {
            items.forEach(function(it) {
                it.el.style.transition = '';
                it.el.style.transform = it.toTransform;
                it.el.style.filter = it.toFilter;
                it.el.style.opacity = it.toOpacity;
                it.el.removeAttribute('data-from');
            });
        };
        if (delay > 0) { setTimeout(release, delay); } else { release(); }
    }

    // On a put-back, the cloud coming forward is the LIVE card (not a ghost layer),
    // so animate it from the nearest-ghost depth into its resting (front) position —
    // otherwise it just pops in. Same snap-to-FROM → reflow → release technique.
    function playCardTransition() {
        const card = app.querySelector('.card[data-card-from]');
        if (!card) { return; }
        const parts = (card.getAttribute('data-card-from') || '').split('|');
        card.style.transition = 'none';
        card.style.transform = parts[0] || '';
        card.style.filter = parts[1] || '';
        card.style.opacity = parts[2] || '1';
        void app.offsetWidth;
        card.style.transition = '';
        card.style.transform = '';      // resting front position (identity)
        card.style.filter = '';
        card.style.opacity = '';
        card.removeAttribute('data-card-from');
    }

    // After a detach drop the new working hub (the full purple bubble) should look
    // like it GREW from where you let the dragged bubble go — not just blink into
    // the centre while the depth stack recedes behind it.
    //
    // The robust way is to animate a position:FIXED clone of the hub, not the real
    // hub itself. The real hub lives inside the SCROLLED scene (and inside
    // .scene-plane, which establishes a perspective/containing block), so a CSS
    // transform on it lives in CONTENT space — any scroll (or that containing
    // block) between measure and paint reintroduces an offset, which is exactly the
    // "starts from the wrong place, proportional to scroll" symptom. A fixed clone
    // on <body> is in pure VIEWPORT space — the same space as the pointer's
    // clientX/clientY drop point and as getBoundingClientRect — so it is immune to
    // scroll and to ancestor transforms. (This mirrors the drag-ghost, which is
    // also fixed and tracked the cursor perfectly.)
    //
    // A detach renders TWICE (loading → settled), and each render rebuilds the hub,
    // so we keep the REAL hub hidden until the clone lands, then reveal it — no
    // centre flash on either render. The released drag-ghost is already at the full
    // hub size (it grew on arm), so the clone only TRANSLATES from the drop point to
    // the resting hub — no scale change.
    function hideRealHub() {
        const bubble = app.querySelector('.card .bubble-active');
        if (bubble) { bubble.style.visibility = 'hidden'; }
    }
    function playBubbleEmerge(drop) {
        const bubble = app.querySelector('.card .bubble-active');
        if (!bubble) { return; }
        bubble.style.visibility = 'hidden';
        // Settle the scroll to its FINAL resting state BEFORE measuring/animating.
        // After a drill the short new-hub layout scrolls back toward the top; if we
        // animate first and that scroll lands afterwards, the hub jumps out from
        // under the clone (the "broken" re-draw the user saw). The drop point is a
        // fixed VIEWPORT pixel (clientX/Y) and is unaffected by scrolling, so it
        // still maps to where the finger let go. Scroll both the window and any
        // scrollable ancestor of the hub to the top so the hub's resting viewport
        // position is final.
        window.scrollTo(0, 0);
        let node = bubble.parentNode;
        while (node && node.nodeType === 1 && node !== document.body) {
            if (node.scrollTop) { node.scrollTop = 0; }
            node = node.parentNode;
        }
        // Measure the hub's resting viewport rect on the NEXT frame, once the
        // settled layout AND the scroll reset above have committed.
        requestAnimationFrame(function() {
            const rect = bubble.getBoundingClientRect();
            if (!rect.width) { bubble.style.visibility = ''; return; }
            const targetX = rect.left + rect.width / 2;   // viewport centre of the resting hub
            const targetY = rect.top + rect.height / 2;
            // A fixed clone, styled like the hub, pinned at the DROP point (viewport).
            const clone = bubble.cloneNode(true);
            clone.style.position = 'fixed';
            clone.style.margin = '0';
            clone.style.left = drop.x + 'px';
            clone.style.top = drop.y + 'px';
            clone.style.width = rect.width + 'px';
            clone.style.height = rect.height + 'px';
            clone.style.zIndex = '900';
            clone.style.pointerEvents = 'none';
            clone.style.visibility = 'visible';
            clone.style.transformOrigin = 'center center';
            clone.style.transition = 'none';
            // Centre the clone on the drop point. It's already at full hub size (the
            // drag-ghost grew to that on arm), so no initial scale — just position.
            clone.style.transform = 'translate(-50%, -50%)';
            document.body.appendChild(clone);
            void clone.offsetWidth;   // commit the FROM state
            // Glide to the hub's resting centre. tx/ty are viewport deltas, so the
            // clone arrives exactly where the real hub sits.
            const tx = targetX - drop.x;
            const ty = targetY - drop.y;
            clone.style.transition = 'transform .55s cubic-bezier(.18,.85,.25,1.08)';
            clone.style.transform = 'translate(calc(-50% + ' + tx + 'px), calc(-50% + ' + ty + 'px))';
            let finished = false;
            const done = function() {
                if (finished) { return; }
                finished = true;
                if (clone.parentNode) { clone.parentNode.removeChild(clone); }
                bubble.style.visibility = '';   // hand off to the real hub
            };
            clone.addEventListener('transitionend', done);
            setTimeout(done, 700);   // safety net if transitionend doesn't fire
        });
    }

    // Bloom the freshly-grouped cloud: every child bubble emanates (scale up + fade
    // in) OUT of the parent hub to its resting place, like petals opening. Runs on
    // the settled render after a grouping is picked.
    //
    // Both the hub and the cloud bubbles live in the SAME (scene) coordinate space,
    // so the per-bubble offset from the hub is just the difference of their
    // getBoundingClientRect centres — scroll-invariant (both rects shift together)
    // and unaffected by perspective (the live card isn't projected at rest). No
    // fixed clones needed here, unlike the hub emerge which bridged viewport↔scene.
    const BLOOM_STAGGER = 220;   // ms spread from the innermost to the outermost ring
    function playCloudBloom() {
        const hub = app.querySelector('.card .drill-spine .bubble');
        const bubbles = app.querySelectorAll('.card .value-area .flower .bubble');
        if (!hub || !bubbles.length) { return; }
        const hr = hub.getBoundingClientRect();
        const hx = hr.left + hr.width / 2;
        const hy = hr.top + hr.height / 2;
        // Measure every bubble first (one layout read), capturing its offset from the
        // hub and its distance (for a radial, expanding-ring stagger).
        const items = [];
        let maxDist = 1;
        for (let i = 0; i < bubbles.length; i++) {
            const b = bubbles[i];
            const r = b.getBoundingClientRect();
            const dx = (r.left + r.width / 2) - hx;
            const dy = (r.top + r.height / 2) - hy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > maxDist) { maxDist = dist; }
            items.push({ el: b, dx: dx, dy: dy, dist: dist });
        }
        // Park each bubble AT the hub (translate back by its offset) shrunk + faded,
        // transitions suppressed.
        items.forEach(function(it) {
            it.el.style.transformOrigin = 'center center';
            it.el.style.transition = 'none';
            it.el.style.transform = 'translate(' + (-it.dx) + 'px,' + (-it.dy) + 'px) scale(0.1)';
            it.el.style.opacity = '0';
        });
        void app.offsetWidth;   // commit the FROM state for all at once
        // Release each to its resting place, delayed by its ring (inner first) so the
        // cloud blooms outward. Clear the inline overrides once done so hover/focus
        // styling isn't pinned by a stale transition.
        items.forEach(function(it) {
            const delay = (it.dist / maxDist) * BLOOM_STAGGER;
            it.el.style.transition = 'transform .4s cubic-bezier(.2,.7,.3,1) ' + delay + 'ms, opacity .3s ease-out ' + delay + 'ms';
            it.el.style.transform = '';
            it.el.style.opacity = '';
            setTimeout(function() {
                it.el.style.transition = '';
                it.el.style.transformOrigin = '';
            }, delay + 450);
        });
    }

    // Collapse the open cloud back INTO the parent hub — the inverse of the bloom,
    // played when a chip is removed and the level falls back to a single ungrouped
    // bubble. The old cloud bubbles are about to be destroyed by the innerHTML swap
    // (and a later settled render swaps again), so we can't animate them in place.
    // Instead we snapshot each as a position:fixed CLONE on <body> (pure viewport
    // space, immune to the swaps, scroll and perspective — same trick as the hub
    // emerge), then glide the clones into the hub's resting centre and fade them.
    //
    // Returns a starter fn to call AFTER the swap, so the hub centre is measured on
    // the NEW (ungrouped) layout where the single bubble has settled. Returns null
    // when there's nothing to collapse (e.g. table view has no flower bubbles).
    const COLLAPSE_STAGGER = 180;   // ms spread; outer rings leave first, all arrive together
    function snapshotCloudCollapse() {
        const bubbles = app.querySelectorAll('.card .value-area .flower .bubble');
        if (!bubbles.length) { return null; }
        // Clone each bubble at its current viewport rect, frozen on the body.
        const clones = [];
        for (let i = 0; i < bubbles.length; i++) {
            const b = bubbles[i];
            const r = b.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) { continue; }
            const clone = b.cloneNode(true);
            clone.style.position = 'fixed';
            clone.style.margin = '0';
            clone.style.left = r.left + 'px';
            clone.style.top = r.top + 'px';
            clone.style.width = r.width + 'px';
            clone.style.height = r.height + 'px';
            clone.style.zIndex = '880';
            clone.style.pointerEvents = 'none';
            clone.style.transformOrigin = 'center center';
            clone.style.transition = 'none';
            clone.style.transform = 'translate(0,0) scale(1)';
            document.body.appendChild(clone);
            clones.push({ el: clone, cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
        }
        if (!clones.length) { return null; }
        // The starter, run post-swap once the new single hub bubble has its place.
        return function startCollapse() {
            const hub = app.querySelector('.card .drill-spine .bubble');
            const hr = hub ? hub.getBoundingClientRect() : null;
            // Fall back to the screen centre if the hub somehow isn't there yet.
            const hx = hr ? hr.left + hr.width / 2 : window.innerWidth / 2;
            const hy = hr ? hr.top + hr.height / 2 : window.innerHeight / 2;
            let maxDist = 1;
            clones.forEach(function(c) {
                c.dx = hx - c.cx;
                c.dy = hy - c.cy;
                c.dist = Math.sqrt(c.dx * c.dx + c.dy * c.dy);
                if (c.dist > maxDist) { maxDist = c.dist; }
            });
            void document.body.offsetWidth;   // commit the FROM state
            clones.forEach(function(c) {
                // Outermost (farthest) leave first so the ring contracts inward and
                // everything lands on the hub together.
                const delay = (1 - c.dist / maxDist) * COLLAPSE_STAGGER;
                c.el.style.transition = 'transform .42s cubic-bezier(.5,0,.3,1) ' + delay + 'ms, opacity .42s ease-in ' + delay + 'ms';
                c.el.style.transform = 'translate(' + c.dx + 'px,' + c.dy + 'px) scale(0.1)';
                c.el.style.opacity = '0';
                let finished = false;
                const done = function() {
                    if (finished) { return; }
                    finished = true;
                    if (c.el.parentNode) { c.el.parentNode.removeChild(c.el); }
                };
                c.el.addEventListener('transitionend', done);
                setTimeout(done, delay + 700);   // safety net
            });
        };
    }

    window.addEventListener('message', function(event) {
        const msg = event.data;
        if (msg && msg.command === 'render') {
            closeBloom();
            // Snapshot the closing cloud BEFORE the swap destroys it (clones live on
            // <body>, so they survive this and the later settled render).
            const startCollapse = msg.collapse ? snapshotCloudCollapse() : null;
            app.innerHTML = msg.html;
            // Measure the hub on the fresh layout, then contract the clones into it.
            if (startCollapse) { startCollapse(); }
            // Keep the newest step (right edge) of the path strip in view when the
            // chain outgrows the fixed rail.
            const strip = app.querySelector('[data-path-strip]');
            if (strip) { strip.scrollLeft = strip.scrollWidth; }
            // Post-drop depth-stack transition: each ghost layer carries a data-from
            // (its one-level-off start geometry). Snap to FROM with transitions off,
            // force a reflow, then release to the target so CSS eases it into place —
            // a clean "layers step back / forward" move without animating the drag.
            // On a put-back the incoming live card also animates forward from depth.
            if (msg.transition) {
                // Detach drill: the new hub grows in from the drop point while the
                // depth stack recedes — both at once now that the emerge runs in a
                // stable scroll state (no longer competing, so no stagger needed).
                const emerging = msg.transition === 'drill' && pendingDrop;
                playGhostTransition(0);
                playCardTransition();
                if (emerging) { playBubbleEmerge(pendingDrop); }
                pendingDrop = null;
            } else if (pendingDrop) {
                // Intermediate LOADING render after a detach drop (no transition yet):
                // hide the freshly-built hub so it doesn't flash at full size in the
                // centre — the settled 'drill' render then animates a fixed clone in
                // from the drop point and reveals the real hub when it lands.
                hideRealHub();
            }
            // A freshly grouped cloud blooms out of the parent hub (independent of
            // the depth-stack transition — a grouping pick is not a stack step).
            if (msg.bloom) { playCloudBloom(); }
        }
    });

    vscodeApi.postMessage({ command: 'ready' });
})();
</script>
</body>
</html>`;
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Bracket-quotes a Kusto identifier (table/column name), escaping the literal. */
function bracket(name: string): string {
    const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `['${escaped}']`;
}

/**
 * Renders a drill-lock value as a Kusto literal for a `==` predicate. Numbers
 * and booleans pass through; everything else is emitted as a quoted string
 * literal (the dimensions we drill on are string/bool/low-cardinality, never
 * datetime — those carry the 'time' role and aren't offered as drill nubs).
 */
function kustoLiteral(value: unknown, type?: string): string {
    const t = (type ?? '').toLowerCase();
    // A binned datetime/date key locks as a range bound, so it must emit a real
    // datetime literal (not a quoted string) for `col >= lo and col < lo + size`.
    if (/datetime|date/.test(t) && !(typeof value === 'number')) {
        return `todatetime('${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')`;
    }
    if (typeof value === 'number') { return Number.isFinite(value) ? String(value) : '0'; }
    if (typeof value === 'boolean') { return value ? 'true' : 'false'; }
    const s = String(value);
    if (/(int|long|real|double|decimal)/.test(t)) {
        const n = Number(s);
        if (Number.isFinite(n)) { return String(n); }
    }
    if (/bool/.test(t) && (s === 'true' || s === 'false')) { return s; }
    return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Timespan bin ladder (token + milliseconds), smallest to largest. */
const TIME_BIN_LADDER: Array<{ token: string; ms: number }> = [
    { token: '1m', ms: 60_000 },
    { token: '5m', ms: 5 * 60_000 },
    { token: '15m', ms: 15 * 60_000 },
    { token: '1h', ms: 3_600_000 },
    { token: '6h', ms: 6 * 3_600_000 },
    { token: '1d', ms: 86_400_000 },
    { token: '7d', ms: 7 * 86_400_000 },
    { token: '30d', ms: 30 * 86_400_000 },
    { token: '90d', ms: 90 * 86_400_000 },
    { token: '365d', ms: 365 * 86_400_000 },
];

/** Picks a timespan bin token so a range spans ~24-40 buckets (the smallest
 *  ladder step whose bucket count fits), defaulting to the coarsest on overflow. */
function pickTimeBin(rangeMs: number): string {
    for (const step of TIME_BIN_LADDER) {
        if (rangeMs / step.ms <= 40) { return step.token; }
    }
    return TIME_BIN_LADDER[TIME_BIN_LADDER.length - 1]!.token;
}

/** Builds the bin-size options offered by a binned chip's dial. Time columns get
 *  the timespan ladder (1m…365d); numeric columns get a 1-2-5×10ⁿ ladder spanning
 *  a couple of magnitudes around the current size. The current size is always
 *  included so the wheel can open centered on it. Returned ascending. */
function binSizeOptions(type: string | undefined, current: string): string[] {
    const t = (type ?? '').toLowerCase();
    if (/datetime|date|timespan|time/.test(t)) {
        return TIME_BIN_LADDER.map(s => s.token);
    }
    const opts: string[] = [];
    const cur = parseFloat(current);
    if (Number.isFinite(cur) && cur > 0) {
        const baseExp = Math.floor(Math.log10(cur));
        for (let e = baseExp - 2; e <= baseExp + 2; e++) {
            const mag = Math.pow(10, e);
            for (const m of [1, 2, 5]) {
                const v = m * mag;
                opts.push(Number.isInteger(v) ? String(v) : String(parseFloat(v.toPrecision(6))));
            }
        }
    }
    if (!opts.includes(current)) { opts.push(current); }
    return Array.from(new Set(opts)).sort((a, b) => parseFloat(a) - parseFloat(b));
}

/** Picks a numeric bin size snapped to a 1-2-5×10ⁿ ladder, targeting ~30 buckets. */
function pickNumericBin(range: number): string {
    const raw = range / 30;
    if (!(raw > 0)) { return '1'; }
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    const size = step * mag;
    // Keep integer sizes integer; otherwise trim float noise.
    return Number.isInteger(size) ? String(size) : String(parseFloat(size.toPrecision(6)));
}

/** Renders a binned bucket's lock value as a compact label showing just the
 *  bucket START (e.g. "2026-06-03" for a 1d time bin, "100" for a numeric bin).
 *  The start alone identifies the bucket once they're laid out in order, and the
 *  bin size is shown separately; the full range lives in the hover title. */
function binRangeLabel(value: unknown, size: string, type?: string): string {
    const t = (type ?? '').toLowerCase();
    if (/datetime|date/.test(t)) {
        return compactDateTime(value, size);
    }
    const lo = Number(value);
    if (Number.isFinite(lo)) {
        return formatCell(lo);
    }
    return formatCell(value);
}

/**
 * Formats a datetime as compactly as the data allows so it fits a bubble label.
 * Parses the ISO string by TEXT (never via `new Date()`) so there is no timezone
 * interpretation: the output is a faithful truncation of the stored value and
 * always agrees with the raw table. When a bin size token is given, the bucket
 * WIDTH sets the precision (1d → date only, 1h → to the hour, minutes → to the
 * minute). With no size, trailing zero components are trimmed. Falls back to
 * formatCell for anything that isn't an ISO-ish datetime string.
 */
function compactDateTime(value: unknown, sizeToken?: string): string {
    const p = parseIsoParts(value);
    if (!p) { return formatCell(value); }
    const date = `${p.y}-${p.mo}-${p.d}`;
    const sm = sizeToken ? /^(\d+)(m|h|d)$/.exec(sizeToken) : null;
    if (sm) {
        // Bin width drives precision: never show finer than the bucket's unit.
        const unit = sm[2];
        if (unit === 'd') { return date; }
        if (unit === 'h') { return `${date} ${p.h}:00`; }
        return `${date} ${p.h}:${p.mi}`; // minutes
    }
    // No bin context: drop trailing zero components.
    if (p.h === '00' && p.mi === '00' && p.s === '00' && p.ms === 0) { return date; }
    if (p.s === '00' && p.ms === 0) { return `${date} ${p.h}:${p.mi}`; }
    if (p.ms === 0) { return `${date} ${p.h}:${p.mi}:${p.s}`; }
    return `${date} ${p.h}:${p.mi}:${p.s}.${String(p.ms).padStart(3, '0')}`;
}

/** The FULL bucket range for a binned datetime, "start – end" (end = start +
 *  size), each formatted at the bin's precision. Used for the locked bubble's
 *  hover title so the complete window is available even though the body shows
 *  just the compact start. End is computed in UTC from the parsed parts (no local
 *  timezone drift). Falls back to the compact start when it can't be widened. */
function binRangeFull(value: unknown, size: string, type?: string): string {
    const t = (type ?? '').toLowerCase();
    if (/datetime|date/.test(t)) {
        return binSpanRangeDatetime(value, value, size);
    }
    const lo = Number(value);
    const step = Number(size);
    if (Number.isFinite(lo) && Number.isFinite(step)) {
        return `${formatCell(lo)}–${formatCell(lo + step)}`;
    }
    return formatCell(value);
}

/** A datetime bin range "start – end" where the END drops every leading
 *  component it SHARES with the start, so a same-year (or same-month, same-day)
 *  range never repeats that context — e.g. "2026-06-03 – 05" instead of
 *  "2026-06-03 – 2026-06-05", or "2026-06-03 14:00 – 15:00" for a same-day hour
 *  span. This is the ISO 8601 §4.4.2 / CLDR interval convention. `loStart` is the
 *  first bucket's start and `hiStart` the last bucket's start (equal for a single
 *  bucket); the end is `hiStart + size`. Falls back to the bare start when the
 *  value or size can't be parsed (so it never invents a window). */
function binSpanRangeDatetime(loStart: unknown, hiStart: unknown, size: string): string {
    const start = compactDateTime(loStart, size);
    const ps = parseIsoParts(loStart);
    const ph = parseIsoParts(hiStart);
    const ms = timespanToMs(size);
    if (!ps || !ph || ms === null) { return start; }
    const hiStartMs = Date.UTC(Number(ph.y), Number(ph.mo) - 1, Number(ph.d), Number(ph.h), Number(ph.mi), Number(ph.s), ph.ms);
    const endIso = new Date(hiStartMs + ms).toISOString();
    const pe = parseIsoParts(endIso);
    const end = pe ? elideDatetimeRangeEnd(ps, pe, size) : compactDateTime(endIso, size);
    return `${start} – ${end}`;
}

/** The END term of a datetime range with its leading components elided relative
 *  to the start (`ps`). Date fields are dropped field-by-field down to the first
 *  that differs (year → month → day), the ISO 8601 truncated-interval form. The
 *  TIME, when the bin carries one, is treated as a block: shown whole when the
 *  calendar day is shared (date elided entirely → "15:00"), otherwise the end's
 *  full date precedes it (so a cross-midnight hour bin reads "… – 2026-06-04
 *  00:00", never a bare-day "04 00:00"). Never field-elides a time (a lone
 *  "– 06" minute would be unreadable). */
function elideDatetimeRangeEnd(
    ps: { y: string; mo: string; d: string; h: string; mi: string; s: string; ms: number },
    pe: { y: string; mo: string; d: string; h: string; mi: string; s: string; ms: number },
    sizeToken: string,
): string {
    const sm = /^(\d+)(m|h|d)$/.exec(sizeToken);
    const unit = sm ? sm[2] : '';
    const showHour = unit === 'h' || unit === 'm';
    const showMin = unit === 'm';
    const sameY = ps.y === pe.y;
    const sameMo = sameY && ps.mo === pe.mo;
    const sameD = sameMo && ps.d === pe.d;
    if (showHour) {
        const time = showMin ? `${pe.h}:${pe.mi}` : `${pe.h}:00`;
        return sameD ? time : `${pe.y}-${pe.mo}-${pe.d} ${time}`;
    }
    if (!sameY) { return `${pe.y}-${pe.mo}-${pe.d}`; }
    if (!sameMo) { return `${pe.mo}-${pe.d}`; }
    return pe.d;
}

/** The min and max bucket START among a set of selected bucket values, ordered
 *  by chronological/numeric value (datetime parsed by Date.parse, numbers by
 *  Number). Used to scope a multi-select RANGE lock to [lo, hi + size). */
function orderedBounds(values: unknown[], type?: string): { lo: unknown; hi: unknown } {
    const t = (type ?? '').toLowerCase();
    const isTime = /datetime|date/.test(t);
    const keyed = values.map(v => ({
        v,
        n: isTime ? Date.parse(String(v)) : Number(v),
    })).filter(k => Number.isFinite(k.n));
    if (keyed.length === 0) { return { lo: values[0], hi: values[values.length - 1] }; }
    let lo = keyed[0]!; let hi = keyed[0]!;
    for (const k of keyed) {
        if (k.n < lo.n) { lo = k; }
        if (k.n > hi.n) { hi = k; }
    }
    return { lo: lo.v, hi: hi.v };
}

/** The END of the last bucket in a multi-select range (its start + size),
 *  formatted compactly. For datetimes the end is the next bucket's start; for
 *  numbers it's start + step. Used for the "start – end" range label. */
function binRangeEndLabel(hiBucketStart: unknown, size: string, type?: string): string {
    const t = (type ?? '').toLowerCase();
    if (/datetime|date/.test(t)) {
        const p = parseIsoParts(hiBucketStart);
        const ms = timespanToMs(size);
        if (!p || ms === null) { return binRangeLabel(hiBucketStart, size, type); }
        const startMs = Date.UTC(Number(p.y), Number(p.mo) - 1, Number(p.d), Number(p.h), Number(p.mi), Number(p.s), p.ms);
        const endIso = new Date(startMs + ms).toISOString();
        return compactDateTime(endIso, size);
    }
    const lo = Number(hiBucketStart);
    const step = Number(size);
    if (Number.isFinite(lo) && Number.isFinite(step)) {
        return formatCell(lo + step);
    }
    return binRangeLabel(hiBucketStart, size, type);
}

/** Splits an ISO-ish datetime string into zero-padded text parts without any
 *  timezone interpretation. Returns null for non-datetime input. */
function parseIsoParts(value: unknown):
    { y: string; mo: string; d: string; h: string; mi: string; s: string; ms: number } | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(String(value));
    if (!m) { return null; }
    // Fractional seconds: take the first 3 digits as milliseconds (0 when absent).
    const frac = m[7] ? Number((m[7] + '000').slice(0, 3)) : 0;
    return { y: m[1]!, mo: m[2]!, d: m[3]!, h: m[4]!, mi: m[5]!, s: m[6]!, ms: frac };
}

/** Parses a simple Kusto timespan token (e.g. 1m/6h/30d) to milliseconds. */
function timespanToMs(token: string): number | null {
    const m = /^(\d+)(m|h|d)$/.exec(token);
    if (!m) { return null; }
    const n = Number(m[1]);
    const unit = m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000;
    return n * unit;
}


/**
 * Parses a measure result-column header like "Sum of Revenue" into its
 * aggregate glyph, the underlying column name, and whether the aggregate is the
 * implicit default (sum). Falls back to Σ/the raw header for anything unrecognized.
 */
function parseMeasureHeader(header: string): { glyph: string; column: string; isDefault: boolean } {
    for (const kind of AGG_ORDER) {
        const a = AGGREGATES[kind];
        if (header.startsWith(a.prefix)) {
            return { glyph: a.glyph, column: header.slice(a.prefix.length), isDefault: kind === 'sum' };
        }
    }
    return { glyph: AGGREGATES.sum.glyph, column: header, isDefault: true };
}

/** Truncates a label to a maximum length, appending an ellipsis when clipped. */
function truncateLabel(text: string, max: number): string {
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/**
 * The standard bubble body: a title line, the big value, then a caption line of
 * "aggregate glyph + measure column name" (or "# rows" when measuring counts).
 * Every bubble (root, cloud, locked, active) renders the same three lines so the
 * measure shown is always self-describing. Escapes all of its inputs.
 *
 * `contextLabel` (optional) renders a small eyebrow ABOVE the title line naming
 * the dimension column the title value belongs to. The spine's locked/active
 * bubbles pass it so a standalone range like "2026-06-03 – 05" says WHAT it
 * ranges over; cloud bubbles omit it (their floating pill already names the
 * column for the whole field).
 */
function bubbleBody(label: string, valueText: string, aggGlyph: string, measureName: string, dialAttr = '', aggDialAttr = '', showCaption = true, contextLabel = ''): string {
    // The measure dial lives on the caption's NAME span; the aggregate dial lives
    // on the GLYPH span. Both are small, precise ns-resize handles (the rest of the
    // bubble surface is free for click/drag). glyph = HOW you aggregate, name = WHAT.
    // Cloud aggregate bubbles hide the caption (the agg/column is fixed and already
    // shown on their parent hub) and instead let the title wrap to two lines, giving
    // long bin-range / dimension labels more room.
    const contextHtml = contextLabel
        ? `<div class="bubble-context" title="${escapeAttr(contextLabel)}">${escapeHtml(truncateLabel(contextLabel, MAX_MEASURE_NAME_LEN))}</div>`
        : '';
    const labelHtml = showCaption
        ? `<div class="bubble-label">${escapeHtml(label)}</div>`
        : `<div class="bubble-label bubble-label-2">${escapeHtml(label)}</div>`;
    const cap = showCaption
        ? `<div class="bubble-cap" title="${escapeAttr(aggGlyph + ' ' + measureName)}">`
            + `<span class="bubble-agg"${aggDialAttr}><span class="agg-glyph">${escapeHtml(aggGlyph)}</span>`
            + `<span class="agg-label">${escapeHtml(aggLabelFromGlyph(aggGlyph) || aggGlyph)}</span></span>`
            + `<span class="bubble-cap-name"${dialAttr}>${escapeHtml(truncateLabel(measureName, MAX_MEASURE_NAME_LEN))}</span></div>`
        : '';
    return contextHtml
        + labelHtml
        + `<div class="bubble-primary"><span class="bubble-primary-num">${escapeHtml(valueText)}</span></div>`
        + cap;
}

/**
 * Extracts the bits needed to render a result row as a (locked) bubble: its
 * dimension-value label and the single measure shown — the selected numeric
 * column (big value + its glyph/name) or, with no measure, the row count shown
 * as "# rows".
 */
function extractBubbleMetric(
    columns: string[], row: unknown[],
): { label: string; valueText: string; aggGlyph: string; measureName: string } {
    const countIdx = columns.indexOf('Count');
    const measureCols = columns
        .map((name, i) => ({ name, i }))
        .filter(c => isMeasureHeader(c.name));
    const dimIdxs = columns
        .map((name, i) => ({ name, i }))
        .filter(c => c.name !== 'Count' && !isMeasureHeader(c.name))
        .map(c => c.i);

    const count = Number(row[countIdx]) || 0;
    const label = dimIdxs.length > 0
        ? dimIdxs.map(i => formatCell(row[i])).join(' · ')
        : 'All';
    const primaryMeasure = measureCols[0];
    if (primaryMeasure) {
        const pm = parseMeasureHeader(primaryMeasure.name);
        return {
            label,
            valueText: formatMeasureValue(row[primaryMeasure.i]),
            aggGlyph: pm.glyph,
            measureName: pm.column,
        };
    }
    return { label, valueText: formatCompact(count), aggGlyph: '#', measureName: 'rows' };
}

/**
 * Normalizes a list of metric values into [0,1] heat positions (0 = coldest =
 * smallest, 1 = hottest = largest) by VALUE, not rank — so the spread reflects
 * actual magnitude differences rather than how many items there are. A log
 * transform spreads out the small/mid values, which matters for the heavy skew
 * typical of counts (lots of zeros, a few large groups); the minimum (often 0)
 * always maps to the cold end. All-equal values map to the hot end.
 */
function computeHeatValues(values: number[]): number[] {
    const n = values.length;
    if (n === 0) { return []; }
    let min = Infinity;
    let max = -Infinity;
    for (const v of values) {
        if (Number.isFinite(v)) {
            if (v < min) { min = v; }
            if (v > max) { max = v; }
        }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
        // All values equal (or none finite): there's no spread to rank, so show
        // them all at the neutral middle of the ramp (green) rather than "hot".
        return values.map(() => 0.5);
    }
    // log1p over the value's offset from the minimum: gives small/mid values more
    // of the ramp, so a few large groups don't crush everyone else to "cold".
    const denom = Math.log1p(max - min);
    return values.map(v => {
        if (!Number.isFinite(v)) { return 0; }
        return Math.log1p(Math.max(0, v - min)) / denom;
    });
}

/**
 * Maps a heat position t in [0,1] to a sequential cool→hot color: cool/blue for
 * small values, warm/red for large. Hue-interpolated so it reads as an intensity
 * ramp distinct from the categorical role palette (teal/green/purple).
 */
function heatColor(t: number): string {
    const clamped = Math.max(0, Math.min(1, t));
    // Hue 210° (blue, cold) → 0° (red, hot).
    const hue = Math.round(210 * (1 - clamped));
    return `hsl(${hue}, 70%, 55%)`;
}

/**
 * A point on a circle. Angles in degrees, 0° = right, 90° = down (screen coords).
 * Returns hub-relative pixel centers; callers translate by -50% to center.
 */
function anglePoint(center: number, radius: number, deg: number): { x: number; y: number } {
    const rad = (deg * Math.PI) / 180;
    return {
        x: Math.round(center + radius * Math.cos(rad)),
        y: Math.round(center + radius * Math.sin(rad)),
    };
}

function formatNumber(n: number | null): string {
    if (n === null || n === undefined || !Number.isFinite(n)) { return '—'; }
    return n.toLocaleString();
}

/**
 * Compact number formatting for the tight space inside a bubble: large values
 * collapse to K/M/B/T with one decimal (1234567 → "1.2M"), keeping the digits
 * legible. Small/non-finite values fall back to a plain localized number.
 */
function formatCompact(n: number): string {
    if (!Number.isFinite(n)) { return '—'; }
    const abs = Math.abs(n);
    if (abs < 1000) {
        return Number.isInteger(n) ? n.toString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }
    const units: Array<[number, string]> = [
        [1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K'],
    ];
    for (const [scale, suffix] of units) {
        if (abs >= scale) {
            const v = n / scale;
            const s = Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1);
            return s.replace(/\.0$/, '') + suffix;
        }
    }
    return n.toString();
}

/** Compact display of a measure cell: numbers compress to K/M/B; else formatCell. */
function formatMeasureValue(value: unknown): string {
    const n = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(n) && value !== null && value !== '') { return formatCompact(n); }
    return formatCell(value);
}

function formatCell(value: unknown): string {
    if (value === null || value === undefined) { return '(null)'; }
    if (typeof value === 'object') { return JSON.stringify(value); }
    return String(value);
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
    return escapeHtml(s);
}
