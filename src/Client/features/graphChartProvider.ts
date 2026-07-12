// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Graph chart provider — renders a node-link graph using Cytoscape.js.
 *
 * The chart's primary table is interpreted as an edge list:
 *   - source column:  options.xColumn, else the first column
 *   - target column:  options.yColumns[0], else the second column
 *   - edge kind:      options.edgeKindColumn, else options.seriesColumns[0] (optional)
 *
 * If a sibling result table is present it is used as the nodes table.
 * Selection order: options.nodesTable (by name) → a sibling named "nodes"
 * (case-insensitive) → the single non-empty other table.
 *
 * Node columns honor explicit overrides first, then fall back to name-based
 * detection (case-insensitive):
 *   - id:    options.nodeIdColumn    → `id` / `nodeid` / `node_id` / `name` / `node` / first column
 *   - label: options.nodeLabelColumn → `label` / `displayname` / `display_name` / `title` / `name` (else id)
 *   - kind:  options.nodeKindColumn  → `nodekind` / `node_kind` / `nodetype` / `node_type` /
 *                                       `entitytype` / `entity_type` / `category` / `class` /
 *                                       `group` / `role` / `kind` / `type` (optional)
 * Any remaining columns appear in the node tooltip when non-null.
 */

import type { ChartOptions, ResultTable, ResultChartView } from './server';
import { ChartColorways, ChartMode, getColumnRef, getColumnRefByIndex } from './chartProvider';
import type { IChartView, IWebView, IChartProvider, ColumnRef, ChartRenderContext } from './chartProvider';
import * as vscode from 'vscode';

const CytoscapeJsCdn = 'https://cdn.jsdelivr.net/npm/cytoscape@3.30.2/dist/cytoscape.min.js';

// ─── View ───────────────────────────────────────────────────────────────────

class GraphChartView implements IChartView {
    onCopyResult: ((pngDataUrl: string, svgDataUrl?: string) => void) | undefined;
    onCopyError: ((error: string) => void) | undefined;
    private readonly subscription: { dispose(): void };
    private readonly stateListeners = new Set<(state: ResultChartView) => void>();
    /** Latest known node positions, keyed by node id. Survives re-renders. */
    private cachedPositions: { [nodeId: string]: { x: number; y: number } } = {};
    /** Current layout seed (reported by the page; bumped on reroll). */
    private cachedSeed: number | undefined;
    /** True once the user has manually dragged a node. */
    private cachedManual = false;
    /** Last render arguments, so a reroll can re-render with new state. */
    private lastRenderArgs: {
        data: ResultTable;
        options: ChartOptions;
        darkMode: boolean;
        ctx: ChartRenderContext | undefined;
    } | undefined;
    private currentChartName: string | undefined;
    private currentChartTableName: string | undefined;
    /**
     * Signature of the last graph state we emitted to listeners. Used to
     * suppress redundant emits — e.g. when reopening an already-saved graph
     * the page replays and reports back the exact positions we loaded, which
     * must NOT re-dirty the result/history file. The first auto-layout (which
     * differs from the empty/loaded signature) still emits so positions are
     * persisted and stay fixed across sessions.
     */
    private lastEmittedSignature: string | undefined;
    /**
     * Monotonic render token. Each render embeds the current value into the
     * page; position messages echo it back. Messages whose token is not the
     * current one are ignored — this prevents a superseded Cytoscape instance
     * (whose old timers/layout are still running after an innerHTML swap) from
     * clobbering the cache with stale or pre-layout grid positions.
     */
    private renderToken = 0;

    constructor(
        private readonly webview: IWebView,
        private readonly render: (data: ResultTable, options: ChartOptions, darkMode: boolean, ctx: ChartRenderContext | undefined, positions: { [id: string]: { x: number; y: number } }, token: number, seed: number | undefined) => string | undefined
    ) {
        this.subscription = webview.handle((msg) => {
            if (msg && msg.command === 'graphChartPositions' && msg.positions) {
                // Ignore positions from a superseded render.
                if (typeof msg.token === 'number' && msg.token !== this.renderToken) {
                    return;
                }
                const positions = msg.positions as { [id: string]: { x: number; y: number } };
                // Merge — Cytoscape may emit a subset (only nodes that moved
                // during a drag) and we want to retain positions for unmoved
                // nodes too.
                this.cachedPositions = { ...this.cachedPositions, ...positions };
                if (typeof msg.seed === 'number') { this.cachedSeed = msg.seed; }
                if (msg.manual === true) { this.cachedManual = true; }
                this.emitState();
                return;
            }
            if (msg && msg.command === 'graphChartReroll') {
                if (typeof msg.token === 'number' && msg.token !== this.renderToken) {
                    return;
                }
                void this.reroll();
                return;
            }
        });
    }

    private buildState(): ResultChartView {
        const graph: NonNullable<ResultChartView['graph']> = { positions: this.cachedPositions };
        if (this.cachedSeed !== undefined) { graph.seed = this.cachedSeed; }
        if (this.cachedManual) { graph.manual = true; }
        const state: ResultChartView = { graph };
        if (this.currentChartName) state.name = this.currentChartName;
        if (this.currentChartTableName) state.tableName = this.currentChartTableName;
        return state;
    }

    private emitState(): void {
        const state = this.buildState();
        // Only notify (and thus persist) when the state actually changed.
        // Replaying a saved layout reports back identical positions; emitting
        // those again would needlessly dirty the file on every open.
        const signature = JSON.stringify(state);
        if (signature === this.lastEmittedSignature) { return; }
        this.lastEmittedSignature = signature;
        for (const l of this.stateListeners) l(state);
    }

    /** Re-runs the layout with a new seed, discarding cached positions. */
    private async reroll(): Promise<void> {
        if (!this.lastRenderArgs) { return; }
        if (this.cachedManual) {
            const choice = await vscode.window.showWarningMessage(
                'Regenerating the layout will discard your manual node placements. Continue?',
                { modal: true }, 'Regenerate'
            );
            if (choice !== 'Regenerate') { return; }
        }
        this.cachedSeed = (this.cachedSeed ?? 0) + 1;
        this.cachedPositions = {};
        this.cachedManual = false;
        const { data, options, darkMode, ctx } = this.lastRenderArgs;
        this.doRender(data, options, darkMode, ctx);
        // Persist the new seed and cleared positions immediately; the page
        // will also report fresh positions once cose settles.
        this.emitState();
    }

    copyChart(): void {
        // Copy not yet supported for graph chart
    }

    renderChart(data: ResultTable, options: ChartOptions, darkMode: boolean, ctx?: ChartRenderContext, viewState?: ResultChartView): void {
        this.currentChartName = viewState?.name;
        this.currentChartTableName = viewState?.tableName;
        // Adopt any saved state from disk; in-session edits already merge here.
        const saved = viewState?.graph?.positions;
        if (saved) {
            this.cachedPositions = { ...this.cachedPositions, ...saved };
        }
        if (viewState?.graph?.seed !== undefined) { this.cachedSeed = viewState.graph.seed; }
        if (viewState?.graph?.manual) { this.cachedManual = true; }
        // Prime the emit signature with the loaded state so that when the page
        // replays and reports back these exact positions we don't treat it as
        // a change and re-dirty the file. (First-ever render has no saved
        // positions, so the auto-layout will differ and be persisted.)
        if (saved && Object.keys(saved).length > 0) {
            this.lastEmittedSignature = JSON.stringify(this.buildState());
        }
        this.doRender(data, options, darkMode, ctx);
    }

    private doRender(data: ResultTable, options: ChartOptions, darkMode: boolean, ctx: ChartRenderContext | undefined): void {
        this.lastRenderArgs = { data, options, darkMode, ctx };
        const token = ++this.renderToken;
        const bodyHtml = this.render(data, options, darkMode, ctx, this.cachedPositions, token, this.cachedSeed);
        if (bodyHtml) {
            this.webview.setContent(bodyHtml);
        } else {
            this.webview.setContent(
                `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--vscode-foreground,inherit);">` +
                `<span style="font-size:1.5em;">&#10060;</span>&nbsp; Graph chart requires at least two columns (source, target).</div>`
            );
        }
    }

    onDidChangeViewState(listener: (state: ResultChartView) => void): { dispose(): void } {
        this.stateListeners.add(listener);
        return { dispose: () => this.stateListeners.delete(listener) };
    }

    dispose(): void {
        this.stateListeners.clear();
        this.subscription.dispose();
    }
}

// ─── Provider ───────────────────────────────────────────────────────────────

interface CyNode {
    data: {
        id: string;
        label: string;
        kind?: string;
        tip?: string;
    };
}
interface CyEdge {
    data: {
        id: string;
        source: string;
        target: string;
        label?: string;
        kind?: string;
    };
}

export class GraphChartProvider implements IChartProvider {

    createView(webview: IWebView): IChartView {
        webview.setup(
            `<script defer src="${CytoscapeJsCdn}" charset="utf-8"></script>`,
            ''
        );
        return new GraphChartView(webview, (data, options, darkMode, ctx, positions, token, seed) => this.renderGraphHtml(data, options, darkMode, ctx, positions, token, seed));
    }

    private renderGraphHtml(data: ResultTable, options: ChartOptions, darkMode: boolean, ctx: ChartRenderContext | undefined, positions: { [id: string]: { x: number; y: number } }, token: number, seedOverride: number | undefined): string | undefined {
        if (data.columns.length < 2 || data.rows.length === 0) return undefined;

        if (options.mode === ChartMode.Light) darkMode = false;
        else if (options.mode === ChartMode.Dark) darkMode = true;

        const theme = darkMode
            ? {
                background: '#1e1e1e',
                foreground: '#cccccc',
                edgeColor: '#888888',
                nodeBorder: '#3c3c3c',
                labelOutline: '#1e1e1e',
                defaultNode: '#888888',
            }
            : {
                background: '#ffffff',
                foreground: '#333333',
                edgeColor: '#888888',
                nodeBorder: '#d4d4d4',
                labelOutline: '#ffffff',
                defaultNode: '#888888',
            };

        const sourceCol: ColumnRef | undefined =
            (options.xColumn ? getColumnRef(data, options.xColumn) : undefined) ?? getColumnRefByIndex(data, 0);
        const targetCol: ColumnRef | undefined =
            (options.yColumns && options.yColumns[0] ? getColumnRef(data, options.yColumns[0]) : undefined) ?? getColumnRefByIndex(data, 1);
        if (!sourceCol || !targetCol) return undefined;

        const edgeKindCol: ColumnRef | undefined =
            (options.edgeKindColumn ? getColumnRef(data, options.edgeKindColumn) : undefined)
            ?? ((options.seriesColumns && options.seriesColumns[0]) ? getColumnRef(data, options.seriesColumns[0]) : undefined);

        const nodesTable = findNodesTable(data, ctx, options.nodesTable);

        // Build nodes from the nodes table (when present)
        const nodeMap = new Map<string, CyNode>();
        const nodeKinds = new Set<string>();

        if (nodesTable) {
            const nodeIdCol =
                (options.nodeIdColumn ? getColumnRef(nodesTable, options.nodeIdColumn) : undefined)
                ?? pickColumn(nodesTable, ['id', 'nodeid', 'node_id', 'name', 'node'])
                ?? getColumnRefByIndex(nodesTable, 0);
            let nodeLabelCol =
                (options.nodeLabelColumn ? getColumnRef(nodesTable, options.nodeLabelColumn) : undefined)
                ?? pickColumn(nodesTable, ['label', 'displayname', 'display_name', 'title']);
            if (!nodeLabelCol && !options.nodeLabelColumn) {
                const nameCol = pickColumn(nodesTable, ['name']);
                if (nameCol && nameCol.index !== nodeIdCol?.index) nodeLabelCol = nameCol;
            }
            const nodeKindCol =
                (options.nodeKindColumn ? getColumnRef(nodesTable, options.nodeKindColumn) : undefined)
                ?? pickColumn(nodesTable, ['nodekind', 'node_kind', 'nodetype', 'node_type', 'entitytype', 'entity_type', 'category', 'class', 'group', 'role', 'kind', 'type']);
            const nodeAttrCols = nodesTable.columns
                .map((_, i) => getColumnRefByIndex(nodesTable, i))
                .filter((c): c is ColumnRef => !!c)
                .filter(c => c.index !== nodeIdCol?.index
                          && c.index !== nodeLabelCol?.index
                          && c.index !== nodeKindCol?.index);

            if (nodeIdCol) {
                for (const row of nodesTable.rows) {
                    if (!row) continue;
                    const idVal = row[nodeIdCol.index];
                    if (idVal == null) continue;
                    const id = String(idVal);
                    const label = nodeLabelCol ? stringOrId(row[nodeLabelCol.index], id) : id;
                    const kind = nodeKindCol ? optString(row[nodeKindCol.index]) : undefined;
                    if (kind) nodeKinds.add(kind);
                    const tip = buildTooltip(label, kind, nodeAttrCols, row);
                    const node: CyNode = { data: { id, label } };
                    if (kind) node.data.kind = kind;
                    if (tip) node.data.tip = tip;
                    nodeMap.set(id, node);
                }
            }
        }

        const ensureNode = (id: string): void => {
            if (!nodeMap.has(id)) {
                nodeMap.set(id, { data: { id, label: id } });
            }
        };

        const edges: CyEdge[] = [];
        const edgeKinds = new Set<string>();
        let edgeIdx = 0;
        for (const row of data.rows) {
            if (!row) continue;
            const sVal = row[sourceCol.index];
            const tVal = row[targetCol.index];
            if (sVal == null || tVal == null) continue;
            const s = String(sVal);
            const t = String(tVal);
            ensureNode(s);
            ensureNode(t);
            const edge: CyEdge = { data: { id: `e${edgeIdx++}`, source: s, target: t } };
            if (edgeKindCol) {
                const kVal = row[edgeKindCol.index];
                if (kVal != null) {
                    const k = String(kVal);
                    edge.data.kind = k;
                    edge.data.label = k;
                    edgeKinds.add(k);
                }
            }
            edges.push(edge);
        }

        if (nodeMap.size === 0) return undefined;

        // Position handling:
        //  - If we have SAVED positions (user-dragged or persisted), pin them
        //    exactly via a 'preset' layout. Unknown nodes go to the centroid.
        //  - Otherwise, run cose. To make the layout reproducible for the same
        //    data, we seed cose's internal randomness (Math.random) with a
        //    hash of the data on the page side — see the layout run below.
        type CyNodeWithPos = CyNode & { position?: { x: number; y: number } };
        const havePositions = Object.keys(positions).length > 0;

        // Deterministic seed derived from the graph's node ids + edges so that
        // re-running a query that yields identical data produces an identical
        // cose layout. Both the node ids and the edge keys are sorted before
        // hashing so the seed is independent of row order — the same logical
        // graph produces the same layout regardless of how the rows are
        // ordered. A seedOverride (from the reroll button / persisted state)
        // takes precedence.
        const nodeIdsSorted = [...nodeMap.keys()].sort();
        const edgeKeysSorted = edges.map(e => e.data.source + '\u0001' + e.data.target).sort();
        const seedItems = nodeIdsSorted.concat(edgeKeysSorted);
        const layoutSeed = seedOverride !== undefined ? (seedOverride >>> 0) : hashStringList(seedItems);

        let cx = 0, cy_ = 0, n_ = 0;
        if (havePositions) {
            for (const k of Object.keys(positions)) {
                const p = positions[k];
                if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
                    cx += p.x; cy_ += p.y; n_++;
                }
            }
            if (n_ > 0) { cx /= n_; cy_ /= n_; }
        }
        const nodes: CyNodeWithPos[] = [];
        for (const n of nodeMap.values()) {
            const p = positions[n.data.id];
            if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
                nodes.push({ data: n.data, position: { x: p.x, y: p.y } });
            } else if (havePositions) {
                nodes.push({ data: n.data, position: { x: cx, y: cy_ } });
            } else {
                nodes.push(n);
            }
        }
        const elements = [...nodes, ...edges];

        const colors = ChartColorways.Default;
        // Assign node and edge kinds from different parts of the colorway so a
        // node kind and an (unrelated) edge kind don't get the same color and
        // imply a relationship. Nodes take the palette from the start; edges
        // continue after the node kinds, wrapping around as needed.
        const nodeKindStyles: { kind: string; color: string }[] = [];
        let nki = 0;
        for (const k of nodeKinds) {
            nodeKindStyles.push({ kind: k, color: colors[nki % colors.length]! });
            nki++;
        }
        const edgeKindStyles: { kind: string; color: string }[] = [];
        let eki = 0;
        for (const k of edgeKinds) {
            edgeKindStyles.push({ kind: k, color: colors[(nodeKindStyles.length + eki) % colors.length]! });
            eki++;
        }

        const title = options.title ? escapeHtml(options.title) : '';
        const showLegend = nodeKindStyles.length > 0 || edgeKindStyles.length > 0;
        const legendHtml = showLegend ? buildLegendHtml(nodeKindStyles, edgeKindStyles) : '';

        const nodeFontSize = graphFontSize(options.textSize);

        const elementsLit = escapeForJsStringLiteral(JSON.stringify(elements));
        const edgeKindStylesLit = escapeForJsStringLiteral(JSON.stringify(edgeKindStyles));
        const nodeKindStylesLit = escapeForJsStringLiteral(JSON.stringify(nodeKindStyles));
        const positionsLit = escapeForJsStringLiteral(JSON.stringify(positions));

        return `
<style>
.gc-wrapper {
    position: relative;
    height: 100%;
    width: 100%;
    background: ${theme.background};
    color: ${theme.foreground};
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    box-sizing: border-box;
}
.gc-title {
    position: absolute;
    top: 6px;
    left: 12px;
    right: 12px;
    font-size: 1.1em;
    font-weight: 600;
    pointer-events: none;
    z-index: 2;
}
.gc-cy {
    position: absolute;
    top: ${title ? '32px' : '0'};
    left: 0;
    right: 0;
    bottom: 0;
}
.gc-status {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    color: ${theme.foreground};
    opacity: 0.7;
}
.gc-tooltip {
    position: absolute;
    pointer-events: none;
    background: ${theme.background};
    color: ${theme.foreground};
    border: 1px solid ${theme.nodeBorder};
    padding: 4px 8px;
    border-radius: 3px;
    font-size: 12px;
    max-width: 360px;
    word-wrap: break-word;
    white-space: pre-line;
    z-index: 3;
    display: none;
    box-shadow: 0 2px 6px rgba(0,0,0,0.3);
}
.gc-legend {
    position: absolute;
    top: ${title ? '36px' : '6px'};
    right: 8px;
    z-index: 2;
    background: ${theme.background};
    color: ${theme.foreground};
    border: 1px solid ${theme.nodeBorder};
    border-radius: 3px;
    padding: 6px 8px;
    font-size: 11px;
    max-height: calc(100% - 48px);
    overflow: auto;
    box-shadow: 0 1px 4px rgba(0,0,0,0.2);
}
.gc-legend-section { margin-bottom: 4px; }
.gc-legend-section:last-child { margin-bottom: 0; }
.gc-legend-title { font-weight: 600; opacity: 0.75; margin-bottom: 2px; }
.gc-legend-item { display: flex; align-items: center; gap: 6px; line-height: 1.6; }
.gc-legend-swatch { width: 10px; height: 10px; border-radius: 50%; flex: 0 0 10px; border: 1px solid ${theme.nodeBorder}; }
.gc-legend-swatch.edge { width: 14px; height: 2px; border-radius: 0; border: 0; flex: 0 0 14px; }
.gc-toolbar {
    position: absolute;
    top: ${title ? '34px' : '6px'};
    left: 8px;
    z-index: 4;
    display: flex;
    gap: 4px;
}
.gc-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    background: ${theme.background};
    color: ${theme.foreground};
    border: 1px solid ${theme.nodeBorder};
    border-radius: 3px;
    cursor: pointer;
    opacity: 0.85;
}
.gc-btn:hover { opacity: 1; }
.gc-btn svg { width: 14px; height: 14px; fill: currentColor; }
</style>
<div class="gc-wrapper">
    ${title ? `<div class="gc-title">${title}</div>` : ''}
    <div class="gc-toolbar">
        <button id="gc-reroll" class="gc-btn" title="Regenerate layout">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.45 4.14A6 6 0 1 0 14 8h-1.5a4.5 4.5 0 1 1-1.02-2.86L9 7h5V2l-1.55 2.14z"/></svg>
        </button>
    </div>
    <div id="gc-cy" class="gc-cy"></div>
    ${legendHtml}
    <div id="gc-status" class="gc-status">Loading graph…</div>
    <div id="gc-tooltip" class="gc-tooltip"></div>
</div>
<script>
(function() {
    function init() {
        if (typeof cytoscape === 'undefined') { setTimeout(init, 50); return; }
        var status = document.getElementById('gc-status');
        if (status) status.style.display = 'none';
        // Destroy any prior Cytoscape instance from a previous render. After
        // an innerHTML swap the old instance's container is detached but its
        // animation/render loop keeps running, which can paint a stale graph
        // on top of the new one (appearing as duplicated nodes).
        try { if (window._gcInstance) { window._gcInstance.destroy(); } } catch (e) {}
        window._gcInstance = undefined;
        var elements, edgeKindStyles, nodeKindStyles, savedPositions;
        try {
            elements = JSON.parse('${elementsLit}');
            edgeKindStyles = JSON.parse('${edgeKindStylesLit}');
            nodeKindStyles = JSON.parse('${nodeKindStylesLit}');
            savedPositions = JSON.parse('${positionsLit}');
        } catch (e) {
            if (status) { status.style.display = ''; status.textContent = 'Graph parse error: ' + e.message; }
            return;
        }
        var stylesheet = [
            { selector: 'node',
              style: {
                'background-color': '${theme.defaultNode}',
                'border-color': '${theme.nodeBorder}',
                'border-width': 1,
                'label': 'data(label)',
                'color': '${theme.foreground}',
                'font-size': ${nodeFontSize},
                'text-valign': 'bottom',
                'text-halign': 'center',
                'text-margin-y': 4,
                'text-outline-color': '${theme.labelOutline}',
                'text-outline-width': 2,
                'width': 18,
                'height': 18
              }
            },
            { selector: 'node:selected',
              style: { 'border-color': '${colors[1]}', 'border-width': 3 }
            },
            { selector: 'edge',
              style: {
                'curve-style': 'bezier',
                'line-color': '${theme.edgeColor}',
                'target-arrow-color': '${theme.edgeColor}',
                'target-arrow-shape': 'triangle',
                'arrow-scale': 0.8,
                'width': 1,
                'opacity': 0.7
              }
            },
            { selector: 'edge:selected',
              style: { 'line-color': '${colors[1]}', 'target-arrow-color': '${colors[1]}', 'width': 2, 'opacity': 1 }
            }
        ];
        for (var i = 0; i < nodeKindStyles.length; i++) {
            var nks = nodeKindStyles[i];
            stylesheet.push({
                selector: 'node[kind = ' + JSON.stringify(nks.kind) + ']',
                style: { 'background-color': nks.color }
            });
        }
        for (var j = 0; j < edgeKindStyles.length; j++) {
            var eks = edgeKindStyles[j];
            stylesheet.push({
                selector: 'edge[kind = ' + JSON.stringify(eks.kind) + ']',
                style: { 'line-color': eks.color, 'target-arrow-color': eks.color }
            });
        }
        var cy;
        try {
            cy = cytoscape({
                container: document.getElementById('gc-cy'),
                elements: elements,
                style: stylesheet,
                wheelSensitivity: 0.2
            });
            window._gcInstance = cy;
        } catch (e) {
            if (status) { status.style.display = ''; status.textContent = 'Graph render error: ' + e.message; }
            return;
        }
        // Post node positions back to the host so they can be persisted
        // across re-renders (and saved into the .kqr file). Uses the
        // page-level _vscodeApi handle established by the host harness.
        var renderToken = ${token};
        var layoutSeed = (${layoutSeed} >>> 0);
        function postPositions(manual, attempt) {
            var api = window._vscodeApi;
            var positions = {};
            cy.nodes().forEach(function(n) {
                var p = n.position();
                positions[n.id()] = { x: p.x, y: p.y };
            });
            if (api) {
                try { api.postMessage({ command: 'graphChartPositions', positions: positions, token: renderToken, seed: layoutSeed, manual: !!manual }); } catch (e) {}
            } else if ((attempt || 0) < 50) {
                // Harness may not have initialised yet on the very first
                // render; retry shortly so we never lose the initial cose
                // positions. Bound the retries (~2.5s) so we never leak an
                // unbounded background timer loop if it never initialises.
                setTimeout(function() { postPositions(manual, (attempt || 0) + 1); }, 50);
            }
        }
        // Capture after each user drag (marks the layout as manually adjusted).
        cy.on('dragfree', 'node', function() { postPositions(true); });
        // Reroll button: ask the host to re-run the layout with a new seed.
        var rerollBtn = document.getElementById('gc-reroll');
        if (rerollBtn) {
            rerollBtn.addEventListener('click', function() {
                var api = window._vscodeApi;
                if (api) {
                    try { api.postMessage({ command: 'graphChartReroll', token: renderToken }); } catch (e) {}
                }
            });
        }
        // Build the layout. When we have saved positions we use 'preset' and
        // feed the coordinates EXPLICITLY via a positions callback (relying on
        // element.position alone can fall back to a grid in some cytoscape
        // builds). Otherwise we run 'cose' to compute a fresh layout.
        var havePositions = savedPositions && Object.keys(savedPositions).length > 0;
        var layout;
        if (havePositions) {
            layout = cy.layout({
                name: 'preset',
                fit: true,
                padding: 20,
                positions: function(node) {
                    var p = savedPositions[node.id()];
                    return (p && isFinite(p.x) && isFinite(p.y)) ? { x: p.x, y: p.y } : undefined;
                }
            });
            // preset just replays known coordinates; no need to re-post them.
            layout.run();
        } else {
            // cose is iterative (even with animate:false the final positions
            // aren't ready until it finishes), so capture on 'layoutstop'.
            // To make the layout reproducible for identical data, seed cose's
            // internal randomness: temporarily replace Math.random with a
            // deterministic PRNG seeded from a hash of the data, run the
            // layout, then restore Math.random.
            layout = cy.layout({ name: 'cose', animate: false, fit: true, padding: 20, randomize: true });
            layout.one('layoutstop', function() { postPositions(false); });
            var _origRandom = Math.random;
            var _seed = layoutSeed || 1;
            Math.random = function() {
                // mulberry32
                _seed |= 0; _seed = (_seed + 0x6D2B79F5) | 0;
                var t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
            try {
                layout.run();
            } finally {
                Math.random = _origRandom;
            }
        }
        var tip = document.getElementById('gc-tooltip');
        var wrapper = tip && tip.parentElement;
        function showTip(text, ev) {
            if (!tip || !wrapper) return;
            tip.textContent = text;
            tip.style.display = 'block';
            var rect = wrapper.getBoundingClientRect();
            var x = ev.originalEvent ? ev.originalEvent.clientX - rect.left + 10 : 10;
            var y = ev.originalEvent ? ev.originalEvent.clientY - rect.top + 10 : 10;
            tip.style.left = x + 'px';
            tip.style.top = y + 'px';
        }
        function hideTip() { if (tip) tip.style.display = 'none'; }
        cy.on('mouseover', 'node', function(ev) {
            var d = ev.target.data();
            showTip(d.tip || d.label || ev.target.id(), ev);
        });
        cy.on('mouseover', 'edge', function(ev) {
            var d = ev.target.data();
            var s = ev.target.source().data('label') || ev.target.source().id();
            var t = ev.target.target().data('label') || ev.target.target().id();
            var k = d.kind ? ' [' + d.kind + ']' : '';
            showTip(s + ' \u2192 ' + t + k, ev);
        });
        cy.on('mousemove', 'node, edge', function(ev) { showTip(tip.textContent, ev); });
        cy.on('mouseout', 'node, edge', hideTip);
    }
    init();
})();
</script>
`;
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function findNodesTable(edges: ResultTable, ctx?: ChartRenderContext, explicitName?: string): ResultTable | undefined {
    if (!ctx) return undefined;
    const others = ctx.tables.filter(t => t !== edges && t.rows.length > 0 && t.columns.length > 0);
    if (explicitName) {
        const lower = explicitName.toLowerCase();
        const match = others.find(t => t.name?.toLowerCase() === lower);
        if (match) return match;
    }
    // Auto-sense: only adopt a sibling literally named "nodes" (case-insensitive).
    // We deliberately do NOT auto-pick "the single other table" — a result set
    // may contain unrelated tables, and silently treating one as nodes is
    // surprising. Users wanting a specific table can select it explicitly.
    return others.find(t => t.name?.toLowerCase() === 'nodes');
}

function pickColumn(table: ResultTable, candidates: string[]): ColumnRef | undefined {
    const lower = table.columns.map(c => c.name.toLowerCase());
    for (const cand of candidates) {
        const idx = lower.indexOf(cand);
        if (idx >= 0) return getColumnRefByIndex(table, idx);
    }
    return undefined;
}

function optString(v: unknown): string | undefined {
    if (v == null) return undefined;
    const s = String(v);
    return s.length === 0 ? undefined : s;
}

/**
 * Order-independent-ish 32-bit hash of a list of strings (FNV-1a per item,
 * combined). Used to derive a deterministic seed for the cose layout so the
 * same graph data produces the same layout.
 */
function hashStringList(items: string[]): number {
    let h = 0x811c9dc5;
    for (const s of items) {
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        // separator between items
        h ^= 0x1b;
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

function stringOrId(v: unknown, fallback: string): string {
    return optString(v) ?? fallback;
}

/**
 * Maps a chart text-size preset to a Cytoscape node label font size (px).
 * Uses the same scale convention as the Plotly charts: Extra Small 0.5×,
 * Small 0.75×, Medium/Auto 1×, Large 1.5×, Extra Large 2×, applied to an
 * 11px base.
 */
function graphFontSize(preset?: string): number {
    const scale = preset === 'Extra Small' ? 0.5
        : preset === 'Small' ? 0.75
        : preset === 'Large' ? 1.5
        : preset === 'Extra Large' ? 2.0
        : 1.0;
    return Math.round(11 * scale);
}

function buildTooltip(label: string, kind: string | undefined, attrCols: ColumnRef[], row: (unknown | null)[]): string | undefined {
    const lines: string[] = [label];
    if (kind) lines.push('(' + kind + ')');
    for (const c of attrCols) {
        const v = row[c.index];
        if (v == null) continue;
        const s = String(v);
        if (s.length === 0) continue;
        lines.push(c.column.name + ': ' + s);
    }
    return lines.length > 0 ? lines.join('\n') : undefined;
}

function buildLegendHtml(
    nodeKindStyles: { kind: string; color: string }[],
    edgeKindStyles: { kind: string; color: string }[]
): string {
    const parts: string[] = ['<div class="gc-legend">'];
    if (nodeKindStyles.length > 0) {
        parts.push('<div class="gc-legend-section"><div class="gc-legend-title">Nodes</div>');
        for (const n of nodeKindStyles) {
            parts.push(`<div class="gc-legend-item"><span class="gc-legend-swatch" style="background:${n.color}"></span>${escapeHtml(n.kind)}</div>`);
        }
        parts.push('</div>');
    }
    if (edgeKindStyles.length > 0) {
        parts.push('<div class="gc-legend-section"><div class="gc-legend-title">Edges</div>');
        for (const e of edgeKindStyles) {
            parts.push(`<div class="gc-legend-item"><span class="gc-legend-swatch edge" style="background:${e.color}"></span>${escapeHtml(e.kind)}</div>`);
        }
        parts.push('</div>');
    }
    parts.push('</div>');
    return parts.join('');
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeForJsStringLiteral(json: string): string {
    return json
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/<\//g, '<\\/')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}
