// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataTableProvider } from '../../features/dataTableProvider';
import type { IDataTableView } from '../../features/dataTableProvider';
import type { IWebView } from '../../features/webview';
import { NullServer } from '../../features/server';
import type { IServer, ResultTable } from '../../features/server';
import type { IClipboard } from '../../features/clipboard';

// ─── Mock IWebView ──────────────────────────────────────────────────────────

function createMockWebView(): IWebView & {
    setup: ReturnType<typeof vi.fn>;
    setContent: ReturnType<typeof vi.fn>;
    invoke: ReturnType<typeof vi.fn>;
    simulateMessage: (message: Record<string, unknown>) => void;
} {
    const handlers: ((message: Record<string, unknown>) => void)[] = [];
    return {
        setup: vi.fn(),
        setContent: vi.fn(),
        invoke: vi.fn(),
        handle: vi.fn((handler: (message: Record<string, unknown>) => void) => {
            handlers.push(handler);
            return { dispose: () => { const i = handlers.indexOf(handler); if (i >= 0) handlers.splice(i, 1); } };
        }),
        simulateMessage(message: Record<string, unknown>) {
            for (const h of handlers) { h(message); }
        },
    };
}

function createMockServer(getTableAsExpression?: (table: ResultTable) => Promise<string | null>): IServer {
    const server = new NullServer();
    if (getTableAsExpression) {
        server.getTableAsExpression = getTableAsExpression;
    }
    return server;
}

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeTable(columns: { name: string; type: string }[], rows: unknown[][]): ResultTable {
    return { name: 'TestTable', columns, rows };
}

function make2dTable(): ResultTable {
    return makeTable(
        [{ name: 'Category', type: 'string' }, { name: 'Value', type: 'real' }],
        [['A', 10], ['B', 20], ['C', 30]],
    );
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('SimpleDataTableProvider', () => {
    let provider: DataTableProvider;
    let clipboard: IClipboard;

    beforeEach(() => {
        clipboard = {
            setContext: vi.fn(),
            getContext: vi.fn(),
            clearContext: vi.fn(),
            copyItems: vi.fn(),
            copyText: vi.fn(),
        };
        provider = new DataTableProvider(new NullServer(), clipboard);
    });

    // ─── createView ─────────────────────────────────────────────────────

    describe('createView', () => {
        it('calls webview.setup() with CDN link and CSS', () => {
            const webview = createMockWebView();
            provider.createView(webview, make2dTable());

            expect(webview.setup).toHaveBeenCalledOnce();
            const [headHtml, scriptsHtml] = webview.setup.mock.calls[0]!;
            expect(headHtml).toContain('simple-datatables');
            expect(headHtml).toContain('<style>');
            expect(headHtml).toContain('.datatable-wrapper');
            expect(scriptsHtml).toBe('');
        });

        it('returns an IDataTableView', () => {
            const webview = createMockWebView();
            const view = provider.createView(webview, make2dTable());

            expect(view).toBeDefined();
            expect(typeof view.copyTableAsText).toBe('function');
            expect(typeof view.copyTableAsMarkdown).toBe('function');
            expect(typeof view.copyTableAsHtml).toBe('function');
            expect(typeof view.copyTableAsDatatable).toBe('function');
            expect(typeof view.toggleSearch).toBe('function');
            expect(typeof view.dispose).toBe('function');
        });

        it('subscribes to webview messages', () => {
            const webview = createMockWebView();
            provider.createView(webview, make2dTable());

            expect(webview.handle).toHaveBeenCalledOnce();
        });

        it('calls webview.setContent with HTML containing a table and script', () => {
            const webview = createMockWebView();
            provider.createView(webview, make2dTable());

            expect(webview.setContent).toHaveBeenCalledOnce();
            const html: string = webview.setContent.mock.calls[0]![0];
            expect(html).toContain('<table>');
            expect(html).toContain('<script>');
        });

        it('embeds column names in the content', () => {
            const webview = createMockWebView();
            provider.createView(webview, make2dTable());
            const html: string = webview.setContent.mock.calls[0]![0];

            expect(html).toContain('Category');
            expect(html).toContain('Value');
        });

        it('embeds row data in the content', () => {
            const webview = createMockWebView();
            provider.createView(webview, make2dTable());
            const html: string = webview.setContent.mock.calls[0]![0];

            expect(html).toContain('"A"');
            expect(html).toContain('"10"');
            expect(html).toContain('"20"');
        });

        it('formats null and undefined as empty strings', () => {
            const table = makeTable(
                [{ name: 'Col', type: 'string' }],
                [[null], [undefined]],
            );
            const webview = createMockWebView();
            provider.createView(webview, table);
            const html: string = webview.setContent.mock.calls[0]![0];

            // Both null and undefined become empty strings in the JSON
            expect(html).toContain('""');
        });

        it('formats objects as JSON strings', () => {
            const table = makeTable(
                [{ name: 'Col', type: 'dynamic' }],
                [[{ a: 1 }]],
            );
            const webview = createMockWebView();
            provider.createView(webview, table);
            const html: string = webview.setContent.mock.calls[0]![0];

            // formatCellValue produces '{"a":1}'. That string is then JSON
            // serialized for the embedded payload, so the inner `"` become
            // `\"`. We no longer HTML-escape cell values (Simple-DataTables
            // renders cell text via textContent), so `&quot;` must NOT appear.
            expect(html).toContain('{\\"a\\":1}');
            expect(html).not.toContain('&quot;');
        });

        it('escapes closing script tags in JSON data', () => {
            const table = makeTable(
                [{ name: 'Col', type: 'string' }],
                [['</script>']],
            );
            const webview = createMockWebView();
            provider.createView(webview, table);
            const html: string = webview.setContent.mock.calls[0]![0];

            // The cell value is no longer HTML-escaped, but the embedded JSON
            // is still protected against early `</script>` termination by the
            // `</` -> `<\/` replacement at serialization time. Only the real
            // closing </script> tag should appear; the cell payload should use
            // the `<\/script>` form.
            const matches = html.match(/<\/script>/g);
            expect(matches).toHaveLength(1);
            expect(html).toContain('<\\/script>');
        });

        it('preserves angle brackets in cell values (passed via cell objects)', () => {
            // Repro for the customer bug: `print Requestor = "George Washington <gwashington@contoso.com>"`
            // crashed Simple-DataTables with `InvalidCharacterError: Failed to execute 'createElement'`
            // because it interpreted the `<gwashington...>` substring as an HTML tag.
            //
            // The fix is to pass each cell as a Simple-DataTables cell
            // object with all three of data/text/order set, which triggers
            // the early-return path in readDataCell and bypasses HTML
            // parsing entirely. Angle brackets therefore survive verbatim
            // in the JSON payload.
            const table = makeTable(
                [{ name: 'Requestor', type: 'string' }],
                [['George Washington <gwashington@contoso.com>']],
            );
            const webview = createMockWebView();
            provider.createView(webview, table);
            const html: string = webview.setContent.mock.calls[0]![0];

            expect(html).toContain('George Washington <gwashington@contoso.com>');
            expect(html).not.toContain('&lt;gwashington@contoso.com&gt;');
        });

        it('preserves ampersands and quotes in cell values', () => {
            const table = makeTable(
                [{ name: 'Col', type: 'string' }],
                [['Tom & Jerry'], ['She said "hi"'], ["It's fine"]],
            );
            const webview = createMockWebView();
            provider.createView(webview, table);
            const html: string = webview.setContent.mock.calls[0]![0];

            // Cell values are no longer HTML-escaped — they appear raw in
            // the JSON payload (with JSON's own `\"` quote escaping).
            expect(html).toContain('Tom & Jerry');
            expect(html).not.toContain('&amp;');
            expect(html).not.toContain('&quot;');
            expect(html).toContain('She said \\"hi\\"');
            expect(html).toContain("It's fine");
        });

        it('preserves angle brackets in column names (passed via cell objects)', () => {
            // Column names are passed as Simple-DataTables heading cell
            // objects ({ data, text }), with column types supplied separately
            // via the `columns` config. The library returns these heading
            // objects as-is without re-parsing as HTML, so angle brackets
            // survive raw in the JSON payload and do not need HTML-escaping.
            const table = makeTable(
                [{ name: 'Value <units>', type: 'real' }],
                [[42]],
            );
            const webview = createMockWebView();
            provider.createView(webview, table);
            const html: string = webview.setContent.mock.calls[0]![0];

            expect(html).toContain('Value <units>');
            expect(html).not.toContain('Value &lt;units&gt;');
        });

        it('includes Simple-DataTables initialization in the script', () => {
            const webview = createMockWebView();
            provider.createView(webview, make2dTable());
            const html: string = webview.setContent.mock.calls[0]![0];

            expect(html).toContain('simpleDatatables.DataTable');
            expect(html).toContain('perPage');
        });

        it('includes container-relative DOM queries in the script', () => {
            const webview = createMockWebView();
            provider.createView(webview, make2dTable());
            const html: string = webview.setContent.mock.calls[0]![0];

            expect(html).toContain('document.currentScript.parentElement');
            expect(html).toContain('container.querySelector');
        });

        it('includes cleanup support for re-render', () => {
            const webview = createMockWebView();
            provider.createView(webview, make2dTable());
            const html: string = webview.setContent.mock.calls[0]![0];

            expect(html).toContain('_dtCleanup');
        });
    });

    // ─── invoke methods ─────────────────────────────────────────────────

    describe('toggleSearch', () => {
        it('invokes toggleSearch command on the webview', () => {
            const webview = createMockWebView();
            const view = provider.createView(webview, make2dTable());

            view.toggleSearch();

            expect(webview.invoke).toHaveBeenCalledWith('toggleSearch');
        });
    });

    describe('expression resolver', () => {
        it('calls the server with the table on creation', async () => {
            const mockGetExpr = vi.fn(async () => 'datatable(x:int)[1]');
            const p = new DataTableProvider(createMockServer(mockGetExpr), clipboard);
            const webview = createMockWebView();
            const table = make2dTable();
            p.createView(webview, table);

            await Promise.resolve();

            expect(mockGetExpr).toHaveBeenCalledWith(table);
            expect(webview.invoke).toHaveBeenCalledWith(
                'setExpression',
                expect.objectContaining({ expression: 'datatable(x:int)[1]' })
            );
        });

        it('calls the server on requestExpression message', async () => {
            const mockGetExpr = vi.fn(async () => 'expr');
            const p = new DataTableProvider(createMockServer(mockGetExpr), clipboard);
            const webview = createMockWebView();
            p.createView(webview, make2dTable());

            await Promise.resolve();
            webview.invoke.mockClear();
            mockGetExpr.mockClear();

            const html: string = webview.setContent.mock.calls[0]![0];
            const match = html.match(/var token = '(dt-[a-z0-9]+)'/);
            const token = match![1]!;

            webview.simulateMessage({ command: 'requestExpression', _token: token });
            await Promise.resolve();

            expect(mockGetExpr).toHaveBeenCalledOnce();
            expect(webview.invoke).toHaveBeenCalledWith(
                'setExpression',
                expect.objectContaining({ expression: 'expr' })
            );
        });

        it('does not invoke setExpression when server returns null', async () => {
            const p = new DataTableProvider(createMockServer(async () => null), clipboard);
            const webview = createMockWebView();
            p.createView(webview, make2dTable());

            await Promise.resolve();

            expect(webview.invoke).not.toHaveBeenCalledWith('setExpression', expect.anything());
        });

        it('does not throw when server rejects', async () => {
            const p = new DataTableProvider(createMockServer(async () => { throw new Error('server error'); }), clipboard);
            const webview = createMockWebView();
            p.createView(webview, make2dTable());

            await Promise.resolve();
            // no error thrown
        });

        it('does not invoke setExpression when server returns null (NullServer)', async () => {
            const webview = createMockWebView();
            provider.createView(webview, make2dTable());

            await Promise.resolve();

            expect(webview.invoke).not.toHaveBeenCalledWith('setExpression', expect.anything());
        });
    });

    // ─── copyTableAsDatatable ─────────────────────────────────────────

    describe('copyTableAsDatatable', () => {
        it('copies expression to clipboard', async () => {
            const mockGetExpr = vi.fn(async () => 'datatable(x:int)[1]');
            const p = new DataTableProvider(createMockServer(mockGetExpr), clipboard);
            const webview = createMockWebView();
            const table = make2dTable();
            const view = p.createView(webview, table);

            await view.copyTableAsDatatable();

            expect(mockGetExpr).toHaveBeenCalledWith(table);
            expect(clipboard.copyText).toHaveBeenCalledWith('datatable(x:int)[1]');
        });

        it('does not copy when server returns null', async () => {
            const p = new DataTableProvider(createMockServer(async () => null), clipboard);
            const webview = createMockWebView();
            const view = p.createView(webview, make2dTable());

            await view.copyTableAsDatatable();

            expect(clipboard.copyText).not.toHaveBeenCalled();
        });
    });

    // ─── copyTableAsText (default Ctrl+C) ────────────────────────────────

    describe('copyTableAsText', () => {
        it('copies CF_HTML and TSV to clipboard', async () => {
            const webview = createMockWebView();
            const view = provider.createView(webview, make2dTable());

            await view.copyTableAsText();

            expect(clipboard.copyItems).toHaveBeenCalledOnce();
            const items = (clipboard.copyItems as ReturnType<typeof vi.fn>).mock.calls[0]![0];
            expect(items).toHaveLength(2);
            expect(items[0].format).toBe('HTML Format');
            expect(items[1].format).toBe('Text');
            // Text item should be TSV (tab-separated), not markdown pipes.
            expect(items[1].data).toContain('\t');
            expect(items[1].data).not.toContain('|');
        });
    });

    // ─── copyTableAsMarkdown ─────────────────────────────────────────────

    describe('copyTableAsMarkdown', () => {
        it('copies markdown source as plain text', async () => {
            const webview = createMockWebView();
            const view = provider.createView(webview, make2dTable());

            await view.copyTableAsMarkdown();

            expect(clipboard.copyText).toHaveBeenCalledOnce();
            const text = (clipboard.copyText as ReturnType<typeof vi.fn>).mock.calls[0]![0];
            expect(text).toContain('|');
            expect(text).toContain('---');
        });
    });

    // ─── copyTableAsHtml ────────────────────────────────────────────────

    describe('copyTableAsHtml', () => {
        it('copies CF_HTML and HTML source', async () => {
            const webview = createMockWebView();
            const view = provider.createView(webview, make2dTable());

            await view.copyTableAsHtml();

            expect(clipboard.copyItems).toHaveBeenCalledOnce();
            const items = (clipboard.copyItems as ReturnType<typeof vi.fn>).mock.calls[0]![0];
            expect(items).toHaveLength(2);
            expect(items[0].format).toBe('HTML Format');
            expect(items[1].format).toBe('Text');
            // Text item should be raw HTML markup.
            expect(items[1].data).toContain('<table');
        });
    });

    // ─── column view state ──────────────────────────────────────────────

    describe('column view state', () => {
        it('returns undefined view state initially when none provided', () => {
            const webview = createMockWebView();
            const view = provider.createView(webview, make2dTable());

            expect(view.getViewState()).toBeUndefined();
        });

        it('returns the initial view state when one is provided', () => {
            const webview = createMockWebView();
            const initial = { name: 'TestTable', columns: [{ index: 0, width: 120 }, { index: 1, width: 80 }] };
            const view = provider.createView(webview, make2dTable(), initial);

            expect(view.getViewState()).toEqual(initial);
        });

        it('embeds the initial view JSON into the init script', () => {
            const webview = createMockWebView();
            provider.createView(webview, make2dTable(), { name: 'TestTable', columns: [{ index: 1, width: 99 }] });
            const html: string = webview.setContent.mock.calls[0]![0];

            expect(html).toContain('var tableView');
            expect(html).toContain('"index":1');
            expect(html).toContain('"width":99');
        });

        it('embeds null tableView when no initial state is provided', () => {
            const webview = createMockWebView();
            provider.createView(webview, make2dTable());
            const html: string = webview.setContent.mock.calls[0]![0];

            expect(html).toContain('var tableView = null;');
        });

        it('updates view state on setColumnView message', () => {
            const webview = createMockWebView();
            const view = provider.createView(webview, make2dTable());
            const html: string = webview.setContent.mock.calls[0]![0];
            const token = html.match(/var token = '(dt-[a-z0-9]+)'/)![1]!;

            webview.simulateMessage({
                command: 'setColumnView',
                _token: token,
                columns: [{ index: 0, width: 150 }, { index: 1, width: 200 }],
            });

            expect(view.getViewState()).toEqual({
                name: 'TestTable',
                columns: [{ index: 0, width: 150 }, { index: 1, width: 200 }],
            });
        });

        it('notifies onDidChangeViewState listeners', () => {
            const webview = createMockWebView();
            const view = provider.createView(webview, make2dTable());
            const html: string = webview.setContent.mock.calls[0]![0];
            const token = html.match(/var token = '(dt-[a-z0-9]+)'/)![1]!;
            const listener = vi.fn();
            view.onDidChangeViewState(listener);

            webview.simulateMessage({
                command: 'setColumnView',
                _token: token,
                columns: [{ index: 0, width: 50 }],
            });

            expect(listener).toHaveBeenCalledOnce();
            expect(listener.mock.calls[0]![0]).toEqual({ name: 'TestTable', columns: [{ index: 0, width: 50 }] });
        });

        it('rejects out-of-range or invalid column indices', () => {
            const webview = createMockWebView();
            const view = provider.createView(webview, make2dTable());
            const html: string = webview.setContent.mock.calls[0]![0];
            const token = html.match(/var token = '(dt-[a-z0-9]+)'/)![1]!;

            // make2dTable has 2 columns: valid indices are 0 and 1.
            webview.simulateMessage({
                command: 'setColumnView',
                _token: token,
                columns: [
                    { index: 0, width: 100 },
                    { index: 5, width: 200 },     // out of range
                    { index: -1, width: 50 },     // negative
                    { index: 'oops', width: 80 }, // wrong type
                    { index: 1, width: 'bad' },   // invalid width — keep index, drop width
                ],
            });

            expect(view.getViewState()).toEqual({
                name: 'TestTable',
                columns: [{ index: 0, width: 100 }, { index: 1 }],
            });
        });
    });

    // ─── message handling ───────────────────────────────────────────────

    describe('message handling', () => {
        let webview: ReturnType<typeof createMockWebView>;
        let view: IDataTableView;
        let token: string;

        beforeEach(() => {
            webview = createMockWebView();
            view = provider.createView(webview, make2dTable());
            // Extract the token from the rendered content
            const html: string = webview.setContent.mock.calls[0]![0];
            const match = html.match(/var token = '(dt-[a-z0-9]+)'/);
            token = match![1]!;
        });

        it('copies text to clipboard when copyText message matches token', () => {
            webview.simulateMessage({ command: 'copyText', text: 'hello', _token: token });

            expect(clipboard.copyText).toHaveBeenCalledOnce();
            expect(clipboard.copyText).toHaveBeenCalledWith('hello');
        });

        it('does not copy to clipboard for mismatched token', () => {
            webview.simulateMessage({ command: 'copyText', text: 'hello', _token: 'wrong-token' });

            expect(clipboard.copyText).not.toHaveBeenCalled();
        });

        it('does not fire for unrelated messages', () => {
            webview.simulateMessage({ command: 'someOtherCommand', _token: token });

            expect(clipboard.copyText).not.toHaveBeenCalled();
        });

        it('does not throw when callbacks are not set', () => {
            expect(() => {
                webview.simulateMessage({ command: 'copyText', text: 'hello', _token: token });
                webview.simulateMessage({ command: 'requestExpression', _token: token });
            }).not.toThrow();
        });
    });

    // ─── selection statistics ───────────────────────────────────────────

    describe('selection statistics', () => {
        function tokenOf(webview: ReturnType<typeof createMockWebView>): string {
            const html: string = webview.setContent.mock.calls[0]![0];
            return html.match(/var token = '(dt-[a-z0-9]+)'/)![1]!;
        }

        function lastStats(webview: ReturnType<typeof createMockWebView>): string | undefined {
            const calls = webview.invoke.mock.calls.filter(c => c[0] === 'setSelectionStats');
            const last = calls[calls.length - 1];
            return last ? (last[1] as { text: string }).text : undefined;
        }

        it('publishes aggregates when a numeric selection is reported', () => {
            const webview = createMockWebView();
            provider.createView(webview, make2dTable());

            webview.simulateMessage({
                command: 'setSelection',
                _token: tokenOf(webview),
                selection: { rows: [0, 1, 2], cols: [1] },
            });

            const text = lastStats(webview)!;
            expect(text).toContain('Count: 3');
            expect(text).toContain('Sum: 60');
            expect(text).toContain('Avg: 20');
            expect(text).toContain('Min: 10');
            expect(text).toContain('Max: 30');
        });

        it('publishes count only for a non-numeric selection', () => {
            const webview = createMockWebView();
            provider.createView(webview, make2dTable());

            webview.simulateMessage({
                command: 'setSelection',
                _token: tokenOf(webview),
                selection: { rows: [0, 1], cols: [0] },
            });

            expect(lastStats(webview)).toBe('Count: 2');
        });

        it('publishes empty text when the selection is cleared', () => {
            const webview = createMockWebView();
            provider.createView(webview, make2dTable());
            const token = tokenOf(webview);

            webview.simulateMessage({ command: 'setSelection', _token: token, selection: { rows: [0], cols: [1] } });
            webview.simulateMessage({ command: 'setSelection', _token: token, selection: null });

            expect(lastStats(webview)).toBe('');
        });

        it('renders the status bar element and handler in the page', () => {
            const webview = createMockWebView();
            provider.createView(webview, make2dTable());
            const html: string = webview.setContent.mock.calls[0]![0];

            expect(html).toContain('class="selection-stats"');
            expect(html).toContain('setSelectionStats');
        });
    });

    // ─── token uniqueness ───────────────────────────────────────────────

    describe('token scoping', () => {
        it('generates unique tokens for different views', () => {
            const webview1 = createMockWebView();
            const webview2 = createMockWebView();
            provider.createView(webview1, make2dTable());
            provider.createView(webview2, make2dTable());

            const html1: string = webview1.setContent.mock.calls[0]![0];
            const html2: string = webview2.setContent.mock.calls[0]![0];

            const match1 = html1.match(/var token = '(dt-[a-z0-9]+)'/);
            const match2 = html2.match(/var token = '(dt-[a-z0-9]+)'/);

            expect(match1![1]).not.toBe(match2![1]);
        });

        it('only the matching view copies to clipboard when sharing a webview', () => {
            const webview = createMockWebView();
            provider.createView(webview, make2dTable());
            provider.createView(webview, make2dTable());

            // Extract token from first view
            const html1: string = webview.setContent.mock.calls[0]![0];
            const match1 = html1.match(/var token = '(dt-[a-z0-9]+)'/);
            const token1 = match1![1]!;

            // Send with view1's token — clipboard should be called once
            webview.simulateMessage({ command: 'copyText', text: 'test', _token: token1 });

            expect(clipboard.copyText).toHaveBeenCalledOnce();
            expect(clipboard.copyText).toHaveBeenCalledWith('test');
        });
    });

    // ─── dispose ────────────────────────────────────────────────────────

    describe('dispose', () => {
        it('unsubscribes the message handler', () => {
            const webview = createMockWebView();
            const view = provider.createView(webview, make2dTable());

            const html: string = webview.setContent.mock.calls[0]![0];
            const match = html.match(/var token = '(dt-[a-z0-9]+)'/);
            const token = match![1]!;

            view.dispose();

            webview.simulateMessage({ command: 'copyText', text: 'hello', _token: token });
            expect(clipboard.copyText).not.toHaveBeenCalled();
        });
    });

    // ─── in-page script content ─────────────────────────────────────────

    describe('in-page script', () => {
        it('includes cell selection handling', () => {
            const webview = createMockWebView();
            provider.createView(webview, make2dTable());
            const html: string = webview.setContent.mock.calls[0]![0];

            expect(html).toContain('cell-selected');
        });

        it('includes drag-drop support', () => {
            const webview = createMockWebView();
            provider.createView(webview, make2dTable());
            const html: string = webview.setContent.mock.calls[0]![0];

            expect(html).toContain('dragstart');
            expect(html).toContain('draggable');
        });

        it('does not adopt cells on contextmenu', () => {
            const webview = createMockWebView();
            provider.createView(webview, make2dTable());
            const html: string = webview.setContent.mock.calls[0]![0];

            expect(html).not.toContain("addEventListener('contextmenu'");
        });

        it('checks active class before responding to commands', () => {
            const webview = createMockWebView();
            provider.createView(webview, make2dTable());
            const html: string = webview.setContent.mock.calls[0]![0];

            expect(html).toContain("container.classList.contains('active')");
        });

        it('includes search toggle support', () => {
            const webview = createMockWebView();
            provider.createView(webview, make2dTable());
            const html: string = webview.setContent.mock.calls[0]![0];

            expect(html).toContain('toggleSearch');
            expect(html).toContain('search-visible');
        });
    });
});
