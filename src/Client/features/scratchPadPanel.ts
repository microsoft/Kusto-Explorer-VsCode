// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
* This module implements the ScratchPadPanel class.
* It is the UI for the "Scratch Pads" feature in the sidebar, which provides a list of scratch pad query sets.
*/

import * as vscode from 'vscode';
import type { ConnectionManager, DocumentConnection } from './connectionManager';
import { ScratchPadManager, SCRATCH_PAD_SCHEME } from './scratchPadManager';
import { pathBaseName } from './fileStore';

/** MIME type for scratch pad drag-and-drop within the tree view. */
const SCRATCH_PAD_DRAG_MIME = 'application/vnd.code.tree.mskustoexplorer_scratchpads';

const AUTO_SAVE_DELAY_MS = 1000;

/** Builds a virtual URI for a scratch pad file: msKustoExplorer-scratch:/ScratchPad1.kql */
function scratchUri(fileName: string): vscode.Uri {
    return vscode.Uri.from({ scheme: SCRATCH_PAD_SCHEME, path: '/' + fileName });
}

// =============================================================================
// ScratchPadPanel — UI layer: tree view, commands, auto-save, placeholder
// =============================================================================

/**
 * Provides the sidebar tree view, command handlers, auto-save and placeholder
 * decorations for scratch pad documents. Delegates all data operations to
 * the {@link ScratchPadManager}.
 */
export class ScratchPadPanel {
    private readonly treeProvider: ScratchPadTreeProvider;
    private readonly treeView: vscode.TreeView<ScratchPadItem>;
    private readonly autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly placeholderDecoration: vscode.TextEditorDecorationType;

    constructor(context: vscode.ExtensionContext, private readonly manager: ScratchPadManager, private readonly connections: ConnectionManager) {
        this.placeholderDecoration = vscode.window.createTextEditorDecorationType({
            after: {
                contentText: 'Write a KQL query here, then press F5 to run it.',
                color: new vscode.ThemeColor('editorGhostText.foreground'),
                fontStyle: 'italic',
            },
            isWholeLine: true,
        });

        // Register tree data provider with drag and drop support
        this.treeProvider = new ScratchPadTreeProvider(manager);
        this.treeView = vscode.window.createTreeView('msKustoExplorer_scratchPads', {
            treeDataProvider: this.treeProvider,
            dragAndDropController: new ScratchPadDragAndDropController(manager),
        });
        context.subscriptions.push(this.treeView);

        // Refresh the tree whenever the manager reports a data change
        manager.onDidChange(() => this.treeProvider.refresh());

        // Auto-open a scratch pad when the sidebar becomes visible and no Kusto doc is active
        this.treeView.onDidChangeVisibility(async (e) => {
            if (e.visible && !this.hasActiveKustoDocument()) {
                await this.openOrCreateDefaultScratchPad();
            }
        });

        // Auto-save scratch pad documents after a pause in editing
        context.subscriptions.push(
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.scheme === SCRATCH_PAD_SCHEME) {
                    this.scheduleAutoSave(e.document);
                }
            })
        );

        // Show/hide placeholder hint when scratch pad content or active editor changes
        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor((editor) => this.updatePlaceholder(editor)),
            vscode.workspace.onDidChangeTextDocument((e) => {
                const editor = vscode.window.activeTextEditor;
                if (editor && e.document === editor.document) {
                    this.updatePlaceholder(editor);
                }
            }),
            this.placeholderDecoration,
        );
    }

    // ─── Private helpers ─────────────────────────────────────────────

    private hasActiveKustoDocument(): boolean {
        // Check if the active editor is a Kusto document
        if (vscode.window.activeTextEditor?.document.languageId === 'kusto') {
            return true;
        }
        // Check if any visible editor is a Kusto document (e.g. during startup restore)
        if (vscode.window.visibleTextEditors.some(e => e.document.languageId === 'kusto')) {
            return true;
        }
        // Check if any open tab has a .kql file or scratch pad (tabs restore before editors)
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                const input = tab.input;
                if (input instanceof vscode.TabInputText) {
                    const uri = input.uri;
                    if (uri.scheme === SCRATCH_PAD_SCHEME || uri.path.endsWith('.kql') || uri.path.endsWith('.csl')) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    private updatePlaceholder(editor: vscode.TextEditor | undefined): void {
        if (!editor) {
            return;
        }
        if (editor.document.uri.scheme === SCRATCH_PAD_SCHEME && editor.document.getText().length === 0) {
            const range = new vscode.Range(0, 0, 0, 0);
            editor.setDecorations(this.placeholderDecoration, [{ range }]);
        } else {
            editor.setDecorations(this.placeholderDecoration, []);
        }
    }

    private scheduleAutoSave(document: vscode.TextDocument): void {
        const key = document.uri.toString();
        const existing = this.autoSaveTimers.get(key);
        if (existing) {
            clearTimeout(existing);
        }
        this.autoSaveTimers.set(key, setTimeout(async () => {
            this.autoSaveTimers.delete(key);
            if (!document.isClosed && document.isDirty) {
                await document.save();
            }
        }, AUTO_SAVE_DELAY_MS));
    }

    // ─── Command Handlers ────────────────────────────────────────────

    private async resolveConnectionToInherit(): Promise<DocumentConnection | undefined> {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.languageId === 'kusto') {
            const conn = await this.connections.getDocumentConnection(activeEditor.document.uri.toString());
            if (conn?.cluster) {
                return conn;
            }
        }

        const files = this.manager.getScratchPadFiles();
        for (const file of files) {
            const uri = scratchUri(file).toString();
            const conn = await this.connections.getDocumentConnection(uri);
            if (conn?.cluster) {
                return conn;
            }
        }

        return undefined;
    }

    private async openScratchPadByName(fileName: string): Promise<void> {
        const uri = scratchUri(fileName);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);
        this.updatePlaceholder(editor);
    }

    private async openOrCreateDefaultScratchPad(): Promise<void> {
        const files = this.manager.getScratchPadFiles();
        let name: string;
        if (files.length > 0) {
            name = files[0]!;
        } else {
            name = this.manager.nextScratchPadFileName([]);
            await this.manager.createScratchPadFile(name);
        }
        await this.openScratchPadByName(name);
    }

    async createScratchPad(): Promise<void> {
        const existing = this.manager.getScratchPadFiles();
        const name = this.manager.nextScratchPadFileName(existing);

        const inheritedConnection = await this.resolveConnectionToInherit();

        await this.manager.createScratchPadFile(name);
        await this.openScratchPadByName(name);

        if (inheritedConnection?.cluster) {
            const newUri = scratchUri(name).toString();
            await this.connections.setDocumentConnection(newUri, inheritedConnection.cluster, inheritedConnection.database);
        }
    }

    async openScratchPad(item: { fileName: string }): Promise<void> {
        await this.openScratchPadByName(item.fileName);
    }

    async deleteScratchPad(item: { fileName: string }): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `Delete query "${pathBaseName(item.fileName, '.kql')}"?`,
            { modal: true },
            'Delete'
        );
        if (confirm !== 'Delete') {
            return;
        }

        const uri = scratchUri(item.fileName);
        for (const tabGroup of vscode.window.tabGroups.all) {
            for (const tab of tabGroup.tabs) {
                if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()) {
                    await vscode.window.tabGroups.close(tab);
                }
            }
        }

        this.manager.deleteScratchPadFile(uri, item.fileName);
    }

    async renameScratchPad(item: { fileName: string }): Promise<void> {
        const currentName = pathBaseName(item.fileName, '.kql');
        const newName = await vscode.window.showInputBox({
            prompt: 'Enter new name for the query document',
            value: currentName,
            validateInput: (value) => {
                if (!value.trim()) {
                    return 'Name cannot be empty';
                }
                const newFileName = value.trim() + '.kql';
                if (newFileName !== item.fileName && this.manager.getScratchPadFiles().includes(newFileName)) {
                    return 'A query document with that name already exists';
                }
                return undefined;
            },
        });
        if (!newName || newName.trim() + '.kql' === item.fileName) {
            return;
        }

        const newFileName = newName.trim() + '.kql';
        const oldUri = scratchUri(item.fileName);
        const newUri = scratchUri(newFileName);

        const openDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === oldUri.toString());
        if (openDoc?.isDirty) {
            await openDoc.save();
        }

        let viewColumn: vscode.ViewColumn | undefined;
        for (const tabGroup of vscode.window.tabGroups.all) {
            for (const tab of tabGroup.tabs) {
                if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === oldUri.toString()) {
                    viewColumn = tabGroup.viewColumn;
                    await vscode.window.tabGroups.close(tab);
                }
            }
        }

        this.manager.renameScratchPadFile(oldUri, newUri, item.fileName, newFileName);

        if (viewColumn !== undefined) {
            await this.openScratchPadByName(newFileName);
        }
    }

    async saveScratchPadAs(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== SCRATCH_PAD_SCHEME) {
            return;
        }

        const scratchDocument = editor.document;
        const scratchUriValue = scratchDocument.uri;
        const viewColumn = editor.viewColumn;

        const defaultName = pathBaseName(scratchUriValue.path);
        const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(defaultName),
            filters: { 'Kusto Query': ['kql', 'csl', 'kusto'] },
        });
        if (!target) {
            return;
        }

        const scratchConnection = await this.connections.getDocumentConnection(scratchUriValue.toString());

        const content = new TextEncoder().encode(scratchDocument.getText());
        await vscode.workspace.fs.writeFile(target, content);

        if (scratchConnection?.cluster) {
            await this.connections.setDocumentConnection(target.toString(), scratchConnection.cluster, scratchConnection.database);
        }

        const action = await vscode.window.showInformationMessage(
            `What would you like to do with the original query set "${pathBaseName(scratchUriValue.path, '.kql')}"?`,
            { modal: true },
            'Keep',
            'Keep and Clear',
            'Remove',
        );
        if (!action) {
            const newDoc = await vscode.workspace.openTextDocument(target);
            await vscode.window.showTextDocument(newDoc, viewColumn);
            return;
        }

        if (action === 'Remove') {
            for (const tabGroup of vscode.window.tabGroups.all) {
                for (const tab of tabGroup.tabs) {
                    if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === scratchUriValue.toString()) {
                        await vscode.window.tabGroups.close(tab);
                    }
                }
            }
            const fileName = pathBaseName(scratchUriValue.path.replace(/^\//, ''));
            this.manager.deleteScratchPadFile(scratchUriValue, fileName);
        } else if (action === 'Keep and Clear') {
            this.manager.writeFile(scratchUriValue, new Uint8Array());
        }

        const newDoc = await vscode.workspace.openTextDocument(target);
        await vscode.window.showTextDocument(newDoc, viewColumn);
    }
}

// =============================================================================
// Tree Data Provider
// =============================================================================

class ScratchPadTreeProvider implements vscode.TreeDataProvider<ScratchPadItem> {
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    constructor(private readonly manager: ScratchPadManager) {}

    refresh(): void {
        this._onDidChange.fire();
    }

    getTreeItem(element: ScratchPadItem): vscode.TreeItem {
        return element;
    }

    getChildren(): ScratchPadItem[] {
        return this.manager.getScratchPadFiles().map(f => new ScratchPadItem(f));
    }
}

// =============================================================================
// Drag and Drop Controller
// =============================================================================

class ScratchPadDragAndDropController implements vscode.TreeDragAndDropController<ScratchPadItem> {
    readonly dropMimeTypes = [SCRATCH_PAD_DRAG_MIME];
    readonly dragMimeTypes = [SCRATCH_PAD_DRAG_MIME];

    constructor(private readonly manager: ScratchPadManager) {}

    handleDrag(source: readonly ScratchPadItem[], dataTransfer: vscode.DataTransfer): void {
        if (source.length === 1) {
            dataTransfer.set(SCRATCH_PAD_DRAG_MIME, new vscode.DataTransferItem(source[0]!.fileName));
        }
    }

    async handleDrop(target: ScratchPadItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
        const transferItem = dataTransfer.get(SCRATCH_PAD_DRAG_MIME);
        if (!transferItem || !target) {
            return;
        }

        const draggedFileName = transferItem.value as string;
        if (draggedFileName === target.fileName) {
            return;
        }

        const order = this.manager.readOrder();
        const fromIndex = order.indexOf(draggedFileName);
        const toIndex = order.indexOf(target.fileName);
        if (fromIndex === -1 || toIndex === -1) {
            return;
        }

        // Remove from old position and insert at new position
        order.splice(fromIndex, 1);
        order.splice(toIndex, 0, draggedFileName);
        this.manager.saveOrder(order);
    }
}

// =============================================================================
// Tree Items
// =============================================================================

class ScratchPadItem extends vscode.TreeItem {
    constructor(public readonly fileName: string) {
        super(pathBaseName(fileName, '.kql'), vscode.TreeItemCollapsibleState.None);
        this.command = {
            command: 'msKustoExplorer.openScratchPad',
            title: 'Open',
            arguments: [this]
        };
        this.contextValue = 'scratchPad';
        this.iconPath = new vscode.ThemeIcon('file');
        this.resourceUri = scratchUri(fileName);
    }
}
