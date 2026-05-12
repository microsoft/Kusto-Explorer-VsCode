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

/**
 * Escape HTML-special characters so the value is rendered as literal text by
 * Simple-DataTables (which interprets cell strings as HTML). Without this,
 * a value like `Name <user@example.com>` causes the grid to fail with
 * "InvalidCharacterError: Failed to execute 'createElement' ..." because
 * the angle-bracketed substring is parsed as a tag name.
 */
function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, ch => {
        switch (ch) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&#39;';
            default: return ch;
        }
    });
}

function formatCellValue(value: unknown): string {
    if (value === null || value === undefined) return '';
    const text = (typeof value === 'object') ? JSON.stringify(value) : String(value);
    return escapeHtml(text);
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
            columns: table.columns,
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
        table { border-collapse: collapse; width: fit-content !important; max-width: 100%; }
        th, td {
            padding: 4px 8px;
            text-align: left;
            border: 1px solid var(--vscode-editorGroup-border, var(--vscode-panel-border, #666));
            white-space: nowrap;
            max-width: 500px;
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
    var headings = tableData.columns.map(function(c) { return c.name; });
    var data = tableData.rows;
    var grid = new simpleDatatables.DataTable(tableEl, {
        data: { headings: headings, data: data },
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
