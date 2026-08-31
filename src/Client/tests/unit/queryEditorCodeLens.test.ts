// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KustoCodeLensProvider } from '../../features/queryEditor';
import type { HistoryManager } from '../../features/historyManager';
import type { IServer, QueryRangesResult } from '../../features/server';

/**
 * Query ranges are a pure function of document content, so the provider caches them per document
 * version to keep the cross-process call off the cursor-movement path.
 */

const QUERY_TEXT = 'StormEvents | take 10';

function createDocument(uri: string, version: number) {
    return {
        uri: { toString: () => uri, scheme: uri.split(':')[0] },
        version,
        getText: () => QUERY_TEXT
    } as unknown as Parameters<KustoCodeLensProvider['provideCodeLenses']>[0];
}

function createRangesResult(uri: string): QueryRangesResult {
    return {
        uri,
        ranges: [{ start: { line: 0, character: 0 }, end: { line: 0, character: QUERY_TEXT.length } }]
    };
}

describe('KustoCodeLensProvider query range caching', () => {
    let getQueryRanges: ReturnType<typeof vi.fn>;
    let provider: KustoCodeLensProvider;

    beforeEach(() => {
        getQueryRanges = vi.fn(async (uri: string) => createRangesResult(uri));
        const server = { getQueryRanges } as unknown as IServer;
        const history = { getMatchingEntry: async () => undefined } as unknown as HistoryManager;
        provider = new KustoCodeLensProvider(server, history);
    });

    it('queries the server on the first request', async () => {
        await provider.provideCodeLenses(createDocument('file:///a.kql', 1));

        expect(getQueryRanges).toHaveBeenCalledTimes(1);
        expect(getQueryRanges).toHaveBeenCalledWith('file:///a.kql');
    });

    it('does not query the server again at the same document version', async () => {
        const document = createDocument('file:///a.kql', 1);

        await provider.provideCodeLenses(document);
        await provider.provideCodeLenses(document);
        await provider.provideCodeLenses(document);

        expect(getQueryRanges).toHaveBeenCalledTimes(1);
    });

    it('returns the same lenses from the cached result', async () => {
        const document = createDocument('file:///a.kql', 1);

        const first = await provider.provideCodeLenses(document);
        const second = await provider.provideCodeLenses(document);

        expect(second.length).toBe(first.length);
        expect(first.length).toBeGreaterThan(0);
    });

    it('queries the server again when the document version changes', async () => {
        await provider.provideCodeLenses(createDocument('file:///a.kql', 1));
        await provider.provideCodeLenses(createDocument('file:///a.kql', 2));

        expect(getQueryRanges).toHaveBeenCalledTimes(2);
    });

    it('caches per document rather than globally', async () => {
        await provider.provideCodeLenses(createDocument('file:///a.kql', 1));
        await provider.provideCodeLenses(createDocument('file:///b.kql', 1));
        await provider.provideCodeLenses(createDocument('file:///a.kql', 1));
        await provider.provideCodeLenses(createDocument('file:///b.kql', 1));

        expect(getQueryRanges).toHaveBeenCalledTimes(2);
        expect(getQueryRanges.mock.calls.map(call => call[0])).toEqual(['file:///a.kql', 'file:///b.kql']);
    });

    it('distinguishes entity definition documents from files with the same path', async () => {
        await provider.provideCodeLenses(createDocument('file:///db/Table.kql', 1));
        await provider.provideCodeLenses(createDocument('kusto-entity:///db/Table.kql', 1));

        expect(getQueryRanges).toHaveBeenCalledTimes(2);
    });

    it('shares a single in-flight request between concurrent requests', async () => {
        const document = createDocument('file:///a.kql', 1);

        await Promise.all([
            provider.provideCodeLenses(document),
            provider.provideCodeLenses(document)
        ]);

        expect(getQueryRanges).toHaveBeenCalledTimes(1);
    });

    it('does not cache a failed request', async () => {
        getQueryRanges.mockRejectedValueOnce(new Error('server unavailable'));
        const document = createDocument('file:///a.kql', 1);

        await expect(provider.provideCodeLenses(document)).rejects.toThrow('server unavailable');
        await provider.provideCodeLenses(document);

        expect(getQueryRanges).toHaveBeenCalledTimes(2);
    });

    it('re-queries a document that was closed and reopened at the same version', async () => {
        const closeListener = vi.fn();
        const disposeSpy = vi.fn();
        const vscode = await import('vscode');
        const originalOnDidClose = vscode.workspace.onDidCloseTextDocument;
        let capturedListener: ((document: unknown) => void) | undefined;
        vscode.workspace.onDidCloseTextDocument = ((listener: (document: unknown) => void) => {
            capturedListener = listener;
            closeListener();
            return { dispose: disposeSpy };
        }) as typeof vscode.workspace.onDidCloseTextDocument;

        try {
            const scopedProvider = new KustoCodeLensProvider(
                { getQueryRanges } as unknown as IServer,
                { getMatchingEntry: async () => undefined } as unknown as HistoryManager
            );

            await scopedProvider.provideCodeLenses(createDocument('file:///a.kql', 1));
            expect(getQueryRanges).toHaveBeenCalledTimes(1);

            capturedListener?.({ uri: { toString: () => 'file:///a.kql' } });

            await scopedProvider.provideCodeLenses(createDocument('file:///a.kql', 1));
            expect(getQueryRanges).toHaveBeenCalledTimes(2);

            scopedProvider.dispose();
            expect(disposeSpy).toHaveBeenCalledTimes(1);
        } finally {
            vscode.workspace.onDidCloseTextDocument = originalOnDidClose;
        }
    });

    it('drops cached ranges on dispose', async () => {
        const document = createDocument('file:///a.kql', 1);

        await provider.provideCodeLenses(document);
        provider.dispose();
        await provider.provideCodeLenses(document);

        expect(getQueryRanges).toHaveBeenCalledTimes(2);
    });
});
