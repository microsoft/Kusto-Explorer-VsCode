// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
* This module implements the ScratchPadManager class.
* The ScratchPadManager manages "scratch pads" — virtual documents that users can use to write and save Kusto queries.
*/

import * as vscode from 'vscode';
import { toText, type IFileStore } from './fileStore';

// =============================================================================
// Constants
// =============================================================================

/** URI scheme for scratch pad virtual documents. */
export const SCRATCH_PAD_SCHEME = 'msKustoExplorer-scratch';

/** Name of the JSON file that stores scratch pad display order. */
const ORDER_FILE = '_order.json';

// =============================================================================
// ScratchPadManager
// =============================================================================

/**
 * Manages a list of scratch pads, virtual query set documents that the user uses to write and save Kusto queries without creating a physical file. 
 * This class is used primary by the ScratchPadPanel UI component.
 */
export class ScratchPadManager {
    private readonly scratchFs: ScratchPadFileSystemProvider;
    private readonly _onDidChange = new vscode.EventEmitter<void>();

    /** Fires after any mutation (add, delete, rename, reorder) so the UI can refresh. */
    readonly onDidChange = this._onDidChange.event;

    /**
     * @param store the scratch pad directory (desktop: `<globalStorage>/scratchpads` on disk).
     */
    constructor(context: vscode.ExtensionContext, readonly store: IFileStore) {

        // Register virtual file system provider
        this.scratchFs = new ScratchPadFileSystemProvider(this);
        context.subscriptions.push(
            vscode.workspace.registerFileSystemProvider(SCRATCH_PAD_SCHEME, this.scratchFs)
        );

        // Create a default scratch pad if none exist yet
        if (this.getScratchPadFiles().length === 0) {
            const name = this.nextScratchPadFileName([]);
            if (!this.store.exists(name)) {
                this.store.write(name, '');
            }
            const order = this.readOrder();
            if (!order.includes(name)) {
                order.push(name);
                this.saveOrder(order);
            }
        }
    }

    // ─── Public API ──────────────────────────────────────────────────

    /** Resolves a virtual URI to the name of its backing file in the store. */
    fileName(uri: vscode.Uri): string {
        return uri.path.replace(/^\//, '');
    }

    /** Returns ordered list of .kql filenames in the scratchpads directory, respecting user-defined order. */
    getScratchPadFiles(): string[] {
        const filesOnDisk = this.store.list()
            .filter(f => f.endsWith('.kql'));
        if (filesOnDisk.length === 0) {
            return [];
        }
        const order = this.readOrder();
        const reconciled = this.reconcileOrder(order, filesOnDisk);
        if (reconciled.length !== order.length || reconciled.some((f, i) => f !== order[i])) {
            this.saveOrder(reconciled);
        }
        return reconciled;
    }

    /** Reads the order list from disk. Returns an empty array if the file doesn't exist or is invalid. */
    readOrder(): string[] {
        try {
            const data = toText(this.store.read(ORDER_FILE));
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
                return parsed;
            }
        } catch {
            // File missing or invalid — return empty
        }
        return [];
    }

    /** Writes the order list to disk and fires the change event. */
    saveOrder(order: string[]): void {
        this.store.write(ORDER_FILE, JSON.stringify(order, null, 2));
        this._onDidChange.fire();
    }

    /** Returns the next available ScratchPad filename that doesn't conflict with existing files. */
    nextScratchPadFileName(existing: string[]): string {
        let num = 1;
        while (existing.includes(`ScratchPad${num}.kql`)) {
            num++;
        }
        return `ScratchPad${num}.kql`;
    }

    /** Creates an empty .kql file in the scratchpads directory if it doesn't exist, and appends to order. */
    async createScratchPadFile(name: string): Promise<void> {
        if (!this.store.exists(name)) {
            await this.store.writeAsync(name, '');
        }
        const order = this.readOrder();
        if (!order.includes(name)) {
            order.push(name);
            this.saveOrder(order);
        }
    }

    /**
     * Adds a scratch pad file with the given name and content.
     * If name is null, the next available ScratchPad name is used.
     * If a file with the same name already exists, a numeric suffix is added.
     * Returns the final filename used.
     */
    async addScratchPadFile(name: string | null, content: string): Promise<string> {
        const existing = this.getScratchPadFiles();
        let finalName = name ?? this.nextScratchPadFileName(existing);
        if (!finalName.endsWith('.kql')) {
            finalName += '.kql';
        }
        if (existing.includes(finalName)) {
            const base = finalName.slice(0, -'.kql'.length);
            let num = 2;
            while (existing.includes(`${base} (${num}).kql`)) {
                num++;
            }
            finalName = `${base} (${num}).kql`;
        }
        await this.store.writeAsync(finalName, content);
        const order = this.readOrder();
        if (!order.includes(finalName)) {
            order.push(finalName);
            this.saveOrder(order);
        }
        return finalName;
    }

    /** Deletes a scratch pad's backing file and removes it from the order. */
    deleteScratchPadFile(uri: vscode.Uri, fileName: string): void {
        this.scratchFs.delete(uri);
        const order = this.readOrder();
        const idx = order.indexOf(fileName);
        if (idx !== -1) {
            order.splice(idx, 1);
            this.saveOrder(order);
        }
    }

    /** Renames a scratch pad's backing file and updates the order in-place. */
    renameScratchPadFile(oldUri: vscode.Uri, newUri: vscode.Uri, oldFileName: string, newFileName: string): void {
        this.scratchFs.rename(oldUri, newUri);
        const order = this.readOrder();
        const idx = order.indexOf(oldFileName);
        if (idx !== -1) {
            order[idx] = newFileName;
            this.saveOrder(order);
        }
    }

    /** Writes content to a scratch pad backing file via the filesystem provider. */
    writeFile(uri: vscode.Uri, content: Uint8Array): void {
        this.scratchFs.writeFile(uri, content, { create: false, overwrite: true });
    }

    // ─── Private helpers ─────────────────────────────────────────────

    private reconcileOrder(order: string[], filesOnDisk: string[]): string[] {
        const diskSet = new Set(filesOnDisk);
        const orderSet = new Set(order);

        const reconciled = order.filter(f => diskSet.has(f));

        const newFiles = filesOnDisk.filter(f => !orderSet.has(f))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        reconciled.push(...newFiles);

        return reconciled;
    }
}

// =============================================================================
// FileSystemProvider — maps msKustoExplorer-scratch:/ URIs to files in the scratch pad store
// =============================================================================

class ScratchPadFileSystemProvider implements vscode.FileSystemProvider {
    private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this._onDidChangeFile.event;

    constructor(private readonly manager: ScratchPadManager) {}

    watch(): vscode.Disposable {
        // No-op: we fire change events explicitly when we write files
        return new vscode.Disposable(() => {});
    }

    stat(uri: vscode.Uri): vscode.FileStat {
        const stat = this.manager.store.stat(this.manager.fileName(uri));
        return {
            type: vscode.FileType.File,
            ctime: stat.ctime,
            mtime: stat.mtime,
            size: stat.size,
        };
    }

    readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] {
        return this.manager.getScratchPadFiles().map(f => [f, vscode.FileType.File]);
    }

    // FileSystemProvider methods are synchronous because the VS Code
    // FileSystemProvider interface is invoked synchronously by the editor for
    // document open/save operations. While the interface accepts Thenable returns,
    // async I/O here risks interleaving with editor state. These files are small
    // scratch pads, so blocking is negligible (on the web the store serves them from memory).
    readFile(uri: vscode.Uri): Uint8Array {
        return this.manager.store.read(this.manager.fileName(uri));
    }

    writeFile(uri: vscode.Uri, content: Uint8Array, _options: { create: boolean; overwrite: boolean }): void {
        this.manager.store.write(this.manager.fileName(uri), content);
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    }

    delete(uri: vscode.Uri): void {
        this.manager.store.delete(this.manager.fileName(uri));
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    }

    rename(oldUri: vscode.Uri, newUri: vscode.Uri): void {
        this.manager.store.rename(this.manager.fileName(oldUri), this.manager.fileName(newUri));
        this._onDidChangeFile.fire([
            { type: vscode.FileChangeType.Deleted, uri: oldUri },
            { type: vscode.FileChangeType.Created, uri: newUri },
        ]);
    }

    createDirectory(_uri: vscode.Uri): void {
        // Not needed — the backing directory is created by the store
    }

    dispose(): void {
        this._onDidChangeFile.dispose();
    }
}
