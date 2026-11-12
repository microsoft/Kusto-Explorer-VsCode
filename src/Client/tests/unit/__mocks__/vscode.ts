// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Minimal mock of the vscode module for unit testing.
// Add additional mocks here as needed when testing features that use the vscode API.

export const workspace = {
    onDidCloseTextDocument: () => ({ dispose: () => {} }),
    onDidChangeTextDocument: () => ({ dispose: () => {} }),
    onDidOpenTextDocument: () => ({ dispose: () => {} }),
    getConfiguration: () => ({
        get: (_key: string, defaultValue?: unknown) => defaultValue,
        has: () => false,
        inspect: () => undefined,
        update: async () => {},
    }),
    registerFileSystemProvider: () => ({ dispose: () => {} }),
    workspaceFolders: [],
};

export const window = {
    activeTextEditor: undefined as unknown,
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    createOutputChannel: () => ({
        appendLine: () => {},
        append: () => {},
        clear: () => {},
        show: () => {},
        dispose: () => {},
    }),
};

export class Position {
    constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
    readonly start: Position;
    readonly end: Position;
    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
        this.start = new Position(startLine, startCharacter);
        this.end = new Position(endLine, endCharacter);
    }
}

export class CodeLens {
    constructor(public readonly range: Range, public readonly command?: unknown) {}
}

export const DocumentDropOrPasteEditKind = {
    Text: { append: (value: string) => ({ value }) },
};

export const Uri = {
    parse: (value: string) => ({ toString: () => value, fsPath: value, scheme: 'file' }),
    file: (path: string) => ({ toString: () => path, fsPath: path, scheme: 'file' }),
};

export enum TreeItemCollapsibleState {
    None = 0,
    Collapsed = 1,
    Expanded = 2,
}

export enum FileType {
    Unknown = 0,
    File = 1,
    Directory = 2,
    SymbolicLink = 64,
}

export enum FileChangeType {
    Changed = 1,
    Created = 2,
    Deleted = 3,
}

export class EventEmitter<T = void> {
    private listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void) => {
        this.listeners.push(listener);
        return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
    };
    fire(data?: T) { for (const l of this.listeners) l(data as T); }
    dispose() { this.listeners = []; }
}

export class Disposable {
    static from(..._disposables: { dispose: () => unknown }[]) {
        return new Disposable(() => {});
    }
    constructor(private callOnDispose: () => unknown) {}
    dispose() { this.callOnDispose(); }
}
