// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ScratchPadManager } from '../../features/scratchPadManager';
import { NodeFileStore } from '../../features/nodeFileStore';
import type * as vscode from 'vscode';

/** Creates a minimal mock ExtensionContext pointing at a temp directory. */
function createMockContext(storageDir: string): vscode.ExtensionContext {
    return {
        globalStorageUri: { fsPath: storageDir },
        subscriptions: [],
    } as unknown as vscode.ExtensionContext;
}

/** Builds a vscode.Uri-like object for a scratch pad filename. */
function scratchUri(fileName: string): vscode.Uri {
    return { path: `/${fileName}`, toString: () => `msKustoExplorer-scratch:/${fileName}` } as unknown as vscode.Uri;
}

describe('ScratchPadManager', () => {
    let tmpDir: string;
    let scratchpadDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scratchpad-test-'));
        scratchpadDir = path.join(tmpDir, 'scratchpads');
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function createManager(): ScratchPadManager {
        return new ScratchPadManager(createMockContext(tmpDir), new NodeFileStore(scratchpadDir));
    }

    describe('constructor', () => {
        it('creates the scratchpads directory', () => {
            createManager();
            expect(fs.existsSync(scratchpadDir)).toBe(true);
        });

        it('creates a default ScratchPad1.kql when no files exist', () => {
            createManager();
            expect(fs.existsSync(path.join(scratchpadDir, 'ScratchPad1.kql'))).toBe(true);
        });

        it('does not create a default file when scratch pads already exist', () => {
            fs.mkdirSync(scratchpadDir, { recursive: true });
            fs.writeFileSync(path.join(scratchpadDir, 'Existing.kql'), 'test', 'utf-8');

            createManager();

            expect(fs.existsSync(path.join(scratchpadDir, 'ScratchPad1.kql'))).toBe(false);
        });
    });

    describe('nextScratchPadFileName', () => {
        it('returns ScratchPad1.kql when no existing files', () => {
            const mgr = createManager();
            expect(mgr.nextScratchPadFileName([])).toBe('ScratchPad1.kql');
        });

        it('skips existing names', () => {
            const mgr = createManager();
            expect(mgr.nextScratchPadFileName(['ScratchPad1.kql'])).toBe('ScratchPad2.kql');
        });

        it('finds gaps', () => {
            const mgr = createManager();
            expect(mgr.nextScratchPadFileName(['ScratchPad1.kql', 'ScratchPad3.kql'])).toBe('ScratchPad2.kql');
        });
    });

    describe('getScratchPadFiles', () => {
        it('returns only .kql files', () => {
            const mgr = createManager();
            // Constructor already created ScratchPad1.kql
            fs.writeFileSync(path.join(scratchpadDir, 'notes.txt'), 'not a kql file', 'utf-8');

            const files = mgr.getScratchPadFiles();
            expect(files.every(f => f.endsWith('.kql'))).toBe(true);
            expect(files).not.toContain('notes.txt');
        });

        it('respects saved order', () => {
            const mgr = createManager();
            fs.writeFileSync(path.join(scratchpadDir, 'B.kql'), '', 'utf-8');
            fs.writeFileSync(path.join(scratchpadDir, 'A.kql'), '', 'utf-8');
            mgr.saveOrder(['A.kql', 'B.kql', 'ScratchPad1.kql']);

            const files = mgr.getScratchPadFiles();
            expect(files).toEqual(['A.kql', 'B.kql', 'ScratchPad1.kql']);
        });

        it('appends files not in order list', () => {
            const mgr = createManager();
            // ScratchPad1.kql exists from constructor with its order
            fs.writeFileSync(path.join(scratchpadDir, 'New.kql'), '', 'utf-8');

            const files = mgr.getScratchPadFiles();
            expect(files).toContain('New.kql');
        });

        it('removes ordered files that no longer exist on disk', () => {
            const mgr = createManager();
            mgr.saveOrder(['ScratchPad1.kql', 'Deleted.kql']);

            const files = mgr.getScratchPadFiles();
            expect(files).toContain('ScratchPad1.kql');
            expect(files).not.toContain('Deleted.kql');
        });
    });

    describe('readOrder / saveOrder', () => {
        it('returns empty array when no order file exists', () => {
            fs.mkdirSync(scratchpadDir, { recursive: true });
            fs.writeFileSync(path.join(scratchpadDir, 'X.kql'), '', 'utf-8');
            const mgr = createManager();
            // Remove the order file created by constructor
            const orderPath = path.join(scratchpadDir, '_order.json');
            if (fs.existsSync(orderPath)) {
                fs.unlinkSync(orderPath);
            }
            expect(mgr.readOrder()).toEqual([]);
        });

        it('returns empty array for corrupted order file', () => {
            const mgr = createManager();
            fs.writeFileSync(path.join(scratchpadDir, '_order.json'), 'not json', 'utf-8');
            expect(mgr.readOrder()).toEqual([]);
        });

        it('persists order to disk', () => {
            const mgr = createManager();
            mgr.saveOrder(['A.kql', 'B.kql']);

            const raw = fs.readFileSync(path.join(scratchpadDir, '_order.json'), 'utf-8');
            expect(JSON.parse(raw)).toEqual(['A.kql', 'B.kql']);
        });

        it('reorders items correctly when dragging an item to a new position', () => {
            const mgr = createManager();
            fs.writeFileSync(path.join(scratchpadDir, 'A.kql'), '', 'utf-8');
            fs.writeFileSync(path.join(scratchpadDir, 'B.kql'), '', 'utf-8');
            fs.writeFileSync(path.join(scratchpadDir, 'C.kql'), '', 'utf-8');
            mgr.saveOrder(['A.kql', 'B.kql', 'C.kql', 'ScratchPad1.kql']);

            // Simulate dragging C.kql to before A.kql (same logic as handleDrop)
            const order = mgr.readOrder();
            const fromIndex = order.indexOf('C.kql');
            const toIndex = order.indexOf('A.kql');
            order.splice(fromIndex, 1);
            order.splice(toIndex, 0, 'C.kql');
            mgr.saveOrder(order);

            expect(mgr.getScratchPadFiles()).toEqual(['C.kql', 'A.kql', 'B.kql', 'ScratchPad1.kql']);
        });
    });

    describe('createScratchPadFile', () => {
        it('creates a new empty file and adds to order', async () => {
            const mgr = createManager();
            await mgr.createScratchPadFile('NewPad.kql');

            expect(fs.existsSync(path.join(scratchpadDir, 'NewPad.kql'))).toBe(true);
            expect(fs.readFileSync(path.join(scratchpadDir, 'NewPad.kql'), 'utf-8')).toBe('');
            expect(mgr.readOrder()).toContain('NewPad.kql');
        });

        it('does not overwrite existing file content', async () => {
            const mgr = createManager();
            fs.writeFileSync(path.join(scratchpadDir, 'Existing.kql'), 'keep me', 'utf-8');

            await mgr.createScratchPadFile('Existing.kql');

            expect(fs.readFileSync(path.join(scratchpadDir, 'Existing.kql'), 'utf-8')).toBe('keep me');
        });

        it('does not duplicate name in order', async () => {
            const mgr = createManager();
            await mgr.createScratchPadFile('Pad.kql');
            await mgr.createScratchPadFile('Pad.kql');

            const order = mgr.readOrder();
            expect(order.filter(n => n === 'Pad.kql')).toHaveLength(1);
        });
    });

    describe('addScratchPadFile', () => {
        it('adds file with given name and content', async () => {
            const mgr = createManager();
            const name = await mgr.addScratchPadFile('Query.kql', 'StormEvents | take 10');

            expect(name).toBe('Query.kql');
            expect(fs.readFileSync(path.join(scratchpadDir, 'Query.kql'), 'utf-8')).toBe('StormEvents | take 10');
            expect(mgr.readOrder()).toContain('Query.kql');
        });

        it('appends .kql extension if missing', async () => {
            const mgr = createManager();
            const name = await mgr.addScratchPadFile('MyQuery', 'content');
            expect(name).toBe('MyQuery.kql');
        });

        it('auto-generates name when null', async () => {
            const mgr = createManager();
            // ScratchPad1.kql already exists from constructor
            const name = await mgr.addScratchPadFile(null, 'content');
            expect(name).toBe('ScratchPad2.kql');
        });

        it('adds numeric suffix when name conflicts', async () => {
            const mgr = createManager();
            await mgr.addScratchPadFile('Dup.kql', 'first');
            const name = await mgr.addScratchPadFile('Dup.kql', 'second');

            expect(name).toBe('Dup (2).kql');
            expect(fs.readFileSync(path.join(scratchpadDir, 'Dup.kql'), 'utf-8')).toBe('first');
            expect(fs.readFileSync(path.join(scratchpadDir, 'Dup (2).kql'), 'utf-8')).toBe('second');
        });

        it('increments suffix when multiple conflicts', async () => {
            const mgr = createManager();
            await mgr.addScratchPadFile('Dup.kql', '1');
            await mgr.addScratchPadFile('Dup.kql', '2');
            const name = await mgr.addScratchPadFile('Dup.kql', '3');
            expect(name).toBe('Dup (3).kql');
        });
    });

    describe('deleteScratchPadFile', () => {
        it('removes file from disk and order', async () => {
            const mgr = createManager();
            await mgr.createScratchPadFile('ToDelete.kql');
            expect(fs.existsSync(path.join(scratchpadDir, 'ToDelete.kql'))).toBe(true);

            mgr.deleteScratchPadFile(scratchUri('ToDelete.kql'), 'ToDelete.kql');

            expect(fs.existsSync(path.join(scratchpadDir, 'ToDelete.kql'))).toBe(false);
            expect(mgr.readOrder()).not.toContain('ToDelete.kql');
        });
    });

    describe('renameScratchPadFile', () => {
        it('renames file on disk and updates order', async () => {
            const mgr = createManager();
            await mgr.createScratchPadFile('OldName.kql');
            fs.writeFileSync(path.join(scratchpadDir, 'OldName.kql'), 'content', 'utf-8');

            mgr.renameScratchPadFile(
                scratchUri('OldName.kql'),
                scratchUri('NewName.kql'),
                'OldName.kql',
                'NewName.kql',
            );

            expect(fs.existsSync(path.join(scratchpadDir, 'OldName.kql'))).toBe(false);
            expect(fs.existsSync(path.join(scratchpadDir, 'NewName.kql'))).toBe(true);
            expect(fs.readFileSync(path.join(scratchpadDir, 'NewName.kql'), 'utf-8')).toBe('content');

            const order = mgr.readOrder();
            expect(order).toContain('NewName.kql');
            expect(order).not.toContain('OldName.kql');
        });
    });

    describe('writeFile', () => {
        it('writes content to the backing file', () => {
            const mgr = createManager();
            const content = new TextEncoder().encode('new content');

            mgr.writeFile(scratchUri('ScratchPad1.kql'), content);

            expect(fs.readFileSync(path.join(scratchpadDir, 'ScratchPad1.kql'), 'utf-8')).toBe('new content');
        });
    });

    describe('fileName', () => {
        it('resolves URI to the backing file name in the store', () => {
            const mgr = createManager();
            expect(mgr.fileName(scratchUri('Test.kql'))).toBe('Test.kql');
        });
    });

    describe('onDidChange event', () => {
        it('fires when saveOrder is called', () => {
            const mgr = createManager();
            let fired = 0;
            mgr.onDidChange(() => fired++);

            mgr.saveOrder(['A.kql']);
            expect(fired).toBe(1);
        });

        it('fires when a scratch pad is created', async () => {
            const mgr = createManager();
            let fired = 0;
            mgr.onDidChange(() => fired++);

            await mgr.createScratchPadFile('New.kql');
            expect(fired).toBeGreaterThanOrEqual(1);
        });

        it('fires when a scratch pad is added', async () => {
            const mgr = createManager();
            let fired = 0;
            mgr.onDidChange(() => fired++);

            await mgr.addScratchPadFile('Added.kql', 'content');
            expect(fired).toBeGreaterThanOrEqual(1);
        });

        it('fires when a scratch pad is deleted', async () => {
            const mgr = createManager();
            await mgr.createScratchPadFile('Del.kql');

            let fired = 0;
            mgr.onDidChange(() => fired++);

            mgr.deleteScratchPadFile(scratchUri('Del.kql'), 'Del.kql');
            expect(fired).toBeGreaterThanOrEqual(1);
        });

        it('fires when a scratch pad is renamed', async () => {
            const mgr = createManager();
            await mgr.createScratchPadFile('Old.kql');

            let fired = 0;
            mgr.onDidChange(() => fired++);

            mgr.renameScratchPadFile(scratchUri('Old.kql'), scratchUri('New.kql'), 'Old.kql', 'New.kql');
            expect(fired).toBeGreaterThanOrEqual(1);
        });
    });
});
