// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * This module provides the "History" tree view in the sidebar, letting users
 * browse, open, and delete past queries. Delegates all data operations to
 * the {@link HistoryManager}.
 */

import * as vscode from 'vscode';
import { HistoryManager, HistoryEntry } from './historyManager';
import type { ResultsViewer } from './resultsViewer';

// =============================================================================
// HistoryPanel — UI layer: tree view, commands
// =============================================================================

/**
 * Provides the sidebar tree view and command handlers for query history.
 * Delegates all data operations to the {@link HistoryManager}.
 */
export class HistoryPanel {
    private readonly treeProvider: HistoryTreeProvider;
    private readonly treeView: vscode.TreeView<HistoryItem>;

    constructor(context: vscode.ExtensionContext, private readonly manager: HistoryManager, private readonly resultsViewer: ResultsViewer) {
        this.treeProvider = new HistoryTreeProvider(manager);
        this.treeView = vscode.window.createTreeView('msKustoExplorer_history', {
            treeDataProvider: this.treeProvider,
        });
        context.subscriptions.push(this.treeView);

        // Refresh the tree whenever the manager reports a data change
        manager.onDidChange(() => this.treeProvider.refresh());

        // Auto-reveal newly added entries in the tree view
        manager.onDidAddEntry((meta) => {
            this.treeProvider.refresh();
            // Skip reveal when the tree view is not visible. TreeView.reveal() forces
            // its containing view to become visible, which would yank the Kusto sidebar
            // open while the user is doing something else (running a query saves a
            // history entry as a side effect, not as a request to see history).
            if (!this.treeView.visible) {
                return;
            }
            const item = new HistoryItem(meta);
            this.treeView.reveal(item, { select: true, focus: false }).then(undefined, (err) => console.warn('Failed to reveal history item:', err));
        });

    }

    // ─── Command Handlers ───────────────────────────────────────────────

    /** Reveals and selects a history entry in the tree view. */
    revealEntry(entry: HistoryEntry): void {
        // Skip reveal when the tree view is not visible. This entry point is
        // invoked as a side effect of "Show Results" (queryEditor.ts), not as
        // an explicit "navigate to history" request, so we must not force the
        // Kusto sidebar open.
        if (!this.treeView.visible) {
            return;
        }
        const item = new HistoryItem(entry);
        this.treeView.reveal(item, { select: true, focus: false }).then(undefined, (err) => console.warn('Failed to reveal history item:', err));
    }

    /** Opens a history item in the singleton results view. */
    async openHistoryItem(item: { meta: HistoryEntry }): Promise<void> {
        const uri = this.manager.getHistoryFileUri(item.meta.fileName);
        const resultData = await this.manager.readHistoryFile(uri);
        if (!resultData) {
            vscode.window.showErrorMessage('Failed to read history entry.');
            return;
        }

        // Import dynamically to avoid circular dependency at module level
        this.resultsViewer.setSingletonViewBackingUri(uri);
        await this.resultsViewer.displayResults(resultData);
    }

    /** Deletes a history item after confirmation. */
    async deleteHistoryItem(item: { meta: HistoryEntry }): Promise<void> {
        await this.manager.deleteEntry(item.meta.fileName);
    }

    /** Clears all history after confirmation. */
    async clearHistory(): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            'Delete all query history?',
            { modal: true },
            'Delete All'
        );
        if (confirm !== 'Delete All') { return; }

        await this.manager.clearAllEntries();
    }
}

// =============================================================================
// Tree Data Provider
// =============================================================================

class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryItem> {
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    constructor(private readonly manager: HistoryManager) {}

    refresh(): void {
        this._onDidChange.fire();
    }

    getTreeItem(element: HistoryItem): vscode.TreeItem {
        return element;
    }

    getChildren(): HistoryItem[] {
        return this.manager.getEntries().map(meta => new HistoryItem(meta));
    }

    getParent(): undefined {
        return undefined;
    }
}

// =============================================================================
// Tree Items
// =============================================================================

class HistoryItem extends vscode.TreeItem {
    constructor(public readonly meta: HistoryEntry) {
        super(meta.queryPreview, vscode.TreeItemCollapsibleState.None);
        this.id = meta.fileName;

        // Format timestamp for description
        const date = new Date(meta.timestamp);
        const timeStr = date.toLocaleString(undefined, {
            month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });
        const parts: string[] = [timeStr];
        if (meta.rowCount !== undefined) {
            parts.push(`${meta.rowCount} rows`);
        }
        this.description = parts.join(' · ');

        this.tooltip = [
            meta.minifiedPreview ?? meta.queryPreview,
            `${meta.cluster ?? ''}${meta.database ? '/' + meta.database : ''}`,
            timeStr,
        ].filter(Boolean).join('\n');

        this.command = {
            command: 'msKustoExplorer.openHistoryItem',
            title: 'Open',
            arguments: [this],
        };
        this.contextValue = 'historyItem';
        this.iconPath = new vscode.ThemeIcon('history');
    }
}
