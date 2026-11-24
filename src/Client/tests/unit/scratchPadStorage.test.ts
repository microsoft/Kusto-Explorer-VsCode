// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { WorkspaceFileStore, toText } from '../../features/fileStore';
import { ScratchPadManager } from '../../features/scratchPadManager';

type MockUri = vscode.Uri & { path: string };
const uri = (path: string) => ({ path }) as MockUri;

describe('scratch pad storage', () => {
    let files: Map<string, Uint8Array>;
    let provider: vscode.FileSystemProvider;

    beforeEach(() => {
        files = new Map();
        Object.assign(vscode.Uri, { joinPath: (dir: MockUri, name: string) => uri(`${dir.path}/${name}`) });
        Object.assign(vscode.workspace, {
            fs: {
                createDirectory: async () => {},
                readDirectory: async () => [...files.keys()].map(name => [name, vscode.FileType.File]),
                stat: async (file: MockUri) => {
                    const content = files.get(file.path.split('/').pop()!);
                    if (!content) throw new Error('not found');
                    return { ctime: 1, mtime: 2, size: content.length };
                },
                readFile: async (file: MockUri) => {
                    const content = files.get(file.path.split('/').pop()!);
                    if (!content) throw new Error('not found');
                    return content;
                },
                writeFile: async (file: MockUri, content: Uint8Array) => {
                    files.set(file.path.split('/').pop()!, content);
                },
                delete: async (file: MockUri) => { files.delete(file.path.split('/').pop()!); },
            },
        });
        vi.spyOn(vscode.workspace, 'registerFileSystemProvider').mockImplementation((_scheme, p) => {
            provider = p;
            return { dispose() {} };
        });
    });

    async function openStore(): Promise<WorkspaceFileStore> {
        return WorkspaceFileStore.open(uri('/scratch'), () => true);
    }

    it('refreshes another window’s additions, removals and metadata', async () => {
        const first = await openStore();
        const second = await openStore();
        await second.writeAsync('ScratchPad1.kql', 'query');
        await first.refresh();
        expect(first.exists('ScratchPad1.kql')).toBe(true);
        expect(toText(first.read('ScratchPad1.kql'))).toBe('query');
        const manager = new ScratchPadManager({ subscriptions: [] } as unknown as vscode.ExtensionContext, first);
        expect(manager.nextScratchPadFileName(manager.getScratchPadFiles())).toBe('ScratchPad2.kql');
        await second.writeAsync('ScratchPad1.kql', 'longer query');
        await first.refresh();
        expect(first.stat('ScratchPad1.kql').size).toBe(12);
        expect(toText(first.read('ScratchPad1.kql'))).toBe('longer query');
        await second.deleteAsync('ScratchPad1.kql');
        await first.refresh();
        expect(first.exists('ScratchPad1.kql')).toBe(false);
    });

    it('refreshes before choosing a name for an imported pad', async () => {
        const first = await openStore();
        const manager = new ScratchPadManager({ subscriptions: [] } as unknown as vscode.ExtensionContext, first);
        await first.flush();
        const second = await openStore();
        await second.writeAsync('ScratchPad2.kql', 'other window');
        expect(await manager.addScratchPadFile(null, 'imported')).toBe('ScratchPad3.kql');
        expect(toText(files.get('ScratchPad2.kql')!)).toBe('other window');
    });

    it('waits for queued writes before refreshing', async () => {
        const store = await openStore();
        const readDirectory = vi.spyOn(vscode.workspace.fs, 'readDirectory');
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const originalWrite = vscode.workspace.fs.writeFile;
        vi.spyOn(vscode.workspace.fs, 'writeFile').mockImplementation(async (file, content) => {
            await gate;
            await originalWrite(file, content);
        });
        const write = store.writeAsync('queued.kql', 'queued');
        const refresh = store.refresh();
        try {
            await Promise.resolve();
            await Promise.resolve();
            expect(readDirectory).not.toHaveBeenCalled();
            release();
            await Promise.all([write, refresh]);
        } finally {
            release();
            await Promise.allSettled([write, refresh]);
        }
        expect(store.exists('queued.kql')).toBe(true);
        expect(toText(store.read('queued.kql'))).toBe('queued');
    });

    it('propagates save failures without firing a changed event', async () => {
        const store = await openStore();
        new ScratchPadManager({ subscriptions: [] } as unknown as vscode.ExtensionContext, store);
        await store.flush();
        const failure = new Error('storage failed');
        vi.spyOn(vscode.workspace.fs, 'writeFile').mockRejectedValue(failure);
        const events: vscode.FileChangeEvent[][] = [];
        provider.onDidChangeFile(e => events.push(e));
        await expect(provider.writeFile(uri('/ScratchPad1.kql'), new Uint8Array([1]), { create: false, overwrite: true }))
            .rejects.toThrow('storage failed');
        expect(events).toEqual([]);
    });

    it('fires the save event only after the backing write finishes', async () => {
        const store = await openStore();
        const manager = new ScratchPadManager({ subscriptions: [] } as unknown as vscode.ExtensionContext, store);
        await store.flush();
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const originalWrite = vscode.workspace.fs.writeFile;
        vi.spyOn(vscode.workspace.fs, 'writeFile').mockImplementation(async (file, content) => {
            await gate;
            await originalWrite(file, content);
        });
        const events: vscode.FileChangeEvent[][] = [];
        provider.onDidChangeFile(e => events.push(e));
        const save = manager.writeFile(uri('/ScratchPad1.kql'), new Uint8Array([1]));
        try {
            await Promise.resolve();
            expect(events).toEqual([]);
        } finally {
            release();
            await Promise.allSettled([save]);
        }
        await save;
        expect(events).toHaveLength(1);
        expect(files.get('ScratchPad1.kql')).toEqual(new Uint8Array([1]));
    });
});
