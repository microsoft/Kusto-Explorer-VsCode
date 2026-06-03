// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * The Explore panel — a singleton webview that opens a spatial, balloon-style
 * exploration of a table. The MVP shows ONE card:
 *  - collapsed: a single bubble with the table name and total row count;
 *  - expanded: the table's classified columns (dimensions are selectable) plus
 *    a value area that "flowers" into one bubble per dimension-value group
 *    (each bubble shows that group's count).
 *
 * The extension owns all state and generates the card/bubble HTML as strings.
 * The webview is a thin shell: it acquires the VS Code API, uses event
 * delegation so handlers survive innerHTML swaps, and posts intent messages
 * (toggleExpand / toggleDimension) back to the extension.
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
    collapsed: boolean;
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
    loading: boolean;
    error?: string;
}

/** Cap on rows rendered as bubbles (render-limit, not a query semantics limit). */
const MAX_FLOWER_ROWS = 200;

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
            collapsed: true,
            totalCount: null,
            totalMeasure: null,
            result: null,
            drillChain: [],
            focusKey: null,
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

    private handleMessage(message: { command?: string; column?: string; key?: string; index?: string; agg?: string }): void {
        switch (message?.command) {
            case 'ready':
                this.ready = true;
                this.render();
                break;
            case 'toggleExpand':
                if (this.state) {
                    this.state.collapsed = !this.state.collapsed;
                    this.render();
                }
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
        this.render();

        const aggs = [`${bracket('Count')}=count()`,
            ...measures.map(m => this.measureExpr(m))];
        const byClause = dims.length > 0 ? ` by ${dims.map(bracket).join(', ')}` : '';
        // Drill chain → a `where` that scopes the cloud to the locked-in ancestor
        // bubble values, so each descend narrows to one slice (bounded) rather
        // than exploding the grouping (a cartesian product of dimensions).
        const whereClause = this.buildWhereClause();
        // Position is keyed to the GROUP IDENTITY, not the value: order by the
        // dimension(s) so a given bubble keeps its place when you switch the
        // measure (only its size/heat changes). Size + heat carry magnitude.
        // With no dimension it's a single bubble, so order by the metric.
        const orderClause = dims.length > 0
            ? ` | order by ${dims.map(d => `${bracket(d)} asc`).join(', ')}`
            : ` | order by ${measures.length > 0 ? bracket(this.measureHeader(measures[0]!)) : bracket('Count')} desc`;
        const query = `${bracket(source)}${whereClause} | summarize ${aggs.join(', ')}${byClause}${orderClause}`;

        try {
            const result = await this.server.runQuery(
                query, cluster, database, true, MAX_FLOWER_ROWS,
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
        return state.collapsed ? this.collapsedHtml(state) : this.expandedHtml(state);
    }

    private collapsedHtml(state: ExploreState): string {
        // Count uses the SAME compact format as every other bubble (locked, active,
        // cloud) — they're all the same 120px size, so the root must not show a
        // long localized number where the others show "1.2M".
        const count = state.loading && state.totalCount === null
            ? '…'
            : state.totalCount === null ? '—' : formatCompact(state.totalCount);

        const catsHtml = this.categoryNubsHtml(state);

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
        const rootHub = `
                <div class="bubble-hub" style="width:${HUB_SIZE}px;height:${HUB_SIZE}px;">
                    <div class="${rootBubbleClass}"${rootAction}
                        title="${escapeAttr(rootTitle)}">
                        ${bubbleBody(state.source, rootValue, aggGlyph, measureName, rootDial, rootAggDial)}
                        <button class="thumb" data-action="toggleExpand" title="Open card (show all columns)">
                            <span class="thumb-grip"></span>
                        </button>
                    </div>
                    ${catsHtml}
                </div>`;
        // The drop zone is rendered whenever there are cloud bubbles to drag (a
        // dimension grouping exists), not only when one is focused — CSS keeps it
        // hidden until a drag is in flight. This lets you press-and-drag a bubble
        // directly without a focus click first.
        return `
            <div class="card collapsed">
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
     * Renders the category nubs (dimension, measure) tucked behind the bubble.
     * Each is a stable colored dot that blooms its member nubs in a downward arc
     * on hover; a category with active selections stays lit at rest with a count.
     */
    private categoryNubsHtml(state: ExploreState): string {
        // Once drilled, the root is an ancestor in the stack: it shows no nubs (only
        // the deepest/bottom bubble does). Its grouping appears on the first
        // connector line instead.
        if (state.drillChain.length > 0) { return ''; }

        const categories: NubCategory[] = [];
        const dimNubs = selectDimensionNubs(state.columns, MAX_DIMENSION_NUBS);
        if (dimNubs.length > 0) {
            categories.push({ key: 'dimension', title: 'Group by', action: 'toggleDimension', members: dimNubs, selected: state.selectedDimensions });
        }
        // The measure is chosen via the dial on the bubble surface, not a nub.
        return this.renderCategoryNubs(categories);
    }

    /** Lays out a set of category nubs at their fixed per-kind angles on the bubble
     *  edge. `hubCenter` is the center of the container the nubs ride (default the
     *  420px hub; compact bubbles pass their own half-size). */
    private renderCategoryNubs(categories: NubCategory[], hubCenter: number = HUB_CENTER): string {
        if (categories.length === 0) { return ''; }

        return categories.map((cat) => {
            // Each kind has a FIXED angle so a nub never moves when the number of
            // categories changes; its center rides the bubble edge.
            const catAngle = categoryAngle(cat.key);
            const cp = anglePoint(hubCenter, NUB_RADIUS, catAngle);

            // A static category (the root's locked-in grouping after you've drilled)
            // just shows the chosen name(s) as a lit nub — no interactive bloom.
            if (cat.static) {
                const names = cat.selected;
                const sp = names.length === 1
                    ? `<span class="cat-pinned">${escapeHtml(names[0])}</span>`
                    : names.length > 1 ? `<span class="cat-badge">${names.length}</span>` : '';
                return `<div class="cat-nub cat-${cat.key} has-selection locked-cat"
                    style="left:${cp.x}px;top:${cp.y}px;"
                    title="${escapeAttr(names.join(', '))}">${sp}</div>`;
            }

            const selectedMembers = cat.members.filter(m => cat.selected.includes(m.name));
            const selectedCount = selectedMembers.length;
            // Exactly one pick → show its name below the hub; many → a count badge.
            const pinned = selectedCount === 1
                ? `<span class="cat-pinned">${escapeHtml(selectedMembers[0].name)}</span>`
                : selectedCount > 1 ? `<span class="cat-badge">${selectedCount}</span>` : '';

            // Members are small dots riding a larger circle centered on the BUBBLE,
            // spaced a FIXED angular gap apart and centered on the category's radial
            // direction. They live inside .cat-bloom (anchored at the category nub),
            // so each member is offset by the category nub's hub position.
            const n = cat.members.length;
            const membersHtml = cat.members.map((m, mi) => {
                const angle = catAngle + (mi - (n - 1) / 2) * MEMBER_ARC_GAP;
                const hub = anglePoint(hubCenter, MEMBER_RADIUS, angle);
                const x = hub.x - cp.x;
                const y = hub.y - cp.y;
                const sel = cat.selected.includes(m.name);
                return `<button class="member m-${cat.key}${sel ? ' selected' : ''}"
                    style="left:${x}px;top:${y}px;"
                    data-action="${cat.action}" data-col="${escapeAttr(m.name)}"
                    title="${escapeAttr(m.name)}"
                    ><span class="member-label">${escapeHtml(m.name)}</span></button>`;
            }).join('');

            // An invisible disc centered on the bubble that, only while the category
            // is open, captures pointer events across the whole bloom region — so
            // the bloom stays sticky even over a hub that's otherwise click-through
            // (the focused aggregate overlay). It sits below the member dots.
            const catchX = hubCenter - cp.x;
            const catchY = hubCenter - cp.y;
            const bloomCatch = `<div class="bloom-catch" style="left:${catchX}px;top:${catchY}px;"></div>`;

            return `<div class="cat-nub cat-${cat.key}${selectedCount > 0 ? ' has-selection' : ''}"
                style="left:${cp.x}px;top:${cp.y}px;"
                tabindex="0" title="${escapeAttr(cat.title)}">
                ${pinned}
                <div class="cat-bloom">${bloomCatch}${membersHtml}</div>
            </div>`;
        }).join('');
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
     * hub (like the root) whose dimension nubs pick the next grouping (toggleDimension,
     * not a further descent — this bubble is already locked). It is the bottom of
     * the stack — the level you're currently on — so clicking its body does nothing.
     * Already-locked dimensions are excluded.
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
                </div>
                ${this.activeStackedNubsHtml(state)}
            </div>`;
    }

    /**
     * Nubs for the deepest (bottom) stacked bubble — like the root's: the dimension
     * category picks the grouping (toggleDimension, NOT a descent — already locked),
     * excluding dimensions already locked up the chain; the measure category toggles
     * measures. Shared by the active hub and the deepest compact locked bubble.
     */
    private stackNubCategories(state: ExploreState): NubCategory[] {
        const used = new Set<string>();
        for (const crumb of state.drillChain) {
            for (const lock of crumb.locks) { used.add(lock.dimension); }
        }
        const categories: NubCategory[] = [];
        const dimNubs = selectDimensionNubs(state.columns, MAX_DIMENSION_NUBS).filter(m => !used.has(m.name));
        if (dimNubs.length > 0) {
            categories.push({ key: 'dimension', title: 'Group by', action: 'toggleDimension', members: dimNubs, selected: state.selectedDimensions });
        }
        // The measure is chosen via the dial on the bubble surface, not a nub.
        return categories;
    }

    private activeStackedNubsHtml(state: ExploreState): string {
        return this.renderCategoryNubs(this.stackNubCategories(state));
    }

    /**
     * Renders a locked drill node as a bubble (from the snapshot captured when it
     * was picked), clickable to pop back to that level. Only the deepest (bottom)
     * bubble carries nubs — ancestors are bare, their locked dimension shown on the
     * connector line above them instead.
     */
    private lockedBubbleHtml(state: ExploreState, crumb: DrillCrumb, index: number, isDeepest: boolean): string {
        const m = extractBubbleMetric(crumb.columns, crumb.row);
        // Compact bubbles are 180px → their center/edge radius is 90px.
        const nubs = isDeepest ? this.renderCategoryNubs(this.stackNubCategories(state), BUBBLE_RADIUS) : '';
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
                </div>
                ${nubs}
            </div>`;
    }

    private expandedHtml(state: ExploreState): string {
        const columnsHtml = state.columns.map(c => this.columnChipHtml(c, state)).join('');
        return `
            <div class="card expanded">
                <div class="card-header">
                    <button class="collapse-btn" data-action="toggleExpand" title="Collapse">▾</button>
                    <span class="card-title">${escapeHtml(state.source)}</span>
                    <span class="card-total">${formatNumber(state.totalCount)} rows</span>
                </div>
                <div class="columns">${columnsHtml}</div>
                ${this.drillSpineHtml(state)}
                <div class="value-area">${this.valueAreaHtml(state)}</div>
                ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
            </div>`;
    }

    private columnChipHtml(col: ClassifiedColumn, state: ExploreState): string {
        const isDimension = col.role === 'dimension';
        const isMeasure = col.role === 'measure';
        const selectable = isDimension || isMeasure;
        const selected = isDimension
            ? state.selectedDimensions.includes(col.name)
            : isMeasure && state.selectedMeasures.includes(col.name);
        const cls = ['chip', `role-${col.role}`, selectable ? 'selectable' : 'static', selected ? 'selected' : ''].join(' ');
        const action = isDimension ? ` data-action="toggleDimension" data-col="${escapeAttr(col.name)}"`
            : isMeasure ? ` data-action="toggleMeasure" data-col="${escapeAttr(col.name)}"` : '';
        const dc = col.dcount !== undefined ? `<span class="chip-dc">${formatNumber(col.dcount)}</span>` : '';
        return `<span class="${cls}"${action} title="${escapeAttr(col.type)} · ${col.role}">${selected ? '✓ ' : ''}${escapeHtml(col.name)}${dc}</span>`;
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

        const bubbles = result.rows.map((row, rowIdx) => {
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

            const heat = heatColor(heatRank[rowIdx] ?? 0);
            const heatStyle = `border-color:${heat};`
                + `background:color-mix(in srgb, ${heat} 16%, var(--vscode-editorWidget-background));`;

            const key = String(rowIdx);
            const inner = bubbleBody(label, valueText, aggGlyph, measureName);

            // The focused bubble is enlarged (object permanence: its peers stay
            // visible but fade). It carries NO drill nubs — to descend you must
            // DRAG it onto the drop zone below the stack (an intentional "link"
            // gesture); dropping elsewhere deselects it.
            if (state.focusKey === key) {
                // The focus slot keeps the SAME 96px footprint in the flex flow so
                // peers don't shift; the enlarged hub is an overlay drawn on top of
                // the (already faded) neighbours.
                return `
                    <div class="focus-slot">
                        <div class="bubble-hub bubble-hub-focus" style="width:${HUB_SIZE}px;height:${HUB_SIZE}px;">
                            <div class="bubble bubble-focus" data-action="clearFocus" style="${heatStyle}" title="Drag down to drill in, or click to unfocus">${inner}</div>
                        </div>
                    </div>`;
            }

            const faded = state.focusKey !== null ? ' faded' : '';
            return `
                <div class="bubble clickable${faded}" style="${heatStyle}" data-action="focusBubble" data-key="${key}" title="Click to focus, or drag down to drill in">
                    ${inner}
                </div>`;
        }).join('');

        const capped = result.rows.length >= MAX_FLOWER_ROWS
            ? `<div class="hint">Showing top ${MAX_FLOWER_ROWS} groups.</div>` : '';
        const refreshing = state.loading ? ' is-refreshing' : '';
        return `<div class="flower${refreshing}">${bubbles}</div>${capped}`;
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
    /* Until the full pan/zoom canvas exists, center the collapsed hub (and its
       flowering value area) along the panel width instead of hugging the left. */
    .card.collapsed { align-items: center; }
    .card.collapsed .value-area { align-self: stretch; }
    .card.collapsed .flower { justify-content: center; }
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
       root-bubble → cloud distance. */
    .value-area-drilled { margin-top: 114px; }
    .flower { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
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
    // translucent wheel popup, kept on screen and draggable so you can scrub it
    // without holding the drag from the capsule. Drag + release snaps/commits;
    // clicking away (or Escape) dismisses it.
    let openWheel = null;
    function closeDialWheel() {
        if (openWheel) { if (openWheel.popup) { openWheel.popup.remove(); } openWheel = null; }
    }
    function openDialWheel(el, options, kind, current) {
        closeDialWheel();
        let idx = options.indexOf(current);
        if (idx < 0) { idx = 0; }
        const s = { el: el, options: options, index: idx, kind: kind, current: current, popup: null, list: null };
        buildDialPopup(s);
        s.popup.classList.add('is-open');
        updateDial(s, 0); // show the current pick centered
        // A pointerdown on the wheel starts a scrub (reusing the same drag path).
        s.popup.addEventListener('pointerdown', function(ev) {
            ev.stopPropagation();
            dialState = { el: el, startY: ev.clientY, options: options, index: s.index, kind: kind, current: current, dragging: true, popup: s.popup, list: s.list, floating: true };
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
        } else if (!wasFloating) {
            // No drag from a capsule = a click: bring up the draggable wheel.
            suppressClick = true;
            openDialWheel(dialState.el, dialState.options, dialState.kind, dialState.current);
        }
        dialState = null;
    });
    // Click anywhere outside the open wheel (or pressing Escape) dismisses it.
    window.addEventListener('pointerdown', function(e) {
        if (openWheel && !(e.target.closest && e.target.closest('.measure-dial-popup')) && !(e.target.closest && e.target.closest('[data-dial]'))) {
            closeDialWheel();
        }
    });
    window.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') { closeDialWheel(); }
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
        if (action === 'toggleExpand') {
            vscodeApi.postMessage({ command: 'toggleExpand' });
        } else if (action === 'toggleDimension') {
            vscodeApi.postMessage({ command: 'toggleDimension', column: el.getAttribute('data-col') });
        } else if (action === 'toggleMeasure') {
            vscodeApi.postMessage({ command: 'toggleMeasure', column: el.getAttribute('data-col') });
        } else if (action === 'focusBubble') {
            vscodeApi.postMessage({ command: 'focusBubble', key: el.getAttribute('data-key') });
        } else if (action === 'clearFocus') {
            vscodeApi.postMessage({ command: 'clearFocus' });
        } else if (action === 'drillDimension') {
            vscodeApi.postMessage({ command: 'drillDimension', column: el.getAttribute('data-col') });
        } else if (action === 'popDrill') {
            vscodeApi.postMessage({ command: 'popDrill', index: el.getAttribute('data-index') });
        } else if (action === 'popToRoot') {
            vscodeApi.postMessage({ command: 'popToRoot' });
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
