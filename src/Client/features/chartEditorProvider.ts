// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Chart editor — builds and manages the chart-options edit panel.
 *
 * The editor generates a form whose controls mirror the `ChartOptions` type.
 * When the user changes any control, the in-page JS collects the values and
 * posts a `chartOptionsChanged` message, which the controller forwards via its
 * `onOptionsChanged` callback.
 */

import { ChartAspectRatio, ChartSortOrder, ChartTextSize, ChartYLayout, ChartLegendPosition } from './chartProvider';
import type { ChartOptions } from './server';
import type { IWebView } from './webview';
import { escapeHtml } from './html';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Known chart types for the edit panel dropdown. Maps internal ID → UI display name. */
const chartTypes: ReadonlyMap<string, string> = new Map([
    ['Area', 'Area (areachart)'],
    ['AreaStacked', 'Area - Stacked (areachart)'],
    ['AreaStacked100', 'Area - Stacked 100% (areachart)'],
    ['Bar', 'Bar (barchart)'],
    ['BarStacked', 'Bar - Stacked (barchart)'],
    ['BarStacked100', 'Bar - Stacked 100% (barchart)'],
    ['Card', 'Card (card)'],
    ['Column', 'Column (columnchart)'],
    ['ColumnStacked', 'Column - Stacked (columnchart)'],
    ['ColumnStacked100', 'Column - Stacked 100% (columnchart)'],
    ['Graph', 'Graph (graph)'],
    ['Ladder', 'Time - Ladder (ladderchart)'],
    ['Line', 'Line (linechart)'],
    ['Pie', 'Pie (piechart)'],
    ['Plotly', 'Plotly (plotly)'],
    ['Sankey', 'Sankey (sankey)'],
    ['Scatter', 'Scatter (scatterchart)'],
    ['ThreeD', '3D (3Dchart)'],
    ['TimeLine', 'Time - Line (timechart)'],
    ['TimeLineAnomaly', 'Time - Line w/ Anomalies (anomalychart)'],
    ['TimePivot', 'Time - Pivot (timepivot)'],
    ['TreeMap', 'Tree Map (treemap)'],
]);

const legendPositions: [string, string][] = [['Auto', 'Auto'], ['Right', 'Right'], ['Bottom', 'Bottom'], ['None', 'None']];
const axisTypes = ['Linear', 'Log'];
const sortOrders = [ChartSortOrder.Auto, ChartSortOrder.Ascending, ChartSortOrder.Descending];
const chartModes: [string, string][] = [['Auto', 'Auto'], ['Light', 'Light'], ['Dark', 'Dark']];
const aspectRatios = [ChartAspectRatio.Fill, ChartAspectRatio.Ratio16x9, ChartAspectRatio.Ratio3x2, ChartAspectRatio.Ratio4x3, ChartAspectRatio.Ratio1x1, ChartAspectRatio.Ratio3x4, ChartAspectRatio.Ratio2x3, ChartAspectRatio.Ratio9x16];
const textSizes: [string, string][] = [['Auto', 'Auto'], ['Extra Small', 'Extra Small'], ['Small', 'Small'], ['Medium', 'Medium'], ['Large', 'Large'], ['Extra Large', 'Extra Large']];
const markerShapeOptions: [string, string][] = [
    ['Circle', 'Circle'],
    ['Diamond', 'Diamond'],
    ['Square', 'Square'],
    ['TriangleUp', 'Triangle Up'],
    ['Cross', 'Cross'],
    ['Star', 'Star'],
    ['X', 'X'],
];
const markerShapeLabels: ReadonlyMap<string, string> = new Map([
    ['Circle', 'Circle'],
    ['Diamond', 'Diamond'],
    ['Square', 'Square'],
    ['TriangleUp', 'Triangle Up'],
    ['Cross', 'Cross'],
    ['Star', 'Star'],
    ['X', 'X'],
]);
const tickAngles = [0, 15, 30, 45, 60, 75, 90, -15, -30, -45, -60, -75, -90];
const aggregationTypes = ['Sum', 'Count', 'Average', 'Min', 'Max'];
const maxSeriesOptions = [10, 20, 30, 40, 50];
const maxPointsOptions = [100, 500, 1000, 5000, 10000, 50000];
const defaultMarkerShape = 'Circle';
const defaultMarkerSize = ChartTextSize.Medium;
const defaultableChartOptionKeys: Array<keyof ChartOptions> = [
    'legendPosition', 'sort', 'aspectRatio', 'textSize', 'yLayout', 'accumulate',
    'showValues', 'showMarkers', 'markerOutline', 'cycleMarkerShapes', 'xShowTicks',
    'yShowTicks', 'yMirror', 'xShowGrid', 'yShowGrid', 'markerShape', 'markerSize',
    'xTickAngle', 'yTickAngle'
];

// ─── Interfaces ─────────────────────────────────────────────────────────────

/** Lightweight description of a result table for the chart editor. */
export interface ChartEditorTableInfo {
    name: string;
    columns: string[];
}

/**
 * View for the chart-options edit panel in a webview.
 * Created by `IChartEditorProvider.createView()`.
 */
export interface IChartEditorView {
    /** Populate (or re-populate) the edit panel with the given options and column names.
     *  `tables` lists all sibling result tables (used by graph chart options). */
    setOptions(options: ChartOptions | undefined, columnNames: string[], defaults?: Partial<ChartOptions>, tables?: ChartEditorTableInfo[], primaryTableName?: string): void;
    /** Fires when the user changes any chart option in the edit panel. */
    onOptionsChanged: ((options: ChartOptions) => void) | undefined;
    /** Release handlers and resources. */
    dispose(): void;
}

/** Provider for creating chart editor views bound to webview regions. */
export interface IChartEditorProvider {
    createView(webview: IWebView): IChartEditorView;
}

// ─── Implementation ─────────────────────────────────────────────────────────

class ChartEditorView implements IChartEditorView {
    private readonly webview: IWebView;
    private readonly subscription: { dispose(): void };
    private currentOptions: ChartOptions = { type: 'Column' };
    private currentDefaults: Partial<ChartOptions> = {};
    onOptionsChanged: ((options: ChartOptions) => void) | undefined;

    constructor(webview: IWebView) {
        this.webview = webview;
        webview.setup(this.buildCss(), this.buildScripts());
        this.subscription = webview.handle((msg) => {
            if (msg.command === 'chartOptionsChanged' && msg.chartOptions) {
                this.currentOptions = msg.chartOptions as ChartOptions;
                this.onOptionsChanged?.(msg.chartOptions as ChartOptions);
            } else if (msg.command === 'chartEditorDefaultsAction' && typeof msg.action === 'string') {
                const updatedOptions = msg.action === 'capture'
                    ? this.captureCurrentDefaults(this.currentOptions, this.currentDefaults)
                    : this.restoreMatchingDefaults(this.currentOptions, this.currentDefaults);
                this.currentOptions = updatedOptions;
                this.webview.setContent(this.buildFormHtml(updatedOptions, this.lastColumnNames, this.currentDefaults, this.lastTables, this.lastPrimaryTableName));
                this.onOptionsChanged?.(updatedOptions);
            }
        });
    }

    private lastColumnNames: string[] = [];
    private lastTables: ChartEditorTableInfo[] = [];
    private lastPrimaryTableName: string | undefined;

    setOptions(options: ChartOptions | undefined, columnNames: string[], defaults?: Partial<ChartOptions>, tables?: ChartEditorTableInfo[], primaryTableName?: string): void {
        this.currentOptions = options ?? { type: 'Column' };
        this.lastColumnNames = columnNames;
        this.lastTables = tables ?? [];
        this.lastPrimaryTableName = primaryTableName;
        this.currentDefaults = defaults ?? {};
        this.webview.setContent(this.buildFormHtml(this.currentOptions, columnNames, this.currentDefaults, this.lastTables, this.lastPrimaryTableName));
    }

    dispose(): void {
        this.subscription.dispose();
    }

    private getResolvedDefaults(defaults: Partial<ChartOptions>): Partial<ChartOptions> {
        const resolvedDefaults: Partial<ChartOptions> = {
            legendPosition: defaults.legendPosition ?? ChartLegendPosition.Auto,
            sort: defaults.sort ?? ChartSortOrder.Auto,
            aspectRatio: defaults.aspectRatio ?? ChartAspectRatio.Fill,
            textSize: defaults.textSize ?? ChartTextSize.Auto,
            yLayout: ChartYLayout.SharedAxis,
            accumulate: defaults.accumulate ?? false,
            showValues: defaults.showValues ?? false,
            showMarkers: defaults.showMarkers ?? false,
            markerOutline: defaults.markerOutline ?? false,
            markerShape: defaults.markerShape ?? defaultMarkerShape,
            markerSize: defaults.markerSize ?? defaultMarkerSize,
            cycleMarkerShapes: defaults.cycleMarkerShapes ?? false,
            xShowTicks: defaults.xShowTicks ?? false,
            yShowTicks: defaults.yShowTicks ?? false,
            yMirror: defaults.yMirror ?? false,
            xShowGrid: defaults.xShowGrid ?? true,
            yShowGrid: defaults.yShowGrid ?? true,
        };

        if (defaults.xTickAngle != null) {
            resolvedDefaults.xTickAngle = defaults.xTickAngle;
        }
        if (defaults.yTickAngle != null) {
            resolvedDefaults.yTickAngle = defaults.yTickAngle;
        }

        return resolvedDefaults;
    }

    private captureCurrentDefaults(options: ChartOptions, defaults: Partial<ChartOptions>): ChartOptions {
        const resolvedDefaults = this.getResolvedDefaults(defaults);
        const updatedOptions: ChartOptions = { ...options };

        for (const key of defaultableChartOptionKeys) {
            if (updatedOptions[key] == null) {
                const resolvedValue = resolvedDefaults[key];
                if (resolvedValue != null) {
                    updatedOptions[key] = resolvedValue as never;
                }
            }
        }

        return updatedOptions;
    }

    private restoreMatchingDefaults(options: ChartOptions, defaults: Partial<ChartOptions>): ChartOptions {
        const resolvedDefaults = this.getResolvedDefaults(defaults);
        const updatedOptions: ChartOptions = { ...options };

        for (const key of defaultableChartOptionKeys) {
            const resolvedValue = resolvedDefaults[key];
            if (resolvedValue != null && updatedOptions[key] === resolvedValue) {
                delete updatedOptions[key];
            }
        }

        return updatedOptions;
    }

    // ─── HTML Builders ──────────────────────────────────────────────────

    private buildCss(): string {
        return `<style>
        .edit-panel {
            display: none;
            width: 280px;
            min-width: 280px;
            border-left: 1px solid var(--vscode-panel-border, #444);
            background: var(--vscode-sideBar-background, var(--vscode-editor-background));
            overflow-y: auto;
            padding: 0;
            box-sizing: border-box;
        }
        .edit-panel.visible { display: block; }
        .edit-panel .panel-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin: 0;
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-panel-border, #444);
        }
        .edit-panel .panel-header h3 {
            margin: 0;
            font-size: 13px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-foreground);
            opacity: 0.8;
        }
        .edit-panel .header-actions {
            position: relative;
            display: flex;
            align-items: center;
        }
        .edit-panel .icon-button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 24px;
            height: 24px;
            border: none;
            border-radius: 4px;
            background: transparent;
            color: var(--vscode-foreground);
            cursor: pointer;
            opacity: 0.8;
            font-size: 14px;
        }
        .edit-panel .icon-button:hover {
            background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground, #2a2d2e));
            opacity: 1;
        }
        .edit-panel .header-menu {
            position: absolute;
            top: calc(100% + 4px);
            right: 0;
            display: none;
            min-width: 170px;
            padding: 4px;
            border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border, #444));
            border-radius: 4px;
            background: var(--vscode-menu-background, var(--vscode-editorWidget-background, #252526));
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
            z-index: 10;
        }
        .edit-panel .header-menu.visible {
            display: block;
        }
        .edit-panel .menu-item {
            display: block;
            width: 100%;
            padding: 6px 8px;
            border: none;
            border-radius: 3px;
            background: transparent;
            color: var(--vscode-menu-foreground, var(--vscode-foreground));
            text-align: left;
            cursor: pointer;
            font: inherit;
        }
        .edit-panel .menu-item:hover {
            background: var(--vscode-list-hoverBackground, #2a2d2e);
        }
        .edit-panel .section-header {
            display: flex;
            align-items: center;
            padding: 6px 12px;
            cursor: pointer;
            user-select: none;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.3px;
            color: var(--vscode-foreground);
            background: var(--vscode-sideBarSectionHeader-background, transparent);
            border-bottom: 1px solid var(--vscode-panel-border, #444);
        }
        .edit-panel .section-header:hover {
            background: var(--vscode-list-hoverBackground, #2a2d2e);
        }
        .edit-panel .section-header .chevron {
            margin-right: 6px;
            font-size: 10px;
            transition: transform 0.15s;
            display: inline-block;
            width: 10px;
        }
        .edit-panel .section-header.collapsed .chevron {
            transform: rotate(-90deg);
        }
        .edit-panel .section-body {
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-panel-border, #444);
        }
        .edit-panel .section-body.collapsed {
            display: none;
        }
        .edit-panel .field { margin-bottom: 10px; }
        .edit-panel .field:last-child { margin-bottom: 0; }
        .edit-panel .field-row {
            display: flex;
            gap: 8px;
        }
        .edit-panel .field-row .field {
            flex: 1;
            min-width: 0;
            margin-bottom: 10px;
        }
        .edit-panel label {
            display: block;
            margin-bottom: 3px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground, var(--vscode-foreground));
        }
        .edit-panel select,
        .edit-panel input[type="text"],
        .edit-panel input[type="number"] {
            width: 100%;
            padding: 4px 6px;
            background: var(--vscode-input-background, #3c3c3c);
            color: var(--vscode-input-foreground, var(--vscode-foreground));
            border: 1px solid var(--vscode-input-border, #555);
            border-radius: 2px;
            font-family: inherit;
            font-size: inherit;
            box-sizing: border-box;
        }
        .edit-panel select:focus,
        .edit-panel input[type="text"]:focus,
        .edit-panel input[type="number"]:focus {
            outline: 1px solid var(--vscode-focusBorder, #007acc);
            outline-offset: -1px;
        }
        .edit-panel .checkbox-field {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .edit-panel .checkbox-field label {
            display: inline;
            margin-bottom: 0;
        }
        .edit-panel .column-list {
            list-style: none;
            padding: 0;
            margin: 4px 0 0 0;
            max-height: 120px;
            overflow-y: auto;
            border: 1px solid var(--vscode-input-border, #555);
            border-radius: 2px;
            background: var(--vscode-input-background, #3c3c3c);
        }
        .edit-panel .column-list:empty {
            display: none;
        }
        .edit-panel .column-list li {
            display: flex;
            align-items: center;
            padding: 2px 4px;
            gap: 2px;
        }
        .edit-panel .column-list li:hover {
            background: var(--vscode-list-hoverBackground, #2a2d2e);
        }
        .edit-panel .column-list li span {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .edit-panel .column-list li button {
            background: none;
            border: none;
            color: var(--vscode-foreground, #ccc);
            cursor: pointer;
            padding: 0 2px;
            font-size: 14px;
            line-height: 1;
            opacity: 0.7;
        }
        .edit-panel .column-list li button:hover {
            opacity: 1;
        }
        </style>`;
    }

    private buildScripts(): string {
        return `<script>
        function _editorAddColumnItem(pickerId, listId) {
            var picker = document.getElementById(pickerId);
            var list = document.getElementById(listId);
            if (!picker || !list || !picker.value) return;
            var val = picker.value;
            var li = document.createElement('li');
            var span = document.createElement('span');
            span.textContent = val;
            li.appendChild(span);
            var upBtn = document.createElement('button');
            upBtn.innerHTML = '&uarr;';
            upBtn.title = 'Move up';
            upBtn.onclick = function() { _editorMoveColumnItem(upBtn, -1); };
            li.appendChild(upBtn);
            var downBtn = document.createElement('button');
            downBtn.innerHTML = '&darr;';
            downBtn.title = 'Move down';
            downBtn.onclick = function() { _editorMoveColumnItem(downBtn, 1); };
            li.appendChild(downBtn);
            var removeBtn = document.createElement('button');
            removeBtn.innerHTML = '&times;';
            removeBtn.title = 'Remove';
            removeBtn.onclick = function() { _editorRemoveColumnItem(removeBtn); };
            li.appendChild(removeBtn);
            list.appendChild(li);
            picker.selectedIndex = 0;
            _editorUpdateColumnPlaceholder(picker, list);
            _editorOnChartOptionChanged();
        }

        function _editorRemoveColumnItem(btn) {
            var li = btn.closest('li');
            if (li) {
                var list = li.parentNode;
                var pickerId = list.id.replace('-list', '-picker');
                li.remove();
                var picker = document.getElementById(pickerId);
                if (picker) _editorUpdateColumnPlaceholder(picker, list);
                _editorOnChartOptionChanged();
            }
        }

        function _editorUpdateColumnPlaceholder(picker, list) {
            var firstOpt = picker.options[0];
            if (firstOpt) {
                firstOpt.textContent = list.children.length > 0 ? '(add)' : '(auto)';
            }
        }

        function _editorMoveColumnItem(btn, dir) {
            var li = btn.closest('li');
            if (!li) return;
            var list = li.parentNode;
            if (dir === -1 && li.previousElementSibling) {
                list.insertBefore(li, li.previousElementSibling);
            } else if (dir === 1 && li.nextElementSibling) {
                list.insertBefore(li.nextElementSibling, li);
            }
            _editorOnChartOptionChanged();
        }

        function _editorToggleSection(headerEl) {
            headerEl.classList.toggle('collapsed');
            var body = headerEl.nextElementSibling;
            if (body) body.classList.toggle('collapsed');
        }

        function _editorToggleDefaultsMenu(btn) {
            var menu = btn.nextElementSibling;
            if (menu) {
                menu.classList.toggle('visible');
            }
        }

        function _editorRunDefaultsAction(action) {
            var menus = document.querySelectorAll('.header-menu.visible');
            menus.forEach(function(menu) { menu.classList.remove('visible'); });
            if (window._vscodeApi) {
                window._vscodeApi.postMessage({ command: 'chartEditorDefaultsAction', action: action });
            }
        }

        // Repopulate the node Id/Label/Kind column dropdowns from the columns
        // of the newly selected Nodes Table. Done entirely client-side using
        // the table→columns map embedded on the select, so the form is not
        // rebuilt (which would reset section collapse state and focus).
        function _editorOnNodesTableChanged() {
            var sel = document.getElementById('opt-nodesTable');
            if (sel) {
                var map = {};
                try { map = JSON.parse(sel.getAttribute('data-node-columns') || '{}'); } catch (e) {}
                var cols = map[sel.value] || [];
                ['opt-nodeIdColumn', 'opt-nodeLabelColumn', 'opt-nodeKindColumn'].forEach(function(id) {
                    var colSel = document.getElementById(id);
                    if (!colSel) return;
                    var prev = colSel.value;
                    var html = '<option value="">(auto)</option>';
                    var keep = false;
                    for (var i = 0; i < cols.length; i++) {
                        var c = String(cols[i]);
                        var selAttr = (c === prev) ? ' selected' : '';
                        if (c === prev) keep = true;
                        html += '<option value="' + _editorEscapeAttr(c) + '"' + selAttr + '>' + _editorEscapeHtml(c) + '</option>';
                    }
                    colSel.innerHTML = html;
                    // If the previously selected column no longer exists, fall
                    // back to (auto).
                    colSel.value = keep ? prev : '';
                });
            }
            _editorOnChartOptionChanged();
        }

        function _editorEscapeHtml(s) {
            return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
        function _editorEscapeAttr(s) {
            return _editorEscapeHtml(s).replace(/"/g, '&quot;');
        }

        document.addEventListener('click', function(e) {
            if (e.target.closest && e.target.closest('.header-actions')) {
                return;
            }
            var menus = document.querySelectorAll('.header-menu.visible');
            menus.forEach(function(menu) { menu.classList.remove('visible'); });
        });

        function _editorCollectChartOptions() {
            var opts = {};
            var chartType = document.getElementById('opt-type');
            if (chartType) opts.type = chartType.value;
            var legendPos = document.getElementById('opt-legendPosition');
            if (legendPos && legendPos.value) {
                opts.legendPosition = legendPos.value;
            }
            var sort = document.getElementById('opt-sort');
            if (sort && sort.value) opts.sort = sort.value;
            var mode = document.getElementById('opt-mode');
            if (mode && mode.value) opts.mode = mode.value;
            var aspectRatio = document.getElementById('opt-aspectRatio');
            if (aspectRatio && aspectRatio.value) opts.aspectRatio = aspectRatio.value;
            var textSize = document.getElementById('opt-textSize');
            if (textSize && textSize.value) opts.textSize = textSize.value;
            var showValues = document.getElementById('opt-showValues');
            if (showValues && showValues.value) opts.showValues = showValues.value === 'On';
            var title = document.getElementById('opt-title');
            if (title && title.value) opts.title = title.value;
            var xTitle = document.getElementById('opt-xTitle');
            if (xTitle && xTitle.value) opts.xTitle = xTitle.value;
            var yTitle = document.getElementById('opt-yTitle');
            if (yTitle && yTitle.value) opts.yTitle = yTitle.value;
            var zTitle = document.getElementById('opt-zTitle');
            if (zTitle && zTitle.value) opts.zTitle = zTitle.value;
            var xColumn = document.getElementById('opt-xColumn');
            if (xColumn && xColumn.value) opts.xColumn = xColumn.value;
            var yColList = document.getElementById('opt-yColumns-list');
            if (yColList) { var items = Array.from(yColList.querySelectorAll('li span')).map(function(s) { return s.textContent; }); if (items.length) opts.yColumns = items; }
            var seriesList = document.getElementById('opt-seriesColumns-list');
            if (seriesList) { var si = Array.from(seriesList.querySelectorAll('li span')).map(function(s) { return s.textContent; }); if (si.length) opts.seriesColumns = si; }
            var anomalyList = document.getElementById('opt-anomalyColumns-list');
            if (anomalyList) { var ai = Array.from(anomalyList.querySelectorAll('li span')).map(function(s) { return s.textContent; }); if (ai.length) opts.anomalyColumns = ai; }
            var showMarkers = document.getElementById('opt-showMarkers');
            if (showMarkers && showMarkers.value) opts.showMarkers = showMarkers.value === 'On';
            var markerOutline = document.getElementById('opt-markerOutline');
            if (markerOutline && markerOutline.value) opts.markerOutline = markerOutline.value === 'On';
            var markerShape = document.getElementById('opt-markerShape');
            if (markerShape && markerShape.value) opts.markerShape = markerShape.value;
            var cycleMarkerShapes = document.getElementById('opt-cycleMarkerShapes');
            if (cycleMarkerShapes && cycleMarkerShapes.value) opts.cycleMarkerShapes = cycleMarkerShapes.value === 'On';
            var markerSize = document.getElementById('opt-markerSize');
            if (markerSize && markerSize.value) opts.markerSize = markerSize.value;
            var accumulate = document.getElementById('opt-accumulate');
            if (accumulate && accumulate.value) opts.accumulate = accumulate.value === 'On';
            var binSize = document.getElementById('opt-binSize');
            if (binSize && binSize.value) opts.binSize = binSize.value;
            var aggregation = document.getElementById('opt-aggregation');
            if (aggregation && aggregation.value) opts.aggregation = aggregation.value;
            var maxSeries = document.getElementById('opt-maxSeries');
            if (maxSeries && maxSeries.value) opts.maxSeries = Number(maxSeries.value);
            var maxPointsPerSeries = document.getElementById('opt-maxPointsPerSeries');
            if (maxPointsPerSeries && maxPointsPerSeries.value) opts.maxPointsPerSeries = Number(maxPointsPerSeries.value);
            var xAxis = document.getElementById('opt-xAxis');
            if (xAxis) opts.xAxis = xAxis.value;
            var yAxis = document.getElementById('opt-yAxis');
            if (yAxis) opts.yAxis = yAxis.value;
            var yLayout = document.getElementById('opt-yLayout');
            if (yLayout && yLayout.value) opts.yLayout = yLayout.value;
            var xmin = document.getElementById('opt-xMin');
            if (xmin && xmin.value) opts.xMin = xmin.value;
            var xmax = document.getElementById('opt-xMax');
            if (xmax && xmax.value) opts.xMax = xmax.value;
            var ymin = document.getElementById('opt-yMin');
            if (ymin && ymin.value) opts.yMin = ymin.value;
            var ymax = document.getElementById('opt-yMax');
            if (ymax && ymax.value) opts.yMax = ymax.value;
            var xShowTicks = document.getElementById('opt-xShowTicks');
            if (xShowTicks && xShowTicks.value) opts.xShowTicks = xShowTicks.value === 'On';
            var yShowTicks = document.getElementById('opt-yShowTicks');
            if (yShowTicks && yShowTicks.value) opts.yShowTicks = yShowTicks.value === 'On';
            var yMirror = document.getElementById('opt-yMirror');
            if (yMirror && yMirror.value) opts.yMirror = yMirror.value === 'On';
            var xShowGrid = document.getElementById('opt-xShowGrid');
            if (xShowGrid && xShowGrid.value) opts.xShowGrid = xShowGrid.value === 'On';
            var yShowGrid = document.getElementById('opt-yShowGrid');
            if (yShowGrid && yShowGrid.value) opts.yShowGrid = yShowGrid.value === 'On';
            var xTickAngle = document.getElementById('opt-xTickAngle');
            if (xTickAngle && xTickAngle.value !== '') opts.xTickAngle = Number(xTickAngle.value);
            var yTickAngle = document.getElementById('opt-yTickAngle');
            if (yTickAngle && yTickAngle.value !== '') opts.yTickAngle = Number(yTickAngle.value);
            var nodesTable = document.getElementById('opt-nodesTable');
            if (nodesTable && nodesTable.value) opts.nodesTable = nodesTable.value;
            var nodeIdColumn = document.getElementById('opt-nodeIdColumn');
            if (nodeIdColumn && nodeIdColumn.value) opts.nodeIdColumn = nodeIdColumn.value;
            var nodeLabelColumn = document.getElementById('opt-nodeLabelColumn');
            if (nodeLabelColumn && nodeLabelColumn.value) opts.nodeLabelColumn = nodeLabelColumn.value;
            var nodeKindColumn = document.getElementById('opt-nodeKindColumn');
            if (nodeKindColumn && nodeKindColumn.value) opts.nodeKindColumn = nodeKindColumn.value;
            var edgeKindColumn = document.getElementById('opt-edgeKindColumn');
            if (edgeKindColumn && edgeKindColumn.value) opts.edgeKindColumn = edgeKindColumn.value;
            return opts;
        }

        function _editorOnChartOptionChanged() {
            _editorApplyClientSideOptions();
            if (window._vscodeApi) {
                window._vscodeApi.postMessage({ command: 'chartOptionsChanged', chartOptions: _editorCollectChartOptions() });
            }
        }

        function _editorApplyClientSideOptions() {
            var chartDiv = document.getElementById('chart');
            var arSelect = document.getElementById('opt-aspectRatio');
            var tsSelect = document.getElementById('opt-textSize');
            if (chartDiv) {
                var arValue = arSelect ? arSelect.value : '';
                var defaultArValue = arSelect ? (arSelect.getAttribute('data-default-value') || '') : '';
                var effectiveArValue = arValue || defaultArValue;
                if (effectiveArValue && effectiveArValue !== 'Fill') {
                    chartDiv.classList.add('has-aspect-ratio');
                    chartDiv.style.setProperty('--chart-aspect-ratio', effectiveArValue.replace(':', '/'));
                } else {
                    chartDiv.classList.remove('has-aspect-ratio');
                    chartDiv.style.removeProperty('--chart-aspect-ratio');
                }
                var textSizeValue = tsSelect ? tsSelect.value : '';
                var defaultTextSizeValue = tsSelect ? (tsSelect.getAttribute('data-default-value') || '') : '';
                var effectiveTextSizeValue = textSizeValue || defaultTextSizeValue;
                chartDiv.setAttribute('data-text-size', effectiveTextSizeValue === 'Auto' ? '' : effectiveTextSizeValue);
                setTimeout(function() {
                    if (window._chartResize) window._chartResize();
                }, 50);
            }
        }

        // Listen for editor content updates from the extension.
        // Note: innerHTML is safe here because the HTML is generated by the
        // extension itself (buildFormHtml) and posted via the VS Code webview
        // messaging API — it never contains untrusted user input.
        window.addEventListener('message', function(event) {
            var msg = event.data;
            if (msg && msg.command === 'setEditPanelContent' && typeof msg.html === 'string') {
                var panel = document.getElementById('edit-panel');
                if (panel) { panel.innerHTML = msg.html; }
            }
        });
        <\/script>`;
    }

    private buildFormHtml(chartOptions: ChartOptions, columnNames: string[], defaults: Partial<ChartOptions>, tables: ChartEditorTableInfo[] = [], primaryTableName?: string): string {
        const opts = chartOptions;
        const formatDefaultLabel = (value: string) => `Default (${value})`;
        const formatAngleLabel = (value: number | undefined) => value == null ? 'Auto' : `${value}°`;
        const formatToggleLabel = (value: boolean | undefined) => value === true ? 'On' : 'Off';
        const buildToggleOptions = (current: boolean | undefined, defaultValue: boolean | undefined) => {
            const currentValue = current == null ? '' : (current ? 'On' : 'Off');
            return [['', formatDefaultLabel(formatToggleLabel(defaultValue))], ['On', 'On'], ['Off', 'Off']].map(([value, label]) =>
                `<option value="${value}"${value === currentValue ? ' selected' : ''}>${label}</option>`
            ).join('');
        };
        const defaultLegendValue = (defaults.legendPosition as string | undefined) ?? 'Auto';
        const defaultAspectRatioValue = (defaults.aspectRatio as string | undefined) ?? ChartAspectRatio.Fill;
        const defaultTextSizeValue = (defaults.textSize as string | undefined) ?? 'Auto';
        const formatMarkerShapeLabel = (value: string) => markerShapeLabels.get(value) ?? value;
        const defaultMarkerShapeValue = formatMarkerShapeLabel((defaults.markerShape as string | undefined) ?? 'Circle');
        const defaultMarkerSizeValue = (defaults.markerSize as string | undefined) ?? 'Medium';
        const defaultXTickAngleValue = typeof defaults.xTickAngle === 'number' ? defaults.xTickAngle : undefined;
        const defaultYTickAngleValue = typeof defaults.yTickAngle === 'number' ? defaults.yTickAngle : undefined;

        const allTypeKeys = chartTypes.has(opts.type) ? [...chartTypes.keys()] : [opts.type, ...chartTypes.keys()];
        allTypeKeys.sort((a, b) => {
            const la = chartTypes.get(a) ?? a;
            const lb = chartTypes.get(b) ?? b;
            return la.localeCompare(lb);
        });
        const typeOptions = allTypeKeys.map(t => {
            const label = chartTypes.get(t);
            const display = label ?? t;
            return `<option value="${t}"${t === opts.type ? ' selected' : ''} title="${escapeHtml(t)}">${escapeHtml(display)}</option>`;
        }).join('');

        const currentLegend = opts.legendPosition === 'Hidden' ? 'None' : (opts.legendPosition ?? '');
        const legendPosOptions = [['', formatDefaultLabel(defaultLegendValue)], ...legendPositions].map(([value, label]) =>
            `<option value="${value}"${value === currentLegend ? ' selected' : ''}>${label}</option>`
        ).join('');

        const defaultSortValue = defaults.sort ?? ChartSortOrder.Auto;
        const currentSort = opts.sort ?? '';
        const sortOptions = [['', formatDefaultLabel(defaultSortValue)], ...sortOrders.map(s => [s, s] as [string, string])].map(([value, label]) =>
            `<option value="${value}"${value === currentSort ? ' selected' : ''}>${label}</option>`
        ).join('');

        const currentMode = opts.mode ?? 'Auto';
        const modeOptions = chartModes.map(([value, label]) =>
            `<option value="${value}"${value === currentMode ? ' selected' : ''}>${label}</option>`
        ).join('');

        const currentAspectRatio = opts.aspectRatio ?? '';
        const aspectRatioOptions = ['', ...aspectRatios].map(r =>
            `<option value="${r}"${r === currentAspectRatio ? ' selected' : ''}>${r || formatDefaultLabel(defaultAspectRatioValue)}</option>`
        ).join('');

        const currentTextSize = opts.textSize ?? '';
        const textSizeOptions = [['', formatDefaultLabel(defaultTextSizeValue)], ...textSizes].map(([value, label]) =>
            `<option value="${value}"${value === currentTextSize ? ' selected' : ''}>${label}</option>`
        ).join('');

        const showValuesOptions = buildToggleOptions(opts.showValues, defaults.showValues as boolean | undefined);

        const xColOptions = ['', ...columnNames].map(c =>
            `<option value="${escapeHtml(c)}"${c === (opts.xColumn ?? '') ? ' selected' : ''}>${c || '(auto)'}</option>`
        ).join('');

        const currentEdgeKindColumn = opts.edgeKindColumn ?? '';
        const edgeKindColumnOptions = ['', ...columnNames].map(c =>
            `<option value="${escapeHtml(c)}"${c === currentEdgeKindColumn ? ' selected' : ''}>${c || '(auto)'}</option>`
        ).join('');

        // Sibling tables (everything except the primary/edges table) — used to
        // populate graph node table/column dropdowns.
        const siblingTables = tables.filter(t => !primaryTableName || t.name !== primaryTableName);
        const siblingNames = siblingTables.map(t => t.name).filter(n => !!n);
        const currentNodesTable = opts.nodesTable ?? '';
        // Options: (auto) = '' → auto-sense a sibling named "nodes";
        //          then each sibling table by name.
        const nodesTableOptions = [
            `<option value=""${currentNodesTable === '' ? ' selected' : ''}>(auto)</option>`,
            ...siblingNames.map(n =>
                `<option value="${escapeHtml(n)}"${n === currentNodesTable ? ' selected' : ''}>${escapeHtml(n)}</option>`
            ),
        ].join('');
        // Resolve which sibling table to source node-column choices from. If
        // the user chose one explicitly, use it; otherwise auto-sense only a
        // sibling literally named "nodes" (case-insensitive).
        const resolveNodesTable = (): ChartEditorTableInfo | undefined => {
            if (currentNodesTable) {
                const m = siblingTables.find(t => t.name === currentNodesTable);
                if (m) return m;
            }
            return siblingTables.find(t => (t.name ?? '').toLowerCase() === 'nodes');
        };
        const nodesTable = resolveNodesTable();
        const nodeColumnNames = nodesTable?.columns ?? [];
        const buildNodeColOptions = (current: string) => ['', ...nodeColumnNames].map(c =>
            `<option value="${escapeHtml(c)}"${c === current ? ' selected' : ''}>${c || '(auto)'}</option>`
        ).join('');
        const nodeIdColumnOptions = buildNodeColOptions(opts.nodeIdColumn ?? '');
        const nodeLabelColumnOptions = buildNodeColOptions(opts.nodeLabelColumn ?? '');
        const nodeKindColumnOptions = buildNodeColOptions(opts.nodeKindColumn ?? '');
        // Map of nodes-table select value → that table's column names, so the
        // page can repopulate the node-column dropdowns client-side when the
        // user changes the Nodes Table (no server round-trip / form rebuild,
        // which would reset section collapse state and focus). The empty-string
        // key ('(auto)') maps to whichever sibling table resolution picks.
        const nodeColumnsByTable: { [tableValue: string]: string[] } = { '': nodeColumnNames };
        for (const t of siblingTables) {
            if (t.name) { nodeColumnsByTable[t.name] = t.columns ?? []; }
        }
        const nodeColumnsByTableJson = escapeHtml(JSON.stringify(nodeColumnsByTable));

        const colOptionsList = columnNames.map(c =>
            `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`
        ).join('');
        const makeColPickerOptions = (hasItems: boolean) =>
            `<option value="" disabled selected>${hasItems ? '(add)' : '(auto)'}</option>` + colOptionsList;

        const yColPickerOptions = makeColPickerOptions((opts.yColumns ?? []).length > 0);
        const seriesColPickerOptions = makeColPickerOptions((opts.seriesColumns ?? []).length > 0);
        const anomalyColPickerOptions = makeColPickerOptions((opts.anomalyColumns ?? []).length > 0);

        const yColumnsItems = (opts.yColumns ?? []).map(c =>
            `<li><span>${escapeHtml(c)}</span><button onclick="_editorMoveColumnItem(this,-1)" title="Move up">&uarr;</button><button onclick="_editorMoveColumnItem(this,1)" title="Move down">&darr;</button><button onclick="_editorRemoveColumnItem(this)" title="Remove">&times;</button></li>`
        ).join('');

        const seriesItems = (opts.seriesColumns ?? []).map(c =>
            `<li><span>${escapeHtml(c)}</span><button onclick="_editorMoveColumnItem(this,-1)" title="Move up">&uarr;</button><button onclick="_editorMoveColumnItem(this,1)" title="Move down">&darr;</button><button onclick="_editorRemoveColumnItem(this)" title="Remove">&times;</button></li>`
        ).join('');

        const anomalyColumnsItems = (opts.anomalyColumns ?? []).map(c =>
            `<li><span>${escapeHtml(c)}</span><button onclick="_editorMoveColumnItem(this,-1)" title="Move up">&uarr;</button><button onclick="_editorMoveColumnItem(this,1)" title="Move down">&darr;</button><button onclick="_editorRemoveColumnItem(this)" title="Remove">&times;</button></li>`
        ).join('');

        const currentMarkerShape = opts.markerShape ?? '';
        const markerShapeOpts = [['', formatDefaultLabel(defaultMarkerShapeValue)], ...markerShapeOptions].map(([value, label]) =>
            `<option value="${value}"${value === currentMarkerShape ? ' selected' : ''}>${label}</option>`
        ).join('');
        const showMarkersOptions = buildToggleOptions(opts.showMarkers, defaults.showMarkers as boolean | undefined);
        const markerOutlineOptions = buildToggleOptions(opts.markerOutline, defaults.markerOutline as boolean | undefined);
        const cycleMarkerShapesOptions = buildToggleOptions(opts.cycleMarkerShapes, defaults.cycleMarkerShapes as boolean | undefined);

        const currentMarkerSize = opts.markerSize ?? '';
        const markerSizeOpts = ['', ...textSizes.filter(([value]) => value !== 'Auto').map(([value]) => value)].map(s =>
            `<option value="${s}"${s === currentMarkerSize ? ' selected' : ''}>${s || formatDefaultLabel(defaultMarkerSizeValue)}</option>`
        ).join('');

        const currentAggregation = opts.aggregation ?? '';
        const aggregationOpts = ['', ...aggregationTypes].map(a =>
            `<option value="${a}"${a === currentAggregation ? ' selected' : ''}>${a || '(none)'}</option>`
        ).join('');

        const currentMaxSeries = opts.maxSeries ?? '';
        const maxSeriesOpts = ['', ...maxSeriesOptions].map(n =>
            `<option value="${n}"${String(n) === String(currentMaxSeries) ? ' selected' : ''}>${n || '(unlimited)'}</option>`
        ).join('');

        const currentMaxPoints = opts.maxPointsPerSeries ?? '';
        const maxPointsOpts = ['', ...maxPointsOptions].map(n =>
            `<option value="${n}"${String(n) === String(currentMaxPoints) ? ' selected' : ''}>${n || '(unlimited)'}</option>`
        ).join('');

        const currentXAxis = opts.xAxis ?? 'Linear';
        const allAxisTypes = currentXAxis && !axisTypes.includes(currentXAxis) ? [currentXAxis, ...axisTypes] : axisTypes;
        const xAxisOptions = allAxisTypes.map(a =>
            `<option value="${a}"${a === currentXAxis ? ' selected' : ''}>${a}</option>`
        ).join('');

        const currentYAxis = opts.yAxis ?? 'Linear';
        const allYAxisTypes = currentYAxis && !axisTypes.includes(currentYAxis) ? [currentYAxis, ...axisTypes] : axisTypes;
        const yAxisOptions = allYAxisTypes.map(a =>
            `<option value="${a}"${a === currentYAxis ? ' selected' : ''}>${a}</option>`
        ).join('');

        const yLayoutModes: [string, string][] = [['SharedAxis', 'Shared Axis'], ['DualAxis', 'Dual Axis'], ['SeparatePanels', 'Separate Panels'], ['SeparateCharts', 'Separate Charts']];
        const defaultYLayoutValue = 'Shared Axis';
        const currentYLayout = opts.yLayout ?? '';
        const yLayoutOptions = [['', formatDefaultLabel(defaultYLayoutValue)], ...yLayoutModes].map(([value, label]) =>
            `<option value="${value}"${value === currentYLayout ? ' selected' : ''}>${label}</option>`
        ).join('');

        const accumulateOptions = buildToggleOptions(opts.accumulate, defaults.accumulate as boolean | undefined);
        const xShowTicksOptions = buildToggleOptions(opts.xShowTicks, defaults.xShowTicks as boolean | undefined);
        const yShowTicksOptions = buildToggleOptions(opts.yShowTicks, defaults.yShowTicks as boolean | undefined);
        const yMirrorOptions = buildToggleOptions(opts.yMirror, defaults.yMirror as boolean | undefined);
        const xShowGridOptions = buildToggleOptions(opts.xShowGrid, (defaults.xShowGrid as boolean | undefined) ?? true);
        const yShowGridOptions = buildToggleOptions(opts.yShowGrid, (defaults.yShowGrid as boolean | undefined) ?? true);
        const xTickAngleValue = opts.xTickAngle != null ? String(opts.xTickAngle) : '';
        const xTickAngleOptions = ['', ...tickAngles.map(String)].map(a =>
            `<option value="${a}"${a === xTickAngleValue ? ' selected' : ''}>${a ? a + '°' : formatDefaultLabel(formatAngleLabel(defaultXTickAngleValue))}</option>`
        ).join('');
        const yTickAngleValue = opts.yTickAngle != null ? String(opts.yTickAngle) : '';
        const yTickAngleOptions = ['', ...tickAngles.map(String)].map(a =>
            `<option value="${a}"${a === yTickAngleValue ? ' selected' : ''}>${a ? a + '°' : formatDefaultLabel(formatAngleLabel(defaultYTickAngleValue))}</option>`
        ).join('');

        return `<div class="panel-header"><h3>Chart Options</h3><div class="header-actions"><button type="button" class="icon-button" title="Chart Actions..." aria-label="Chart Actions..." onclick="_editorToggleDefaultsMenu(this)">&hellip;</button><div class="header-menu"><button type="button" class="menu-item" onclick="_editorRunDefaultsAction('capture')">Capture Defaults</button><button type="button" class="menu-item" onclick="_editorRunDefaultsAction('restore')">Restore Defaults</button></div></div></div>

            <div class="section-header" onclick="_editorToggleSection(this)">
                <span class="chevron">&#9662;</span>General
            </div>
            <div class="section-body">
                <div class="field">
                    <label for="opt-type">Type</label>
                    <select id="opt-type" onchange="_editorOnChartOptionChanged()">${typeOptions}</select>
                </div>
                <div class="field">
                    <label for="opt-legendPosition">Legend</label>
                    <select id="opt-legendPosition" onchange="_editorOnChartOptionChanged()">${legendPosOptions}</select>
                </div>
                <div class="field">
                    <label for="opt-sort">Axis Order</label>
                    <select id="opt-sort" onchange="_editorOnChartOptionChanged()">${sortOptions}</select>
                </div>
                <div class="field">
                    <label for="opt-mode">Mode</label>
                    <select id="opt-mode" onchange="_editorOnChartOptionChanged()">${modeOptions}</select>
                </div>
                <div class="field">
                    <label for="opt-aspectRatio">Aspect Ratio</label>
                    <select id="opt-aspectRatio" data-default-value="${escapeHtml(defaultAspectRatioValue)}" onchange="_editorOnChartOptionChanged()">${aspectRatioOptions}</select>
                </div>
                <div class="field">
                    <label for="opt-textSize">Text Size</label>
                    <select id="opt-textSize" data-default-value="${escapeHtml(defaultTextSizeValue)}" onchange="_editorOnChartOptionChanged()">${textSizeOptions}</select>
                </div>
                <div class="field">
                    <label for="opt-yLayout">Multi Y Layout</label>
                    <select id="opt-yLayout" onchange="_editorOnChartOptionChanged()">${yLayoutOptions}</select>
                </div>
            </div>

            <div class="section-header collapsed" onclick="_editorToggleSection(this)">
                <span class="chevron">&#9662;</span>Data
            </div>
            <div class="section-body collapsed">
                <div class="field">
                    <label for="opt-xColumn">X Column</label>
                    <select id="opt-xColumn" onchange="_editorOnChartOptionChanged()">${xColOptions}</select>
                </div>
                <div class="field">
                    <label>Y Columns</label>
                    <ul id="opt-yColumns-list" class="column-list">${yColumnsItems}</ul>
                    <select id="opt-yColumns-picker" onchange="_editorAddColumnItem('opt-yColumns-picker','opt-yColumns-list')">${yColPickerOptions}</select>
                </div>
                <div class="field">
                    <label>Series Columns</label>
                    <ul id="opt-seriesColumns-list" class="column-list">${seriesItems}</ul>
                    <select id="opt-seriesColumns-picker" onchange="_editorAddColumnItem('opt-seriesColumns-picker','opt-seriesColumns-list')">${seriesColPickerOptions}</select>
                </div>
                <div class="field">
                    <label>Anomaly Columns</label>
                    <ul id="opt-anomalyColumns-list" class="column-list">${anomalyColumnsItems}</ul>
                    <select id="opt-anomalyColumns-picker" onchange="_editorAddColumnItem('opt-anomalyColumns-picker','opt-anomalyColumns-list')">${anomalyColPickerOptions}</select>
                </div>
                <div class="field">
                    <label for="opt-accumulate">Accumulate</label>
                    <select id="opt-accumulate" onchange="_editorOnChartOptionChanged()">${accumulateOptions}</select>
                </div>
                <div class="field">
                    <label for="opt-binSize">Bin Size</label>
                    <input type="text" id="opt-binSize" value="${escapeHtml(opts.binSize ?? '')}" placeholder="e.g. 1h, 1d, 10" onchange="_editorOnChartOptionChanged()">
                </div>
                <div class="field">
                    <label for="opt-aggregation">Bin Aggregation</label>
                    <select id="opt-aggregation" onchange="_editorOnChartOptionChanged()">${aggregationOpts}</select>
                </div>
                <div class="field">
                    <label for="opt-maxSeries">Max Series (top N)</label>
                    <select id="opt-maxSeries" onchange="_editorOnChartOptionChanged()">${maxSeriesOpts}</select>
                </div>
                <div class="field">
                    <label for="opt-maxPointsPerSeries">Max Points per Series (downsample)</label>
                    <select id="opt-maxPointsPerSeries" onchange="_editorOnChartOptionChanged()">${maxPointsOpts}</select>
                </div>
            </div>

            <div class="section-header collapsed" onclick="_editorToggleSection(this)">
                <span class="chevron">&#9662;</span>Markers
            </div>
            <div class="section-body collapsed">
                <div class="field">
                    <label for="opt-markerShape">Shape</label>
                    <select id="opt-markerShape" onchange="_editorOnChartOptionChanged()">${markerShapeOpts}</select>
                </div>
                <div class="field">
                    <label for="opt-markerSize">Size</label>
                    <select id="opt-markerSize" onchange="_editorOnChartOptionChanged()">${markerSizeOpts}</select>
                </div>
                <div class="field">
                    <label for="opt-cycleMarkerShapes">Cycle Shapes</label>
                    <select id="opt-cycleMarkerShapes" onchange="_editorOnChartOptionChanged()">${cycleMarkerShapesOptions}</select>
                </div>
                <div class="field">
                    <label for="opt-showMarkers">Show on Lines</label>
                    <select id="opt-showMarkers" onchange="_editorOnChartOptionChanged()">${showMarkersOptions}</select>
                </div>
                <div class="field">
                    <label for="opt-markerOutline">Outline</label>
                    <select id="opt-markerOutline" onchange="_editorOnChartOptionChanged()">${markerOutlineOptions}</select>
                </div>
                <div class="field">
                    <label for="opt-showValues">Show Values</label>
                    <select id="opt-showValues" onchange="_editorOnChartOptionChanged()">${showValuesOptions}</select>
                </div>
            </div>

            <div class="section-header collapsed" onclick="_editorToggleSection(this)">
                <span class="chevron">&#9662;</span>Titles
            </div>
            <div class="section-body collapsed">
                <div class="field">
                    <label for="opt-title">Title</label>
                    <input type="text" id="opt-title" value="${escapeHtml(opts.title ?? '')}" oninput="_editorOnChartOptionChanged()">
                </div>
                <div class="field">
                    <label for="opt-xTitle">X-Axis Title</label>
                    <input type="text" id="opt-xTitle" value="${escapeHtml(opts.xTitle ?? '')}" oninput="_editorOnChartOptionChanged()">
                </div>
                <div class="field">
                    <label for="opt-yTitle">Y-Axis Title</label>
                    <input type="text" id="opt-yTitle" value="${escapeHtml(opts.yTitle ?? '')}" oninput="_editorOnChartOptionChanged()">
                </div>
                <div class="field">
                    <label for="opt-zTitle">Z-Axis Title</label>
                    <input type="text" id="opt-zTitle" value="${escapeHtml(opts.zTitle ?? '')}" oninput="_editorOnChartOptionChanged()">
                </div>
            </div>

            <div class="section-header collapsed" onclick="_editorToggleSection(this)">
                <span class="chevron">&#9662;</span>X Axis
            </div>
            <div class="section-body collapsed">
                <div class="field">
                    <label for="opt-xAxis">Type</label>
                    <select id="opt-xAxis" onchange="_editorOnChartOptionChanged()">${xAxisOptions}</select>
                </div>
                <div class="field-row">
                    <div class="field">
                        <label for="opt-xMin">Min</label>
                        <input type="text" id="opt-xMin" value="${escapeHtml(String(opts.xMin ?? ''))}" oninput="_editorOnChartOptionChanged()">
                    </div>
                    <div class="field">
                        <label for="opt-xMax">Max</label>
                        <input type="text" id="opt-xMax" value="${escapeHtml(String(opts.xMax ?? ''))}" oninput="_editorOnChartOptionChanged()">
                    </div>
                </div>
                <div class="field">
                    <label for="opt-xShowTicks">Show Tick Marks</label>
                    <select id="opt-xShowTicks" onchange="_editorOnChartOptionChanged()">${xShowTicksOptions}</select>
                </div>
                <div class="field">
                    <label for="opt-xShowGrid">Show Grid Lines</label>
                    <select id="opt-xShowGrid" onchange="_editorOnChartOptionChanged()">${xShowGridOptions}</select>
                </div>
                <div class="field">
                    <label for="opt-xTickAngle">Tick Label Angle</label>
                    <select id="opt-xTickAngle" onchange="_editorOnChartOptionChanged()">${xTickAngleOptions}</select>
                </div>
            </div>

            <div class="section-header collapsed" onclick="_editorToggleSection(this)">
                <span class="chevron">&#9662;</span>Y Axis
            </div>
            <div class="section-body collapsed">
                <div class="field">
                    <label for="opt-yAxis">Type</label>
                    <select id="opt-yAxis" onchange="_editorOnChartOptionChanged()">${yAxisOptions}</select>
                </div>
                <div class="field-row">
                    <div class="field">
                        <label for="opt-yMin">Min</label>
                        <input type="text" id="opt-yMin" value="${escapeHtml(String(opts.yMin ?? ''))}" oninput="_editorOnChartOptionChanged()">
                    </div>
                    <div class="field">
                        <label for="opt-yMax">Max</label>
                        <input type="text" id="opt-yMax" value="${escapeHtml(String(opts.yMax ?? ''))}" oninput="_editorOnChartOptionChanged()">
                    </div>
                </div>
                <div class="field">
                    <label for="opt-yShowTicks">Show Tick Marks</label>
                    <select id="opt-yShowTicks" onchange="_editorOnChartOptionChanged()">${yShowTicksOptions}</select>
                </div>
                <div class="field">
                    <label for="opt-yMirror">Mirror Axis</label>
                    <select id="opt-yMirror" onchange="_editorOnChartOptionChanged()">${yMirrorOptions}</select>
                </div>
                <div class="field">
                    <label for="opt-yShowGrid">Show Grid Lines</label>
                    <select id="opt-yShowGrid" onchange="_editorOnChartOptionChanged()">${yShowGridOptions}</select>
                </div>
                <div class="field">
                    <label for="opt-yTickAngle">Tick Label Angle</label>
                    <select id="opt-yTickAngle" onchange="_editorOnChartOptionChanged()">${yTickAngleOptions}</select>
                </div>
            </div>

            <div class="section-header collapsed" onclick="_editorToggleSection(this)">
                <span class="chevron">&#9662;</span>Graph
            </div>
            <div class="section-body collapsed">
                <div class="field">
                    <label for="opt-nodesTable">Nodes Table</label>
                    <select id="opt-nodesTable" data-node-columns="${nodeColumnsByTableJson}" onchange="_editorOnNodesTableChanged()">${nodesTableOptions}</select>
                </div>
                <div class="field">
                    <label for="opt-nodeIdColumn">Node Id Column</label>
                    <select id="opt-nodeIdColumn" onchange="_editorOnChartOptionChanged()">${nodeIdColumnOptions}</select>
                </div>
                <div class="field">
                    <label for="opt-nodeLabelColumn">Node Label Column</label>
                    <select id="opt-nodeLabelColumn" onchange="_editorOnChartOptionChanged()">${nodeLabelColumnOptions}</select>
                </div>
                <div class="field">
                    <label for="opt-nodeKindColumn">Node Kind Column</label>
                    <select id="opt-nodeKindColumn" onchange="_editorOnChartOptionChanged()">${nodeKindColumnOptions}</select>
                </div>
                <div class="field">
                    <label for="opt-edgeKindColumn">Edge Kind Column</label>
                    <select id="opt-edgeKindColumn" onchange="_editorOnChartOptionChanged()">${edgeKindColumnOptions}</select>
                </div>
            </div>`;
    }
}

export class ChartEditorProvider implements IChartEditorProvider {
    createView(webview: IWebView): IChartEditorView {
        return new ChartEditorView(webview);
    }
}
