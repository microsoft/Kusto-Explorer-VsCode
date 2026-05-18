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
        this.server.getTableAsExpression(this.table).then(
            expression => { if (expression) this.webview.invoke('setExpression', { expression }); },
            () => { /* ignore errors — drag will just not work until next attempt */ }
        );
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
        /* Row selection */
        tbody tr { cursor: pointer; }
        tbody tr.row-selected {
            background: var(--vscode-list-activeSelectionBackground, #094771) !important;
            color: var(--vscode-list-activeSelectionForeground, #fff);
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
    tableData.columns.forEach(function(c, i) {
        var kustoType = c.type;
        var sortType =
            (kustoType === 'int' || kustoType === 'long' ||
             kustoType === 'real' || kustoType === 'decimal') ? 'number'
            : (kustoType === 'datetime') ? 'date'
            : (kustoType === 'bool') ? 'boolean'
            : 'string';
        columnSettings.push({ select: i, type: sortType });
    });

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
    var headings = tableData.columns.map(function(c) {
        return { data: c.name, text: c.name };
    });
    var rows = tableData.rows.map(function(row) {
        return row.map(function(text, i) {
            var sortType = columnSortTypes[i];
            return { data: text, text: text, order: computeOrder(text, sortType) };
        });
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
        tableEl.style.width = total + 'px';
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
        tableEl.style.width = (tableW + delta) + 'px';
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
        th.style.cursor = nearRightEdge(th, e.clientX) ? 'col-resize' : '';
    });

    // Suppress the click that would otherwise trigger sort after a resize drag
    // (or even a same-spot mousedown/mouseup on the edge).
    container.addEventListener('click', function(e) {
        if (!suppressNextClick) return;
        suppressNextClick = false;
        e.preventDefault();
        e.stopPropagation();
    }, true);

    // Make tables draggable
    container.querySelectorAll('table').forEach(function(tbl) {
        tbl.setAttribute('draggable', 'true');
    });

    // ── Context menu tracking (for copyCell) ──
    container.addEventListener('contextmenu', function(e) {
        lastContextTarget = e.target;
    });

    // ── Row selection ──
    container.addEventListener('click', function(e) {
        var tr = e.target.closest ? e.target.closest('tbody tr') : null;
        if (!tr) return;
        var prev = container.querySelector('tr.row-selected');
        if (prev && prev !== tr) prev.classList.remove('row-selected');
        tr.classList.toggle('row-selected');
    });

    // ── Drag-drop ──
    container.addEventListener('dragstart', function(e) {
        var tbl = e.target.closest ? e.target.closest('table') : null;
        if (!tbl) return;
        if (cachedExpression) {
            e.dataTransfer.setData('text/plain', cachedExpression);
            e.dataTransfer.effectAllowed = 'copy';
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
            return;
        }
    }

    window.addEventListener('message', onMessage);

    // ── Cleanup for re-render ──
    container._dtCleanup = function() {
        window.removeEventListener('message', onMessage);
        document.removeEventListener('mousemove', onDocMouseMove);
        document.removeEventListener('mouseup', onDocMouseUp);
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
