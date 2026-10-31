// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Host-independent: shared by the desktop and web builds. The LSP-backed
// implementation lives in lspServer.ts (desktop only).

import type { InitializeResult } from 'vscode-languageclient';
import type { CancellationToken, Disposable } from 'vscode';

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
 * Null Object implementation of IServer.
 * Returns safe defaults (null, empty, no-op) for all operations.
 * Used when no language server is available so all components can still be
 * constructed and registered without conditional guards.
 */
export class NullServer implements IServer {
    protected static readonly noopDisposable: Disposable = { dispose() {} };

    runQuery(_query: string, _cluster?: string, _database?: string, _isReadOnly?: boolean, _maxRows?: number, _clientRequestId?: string): Promise<RunQueryResult | null> { return Promise.resolve(null); }
    getQueryResultType(): Promise<GetQueryResultTypeResult | null> { return Promise.resolve(null); }
    getFunctionResultType(): Promise<GetFunctionResultTypeResult | null> { return Promise.resolve(null); }
    getQueryRanges(_uri: string): Promise<QueryRangesResult | null> { return Promise.resolve(null); }
    getQueryRange(_uri: string, _position: Position): Promise<Range | null> { return Promise.resolve(null); }
    getServerKind(_connection: string): Promise<ServerKindResult | null> { return Promise.resolve(null); }
    decodeConnectionString(_connectionString: string): Promise<DecodeConnectionStringResult | null> { return Promise.resolve(null); }
    getServerInfo(_connection: string, _serverKind: string | null): Promise<ServerInfoResult | null> { return Promise.resolve(null); }
    getDatabaseInfo(_cluster: string, _database: string): Promise<DatabaseInfo | null> { return Promise.resolve(null); }
    getEntityAsCommand(): Promise<string | null> { return Promise.resolve(null); }
    getEntityAsExpression(): Promise<string | null> { return Promise.resolve(null); }
    getQueryAsHtml(): Promise<QueryAsHtmlResult | null> { return Promise.resolve(null); }
    getDataAsExpression(): Promise<DataAsExpression | null> { return Promise.resolve(null); }
    getTableAsExpression(_table: ResultTable): Promise<string | null> { return Promise.resolve(null); }
    getEntityDefinitionContent(): Promise<EntityDefinitionContentResult | null> { return Promise.resolve(null); }
    transformPaste(): Promise<string | null> { return Promise.resolve(null); }
    refreshSchema(_cluster: string, _database?: string): Promise<void> { return Promise.resolve(); }
    refreshDocumentSchema(): Promise<void> { return Promise.resolve(); }
    inferDocumentConnection(): Promise<InferDocumentConnectionResult | null> { return Promise.resolve(null); }
    ensureDocument(): Promise<void> { return Promise.resolve(); }
    validateQuery(): Promise<ValidateQueryResult | null> { return Promise.resolve(null); }
    getMinifiedQuery(): Promise<GetMinifiedQueryResult | null> { return Promise.resolve(null); }
    sendConnectionsUpdated(_connections: string[]): void {}
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
    chartViews?: ResultChartView[];
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

/**
 * Per-chart presentation state. Looked up by matching `name` (if set) or
 * `tableName`. Optional/absent fields mean "use default behavior".
 */
export interface ResultChartView {
    /** Matches `ResultChart.name`, if the chart has one. */
    name?: string;
    /** Matches `ResultChart.tableName`, if the chart is bound to a specific table. */
    tableName?: string;
    /** Graph chart-specific state: cached node positions keyed by node id. */
    graph?: {
        /**
         * Layout seed used to make the cose layout reproducible. Absent means
         * "derive from a hash of the data" (the default first-render seed).
         * Changed by the user via the reroll button.
         */
        seed?: number;
        /** Full snapshot of node positions, keyed by node id. */
        positions?: { [nodeId: string]: { x: number; y: number } };
        /** True once the user has manually dragged any node. */
        manual?: boolean;
    };
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
    // Graph chart options
    nodesTable?: string;
    nodeIdColumn?: string;
    nodeLabelColumn?: string;
    nodeKindColumn?: string;
    edgeKindColumn?: string;
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

