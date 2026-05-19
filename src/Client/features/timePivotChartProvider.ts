// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Time Pivot chart provider — renders hierarchical time-range swimlane
 * visualizations using custom HTML/CSS (no Plotly dependency).
 */

import type { ChartOptions, ResultTable } from './server';
import { ChartColorways, ChartMode, hexToRgba, isDateTimeType, isNumericType, getColumnRef, getColumnRefByIndex } from './chartProvider';
import type { IChartView, IWebView, IChartProvider, ColumnRef } from './chartProvider';

// ─── View ───────────────────────────────────────────────────────────────────

class TimePivotChartView implements IChartView {
    onCopyResult: ((pngDataUrl: string, svgDataUrl?: string) => void) | undefined;
    onCopyError: ((error: string) => void) | undefined;
    private readonly subscription: { dispose(): void };

    constructor(
        private readonly webview: IWebView,
        private readonly render: (data: ResultTable, options: ChartOptions, darkMode: boolean) => string | undefined
    ) {
        this.subscription = webview.handle(() => { /* no webview messages expected */ });
    }

    copyChart(): void {
        // Copy not yet supported for HTML time pivot
    }

    renderChart(data: ResultTable, options: ChartOptions, darkMode: boolean): void {
        const bodyHtml = this.render(data, options, darkMode);
        if (bodyHtml) {
            this.webview.setContent(bodyHtml);
        }
    }

    dispose(): void {
        this.subscription.dispose();
    }
}

// ─── Provider ───────────────────────────────────────────────────────────────

export class TimePivotChartProvider implements IChartProvider {

    createView(webview: IWebView): IChartView {
        // No setup needed — TimePivot posts self-contained HTML via setContent.
        return new TimePivotChartView(webview, (data, options, darkMode) => this.renderTimePivotHtml(data, options, darkMode));
    }

    private renderTimePivotHtml(data: ResultTable, options: ChartOptions, darkMode: boolean): string | undefined {
        if (data.columns.length < 2 || data.rows.length === 0) return undefined;

        // Allow the chart's mode option to override the editor theme
        if (options.mode === ChartMode.Light) darkMode = false;
        else if (options.mode === ChartMode.Dark) darkMode = true;

        // Theme palette — explicit so the rendered chart honors the chosen mode
        // regardless of the host (webview / exported HTML) theme.
        const theme = darkMode
            ? {
                background: '#1e1e1e',
                foreground: '#cccccc',
                descForeground: '#9d9d9d',
                border: '#3c3c3c',
                gridLine: 'rgba(255,255,255,0.08)',
                focusBorder: '#007fd4',
            }
            : {
                background: '#ffffff',
                foreground: '#333333',
                descForeground: '#717171',
                border: '#d4d4d4',
                gridLine: 'rgba(0,0,0,0.08)',
                focusBorder: '#0090f1',
            };

        // Find datetime columns and candidate series columns
        const datetimeCols: ColumnRef[] = [];
        const seriesCandidates: ColumnRef[] = [];

        for (let i = 0; i < data.columns.length; i++) {
            const col = data.columns[i];
            if (!col) continue;
            if (isDateTimeType(col.type)) {
                const ref = getColumnRefByIndex(data, i);
                if (ref) datetimeCols.push(ref);
            } else if (!isNumericType(col.type)) {
                const ref = getColumnRefByIndex(data, i);
                if (ref) seriesCandidates.push(ref);
            }
        }

        if (datetimeCols.length === 0) return undefined;

        const startColumn = datetimeCols[0]!;
        const endColumn = datetimeCols.length >= 2 ? datetimeCols[1]! : undefined;
        const isRangeMode = endColumn !== undefined;

        // Resolve series columns: use explicit, or auto-infer first non-datetime non-numeric
        let seriesCols: ColumnRef[];
        if (options.seriesColumns && options.seriesColumns.length > 0) {
            seriesCols = options.seriesColumns
                .map(name => getColumnRef(data, name))
                .filter((c): c is ColumnRef => c !== undefined);
        } else {
            seriesCols = seriesCandidates.length > 0 ? [seriesCandidates[0]!] : [];
        }

        if (seriesCols.length === 0) return undefined;

        // Build tree: each series column = one nesting level, leaf = data rows
        interface PivotRow { start: number; end: number; }
        interface TreeNode {
            key: string;
            children: Map<string, TreeNode>;
            childOrder: string[];
            rows: PivotRow[];
            level: number;
        }

        const root: TreeNode = { key: '', children: new Map(), childOrder: [], rows: [], level: -1 };
        let globalMin = Infinity;
        let globalMax = -Infinity;

        for (const row of data.rows) {
            if (!row) continue;
            const startVal = row[startColumn.index];
            if (startVal == null) continue;
            const startMs = new Date(String(startVal)).getTime();
            if (isNaN(startMs)) continue;

            let endMs: number;
            if (isRangeMode) {
                const endVal = row[endColumn.index];
                if (endVal == null) continue;
                endMs = new Date(String(endVal)).getTime();
                if (isNaN(endMs)) continue;
            } else {
                endMs = startMs;
            }

            if (startMs < globalMin) globalMin = startMs;
            if (endMs > globalMax) globalMax = endMs;

            // Walk down the tree, creating nodes at each series level
            let node = root;
            for (let lvl = 0; lvl < seriesCols.length; lvl++) {
                const key = String(row[seriesCols[lvl]!.index] ?? '');
                if (!node.children.has(key)) {
                    node.children.set(key, { key, children: new Map(), childOrder: [], rows: [], level: lvl });
                    node.childOrder.push(key);
                }
                node = node.children.get(key)!;
            }
            node.rows.push({ start: startMs, end: endMs });
        }

        if (root.childOrder.length === 0 || globalMin >= globalMax) return undefined;

        const globalRange = globalMax - globalMin;
        const colors = ChartColorways.Default;
        const maxLevel = seriesCols.length - 1;

        const pct = (ms: number) => ((ms - globalMin) / globalRange * 100);
        const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

        // Compute time range for a node (all descendant rows)
        function nodeRange(node: TreeNode): { min: number; max: number } {
            let min = Infinity;
            let max = -Infinity;
            for (const r of node.rows) {
                if (r.start < min) min = r.start;
                if (r.start > max) max = r.start;
                if (r.end < min) min = r.end;
                if (r.end > max) max = r.end;
            }
            for (const child of node.children.values()) {
                const cr = nodeRange(child);
                if (cr.min < min) min = cr.min;
                if (cr.max > max) max = cr.max;
            }
            return { min, max };
        }

        // Count leaf descendants
        function leafCount(node: TreeNode): number {
            if (node.children.size === 0) return 1;
            let count = 0;
            for (const child of node.children.values()) count += leafCount(child);
            return count;
        }

        // Collect all rows from descendant leaves
        function allRows(node: TreeNode): PivotRow[] {
            if (node.children.size === 0) return node.rows;
            const result: PivotRow[] = [];
            for (const child of node.children.values()) result.push(...allRows(child));
            return result;
        }

        // Build time axis ticks
        const tickCount = 8;
        const tickSpanMs = globalRange / tickCount;
        const tickSpanDays = tickSpanMs / (24 * 60 * 60 * 1000);
        const firstDay = new Date(globalMin).toISOString().slice(0, 10);
        const lastDay = new Date(globalMin + globalRange).toISOString().slice(0, 10);
        const sameDay = firstDay === lastDay;
        const ticksHtml: string[] = [];
        for (let i = 0; i <= tickCount; i++) {
            const ms = globalMin + (globalRange * i / tickCount);
            const d = new Date(ms);
            const fullLabel = d.toISOString().replace('T', ' ').replace(/\.000Z$/, '');
            const shortLabel = sameDay
                ? d.toISOString().slice(11).replace(/\.000Z$/, '')
                : tickSpanDays >= 1 ? d.toISOString().slice(0, 10) : fullLabel;
            const left = (i / tickCount * 100);
            const tickClass = i === 0 ? ' tp-tick-first' : '';
            ticksHtml.push(`<div class="tp-tick${tickClass}" style="left:${left}%"><div class="tp-tick-line"></div><div class="tp-tick-label" title="${esc(fullLabel)}">${esc(shortLabel)}</div></div>`);
        }

        // Recursively build rows
        const rowsHtml: string[] = [];
        let colorIndex = 0;

        function renderNode(node: TreeNode, color: string, depth: number, parentPath: string): void {
            const isLeaf = node.level === maxLevel;
            const indent = depth * 16;
            const range = nodeRange(node);
            const bgLeft = pct(range.min);
            const bgWidth = pct(range.max) - bgLeft;
            const nodeRange_ = range.max - range.min;
            const pctLocal = (ms: number) => nodeRange_ > 0 ? ((ms - range.min) / nodeRange_ * 100) : 0;

            if (!isLeaf) {
                // Group row with toggle + spanning bar
                const count = leafCount(node);
                const bgOpacity = 0.3 - depth * 0.05; // slightly lighter at each level
                const nodePath = parentPath ? `${parentPath}/${node.key}` : node.key;
                const collapsedClass = 'collapsed';
                const hiddenClass = depth > 0 ? ' tp-hidden' : '';

                // Build aggregated segments from all descendant leaves
                let aggSegments = '';
                const descRows = allRows(node);
                if (isRangeMode) {
                    for (const r of descRows) {
                        const segLeft = pctLocal(r.start);
                        const segWidth = pctLocal(r.end) - segLeft;
                        const startLabel = new Date(r.start).toISOString().replace('T', ' ').replace(/\.000Z$/, '');
                        const endLabel = new Date(r.end).toISOString().replace('T', ' ').replace(/\.000Z$/, '');
                        aggSegments += `<div class="tp-segment" style="left:${segLeft}%;width:${segWidth}%;background:${color}" title="${esc(startLabel)} \u2192 ${esc(endLabel)}"></div>`;
                    }
                } else {
                    for (const r of descRows) {
                        const dotLeft = pctLocal(r.start);
                        const dotLabel = new Date(r.start).toISOString().replace('T', ' ').replace(/\.000Z$/, '');
                        aggSegments += `<div class="tp-dot" style="left:${dotLeft}%;background:${color}" title="${esc(dotLabel)}"></div>`;
                    }
                }

                const rangeStartLabel = new Date(range.min).toISOString().replace('T', ' ').replace(/\.000Z$/, '');
                const rangeEndLabel = new Date(range.max).toISOString().replace('T', ' ').replace(/\.000Z$/, '');
                const bgTitle = `${esc(rangeStartLabel)} \u2192 ${esc(rangeEndLabel)} (${count})`;

                rowsHtml.push(
                    `<div class="tp-row tp-group ${collapsedClass}${hiddenClass}" data-group="${esc(nodePath)}" data-depth="${depth}">` +
                    `<div class="tp-label tp-group-label" style="padding-left:${8 + indent}px" title="${esc(node.key)} (${count})">` +
                    `<span class="tp-toggle">&#9662;</span>` +
                    `${esc(node.key)} <span class="tp-count">(${count})</span></div>` +
                    `<div class="tp-swimlane"><div class="tp-bg-bar" style="left:${bgLeft}%;width:${bgWidth}%;background:${hexToRgba(color, Math.max(bgOpacity, 0.1))}" title="${bgTitle}"><div class="tp-agg">${aggSegments}</div></div></div></div>`
                );

                // Render children
                for (const childKey of node.childOrder) {
                    const child = node.children.get(childKey)!;
                    renderNode(child, color, depth + 1, nodePath);
                }
            } else {
                // Leaf detail row
                const bgColor = hexToRgba(color, 0.15);
                let segmentsHtml = '';

                if (isRangeMode) {
                    for (const r of node.rows) {
                        const segLeft = pctLocal(r.start);
                        const segWidth = pctLocal(r.end) - segLeft;
                        const startLabel = new Date(r.start).toISOString().replace('T', ' ').replace(/\.000Z$/, '');
                        const endLabel = new Date(r.end).toISOString().replace('T', ' ').replace(/\.000Z$/, '');
                        segmentsHtml += `<div class="tp-segment" style="left:${segLeft}%;width:${segWidth}%;background:${color}" title="${esc(startLabel)} \u2192 ${esc(endLabel)}"></div>`;
                    }
                } else {
                    for (const r of node.rows) {
                        const dotLeft = pctLocal(r.start);
                        const dotLabel = new Date(r.start).toISOString().replace('T', ' ').replace(/\.000Z$/, '');
                        segmentsHtml += `<div class="tp-dot" style="left:${dotLeft}%;background:${color}" title="${esc(dotLabel)}"></div>`;
                    }
                }

                const parentPath2 = parentPath ? parentPath : '';
                const leafHidden = depth > 0 ? ' tp-hidden' : '';
                const leafRangeStart = new Date(range.min).toISOString().replace('T', ' ').replace(/\.000Z$/, '');
                const leafRangeEnd = new Date(range.max).toISOString().replace('T', ' ').replace(/\.000Z$/, '');
                const leafBgTitle = `${esc(leafRangeStart)} \u2192 ${esc(leafRangeEnd)} (${node.rows.length})`;
                rowsHtml.push(
                    `<div class="tp-row tp-leaf${leafHidden}" data-parent-group="${esc(parentPath2)}" data-depth="${depth}">` +
                    `<div class="tp-label" style="padding-left:${8 + indent}px" title="${esc(node.key)}">${esc(node.key)}</div>` +
                    `<div class="tp-swimlane">` +
                    `<div class="tp-bg-bar" style="left:${bgLeft}%;width:${bgWidth}%;background:${bgColor}" title="${leafBgTitle}">` +
                    segmentsHtml +
                    `</div></div></div>`
                );
            }
        }

        // Render top-level nodes
        for (const topKey of root.childOrder) {
            const topNode = root.children.get(topKey)!;
            const color = colors[colorIndex % colors.length]!;
            renderNode(topNode, color, 0, '');
            colorIndex++;
        }

        const titleHtml = options.title ? `<div class="tp-title">${esc(options.title)}</div>` : '';

        return `
<style>
.tp-wrapper {
    --tp-label-width: 180px;
    --tp-bg: ${theme.background};
    --tp-fg: ${theme.foreground};
    --tp-desc-fg: ${theme.descForeground};
    --tp-border: ${theme.border};
    --tp-grid: ${theme.gridLine};
    --tp-focus: ${theme.focusBorder};
    position: relative;
    height: 100%;
    background: var(--tp-bg);
    color: var(--tp-fg);
}
.tp-container {
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--tp-fg);
    overflow-x: hidden;
    overflow-y: auto;
    height: 100%;
    user-select: none;
}
.tp-title {
    font-size: 1.2em;
    font-weight: 600;
    padding: 8px 12px 4px;
}
.tp-axis {
    display: flex;
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--tp-bg);
    border-bottom: 1px solid var(--tp-border);
}
.tp-axis-label-spacer {
    flex: 0 0 var(--tp-label-width);
    min-width: var(--tp-label-width);
    box-sizing: border-box;
    position: sticky;
    left: 0;
    z-index: 3;
    background: var(--tp-bg);
}
.tp-axis-ticks {
    flex: 1;
    position: relative;
    height: 36px;
}
.tp-tick {
    position: absolute;
    top: 0;
    height: 100%;
}
.tp-tick-line {
    width: 1px;
    height: 18px;
    background: var(--tp-border);
}
.tp-tick-label {
    font-size: 10px;
    white-space: nowrap;
    color: var(--tp-desc-fg);
    transform: translateX(-50%);
    padding-top: 2px;
}
.tp-tick-first {
    z-index: 4;
}
.tp-rows {
    position: relative;
}
.tp-row {
    display: flex;
    align-items: center;
    min-height: 26px;
    border-bottom: 1px solid var(--tp-grid);
}
.tp-group {
    min-height: 28px;
}
.tp-label {
    flex: 0 0 var(--tp-label-width);
    min-width: var(--tp-label-width);
    box-sizing: border-box;
    padding: 2px 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    position: sticky;
    left: 0;
    z-index: 1;
    background: var(--tp-bg);
}
.tp-resize-handle {
    position: absolute;
    top: 0;
    bottom: 0;
    left: var(--tp-label-width);
    width: 5px;
    margin-left: -2px;
    cursor: col-resize;
    z-index: 5;
}
.tp-resize-handle:hover,
.tp-resize-handle.active {
    background: var(--tp-focus);
}
.tp-group-label {
    font-weight: 600;
}
.tp-count {
    color: var(--tp-desc-fg);
    font-weight: normal;
    font-size: 11px;
}
.tp-toggle {
    cursor: pointer;
    display: inline-block;
    transition: transform 0.15s;
    margin-right: 4px;
}
.tp-group.collapsed .tp-toggle {
    transform: rotate(-90deg);
}
.tp-agg {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    pointer-events: none;
}
.tp-agg > * {
    pointer-events: auto;
}
.tp-group:not(.collapsed) .tp-agg {
    display: none;
}
.tp-hidden {
    display: none !important;
}
.tp-swimlane {
    flex: 1;
    position: relative;
    height: 20px;
    margin: 2px 8px 2px 0;
    overflow: hidden;
}
.tp-group .tp-swimlane {
    height: 16px;
}
.tp-bg-bar {
    position: absolute;
    top: 0;
    height: 100%;
    border-radius: 3px;
    min-width: 4px;
}
.tp-segment {
    position: absolute;
    top: 50%;
    height: 6px;
    transform: translateY(-50%);
    border-radius: 2px;
    opacity: 0.9;
    min-width: 4px;
}
.tp-dot {
    position: absolute;
    top: 50%;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    transform: translate(-50%, -50%);
}
.tp-grid-line {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--tp-grid);
    pointer-events: none;
}
</style>
<div class="tp-wrapper" id="tp-wrapper">
    <div class="tp-resize-handle" id="tp-resize-handle"></div>
    <div class="tp-container">
    ${titleHtml}
    <div class="tp-axis">
        <div class="tp-axis-label-spacer"></div>
        <div class="tp-axis-ticks">${ticksHtml.join('')}</div>
    </div>
    <div class="tp-rows" id="tp-rows-container">
        ${rowsHtml.join('\n        ')}
    </div>
    </div>
</div>
<script>
(function() {
    // Resize handle for label column
    (function() {
        var handle = document.getElementById('tp-resize-handle');
        var wrapper = document.getElementById('tp-wrapper');
        if (!handle || !wrapper) return;
        var startX, startWidth;
        handle.addEventListener('mousedown', function(e) {
            e.preventDefault();
            startX = e.clientX;
            startWidth = parseInt(getComputedStyle(wrapper).getPropertyValue('--tp-label-width')) || 180;
            handle.classList.add('active');
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
        function onMove(e) {
            var newWidth = Math.max(80, startWidth + (e.clientX - startX));
            wrapper.style.setProperty('--tp-label-width', newWidth + 'px');
        }
        function onUp() {
            handle.classList.remove('active');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        }
    })();

    // Toggle collapse/expand for any group level
    document.querySelectorAll('.tp-toggle').forEach(function(toggle) {
        toggle.addEventListener('click', function(e) {
            e.stopPropagation();
            var group = this.closest('.tp-group');
            if (!group) return;
            var isCollapsing = !group.classList.contains('collapsed');
            group.classList.toggle('collapsed');
            var groupPath = group.dataset.group;
            // Hide/show all descendant rows whose parent-group starts with this path
            var allRows = group.parentElement.children;
            var found = false;
            for (var i = 0; i < allRows.length; i++) {
                if (allRows[i] === group) { found = true; continue; }
                if (!found) continue;
                var row = allRows[i];
                var rowGroup = row.dataset.group || row.dataset.parentGroup || '';
                // Stop if we hit a sibling at same or higher level
                if (row.classList.contains('tp-group') && !rowGroup.startsWith(groupPath + '/')) break;
                if (row.classList.contains('tp-leaf') && !rowGroup.startsWith(groupPath)) break;
                if (isCollapsing) {
                    row.classList.add('tp-hidden');
                    // Also collapse nested groups
                    if (row.classList.contains('tp-group')) row.classList.add('collapsed');
                } else {
                    // Only show direct children (not nested collapsed ones)
                    var rowDepth = parseInt(row.dataset.depth || '0');
                    var groupDepth = parseInt(group.dataset.depth || '0');
                    if (rowDepth === groupDepth + 1) {
                        row.classList.remove('tp-hidden');
                        // Keep nested groups collapsed
                    }
                }
            }
        });
    });
})();
</script>`;
    }
}
