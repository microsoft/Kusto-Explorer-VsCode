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
    locks: Array<{ dimension: string; value: unknown }>;
    fromDimensions: string[];
    display: string;
    /** Snapshot of the focused bubble's result row, so the locked node can be
     *  re-rendered as a bubble identical to how it looked when picked. */
    columns: string[];
    row: unknown[];
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
    /** Cloud presentation: 'auto' picks the LOD tier from the row count (and falls
     *  back to the table when too dense); 'table' forces the table regardless. */
    viewMode: 'auto' | 'table';
    /** When the current grouping has more distinct combinations than the explorer
     *  ceiling, the estimated group count (so we show a guidance card instead of a
     *  field and don't query the cloud); null when within the ceiling. */
    tooManyGroups: number | null;
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

/** Geometry of the collapsed bubble "hub" (the bubble plus the space its nubs occupy). */
const HUB_SIZE = 420;
const HUB_CENTER = HUB_SIZE / 2;
/** Radius of the hub bubbles (root/focus are 180px wide → 90px radius). A category
 *  nub's center sits exactly on this edge. */
const BUBBLE_RADIUS = 90;
/** Distance from hub center to a category nub's center — on the bubble edge. */
const NUB_RADIUS = BUBBLE_RADIUS;
/** Radius of the circle (centered on the bubble) that bloomed member dots ride. */
const MEMBER_RADIUS = 156;
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
            selectedMeasures: [],
            selectedAggregate: 'sum',
            totalCount: null,
            totalMeasure: null,
            result: null,
            drillChain: [],
            focusKey: null,
            viewMode: 'auto',
            tooManyGroups: null,
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

    private handleMessage(message: { command?: string; column?: string; key?: string; index?: string; agg?: string; accumulate?: boolean; mode?: string }): void {
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
                    // Toggle focus: clicking the focused bubble again clears it.
                    this.state.focusKey = this.state.focusKey === message.key ? null : message.key;
                    this.render();
                }
                break;
            case 'clearFocus':
                if (this.state) {
                    this.state.focusKey = null;
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
            case 'popToRoot':
                if (this.state) {
                    this.popToRoot();
                }
                break;
            case 'clearGrouping':
                if (this.state) {
                    // Clicking the bubble that owns the open cloud undoes its
                    // dimension selection: the cloud collapses and the level falls
                    // back to a single ungrouped bubble.
                    this.state.selectedDimensions = [];
                    this.state.focusKey = null;
                    void this.runGrouping();
                }
                break;
            case 'groupDimension':
                if (this.state && typeof message.column === 'string' && message.column) {
                    // The bottom dimension facet flung a column down onto the drop
                    // zone. Plain fling REPLACES the grouping; Shift+fling ACCUMULATES
                    // (adds another grouping dimension), preserving combined grouping.
                    if (message.accumulate) {
                        if (!this.state.selectedDimensions.includes(message.column)) {
                            this.state.selectedDimensions.push(message.column);
                        }
                    } else {
                        this.state.selectedDimensions = [message.column];
                    }
                    this.state.focusKey = null;
                    void this.runGrouping();
                }
                break;
            case 'removeDimension':
                if (this.state && typeof message.column === 'string') {
                    // Removing one chip from the active dimension set (the × on a
                    // dim chip). Collapses to ungrouped when the last one goes.
                    const i = this.state.selectedDimensions.indexOf(message.column);
                    if (i >= 0) { this.state.selectedDimensions.splice(i, 1); }
                    this.state.focusKey = null;
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

        if (row && fromDimensions.length > 0) {
            const locks = fromDimensions.map(dim => ({
                dimension: dim,
                value: row[result!.columns.indexOf(dim)],
            }));
            const display = locks.map(l => formatCell(l.value)).join(' · ');
            this.state.drillChain.push({
                locks, fromDimensions, display,
                columns: [...result!.columns], row: [...row],
            });
        }

        this.state.selectedDimensions = newDim ? [newDim] : [];
        this.state.focusKey = null;
        void this.runGrouping();
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
        this.state.drillChain = this.state.drillChain.slice(0, index + 1);
        this.state.selectedDimensions = [];
        this.state.focusKey = null;
        void this.runGrouping();
    }

    /** Pops all the way back to the root, ungrouped (the dimension selection is
     *  cleared so the root falls back to a single bubble). */
    private popToRoot(): void {
        if (!this.state || this.state.drillChain.length === 0) { return; }
        this.state.selectedDimensions = [];
        this.state.drillChain = [];
        this.state.focusKey = null;
        void this.runGrouping();
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
                if (lock.value === null || lock.value === undefined) {
                    predicates.push(`isnull(${col})`);
                } else {
                    const type = this.state.columns.find(c => c.name === lock.dimension)?.type;
                    predicates.push(`${col} == ${kustoLiteral(lock.value, type)}`);
                }
            }
        }
        return predicates.length > 0 ? ` | where ${predicates.join(' and ')}` : '';
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
            const by = crumb.fromDimensions.length > 0
                ? ` by ${crumb.fromDimensions.map(bracket).join(', ')}` : '';
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
        await Promise.all([rootPromise, ...crumbPromises]);
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

        if (dims.length === 0 && measures.length === 0) {
            this.state.result = null;
            // Snapshots may still need to drop a previously-shown measure.
            await this.refreshSnapshots(token);
            if (token !== this.renderToken || !this.state) { return; }
            this.state.loading = false;
            this.render();
            return;
        }

        this.state.loading = true;
        this.state.error = undefined;
        this.state.tooManyGroups = null;
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
                ? `dcount(${bracket(dims[0]!)})`
                : `dcount(strcat(${dims.map(d => `tostring(${bracket(d)})`).join(`, " ~|~ ", `)}))`;
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
        const byClause = dims.length > 0 ? ` by ${dims.map(bracket).join(', ')}` : '';
        // Fetch up to the ceiling, ordered by the metric so any boundary truncation
        // keeps the most significant groups. The VIEW (cloud tier or table) is
        // chosen from the actual row count in valueAreaHtml; cloud tiers re-sort by
        // identity client-side so a bubble keeps its place when only the measure
        // changes. With no dimension it's a single bubble.
        const metricCol = measures.length > 0
            ? bracket(this.measureHeader(measures[0]!)) : bracket('Count');
        const orderClause = dims.length > 0
            ? ` | top ${MAX_GROUP_ROWS} by ${metricCol} desc`
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
        this.panel.webview.postMessage({ command: 'render', html: this.bodyHtml(this.state) });
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
            : (hasGroups ? 'Clear grouping' : state.source);
        // The root carries the measure dial only while it owns the measure choice
        // (i.e. before drilling — once drilled, the deepest bubble owns it).
        const rootDial = drilled ? '' : this.dialAttrs(state, hasMeasure ? measureName : null);
        const rootAggDial = drilled ? '' : this.aggDialAttrs(state);
        // The dimension facet (scrub + fling-to-group) and the active-dimension
        // chips live on the root only while it owns the grouping (before drilling).
        const rootFacet = drilled ? '' : this.dimFacetHtml(state);
        const rootChips = drilled ? '' : this.dimChipsHtml(state);
        const rootHub = `
                <div class="bubble-hub" style="width:${HUB_SIZE}px;height:${HUB_SIZE}px;">
                    <div class="${rootBubbleClass}"${rootAction}
                        title="${escapeAttr(rootTitle)}">
                        ${bubbleBody(state.source, rootValue, aggGlyph, measureName, rootDial, rootAggDial)}
                        ${rootFacet}
                    </div>
                    ${rootChips}
                </div>`;
        // The drop zone is rendered whenever there are cloud bubbles to drag (a
        // dimension grouping exists), not only when one is focused — CSS keeps it
        // hidden until a drag is in flight. This lets you press-and-drag a bubble
        // directly without a focus click first.
        return `
            <div class="card">
                ${this.drillSpineHtml(state, rootHub)}
                ${hasGroups && !isActiveStacked(state)
                    ? `<div class="drop-zone${state.drillChain.length === 0 ? ' drop-zone-root' : ''}" data-dropzone="1"><span class="drop-zone-label">Drop here to drill in</span></div>`
                    : ''}
                ${hasGroups && !isActiveStacked(state) ? `<div class="value-area${drilled ? ' value-area-drilled' : ''}">${this.valueAreaHtml(state)}</div>` : ''}
                ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
            </div>`;
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
        const allDims = selectDimensionNubs(state.columns, state.columns.length)
            .map(c => c.name)
            .filter(n => !used.has(n));
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
        const tip = accumulating
            ? 'Change the breakdown: click, scroll to a field (hold Shift to add another)'
            : 'Break down by a field: click, then scroll to choose';
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
        const chips = state.selectedDimensions.map(d =>
            `<span class="dim-chip" title="${escapeAttr(d)}">`
            + `<span class="dim-chip-label">${escapeHtml(truncateLabel(d, 14))}</span>`
            + `<button class="dim-chip-x" data-action="removeDimension" data-col="${escapeAttr(d)}"`
            + ` title="Remove ${escapeAttr(d)}">\u00d7</button></span>`).join('');
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
        if (!rootHub && state.drillChain.length === 0) { return ''; }
        const nodes: string[] = [];
        if (rootHub) { nodes.push(`<div class="spine-node">${rootHub}</div>`); }
        const active = isActiveStacked(state);
        state.drillChain.forEach((crumb, i) => {
            const isActiveNode = active && i === state.drillChain.length - 1;
            // The link right after the root hub must reach across the hub's reserved
            // lower nub space; links between locked bubbles are the short default.
            // The active node draws its OWN connector (a pseudo-element) and pulls
            // itself up under the preceding bubble, so it gets no separate link.
            // Each connector carries the name of the dimension(s) locked in to reach
            // the bubble it leads into (the bubbles themselves no longer show that
            // as a nub — only the deepest/bottom bubble has nubs now).
            if (nodes.length > 0 && !isActiveNode) {
                const linkClass = (rootHub && i === 0) ? 'spine-link spine-link-root' : 'spine-link';
                nodes.push(`<div class="${linkClass}">${this.linkLabelHtml(crumb)}</div>`);
            }
            // When stacked with no grouping yet (drag gesture), the DEEPEST node is
            // the "active" bubble: a full interactive hub like the root, awaiting a
            // grouping choice. Shallower nodes stay compact and static.
            if (isActiveNode) {
                // The active node following the root hub must clear the root's larger
                // (120px) bloom reserve, not a locked bubble's 10px margin.
                const followsRoot = i === 0;
                nodes.push(`<div class="spine-node">${this.activeBubbleHtml(state, crumb, followsRoot)}</div>`);
            } else {
                const isDeepest = i === state.drillChain.length - 1;
                nodes.push(`<div class="spine-node">${this.lockedBubbleHtml(state, crumb, i, isDeepest)}</div>`);
            }
        });
        return `<div class="drill-spine">${nodes.join('')}</div>`;
    }

    /** The label shown on the connector leading into a bubble: the dimension
     *  column name(s) that were locked in to reach that bubble. */
    private linkLabelHtml(crumb: DrillCrumb): string {
        if (crumb.fromDimensions.length === 0) { return ''; }
        const text = crumb.fromDimensions.join(' · ');
        return `<span class="spine-link-label" title="${escapeAttr(text)}">${escapeHtml(text)}</span>`;
    }

    /**
     * The deepest stacked bubble after a drag gesture: rendered as a full 420px
     * hub (like the root) whose bottom dimension facet picks the next grouping
     * (groupDimension, not a further descent — this bubble is already locked). It
     * is the bottom of the stack — the level you're currently on — so clicking its
     * body does nothing. Already-locked dimensions are excluded from the facet.
     */
    private activeBubbleHtml(state: ExploreState, crumb: DrillCrumb, followsRoot: boolean): string {
        const m = extractBubbleMetric(crumb.columns, crumb.row);
        const linkLabel = crumb.fromDimensions.length > 0
            ? `<span class="spine-link-label active-link-label" title="${escapeAttr(crumb.fromDimensions.join(' · '))}">${escapeHtml(crumb.fromDimensions.join(' · '))}</span>`
            : '';
        const rootCls = followsRoot ? ' bubble-hub-active-root' : '';
        const dial = this.dialAttrs(state, state.selectedMeasures[0] ?? null);
        const aggDial = this.aggDialAttrs(state);
        return `
            <div class="bubble-hub bubble-hub-active${rootCls}" style="width:${HUB_SIZE}px;height:${HUB_SIZE}px;">
                ${linkLabel}
                <div class="bubble bubble-locked bubble-active"
                    title="${escapeAttr(crumb.display)}">
                    ${bubbleBody(m.label, m.valueText, m.aggGlyph, m.measureName, dial, aggDial)}
                    ${this.dimFacetHtml(state)}
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
        const title = isDeepest ? 'Clear grouping' : 'Back to ' + crumb.display;
        return `
            <div class="locked-hub">
                <div class="bubble bubble-locked clickable"${action}
                    title="${escapeAttr(title)}">
                    ${bubbleBody(m.label, m.valueText, m.aggGlyph, m.measureName, dial, aggDial)}
                    ${facet}
                </div>
                ${chips}
            </div>`;
    }

    private valueAreaHtml(state: ExploreState): string {
        // Only show the bare "Loading…" hint on a COLD load (no cloud to show yet).
        // When a cloud is already on screen — e.g. switching the measure re-runs the
        // query — we keep the existing bubbles up and just dim them (`is-refreshing`)
        // so they update in place instead of flashing off to "Loading…" and back.
        if (state.loading && !state.result) {
            return `<div class="hint">Loading…</div>`;
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
        // place when only the measure changes (size/heat carry magnitude). The query
        // returns rows by metric desc (so a safety-cap truncation keeps the most
        // significant), so we re-sort indices alphabetically for layout here. Keys
        // stay the ORIGINAL result-row index (descend/focus index back into it).
        const order = result.rows.map((_r, i) => i);
        if (dimIdxs.length > 0) {
            order.sort((a, b) => {
                for (const di of dimIdxs) {
                    const av = formatCell(result.rows[a]![di]);
                    const bv = formatCell(result.rows[b]![di]);
                    if (av < bv) { return -1; }
                    if (av > bv) { return 1; }
                }
                return 0;
            });
        }

        const bubbles = order.map((rowIdx) => {
            const row = result.rows[rowIdx]!;
            const count = Number(row[countIdx]) || 0;
            const label = dimIdxs.length > 0
                ? dimIdxs.map(i => formatCell(row[i])).join(' · ')
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
                const inner = bubbleBody(label, valueText, aggGlyph, measureName);
                const focusStyle = `border-color:${heat};` + fullFill;
                // The focus slot keeps the SAME footprint as the bubble it replaced
                // (tier-sized) so peers don't shift and no gaps open in a dense
                // cloud; the enlarged hub is an overlay drawn on top of the
                // (already faded) neighbours.
                const slot = LOD_SLOT_PX[tier];
                return `
                    <div class="focus-slot" style="width:${slot}px;height:${slot}px;">
                        <div class="bubble-hub bubble-hub-focus" style="width:${HUB_SIZE}px;height:${HUB_SIZE}px;">
                            <div class="bubble bubble-focus" data-action="clearFocus" style="${focusStyle}" title="Drag down to drill in, or click to unfocus">${inner}</div>
                        </div>
                    </div>`;
            }

            const faded = state.focusKey !== null ? ' faded' : '';

            if (tier === 'full') {
                const inner = bubbleBody(label, valueText, aggGlyph, measureName);
                return `
                    <div class="bubble clickable${faded}" style="${heatStyle}" data-action="focusBubble" data-key="${key}" title="Click to focus, or drag down to drill in">
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
            return `<div class="bubble bubble-${tier} clickable${faded}" style="${heatStyle}" data-action="focusBubble" data-key="${key}" title="${escapeAttr(hover)}">${body}</div>`;
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
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
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
    .value-area { margin-top: 4px; }
    /* When drilled, the cloud follows a compact 180px locked bubble that (unlike
       the 420px root hub) reserves no bloom space below it, so the cloud lands far
       too close. Add the missing reserve (~110px) so the gap matches the original
       root-bubble → cloud distance. These values are the DURING-DRAG layout — they
       leave room for the drop zone to appear without shoving the cloud. */
    .value-area-drilled { margin-top: 114px; }
    /* At REST (no drag in flight) the drop zone is hidden, so the full reserve is
       just dead space — and starting a drag expands the gap anyway, so reserving it
       up front buys no stability. Halve it while idle: pull the root cloud up into
       the hub's empty bloom half, and cut the drilled reserve to ~half. */
    #app:not(.dragging-bubble) .value-area:not(.value-area-drilled) { margin-top: -66px; }
    #app:not(.dragging-bubble) .value-area-drilled { margin-top: 57px; }
    .flower { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: center; }
    /* The compact tiers degrade into a dense heat-field; left edge-to-edge they
       read as a wall of text/dots. Constraining them to a centered column with
       generous side margins implies a "canvas" the field sits on (even though we
       don't draw one) and keeps the cloud feeling like an object, not a fill. The
       cap is generous so a wide panel gets more room, but it never goes full-bleed:
       min() keeps comfortable side gutters on narrow panels. */
    .flower.tier-numeric, .flower.tier-dot {
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

    /* Drop zone: the attach target that appears just below the stack only while
       a focused bubble is being dragged. Dropping on it links (drills in). It's
       drawn as a dashed CIRCLE the size of a locked bubble (the shape it will
       become once attached), centered in the column. Its top sits at the SAME 26px
       gap a real bubble would have once attached. Following a compact locked bubble
       (10px margin) needs +16px; the root hub reserves ~120px of empty bloom space
       below its bubble, so the root-following zone is pulled up to that same gap.
       The actual accepted drop area is larger (see overDropZone in script). */
    .drop-zone { display: none; }
    #app.dragging-bubble .drop-zone {
        display: flex; align-items: center; justify-content: center;
        width: 180px; height: 180px; margin: 16px 0 6px;
        border: 2px dashed color-mix(in srgb, var(--root-accent) 60%, transparent);
        border-radius: 50%;
        background: color-mix(in srgb, var(--root-accent) 6%, transparent);
        transition: background 0.1s, border-color 0.1s;
    }
    #app.dragging-bubble .drop-zone.drop-zone-root { margin-top: -94px; }
    #app.dragging-bubble.over-dropzone .drop-zone {
        border-color: var(--root-accent);
        background: color-mix(in srgb, var(--root-accent) 18%, transparent);
    }
    .drop-zone-label { font-size: 0.8em; opacity: 0.75; pointer-events: none; }
    #app.over-dropzone .drop-zone-label { opacity: 1; }

    /* Cursor-following ghost shown during the drag, so the bubble visibly moves
       toward the drop zone. */
    .drag-ghost {
        position: fixed; z-index: 1000; left: 0; top: 0;
        transform: translate(-50%, -50%);
        min-width: 96px; max-width: 180px; padding: 8px 10px;
        border-radius: 50%; aspect-ratio: 1;
        display: flex; align-items: center; justify-content: center; text-align: center;
        font-size: 0.78em; overflow: hidden;
        border: 2px solid var(--focus-accent);
        background: color-mix(in srgb, var(--focus-accent) 18%, var(--vscode-editorWidget-background));
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5);
        pointer-events: none; opacity: 0.92;
    }
    .bubble-hub-focus .bubble-focus {
        position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
        z-index: 1;
    }
    /* The focused bubble occupies a normal 96px slot in the flow so its peers
       stay put; the larger hub + drill nubs are overlaid on top (and only the
       interactive children capture clicks, so faded peers behind stay clickable). */
    .focus-slot { width: 96px; height: 96px; flex: 0 0 auto; position: relative; }
    .bubble-hub-focus {
        position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
        z-index: 5; pointer-events: none;
    }
    .bubble-hub-focus .bubble-focus,
    .bubble-hub-focus .cat-nub,
    .bubble-hub-focus .cat-bloom,
    .bubble-hub-focus .member { pointer-events: auto; }
    /* Drill spine: the locked ancestor bubbles stacked vertically, centered,
       with a connector line between them — the path you've drilled stays on
       screen as real bubbles (click one to pop back to that level). Locked
       bubbles match the root's purple — they ARE sub-roots of the lineage — and
       carry no heat color (heat belongs to the live cloud you're comparing). */
    .drill-spine { display: flex; flex-direction: column; align-items: center; }
    .spine-node { display: flex; justify-content: center; }
    .spine-link { position: relative; width: 2px; height: 16px; background: color-mix(in srgb, var(--root-accent) 50%, transparent); }
    /* The dimension(s) locked in to reach the bubble below, shown beside the
       connector line (the bubbles no longer carry this as a nub). */
    .spine-link-label {
        position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
        white-space: nowrap; max-width: 160px; overflow: hidden; text-overflow: ellipsis;
        font-size: 0.7em; color: var(--role-dimension); pointer-events: none;
    }
    .active-link-label {
        top: 107px; left: calc(50% + 10px);
    }
    /* The hub reserves ~120px below its centered bubble for the nub bloom space.
       Pull the first locked node up into that zone (negative margin) so it sits
       the SAME short distance under the hub as locked bubbles sit from each other:
       gap = 120 + margin-top + height = 120 - 112 + 18 = 26px. */
    .spine-link-root { height: 18px; margin-top: -112px; }
    .bubble-locked {
        width: 180px; height: 180px;
        font-size: 1.35em;
        border: 3px solid var(--root-accent);
        background: color-mix(in srgb, var(--root-accent) 14%, var(--vscode-editorWidget-background));
    }
    .bubble-locked:hover { box-shadow: 0 1px 6px rgba(0, 0, 0, 0.35); }
    /* A locked spine node: the 120px bubble with its category nubs on the rim. The
       bubble sits ABOVE its nubs (z-index) so each nub is tucked behind it (only
       its outer half peeks out), matching the root/cloud bubbles. The bottom margin
       (10px) + the following spine-link (16px) = a 26px gap to the next bubble,
       matching the root→first gap so every bubble is evenly spaced. */
    .locked-hub { position: relative; width: 180px; height: 180px; margin-bottom: 10px; }
    .locked-hub .bubble-locked { position: relative; z-index: 1; }
    .locked-cat { cursor: default; }
    /* Locked bubbles reveal their interactive nubs on hover, like the big hubs. */
    .locked-hub:hover .cat-nub, .locked-hub .cat-nub.has-selection, .locked-hub .cat-nub:focus {
        opacity: 1; pointer-events: auto; outline: none;
    }
    .bubble-label { font-size: 0.85em; opacity: 0.85; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
        position: absolute; left: 50%; top: calc(50% + 96px); transform: translateX(-50%);
        display: flex; flex-wrap: wrap; gap: 4px; justify-content: center;
        max-width: 260px; z-index: 3;
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
    .dim-chip-x {
        display: inline-flex; align-items: center; justify-content: center;
        width: 14px; height: 14px; padding: 0; border: none; border-radius: 50%;
        background: transparent; color: inherit; opacity: 0.6; cursor: pointer;
        font-size: 1.1em; line-height: 1;
    }
    .dim-chip-x:hover { opacity: 1; background: color-mix(in srgb, var(--role-dimension) 30%, transparent); }

    /* Collapsed bubble "hub": the bubble centered, with category nubs around it. */
    .bubble-hub { position: relative; }
    .bubble-hub .bubble-root {
        position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
        z-index: 1; /* covers the inner half of the nubs tucked behind it */
    }
    /* The active stacked bubble (deepest node after a drag) is centered in its
       hub just like the root, so its interactive nubs lay out around it. */
    .bubble-hub .bubble-active {
        position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
        z-index: 1;
    }
    /* The active hub is a full 420px hub but its bubble is centered, so 120px of
       empty space sits above it (210px hub center − 90px bubble radius). Pull the
       hub up under the preceding bubble so the active bubble lands a 26px gap below
       it (preceding margin-bottom 10 + margin-top + 120 = 26 → margin-top -104), trim
       the empty bottom, then draw the connector ourselves (the preceding link is
       omitted) so the line spans that gap. */
    .bubble-hub-active { margin-top: -104px; margin-bottom: -60px; }
    /* When the active hub follows the ROOT hub (just dropped, nothing locked yet),
       the predecessor reserves 120px of bloom space below its bubble instead of a
       10px margin, so pull up further: 26 − 120 − 120 = -214. */
    .bubble-hub-active-root { margin-top: -214px; }
    .bubble-hub-active::before {
        content: ''; position: absolute; left: 50%; top: 94px;
        transform: translateX(-50%); width: 2px; height: 26px;
        background: var(--root-accent); opacity: 0.5; pointer-events: none;
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

    // Drag-and-drop-to-link gesture: press the focused aggregate bubble and drag
    // it onto the drop zone that appears just below the stack to ATTACH it (drill
    // in). A cursor-following ghost makes the link feel deliberate. Dropping
    // anywhere other than the zone simply deselects (clears focus). The trailing
    // click is suppressed so a drag release doesn't also clear focus.
    let dragState = null;      // { x, y, dragging, ghost }
    let suppressClick = false;
    const DRAG_THRESHOLD = 6;
    function dropZoneRect() {
        const zone = app.querySelector('[data-dropzone]');
        return zone ? zone.getBoundingClientRect() : null;
    }
    function overDropZone(x, y) {
        const r = dropZoneRect();
        if (!r) { return false; }
        // Count it as long as the dragged object (the ghost circle) intersects the
        // drop zone — not just the cursor point. The ghost is centered on the
        // cursor, so derive its box from the ghost element (fallback to a 120px
        // circle around the cursor if it isn't up yet).
        let g = dragState && dragState.ghost ? dragState.ghost.getBoundingClientRect() : null;
        if (!g) {
            const half = 60;
            g = { left: x - half, right: x + half, top: y - half, bottom: y + half };
        }
        return g.left <= r.right && g.right >= r.left
            && g.top <= r.bottom && g.bottom >= r.top;
    }
    app.addEventListener('pointerdown', function(e) {
        if (!e.target.closest) { return; }
        // Either the already-focused aggregate (legacy gesture) OR any cloud
        // bubble directly — press and drag without a focus click first. The cloud
        // bubble carries its row key so the drop can drill straight into it.
        const focus = e.target.closest('.bubble-focus');
        const cloud = e.target.closest('.bubble[data-action="focusBubble"]');
        const target = focus || cloud;
        if (target) {
            // Stop the browser from starting a text selection on the bubble's
            // label/numbers as the pointer drags.
            e.preventDefault();
            dragState = { x: e.clientX, y: e.clientY, dragging: false, ghost: null, label: '',
                key: cloud ? cloud.getAttribute('data-key') : null };
            const lbl = target.querySelector('.bubble-label');
            dragState.label = lbl ? lbl.textContent : '';
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
            document.body.appendChild(g);
            dragState.ghost = g;
        }
        if (dragState.ghost) {
            dragState.ghost.style.left = e.clientX + 'px';
            dragState.ghost.style.top = e.clientY + 'px';
        }
        app.classList.toggle('over-dropzone', overDropZone(e.clientX, e.clientY));
    });
    window.addEventListener('pointerup', function(e) {
        if (dragState && dragState.dragging) {
            const onZone = overDropZone(e.clientX, e.clientY);
            if (dragState.ghost) { dragState.ghost.remove(); }
            app.classList.remove('dragging-bubble', 'over-dropzone');
            suppressClick = true;
            // Dropped on the zone → link (drill in), carrying the dragged bubble's
            // key (null = the already-focused bubble). Dropped elsewhere → deselect.
            vscodeApi.postMessage(onZone
                ? { command: 'descendBubble', key: dragState.key }
                : { command: 'clearFocus' });
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
    // the open-wheel scrub, and a plain commit). kind = 'aggregate' | 'measure'.
    function commitDialChoice(kind, chosen) {
        if (kind === 'aggregate') {
            // Dial labels are Sum/Avg/Min/Max → lowercase to the agg kind.
            vscodeApi.postMessage({ command: 'setAggregate', agg: chosen.toLowerCase() });
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
            commitDialChoice(dialState.kind, chosen);
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
            commitDialChoice(dialState.kind, chosen);
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
        s.options.forEach(function(opt) {
            const item = document.createElement('div');
            item.className = 'dim-dial-item';
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
        const rect = facetEl.getBoundingClientRect();
        // Fall back to the facet center if no cursor was supplied (e.g. keyboard).
        const cy = (typeof cursorY === 'number') ? cursorY : (rect.top + rect.height / 2);
        // In replace mode, open the wheel ON the current field so it can be changed
        // in place. In accumulate mode the current field isn't listed; start at top.
        const current = accumulate ? null : facetEl.getAttribute('data-dimfacet-current');
        let startIndex = current ? options.indexOf(current) : 0;
        if (startIndex < 0) { startIndex = 0; }
        const s = { facetEl: facetEl, options: options, index: startIndex, rect: rect, cursorY: cy, accumulate: !!accumulate, popup: null, list: null };
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
            vscodeApi.postMessage({ command: 'focusBubble', key: el.getAttribute('data-key') });
        } else if (action === 'descendBubble') {
            vscodeApi.postMessage({ command: 'descendBubble', key: el.getAttribute('data-key') });
        } else if (action === 'clearFocus') {
            vscodeApi.postMessage({ command: 'clearFocus' });
        } else if (action === 'drillDimension') {
            vscodeApi.postMessage({ command: 'drillDimension', column: el.getAttribute('data-col') });
        } else if (action === 'popDrill') {
            vscodeApi.postMessage({ command: 'popDrill', index: el.getAttribute('data-index') });
        } else if (action === 'popToRoot') {
            vscodeApi.postMessage({ command: 'popToRoot' });
        } else if (action === 'setViewMode') {
            vscodeApi.postMessage({ command: 'setViewMode', mode: el.getAttribute('data-mode') });
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

    window.addEventListener('message', function(event) {
        const msg = event.data;
        if (msg && msg.command === 'render') {
            closeBloom();
            app.innerHTML = msg.html;
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
    if (typeof value === 'number') { return Number.isFinite(value) ? String(value) : '0'; }
    if (typeof value === 'boolean') { return value ? 'true' : 'false'; }
    const s = String(value);
    const t = (type ?? '').toLowerCase();
    if (/(int|long|real|double|decimal)/.test(t)) {
        const n = Number(s);
        if (Number.isFinite(n)) { return String(n); }
    }
    if (/bool/.test(t) && (s === 'true' || s === 'false')) { return s; }
    return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
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
 */
function bubbleBody(label: string, valueText: string, aggGlyph: string, measureName: string, dialAttr = '', aggDialAttr = ''): string {
    // The measure dial lives on the caption's NAME span; the aggregate dial lives
    // on the GLYPH span. Both are small, precise ns-resize handles (the rest of the
    // bubble surface is free for click/drag). glyph = HOW you aggregate, name = WHAT.
    return `<div class="bubble-label">${escapeHtml(label)}</div>`
        + `<div class="bubble-primary"><span class="bubble-primary-num">${escapeHtml(valueText)}</span></div>`
        + `<div class="bubble-cap" title="${escapeAttr(aggGlyph + ' ' + measureName)}">`
        + `<span class="bubble-agg"${aggDialAttr}><span class="agg-glyph">${escapeHtml(aggGlyph)}</span>`
        + `<span class="agg-label">${escapeHtml(aggLabelFromGlyph(aggGlyph) || aggGlyph)}</span></span>`
        + `<span class="bubble-cap-name"${dialAttr}>${escapeHtml(truncateLabel(measureName, MAX_MEASURE_NAME_LEN))}</span></div>`;
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
        .filter(c => c.name.startsWith('Sum of '));
    const dimIdxs = columns
        .map((name, i) => ({ name, i }))
        .filter(c => c.name !== 'Count' && !c.name.startsWith('Sum of '))
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
