// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * Desktop IFileStore over Node's fs. Desktop only: the web build must not import this module.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { FileStoreStat, IFileStore } from './fileStore';

/** IFileStore backed by a directory on the local disk. Creates the directory on construction. */
export class NodeFileStore implements IFileStore {
    constructor(readonly dirPath: string) {
        fs.mkdirSync(dirPath, { recursive: true });
    }

    private filePath(name: string): string {
        return path.join(this.dirPath, name);
    }

    uri(name: string): vscode.Uri {
        return vscode.Uri.file(this.filePath(name));
    }

    list(): string[] {
        return fs.existsSync(this.dirPath) ? fs.readdirSync(this.dirPath) : [];
    }

    exists(name: string): boolean {
        return fs.existsSync(this.filePath(name));
    }

    stat(name: string): FileStoreStat {
        const s = fs.statSync(this.filePath(name));
        return { ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
    }

    read(name: string): Uint8Array {
        return fs.readFileSync(this.filePath(name));
    }

    write(name: string, data: Uint8Array | string): void {
        fs.writeFileSync(this.filePath(name), data);
    }

    delete(name: string): void {
        fs.unlinkSync(this.filePath(name));
    }

    rename(oldName: string, newName: string): void {
        fs.renameSync(this.filePath(oldName), this.filePath(newName));
    }

    readAsync(name: string): Promise<Uint8Array> {
        return fs.promises.readFile(this.filePath(name));
    }

    writeAsync(name: string, data: Uint8Array | string): Promise<void> {
        return fs.promises.writeFile(this.filePath(name), data);
    }

    deleteAsync(name: string): Promise<void> {
        return fs.promises.unlink(this.filePath(name));
    }
}
