// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { LanguageClient, InitializeResult } from 'vscode-languageclient/node';
import { CancellationToken, Disposable, ExtensionContext } from 'vscode';
import {
    acquireMicrosoftAuthenticationToken,
    GetAuthenticationTokenParams,
    GetAuthenticationTokenResult,
} from './authentication';

/**
 * Interface for the Kusto Language Server, used by all components.
 * The real Server communicates via LSP; NullServer returns safe defaults
 * when no language server is available (e.g. during integration tests).
 */
export interface IServer {
    // LSP Requests
    runQuery(query: string, cluster?: string, database?: string, isReadOnly?: boolean, maxRows?: number, clientRequestId?: string): Promise<RunQueryResult | null>;
    getQueryResultType(query: string, cluster: string, database?: string): Promise<GetQueryResultTypeResult | null>;
    getFunctionResultType(cluster: string, database: string, functionName: string): Promise<GetFunctionResultTypeResult | null>;
    getQueryRanges(uri: string): Promise<QueryRangesResult | null>;
    getQueryRange(uri: string, position: Position): Promise<Range | null>;
    getServerKind(connection: string): Promise<ServerKindResult | null>;
    decodeConnectionString(connectionString: string): Promise<DecodeConnectionStringResult | null>;
    getServerInfo(connection: string, serverKind: string | null): Promise<ServerInfoResult | null>;
    getDatabaseInfo(cluster: string, database: string): Promise<DatabaseInfo | null>;
    getEntityAsCommand(cluster: string, database: string, entityType: string, entityName: string): Promise<string | null>;
    getEntityAsExpression(cluster: string, database: string, entityType: string, entityName: string, uri: string | null): Promise<string | null>;
    getQueryAsHtml(query: string, cluster?: string, database?: string, darkMode?: boolean): Promise<QueryAsHtmlResult | null>;
    getDataAsExpression(data: ResultData, tableName?: string): Promise<DataAsExpression | null>;
    getTableAsExpression(table: ResultTable): Promise<string | null>;
    getEntityDefinitionContent(uri: string, token?: CancellationToken): Promise<EntityDefinitionContentResult | null>;
    transformPaste(text: string, kind: string, targetUri: string, targetPosition: Position, entityCluster?: string, entityDatabase?: string, entityType?: string, entityName?: string): Promise<string | null>;
    refreshSchema(cluster: string, database?: string): Promise<void>;
    refreshDocumentSchema(uri: string): Promise<void>;
    inferDocumentConnection(uri: string): Promise<InferDocumentConnectionResult | null>;
    ensureDocument(uri: string, text: string): Promise<void>;
    validateQuery(query: string, cluster: string, database?: string): Promise<ValidateQueryResult | null>;
    getMinifiedQuery(query: string): Promise<GetMinifiedQueryResult | null>;

    // Notifications (client → server)
    sendConnectionsUpdated(connections: string[]): void;
    sendDocumentConnectionChanged(uri: string, cluster: string | null, database: string | null, serverKind: string | null): void;

    // Notifications (server → client)
    onDocumentReady(handler: (params: DocumentReadyNotification) => void): Disposable;
    onSemanticTokensRefresh(handler: () => void): Disposable;

    // Server Capabilities
    readonly initializeResult: InitializeResult | undefined;
}

/**
 * Typed wrapper around the Kusto Language Server LSP protocol.
 * Centralizes all custom LSP requests and notifications so return type signatures
 * are defined in one place, and the LanguageClient dependency is encapsulated.
 *
 * Also bridges the server's getData/setData requests to VS Code's globalState,
 * allowing the server to persist data across sessions.
 */
export class Server implements IServer {
    constructor(private readonly client: LanguageClient, context: ExtensionContext) {
        // Bridge server storage requests to VS Code's globalState
        this.client.onRequest('kusto/getData', async (params: GetDataParams) => {
            return context.globalState.get<object>(params.key) ?? null;
        });
        this.client.onRequest('kusto/setData', async (params: SetDataParams) => {
            await context.globalState.update(params.key, params.data);
        });
        // Bridge server AAD token requests to VS Code's built-in Microsoft
        // authentication provider. This lets sign-in UI live in the host
        // (the VS Code window) rather than in the language server process,
        // which avoids "non-interactive environment" failures on remote-SSH /
        // WSL / Codespaces and lets the user manage sign-in through the
        // standard Accounts gear.
        this.client.onRequest('kusto/getAuthenticationToken', async (params: GetAuthenticationTokenParams) => {
            return await acquireMicrosoftAuthenticationToken(params.clusterUri);
        });
    }

    // ─── LSP Requests ──────────────────────────────────────────────────

    /**
     * Runs a query with the given text, cluster, and database, returning results as ResultData.
     */
    runQuery(
        query: string,
        cluster?: string,
        database?: string,
        isReadOnly?: boolean,
        maxRows?: number,
        clientRequestId?: string
    ): Promise<RunQueryResult | null> {
        return this.client.sendRequest<RunQueryResult | null>(
            'kusto/runQuery',
            { query, cluster, database, isReadOnly, maxRows, clientRequestId }
        );
    }

    /**
     * Gets the result type of a query as a formatted string.
     */
    getQueryResultType(
        query: string,
        cluster: string,
        database?: string
    ): Promise<GetQueryResultTypeResult | null> {
        return this.client.sendRequest<GetQueryResultTypeResult | null>(
            'kusto/getQueryResultType',
            { query, cluster, database }
        );
    }

    /**
     * Gets the result type of a database function.
     */
    getFunctionResultType(
        cluster: string,
        database: string,
        functionName: string
    ): Promise<GetFunctionResultTypeResult | null> {
        return this.client.sendRequest<GetFunctionResultTypeResult | null>(
            'kusto/getFunctionResultType',
            { cluster, database, functionName }
        );
    }

    /**
     * Gets the query ranges (boundaries) for a document.
     */
    getQueryRanges(uri: string): Promise<QueryRangesResult | null> {
        return this.client.sendRequest<QueryRangesResult | null>(
            'kusto/getQueryRanges',
            { uri }
        );
    }

    /**
     * Gets the query range containing the given position in a document.
     */
    getQueryRange(uri: string, position: Position): Promise<Range | null> {
        return this.client.sendRequest<Range | null>(
            'kusto/getQueryRange',
            { uri, position }
        );
    }

    /**
     * Gets the server kind for a connection string.
     */
    getServerKind(connection: string): Promise<ServerKindResult | null> {
        return this.client.sendRequest<ServerKindResult | null>(
            'kusto/getServerKind',
            { connection }
        );
    }

    /**
     * Decodes a connection string to extract the cluster and database names.
     */
    decodeConnectionString(connectionString: string): Promise<DecodeConnectionStringResult | null> {
        return this.client.sendRequest<DecodeConnectionStringResult | null>(
            'kusto/decodeConnectionString',
            { connectionString }
        );
    }

    /**
     * Gets server info (list of databases) for a cluster.
     */
    getServerInfo(
        connection: string,
        serverKind: string | null
    ): Promise<ServerInfoResult | null> {
        return this.client.sendRequest<ServerInfoResult | null>(
            'kusto/getServerInfo',
            { connection, serverKind }
        );
    }

    /**
     * Gets detailed database info (tables, functions, etc.) for a database.
     */
    getDatabaseInfo(cluster: string, database: string): Promise<DatabaseInfo | null> {
        return this.client.sendRequest<DatabaseInfo | null>(
            'kusto/getDatabaseInfo',
            { cluster, database }
        );
    }

    /**
     * Gets the create command for a database entity.
     */
    getEntityAsCommand(
        cluster: string,
        database: string,
        entityType: string,
        entityName: string
    ): Promise<string | null> {
        return this.client.sendRequest<string | null>(
            'kusto/getEntityAsCommand',
            { cluster, database, entityType, entityName }
        );
    }

    /**
     * Gets a KQL expression that references a database entity in a query.
     */
    getEntityAsExpression(
        cluster: string,
        database: string,
        entityType: string,
        entityName: string,
        uri: string | null
    ): Promise<string | null> {
        return this.client.sendRequest<string | null>(
            'kusto/getEntityAsExpression',
            { cluster, database, entityType, entityName, uri }
        );
    }

    /**
     * Gets the HTML representation of query text with syntax colorization.
     */
    getQueryAsHtml(
        query: string,
        cluster?: string,
        database?: string,
        darkMode?: boolean
    ): Promise<QueryAsHtmlResult | null> {
        return this.client.sendRequest<QueryAsHtmlResult | null>(
            'kusto/getQueryAsHtml',
            { query, cluster, database, darkMode }
        );
    }

    /**
     * Gets the query result data as a KQL datatable expression.
     */
    getDataAsExpression(data: ResultData, tableName?: string): Promise<DataAsExpression | null> {
        return this.client.sendRequest<DataAsExpression | null>(
            'kusto/getDataAsExpression',
            {
                data,
                tableName
            }
        );
    }

    /**
     * Gets a single table as a KQL datatable expression.
     */
    async getTableAsExpression(table: ResultTable): Promise<string | null> {
        const result = await this.getDataAsExpression({ tables: [table] }, table.name);
        return result?.expression ?? null;
    }

    /**
     * Gets the content of a virtual entity definition document.
     */
    getEntityDefinitionContent(uri: string, token?: CancellationToken): Promise<EntityDefinitionContentResult | null> {
        return this.client.sendRequest<EntityDefinitionContentResult | null>(
            'kusto/getEntityDefinitionContent',
            { uri },
            token
        );
    }

    /**
     * Asks the server to transform pasted text based on source and target connection context.
     */
    transformPaste(
        text: string,
        kind: string,
        targetUri: string,
        targetPosition: Position,
        entityCluster?: string | undefined,
        entityDatabase?: string | undefined,
        entityType?: string | undefined,
        entityName?: string | undefined,
    ): Promise<string | null> {
        return this.client.sendRequest<string | null>(
            'kusto/transformPaste',
            {
                text,
                kind,
                textDocument: { uri: targetUri },
                position: targetPosition,
                entityCluster,
                entityDatabase,
                entityType,
                entityName
            }
        );
    }

    /**
     * Refreshes the schema cache for a cluster or specific database on the server.
     */
    refreshSchema(cluster: string, database?: string): Promise<void> {
        return this.client.sendRequest<void>(
            'kusto/refreshSchema',
            { cluster, database }
        );
    }

    /**
     * Refreshes the schema cache for all databases referenced by a document.
     */
    refreshDocumentSchema(uri: string): Promise<void> {
        return this.client.sendRequest<void>(
            'kusto/refreshDocumentSchema',
            { uri }
        );
    }

    /**
     * Infers the connection for a document based on its content.
     */
    inferDocumentConnection(uri: string): Promise<InferDocumentConnectionResult | null> {
        return this.client.sendRequest<InferDocumentConnectionResult | null>(
            'kusto/inferDocumentConnection',
            { uri }
        );
    }

    /**
     * Ensures the server has a document. If not, it will be added with the provided text.
     * Always triggers a kusto/documentReady notification from the server.
     */
    ensureDocument(uri: string, text: string): Promise<void> {
        return this.client.sendRequest<void>(
            'kusto/ensureDocument',
            { uri, text }
        );
    }

    /**
     * Validates a query and returns any diagnostics.
     */
    validateQuery(
        query: string,
        cluster: string,
        database?: string
    ): Promise<ValidateQueryResult | null> {
        return this.client.sendRequest<ValidateQueryResult | null>(
            'kusto/validateQuery',
            { query, cluster, database }
        );
    }

    /**
     * Gets the minified form of a query.
     */
    getMinifiedQuery(query: string): Promise<GetMinifiedQueryResult | null> {
        return this.client.sendRequest<GetMinifiedQueryResult | null>(
            'kusto/getMinifiedQuery',
            { query }
        );
    }

    // ─── Notifications (client → server) ──────────────────────────────

    /**
     * Notifies the server that the connections list has been updated.
     */
    sendConnectionsUpdated(connections: string[]): void {
        void this.client.sendNotification('kusto/connectionsUpdated', { connections });
    }

    /**
     * Notifies the server that a document's connection has changed.
     */
    sendDocumentConnectionChanged(uri: string, cluster: string | null, database: string | null, serverKind: string | null): void {
        void this.client.sendNotification('kusto/documentConnectionChanged', { uri, cluster, database, serverKind });
    }

    // ─── Notifications (server → client) ────────────────────────────────

    /**
     * Registers a handler for the server's documentReady notification.
     */
    onDocumentReady(handler: (params: DocumentReadyNotification) => void): Disposable {
        return this.client.onNotification('kusto/documentReady', handler);
    }

    /**
     * Registers a handler for the server's semantic tokens refresh notification.
     */
    onSemanticTokensRefresh(handler: () => void): Disposable {
        return this.client.onNotification('workspace/semanticTokens/refresh', handler);
    }

    // ─── Server Capabilities ────────────────────────────────────────────

    /**
     * Gets the initialize result from the language server (server capabilities, etc.).
     */
    get initializeResult() {
        return this.client.initializeResult;
    }
}

/**
 * Null Object implementation of IServer.
 * Returns safe defaults (null, empty, no-op) for all operations.
 * Used when no language server is available so all components can still be
 * constructed and registered without conditional guards.
 */
export class NullServer implements IServer {
    private static readonly noopDisposable: Disposable = { dispose() {} };

    runQuery(): Promise<RunQueryResult | null> { return Promise.resolve(null); }
    getQueryResultType(): Promise<GetQueryResultTypeResult | null> { return Promise.resolve(null); }
    getFunctionResultType(): Promise<GetFunctionResultTypeResult | null> { return Promise.resolve(null); }
    getQueryRanges(): Promise<QueryRangesResult | null> { return Promise.resolve(null); }
    getQueryRange(): Promise<Range | null> { return Promise.resolve(null); }
    getServerKind(): Promise<ServerKindResult | null> { return Promise.resolve(null); }
    decodeConnectionString(): Promise<DecodeConnectionStringResult | null> { return Promise.resolve(null); }
    getServerInfo(): Promise<ServerInfoResult | null> { return Promise.resolve(null); }
    getDatabaseInfo(): Promise<DatabaseInfo | null> { return Promise.resolve(null); }
    getEntityAsCommand(): Promise<string | null> { return Promise.resolve(null); }
    getEntityAsExpression(): Promise<string | null> { return Promise.resolve(null); }
    getQueryAsHtml(): Promise<QueryAsHtmlResult | null> { return Promise.resolve(null); }
    getDataAsExpression(): Promise<DataAsExpression | null> { return Promise.resolve(null); }
    getTableAsExpression(_table: ResultTable): Promise<string | null> { return Promise.resolve(null); }
    getEntityDefinitionContent(): Promise<EntityDefinitionContentResult | null> { return Promise.resolve(null); }
    transformPaste(): Promise<string | null> { return Promise.resolve(null); }
    refreshSchema(): Promise<void> { return Promise.resolve(); }
    refreshDocumentSchema(): Promise<void> { return Promise.resolve(); }
    inferDocumentConnection(): Promise<InferDocumentConnectionResult | null> { return Promise.resolve(null); }
    ensureDocument(): Promise<void> { return Promise.resolve(); }
    validateQuery(): Promise<ValidateQueryResult | null> { return Promise.resolve(null); }
    getMinifiedQuery(): Promise<GetMinifiedQueryResult | null> { return Promise.resolve(null); }
    sendConnectionsUpdated(): void {}
    sendDocumentConnectionChanged(): void {}
    onDocumentReady(): Disposable { return NullServer.noopDisposable; }
    onSemanticTokensRefresh(): Disposable { return NullServer.noopDisposable; }
    get initializeResult(): undefined { return undefined; }
}

export interface DatabaseTableInfo {
    name: string;
    columns?: DatabaseColumnInfo[];
    description?: string;
    folder?: string;
}

export interface DatabaseExternalTableInfo
{
    name: string;
    columns?: DatabaseColumnInfo[];
    description?: string;
    folder?: string;
}

export interface DatabaseMaterializedViewInfo
{
    name: string;
    source: string;
    query: string;
    columns?: DatabaseColumnInfo[];
    description?: string;
    folder?: string;
}

export interface DatabaseColumnInfo {
    name: string;
    type: string;
    description?: string;
}

export interface DatabaseFunctionInfo {
    name: string;
    parameters?: string;
    body?: string;
    description?: string;
    folder?: string;
}

export interface DatabaseEntityGroupInfo {
    name: string;
    entities?: string[];
    description?: string;
    folder?: string;
}

export interface DatabaseGraphModelInfo {
    name: string;
    model?: string;
    snapshots?: string[];
    description?: string;
    folder?: string;
}

export interface DatabaseStoredQueryResultInfo
{
    name: string;
    columns?: DatabaseColumnInfo[];
    description?: string;
    folder?: string;
}

export interface DatabaseInfo {
    name: string;
    alternateName?: string;
    tables?: DatabaseTableInfo[];
    externalTables?: DatabaseExternalTableInfo[];
    materializedViews?: DatabaseMaterializedViewInfo[];
    functions?: DatabaseFunctionInfo[];
    entityGroups?: DatabaseEntityGroupInfo[];
    graphModels?: DatabaseGraphModelInfo[];
    storedQueryResults?: DatabaseStoredQueryResultInfo[];
}

/** Result of running a query and returning results as ResultData. */
export interface RunQueryResult {
    data?: ResultData;
    connection?: string;
    cluster?: string;
    database?: string;
    error?: QueryDiagnostic;
}

/** Result of getting the query result type. */
export interface GetQueryResultTypeResult {
    resultType?: string;
}

/** Result of getting a function's result type. */
export interface GetFunctionResultTypeResult {
    resultType?: string;
}

/** Error from running a query. */
export interface QueryDiagnostic {
    message: string,
    details?: string,
    range?: Range
}

/** Result of getting query as HTML. */
export interface QueryAsHtmlResult {
    html: string;
}

/** Result of getting data as a KQL expression. */
export interface DataAsExpression {
    expression: string;
}

/** Serializable representation of a query execution result. */
export interface ResultData {
    query?: string;
    cluster?: string;
    database?: string;
    executionStartedAt?: string;
    executionDurationMs?: number;
    clientRequestId?: string;
    tables: ResultTable[];
    charts?: ResultChart[];
    tableViews?: ResultTableView[];
}

/**
 * Per-table presentation state. Looked up by `name` (matches
 * `ResultTable.name`). Optional/absent fields mean "use default behavior"
 * (original column order, auto width).
 */
export interface ResultTableView {
    /** Name of the `ResultTable` this view applies to. */
    name: string;
    /**
     * Display order for columns. Each entry is the index into the table's
     * original `columns[]` array, plus an optional pixel width. The array
     * must be a permutation of valid column indices to fully describe the
     * order; if it is shorter, missing columns are appended in their
     * original order. Entries with out-of-range indices are ignored.
     */
    columns?: Array<{ index: number; width?: number }>;
}

/** Serializable representation of a named chart bound to an optional result table. */
export interface ResultChart {
    name?: string;
    tableName?: string;
    options: ChartOptions;
}

/** Serializable representation of a data table. */
export interface ResultTable {
    name: string;
    columns: ResultColumn[];
    rows: (unknown | null)[][];
}

/** Serializable representation of a table column. */
export interface ResultColumn {
    name: string;
    type: string;
}

/** Serializable representation of chart visualization options. */
export interface ChartOptions {
    type: string;
    title?: string;
    xTitle?: string;
    yTitle?: string;
    xColumn?: string;
    yColumns?: string[];
    seriesColumns?: string[];
    anomalyColumns?: string[];
    yLayout?: string | undefined;
    yMirror?: boolean | undefined;
    xAxis?: string;
    yAxis?: string;
    xMin?: unknown;
    xMax?: unknown;
    yMin?: unknown;
    yMax?: unknown;
    accumulate?: boolean;
    zTitle?: string;
    xShowTicks?: boolean;
    yShowTicks?: boolean;
    xShowGrid?: boolean;
    yShowGrid?: boolean;
    xTickAngle?: number;
    yTickAngle?: number;
    showValues?: boolean;
    sort?: string;
    legendPosition?: string;
    mode?: string;
    aspectRatio?: string;
    textSize?: string;
    showMarkers?: boolean;
    markerOutline?: boolean;
    markerShape?: 'Circle' | 'Diamond' | 'Square' | 'TriangleUp' | 'Cross' | 'Star' | 'X';
    cycleMarkerShapes?: boolean;
    markerSize?: string;
    binSize?: string;
    aggregation?: string;
    maxSeries?: number;
    maxPointsPerSeries?: number;
}

/** Position in a document. */
export interface Position {
    line: number;
    character: number;
}

/** Range in a document. */
export interface Range {
    start: Position;
    end: Position;
}

/** Result of getting query ranges for a document. */
export interface QueryRangesResult {
    uri: string;
    ranges: Range[];
}

/** Result of getting the server kind for a connection. */
export interface ServerKindResult {
    serverKind: string;
}

/** Result of decoding a connection string. */
export interface DecodeConnectionStringResult {
    cluster: string;
    database?: string;
}

/** Result of getting server info (databases) for a connection. */
export interface ServerInfoResult {
    cluster: string;
    databases: DatabaseName[];
}

export interface DatabaseName {
    name: string;
    alternateName?: string;
}

/** Selection range passed to runQuery. */
export interface SelectionRange {
    start: Position;
    end: Position;
}

/** Result of getting entity definition content. */
export interface EntityDefinitionContentResult {
    content: string;
}



/** Result of inferring a document's connection from its content. */
export interface InferDocumentConnectionResult {
    connection?: string;
    cluster?: string;
    database?: string;
}



/** Notification sent by the server when a document has been fully processed and is ready. */
export interface DocumentReadyNotification {
    uri: string;
}

/** Parameters for the server's getData request. */
export interface GetDataParams {
    key: string;
}

/** Parameters for the server's setData request. */
export interface SetDataParams {
    key: string;
    data: object | undefined;
}



/** A diagnostic from validating a query. */
export interface ValidateQueryDiagnostic {
    range: Range;
    code?: string;
    message: string;
    severity: number;
}

/** Result of validating a query. */
export interface ValidateQueryResult {
    diagnostics: ValidateQueryDiagnostic[];
}



/** Result of getting a minified query. */
export interface GetMinifiedQueryResult {
    minifiedQuery?: string;
}

