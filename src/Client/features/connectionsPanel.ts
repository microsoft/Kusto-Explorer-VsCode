// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * This module implements the "Connections" tree view in the sidebar.
 * It displays configured Kusto clusters, databases, and schema entities (tables, functions, etc.),
 * and provides commands for adding, removing, editing, and browsing connections.
 * On first activation with no connections, it prompts the user to import from Kusto Explorer.
 */

import * as vscode from 'vscode';
import type { IServer } from './server';
import type { IClipboard } from './clipboard';
import { type ConnectionManager, isServerGroup, getDisplayName } from './connectionManager';
import type { ServerInfo, ServerGroupInfo } from './connectionManager';
import type { DatabaseTableInfo, DatabaseColumnInfo, DatabaseFunctionInfo, DatabaseEntityGroupInfo, DatabaseGraphModelInfo } from './server';
import { ENTITY_DEFINITION_SCHEME } from './entityDefinitionProvider';
import { Importer } from './importer';


// =============================================================================
// ConnectionsPanel Class
// =============================================================================

/**
 * Implements the "Connections" tree view in the sidebar.
 * Displays configured Kusto clusters, databases, and schema entities,
 * and provides commands for managing connections.
 */
export class ConnectionsPanel {
    private readonly connectionsProvider: KustoConnectionsProvider;
    private readonly treeView: vscode.TreeView<KustoTreeItem>;
    private programmaticSelectionCount = 0;
    private isTreeSelectionChangingConnection = false;
    private isFetchingDatabasesForTreeUpdate = false;
    private isDragging = false;
    private lastValidSelection: KustoTreeItem | undefined;

    constructor(
        context: vscode.ExtensionContext,
        private readonly server: IServer,
        private readonly clipboard: IClipboard,
        importer: Importer,
        private readonly connections: ConnectionManager
    ) {
        this.connectionsProvider = new KustoConnectionsProvider(connections);
    
    // Register for connection change events
    context.subscriptions.push(connections.registerOnDocumentConnectionChanged(async (uri: string) => {
        // Skip if the connection change was initiated from tree selection
        // (tree already shows the correct selection in that case)
        if (this.isTreeSelectionChangingConnection) {
            return;
        }
        if (vscode.window.activeTextEditor?.document.uri.toString() === uri) {
            await this.updateTreeSelectionForActiveDocument();
        }
    }));
    context.subscriptions.push(connections.registerOnServersAndGroupsChanged(async () => {
        this.connectionsProvider.refresh();
        // After refresh, restore the tree selection based on the current document's connection.
        // The 100ms delay is a workaround because the VS Code TreeView API does not provide
        // a callback or event for when the tree has finished rebuilding after a refresh.
        // Skip if we're already updating the tree (to prevent infinite loop from fetchDatabasesForCluster)
        if (!this.isFetchingDatabasesForTreeUpdate) {
            setTimeout(async () => {
                await this.updateTreeSelectionForActiveDocument();
            }, 100);
        }
    }));
    
    // Load servers and groups from global state first
    // This must happen before tree view creation so initial getChildren() has data
    connections.loadServersAndGroups();

    // Create tree view with drag and drop support
    this.treeView = vscode.window.createTreeView('msKustoExplorer_connections', {
        treeDataProvider: this.connectionsProvider,
        showCollapseAll: true,
        dragAndDropController: new KustoDragAndDropController(connections, () => { this.isDragging = true; setTimeout(() => { this.isDragging = false; }, 100); }) // delay resets drag state after tree selection events settle
    });
    context.subscriptions.push(this.treeView);

    // Register drop edit provider so entity drops resolve text at drop time with the target document URI
    context.subscriptions.push(
        vscode.languages.registerDocumentDropEditProvider(
            { language: 'kusto' },
            new KustoDocumentDropEditProvider(server),
            { dropMimeTypes: [ENTITY_DRAG_MIME] }
        )
    );

    // Send initial connections list to server and load document connections
    // via initialize() which must be called after construction

    // Handle document ready notification from server - update connection and tree selection
    // This fires after the server has fully processed the document and can infer connections
    server.onDocumentReady(async (params) => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.uri.toString() === params.uri) {
            await this.updateTreeSelectionForActiveDocument();
        }
    });

    // Update tree selection when active editor changes
    // Calls ensureDocument which always triggers documentReady notification
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            if (editor && editor.document.languageId === 'kusto') {
                // Ensure the server has this document and trigger documentReady
                // The notification handler will call updateTreeSelectionForActiveDocument
                await server.ensureDocument(
                    editor.document.uri.toString(),
                    editor.document.getText()
                );
            } else {
                await this.updateTreeSelectionForActiveDocument();
            }
        })
    );

    // Set initial context for view visibility
    const initialEditor = vscode.window.activeTextEditor;
    const initialIsKusto = initialEditor && initialEditor.document.languageId === 'kusto';
    vscode.commands.executeCommand('setContext', 'msKustoExplorer.hasActiveDocument', initialIsKusto);

    // Handle tree selection changes - update document connection when user clicks
    context.subscriptions.push(
        this.treeView.onDidChangeSelection(async (event) => {
            // Ignore if this is a programmatic selection (not user-initiated)
            if (this.isProgrammaticSelection()) {
                return;
            }

            // Ignore selection changes triggered by drag operations
            if (this.isDragging) {
                return;
            }

            if (event.selection.length === 0) {
                return;
            }

            const selected = event.selection[0];

            // Only allow selection of connectable items (server, database, no-connection)
            const isSelectableItem = selected instanceof NoConnectionTreeItem
                || selected instanceof ServerTreeItem
                || selected instanceof DatabaseTreeItem;

            if (!isSelectableItem) {
                // Revert to the last valid selection
                if (this.lastValidSelection) {
                    try {
                        await this.programmaticSelectTreeItem(this.lastValidSelection, { select: true, focus: false, expand: false });
                    } catch {
                        // Silently ignore reveal errors
                    }
                }
                return;
            }


            this.lastValidSelection = selected;

            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'kusto') {
                return;
            }

            // Set flag to prevent the onDocumentConnectionChanged callback from
            // calling updateTreeSelectionForActiveDocument (which would overwrite
            // the user's selection with the inferred connection)
            this.isTreeSelectionChangingConnection = true;
            try {
                if (selected instanceof NoConnectionTreeItem) {
                    await connections.setDocumentConnection(editor.document.uri.toString(), undefined, undefined);
                } else if (selected instanceof ServerTreeItem) {
                    await connections.setDocumentConnection(editor.document.uri.toString(), selected.clusterName, undefined);
                } else if (selected instanceof DatabaseTreeItem) {
                    await connections.setDocumentConnection(editor.document.uri.toString(), selected.clusterName, selected.databaseName);
                }
            } catch (error) {
                console.error('Failed to set document connection:', error);
            } finally {
                this.isTreeSelectionChangingConnection = false;
            }
        })
    );

    // Initialize tree selection for active document.
    // Deferred with setTimeout because the tree view must finish its initial getChildren()
    // call before reveal() can find tree items. No API event signals this completion.
    setTimeout(async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'kusto') {
            await this.updateTreeSelectionForActiveDocument();
        }
    }, 100);

    // Ensure tree is populated after all initialization
    this.connectionsProvider.refresh();

    // Prompt to import Kusto Explorer connections when the panel becomes visible
    let importPromptResolved = false;
    const tryPromptImport = async () => {
        if (!importPromptResolved) {
            importPromptResolved = await importer.promptImportIfAvailable();
        }
    };
    context.subscriptions.push(
        this.treeView.onDidChangeVisibility((e) => {
            if (e.visible) {
                void tryPromptImport();
                // Re-sync tree selection with the active document now that the view
                // is visible again (selection updates were skipped while hidden).
                void this.updateTreeSelectionForActiveDocument();
            }
        })
    );
    // Also check if the panel is already visible at activation time
    if (this.treeView.visible) { void tryPromptImport(); }

    // Handle tree item expansion events - fetch data for servers (databases fetch in getChildren)
    context.subscriptions.push(
        this.treeView.onDidExpandElement(async (event) => {
            const element = event.element;

            if (element instanceof ServerTreeItem) {
                await connections.fetchDatabasesForCluster(element.clusterName);
                // Refresh only this server item to show its databases
                this.connectionsProvider.refreshItem(element);
            }
            // DatabaseTreeItem fetches data in getChildren, so no action needed here
        })
    );

    }

    // =========================================================================
    // Async Initialization
    // =========================================================================

    /**
     * Performs async initialization that cannot be done in the constructor.
     * Must be called immediately after construction.
     */
    async initialize(): Promise<void> {
        // Send initial connections list to server
        const initialConnections = this.connections.getConfiguredConnections();
        this.server.sendConnectionsUpdated(initialConnections);

        // Load document connections on startup
        await this.connections.loadDocumentConnections();

        // Initialize connection info for documents that are already open
        for (const document of vscode.workspace.textDocuments) {
            if (document.languageId === 'kusto') {
                const connection = await this.connections.getDocumentConnection(document.uri.toString());
                const serverKind = connection?.cluster ? (this.connections.findServerInfo(connection.cluster)?.serverKind ?? null) : null;
                this.server.sendDocumentConnectionChanged(
                    document.uri.toString(),
                    connection?.cluster || null,
                    connection?.database || null,
                    serverKind
                );
            }
        }
    }

    // =========================================================================
    // Command Handlers
    // =========================================================================

    async addServer(): Promise<void> {
        await this.connectionsProvider.promptAddServer();
    }

    async addServerToGroup(item: { groupInfo: { name: string } }): Promise<void> {
        await this.connectionsProvider.promptAddServer(item.groupInfo.name);
    }

    async addServerGroup(): Promise<void> {
        await this.connectionsProvider.promptAddServerGroup();
    }

    async removeServer(item: { clusterName: string; displayName?: string; groupName?: string }): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to remove connection "${item.displayName ?? item.clusterName}"?`,
            { modal: true },
            'Remove'
        );
        if (confirm === 'Remove') {
            await this.connections.removeServer(item.clusterName, item.groupName);
        }
    }

    async removeServerGroup(item: { groupInfo: { name: string } }): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to remove group "${item.groupInfo.name}" and all its connections?`,
            { modal: true },
            'Remove'
        );
        if (confirm === 'Remove') {
            await this.connections.removeServerGroup(item.groupInfo.name);
        }
    }

    async moveServer(item: { clusterName: string; displayName?: string; groupName?: string }): Promise<void> {
        await this.connectionsProvider.promptMoveServer(
            item.clusterName,
            item.displayName ?? item.clusterName,
            item.groupName
        );
    }

    async editServer(item: { connection: string; clusterName: string; displayName?: string; groupName?: string }): Promise<void> {
        await this.connectionsProvider.promptEditServer(
            item.connection,
            item.clusterName,
            item.displayName,
            item.groupName
        );
    }

    async renameServer(item: { clusterName: string; displayName?: string; groupName?: string }): Promise<void> {
        await this.connectionsProvider.promptRenameServer(
            item.clusterName,
            item.displayName ?? item.clusterName,
            item.groupName
        );
    }

    async renameServerGroup(item: { groupInfo: { name: string } }): Promise<void> {
        await this.connectionsProvider.promptRenameServerGroup(item.groupInfo.name);
    }

    async refreshServer(item: { clusterName: string }): Promise<void> {
        await this.connections.refreshClusterSchema(item.clusterName);
    }

    async refreshDatabase(item: { clusterName: string; databaseName: string }): Promise<void> {
        await this.connections.refreshDatabaseSchema(item.clusterName, item.databaseName);
    }

    async copyEntityAsCommand(item: EntityTreeItem): Promise<void> {
        if (!this.server) {
            return;
        }

        const entityType = getEntityType(item);
        if (!entityType) {
            return;
        }

        const entityName = getEntityName(item);
        const cluster = getEntityCluster(item);
        const database = getEntityDatabase(item);

        try {
            const definition = await this.server.getEntityAsCommand(
                cluster,
                database,
                entityType,
                entityName
            );

            if (definition) {
                await vscode.env.clipboard.writeText(definition);
                this.clipboard.setContext({
                    text: definition,
                    kind: 'command',
                    entityCluster: cluster,
                    entityDatabase: database,
                    entityType: entityType,
                    entityName: entityName
                });
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to copy entity: ${error}`);
        }
    }

    async copyEntityAsExpression(item: EntityTreeItem): Promise<void> {
        if (!this.server) {
            return;
        }

        const entityType = getEntityType(item);
        if (!entityType) {
            return;
        }

        const entityName = getEntityName(item);
        const cluster = getEntityCluster(item);
        const database = getEntityDatabase(item);

        try {
            const expression = await this.server.getEntityAsExpression(
                cluster,
                database,
                entityType,
                entityName,
                null
            );

            if (expression) {
                await vscode.env.clipboard.writeText(expression);
                this.clipboard.setContext({
                    text: expression,
                    kind: 'expression',
                    entityCluster: cluster,
                    entityDatabase: database,
                    entityType: entityType,
                    entityName: entityName
                });
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to copy expression: ${error}`);
        }
    }

    async viewEntityDefinition(item: EntityTreeItem): Promise<void> {
        const entityType = getEntityType(item);
        if (!entityType) {
            return;
        }

        // Only support entities that have definitions (not server/database)
        if (item instanceof ServerTreeItem || item instanceof DatabaseTreeItem) {
            return;
        }

        const entityName = getEntityName(item);
        const cluster = getEntityCluster(item);
        const database = getEntityDatabase(item);

        if (!cluster || !database) {
            return;
        }

        // Build the virtual document URI - must match the format in KustoLspServer.cs
        const encodedCluster = encodeURIComponent(cluster);
        const encodedDatabase = encodeURIComponent(database);
        const encodedEntityType = encodeURIComponent(entityType);
        const encodedEntityName = encodeURIComponent(entityName);
        
        const uri = vscode.Uri.parse(
            `${ENTITY_DEFINITION_SCHEME}://${encodedCluster}/${encodedDatabase}/${encodedEntityType}/${encodedEntityName}.kql`
        );

        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: true });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to open entity definition: ${error}`);
        }
    }

    // =========================================================================
    // Tree Selection Helpers
    // =========================================================================

    private isProgrammaticSelection(): boolean {
        return this.programmaticSelectionCount > 0;
    }

    private async programmaticSelectTreeItem(item: KustoTreeItem, options?: { select?: boolean; focus?: boolean; expand?: boolean }): Promise<void> {
        // Skip reveal when the tree view is not visible. TreeView.reveal() forces the
        // containing view to become visible, which would steal focus away from whatever
        // activity bar panel (e.g. Source Control) the user is currently using.
        // Selection will be re-applied via the onDidChangeVisibility handler when the
        // user navigates back to the Kusto Explorer panel.
        if (!this.treeView.visible) {
            return;
        }
        this.programmaticSelectionCount++;
        try {
            await this.treeView.reveal(item, options);
        } finally {
            this.programmaticSelectionCount--;
        }
    }

    private async findServerTreeItem(cluster: string): Promise<ServerTreeItem | undefined> {
        const clusterLower = cluster.toLowerCase();
        const rootItems = await this.connectionsProvider.getChildren();

        for (const item of rootItems) {
            if (item instanceof ServerGroupTreeItem) {
                const groupItems = await this.connectionsProvider.getChildren(item);
                for (const sItem of groupItems) {
                    if (sItem instanceof ServerTreeItem && sItem.clusterName.toLowerCase() === clusterLower) {
                        return sItem;
                    }
                }
            } else if (item instanceof ServerTreeItem && item.clusterName.toLowerCase() === clusterLower) {
                return item;
            }
        }

        return undefined;
    }

    private async findTreeItem(cluster: string, database: string | undefined): Promise<ServerTreeItem | DatabaseTreeItem | undefined> {
        let serverItem = await this.findServerTreeItem(cluster);

        if (!serverItem) {
            return undefined;
        }

        if (!database) {
            return serverItem;
        }

        this.isFetchingDatabasesForTreeUpdate = true;
        try {
            await this.connections.fetchDatabasesForCluster(serverItem.clusterName);
        } finally {
            this.isFetchingDatabasesForTreeUpdate = false;
        }

        await new Promise(resolve => setTimeout(resolve, 100));

        serverItem = await this.findServerTreeItem(cluster);
        if (!serverItem) {
            return undefined;
        }

        const dbItems = await this.connectionsProvider.getChildren(serverItem);
        for (const dbItem of dbItems) {
            if (dbItem instanceof DatabaseTreeItem && dbItem.databaseName.toLowerCase() === database.toLowerCase()) {
                return dbItem;
            }
        }

        return serverItem;
    }

    private async selectNeutralTreeItem(): Promise<void> {
        try {
            const rootItems = await this.connectionsProvider.getChildren();
            const noConnectionItem = rootItems.find(item => item instanceof NoConnectionTreeItem);

            if (noConnectionItem) {
                try {
                    await this.programmaticSelectTreeItem(noConnectionItem, { select: true, focus: false, expand: false });
                    this.lastValidSelection = noConnectionItem;
                } catch {
                    // Silently ignore reveal errors
                }
            }
        } catch {
            // Silently fail
        }
    }

    private async updateTreeSelectionForActiveDocument(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'kusto') {
            await this.selectNeutralTreeItem();
            return;
        }

        const uri = editor.document.uri.toString();

        const connection = await this.connections.getDocumentConnection(uri);

        if (!connection?.cluster) {
            await this.selectNeutralTreeItem();
            return;
        }

        const serverKind = this.connections.findServerInfo(connection.cluster)?.serverKind ?? null;
        this.server.sendDocumentConnectionChanged(uri, connection.cluster, connection.database || null, serverKind);

        try {
            const itemToSelect = await this.findTreeItem(connection.cluster, connection.database);

            if (itemToSelect) {
                try {
                    const currentEditor = vscode.window.activeTextEditor;
                    if (currentEditor && currentEditor.document.languageId === 'kusto') {
                        await this.programmaticSelectTreeItem(itemToSelect, { select: true, focus: false, expand: false });
                        this.lastValidSelection = itemToSelect;
                    }
                } catch {
                    // Silently ignore reveal errors
                }
            }
        } catch {
            // Silently fail - tree might not be fully loaded yet
        }
    }
}

/** Entity tree item types that support copy/drag operations */
type EntityTreeItem = ServerTreeItem | DatabaseTreeItem | TableTreeItem | ExternalTableTreeItem | MaterializedViewTreeItem | FunctionTreeItem | EntityGroupTreeItem | GraphModelTreeItem;

/** Type guard for entity tree items that support copy/drag operations */
function isEntityTreeItem(item: KustoTreeItem): item is EntityTreeItem {
    return item instanceof ServerTreeItem
        || item instanceof DatabaseTreeItem
        || item instanceof TableTreeItem
        || item instanceof ExternalTableTreeItem
        || item instanceof MaterializedViewTreeItem
        || item instanceof FunctionTreeItem
        || item instanceof EntityGroupTreeItem
        || item instanceof GraphModelTreeItem;
}

/** Maps contextValue to the entity type expected by the server */
const entityTypeMap: Record<string, string> = {
    'server': 'Cluster',
    'database': 'Database',
    'table': 'Table',
    'externalTable': 'ExternalTable',
    'materializedView': 'MaterializedView',
    'function': 'Function',
    'entityGroup': 'EntityGroup',
    'graphModel': 'Graph'
};

/**
 * Gets the entity type string for a tree item based on its contextValue.
 * @param item The entity tree item
 * @returns The entity type string, or undefined if not a recognized entity type
 */
function getEntityType(item: EntityTreeItem): string | undefined {
    return entityTypeMap[item.contextValue ?? ''];
}

/**
 * Gets the entity name from a tree item.
 * @param item The entity tree item
 * @returns The entity name
 */
function getEntityName(item: EntityTreeItem): string {
    if (item instanceof ServerTreeItem) {
        return item.clusterName;
    } else if (item instanceof DatabaseTreeItem) {
        return item.databaseName;
    } else if (item instanceof TableTreeItem || item instanceof ExternalTableTreeItem) {
        return item.tableInfo.name;
    } else if (item instanceof MaterializedViewTreeItem) {
        return item.viewInfo.name;
    } else if (item instanceof FunctionTreeItem) {
        return item.functionInfo.name;
    } else if (item instanceof EntityGroupTreeItem) {
        return item.groupInfo.name;
    } else if (item instanceof GraphModelTreeItem) {
        return item.graphInfo.name;
    }
    // This should never happen if EntityTreeItem type is correct
    throw new Error(`Unknown entity tree item type`);
}

/**
 * Gets the cluster context for an entity tree item.
 * Server items have no cluster context (they ARE the entity).
 * All other items have a cluster from their parent.
 */
function getEntityCluster(item: EntityTreeItem): string {
    if (item instanceof ServerTreeItem) {
        return '';
    }
    return item.clusterName;
}

/**
 * Gets the database context for an entity tree item.
 * Server and Database items have no database context.
 * All other items have a database from their parent.
 */
function getEntityDatabase(item: EntityTreeItem): string {
    if (item instanceof ServerTreeItem || item instanceof DatabaseTreeItem) {
        return '';
    }
    return item.databaseName;
}

// =============================================================================
// Connection Tree Provider
// =============================================================================

// Define tree item types
type KustoTreeItem = 
  NoConnectionTreeItem
| ServerGroupTreeItem 
| ServerTreeItem 
| DatabaseTreeItem 
| DatabaseFolderTreeItem 
| EntityFolderTreeItem
| TableTreeItem
| ExternalTableTreeItem
| MaterializedViewTreeItem
| ColumnTreeItem
| FunctionTreeItem
| EntityGroupTreeItem
| EntityGroupMemberTreeItem
| GraphModelTreeItem
| GraphSnapshotTreeItem;

class NoConnectionTreeItem extends vscode.TreeItem {
    constructor() {
        super('(No Connection)', vscode.TreeItemCollapsibleState.None);
        this.id = 'no-connection';
        this.contextValue = 'noConnection';
        this.iconPath = new vscode.ThemeIcon('circle-slash');
    }
}

class ServerGroupTreeItem extends vscode.TreeItem {
    constructor(public readonly groupInfo: ServerGroupInfo) {
        super(groupInfo.name, vscode.TreeItemCollapsibleState.Collapsed);
        this.id = `group:${groupInfo.name}`;
        this.contextValue = 'serverGroup';
        this.iconPath = new vscode.ThemeIcon('folder');
    }
}

/**
 * Returns the appropriate ThemeIcon for a server based on its kind.
 * @param serverKind The kind of server (Engine, DataManager, ClusterManager)
 * @returns A ThemeIcon for the server type
 */
function getServerKindIcon(serverKind?: string): vscode.ThemeIcon {
    switch (serverKind) {
        case 'Engine':
            return new vscode.ThemeIcon('server'); // Server icon for query engine
        case 'DataManagement':
            return new vscode.ThemeIcon('cloud-upload'); // Cloud upload for data ingestion
        case 'ClusterManager':
            return new vscode.ThemeIcon('settings-gear'); // Gear for cluster management
        default:
            return new vscode.ThemeIcon('server'); // Default server icon
    }
}

class ServerTreeItem extends vscode.TreeItem {
    constructor(
        public readonly connection: string,
        public readonly clusterName: string, 
        public readonly displayName?: string,
        public readonly groupName?: string,
        public readonly serverKind?: string
    ) {
        const name = displayName ?? clusterName;
        
        super(name, vscode.TreeItemCollapsibleState.Collapsed);
        this.id = `server:${clusterName}`;
        this.contextValue = 'server';
        this.iconPath = getServerKindIcon(serverKind);
        // Set command to prevent auto-expand on click (selection still fires)
        this.command = {
            command: 'msKustoExplorer.selectServer',
            title: 'Select Server',
            arguments: [this]
        };
        if (displayName) {
            this.description = clusterName;
        }
    }
}

class DatabaseTreeItem extends vscode.TreeItem {
    constructor(public readonly clusterName: string, public readonly databaseName: string) {
        super(databaseName, vscode.TreeItemCollapsibleState.Collapsed);
        this.id = `database:${clusterName}:${databaseName}`;
        this.contextValue = 'database';
        this.iconPath = new vscode.ThemeIcon('database');
        // Set command to prevent auto-expand on click (selection still fires)
        this.command = {
            command: 'msKustoExplorer.selectDatabase',
            title: 'Select Database',
            arguments: [this]
        };
    }
}

/** Folder types for organizing database entities */
type DatabaseFolderType = 'tables' | 'externalTables' | 'materializedViews' | 'functions' | 'entityGroups' | 'graphModels';

class DatabaseFolderTreeItem extends vscode.TreeItem {
    constructor(
        public readonly clusterName: string,
        public readonly databaseName: string,
        public readonly folderType: DatabaseFolderType,
        label: string,
        icon: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.Collapsed);
        this.id = `folder:${clusterName}:${databaseName}:${folderType}`;
        this.contextValue = 'databaseFolder';
        this.iconPath = new vscode.ThemeIcon(icon);
    }
}

class EntityFolderTreeItem extends vscode.TreeItem {
    constructor(
        public readonly clusterName: string,
        public readonly databaseName: string,
        public readonly folderType: DatabaseFolderType,
        public readonly folderPath: string  // Full path like "Logs/HTTP"
    ) {
        // Display name is the last segment of the path
        const segments = folderPath.split('/');
        const folderName = segments[segments.length - 1] ?? folderPath;
        super(folderName, vscode.TreeItemCollapsibleState.Collapsed);
        this.id = `entityFolder:${clusterName}:${databaseName}:${folderType}:${folderPath}`;
        this.contextValue = 'entityFolder';
        this.iconPath = new vscode.ThemeIcon('folder');
    }
}

class TableTreeItem extends vscode.TreeItem {
    constructor(
        public readonly clusterName: string,
        public readonly databaseName: string,
        public readonly tableInfo: DatabaseTableInfo
    ) {
        // Collapsible if there are columns
        const hasColumns = tableInfo.columns && tableInfo.columns.length > 0;
        super(tableInfo.name, hasColumns ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.id = `table:${clusterName}:${databaseName}:${tableInfo.name}`;
        this.contextValue = 'table';
        this.iconPath = new vscode.ThemeIcon('table');
        if (tableInfo.description) {
            this.tooltip = tableInfo.description;
        }
        // Set command to prevent auto-expand on click/drag (selection still fires)
        this.command = { command: 'msKustoExplorer.selectEntity', title: 'Select Entity', arguments: [this] };
    }
}

class ExternalTableTreeItem extends vscode.TreeItem {
    constructor(
        public readonly clusterName: string,
        public readonly databaseName: string,
        public readonly tableInfo: DatabaseTableInfo
    ) {
        // Collapsible if there are columns
        const hasColumns = tableInfo.columns && tableInfo.columns.length > 0;
        super(tableInfo.name, hasColumns ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.id = `externalTable:${clusterName}:${databaseName}:${tableInfo.name}`;
        this.contextValue = 'externalTable';
        this.iconPath = new vscode.ThemeIcon('cloud');
        if (tableInfo.description) {
            this.tooltip = tableInfo.description;
        }
        // Set command to prevent auto-expand on click/drag (selection still fires)
        this.command = { command: 'msKustoExplorer.selectEntity', title: 'Select Entity', arguments: [this] };
    }
}

class MaterializedViewTreeItem extends vscode.TreeItem {
    constructor(
        public readonly clusterName: string,
        public readonly databaseName: string,
        public readonly viewInfo: DatabaseTableInfo
    ) {
        // Collapsible if there are columns
        const hasColumns = viewInfo.columns && viewInfo.columns.length > 0;
        super(viewInfo.name, hasColumns ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.id = `materializedView:${clusterName}:${databaseName}:${viewInfo.name}`;
        this.contextValue = 'materializedView';
        this.iconPath = new vscode.ThemeIcon('eye');
        if (viewInfo.description) {
            this.tooltip = viewInfo.description;
        }
        // Set command to prevent auto-expand on click/drag (selection still fires)
        this.command = { command: 'msKustoExplorer.selectEntity', title: 'Select Entity', arguments: [this] };
    }
}

/** Entity type for column parent tracking */
type ColumnParentType = 'table' | 'externalTable' | 'materializedView';

class ColumnTreeItem extends vscode.TreeItem {
    constructor(
        public readonly clusterName: string,
        public readonly databaseName: string,
        public readonly parentName: string,
        public readonly parentType: ColumnParentType,
        public readonly columnInfo: DatabaseColumnInfo
    ) {
        super(columnInfo.name, vscode.TreeItemCollapsibleState.None);
        this.id = `column:${clusterName}:${databaseName}:${parentType}:${parentName}:${columnInfo.name}`;
        this.contextValue = 'column';
        this.iconPath = new vscode.ThemeIcon('symbol-field');
        this.description = columnInfo.type;
    }
}

class FunctionTreeItem extends vscode.TreeItem {
    constructor(
        public readonly clusterName: string,
        public readonly databaseName: string,
        public readonly functionInfo: DatabaseFunctionInfo
    ) {
        super(functionInfo.name, vscode.TreeItemCollapsibleState.None);
        this.id = `function:${clusterName}:${databaseName}:${functionInfo.name}`;
        this.contextValue = 'function';
        this.iconPath = new vscode.ThemeIcon('symbol-function');
        if (functionInfo.parameters) {
            this.description = functionInfo.parameters;
        }
        if (functionInfo.description) {
            this.tooltip = functionInfo.description;
        }
    }
}

class EntityGroupTreeItem extends vscode.TreeItem {
    constructor(
        public readonly clusterName: string,
        public readonly databaseName: string,
        public readonly groupInfo: DatabaseEntityGroupInfo
    ) {
        // Collapsible if there are entities
        const hasEntities = groupInfo.entities && groupInfo.entities.length > 0;
        super(groupInfo.name, hasEntities ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.id = `entityGroup:${clusterName}:${databaseName}:${groupInfo.name}`;
        this.contextValue = 'entityGroup';
        this.iconPath = new vscode.ThemeIcon('symbol-namespace');
        if (groupInfo.description) {
            this.tooltip = groupInfo.description;
        }
        // Set command to prevent auto-expand on click/drag (selection still fires)
        this.command = { command: 'msKustoExplorer.selectEntity', title: 'Select Entity', arguments: [this] };
    }
}

class EntityGroupMemberTreeItem extends vscode.TreeItem {
    constructor(
        public readonly clusterName: string,
        public readonly databaseName: string,
        public readonly groupName: string,
        public readonly entityName: string
    ) {
        super(entityName, vscode.TreeItemCollapsibleState.None);
        this.id = `entityGroupMember:${clusterName}:${databaseName}:${groupName}:${entityName}`;
        this.contextValue = 'entityGroupMember';
        this.iconPath = new vscode.ThemeIcon('symbol-reference');
    }
}

class GraphModelTreeItem extends vscode.TreeItem {
    constructor(
        public readonly clusterName: string,
        public readonly databaseName: string,
        public readonly graphInfo: DatabaseGraphModelInfo
    ) {
        const hasSnapshots = (graphInfo.snapshots?.length ?? 0) > 0;
        super(graphInfo.name, hasSnapshots ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.id = `graphModel:${clusterName}:${databaseName}:${graphInfo.name}`;
        this.contextValue = 'graphModel';
        this.iconPath = new vscode.ThemeIcon('type-hierarchy');
    }
}

class GraphSnapshotTreeItem extends vscode.TreeItem {
    constructor(
        public readonly clusterName: string,
        public readonly databaseName: string,
        public readonly modelName: string,
        public readonly snapshotName: string
    ) {
        super(snapshotName, vscode.TreeItemCollapsibleState.None);
        this.id = `graphSnapshot:${clusterName}:${databaseName}:${modelName}:${snapshotName}`;
        this.contextValue = 'graphSnapshot';
        this.iconPath = new vscode.ThemeIcon('history');
    }
}

// =============================================================================
// Entity Folder Grouping Helper
// =============================================================================

/**
 * Groups entities by their folder paths, returning entities that belong directly
 * at the current level and subfolders that contain deeper entities.
 * @param entities List of entities that may have a folder property
 * @param currentPath The current folder path ('' for root level of entity type folder)
 * @returns Direct entities at this level and subfolder paths to create
 */
function getEntitiesAndSubfolders<T extends { folder?: string }>(
    entities: T[],
    currentPath: string
): { directEntities: T[]; subfolderPaths: string[] } {
    const directEntities: T[] = [];
    const subfolderPathSet = new Set<string>();

    for (const entity of entities) {
        const folder = entity.folder?.replace(/\\/g, '/');

        if (!folder) {
            // No folder: show at root level only
            if (currentPath === '') {
                directEntities.push(entity);
            }
            continue;
        }

        if (currentPath === '') {
            // Root level: entities with folders go into subfolders
            const firstSlash = folder.indexOf('/');
            const topFolder = firstSlash === -1 ? folder : folder.substring(0, firstSlash);
            subfolderPathSet.add(topFolder);
        } else if (folder === currentPath) {
            // Entity's folder matches this folder exactly
            directEntities.push(entity);
        } else if (folder.startsWith(currentPath + '/')) {
            // Entity is in a deeper subfolder
            const remaining = folder.substring(currentPath.length + 1);
            const nextSlash = remaining.indexOf('/');
            const nextSegment = nextSlash === -1 ? remaining : remaining.substring(0, nextSlash);
            subfolderPathSet.add(currentPath + '/' + nextSegment);
        }
    }

    return {
        directEntities,
        subfolderPaths: Array.from(subfolderPathSet).sort((a, b) =>
            a.localeCompare(b, undefined, { sensitivity: 'base' })
        )
    };
}

/**
 * Builds tree items for a given entity type folder at a specific folder path level.
 * Returns entity folder items (sorted) followed by entity items (sorted).
 */
function buildEntityFolderChildren<TEntity extends { folder?: string; name: string }, TTreeItem extends KustoTreeItem>(
    entities: TEntity[],
    currentPath: string,
    clusterName: string,
    databaseName: string,
    folderType: DatabaseFolderType,
    createTreeItem: (entity: TEntity) => TTreeItem
): KustoTreeItem[] {
    const { directEntities, subfolderPaths } = getEntitiesAndSubfolders(entities, currentPath);

    const folderItems: EntityFolderTreeItem[] = subfolderPaths.map(
        p => new EntityFolderTreeItem(clusterName, databaseName, folderType, p)
    );

    const entityItems: TTreeItem[] = directEntities
        .map(e => createTreeItem(e))
        .sort((a, b) => {
            const aLabel = typeof a.label === 'string' ? a.label : a.label?.label ?? '';
            const bLabel = typeof b.label === 'string' ? b.label : b.label?.label ?? '';
            return aLabel.localeCompare(bLabel, undefined, { sensitivity: 'base' });
        });

    return [...folderItems, ...entityItems];
}

class KustoConnectionsProvider implements vscode.TreeDataProvider<KustoTreeItem>
{
    private _onDidChangeTreeData = new vscode.EventEmitter<KustoTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly connections: ConnectionManager) {}

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    refreshItem(item: KustoTreeItem): void {
        this._onDidChangeTreeData.fire(item);
    }

    // =========================================================================
    // UI Prompt Methods
    // =========================================================================

    /**
     * Prompts the user to add a new server.
     * @param groupName Optional group name to add the server to
     */
    async promptAddServer(groupName?: string): Promise<void> {
        const connectionString = await vscode.window.showInputBox({
            prompt: 'Enter the connection URL or connection string',
            placeHolder: 'e.g., myserver.kusto.windows.net'
        });

        if (!connectionString) {
            return;
        }

        // Extract cluster hostname from connection string
        const cluster = await this.connections.getHostName(connectionString);

        const displayName = getDisplayName(cluster);
        const server: ServerInfo = { 
            connection: connectionString,
            cluster: cluster
        };
        if (displayName) {
            server.displayName = displayName;
        }

        // Fetch server kind from the language server
        const serverKind = await this.connections.fetchServerKind(connectionString);
        if (serverKind) {
            server.serverKind = serverKind;
        }

        await this.connections.addServer(server, groupName);
    }

    /**
     * Prompts the user to add a new server group.
     */
    async promptAddServerGroup(): Promise<void> {
        const name = await vscode.window.showInputBox({
            prompt: 'Enter the group name',
            placeHolder: 'e.g., Production Clusters'
        });

        if (!name) {
            return;
        }

        const group: ServerGroupInfo = {
            name,
            servers: []
        };

        await this.connections.addServerGroup(group);
    }

    /**
     * Prompts the user to select a destination and moves the server.
     */
    async promptMoveServer(cluster: string, displayName: string, currentGroupName?: string): Promise<void> {
        const destinations: vscode.QuickPickItem[] = [];

        if (currentGroupName) {
            destinations.push({
                label: '$(home) Root',
                description: 'Move to root level'
            });
        }

        for (const item of this.connections.getServersAndGroups().items) {
            if (isServerGroup(item) && item.name !== currentGroupName) {
                destinations.push({
                    label: `$(folder) ${item.name}`,
                    description: `Move to group "${item.name}"`
                });
            }
        }

        if (destinations.length === 0) {
            vscode.window.showInformationMessage('No other destinations available. Create a group first.');
            return;
        }

        const selection = await vscode.window.showQuickPick(destinations, {
            placeHolder: `Select destination for "${displayName}"`
        });

        if (!selection) {
            return;
        }

        let targetGroupName: string | undefined;
        if (!selection.label.startsWith('$(home)')) {
            targetGroupName = selection.label.replace('$(folder) ', '');
        }

        await this.connections.moveServer(cluster, currentGroupName, targetGroupName);
    }

    /**
     * Prompts the user to edit a server's connection string.
     */
    async promptEditServer(connection: string, cluster: string, displayName?: string, groupName?: string): Promise<void> {
        const newConnectionString = await vscode.window.showInputBox({
            prompt: 'Edit the connection URL or connection string',
            value: connection,
            placeHolder: 'e.g., myserver.kusto.windows.net'
        });

        if (!newConnectionString) {
            return;
        }

        const newCluster = await this.connections.getHostName(newConnectionString);

        let newDisplayName: string | undefined;
        if (newCluster === cluster) {
            newDisplayName = displayName;
        } else {
            newDisplayName = getDisplayName(newCluster) ?? newCluster;
        }

        // Fetch server kind from the language server
        const serverKind = await this.connections.fetchServerKind(newConnectionString);

        await this.connections.editServer(cluster, newConnectionString, newDisplayName, serverKind ?? undefined, groupName);
    }

    /**
     * Prompts the user to rename a server's display name.
     */
    async promptRenameServer(cluster: string, currentDisplayName: string, groupName?: string): Promise<void> {
        const newDisplayName = await vscode.window.showInputBox({
            prompt: 'Enter a new display name',
            value: currentDisplayName
        });

        if (newDisplayName === undefined || newDisplayName === currentDisplayName) {
            return;
        }

        await this.connections.renameServer(cluster, newDisplayName, groupName);
    }

    /**
     * Prompts the user to rename a server group.
     */
    async promptRenameServerGroup(currentName: string): Promise<void> {
        const newName = await vscode.window.showInputBox({
            prompt: 'Enter a new group name',
            value: currentName
        });

        if (!newName || newName === currentName) {
            return;
        }

        await this.connections.renameServerGroup(currentName, newName);
    }

    // =========================================================================
    // Tree Data Provider Implementation
    // =========================================================================

    getTreeItem(element: KustoTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: KustoTreeItem): KustoTreeItem[] | Thenable<KustoTreeItem[]> {
        if (!element) {
            const items: KustoTreeItem[] = [];

            items.push(new NoConnectionTreeItem());

            const groups: ServerGroupTreeItem[] = [];
            const servers: ServerTreeItem[] = [];

            for (const item of this.connections.getServersAndGroups().items) {
                if (isServerGroup(item)) {
                    groups.push(new ServerGroupTreeItem(item));
                } else {
                    servers.push(new ServerTreeItem(item.connection, item.cluster, item.displayName, undefined, item.serverKind));
                }
            }

            groups.sort((a, b) =>
                a.groupInfo.name.localeCompare(b.groupInfo.name, undefined, { sensitivity: 'base' })
            );

            servers.sort((a, b) => {
                const aName = a.displayName ?? a.clusterName;
                const bName = b.displayName ?? b.clusterName;
                return aName.localeCompare(bName, undefined, { sensitivity: 'base' });
            });

            items.push(...servers);
            items.push(...groups);

            return items;
        }

        if (element instanceof ServerGroupTreeItem) {
            const servers = element.groupInfo.servers.map(s =>
                new ServerTreeItem(s.connection, s.cluster, s.displayName, element.groupInfo.name, s.serverKind)
            );

            servers.sort((a, b) => {
                const aName = a.displayName ?? a.clusterName;
                const bName = b.displayName ?? b.clusterName;
                return aName.localeCompare(bName, undefined, { sensitivity: 'base' });
            });

            return servers;
        }

        if (element instanceof ServerTreeItem) {
            const databases = this.connections.getClusterDatabases(element.clusterName);
            const items = databases?.map(db => new DatabaseTreeItem(element.clusterName, db.name)) ?? [];

            items.sort((a, b) =>
                a.databaseName.localeCompare(b.databaseName, undefined, { sensitivity: 'base' })
            );

            return items;
        }

        if (element instanceof DatabaseTreeItem) {
            // Fetch database info if not cached (returns cached data if available)
            return this.connections.getDatabaseSchema(element.clusterName, element.databaseName).then(dbInfo => {
                const folders: DatabaseFolderTreeItem[] = [];

                if (dbInfo?.tables && dbInfo.tables.length > 0) {
                    folders.push(new DatabaseFolderTreeItem(element.clusterName, element.databaseName, 'tables', 'Tables', 'table'));
                }
                if (dbInfo?.externalTables && dbInfo.externalTables.length > 0) {
                    folders.push(new DatabaseFolderTreeItem(element.clusterName, element.databaseName, 'externalTables', 'External Tables', 'cloud'));
                }
                if (dbInfo?.materializedViews && dbInfo.materializedViews.length > 0) {
                    folders.push(new DatabaseFolderTreeItem(element.clusterName, element.databaseName, 'materializedViews', 'Materialized Views', 'eye'));
                }
                if (dbInfo?.functions && dbInfo.functions.length > 0) {
                    folders.push(new DatabaseFolderTreeItem(element.clusterName, element.databaseName, 'functions', 'Functions', 'symbol-function'));
                }
                if (dbInfo?.entityGroups && dbInfo.entityGroups.length > 0) {
                    folders.push(new DatabaseFolderTreeItem(element.clusterName, element.databaseName, 'entityGroups', 'Entity Groups', 'symbol-namespace'));
                }
                if (dbInfo?.graphModels && dbInfo.graphModels.length > 0) {
                    folders.push(new DatabaseFolderTreeItem(element.clusterName, element.databaseName, 'graphModels', 'Graph Models', 'type-hierarchy'));
                }

                return folders;
            });
        }

        if (element instanceof DatabaseFolderTreeItem) {
            // Fetch database info if not cached (returns cached data if available)
            return this.connections.getDatabaseSchema(element.clusterName, element.databaseName).then(dbInfo => {
                if (!dbInfo) return [];

                switch (element.folderType) {
                    case 'tables':
                        return buildEntityFolderChildren(
                            dbInfo.tables ?? [], '', element.clusterName, element.databaseName, 'tables',
                            t => new TableTreeItem(element.clusterName, element.databaseName, t)
                        );
                    case 'externalTables':
                        return buildEntityFolderChildren(
                            dbInfo.externalTables ?? [], '', element.clusterName, element.databaseName, 'externalTables',
                            t => new ExternalTableTreeItem(element.clusterName, element.databaseName, t)
                        );
                    case 'materializedViews':
                        return buildEntityFolderChildren(
                            dbInfo.materializedViews ?? [], '', element.clusterName, element.databaseName, 'materializedViews',
                            v => new MaterializedViewTreeItem(element.clusterName, element.databaseName, v)
                        );
                    case 'functions':
                        return buildEntityFolderChildren(
                            dbInfo.functions ?? [], '', element.clusterName, element.databaseName, 'functions',
                            f => new FunctionTreeItem(element.clusterName, element.databaseName, f)
                        );
                    case 'entityGroups':
                        return buildEntityFolderChildren(
                            dbInfo.entityGroups ?? [], '', element.clusterName, element.databaseName, 'entityGroups',
                            g => new EntityGroupTreeItem(element.clusterName, element.databaseName, g)
                        );
                    case 'graphModels':
                        return (dbInfo.graphModels ?? [])
                            .map(g => new GraphModelTreeItem(element.clusterName, element.databaseName, g))
                            .sort((a, b) => a.graphInfo.name.localeCompare(b.graphInfo.name, undefined, { sensitivity: 'base' }));
                    default:
                        return [];
                }
            });
        }

        if (element instanceof EntityFolderTreeItem) {
            // Fetch database info if not cached (returns cached data if available)
            return this.connections.getDatabaseSchema(element.clusterName, element.databaseName).then(dbInfo => {
                if (!dbInfo) return [];

                switch (element.folderType) {
                    case 'tables':
                        return buildEntityFolderChildren(
                            dbInfo.tables ?? [], element.folderPath, element.clusterName, element.databaseName, 'tables',
                            t => new TableTreeItem(element.clusterName, element.databaseName, t)
                        );
                    case 'externalTables':
                        return buildEntityFolderChildren(
                            dbInfo.externalTables ?? [], element.folderPath, element.clusterName, element.databaseName, 'externalTables',
                            t => new ExternalTableTreeItem(element.clusterName, element.databaseName, t)
                        );
                    case 'materializedViews':
                        return buildEntityFolderChildren(
                            dbInfo.materializedViews ?? [], element.folderPath, element.clusterName, element.databaseName, 'materializedViews',
                            v => new MaterializedViewTreeItem(element.clusterName, element.databaseName, v)
                        );
                    case 'functions':
                        return buildEntityFolderChildren(
                            dbInfo.functions ?? [], element.folderPath, element.clusterName, element.databaseName, 'functions',
                            f => new FunctionTreeItem(element.clusterName, element.databaseName, f)
                        );
                    case 'entityGroups':
                        return buildEntityFolderChildren(
                            dbInfo.entityGroups ?? [], element.folderPath, element.clusterName, element.databaseName, 'entityGroups',
                            g => new EntityGroupTreeItem(element.clusterName, element.databaseName, g)
                        );
                    default:
                        return [];
                }
            });
        }

        if (element instanceof TableTreeItem) {
            return (element.tableInfo.columns ?? [])
                .map(c => new ColumnTreeItem(element.clusterName, element.databaseName, element.tableInfo.name, 'table', c));
        }

        if (element instanceof ExternalTableTreeItem) {
            return (element.tableInfo.columns ?? [])
                .map(c => new ColumnTreeItem(element.clusterName, element.databaseName, element.tableInfo.name, 'externalTable', c));
        }

        if (element instanceof MaterializedViewTreeItem) {
            return (element.viewInfo.columns ?? [])
                .map(c => new ColumnTreeItem(element.clusterName, element.databaseName, element.viewInfo.name, 'materializedView', c));
        }

        if (element instanceof EntityGroupTreeItem) {
            return (element.groupInfo.entities ?? [])
                .map(e => new EntityGroupMemberTreeItem(element.clusterName, element.databaseName, element.groupInfo.name, e));
        }

        if (element instanceof GraphModelTreeItem) {
            return (element.graphInfo.snapshots ?? [])
                .map(s => new GraphSnapshotTreeItem(element.clusterName, element.databaseName, element.graphInfo.name, s))
                .sort((a, b) => a.snapshotName.localeCompare(b.snapshotName, undefined, { sensitivity: 'base' }));
        }

        return [];
    }

    getParent(element: KustoTreeItem): KustoTreeItem | undefined
    {
        if (element instanceof TableTreeItem)
        {
            const folder = element.tableInfo.folder;
            if (folder) {
                return new EntityFolderTreeItem(element.clusterName, element.databaseName, 'tables', folder);
            }
            return new DatabaseFolderTreeItem(element.clusterName, element.databaseName, 'tables', 'Tables', 'table');
        }
        if (element instanceof ExternalTableTreeItem)
        {
            const folder = element.tableInfo.folder;
            if (folder) {
                return new EntityFolderTreeItem(element.clusterName, element.databaseName, 'externalTables', folder);
            }
            return new DatabaseFolderTreeItem(element.clusterName, element.databaseName, 'externalTables', 'External Tables', 'cloud');
        }
        if (element instanceof MaterializedViewTreeItem)
        {
            const folder = element.viewInfo.folder;
            if (folder) {
                return new EntityFolderTreeItem(element.clusterName, element.databaseName, 'materializedViews', folder);
            }
            return new DatabaseFolderTreeItem(element.clusterName, element.databaseName, 'materializedViews', 'Materialized Views', 'eye');
        }
        if (element instanceof FunctionTreeItem)
        {
            const folder = element.functionInfo.folder;
            if (folder) {
                return new EntityFolderTreeItem(element.clusterName, element.databaseName, 'functions', folder);
            }
            return new DatabaseFolderTreeItem(element.clusterName, element.databaseName, 'functions', 'Functions', 'symbol-function');
        }
        if (element instanceof EntityGroupTreeItem)
        {
            const folder = element.groupInfo.folder;
            if (folder) {
                return new EntityFolderTreeItem(element.clusterName, element.databaseName, 'entityGroups', folder);
            }
            return new DatabaseFolderTreeItem(element.clusterName, element.databaseName, 'entityGroups', 'Entity Groups', 'symbol-namespace');
        }
        if (element instanceof EntityGroupMemberTreeItem)
        {
            const dbInfo = this.connections.getDatabaseInfo(element.clusterName, element.databaseName);
            const groupInfo = dbInfo?.entityGroups?.find(g => g.name === element.groupName);
            if (groupInfo) {
                return new EntityGroupTreeItem(element.clusterName, element.databaseName, groupInfo);
            }
            return undefined;
        }
        if (element instanceof GraphModelTreeItem)
        {
            return new DatabaseFolderTreeItem(element.clusterName, element.databaseName, 'graphModels', 'Graph Models', 'type-hierarchy');
        }
        if (element instanceof GraphSnapshotTreeItem)
        {
            const dbInfo = this.connections.getDatabaseInfo(element.clusterName, element.databaseName);
            const graphInfo = dbInfo?.graphModels?.find(g => g.name === element.modelName);
            if (graphInfo) {
                return new GraphModelTreeItem(element.clusterName, element.databaseName, graphInfo);
            }
            return undefined;
        }
        if (element instanceof EntityFolderTreeItem)
        {
            // If the folder path has a parent (contains '/'), return the parent EntityFolderTreeItem
            const lastSlash = element.folderPath.lastIndexOf('/');
            if (lastSlash !== -1) {
                const parentPath = element.folderPath.substring(0, lastSlash);
                return new EntityFolderTreeItem(element.clusterName, element.databaseName, element.folderType, parentPath);
            }
            // Otherwise, parent is the DatabaseFolderTreeItem
            const folderLabels: Record<DatabaseFolderType, [string, string]> = {
                'tables': ['Tables', 'table'],
                'externalTables': ['External Tables', 'cloud'],
                'materializedViews': ['Materialized Views', 'eye'],
                'functions': ['Functions', 'symbol-function'],
                'entityGroups': ['Entity Groups', 'symbol-namespace'],
                'graphModels': ['Graph Models', 'type-hierarchy']
            };
            const [label, icon] = folderLabels[element.folderType];
            return new DatabaseFolderTreeItem(element.clusterName, element.databaseName, element.folderType, label, icon);
        }

        if (element instanceof DatabaseFolderTreeItem)
        {
            return new DatabaseTreeItem(element.clusterName, element.databaseName);
        }

        if (element instanceof DatabaseTreeItem)
        {
            for (const item of this.connections.getServersAndGroups().items)
            {
                if (isServerGroup(item))
                {
                    const server = item.servers.find(s => s.cluster === element.clusterName);
                    if (server)
                    {
                        return new ServerTreeItem(server.connection, server.cluster, server.displayName, item.name, server.serverKind);
                    }
                } else if (item.cluster === element.clusterName)
                {
                    return new ServerTreeItem(item.connection, item.cluster, item.displayName, undefined, item.serverKind);
                }
            }
            return undefined;
        }

        if (element instanceof ServerTreeItem)
        {
            if (element.groupName)
            {
                const group = this.connections.getServersAndGroups().items.find(
                    item => isServerGroup(item) && item.name === element.groupName
                ) as ServerGroupInfo | undefined;
                if (group)
                {
                    return new ServerGroupTreeItem(group);
                }
            }
            return undefined;
        }

        return undefined;
    }
}

/**
 * Custom MIME type for dragging entity metadata from the tree.
 */
const ENTITY_DRAG_MIME = 'application/vnd.msKustoExplorer.entity';

/**
 * Drag and drop controller for moving servers between groups
 * and dragging entities onto text editors.
 */
class KustoDragAndDropController implements vscode.TreeDragAndDropController<KustoTreeItem> {
    readonly dropMimeTypes = ['application/vnd.code.tree.mskustoexplorer_connections'];
    readonly dragMimeTypes = ['application/vnd.code.tree.mskustoexplorer_connections', ENTITY_DRAG_MIME];

    constructor(private readonly connections: ConnectionManager, private readonly onDragStart: () => void) {}

    async handleDrag(source: readonly KustoTreeItem[], dataTransfer: vscode.DataTransfer, _token: vscode.CancellationToken): Promise<void> {
        // Suppress selection changes during drag
        this.onDragStart();

        // Allow dragging ServerTreeItem for reordering between groups
        const servers = source.filter((item): item is ServerTreeItem => item instanceof ServerTreeItem);
        if (servers.length > 0) {
            const dragData = servers.map(s => ({
                cluster: s.clusterName,
                groupName: s.groupName
            }));
            dataTransfer.set('application/vnd.code.tree.mskustoexplorer_connections', new vscode.DataTransferItem(dragData));
        }

        // Allow dragging entity items (servers, databases, tables, functions, etc.) onto the editor
        if (source.length === 1) {
            const item = source[0]!;
            if (isEntityTreeItem(item)) {
                // Pass entity metadata via custom MIME type — the actual text is resolved
                // at drop time by KustoDocumentDropEditProvider, which has access to the
                // target document URI.
                const entityType = getEntityType(item);
                if (entityType) {
                    const entityName = getEntityName(item);
                    const metadata = {
                        cluster: getEntityCluster(item),
                        database: getEntityDatabase(item),
                        entityType,
                        entityName
                    };
                    dataTransfer.set(ENTITY_DRAG_MIME, new vscode.DataTransferItem(JSON.stringify(metadata)));
                }
            }
        }
    }

    async handleDrop(target: KustoTreeItem | undefined, dataTransfer: vscode.DataTransfer, _token: vscode.CancellationToken): Promise<void> {
        const transferItem = dataTransfer.get('application/vnd.code.tree.mskustoexplorer_connections');
        if (!transferItem) {
            return;
        }

        const dragData = transferItem.value as { cluster: string; groupName?: string }[];
        if (!dragData || dragData.length === 0) {
            return;
        }

        // Determine target group
        let targetGroupName: string | undefined;
        if (target instanceof ServerGroupTreeItem) {
            targetGroupName = target.groupInfo.name;
        } else if (target instanceof ServerTreeItem && target.groupName) {
            // Dropped on a server within a group - move to same group
            targetGroupName = target.groupName;
        }
        // If target is undefined or NoConnectionTreeItem, move to root level (targetGroupName stays undefined)

        // Move each dragged server
        for (const item of dragData) {
            // Skip if source and target are the same
            if (item.groupName === targetGroupName) {
                continue;
            }
            await this.connections.moveServer(item.cluster, item.groupName, targetGroupName);
        }
    }
}

/**
 * Document drop edit provider that resolves entity expression text at drop time.
 * This allows us to pass the target document URI to the server so it can generate
 * the correct expression based on the document's connection context.
 */
class KustoDocumentDropEditProvider implements vscode.DocumentDropEditProvider {
    constructor(private readonly server: IServer) {}

    async provideDocumentDropEdits(
        document: vscode.TextDocument,
        _position: vscode.Position,
        dataTransfer: vscode.DataTransfer,
        token: vscode.CancellationToken
    ): Promise<vscode.DocumentDropEdit | undefined> {
        const transferItem = dataTransfer.get(ENTITY_DRAG_MIME);
        if (!transferItem) {
            return undefined;
        }

        const raw = await transferItem.asString();
        if (!raw || token.isCancellationRequested) {
            return undefined;
        }

        let metadata: { cluster: string; database: string; entityType: string; entityName: string };
        try {
            metadata = JSON.parse(raw);
        } catch {
            return undefined;
        }

        const expression = await this.server.getEntityAsExpression(
            metadata.cluster,
            metadata.database,
            metadata.entityType,
            metadata.entityName,
            document.uri.toString()
        );

        if (!expression || token.isCancellationRequested) {
            return undefined;
        }

        const edit = new vscode.DocumentDropEdit(expression);
        return edit;
    }
}
