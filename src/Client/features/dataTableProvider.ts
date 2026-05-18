// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Data table provider — renders tabular data in webview grids using Simple-DataTables.
 *
 * Each `IDataTableView` manages a single table grid within a webview region.
 * The view is container-agnostic: it uses relative DOM queries (via
 * `document.currentScript.parentElement`) and a unique token for message
 * scoping, so it has no knowledge of the container div ID or its position
 * in the page.  The page builder controls which container receives the
 * content by mapping the adapter's content command to a specific div.
 */

import type { IServer, ResultTable } from './server';
import type { IWebView } from './webview';
import type { IClipboard } from './clipboard';
import { formatCfHtml } from './clipboard';
import { resultTableToHtml } from './html';
import { resultTableToMarkdown } from './markdown';

// ─── Interfaces ─────────────────────────────────────────────────────────────

/**
 * View for a single data table grid in a webview region.
 * Created by `IDataTableProvider.createView()`.
 */
export interface IDataTableView {
    /** Request the webview to copy the cell under the cursor. */
    copyCell(): void;
    /** Copy the entire table as a KQL datatable expression to the clipboard. */
    copyTableAsExpression(): Promise<void>;
    /** Copy the table as rich HTML + markdown text to the clipboard. */
    copyTableAsText(): Promise<void>;
    /** Toggle search box visibility. */
    toggleSearch(): void;
    /** Release handlers and resources. */
    dispose(): void;
}

/** Provider for creating data table views bound to webview regions. */
export interface IDataTableProvider {
    createView(webview: IWebView, table: ResultTable): IDataTableView;
}

// ─── Implementation ─────────────────────────────────────────────────────────

// Cell values are passed raw (unescaped) to the webview. In the init
// script each value is wrapped in a Simple-DataTables cell object with
// all three fields set (data, text, order). That triggers the early-return
// path in Simple-DataTables' readDataCell, so it never parses cell strings
// as HTML — avoiding the InvalidCharacterError that values like
// "George <gw@x.com>" used to trigger — while still letting the library
// own row rendering (paging, virtualization). The library renders cell
// `text` as textContent, so characters like " and & display correctly
// without any escaping.
function formatCellValue(value: unknown): string {
    if (value === null || value === undefined) return '';
    return (typeof value === 'object') ? JSON.stringify(value) : String(value);
}

/** Generate a short random token for message scoping. */
function makeToken(): string {
    return 'dt-' + Math.random().toString(36).slice(2, 10);
}

class DataTableView implements IDataTableView {
    private readonly webview: IWebView;
    private readonly server: IServer;
    private readonly clipboard: IClipboard;
    private readonly token: string;
    private readonly subscription: { dispose(): void };
    private readonly table: ResultTable;
    /**
     * Original-data indices for the user's current selection. `rows` and
     * `cols` list specific indices into `this.table.rows` / `this.table.columns`.
     * `null` means "no selection" — drag operations should use the whole table.
     * The webview keeps this in sync via `setSelection` messages and we use it
     * to subset the table for expression / HTML produced for drag-and-drop.
     */
    private currentSelection: { rows: number[]; cols: number[] } | null = null;

    constructor(webview: IWebView, server: IServer, clipboard: IClipboard, table: ResultTable) {
        this.webview = webview;
        this.server = server;
        this.clipboard = clipboard;
        this.table = table;
        this.token = makeToken();
        webview.setup(DataTableView.buildHeadHtml(), '');
        this.subscription = webview.handle((msg) => {
            if (msg._token !== this.token) return;
            if (msg.command === 'copyText' && typeof msg.text === 'string') {
                void this.clipboard.copyText(msg.text);
            }
            if (msg.command === 'requestExpression') {
                this.resolveExpression();
            }
            if (msg.command === 'setSelection') {
                const sel = msg.selection as { rows: number[]; cols: number[] } | null | undefined;
                this.currentSelection = sel ?? null;
                this.resolveExpression();
            }
        });

        const data = {
            // Pass column names and cell values raw (no HTML escaping).
            // The init script wraps each cell as a { data, text, order } object
            // and configures an explicit per-column `type` (never "html"), so
            // Simple-DataTables takes its early-return path in readDataCell and
            // never parses cell strings as HTML. Rendering goes through the
            // textContent path, so '<', '>', '&', and '"' display verbatim.
            columns: table.columns.map(c => ({ ...c })),
            rows: table.rows.map(row => row.map(cell => formatCellValue(cell)))
        };
        const json = JSON.stringify(data).replace(/<\//g, '<\\/');
        webview.setContent(`<table></table>${this.buildInitScript(json)}`);
        this.resolveExpression();
    }

    copyCell(): void {
        this.webview.invoke('copyCell');
    }

    async copyTableAsExpression(): Promise<void> {
        const expression = await this.server.getTableAsExpression(this.table);
        if (expression) {
            await this.clipboard.copyText(expression);
        }
    }

    async copyTableAsText(): Promise<void> {
        const html = resultTableToHtml(this.table);
        const markdown = resultTableToMarkdown(this.table);
        if (html) {
            await this.clipboard.copyItems([
                { format: 'HTML Format', data: formatCfHtml(html), encoding: 'utf8' },
                { format: 'Text', data: markdown || html, encoding: 'text' },
            ]);
        } else if (markdown) {
            await this.clipboard.copyText(markdown);
        }
    }

    toggleSearch(): void {
        this.webview.invoke('toggleSearch');
    }

    private resolveExpression(): void {
        // Build the table to fetch an expression for. When the user has a
        // rectangular selection we subset the original table (rows + columns)
        // so drag-and-drop carries just those cells. Row order is the
        // ORIGINAL data order — we do not preserve view-time sort/filter.
        const subset = this.buildSubsetTable();
        const html = resultTableToHtml(subset);
        if (subset === this.table) {
            // No selection — subset IS the full table. One server round-trip.
            this.server.getTableAsExpression(this.table).then(
                expression => {
                    if (expression) {
                        this.webview.invoke('setExpression', {
                            expression,
                            html,
                            fullExpression: expression,
                            fullHtml: html,
                        });
                    }
                },
                () => { /* ignore errors — drag will retry on the next selection change */ }
            );
            return;
        }
        // Selection: resolve both the subset expression (for cell/row drags)
        // and the full-table expression (for corner drags) so the webview
        // can choose based on drag origin.
        const fullHtml = resultTableToHtml(this.table);
        Promise.all([
            this.server.getTableAsExpression(subset),
            this.server.getTableAsExpression(this.table),
        ]).then(
            ([expression, fullExpression]) => {
                if (expression) {
                    this.webview.invoke('setExpression', {
                        expression,
                        html,
                        fullExpression: fullExpression ?? expression,
                        fullHtml,
                    });
                }
            },
            () => { /* ignore errors */ }
        );
    }

    /**
     * Returns a sub-`ResultTable` reflecting the current selection (specific
     * row + column indices into the original data), or the whole table when
     * no selection is active. Row order matches the order indices were
     * reported in (tbody / view order from the webview); per design we do
     * not re-sort to match the view's sort indicator.
     */
    private buildSubsetTable(): ResultTable {
        const sel = this.currentSelection;
        if (!sel) return this.table;
        const rowIdx = sel.rows.filter(i => i >= 0 && i < this.table.rows.length);
        const colIdx = sel.cols.filter(i => i >= 0 && i < this.table.columns.length);
        if (rowIdx.length === 0 || colIdx.length === 0) return this.table;
        const columns = colIdx.map(i => this.table.columns[i]!);
        const rows = rowIdx.map(r => colIdx.map(c => this.table.rows[r]![c]));
        return { name: this.table.name, columns, rows };
    }

    dispose(): void {
        this.subscription.dispose();
    }

    // ─── HTML Builders ──────────────────────────────────────────────────

    static buildHeadHtml(): string {
        return `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/simple-datatables@9/dist/style.min.css">
    <script src="https://cdn.jsdelivr.net/npm/simple-datatables@9/dist/umd/simple-datatables.min.js"><\/script>
    <style>
        /* Simple-DataTables overrides for VS Code theme */
        .datatable-wrapper {
            padding: 0;
            display: flex;
            flex-direction: column;
            height: 100%;
        }
        .datatable-top {
            padding: 4px 8px;
            background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
            color: var(--vscode-foreground);
            border-bottom: 1px solid var(--vscode-panel-border, #444);
            flex-shrink: 0;
            display: flex;
            justify-content: flex-end;
            gap: 8px;
        }
        .datatable-container {
            flex: 1;
            overflow: auto;
        }
        .datatable-bottom {
            padding: 4px 8px;
            background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
            color: var(--vscode-foreground);
            border-top: 1px solid var(--vscode-panel-border, #444);
            flex-shrink: 0;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
        }
        .datatable-bottom::after { display: none; }
        /* Hide search by default; show when toggled */
        .datatable-search { display: none !important; }
        .search-visible .datatable-search { display: block !important; }
        .datatable-info { color: var(--vscode-descriptionForeground, var(--vscode-foreground)); }
        .datatable-input {
            background: var(--vscode-input-background, #3c3c3c);
            color: var(--vscode-input-foreground, var(--vscode-foreground));
            border: 1px solid var(--vscode-input-border, #555);
            border-radius: 2px;
            padding: 2px 6px;
            font-family: inherit;
            font-size: inherit;
        }
        .datatable-selector {
            background: var(--vscode-input-background, #3c3c3c);
            color: var(--vscode-input-foreground, var(--vscode-foreground));
            border: 1px solid var(--vscode-input-border, #555);
            border-radius: 2px;
            padding: 2px 4px;
        }
        .datatable-pagination a, .datatable-pagination button {
            color: var(--vscode-foreground);
            background: transparent;
            border: 1px solid var(--vscode-panel-border, #444);
        }
        .datatable-pagination .datatable-active a,
        .datatable-pagination .datatable-active button {
            background: var(--vscode-focusBorder, #007acc);
            color: #fff;
        }
        table { border-collapse: collapse; width: fit-content !important; }
        th, td {
            padding: 4px 8px;
            text-align: left;
            border: 1px solid var(--vscode-editorGroup-border, var(--vscode-panel-border, #666));
            white-space: nowrap;
            /* border-box so an explicit width includes padding+border, matching
               offsetWidth. Without this, switching from auto to fixed layout
               with width = offsetWidth would make every cell wider by the
               padding+border amount and cause a visible jump. */
            box-sizing: border-box;
            max-width: 500px;
        }
        /* Clip and ellipsize only data cells. Header cells need to keep their
           sort-indicator pseudo-elements visible, which sit just after the
           column-name text — applying overflow:hidden + ellipsis here would
           clip the indicators in narrow columns. */
        td {
            overflow: hidden;
            text-overflow: ellipsis;
        }
        th {
            position: sticky;
            top: 0;
            background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
            z-index: 1;
            font-weight: 600;
            cursor: pointer;
            min-width: 40px;
        }
        /* Column resize: hover near right edge of a header to drag-resize.
           The cursor is set dynamically by JS when the pointer is within the
           rightmost few pixels of a th. The CSS resize property does not work
           on display: table-cell elements, so we use a delegated mouse
           handler instead. */
        th.col-resizing, body.col-resizing, body.col-resizing * {
            cursor: col-resize !important;
            user-select: none !important;
        }
        /* Sort indicator styling */
        .datatable-sorter { color: var(--vscode-foreground); }
        .datatable-sorter::before, .datatable-sorter::after {
            border-left-color: transparent;
            border-right-color: transparent;
        }
        /* Disable text selection and focus outline in the header so
           shift+click for column selection does not trigger the browser's
           text-range selection on the underlying sorter <a> element. */
        .datatable-table thead th,
        .datatable-table thead th * {
            user-select: none !important;
            -webkit-user-select: none !important;
        }
        .datatable-sorter:focus,
        .datatable-sorter:focus-visible,
        .datatable-table thead th:focus,
        .datatable-table thead th:focus-visible {
            outline: none !important;
            box-shadow: none !important;
        }
        /* Cell selection (single cell on click; expanded by later steps). */
        tbody td.cell-selected {
            background: var(--vscode-list-activeSelectionBackground, #094771) !important;
            color: var(--vscode-list-activeSelectionForeground, #fff);
        }
        /* Excel-style row/column header gutter. The first cell of each row is
           a tiny row-number column; the matching first cell in the header is
           the "select all" corner. Click the gutter to select an entire row;
           click the corner to select the entire table. */
        .datatable-table thead th:first-child,
        .datatable-table tbody td:first-child {
            width: 44px;
            min-width: 44px;
            max-width: 44px;
            text-align: right;
            background: var(--vscode-editorGutter-background, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
            color: var(--vscode-editorLineNumber-foreground, var(--vscode-descriptionForeground));
            font-weight: normal;
            user-select: none;
            cursor: pointer;
            padding: 4px 6px;
        }
        .datatable-table thead th:first-child {
            text-align: center;
        }
        /* Override the cell-selected highlight for gutter cells — they get
           their own row-selected style, not the data-cell selection color. */
        .datatable-table tbody td:first-child.cell-selected {
            background: var(--vscode-editorGutter-background, var(--vscode-editorWidget-background, var(--vscode-editor-background))) !important;
            color: var(--vscode-editorLineNumber-foreground, var(--vscode-descriptionForeground));
        }
        .datatable-table tbody td:first-child.row-selected,
        .datatable-table thead th:first-child.all-selected {
            background: var(--vscode-list-activeSelectionBackground, #094771) !important;
            color: var(--vscode-list-activeSelectionForeground, #fff) !important;
        }
        /* Column-select header highlight — applied when every visible row
           of a data column is in the current selection. */
        .datatable-table thead th.col-selected {
            background: var(--vscode-list-activeSelectionBackground, #094771) !important;
            color: var(--vscode-list-activeSelectionForeground, #fff) !important;
        }
        .datatable-sorter::before { border-top-color: var(--vscode-foreground); }
        .datatable-sorter::after { border-bottom-color: var(--vscode-foreground); }
    </style>`;
    }

    /**
     * Builds the inline init script that is delivered with the table content.
     * Uses container-relative DOM queries and the instance token for message scoping.
     */
    private buildInitScript(tableDataJson: string): string {
        const token = this.token;
        return `<script>
(function() {
    var container = document.currentScript.parentElement;
    var tableEl = container.querySelector('table');
    if (!tableEl) return;

    function init() {
    // Clean up previous instance if re-rendered
    if (container._dtCleanup) container._dtCleanup();

    var token = '${token}';
    var searchVisible = false;
    var cachedExpression = '';
    var cachedHtml = '';
    // Whole-table drag payload — used when the drag is initiated from the
    // corner box. Kept separate from cachedExpression so corner drags
    // always carry the full table even while a sub-range is selected.
    var cachedFullExpression = '';
    var cachedFullHtml = '';
    var lastContextTarget = null;
    var tableData = ${tableDataJson};

    // ── Initialize Simple-DataTables grid ──
    // Map Kusto column types to Simple-DataTables sort types so numeric and
    // date columns sort correctly instead of as text. Importantly, we set
    // an explicit type for EVERY column (not just numeric/date/bool), because
    // Simple-DataTables defaults the type to "html" — and for html-typed
    // columns the renderer treats cell.data as an array of node objects to
    // splice into the <td>. Our cell.data is a string, which breaks
    // rendering. Using "string" type makes the renderer go through the
    // text-content path and use cell.text instead.
    var columnSettings = [];
    // Leading gutter column: shows the original 1-based row index. It is
    // sortable so that clicking the corner cell can restore the default
    // (insertion) order — see the corner-click handling below. Not
    // searchable and not part of cell selection. Clicking a gutter cell
    // selects the whole row; the matching corner cell in the header sorts
    // the table by row number on plain click and selects the whole table
    // on shift+click.
    columnSettings.push({ select: 0, sortable: true, searchable: false, type: 'number' });
    tableData.columns.forEach(function(c, i) {
        var kustoType = c.type;
        var sortType =
            (kustoType === 'int' || kustoType === 'long' ||
             kustoType === 'real' || kustoType === 'decimal') ? 'number'
            : (kustoType === 'datetime') ? 'date'
            : (kustoType === 'bool') ? 'boolean'
            : 'string';
        columnSettings.push({ select: i + 1, type: sortType });
    });
    // Number of data columns (excluding gutter). Cell positions use DOM
    // cellIndex, so data cells live at c = 1 .. dataColCount.
    var dataColCount = tableData.columns.length;

    // Compute a sort-friendly "order" value for a raw cell string based on
    // the Simple-DataTables column type. We supply this ourselves so the
    // library does not need to parse the cell as HTML to derive it.
    function computeOrder(text, sortType) {
        if (sortType === 'number') {
            var n = parseFloat(text);
            return isNaN(n) ? text : n;
        }
        if (sortType === 'date') {
            var t = Date.parse(text);
            return isNaN(t) ? text : t;
        }
        if (sortType === 'boolean') {
            var s = String(text).toLowerCase().trim();
            return (s === 'false' || s === '0' || s === '' || s === 'null' || s === 'undefined') ? 0 : 1;
        }
        return text;
    }
    var columnSortTypes = columnSettings.map(function(c) { return c.type; });

    // Build heading cell objects (data + text) and row cells (data + text +
    // order). Plain objects whose keys are all in [data, text, order,
    // attributes] are returned as-is by Simple-DataTables' readDataCell —
    // it never parses cell strings as HTML in that path — avoiding the
    // InvalidCharacterError that <...> values used to trigger. Rendering
    // goes through the library's normal paged row rendering, so we keep
    // the benefits of not materializing every <tr>/<td> ourselves.
    var headings = [{ data: '#', text: '#' }].concat(
        tableData.columns.map(function(c) {
            return { data: c.name, text: c.name };
        })
    );
    var rows = tableData.rows.map(function(row, rowIdx) {
        var rowNum = String(rowIdx + 1);
        var cells = [{
            data: rowNum,
            text: rowNum,
            order: rowIdx,
            // data-gutter marks the row-header cell; data-orig-row lets the
            // selection logic map a display-order tbody row back to its
            // source row after the user sorts/filters.
            attributes: { 'data-gutter': '1', 'data-orig-row': String(rowIdx) }
        }];
        row.forEach(function(text, i) {
            // columnSortTypes is indexed by DOM column index, so the data
            // sort type for original column i lives at columnSortTypes[i+1].
            var sortType = columnSortTypes[i + 1];
            cells.push({
                data: text,
                text: text,
                order: computeOrder(text, sortType),
                // data-orig-col preserves the source column index in case we
                // later support column reordering — currentSelectionIndices
                // reads it back so dragged selections always reference the
                // correct original columns.
                attributes: { 'data-orig-col': String(i) }
            });
        });
        return cells;
    });

    var grid = new simpleDatatables.DataTable(tableEl, {
        data: { headings: headings, data: rows },
        columns: columnSettings,
        perPage: 100,
        perPageSelect: [50, 100, 500, 1000],
        searchable: true,
        sortable: true,
        paging: tableData.rows.length > 100,
        labels: {
            placeholder: 'Search...',
            noRows: 'No results',
            info: 'Showing {start} to {end} of {rows} rows'
        }
    });

    // Clear the cell selection whenever the table is sorted. After a sort
    // the row order changes and the saved selection coordinates would
    // highlight unrelated cells, so we drop the selection entirely.
    grid.on('datatable.sort', function() {
        if (selectedCells.size === 0 && !selAnchor) return;
        selectedCells.clear();
        selAnchor = null;
        applySelection();
        postSelectionChange();
    });

    // Move the per-page selector from top bar to bottom bar
    var wrapper = tableEl.closest('.datatable-wrapper');
    if (wrapper) {
        var selector = wrapper.querySelector('.datatable-top .datatable-dropdown');
        var bottom = wrapper.querySelector('.datatable-bottom');
        if (selector && bottom) {
            bottom.insertBefore(selector, bottom.firstChild);
        }
    }

    // ── Column resize via right-edge drag ──
    // The CSS resize property does not work on display:table-cell, so we use a
    // delegated mousedown handler: if the click lands within EDGE_PX of a
    // th's right edge, we capture the drag and set th.style.width on
    // mousemove. Event delegation means we keep working after Simple-DataTables
    // re-renders (sort/page/search) without re-binding per th.
    //
    // We pin column widths and switch to table-layout: fixed lazily, on the
    // first user resize attempt. Up to that point the table uses
    // table-layout: auto, so columns get their natural content-based widths
    // (which is what the user expects on first paint). Doing this lazily
    // also avoids measuring while the tab is hidden, which would return
    // zero widths.
    //
    // Important: under table-layout: fixed the browser ignores
    // width: fit-content and falls back to filling the container, so we must
    // also pin the table's total width to the sum of column widths.
    var tableLayoutPinned = false;
    function ensurePinned() {
        if (tableLayoutPinned) return;
        var ths = tableEl.querySelectorAll('thead th');
        var total = 0;
        for (var i = 0; i < ths.length; i++) {
            var t = ths[i];
            var w = t.offsetWidth;
            if (!t.style.width) {
                t.style.width = w + 'px';
            }
            total += w;
        }
        // The base stylesheet sets width: fit-content !important on table
        // so initial render sizes to content. To pin a specific total under
        // table-layout: fixed we must beat that !important with our own.
        tableEl.style.setProperty('width', total + 'px', 'important');
        tableEl.style.tableLayout = 'fixed';
        tableLayoutPinned = true;
    }
    var EDGE_PX = 6;
    var resizing = null;          // { th, startX, startWidth }
    var suppressNextClick = false;

    function nearRightEdge(th, clientX) {
        var rect = th.getBoundingClientRect();
        return clientX >= rect.right - EDGE_PX && clientX <= rect.right + 2;
    }

    container.addEventListener('mousedown', function(e) {
        if (e.button !== 0) return;
        var th = e.target.closest ? e.target.closest('thead th') : null;
        if (!th) return;
        // The gutter column is fixed-width — ignore resize attempts on it.
        if (th.cellIndex === 0) return;
        if (!nearRightEdge(th, e.clientX)) return;
        ensurePinned();
        resizing = { th: th, startX: e.clientX, startWidth: th.offsetWidth };
        suppressNextClick = true;
        document.body.classList.add('col-resizing');
        e.preventDefault();
        e.stopPropagation();
    }, true);

    function onDocMouseMove(e) {
        if (!resizing) return;
        var w = Math.max(40, resizing.startWidth + (e.clientX - resizing.startX));
        var prev = parseFloat(resizing.th.style.width) || resizing.th.offsetWidth;
        var delta = w - prev;
        // Under table-layout: fixed, setting the width on the th sets the
        // column width directly (both directions). Also update the table's
        // total width by the same delta so growing one column expands the
        // table (and triggers the container's horizontal scrollbar) rather
        // than stealing space from neighbors.
        resizing.th.style.width = w + 'px';
        var tableW = parseFloat(tableEl.style.width) || tableEl.offsetWidth;
        // Must use setProperty with !important to beat the stylesheet's
        // width: fit-content !important rule.
        tableEl.style.setProperty('width', (tableW + delta) + 'px', 'important');
    }
    function onDocMouseUp() {
        if (!resizing) return;
        resizing = null;
        document.body.classList.remove('col-resizing');
    }
    document.addEventListener('mousemove', onDocMouseMove);
    document.addEventListener('mouseup', onDocMouseUp);

    // Cursor hint when hovering near a column edge.
    container.addEventListener('mousemove', function(e) {
        if (resizing) return;
        var th = e.target.closest ? e.target.closest('thead th') : null;
        if (!th) return;
        if (th.cellIndex === 0) return; // skip gutter
        th.style.cursor = nearRightEdge(th, e.clientX) ? 'col-resize' : '';
    });

    // Suppress the click that would otherwise trigger sort after a resize drag
    // (or even a same-spot mousedown/mouseup on the edge). Also the entry
    // point for the "header click while selection active" toggle.
    container.addEventListener('click', function(e) {
        // After any header click (sort or selection), blur the sorter <a>
        // so it does not retain keyboard focus. Otherwise VS Code's focus
        // indicator paints a highlight around the column name when the
        // user next presses SHIFT.
        var thClicked = e.target.closest ? e.target.closest('thead th') : null;
        if (thClicked) {
            var sorter = thClicked.querySelector('.datatable-sorter') || thClicked.querySelector('a');
            if (sorter && sorter.blur) sorter.blur();
            if (document.activeElement && document.activeElement.blur && thClicked.contains(document.activeElement)) {
                document.activeElement.blur();
            }
        }
        if (!suppressNextClick) return;
        suppressNextClick = false;
        e.preventDefault();
        e.stopPropagation();
        if (pendingCornerSelect) {
            pendingCornerSelect = false;
            var tbodyC = tableEl.querySelector('tbody');
            var totalRowsC = tbodyC ? tbodyC.rows.length : 0;
            var fullySelectedC = totalRowsC > 0 && selectedCells.size === totalRowsC * dataColCount;
            selectedCells.clear();
            if (!fullySelectedC && tbodyC) {
                for (var rC = 0; rC < tbodyC.rows.length; rC++) {
                    for (var cC = 1; cC <= dataColCount; cC++) {
                        selectedCells.add(selKey(rC, cC));
                    }
                }
                selAnchor = { r: 0, c: 1 };
            } else {
                selAnchor = null;
            }
            applySelection();
            postSelectionChange();
            return;
        }
        if (pendingHeaderSelect !== null) {
            var col = pendingHeaderSelect;
            pendingHeaderSelect = null;
            // Compute current selection's column range. Selections are
            // always rectangular, so the active columns are minC..maxC.
            var minC = Infinity, maxC = -1;
            selectedCells.forEach(function(k) {
                var c = +k.split(':')[1];
                if (c < minC) minC = c;
                if (c > maxC) maxC = c;
            });
            var tbodyH = tableEl.querySelector('tbody');
            var lastH = tbodyH ? tbodyH.rows.length - 1 : 0;
            var hasSel = selectedCells.size > 0;
            var onlyCol = hasSel && minC === maxC && minC === col;
            if (onlyCol) {
                // Shift+click on the only-selected column clears.
                selectedCells.clear();
                selAnchor = null;
            } else if (hasSel && selAnchor && selAnchor.c >= 1) {
                // Extend contiguous column range from the existing anchor
                // to this column — Excel-style shift+click extension.
                selectedCells.clear();
                selectRect(0, selAnchor.c, lastH, col);
                // Keep selAnchor unchanged so further shift-clicks keep
                // extending from the original origin.
            } else {
                // No prior selection (or anchor was on the row gutter):
                // start a fresh single-column selection.
                selectedCells.clear();
                selectRect(0, col, lastH, col);
                selAnchor = { r: 0, c: col };
            }
            applySelection();
            postSelectionChange();
        }
    }, true);

    // Make tables draggable
    container.querySelectorAll('table').forEach(function(tbl) {
        tbl.setAttribute('draggable', 'true');
    });

    // ── Context menu tracking (for copyCell) ──
    container.addEventListener('contextmenu', function(e) {
        lastContextTarget = e.target;
    });

    // ── Cell selection ──
    // Plain click  : select a single cell (replaces any prior selection).
    // Shift+click  : extend selection to a rectangle from the anchor cell.
    // Click-and-drag: drag-select a rectangle from the press cell.
    // Selection is always rectangular and contiguous.
    var selectedCells = new Set();   // keys are "r:c" within tbody; c >= 1 (data cells only)
    var selAnchor = null;            // { r, c } — origin for shift-extend / drag (c >= 1)
    var dragSelecting = false;       // false | 'cell' | 'row' | 'col'
    // Armed state for column-select drag: a column-header mousedown stores
    // start coordinates here. The next mousemove past a small threshold
    // converts this into dragSelecting='col' — a plain click without
    // movement leaves it null so the library's sort handler still runs.
    var pendingColDrag = null;
    // When the user mousedowns on a column header while there is already a
    // selection, sort is suppressed and the click instead becomes a
    // column-select toggle. We remember the column here so the
    // suppressed-click handler can apply the action.
    var pendingHeaderSelect = null;
    // Set true when the user shift+mousedowned on the corner cell. The
    // upcoming click is then handled as a select-all toggle instead of
    // the library's column-0 sort.
    var pendingCornerSelect = false;
    // dragstart events have e.target = the draggable element (the <table>),
    // not the deepest element under the cursor. Remember the actual
    // mousedown target so the dragstart handler can tell where the user
    // grabbed the table.
    var lastDragOriginTarget = null;
    // When the mousedown handler has just established a selection (e.g. it
    // pre-selected a row on gutter mousedown so drag-extension works), set
    // this flag so the click handler that fires next does not interpret the
    // fresh selection as "already selected, click again to toggle off".
    var suppressNextToggle = false;

    function getCellPos(td) {
        var tr = td.parentNode;
        if (!tr || !tr.parentNode || tr.parentNode.nodeName !== 'TBODY') return null;
        return { r: tr.sectionRowIndex, c: td.cellIndex };
    }
    function selKey(r, c) { return r + ':' + c; }

    function applySelection() {
        // Clear prior cell-selected, row-selected, all-selected, and
        // col-selected marks.
        var prev = container.querySelectorAll('tbody td.cell-selected, tbody td.row-selected, thead th.all-selected, thead th.col-selected');
        for (var i = 0; i < prev.length; i++) {
            prev[i].classList.remove('cell-selected');
            prev[i].classList.remove('row-selected');
            prev[i].classList.remove('all-selected');
            prev[i].classList.remove('col-selected');
        }
        var tbody = tableEl.querySelector('tbody');
        if (!tbody) return;
        // Tally the number of selected data cells per row so we can
        // highlight the gutter cell only when the entire row is selected
        // (Excel-style row-header highlight). Also apply cell-selected to
        // each individual selected data cell.
        var perRowCount = {};
        selectedCells.forEach(function(k) {
            var rc = k.split(':');
            var r = +rc[0], c = +rc[1];
            var tr = tbody.rows[r];
            if (!tr) return;
            var td = tr.cells[c];
            if (td) td.classList.add('cell-selected');
            perRowCount[r] = (perRowCount[r] || 0) + 1;
        });
        for (var rk in perRowCount) {
            if (perRowCount[rk] === dataColCount) {
                var gtr = tbody.rows[+rk];
                if (gtr && gtr.cells[0]) gtr.cells[0].classList.add('row-selected');
            }
        }
        // Corner gets all-selected when every visible tbody row + every data
        // column is in the selection.
        var totalRows = tbody.rows.length;
        var totalSel = selectedCells.size;
        if (totalRows > 0 && totalSel === totalRows * dataColCount) {
            var cornerTh = tableEl.querySelector('thead th');
            if (cornerTh) cornerTh.classList.add('all-selected');
        }
        // Highlight a data column header when every visible row of that
        // column is in the selection.
        if (totalRows > 0) {
            var thsAll = tableEl.querySelectorAll('thead th');
            for (var tc = 1; tc < thsAll.length; tc++) {
                var fullCol = true;
                for (var rr = 0; rr < totalRows && fullCol; rr++) {
                    if (!selectedCells.has(selKey(rr, tc))) fullCol = false;
                }
                if (fullCol) thsAll[tc].classList.add('col-selected');
            }
        }
    }
    function selectRect(r1, c1, r2, c2) {
        var minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
        var minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
        selectedCells.clear();
        for (var r = minR; r <= maxR; r++) {
            for (var c = minC; c <= maxC; c++) {
                selectedCells.add(selKey(r, c));
            }
        }
    }

    /**
     * Collects the ORIGINAL-data row indices for every selected tbody row,
     * plus the (column-stable) column indices that are within the selection.
     * The selection is always a rectangle in tbody coordinates, but after
     * the user has sorted/filtered, tbody row N is not original row N — so
     * we read the data-orig-row attribute we stamped on each row's first
     * cell. Returns null when nothing is selected.
     */
    function currentSelectionIndices() {
        if (selectedCells.size === 0) return null;
        var minR = Infinity, maxR = -1, minC = Infinity, maxC = -1;
        selectedCells.forEach(function(k) {
            var rc = k.split(':');
            var r = +rc[0], c = +rc[1];
            if (r < minR) minR = r;
            if (r > maxR) maxR = r;
            if (c < minC) minC = c;
            if (c > maxC) maxC = c;
        });
        var tbody = tableEl.querySelector('tbody');
        if (!tbody) return null;
        var rows = [];
        for (var i = minR; i <= maxR; i++) {
            var tr = tbody.rows[i];
            if (!tr) continue;
            var firstCell = tr.cells[0];
            var orig = firstCell ? firstCell.getAttribute('data-orig-row') : null;
            if (orig !== null) rows.push(+orig);
        }
        var cols = [];
        var refRow = tbody.rows[minR];
        if (refRow) {
            for (var c2 = minC; c2 <= maxC; c2++) {
                var dc = refRow.cells[c2];
                var oc = dc ? dc.getAttribute('data-orig-col') : null;
                if (oc !== null) cols.push(+oc);
            }
        }
        if (rows.length === 0 || cols.length === 0) return null;
        return { rows: rows, cols: cols };
    }

    /**
     * Notify the extension of the current selection so it can refresh the
     * cached drag payload (kusto expression + HTML) for the subset.
     * Invalidate the local cache now so dragstart will abort and re-request
     * rather than dropping stale whole-table data.
     */
    function postSelectionChange() {
        cachedExpression = '';
        cachedHtml = '';
        // The full-table cache does not depend on selection — leave it.
        if (window._vscodeApi) {
            window._vscodeApi.postMessage({
                command: 'setSelection',
                selection: currentSelectionIndices(),
                _token: token
            });
        }
    }

    // mousedown on a body cell starts a potential drag-select. We call
    // preventDefault to suppress native HTML5 drag of the table — drag-and-drop
    // can still be initiated from the table header area. If the user releases
    // without moving, the click handler below treats it as a normal click.
    var scrollContainer = tableEl.closest('.datatable-container') || tableEl.parentElement;
    var lastDragX = 0, lastDragY = 0;
    var scrollRaf = 0;

    function autoScrollTick() {
        scrollRaf = 0;
        if (!dragSelecting || !scrollContainer) return;
        var rect = scrollContainer.getBoundingClientRect();
        var EDGE = 30;     // px from edge that triggers scroll
        var MAX_SPEED = 24; // px per frame at the edge
        var dx = 0, dy = 0;
        if (lastDragY < rect.top + EDGE)        dy = -Math.min(MAX_SPEED, EDGE - (lastDragY - rect.top));
        else if (lastDragY > rect.bottom - EDGE) dy =  Math.min(MAX_SPEED, EDGE - (rect.bottom - lastDragY));
        if (lastDragX < rect.left + EDGE)        dx = -Math.min(MAX_SPEED, EDGE - (lastDragX - rect.left));
        else if (lastDragX > rect.right - EDGE)  dx =  Math.min(MAX_SPEED, EDGE - (rect.right - lastDragX));
        if (dx === 0 && dy === 0) return;
        scrollContainer.scrollLeft += dx;
        scrollContainer.scrollTop  += dy;
        // After scrolling, the element under the (unchanged) cursor position
        // is now a different cell — update the selection rectangle.
        var el = document.elementFromPoint(lastDragX, lastDragY);
        if (dragSelecting === 'col') {
            var thC = el && el.closest ? el.closest('thead th') : null;
            var tColC = null;
            if (thC && tableEl.contains(thC) && thC.cellIndex !== 0) {
                tColC = thC.cellIndex;
            } else {
                var tdC = el && el.closest ? el.closest('tbody td') : null;
                if (tdC && tableEl.contains(tdC) && tdC.cellIndex !== 0) tColC = tdC.cellIndex;
            }
            if (tColC !== null && selAnchor) {
                var tbAS = tableEl.querySelector('tbody');
                var lastAS = tbAS ? tbAS.rows.length - 1 : 0;
                selectRect(0, selAnchor.c, lastAS, tColC);
                applySelection();
            }
        } else {
            var td = el && el.closest ? el.closest('tbody td') : null;
            if (td && tableEl.contains(td)) {
                var pos = getCellPos(td);
                if (pos && selAnchor) {
                    if (dragSelecting === 'row') {
                        selectRect(selAnchor.r, 1, pos.r, dataColCount);
                    } else {
                        var c = pos.c === 0 ? 1 : pos.c;
                        selectRect(selAnchor.r, selAnchor.c, pos.r, c);
                    }
                    applySelection();
                }
            }
        }
        scrollRaf = requestAnimationFrame(autoScrollTick);
    }

    /**
     * True if every data cell of tbody row r is in the current selection.
     * Used to decide whether a mousedown on the gutter should let native
     * HTML5 drag start (row already selected) instead of starting a new
     * row-select drag.
     */
    function isRowFullySelected(r) {
        for (var c = 1; c <= dataColCount; c++) {
            if (!selectedCells.has(selKey(r, c))) return false;
        }
        return true;
    }

    container.addEventListener('mousedown', function(e) {
        if (e.button !== 0) return;
        // Record the drag origin so a later dragstart on the table element
        // can tell whether the user grabbed a body cell, the corner, or a
        // regular column header.
        lastDragOriginTarget = e.target;
        // Headers: plain mousedown is reserved for sort (and future column
        // reorder via plain drag). Shift+mousedown arms a column-select
        // click/drag. The corner is unaffected by shift — it does select-all
        // on click and whole-table drag on drag.
        var thAny = e.target.closest ? e.target.closest('thead th') : null;
        if (thAny) {
            if (thAny.cellIndex === 0) {
                // Corner: plain click falls through to the library's
                // sort on the row-number column (restores default order
                // on first click, reverses on subsequent clicks). Shift+
                // click instead toggles select-all and suppresses sort.
                if (e.shiftKey) {
                    pendingCornerSelect = true;
                    suppressNextClick = true;
                    e.preventDefault();
                }
                return;
            }
            if (e.shiftKey && !nearRightEdge(thAny, e.clientX)) {
                pendingColDrag = { startX: e.clientX, startY: e.clientY, col: thAny.cellIndex };
                pendingHeaderSelect = thAny.cellIndex;
                // Suppress the click so the library's sort handler does
                // not run — we are doing a selection operation instead.
                suppressNextClick = true;
                // Stop text selection on the header during a shift-drag.
                e.preventDefault();
            }
            return;
        }
        var td = e.target.closest ? e.target.closest('tbody td') : null;
        if (!td) return;
        var pos = getCellPos(td);
        if (!pos) return;
        if (pos.c === 0) {
            if (e.shiftKey && selAnchor) {
                // Shift+drag on the gutter extends the row range from the
                // existing anchor. The click handler fall-through (when no
                // movement) handles the shift+click extend case.
                dragSelecting = 'row';
                e.preventDefault();
                return;
            }
            // Gutter click: start a row-select drag. If the row is already
            // fully selected, fall through (return) so the native HTML5
            // drag can carry the row away.
            if (isRowFullySelected(pos.r)) return;
            selAnchor = { r: pos.r, c: 1 };
            dragSelecting = 'row';
            selectRect(pos.r, 1, pos.r, dataColCount);
            applySelection();
            // The follow-up click would otherwise see "only this row is
            // selected" and toggle it back off. Suppress that.
            suppressNextToggle = true;
            e.preventDefault();
            return;
        }
        if (e.shiftKey && selAnchor) {
            // Shift+drag on a body cell extends the rect from selAnchor.
            // The click handler's shift+click branch covers the no-movement
            // case.
            dragSelecting = 'cell';
            e.preventDefault();
            return;
        }
        // If the press is on a cell that's already in the selection, do not
        // intercept — allow the native HTML5 drag to start so the existing
        // table drag&drop handler can run. (A plain click without movement
        // will still fall through to the click handler below and collapse
        // the selection to that cell.)
        if (selectedCells.has(selKey(pos.r, pos.c))) return;
        selAnchor = pos;
        dragSelecting = 'cell';
        e.preventDefault();
    });

    function onCellDragMove(e) {
        // Promote an armed column-header press into an active column drag
        // once the cursor has moved past a small threshold. This is the
        // signal that disambiguates "click for sort" from "drag to select
        // a column".
        if (pendingColDrag && !dragSelecting) {
            var ddx = Math.abs(e.clientX - pendingColDrag.startX);
            var ddy = Math.abs(e.clientY - pendingColDrag.startY);
            if (ddx + ddy > 4) {
                var tbodyP = tableEl.querySelector('tbody');
                var lastP = tbodyP ? tbodyP.rows.length - 1 : 0;
                dragSelecting = 'col';
                // Reuse an existing header anchor if there is one so
                // shift+drag extends a column range from the prior origin;
                // otherwise start a fresh column selection from the press.
                if (!selAnchor || selAnchor.r !== 0 || selAnchor.c < 1) {
                    selAnchor = { r: 0, c: pendingColDrag.col };
                }
                selectedCells.clear();
                selectRect(0, selAnchor.c, lastP, pendingColDrag.col);
                applySelection();
                // Suppress the click that would otherwise trigger the
                // library's column sort on mouseup.
                suppressNextClick = true;
                pendingColDrag = null;
                // The user is dragging, not clicking — abandon any armed
                // header-toggle action.
                pendingHeaderSelect = null;
            }
        }
        if (!dragSelecting || !selAnchor) return;
        lastDragX = e.clientX;
        lastDragY = e.clientY;
        if (dragSelecting === 'col') {
            var elc = document.elementFromPoint(e.clientX, e.clientY);
            var targetColC = null;
            if (elc && elc.closest) {
                var thT = elc.closest('thead th');
                if (thT && tableEl.contains(thT) && thT.cellIndex !== 0) {
                    targetColC = thT.cellIndex;
                } else {
                    var tdT = elc.closest('tbody td');
                    if (tdT && tableEl.contains(tdT) && tdT.cellIndex !== 0) {
                        targetColC = tdT.cellIndex;
                    }
                }
            }
            if (targetColC !== null) {
                var tbodyC = tableEl.querySelector('tbody');
                var lastC = tbodyC ? tbodyC.rows.length - 1 : 0;
                selectRect(0, selAnchor.c, lastC, targetColC);
                applySelection();
            }
            if (!scrollRaf) scrollRaf = requestAnimationFrame(autoScrollTick);
            return;
        }
        var el = document.elementFromPoint(e.clientX, e.clientY);
        var td = el && el.closest ? el.closest('tbody td') : null;
        if (td && tableEl.contains(td)) {
            var pos = getCellPos(td);
            if (pos) {
                if (dragSelecting === 'row') {
                    selectRect(selAnchor.r, 1, pos.r, dataColCount);
                } else {
                    // Clamp horizontal motion into the gutter back to col 1.
                    var c = pos.c === 0 ? 1 : pos.c;
                    selectRect(selAnchor.r, selAnchor.c, pos.r, c);
                }
                applySelection();
            }
        }
        // Kick off auto-scroll loop if cursor is near an edge of the
        // scrollable container. The loop self-terminates when dragSelecting
        // ends or the cursor moves away from the edge.
        if (!scrollRaf) scrollRaf = requestAnimationFrame(autoScrollTick);
    }
    function onCellDragEnd() {
        var wasDragging = dragSelecting;
        dragSelecting = false;
        pendingColDrag = null;
        if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = 0; }
        if (wasDragging) postSelectionChange();
    }
    document.addEventListener('mousemove', onCellDragMove);
    document.addEventListener('mouseup', onCellDragEnd);

    container.addEventListener('click', function(e) {
        var td = e.target.closest ? e.target.closest('tbody td') : null;
        if (!td) return;
        var pos = getCellPos(td);
        if (!pos) return;
        if (pos.c === 0) {
            // Gutter click: select the whole row. Shift+click extends the
            // row-range from selAnchor. Clicking the gutter of the only
            // selected row toggles it off.
            if (e.shiftKey && selAnchor) {
                selectRect(selAnchor.r, 1, pos.r, dataColCount);
                applySelection();
                postSelectionChange();
                return;
            }
            var rowAlone = !suppressNextToggle &&
                selectedCells.size === dataColCount &&
                isRowFullySelected(pos.r);
            suppressNextToggle = false;
            selectedCells.clear();
            if (rowAlone) {
                selAnchor = null;
            } else {
                selectRect(pos.r, 1, pos.r, dataColCount);
                selAnchor = { r: pos.r, c: 1 };
            }
            applySelection();
            postSelectionChange();
            return;
        }
        if (e.shiftKey && selAnchor) {
            selectRect(selAnchor.r, selAnchor.c, pos.r, pos.c);
        } else {
            // Toggle: if this is the only selected cell, clicking it again
            // clears the selection. Otherwise collapse to just this cell.
            var soloHit = selectedCells.size === 1 && selectedCells.has(selKey(pos.r, pos.c));
            selectedCells.clear();
            if (soloHit) {
                selAnchor = null;
            } else {
                selectedCells.add(selKey(pos.r, pos.c));
                selAnchor = pos;
            }
        }
        applySelection();
        postSelectionChange();
    });

    // ── Drag-drop ──
    /**
     * Builds an off-screen miniature table containing only the currently
     * selected cells and uses it as the drag image. Without this, the
     * browser auto-generates a snapshot of the full source table, which is
     * confusing when the user only intended to drag a sub-range.
     * Returns the temporary element so the caller can remove it after the
     * dragstart event completes.
     */
    function buildDragImage() {
        if (selectedCells.size === 0) return null;
        var minR = Infinity, maxR = -1, minC = Infinity, maxC = -1;
        selectedCells.forEach(function(k) {
            var rc = k.split(':');
            var r = +rc[0], c = +rc[1];
            if (r < minR) minR = r;
            if (r > maxR) maxR = r;
            if (c < minC) minC = c;
            if (c > maxC) maxC = c;
        });
        var tbody = tableEl.querySelector('tbody');
        if (!tbody) return null;
        var ghost = document.createElement('table');
        // Match the live table's look closely; the styles defined in <style>
        // for tbody td already apply because the ghost lives in the same
        // document.
        ghost.style.position = 'absolute';
        ghost.style.top = '-10000px';
        ghost.style.left = '-10000px';
        ghost.style.borderCollapse = 'collapse';
        ghost.style.background = 'var(--vscode-editor-background)';
        ghost.style.color = 'var(--vscode-foreground)';
        ghost.style.opacity = '0.95';
        var gbody = document.createElement('tbody');
        for (var r = minR; r <= maxR; r++) {
            var srcTr = tbody.rows[r];
            if (!srcTr) continue;
            var tr = document.createElement('tr');
            for (var c = minC; c <= maxC; c++) {
                var srcTd = srcTr.cells[c];
                var td = document.createElement('td');
                td.textContent = srcTd ? srcTd.textContent : '';
                td.style.padding = '4px 8px';
                td.style.border = '1px solid var(--vscode-panel-border, #888)';
                td.style.whiteSpace = 'nowrap';
                td.style.maxWidth = '300px';
                td.style.overflow = 'hidden';
                td.style.textOverflow = 'ellipsis';
                tr.appendChild(td);
            }
            gbody.appendChild(tr);
        }
        ghost.appendChild(gbody);
        document.body.appendChild(ghost);
        return ghost;
    }

    container.addEventListener('dragstart', function(e) {
        var tbl = e.target.closest ? e.target.closest('table') : null;
        if (!tbl) return;
        // The dragstart event target is the <table> itself; the actual user
        // grab point came from the last mousedown.
        var origin = lastDragOriginTarget;
        // Drag from the column-header row is reserved for sort / column
        // selection — cancel any HTML5 drag started there. The corner cell
        // is the exception: dragging it carries the whole table.
        var th = origin && origin.closest ? origin.closest('thead th') : null;
        var fromCorner = th && th.cellIndex === 0;
        if (th && !fromCorner) {
            e.preventDefault();
            return;
        }
        var expr = fromCorner ? cachedFullExpression : cachedExpression;
        var htmlPayload = fromCorner ? cachedFullHtml : cachedHtml;
        if (expr) {
            e.dataTransfer.setData('text/plain', expr);
            if (htmlPayload) {
                try { e.dataTransfer.setData('text/html', htmlPayload); } catch (_) {}
            }
            e.dataTransfer.effectAllowed = 'copy';
            // Custom mini drag image only for cell/row drags. Corner drags
            // use the browser's default whole-table snapshot.
            var ghost = fromCorner ? null : buildDragImage();
            if (ghost) {
                try { e.dataTransfer.setDragImage(ghost, 10, 10); } catch (_) {}
                // The drag image must remain in the DOM during the call but
                // can be removed right after — the browser has already
                // snapshotted it.
                setTimeout(function() { if (ghost.parentNode) ghost.parentNode.removeChild(ghost); }, 0);
            }
        } else {
            if (window._vscodeApi) {
                window._vscodeApi.postMessage({ command: 'requestExpression', _token: token });
            }
            e.preventDefault();
        }
    });

    // ── Listen for commands from the extension ──
    function onMessage(event) {
        var msg = event.data;
        if (!msg) return;

        // Only respond to commands when this container is the active tab
        if (!container.classList.contains('active')) return;

        if (msg.command === 'copyCell') {
            var cell = lastContextTarget ? lastContextTarget.closest('td, th') : null;
            if (cell && window._vscodeApi) {
                window._vscodeApi.postMessage({ command: 'copyText', text: cell.innerText, _token: token });
            }
            return;
        }

        if (msg.command === 'toggleSearch') {
            searchVisible = !searchVisible;
            if (wrapper) wrapper.classList.toggle('search-visible', searchVisible);
            if (searchVisible) {
                var input = container.querySelector('.datatable-input');
                if (input) input.focus();
            }
            return;
        }

        if (msg.command === 'setExpression' && typeof msg.expression === 'string') {
            cachedExpression = msg.expression;
            cachedHtml = (typeof msg.html === 'string') ? msg.html : '';
            if (typeof msg.fullExpression === 'string') {
                cachedFullExpression = msg.fullExpression;
                cachedFullHtml = (typeof msg.fullHtml === 'string') ? msg.fullHtml : '';
            }
            return;
        }
    }

    window.addEventListener('message', onMessage);

    // ── Cleanup for re-render ──
    container._dtCleanup = function() {
        window.removeEventListener('message', onMessage);
        document.removeEventListener('mousemove', onDocMouseMove);
        document.removeEventListener('mouseup', onDocMouseUp);
        document.removeEventListener('mousemove', onCellDragMove);
        document.removeEventListener('mouseup', onCellDragEnd);
        document.body.classList.remove('col-resizing');
        if (grid) grid.destroy();
    };
    } // end init

    // Defer if the Simple-DataTables CDN script hasn't loaded yet
    if (typeof simpleDatatables !== 'undefined') {
        init();
    } else {
        var cdnScript = document.querySelector('script[src*="simple-datatables"]');
        if (cdnScript) { cdnScript.addEventListener('load', init); }
    }
})();
<\/script>`;
    }
}

export class DataTableProvider implements IDataTableProvider {
    private readonly server: IServer;
    private readonly clipboard: IClipboard;

    constructor(server: IServer, clipboard: IClipboard) {
        this.server = server;
        this.clipboard = clipboard;
    }

    createView(webview: IWebView, table: ResultTable): IDataTableView {
        return new DataTableView(webview, this.server, this.clipboard, table);
    }
}
