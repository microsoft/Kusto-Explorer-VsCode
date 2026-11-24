// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Desktop only: the LSP client to the C# language server. The web build uses
// NullServer-based implementations of IServer instead.

import { LanguageClient } from 'vscode-languageclient/node';
import { CancellationToken, Disposable, ExtensionContext } from 'vscode';
import {
    acquireMicrosoftAuthenticationToken,
    GetAuthenticationTokenParams,
} from './authentication';
import type {
    IServer,
    RunQueryResult,
    GetQueryResultTypeResult,
    GetFunctionResultTypeResult,
    QueryRangesResult,
    Position,
    Range,
    ServerKindResult,
    DecodeConnectionStringResult,
    ServerInfoResult,
    DatabaseInfo,
    QueryAsHtmlResult,
    ResultData,
    DataAsExpression,
    ResultTable,
    EntityDefinitionContentResult,
    InferDocumentConnectionResult,
    ValidateQueryResult,
    GetMinifiedQueryResult,
    DocumentReadyNotification,
} from './server';

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

/** Parameters for the server's getData request. */
interface GetDataParams {
    key: string;
}

/** Parameters for the server's setData request. */
interface SetDataParams {
    key: string;
    data: object | undefined;
}
