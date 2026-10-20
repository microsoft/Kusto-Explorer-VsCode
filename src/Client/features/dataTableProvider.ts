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

import type { IServer, ResultTable, ResultTableView } from './server';
import type { IWebView } from './webview';
import type { IClipboard } from './clipboard';
import { formatCfHtml } from './clipboard';
import { resultTableToHtml } from './html';
import { resultTableToMarkdown } from './markdown';
import { resultTableToTsv, formatCellValue } from './tsv';
import { computeSelectionStats, formatSelectionStats } from './selectionStats';

// ─── Interfaces ─────────────────────────────────────────────────────────────

/**
 * View for a single data table grid in a webview region.
 * Created by `IDataTableProvider.createView()`.
 */
export interface IDataTableView {
    /** Copy the entire table (or current selection) as a KQL `datatable()` expression. */
    copyTableAsDatatable(): Promise<void>;
    /** Default Ctrl+C path: TSV plain text + CF_HTML rich text on the clipboard. */
    copyTableAsText(): Promise<void>;
    /** Copy as markdown table source (plain text only). */
    copyTableAsMarkdown(): Promise<void>;
    /** Copy as HTML source text and CF_HTML rich text. */
    copyTableAsHtml(): Promise<void>;
    /** Toggle search box visibility. */
    toggleSearch(): void;
    /**
     * Current presentation state (column order/widths), or undefined when
     * the user has not made any adjustments. Callers persist this into the
     * matching `ResultData.tableViews[i]` slot.
     */
    getViewState(): ResultTableView | undefined;
    /**
     * Fires whenever the view state changes (user resized or reordered
     * columns). Subscribers typically mark the document dirty and update
     * the cached `ResultData.tableViews[i]`.
     */
    onDidChangeViewState(listener: (state: ResultTableView) => void): { dispose(): void };
    /** Release handlers and resources. */
    dispose(): void;
}

/** Provider for creating data table views bound to webview regions. */
export interface IDataTableProvider {
    /**
     * @param view Optional initial presentation state. When provided, the
     *             grid is rendered with the saved column order and widths.
     */
    createView(webview: IWebView, table: ResultTable, view?: ResultTableView): IDataTableView;
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
    /**
     * Current per-column view state. `undefined` means "all defaults".
     * Mutated whenever the webview reports a resize or (eventually) a
     * reorder, then handed back via `getViewState()` and emitted to
     * `viewStateListeners`.
     */
    private viewState: ResultTableView | undefined;
    private readonly viewStateListeners = new Set<(state: ResultTableView) => void>();

    constructor(webview: IWebView, server: IServer, clipboard: IClipboard, table: ResultTable, view?: ResultTableView) {
        this.webview = webview;
        this.server = server;
        this.clipboard = clipboard;
        this.table = table;
        this.viewState = view;
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
            if (msg.command === 'copyTable') {
                void this.copyTableAsText();
            }
            if (msg.command === 'setSelection') {
                const sel = msg.selection as { rows: number[]; cols: number[] } | null | undefined;
                this.currentSelection = sel ?? null;
                this.resolveExpression();
                this.publishSelectionStats();
            }
            if (msg.command === 'setColumnView') {
                this.applyColumnViewFromWebview(msg.columns);
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
        const viewJson = JSON.stringify(this.viewState ?? null).replace(/<\//g, '<\\/');
        webview.setContent(`<table></table><div class="selection-stats" hidden></div>${this.buildInitScript(json, viewJson)}`);
        this.resolveExpression();
    }

    getViewState(): ResultTableView | undefined {
        return this.viewState;
    }

    onDidChangeViewState(listener: (state: ResultTableView) => void): { dispose(): void } {
        this.viewStateListeners.add(listener);
        return {
            dispose: () => { this.viewStateListeners.delete(listener); }
        };
    }

    /**
     * Webview reported a column-view change (resize or reorder). Validate,
     * store as the new view state, and notify listeners so the host can
     * persist and mark the document dirty.
     */
    private applyColumnViewFromWebview(raw: unknown): void {
        if (!Array.isArray(raw)) return;
        const colCount = this.table.columns.length;
        const seen = new Set<number>();
        const columns: Array<{ index: number; width?: number }> = [];
        for (const entry of raw as Array<{ index?: unknown; width?: unknown }>) {
            if (!entry || typeof entry !== 'object') continue;
            const idx = entry.index;
            if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= colCount) continue;
            if (seen.has(idx)) continue;
            seen.add(idx);
            const w = entry.width;
            const next: { index: number; width?: number } = { index: idx };
            if (typeof w === 'number' && Number.isFinite(w) && w > 0) {
                next.width = Math.round(w);
            }
            columns.push(next);
        }
        const state: ResultTableView = { name: this.table.name, columns };
        this.viewState = state;
        for (const listener of this.viewStateListeners) {
            try { listener(state); } catch { /* listeners are best-effort */ }
        }
    }

    async copyTableAsDatatable(): Promise<void> {
        // Selection-aware (mirrors drag-and-drop). Falls back to the full table.
        const subset = this.buildSubsetTable();
        const expression = await this.server.getTableAsExpression(subset);
        if (expression) {
            await this.clipboard.copyText(expression);
        }
    }

    /**
     * Default "Copy" / Ctrl+C. A single-cell selection copies just the raw
     * value as plain text (no header, no quoting, no CF_HTML). Anything
     * larger puts TSV on the clipboard as plain text and the table's HTML
     * on the clipboard as CF_HTML, so apps that understand rich-text paste
     * (Excel, Word, Outlook) get a real table while plain-text editors get
     * tab-separated values.
     */
    async copyTableAsText(): Promise<void> {
        const subset = this.buildSubsetTable();
        if (subset.columns.length === 1 && subset.rows.length === 1) {
            await this.clipboard.copyText(formatCellValue(subset.rows[0]![0]));
            return;
        }
        const tsv = resultTableToTsv(subset);
        const html = resultTableToHtml(subset);
        if (html || tsv) {
            const items: { format: string; data: string; encoding: 'utf8' | 'text' }[] = [];
            if (html) {
                items.push({ format: 'HTML Format', data: formatCfHtml(html), encoding: 'utf8' });
            }
            if (tsv) {
                items.push({ format: 'Text', data: tsv, encoding: 'text' });
            }
            await this.clipboard.copyItems(items);
        }
    }

    /** "Copy as Markdown": markdown source as plain text only. */
    async copyTableAsMarkdown(): Promise<void> {
        const subset = this.buildSubsetTable();
        const markdown = resultTableToMarkdown(subset);
        if (markdown) {
            await this.clipboard.copyText(markdown);
        }
    }

    /**
     * "Copy as HTML": HTML source as plain text AND CF_HTML, so the
     * receiving app picks whichever it can handle. Word/Outlook render
     * the table; markdown / source editors get the HTML markup verbatim.
     */
    async copyTableAsHtml(): Promise<void> {
        const subset = this.buildSubsetTable();
        const html = resultTableToHtml(subset);
        if (html) {
            await this.clipboard.copyItems([
                { format: 'HTML Format', data: formatCfHtml(html), encoding: 'utf8' },
                { format: 'Text', data: html, encoding: 'text' },
            ]);
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
     * Computes aggregates for the current selection and pushes them to the
     * webview's status bar. The webview only holds display strings, so the
     * math runs here against the raw typed values. An empty selection sends
     * empty text, which hides the bar.
     */
    private publishSelectionStats(): void {
        const sel = this.currentSelection;
        const stats = sel ? computeSelectionStats(this.table, sel.rows, sel.cols) : undefined;
        this.webview.invoke('setSelectionStats', { text: formatSelectionStats(stats) });
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
            /* Allow the wrapper to shrink below its content height so the
               selection status bar below it stays visible. */
            min-height: 0;
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
        /* Selection statistics status bar. Pinned to the bottom of the view
           and only shown while a selection is active. */
        .selection-stats {
            flex: 0 0 auto;
            padding: 2px 8px;
            font-size: 0.9em;
            text-align: right;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            user-select: text;
            color: var(--vscode-foreground);
            background: var(--vscode-editorWidget-background, transparent);
            border-top: 1px solid var(--vscode-panel-border, transparent);
        }
        .selection-stats[hidden] { display: none; }
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
     * @param tableDataJson Stringified `{ columns, rows }` payload.
     * @param viewJson      Stringified `ResultTableView` or `null` when no
     *                      initial view state is provided.
     */
    private buildInitScript(tableDataJson: string, viewJson: string): string {
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
    var tableData = ${tableDataJson};
    // Saved presentation state to apply on first render. Matches the
    // host-side ResultTableView payload:
    //   { name: string, columns: [{ index, width? }, ...] } | null
    // The webview only reads "columns" (index is the position in
    // tableData.columns; width is in pixels). "name" is preserved by the
    // host for correlating views back to their table on round-trip.
    var tableView = ${viewJson};

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

    // After every internal re-render the library rebuilds tbody (and may
    // touch thead). Re-apply our column order so reorder survives sort,
    // page, and search. Re-stamp first in case the library rebuilt the
    // header cells — without data-col on each th, applyColOrder() and
    // postColumnView() would see incomplete identity information.
    function reapplyColOrder() {
        try {
            stampOriginalColIndex();
            applyColOrder();
        } catch (_) { /* table not initialized yet */ }
    }
    grid.on('datatable.update', reapplyColOrder);
    grid.on('datatable.page', reapplyColOrder);
    grid.on('datatable.search', reapplyColOrder);
    grid.on('datatable.refresh', reapplyColOrder);

    // ── Column-view state ───────────────────────────────────────────────
    // Stamp each data-column header with its ORIGINAL column index (the
    // index into tableData.columns), so resize/reorder can map a th back
    // to a stable identity even after columns get rearranged. The gutter
    // header (cellIndex 0) is intentionally left unstamped.
    function stampOriginalColIndex() {
        var ths = tableEl.querySelectorAll('thead th');
        for (var i = 1; i < ths.length; i++) {
            if (ths[i].dataset.col === undefined || ths[i].dataset.col === '') {
                ths[i].dataset.col = String(i - 1);
            }
        }
    }
    stampOriginalColIndex();

    // Apply any saved widths from the initial view state. We do this once,
    // after the grid has built its thead. Setting widths pins layout to
    // table-layout: fixed so the widths actually take effect for cells.
    // Reorder restore is handled by colOrder below.
    function applyInitialView() {
        if (!tableView || !tableView.columns) return;
        var anyWidth = false;
        for (var p = 0; p < tableView.columns.length; p++) {
            var pe = tableView.columns[p];
            if (pe && typeof pe.width === 'number' && pe.width > 0) { anyWidth = true; break; }
        }
        if (!anyWidth) return;
        // Defer until layout is valid. When the host tab is inactive at
        // init time (display:none / zero size), every th.offsetWidth is
        // zero — we cannot capture sensible natural widths in that state.
        applySavedWidthsWhenLaidOut();
    }

    /**
     * Apply saved widths from tableView.columns and pin to table-layout:
     * fixed. Must run only when the table has a real layout (positive
     * offsetWidths). Captures natural widths of EVERY column BEFORE
     * applying any saved widths, because once an inline width is set on
     * one column in auto layout the browser redistributes remaining space
     * and unstyled columns (notably the gutter) report a squished
     * offsetWidth — which would then get frozen by ensurePinned.
     *
     * The container may stay zero-sized indefinitely if its host tab
     * is never activated, so this function is bounded: it makes a
     * fixed number of rAF/setTimeout attempts and, if still not laid
     * out, hands off to a ResizeObserver / IntersectionObserver that
     * fires once the element actually becomes measurable. That
     * guarantees the retry loop terminates without spinning CPU.
     */
    var widthApplyAttempts = 0;
    var widthApplyMaxAttempts = 60;     // ~1s at 60fps before handing off
    var widthApplyObserversArmed = false;
    function applySavedWidthsWhenLaidOut() {
        if (tableLayoutPinned) return;
        var ths = tableEl.querySelectorAll('thead th');
        var ready = ths.length > 0;
        if (ready) {
            for (var k = 0; k < ths.length; k++) {
                if (ths[k].offsetWidth <= 0) { ready = false; break; }
            }
        }
        if (!ready) {
            if (widthApplyAttempts++ < widthApplyMaxAttempts) {
                try { requestAnimationFrame(applySavedWidthsWhenLaidOut); }
                catch (_) { setTimeout(applySavedWidthsWhenLaidOut, 100); }
            } else {
                armWidthApplyObservers();
            }
            return;
        }
        // 1) Pin every column to its current natural width.
        for (var i = 0; i < ths.length; i++) {
            if (!ths[i].style.width) {
                ths[i].style.width = ths[i].offsetWidth + 'px';
            }
        }
        // 2) Overwrite data columns with their saved widths by original index.
        var thsByCol = {};
        for (var m = 1; m < ths.length; m++) {
            thsByCol[ths[m].dataset.col] = ths[m];
        }
        for (var j = 0; j < tableView.columns.length; j++) {
            var entry = tableView.columns[j];
            if (!entry || typeof entry.index !== 'number') continue;
            var th = thsByCol[String(entry.index)];
            if (!th) continue;
            if (typeof entry.width === 'number' && entry.width > 0) {
                th.style.width = entry.width + 'px';
            }
        }
        // 3) Total table width = sum of pinned column widths.
        var total = 0;
        for (var n = 0; n < ths.length; n++) {
            total += parseFloat(ths[n].style.width) || ths[n].offsetWidth;
        }
        tableEl.style.setProperty('width', total + 'px', 'important');
        tableEl.style.tableLayout = 'fixed';
        tableLayoutPinned = true;
    }

    // If the rAF retry budget is exhausted (host tab still hidden or
    // container still zero-sized), wait for an actual layout signal
    // rather than polling. Both observers are one-shot — the first one
    // to fire disconnects all of them and resumes the apply attempt.
    function armWidthApplyObservers() {
        if (widthApplyObserversArmed || tableLayoutPinned) return;
        widthApplyObserversArmed = true;
        var resizeObs = null;
        var intersectObs = null;
        function cleanup() {
            try { if (resizeObs) resizeObs.disconnect(); } catch (_) {}
            try { if (intersectObs) intersectObs.disconnect(); } catch (_) {}
            resizeObs = null;
            intersectObs = null;
        }
        function resume() {
            cleanup();
            // Reset the bounded retry budget so the resumed attempt can
            // ride out any remaining rAF stabilization passes.
            widthApplyAttempts = 0;
            widthApplyObserversArmed = false;
            try { requestAnimationFrame(applySavedWidthsWhenLaidOut); }
            catch (_) { setTimeout(applySavedWidthsWhenLaidOut, 0); }
        }
        try {
            if (typeof ResizeObserver === 'function') {
                resizeObs = new ResizeObserver(function(entries) {
                    for (var ri = 0; ri < entries.length; ri++) {
                        var r = entries[ri].contentRect;
                        if (r && r.width > 0 && r.height > 0) { resume(); return; }
                    }
                });
                resizeObs.observe(tableEl);
            }
        } catch (_) { /* observer not supported */ }
        try {
            if (typeof IntersectionObserver === 'function') {
                intersectObs = new IntersectionObserver(function(entries) {
                    for (var ii = 0; ii < entries.length; ii++) {
                        if (entries[ii].isIntersecting) { resume(); return; }
                    }
                });
                intersectObs.observe(tableEl);
            }
        } catch (_) { /* observer not supported */ }
        // If neither observer is available, give up silently; the user
        // can trigger a redraw by interacting with the table and saved
        // widths will be applied at that point via reapplyColOrder.
    }
    applyInitialView();

    // ── Column reorder ─────────────────────────────────────────────────
    // colOrder is the desired display order of ORIGINAL data-column indices.
    // Length === dataColCount. The gutter column (cellIndex 0) is not part
    // of colOrder and never moves.
    var colOrder = [];
    for (var coI = 0; coI < dataColCount; coI++) colOrder.push(coI);
    if (tableView && tableView.columns) {
        var seenCO = {};
        var orderCO = [];
        for (var coJ = 0; coJ < tableView.columns.length; coJ++) {
            var coEntry = tableView.columns[coJ];
            if (!coEntry || typeof coEntry.index !== 'number') continue;
            if (coEntry.index < 0 || coEntry.index >= dataColCount) continue;
            if (seenCO[coEntry.index]) continue;
            orderCO.push(coEntry.index);
            seenCO[coEntry.index] = true;
        }
        for (var coK = 0; coK < dataColCount; coK++) {
            if (!seenCO[coK]) orderCO.push(coK);
        }
        if (orderCO.length === dataColCount) colOrder = orderCO;
    }

    /**
     * Reorder the cells of thead and every tbody row to match colOrder.
     * Skips the gutter cell (cellIndex 0). Idempotent.
     */
    function applyColOrder() {
        var theadRow = tableEl.querySelector('thead tr');
        if (theadRow) reorderRowCells(theadRow, function(c) { return c.dataset ? c.dataset.col : null; });
        var tbody = tableEl.querySelector('tbody');
        if (tbody) {
            for (var rOI = 0; rOI < tbody.rows.length; rOI++) {
                reorderRowCells(tbody.rows[rOI], function(c) { return c.getAttribute('data-orig-col'); });
            }
        }
    }
    function reorderRowCells(rowEl, getOrigIdx) {
        var byCol = {};
        var cells = rowEl.cells;
        for (var i = 1; i < cells.length; i++) {
            var oc = getOrigIdx(cells[i]);
            if (oc !== null && oc !== undefined && oc !== '') byCol[String(oc)] = cells[i];
        }
        for (var j = 0; j < colOrder.length; j++) {
            var cell = byCol[String(colOrder[j])];
            if (cell) rowEl.appendChild(cell); // moves to the end, building order
        }
    }
    applyColOrder();

    /**
     * Posts the current column view (original-index + width per data
     * column, in display order) to the host. Called on resize mouseup.
     */
    function postColumnView() {
        var ths = tableEl.querySelectorAll('thead th');
        var cols = [];
        for (var i = 1; i < ths.length; i++) {
            var idxStr = ths[i].dataset.col;
            if (idxStr === undefined || idxStr === '') continue;
            var idx = parseInt(idxStr, 10);
            if (isNaN(idx)) continue;
            var entry = { index: idx };
            var w = parseFloat(ths[i].style.width);
            if (!isNaN(w) && w > 0) entry.width = Math.round(w);
            cols.push(entry);
        }
        window._vscodeApi.postMessage({ command: 'setColumnView', columns: cols, _token: token });
    }

    // Make the container focusable (tabindex=-1) so mousedown can hand it
    // keyboard focus. Without this, our mousedown handlers' preventDefault
    // calls suppress the browser's default focus transfer to the iframe
    // document — and document-level keydown listeners (notably Ctrl+C)
    // never fire.
    if (!container.hasAttribute('tabindex')) {
        container.setAttribute('tabindex', '-1');
    }
    container.style.outline = 'none';

    // Capture-phase mousedown ensures the container gets keyboard focus
    // even when downstream handlers preventDefault (which would otherwise
    // block the browser's default focus transfer). Required so Ctrl+C
    // reaches our document-level keydown handler.
    container.addEventListener('mousedown', function() {
        try { container.focus({ preventScroll: true }); } catch (_) { container.focus(); }
    }, true);

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
        postColumnView();
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
    // Column-reorder drag state. reorderSourceCol is the ORIGINAL column
    // index being dragged; reorderTargetCol is the original index of the
    // hovered drop column; reorderInsertBefore is true when the drop is to
    // the left of the target, false for the right side.
    var reorderSourceCol = null;
    var reorderTargetCol = null;
    var reorderInsertBefore = false;
    var reorderIndicator = null;
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
        // selection / column REORDER. The corner cell carries the whole
        // table, a fully selected column carries the selection, and a
        // plain (unselected) data header initiates a column reorder.
        var th = origin && origin.closest ? origin.closest('thead th') : null;
        var fromCorner = th && th.cellIndex === 0;
        var fromSelectedHeader = th && !fromCorner && th.classList.contains('col-selected');
        var fromPlainHeader = th && !fromCorner && !fromSelectedHeader;
        // If the user grabbed the resize edge, the mousedown handler already
        // called preventDefault — dragstart should not have fired. Guard
        // anyway in case the threshold differs slightly.
        if (fromPlainHeader && nearRightEdge(th, e.clientX)) {
            e.preventDefault();
            return;
        }
        if (fromPlainHeader) {
            var srcOrig = parseInt(th.dataset.col, 10);
            if (isNaN(srcOrig)) { e.preventDefault(); return; }
            reorderSourceCol = srcOrig;
            reorderTargetCol = null;
            reorderInsertBefore = false;
            try { e.dataTransfer.setData('application/x-kusto-col', String(srcOrig)); } catch (_) {}
            e.dataTransfer.effectAllowed = 'move';
            // Small drag image: a clone of the header cell.
            var colGhost = th.cloneNode(true);
            colGhost.style.position = 'absolute';
            colGhost.style.top = '-1000px';
            colGhost.style.left = '-1000px';
            colGhost.style.background = 'var(--vscode-editor-background, #1e1e1e)';
            colGhost.style.color = 'var(--vscode-editor-foreground, #ddd)';
            colGhost.style.padding = '4px 10px';
            colGhost.style.border = '1px solid var(--vscode-focusBorder, #007acc)';
            colGhost.style.opacity = '0.9';
            colGhost.style.pointerEvents = 'none';
            document.body.appendChild(colGhost);
            try { e.dataTransfer.setDragImage(colGhost, 10, 10); } catch (_) {}
            setTimeout(function() { if (colGhost.parentNode) colGhost.parentNode.removeChild(colGhost); }, 0);
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

    // ── Column-reorder drop tracking ─────────────────────────────────────
    function ensureReorderIndicator() {
        if (reorderIndicator) return reorderIndicator;
        var dc = tableEl.closest('.datatable-container') || container;
        // The indicator is positioned relative to the scroll container so
        // it tracks horizontal scrolling.
        if (getComputedStyle(dc).position === 'static') {
            dc.style.position = 'relative';
        }
        reorderIndicator = document.createElement('div');
        reorderIndicator.style.position = 'absolute';
        reorderIndicator.style.top = '0';
        reorderIndicator.style.width = '2px';
        reorderIndicator.style.background = 'var(--vscode-focusBorder, #007acc)';
        reorderIndicator.style.pointerEvents = 'none';
        reorderIndicator.style.zIndex = '50';
        reorderIndicator.style.display = 'none';
        dc.appendChild(reorderIndicator);
        return reorderIndicator;
    }

    container.addEventListener('dragover', function(e) {
        if (reorderSourceCol === null) return;
        var th = e.target.closest ? e.target.closest('thead th') : null;
        if (!th || !tableEl.contains(th) || th.cellIndex === 0) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
        var rect = th.getBoundingClientRect();
        var mid = rect.left + rect.width / 2;
        var insertBefore = e.clientX < mid;
        var tgt = parseInt(th.dataset.col, 10);
        if (isNaN(tgt)) return;
        reorderTargetCol = tgt;
        reorderInsertBefore = insertBefore;
        var dc = tableEl.closest('.datatable-container') || container;
        var dcRect = dc.getBoundingClientRect();
        var x = (insertBefore ? rect.left : rect.right) - dcRect.left + dc.scrollLeft;
        var ind = ensureReorderIndicator();
        ind.style.left = (x - 1) + 'px';
        ind.style.height = dc.clientHeight + 'px';
        ind.style.display = 'block';
    });

    container.addEventListener('drop', function(e) {
        if (reorderSourceCol === null) return;
        e.preventDefault();
        if (reorderIndicator) reorderIndicator.style.display = 'none';
        var src = reorderSourceCol;
        var tgt = reorderTargetCol;
        var before = reorderInsertBefore;
        reorderSourceCol = null;
        reorderTargetCol = null;
        if (tgt === null || src === tgt) return;
        var srcPos = colOrder.indexOf(src);
        if (srcPos < 0) return;
        colOrder.splice(srcPos, 1);
        var newTgtPos = colOrder.indexOf(tgt);
        if (newTgtPos < 0) {
            // Target somehow vanished — restore source at original position.
            colOrder.splice(srcPos, 0, src);
            return;
        }
        var insertAt = before ? newTgtPos : newTgtPos + 1;
        colOrder.splice(insertAt, 0, src);
        // Clear selection: cellIndex positions are about to shift.
        if (selectedCells.size > 0 || selAnchor) {
            selectedCells.clear();
            selAnchor = null;
            applySelection();
            postSelectionChange();
        }
        applyColOrder();
        postColumnView();
    });

    container.addEventListener('dragend', function() {
        reorderSourceCol = null;
        reorderTargetCol = null;
        if (reorderIndicator) reorderIndicator.style.display = 'none';
    });

    // ── Listen for commands from the extension ──
    function onMessage(event) {
        var msg = event.data;
        if (!msg) return;

        // Only respond to commands when this container is the active tab
        if (!container.classList.contains('active')) return;

        if (msg.command === 'toggleSearch') {
            searchVisible = !searchVisible;
            if (wrapper) wrapper.classList.toggle('search-visible', searchVisible);
            if (searchVisible) {
                var input = container.querySelector('.datatable-input');
                if (input) input.focus();
            }
            return;
        }

        if (msg.command === 'setSelectionStats') {
            var statsEl = container.querySelector('.selection-stats');
            if (statsEl) {
                var statsText = (typeof msg.text === 'string') ? msg.text : '';
                // textContent, never innerHTML — the text is host-generated
                // but the grid never injects markup into the page.
                statsEl.textContent = statsText;
                statsEl.hidden = statsText === '';
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

    // Ctrl/Cmd+C inside the webview: ask the extension host to copy the
    // current selection (or the whole table when there is no selection).
    // VS Code keybindings do not reliably fire inside webview iframes, so
    // we forward the keystroke via postMessage.
    function onKeyDown(e) {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey &&
            (e.key === 'c' || e.key === 'C')) {
            // Multiple table tabs share the same iframe document, so each
            // has its own keydown handler. Only the active tab should
            // forward Ctrl+C — otherwise inactive tabs would clobber the
            // clipboard with their (unselected) full tables.
            if (!container.classList.contains('active')) return;
            // Let the browser's native copy proceed if the user has an
            // actual text selection in an input/textarea (e.g. the search
            // box) so they can still copy text from those.
            var ae = document.activeElement;
            if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
            if (window._vscodeApi) {
                window._vscodeApi.postMessage({ command: 'copyTable', _token: token });
            }
            e.preventDefault();
        }
    }
    document.addEventListener('keydown', onKeyDown);

    // ── Cleanup for re-render ──
    container._dtCleanup = function() {
        window.removeEventListener('message', onMessage);
        document.removeEventListener('keydown', onKeyDown);
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

    createView(webview: IWebView, table: ResultTable, view?: ResultTableView): IDataTableView {
        return new DataTableView(webview, this.server, this.clipboard, table, view);
    }
}
