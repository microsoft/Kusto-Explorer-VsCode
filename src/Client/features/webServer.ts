// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * IServer implementation for VS Code for the Web, where the C# language server
 * can't run. Query execution, connection decoding, schema loading and query
 * ranges go straight to the Kusto REST API through KustoWebClient. Everything
 * that needs Kusto.Language analysis (completion, diagnostics, formatting,
 * semantic tokens, entity definitions, ...) falls back to NullServer defaults.
 */

import * as vscode from 'vscode';
import { NullServer } from './server';
import type {
    DatabaseInfo, DecodeConnectionStringResult, Position, QueryRangesResult, Range,
    RunQueryResult, ServerInfoResult, ServerKindResult
} from './server';
import {
    KustoInBandError, buildDatabaseInfo, diagnosticFromError, findQueryRangeAt, findQueryRanges,
    isClientDirective, kustoBracketedName, mapResponse, parseConnectionString, resultTableToObjects, toResultData
} from './kustoResponse';
import type { ParsedConnectionString } from './kustoResponse';
import { KustoRequestError, KustoWebClient } from './kustoWebClient';
import type { ClusterTokenProvider, KustoClientFactory, KustoRequestOptions } from './kustoWebClient';

export interface WebServerOptions {
    /** Overrides the HTTP client factory (tests). */
    clientFactory?: KustoClientFactory;
    /** Returns the text of an open document; defaults to vscode.workspace.textDocuments. */
    getDocumentText?: (uri: string) => string | undefined;
}

function openDocumentText(uri: string): string | undefined {
    return vscode.workspace.textDocuments.find(d => d.uri.toString() === uri)?.getText();
}

export class WebServer extends NullServer {
    private readonly client: KustoWebClient;
    private readonly getDocumentText: (uri: string) => string | undefined;
    /** Cluster endpoint URLs by host name, remembered from connection strings seen so far. */
    private readonly clusterUrls = new Map<string, string>();

    constructor(getToken: ClusterTokenProvider, options: WebServerOptions = {}) {
        super();
        this.client = new KustoWebClient(getToken, options.clientFactory);
        this.getDocumentText = options.getDocumentText ?? openDocumentText;
    }

    // -------------------------------------------------------------------------
    // Connections
    // -------------------------------------------------------------------------

    private resolve(connection: string): ParsedConnectionString {
        const parsed = parseConnectionString(connection);
        if (!parsed) {
            throw new Error(`Invalid connection: ${connection}`);
        }
        // A bare host name maps back to the URL of a full connection string seen earlier (custom ports).
        const known = this.clusterUrls.get(parsed.cluster);
        if (known && !/[:/;=]/.test(connection.trim())) {
            return { ...parsed, clusterUrl: known };
        }
        this.clusterUrls.set(parsed.cluster, parsed.clusterUrl);
        return parsed;
    }

    override sendConnectionsUpdated(connections: string[]): void {
        for (const connection of connections) {
            try {
                this.resolve(connection);
            } catch {
                // Ignore connections that can't be parsed; they fail when used.
            }
        }
    }

    override decodeConnectionString(connectionString: string): Promise<DecodeConnectionStringResult | null> {
        const parsed = parseConnectionString(connectionString);
        if (!parsed) {
            return Promise.resolve(null);
        }
        const result: DecodeConnectionStringResult = { cluster: parsed.cluster };
        if (parsed.database) {
            result.database = parsed.database;
        }
        return Promise.resolve(result);
    }

    /** Runs a management command and returns its first result table as row objects. */
    private async commandRows(connection: string, database: string | undefined, command: string): Promise<Record<string, unknown>[]> {
        const { clusterUrl } = this.resolve(connection);
        const response = await this.client.execute(clusterUrl, database, command);
        const [table] = mapResponse(response).tables;
        return table ? resultTableToObjects(table) : [];
    }

    override async getServerKind(connection: string): Promise<ServerKindResult | null> {
        const [version] = await this.commandRows(connection, undefined, '.show version');
        const serviceType = version?.['ServiceType'];
        return { serverKind: typeof serviceType === 'string' && serviceType.length > 0 ? serviceType : 'Unknown' };
    }

    override async getServerInfo(connection: string, _serverKind: string | null): Promise<ServerInfoResult | null> {
        const { cluster } = this.resolve(connection);
        const rows = await this.commandRows(connection, undefined, '.show databases | project DatabaseName, PrettyName');
        return {
            cluster,
            databases: rows.map(r => {
                const pretty = r['PrettyName'];
                return typeof pretty === 'string' && pretty.length > 0
                    ? { name: String(r['DatabaseName']), alternateName: pretty }
                    : { name: String(r['DatabaseName']) };
            }),
        };
    }

    override async getDatabaseInfo(cluster: string, database: string): Promise<DatabaseInfo | null> {
        const [identityRows, entities] = await Promise.all([
            this.commandRows(cluster, database, '.show database identity | project DatabaseName, PrettyName'),
            this.commandRows(cluster, database, `.show databases (${kustoBracketedName(database)}) entities`),
        ]);
        const hasType = (type: string) => entities.some(e => e['EntityType'] === type);
        const [materializedViews, graphSnapshots] = await Promise.all([
            hasType('MaterializedView')
                ? this.commandRows(cluster, database, '.show materialized-views | project Name, SourceTable, Query')
                : Promise.resolve(undefined),
            hasType('Graph')
                ? this.commandRows(cluster, database, '.show graph_snapshots * | summarize Snapshots=make_list(Name) by ModelName')
                    .catch(() => undefined)
                : Promise.resolve(undefined),
        ]);
        const rows: Parameters<typeof buildDatabaseInfo>[1] = { identity: identityRows[0], entities };
        if (materializedViews) rows.materializedViews = materializedViews;
        if (graphSnapshots) rows.graphSnapshots = graphSnapshots;
        return buildDatabaseInfo(database, rows);
    }

    // -------------------------------------------------------------------------
    // Queries
    // -------------------------------------------------------------------------

    override getQueryRanges(uri: string): Promise<QueryRangesResult | null> {
        const text = this.getDocumentText(uri);
        return Promise.resolve(text === undefined ? null : { uri, ranges: findQueryRanges(text) });
    }

    override getQueryRange(uri: string, position: Position): Promise<Range | null> {
        const text = this.getDocumentText(uri);
        return Promise.resolve(text === undefined ? null : findQueryRangeAt(text, position));
    }

    override async runQuery(
        query: string,
        cluster?: string,
        database?: string,
        isReadOnly?: boolean,
        maxRows?: number,
        clientRequestId?: string,
    ): Promise<RunQueryResult | null> {
        if (query.trim().length === 0) {
            return { error: { message: 'No query' } };
        }
        if (!cluster) {
            return { error: { message: 'No connection. Choose a cluster and database before running the query.' } };
        }
        if (isClientDirective(query)) {
            return { error: { message: 'Client directives (#connect and others) are not supported in VS Code for the Web yet.' } };
        }

        let connection: ParsedConnectionString;
        try {
            connection = this.resolve(cluster);
        } catch (error) {
            return { error: { message: (error as Error).message } };
        }

        const options: KustoRequestOptions = { clientRequestId, readOnly: isReadOnly, maxRows };
        try {
            const response = await this.client.execute(connection.clusterUrl, database, query, options);
            return { data: toResultData(response, query, connection.cluster, database) };
        } catch (error) {
            if (error instanceof KustoRequestError || error instanceof KustoInBandError) {
                return { error: diagnosticFromError(error.body, query, error.message) };
            }
            return { error: { message: error instanceof Error ? error.message : String(error) } };
        }
    }

    /**
     * Cancels a running query by its client request id. Not part of IServer yet;
     * desktop cancel support will add it there.
     */
    cancelQuery(clientRequestId: string): Promise<boolean> {
        return this.client.cancel(clientRequestId);
    }
}
