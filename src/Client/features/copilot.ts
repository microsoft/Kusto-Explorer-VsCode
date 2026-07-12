// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * This module implements the @kusto chat participant and language model tools for GitHub Copilot.
 * It registers tools for querying cluster metadata, running queries, validating KQL, and inspecting schema,
 * enabling Copilot to assist users with Kusto queries using their connected database context.
 */

import * as vscode from 'vscode';
import type { IServer } from './server';
import * as server from './server';
import type { ConnectionManager } from './connectionManager';
import { ENTITY_DEFINITION_SCHEME } from './entityDefinitionProvider';
import { resultTableToMarkdown } from './markdown';
import type { ResultsViewer } from './resultsViewer';

const COPILOT_PARTICIPANT_ID = 'msKustoExplorer';
const MAX_SCHEMA_CHARS = 30000; // Approximate limit to stay within token limits

// Module-level state set once in activate(). These act as singletons for the extension's
// lifetime. A context object or closure-based approach would be cleaner for testability,
// but the copilot API's tool registration model makes that impractical.
let languageClient: IServer;

let conn: ConnectionManager;

let resultsViewer: ResultsViewer;


// =============================================================================
// Tool Handler Infrastructure
// =============================================================================

/** Resolves the cluster/database from input, falling back to the active connection. */
async function resolveConnection(input: { cluster?: string; database?: string }): Promise<{ cluster: string; database: string } | undefined> {
    let cluster = input.cluster;
    let database = input.database;
    if (!cluster || !database) {
        const active = await conn.getActiveDocumentConnection();
        if (active) {
            cluster = cluster ?? active.cluster;
            database = database ?? active.database;
        }
    }
    return cluster ? { cluster, database: database ?? '' } : undefined;
}

/** Creates a simple text result. */
function textResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

/**
 * Register a tool that just takes input and returns a string.
 * Connection resolution, error wrapping, and prepareInvocation are handled automatically.
 */
function registerTool<T>(
    context: vscode.ExtensionContext,
    id: string,
    progressMessage: string,
    handler: (input: T, token: vscode.CancellationToken) => Promise<string>
): void {
    const tool: vscode.LanguageModelTool<T> = {
        async prepareInvocation() {
            return { invocationMessage: progressMessage };
        },
        async invoke(options, token) {
            return textResult(await handler(options.input, token));
        }
    };
    context.subscriptions.push(vscode.lm.registerTool(id, tool));
}


// =============================================================================
// Activation
// =============================================================================

export function activate(context: vscode.ExtensionContext, srv: IServer, connectionManager: ConnectionManager, rv: ResultsViewer): void {
    languageClient = srv;
    conn = connectionManager;
    resultsViewer = rv;

    // Register tools
    registerTool(context, 'msKustoExplorer_getClusters', 'Getting available clusters...', getClusters);
    registerTool(context, 'msKustoExplorer_getActiveConnection', 'Getting active connection...', getActiveConnection);
    registerTool(context, 'msKustoExplorer_getDatabases', 'Getting databases...', getDatabases);
    registerTool(context, 'msKustoExplorer_getTables', 'Getting tables...', getTables);
    registerTool(context, 'msKustoExplorer_getTableColumns', 'Getting table columns...', getTableColumns);
    registerTool(context, 'msKustoExplorer_getExternalTables', 'Getting external tables...', getExternalTables);
    registerTool(context, 'msKustoExplorer_getExternalTableColumns', 'Getting external table columns...', getExternalTableColumns);
    registerTool(context, 'msKustoExplorer_getFunctions', 'Getting functions...', getFunctions);
    registerTool(context, 'msKustoExplorer_getMaterializedViews', 'Getting materialized views...', getMaterializedViews);
    registerTool(context, 'msKustoExplorer_getMaterializedViewColumns', 'Getting materialized view columns...', getMaterializedViewColumns);
    registerTool(context, 'msKustoExplorer_getEntityGroups', 'Getting entity groups...', getEntityGroups);
    registerTool(context, 'msKustoExplorer_getGraphModels', 'Getting graph models...', getGraphModels);
    registerTool(context, 'msKustoExplorer_getTableDefinition', 'Getting table definition...', getTableDefinition);
    registerTool(context, 'msKustoExplorer_getExternalTableDefinition', 'Getting external table definition...', getExternalTableDefinition);
    registerTool(context, 'msKustoExplorer_getMaterializedViewDefinition', 'Getting materialized view definition...', getMaterializedViewDefinition);
    registerTool(context, 'msKustoExplorer_getFunctionDefinition', 'Getting function definition...', getFunctionDefinition);
    registerTool(context, 'msKustoExplorer_getEntityGroupDefinition', 'Getting entity group definition...', getEntityGroupDefinition);
    registerTool(context, 'msKustoExplorer_getGraphModelDefinition', 'Getting graph model definition...', getGraphModelDefinition);
    registerTool(context, 'msKustoExplorer_getCurrentQueryText', 'Getting current query...', getCurrentQuery);
    registerTool(context, 'msKustoExplorer_getQueryRanges', 'Getting query ranges...', getQueryRanges);
    registerTool(context, 'msKustoExplorer_validateQuery', 'Validating query...', validateQuery);
    registerTool(context, 'msKustoExplorer_getQueryResultType', 'Getting query result type...', getQueryResultType);
    registerTool(context, 'msKustoExplorer_getFunctionResultType', 'Getting function result type...', getFunctionResultType);
    registerTool(context, 'msKustoExplorer_runQuery', 'Running query...', runQuery);

    // Register the Chat Participant - user invokes with @kusto
    const participant = vscode.chat.createChatParticipant(COPILOT_PARTICIPANT_ID, handleChatRequest);
    participant.iconPath = new vscode.ThemeIcon('database');
    context.subscriptions.push(participant);
}


// =============================================================================
// Tool Handlers
// =============================================================================

async function getClusters(): Promise<string> {
    const clusters = conn.getConfiguredConnections();
    if (clusters.length === 0) {
        return 'No clusters configured. Add a cluster connection first.';
    }
    return `Available clusters:\n${clusters.join('\n')}`;
}

async function getActiveConnection(): Promise<string> {
    const active = await conn.getActiveDocumentConnection();
    if (!active) {
        return 'No active connection. Open a .kql file and connect to a database.';
    }
    return `Active connection: cluster=${active.cluster}, database=${active.database ?? '(none)'}`;
}

async function getDatabases(input: { cluster?: string }): Promise<string> {
    let cluster = input.cluster;
    if (!cluster) {
        const active = await conn.getActiveDocumentConnection();
        cluster = active?.cluster;
    }
    if (!cluster) {
        return 'No cluster specified and no active connection.';
    }
    const databases = await conn.getDatabasesForCluster(cluster);
    if (databases.length === 0) {
        return `No databases found for cluster ${cluster}.`;
    }
    return `Databases in ${cluster}:\n${databases.join('\n')}`;
}

/** Helper to get a resolved schema, returning an error string on failure. */
async function getResolvedSchema(input: { cluster?: string; database?: string }): Promise<server.DatabaseInfo | string> {
    const connection = await resolveConnection(input);
    if (!connection) {
        return 'No Kusto connection available. Please connect to a cluster and database first.';
    }
    const schema = await conn.getDatabaseSchema(connection.cluster, connection.database);
    if (!schema) {
        return `Unable to fetch schema for ${connection.cluster}/${connection.database}.`;
    }
    return schema;
}

async function getTables(input: { cluster?: string; database?: string }): Promise<string> {
    const schema = await getResolvedSchema(input);
    if (typeof schema === 'string') return schema;
    const tables = schema.tables ?? [];
    if (tables.length === 0) return `No tables in ${schema.name}.`;
    return `Tables in ${schema.name}:\n${tables.map(t => t.name).join('\n')}`;
}

function formatColumns(entityType: string, name: string, columns?: server.DatabaseColumnInfo[]): string {
    if (!columns || columns.length === 0) return `No columns in ${entityType} ${name}.`;
    return `Columns in ${entityType} ${name}:\n${columns.map(c => `${c.name}: ${c.type}`).join('\n')}`;
}

async function getTableColumns(input: { cluster?: string; database?: string; table: string }): Promise<string> {
    const schema = await getResolvedSchema(input);
    if (typeof schema === 'string') return schema;
    const table = schema.tables?.find(t => t.name === input.table);
    if (!table) return `Table "${input.table}" not found in ${schema.name}.`;
    return formatColumns('table', input.table, table.columns);
}

async function getExternalTableColumns(input: { cluster?: string; database?: string; table: string }): Promise<string> {
    const schema = await getResolvedSchema(input);
    if (typeof schema === 'string') return schema;
    const table = schema.externalTables?.find(t => t.name === input.table);
    if (!table) return `External table "${input.table}" not found in ${schema.name}.`;
    return formatColumns('external table', input.table, table.columns);
}

async function getMaterializedViewColumns(input: { cluster?: string; database?: string; view: string }): Promise<string> {
    const schema = await getResolvedSchema(input);
    if (typeof schema === 'string') return schema;
    const view = schema.materializedViews?.find(v => v.name === input.view);
    if (!view) return `Materialized view "${input.view}" not found in ${schema.name}.`;
    return formatColumns('materialized view', input.view, view.columns);
}

async function getFunctions(input: { cluster?: string; database?: string }): Promise<string> {
    const schema = await getResolvedSchema(input);
    if (typeof schema === 'string') return schema;
    const functions = schema.functions ?? [];
    if (functions.length === 0) return `No functions in ${schema.name}.`;
    return `Functions in ${schema.name}:\n${functions.map(f => `${f.name}${f.parameters ?? '()'}`).join('\n')}`;
}

async function getMaterializedViews(input: { cluster?: string; database?: string }): Promise<string> {
    const schema = await getResolvedSchema(input);
    if (typeof schema === 'string') return schema;
    const views = schema.materializedViews ?? [];
    if (views.length === 0) return `No materialized views in ${schema.name}.`;
    return `Materialized views in ${schema.name}:\n${views.map(v => v.name).join('\n')}`;
}

async function getExternalTables(input: { cluster?: string; database?: string }): Promise<string> {
    const schema = await getResolvedSchema(input);
    if (typeof schema === 'string') return schema;
    const tables = schema.externalTables ?? [];
    if (tables.length === 0) return `No external tables in ${schema.name}.`;
    return `External tables in ${schema.name}:\n${tables.map(t => t.name).join('\n')}`;
}

async function getEntityGroups(input: { cluster?: string; database?: string }): Promise<string> {
    const schema = await getResolvedSchema(input);
    if (typeof schema === 'string') return schema;
    const groups = schema.entityGroups ?? [];
    if (groups.length === 0) return `No entity groups in ${schema.name}.`;
    return `Entity groups in ${schema.name}:\n${groups.map(g => g.name).join('\n')}`;
}

async function getGraphModels(input: { cluster?: string; database?: string }): Promise<string> {
    const schema = await getResolvedSchema(input);
    if (typeof schema === 'string') return schema;
    const models = schema.graphModels ?? [];
    if (models.length === 0) return `No graph models in ${schema.name}.`;
    return `Graph models in ${schema.name}:\n${models.map(m => m.name).join('\n')}`;
}

/** Input type for entity definition handlers that look up a named entity. */
interface EntityDefinitionInput { cluster?: string; database?: string; name: string }

/** Builds a kusto-entity:// URI and fetches the definition content from the language server. */
async function getEntityDefinition(input: EntityDefinitionInput, entityType: string): Promise<string> {
    const connection = await resolveConnection(input);
    if (!connection) {
        return 'No Kusto connection available. Please connect to a cluster and database first.';
    }

    const uri = `${ENTITY_DEFINITION_SCHEME}://${encodeURIComponent(connection.cluster)}/${encodeURIComponent(connection.database)}/${encodeURIComponent(entityType)}/${encodeURIComponent(input.name)}.kql`;
    const result = await languageClient.getEntityDefinitionContent(uri);
    if (!result) {
        return `${entityType} "${input.name}" not found in ${connection.cluster}/${connection.database}.`;
    }
    return result.content;
}

async function getTableDefinition(input: EntityDefinitionInput): Promise<string> {
    return getEntityDefinition(input, 'Table');
}

async function getExternalTableDefinition(input: EntityDefinitionInput): Promise<string> {
    return getEntityDefinition(input, 'ExternalTable');
}

async function getMaterializedViewDefinition(input: EntityDefinitionInput): Promise<string> {
    return getEntityDefinition(input, 'MaterializedView');
}

async function getFunctionDefinition(input: EntityDefinitionInput): Promise<string> {
    return getEntityDefinition(input, 'Function');
}

async function getEntityGroupDefinition(input: EntityDefinitionInput): Promise<string> {
    return getEntityDefinition(input, 'EntityGroup');
}

async function getGraphModelDefinition(input: EntityDefinitionInput): Promise<string> {
    return getEntityDefinition(input, 'Graph');
}

async function getCurrentQuery(): Promise<string> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'kusto') {
        return 'No active Kusto document. Open a .kql file first.';
    }

    const uri = editor.document.uri.toString();
    const cursorPos = editor.selection.active;
    const queryRange = await languageClient.getQueryRange(
        uri,
        { line: cursorPos.line, character: cursorPos.character }
    );

    if (!queryRange) {
        return 'No query found at the current cursor position.';
    }

    const range = new vscode.Range(
        queryRange.start.line, queryRange.start.character,
        queryRange.end.line, queryRange.end.character
    );
    const queryText = editor.document.getText(range);

    return `Current query (lines ${queryRange.start.line + 1}-${queryRange.end.line + 1}):\n${queryText}`;
}

async function getQueryRanges(): Promise<string> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'kusto') {
        return 'No active Kusto document. Open a .kql file first.';
    }

    const result = await languageClient.getQueryRanges(editor.document.uri.toString());
    if (!result || result.ranges.length === 0) {
        return 'No queries found in the active document.';
    }

    return `Queries in document (${result.ranges.length}):\n${result.ranges.map((r, i) =>
        `  Query ${i + 1}: lines ${r.start.line + 1}-${r.end.line + 1}`
    ).join('\n')}`;
}

async function validateQuery(input: { query: string; cluster?: string; database?: string }): Promise<string> {
    let cluster = input.cluster;
    let database = input.database;

    if (!cluster) {
        const active = await conn.getActiveDocumentConnection();
        if (active) {
            cluster = cluster ?? active.cluster;
            database = database ?? active.database;
        }
    }

    if (!cluster) {
        return 'No cluster specified and no active connection. Cannot validate query without schema context.';
    }

    const result = await languageClient.validateQuery(input.query, cluster, database);
    if (!result) {
        return 'Validation failed. The server did not return a result.';
    }

    if (result.diagnostics.length === 0) {
        return 'Query is valid. No errors or warnings found.';
    }

    return `Query has ${result.diagnostics.length} diagnostic(s):\n${result.diagnostics.map(d => {
        const severity = d.severity === 1 ? 'Error' : d.severity === 2 ? 'Warning' : 'Info';
        const line = d.range.start.line + 1;
        const col = d.range.start.character + 1;
        return `  ${severity} at line ${line}, col ${col}: ${d.message}`;
    }).join('\n')}`;
}

async function getQueryResultType(input: { query: string; cluster?: string; database?: string }): Promise<string> {
    let cluster = input.cluster;
    let database = input.database;

    if (!cluster) {
        const active = await conn.getActiveDocumentConnection();
        if (active) {
            cluster = cluster ?? active.cluster;
            database = database ?? active.database;
        }
    }

    if (!cluster) {
        return 'No cluster specified and no active connection. Cannot determine query result type.';
    }

    const result = await languageClient.getQueryResultType(input.query, cluster, database);
    if (!result || !result.resultType) {
        return 'The query does not have a determinable result type (it may not be a tabular or scalar expression).';
    }

    return result.resultType;
}

async function getFunctionResultType(input: { cluster?: string; database?: string; name: string }): Promise<string> {
    const connection = await resolveConnection(input);
    if (!connection) {
        return 'No Kusto connection available. Please connect to a cluster and database first.';
    }

    const result = await languageClient.getFunctionResultType(connection.cluster, connection.database, input.name);
    if (!result || !result.resultType) {
        return `Function "${input.name}" was not found or does not have a determinable result type.`;
    }

    return result.resultType;
}

async function runQuery(input: { query: string; cluster?: string; database?: string; maxRows?: number; showResults?: boolean }): Promise<string> {
    let cluster = input.cluster;
    let database = input.database;

    if (!cluster) {
        const active = await conn.getActiveDocumentConnection();
        if (active) {
            cluster = cluster ?? active.cluster;
            database = database ?? active.database;
        }
    }

    if (!cluster) {
        return 'No cluster specified and no active connection. Cannot run query.';
    }

    const result = await languageClient.runQuery(input.query, cluster, database, true, input.maxRows);
    if (!result) {
        return 'Query execution failed. The server did not return a result.';
    }

    if (result.error) {
        return `Query error: ${result.error.message}${result.error.details ? '\n' + result.error.details : ''}`;
    }

    if (!result.data || result.data.tables.length === 0) {
        return 'Query returned no results.';
    }

    if (input.showResults) {
        await resultsViewer.displayResultsInSingletonView(result.data, 'all');
    }

    return resultTableToMarkdown(result.data.tables[0]!);
}

// =============================================================================
// Chat Participant - User invokes with @kusto
// =============================================================================

/**
 * Handles the Copilot chat request for the @kusto participant.
 */
async function handleChatRequest(
    request: vscode.ChatRequest,
    _context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    
    // Get the active document's connection
    const activeConnection = await conn.getActiveDocumentConnection();
    
    if (!activeConnection) {
        stream.markdown('⚠️ No active Kusto connection.\n\nPlease:\n1. Open a `.kql` file\n2. Click on a database in the **Connections** panel to connect');
        return { metadata: { command: '' } };
    }
    
    if (!activeConnection.database) {
        stream.markdown(`⚠️ Connected to cluster **${activeConnection.cluster}** but no database selected.\n\nPlease click on a database in the **Connections** panel.`);
        return { metadata: { command: '' } };
    }
    
    // Fetch the database schema
    stream.progress(`Fetching schema for ${activeConnection.cluster}/${activeConnection.database}...`);
    
    let dbSchema: server.DatabaseInfo | undefined;
    try {
        dbSchema = await conn.getDatabaseSchema(activeConnection.cluster, activeConnection.database);
    } catch (error) {
        stream.markdown(`❌ Error fetching schema: ${error}`);
        return { metadata: { command: '' } };
    }
    
    if (!dbSchema) {
        stream.markdown(`❌ Unable to fetch schema for **${activeConnection.cluster}/${activeConnection.database}**.\n\nThe database may not exist or you may not have access.`);
        return { metadata: { command: '' } };
    }
    
    // Check if schema has any content
    const tableCount = (dbSchema.tables?.length ?? 0) + 
                       (dbSchema.externalTables?.length ?? 0) + 
                       (dbSchema.materializedViews?.length ?? 0);
    const functionCount = dbSchema.functions?.length ?? 0;
    
    if (tableCount === 0 && functionCount === 0) {
        stream.markdown(`⚠️ Schema for **${activeConnection.database}** appears to be empty.\n\nFound: ${JSON.stringify(dbSchema, null, 2)}`);
        return { metadata: { command: '' } };
    }
    
    // Show what we found
    stream.markdown(`Using schema from **${activeConnection.cluster}/${activeConnection.database}** (${tableCount} tables, ${functionCount} functions)\n\n---\n\n`);
    
    // Compress schema to fit within token limits
    const compressedSchema = compressSchema(dbSchema);
    
    // Combine schema context and user question into a single prompt
    const combinedPrompt = `You are a Kusto Query Language (KQL) expert assistant. 

IMPORTANT: Below is the database schema. Use ONLY these table and column names:

${compressedSchema}

Rules:
- Use ONLY the table and column names from the schema above
- Do NOT make up table or column names
- Follow KQL best practices

User question: ${request.prompt}`;

    // Use the language model to generate a response
    try {
        // Get available chat models - VS Code returns them in preference order
        const models = await vscode.lm.selectChatModels({});
        const model = models?.[0];
        
        if (model) {
            stream.markdown(`*Using model: ${model.name}*\n\n`);
            
            const messages = [
                vscode.LanguageModelChatMessage.User(combinedPrompt)
            ];
            
            const chatResponse = await model.sendRequest(messages, {}, token);
            
            for await (const fragment of chatResponse.text) {
                stream.markdown(fragment);
            }
        } else {
            stream.markdown('❌ No language model available. Please ensure GitHub Copilot is installed and active.');
        }
    } catch (error) {
        if (error instanceof vscode.LanguageModelError) {
            stream.markdown(`❌ Language model error: ${error.message}`);
        } else {
            stream.markdown(`❌ Unexpected error: ${error}`);
        }
    }
    
    return { metadata: { command: '' } };
}


// =============================================================================
// Schema Compression - Reduce schema size to fit within token limits
// =============================================================================

/**
 * Compresses the database schema to fit within token limits.
 * Prioritizes table/column names over descriptions.
 */
function compressSchema(dbSchema: server.DatabaseInfo): string {
    const lines: string[] = [];
    lines.push(`Database: ${dbSchema.name}`);
    
    // Helper to format columns compactly
    const formatColumns = (columns?: server.DatabaseColumnInfo[]): string => {
        if (!columns || columns.length === 0) return '';
        return columns.map(c => `${c.name}:${c.type}`).join(', ');
    };
    
    // Tables (most important)
    if (dbSchema.tables && dbSchema.tables.length > 0) {
        lines.push('\nTables:');
        for (const table of dbSchema.tables) {
            const cols = formatColumns(table.columns);
            lines.push(`  ${table.name}(${cols})`);
        }
    }
    
    // Materialized Views
    if (dbSchema.materializedViews && dbSchema.materializedViews.length > 0) {
        lines.push('\nMaterialized Views:');
        for (const view of dbSchema.materializedViews) {
            const cols = formatColumns(view.columns);
            lines.push(`  ${view.name}(${cols})`);
        }
    }
    
    // External Tables
    if (dbSchema.externalTables && dbSchema.externalTables.length > 0) {
        lines.push('\nExternal Tables:');
        for (const table of dbSchema.externalTables) {
            const cols = formatColumns(table.columns);
            lines.push(`  ${table.name}(${cols})`);
        }
    }
    
    // Functions (compact format)
    if (dbSchema.functions && dbSchema.functions.length > 0) {
        lines.push('\nFunctions:');
        for (const func of dbSchema.functions) {
            lines.push(`  ${func.name}${func.parameters ?? '()'}`);
        }
    }
    
    let result = lines.join('\n');
    
    // If still too large, truncate and add note
    if (result.length > MAX_SCHEMA_CHARS) {
        result = result.substring(0, MAX_SCHEMA_CHARS);
        result += '\n\n[Schema truncated due to size...]';
    }
    
    return result;
}
