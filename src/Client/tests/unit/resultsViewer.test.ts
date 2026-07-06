// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { CompositeChartProvider } from '../../features/compositeChartProvider';
import { WebViewAdapter } from '../../features/resultsViewer';

function createMockVsCodeWebview(): vscode.Webview {
    return {
        postMessage: vi.fn(),
        onDidReceiveMessage: vi.fn(() => ({ dispose: () => { } })),
    } as unknown as vscode.Webview;
}

describe('WebViewAdapter', () => {
    it('keeps setup dependencies from all chart providers sharing the same region', () => {
        const adapter = new WebViewAdapter(createMockVsCodeWebview());

        const view = new CompositeChartProvider().createView(adapter);

        expect(adapter.headHtml).toContain('plotly');
        expect(adapter.headHtml).toContain('cytoscape');
        expect(adapter.scriptsHtml).toContain('setChartContent');
        expect(adapter.scriptsHtml).toContain('chartViewReady');

        view.dispose();
    });
});