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

/** The current exploration state for the single MVP card. */
interface ExploreState {
    source: string;
    cluster: string;
    database: string;
    columns: ClassifiedColumn[];
    selectedDimensions: string[];
    selectedMeasures: string[];
    collapsed: boolean;
    totalCount: number | null;
    /** Result of the current summarize, as a flat table. */
    result: { columns: string[]; rows: unknown[][] } | null;
    loading: boolean;
    error?: string;
}

/** Cap on rows rendered as bubbles (render-limit, not a query semantics limit). */
const MAX_FLOWER_ROWS = 200;

/** Max dimension nubs offered in the dimension category bloom. */
const MAX_DIMENSION_NUBS = 5;

/** Geometry of the collapsed bubble "hub" (the bubble plus the space its nubs occupy). */
const HUB_SIZE = 280;
const HUB_CENTER = HUB_SIZE / 2;
/** Distance from hub center to a category nub's center (tucked behind the 60px bubble). */
const NUB_RADIUS = 66;
/** Radius of the circle (centered on the bubble) that bloomed member dots ride. */
const MEMBER_RADIUS = 104;
/** Angular span (degrees) a category's member dots fan across, centered on the category. */
const MEMBER_ARC_SPAN = 70;
/** Max secondary measure values rendered inside a bubble before an overflow "…". */
const MAX_BUBBLE_VALUES = 2;
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
            collapsed: true,
            totalCount: null,
            result: null,
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

    private handleMessage(message: { command?: string; column?: string }): void {
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

        if (dims.length === 0 && measures.length === 0) {
            this.state.result = null;
            this.state.loading = false;
            this.render();
            return;
        }

        this.state.loading = true;
        this.state.error = undefined;
        this.render();

        const aggs = [`${bracket('Count')}=count()`,
            ...measures.map(m => `${bracket('Sum of ' + m)}=sum(${bracket(m)})`)];
        const byClause = dims.length > 0 ? ` by ${dims.map(bracket).join(', ')}` : '';
        // Position is keyed to the GROUP IDENTITY, not the value: order by the
        // dimension(s) so a given bubble keeps its place when you switch the
        // measure (only its size/heat changes). Size + heat carry magnitude.
        // With no dimension it's a single bubble, so order by the metric.
        const orderClause = dims.length > 0
            ? ` | order by ${dims.map(d => `${bracket(d)} asc`).join(', ')}`
            : ` | order by ${measures.length > 0 ? bracket('Sum of ' + measures[0]) : bracket('Count')} desc`;
        const query = `${bracket(source)} | summarize ${aggs.join(', ')}${byClause}${orderClause}`;

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
        const count = state.loading && state.totalCount === null
            ? '…'
            : formatNumber(state.totalCount);

        const catsHtml = this.categoryNubsHtml(state);

        // The number of columns hidden behind the thumb (everything beyond the rim nubs).
        const hiddenCount = state.columns.length;
        const thumbBadge = hiddenCount > 0 ? `<span class="thumb-badge">${hiddenCount}</span>` : '';

        const hasSelection = state.selectedDimensions.length > 0 || state.selectedMeasures.length > 0;
        return `
            <div class="card collapsed">
                <div class="bubble-hub" style="width:${HUB_SIZE}px;height:${HUB_SIZE}px;">
                    <div class="bubble bubble-root">
                        <div class="bubble-label">${escapeHtml(state.source)}</div>
                        <div class="bubble-primary"><span class="bubble-primary-num">${count}</span></div>
                        <button class="thumb" data-action="toggleExpand" title="Open card (show all columns)">
                            <span class="thumb-grip"></span>${thumbBadge}
                        </button>
                    </div>
                    ${catsHtml}
                </div>
                ${hasSelection ? `<div class="value-area">${this.valueAreaHtml(state)}</div>` : ''}
                ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
            </div>`;
    }

    /**
     * Renders the category nubs (dimension, measure) tucked behind the bubble.
     * Each is a stable colored dot that blooms its member nubs in a downward arc
     * on hover; a category with active selections stays lit at rest with a count.
     */
    private categoryNubsHtml(state: ExploreState): string {
        const categories: Array<{
            key: string; title: string; action: string;
            members: ClassifiedColumn[]; selected: string[];
        }> = [];

        const dimNubs = selectDimensionNubs(state.columns, MAX_DIMENSION_NUBS);
        if (dimNubs.length > 0) {
            categories.push({ key: 'dimension', title: 'Group by', action: 'toggleDimension', members: dimNubs, selected: state.selectedDimensions });
        }
        const measureNubs = selectMeasureNubs(state.columns, MAX_MEASURE_NUBS);
        if (measureNubs.length > 0) {
            categories.push({ key: 'measure', title: 'Measure', action: 'toggleMeasure', members: measureNubs, selected: state.selectedMeasures });
        }
        if (categories.length === 0) { return ''; }

        // Category nubs sit on the bottom arc, tucked behind the bubble.
        const catAngles = computeArcAngles(categories.length, 130, 50);
        const catPositions = catAngles.map(a => anglePoint(HUB_CENTER, NUB_RADIUS, a));

        return categories.map((cat, ci) => {
            const cp = catPositions[ci];
            const catAngle = catAngles[ci];
            const selectedMembers = cat.members.filter(m => cat.selected.includes(m.name));
            const selectedCount = selectedMembers.length;
            // Exactly one pick → show its name below the hub; many → a count badge.
            const pinned = selectedCount === 1
                ? `<span class="cat-pinned">${escapeHtml(selectedMembers[0].name)}</span>`
                : selectedCount > 1 ? `<span class="cat-badge">${selectedCount}</span>` : '';

            // Members are small dots riding a larger circle centered on the BUBBLE,
            // fanned in an arc around the category's own angle. They live inside
            // .cat-bloom (anchored at the category nub) so the hover-reveal works,
            // so each member is offset by the category nub's hub position.
            const memberAngles = computeArcAngles(
                cat.members.length, catAngle + MEMBER_ARC_SPAN / 2, catAngle - MEMBER_ARC_SPAN / 2);
            const membersHtml = cat.members.map((m, mi) => {
                const hub = anglePoint(HUB_CENTER, MEMBER_RADIUS, memberAngles[mi]);
                const x = hub.x - cp.x;
                const y = hub.y - cp.y;
                const sel = cat.selected.includes(m.name);
                return `<button class="member m-${cat.key}${sel ? ' selected' : ''}"
                    style="left:${x}px;top:${y}px;"
                    data-action="${cat.action}" data-col="${escapeAttr(m.name)}"
                    title="${escapeAttr(m.name)}"
                    ><span class="member-label">${escapeHtml(m.name)}</span></button>`;
            }).join('');

            return `<div class="cat-nub cat-${cat.key}${selectedCount > 0 ? ' has-selection' : ''}"
                style="left:${cp.x}px;top:${cp.y}px;"
                tabindex="0" title="${escapeAttr(cat.title)}">
                ${pinned}
                <div class="cat-bloom">${membersHtml}</div>
            </div>`;
        }).join('');
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
        if (state.loading) {
            return `<div class="hint">Loading…</div>`;
        }
        if (state.selectedDimensions.length === 0 && state.selectedMeasures.length === 0) {
            // No grouping yet: a single total bubble.
            return `
                <div class="flower">
                    <div class="bubble">
                        <div class="bubble-label">All</div>
                        <div class="bubble-primary"><span class="bubble-primary-num">${formatNumber(state.totalCount)}</span></div>
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
            .filter(c => c.name.startsWith('Sum of '));
        const dimIdxs = result.columns
            .map((name, i) => ({ name, i }))
            .filter(c => c.name !== 'Count' && !c.name.startsWith('Sum of '))
            .map(c => c.i);

        // Picking a measure promotes it to the PRIMARY metric: it drives the big
        // number and the bubble size, and Count is demoted to a secondary line.
        // With no measure selected, Count stays primary.
        const primaryMeasure = measureCols[0];
        const secondaryMeasures = measureCols.slice(1);
        const showMeasureNames = measureCols.length > 1;

        const metricOf = (row: unknown[]): number => primaryMeasure
            ? Number(row[primaryMeasure.i]) || 0
            : Number(row[countIdx]) || 0;
        const maxMetric = Math.max(1, ...result.rows.map(r => Math.max(0, metricOf(r))));

        // Heat: a redundant magnitude channel on the primary metric so the large
        // values pop even when sizes are close. Normalized by VALUE (log scale)
        // so the spread reflects real magnitude, not item count, and the minimum
        // (usually 0) maps to the cold end. Position stays keyed to category, so
        // heat/size are the only things that move on a measure switch.
        const heatRank = computeHeatValues(result.rows.map(r => metricOf(r)));

        const bubbles = result.rows.map((row, rowIdx) => {
            const count = Number(row[countIdx]) || 0;
            const label = dimIdxs.length > 0
                ? dimIdxs.map(i => formatCell(row[i])).join(' · ')
                : 'All';
            const size = bubbleSize(Math.max(0, metricOf(row)), maxMetric);

            // Primary: the promoted measure if any, else the count.
            let primaryHtml: string;
            if (primaryMeasure) {
                const pm = parseMeasureHeader(primaryMeasure.name);
                // Caption is only useful when it disambiguates: show the name when
                // more than one measure is selected, and the aggregate glyph only
                // when it's NOT the implicit default (sum).
                const showName = showMeasureNames;
                const showGlyph = !pm.isDefault;
                const cap = (showName || showGlyph)
                    ? `<span class="bubble-primary-cap">${showGlyph ? `<span class="bubble-agg">${pm.glyph}</span>` : ''}${showName ? escapeHtml(truncateLabel(pm.column, MAX_MEASURE_NAME_LEN)) : ''}</span>`
                    : '';
                primaryHtml = `<div class="bubble-primary" title="${escapeAttr(primaryMeasure.name + ' = ' + formatCell(row[primaryMeasure.i]))}">`
                    + `<span class="bubble-primary-num">${escapeHtml(formatMeasureValue(row[primaryMeasure.i]))}</span>`
                    + cap + `</div>`;
            } else {
                primaryHtml = `<div class="bubble-primary"><span class="bubble-primary-num">${escapeHtml(formatCompact(count))}</span></div>`;
            }

            // Secondary lines: demoted count (only when a measure is primary)
            // plus any additional measures, each a single compact row.
            const secondary: string[] = [];
            if (primaryMeasure) {
                secondary.push(`<div class="bubble-value" title="${escapeAttr('Count = ' + formatNumber(count))}">`
                    + `<span class="bubble-agg">#</span><span class="bubble-value-num">${escapeHtml(formatCompact(count))}</span></div>`);
            }
            for (const mc of secondaryMeasures.slice(0, MAX_BUBBLE_VALUES)) {
                const m = parseMeasureHeader(mc.name);
                const namePart = showMeasureNames
                    ? `<span class="bubble-value-name">${escapeHtml(truncateLabel(m.column, MAX_MEASURE_NAME_LEN))}</span>`
                    : '';
                secondary.push(`<div class="bubble-value" title="${escapeAttr(mc.name + ' = ' + formatCell(row[mc.i]))}">`
                    + `<span class="bubble-agg">${m.glyph}</span>${namePart}`
                    + `<span class="bubble-value-num">${escapeHtml(formatMeasureValue(row[mc.i]))}</span></div>`);
            }
            const overflow = secondaryMeasures.length > MAX_BUBBLE_VALUES ? `<div class="bubble-more">…</div>` : '';

            const heat = heatColor(heatRank[rowIdx] ?? 0);
            const heatStyle = `width:${size}px;height:${size}px;`
                + `border-color:${heat};`
                + `background:color-mix(in srgb, ${heat} 16%, var(--vscode-editorWidget-background));`;

            return `
                <div class="bubble" style="${heatStyle}">
                    <div class="bubble-label">${escapeHtml(label)}</div>
                    ${primaryHtml}
                    ${secondary.join('')}${overflow}
                </div>`;
        }).join('');

        const capped = result.rows.length >= MAX_FLOWER_ROWS
            ? `<div class="hint">Showing top ${MAX_FLOWER_ROWS} groups.</div>` : '';
        return `<div class="flower">${bubbles}</div>${capped}`;
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
    .flower { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
    .bubble {
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        min-width: 64px; min-height: 64px; padding: 8px; border-radius: 50%;
        background: var(--vscode-editorWidget-background);
        border: 2px solid var(--role-other);
        text-align: center; overflow: hidden;
    }
    /* The root/source bubble is the ENTITY hub the groups flower from — give it a
       solid accent ring, a faint accent-tinted fill and a lift so it reads as the
       anchor, while the derived aggregate bubbles stay as lighter neutral satellites. */
    .bubble-root {
        cursor: default; width: 120px; height: 120px; position: relative;
        border: 3px solid var(--root-accent);
        background:
            color-mix(in srgb, var(--root-accent) 14%, var(--vscode-editorWidget-background));
        box-shadow: 0 1px 6px rgba(0, 0, 0, 0.35);
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

    /* Collapsed bubble "hub": the bubble centered, with category nubs around it. */
    .bubble-hub { position: relative; }
    .bubble-hub .bubble-root {
        position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
        z-index: 1; /* covers the inner half of the nubs tucked behind it */
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
    .member {
        position: absolute; transform: translate(-50%, -50%);
        width: 16px; height: 16px; padding: 0; border-radius: 50%;
        cursor: pointer; user-select: none; z-index: 4;
        background: var(--vscode-editorWidget-background);
        border: 2px solid var(--role-other);
        opacity: 0; pointer-events: none; transition: opacity 0.1s, width 0.1s, height 0.1s;
    }
    .cat-nub.open .member { opacity: 1; pointer-events: auto; }
    .member:hover, .member:focus { width: 20px; height: 20px; z-index: 5; outline: none; border-color: var(--vscode-focusBorder); }
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
    .thumb-badge {
        font-size: 0.7em; opacity: 0.8; line-height: 1;
        padding: 1px 4px; border-radius: 8px;
        background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
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

    // Event delegation survives innerHTML swaps.
    app.addEventListener('click', function(e) {
        const el = e.target.closest ? e.target.closest('[data-action]') : null;
        if (!el) { return; }
        const action = el.getAttribute('data-action');
        if (action === 'toggleExpand') {
            vscodeApi.postMessage({ command: 'toggleExpand' });
        } else if (action === 'toggleDimension') {
            vscodeApi.postMessage({ command: 'toggleDimension', column: el.getAttribute('data-col') });
        } else if (action === 'toggleMeasure') {
            vscodeApi.postMessage({ command: 'toggleMeasure', column: el.getAttribute('data-col') });
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
            const hub = e.target.closest ? e.target.closest('.bubble-hub') : null;
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
 * Parses a measure result-column header like "Sum of Revenue" into its
 * aggregate glyph, the underlying column name, and whether the aggregate is the
 * implicit default (sum). Falls back to Σ/the raw header for anything unrecognized.
 */
function parseMeasureHeader(header: string): { glyph: string; column: string; isDefault: boolean } {
    const prefixes: Array<[string, string, boolean]> = [
        ['Sum of ', 'Σ', true],
        ['Avg of ', 'x̄', false],
        ['Min of ', '↓', false],
        ['Max of ', '↑', false],
    ];
    for (const [prefix, glyph, isDefault] of prefixes) {
        if (header.startsWith(prefix)) { return { glyph, column: header.slice(prefix.length), isDefault }; }
    }
    return { glyph: 'Σ', column: header, isDefault: true };
}

/** Truncates a label to a maximum length, appending an ellipsis when clipped. */
function truncateLabel(text: string, max: number): string {
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function bubbleSize(count: number, maxCount: number): number {
    const min = 64;
    const max = 140;
    const ratio = Math.sqrt(count / maxCount);
    return Math.round(min + (max - min) * ratio);
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
        return values.map(() => 1);
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
 * Evenly-spaced angles (degrees) along an arc from startDeg to endDeg.
 * A single item sits at the arc's midpoint.
 */
function computeArcAngles(count: number, startDeg: number, endDeg: number): number[] {
    const angles: number[] = [];
    for (let i = 0; i < count; i++) {
        const t = count === 1 ? 0.5 : i / (count - 1);
        angles.push(startDeg + t * (endDeg - startDeg));
    }
    return angles;
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
