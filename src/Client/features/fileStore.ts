// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * Host-independent storage for a flat directory of extension-owned files
 * (scratch pads, query history). Desktop uses NodeFileStore (synchronous fs on
 * the global storage folder); the web build uses WorkspaceFileStore, which keeps
 * a synchronous in-memory view and persists through vscode.workspace.fs.
 */

import * as vscode from 'vscode';

export interface FileStoreStat {
    ctime: number;
    mtime: number;
    size: number;
}

/** A flat directory of files addressed by file name. */
export interface IFileStore {
    /** Names of the files in the directory. */
    list(): string[];
    exists(name: string): boolean;
    stat(name: string): FileStoreStat;
    /** Reads a file synchronously. Throws if the file does not exist. */
    read(name: string): Uint8Array;
    write(name: string, data: Uint8Array | string): void;
    delete(name: string): void;
    rename(oldName: string, newName: string): void;
    readAsync(name: string): Promise<Uint8Array>;
    writeAsync(name: string, data: Uint8Array | string): Promise<void>;
    deleteAsync(name: string): Promise<void>;
    /** URI of a file in the directory, usable with vscode.workspace.fs. */
    uri(name: string): vscode.Uri;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBytes(data: Uint8Array | string): Uint8Array {
    return typeof data === 'string' ? encoder.encode(data) : data;
}

export function toText(data: Uint8Array): string {
    return decoder.decode(data);
}

/** Returns the last path segment of a URI (works for file and non-file schemes). */
export function uriFileName(uri: vscode.Uri): string {
    return pathBaseName(uri.path || uri.fsPath || '');
}

/**
 * Returns the last segment of a Windows or POSIX path, like Node's path.basename,
 * optionally removing an extension.
 */
export function pathBaseName(filePath: string, ext?: string): string {
    const name = filePath.split(/[\\/]/).pop() ?? '';
    return ext && name !== ext && name.endsWith(ext) ? name.slice(0, -ext.length) : name;
}

function fileNotFound(name: string): Error {
    return vscode.FileSystemError.FileNotFound(name);
}

interface CachedEntry {
    stat: FileStoreStat;
    /** Content, when cached. Files not selected for preloading are read on demand. */
    content?: Uint8Array;
}

/**
 * IFileStore over vscode.workspace.fs, for hosts without Node's fs (the web worker host).
 * The directory listing and the contents of preloaded files are kept in memory so the
 * synchronous API keeps working; writes update memory immediately and are persisted
 * in order in the background.
 */
export class WorkspaceFileStore implements IFileStore {
    private readonly entries = new Map<string, CachedEntry>();
    private pending: Promise<void> = Promise.resolve();

    private constructor(
        private readonly dir: vscode.Uri,
        private readonly shouldCache: (name: string) => boolean,
        private readonly onError: (error: unknown) => void,
    ) {}

    /**
     * Opens (creating if needed) a directory and loads its listing.
     * @param shouldCache selects files whose content is kept in memory and readable synchronously.
     */
    static async open(
        dir: vscode.Uri,
        shouldCache: (name: string) => boolean,
        onError: (error: unknown) => void = error => console.error('Kusto storage error:', error),
    ): Promise<WorkspaceFileStore> {
        const store = new WorkspaceFileStore(dir, shouldCache, onError);
        await vscode.workspace.fs.createDirectory(dir);
        for (const [name, type] of await vscode.workspace.fs.readDirectory(dir)) {
            if (type !== vscode.FileType.File) {
                continue;
            }
            const uri = store.uri(name);
            const s = await vscode.workspace.fs.stat(uri);
            const entry: CachedEntry = { stat: { ctime: s.ctime, mtime: s.mtime, size: s.size } };
            if (shouldCache(name)) {
                entry.content = await vscode.workspace.fs.readFile(uri);
            }
            store.entries.set(name, entry);
        }
        return store;
    }

    /** Resolves when all queued writes have been persisted. */
    flush(): Promise<void> {
        return this.pending;
    }

    uri(name: string): vscode.Uri {
        return vscode.Uri.joinPath(this.dir, name);
    }

    list(): string[] {
        return [...this.entries.keys()];
    }

    exists(name: string): boolean {
        return this.entries.has(name);
    }

    stat(name: string): FileStoreStat {
        const entry = this.entries.get(name);
        if (!entry) {
            throw fileNotFound(name);
        }
        return { ...entry.stat };
    }

    read(name: string): Uint8Array {
        const entry = this.entries.get(name);
        if (!entry) {
            throw fileNotFound(name);
        }
        if (!entry.content) {
            throw new Error(`File is not cached for synchronous reads: ${name}`);
        }
        return entry.content;
    }

    write(name: string, data: Uint8Array | string): void {
        void this.writeAsync(name, data).catch(() => { /* reported by enqueue */ });
    }

    delete(name: string): void {
        void this.deleteAsync(name).catch(() => { /* reported by enqueue */ });
    }

    rename(oldName: string, newName: string): void {
        const entry = this.entries.get(oldName);
        if (!entry) {
            throw fileNotFound(oldName);
        }
        this.entries.delete(oldName);
        this.entries.set(newName, entry);
        void this.enqueue(() => vscode.workspace.fs.rename(this.uri(oldName), this.uri(newName), { overwrite: true }))
            .catch(() => { /* reported by enqueue */ });
    }

    async readAsync(name: string): Promise<Uint8Array> {
        const entry = this.entries.get(name);
        if (!entry) {
            throw fileNotFound(name);
        }
        if (entry.content) {
            return entry.content;
        }
        await this.pending;
        return vscode.workspace.fs.readFile(this.uri(name));
    }

    writeAsync(name: string, data: Uint8Array | string): Promise<void> {
        const bytes = toBytes(data);
        const now = Date.now();
        const previous = this.entries.get(name);
        const entry: CachedEntry = { stat: { ctime: previous?.stat.ctime ?? now, mtime: now, size: bytes.byteLength } };
        if (this.shouldCache(name)) {
            entry.content = bytes;
        }
        this.entries.set(name, entry);
        return this.enqueue(() => vscode.workspace.fs.writeFile(this.uri(name), bytes));
    }

    deleteAsync(name: string): Promise<void> {
        if (!this.entries.delete(name)) {
            return Promise.reject(fileNotFound(name));
        }
        return this.enqueue(() => vscode.workspace.fs.delete(this.uri(name)));
    }

    private enqueue(operation: () => Thenable<void>): Promise<void> {
        const result = this.pending.then(() => operation());
        this.pending = result.then(undefined, error => this.onError(error));
        return result;
    }
}
