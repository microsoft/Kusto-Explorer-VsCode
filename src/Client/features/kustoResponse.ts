// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Pure, host-independent mapping from raw Kusto REST responses to the shapes
 * the rest of the client consumes (ResultData, DatabaseInfo, QueryDiagnostic).
 *
 * The desktop build gets these shapes from the C# language server; the web
 * build has no server, so this module mirrors the server's mapping:
 *   - result tables / charts: Server/Connections/ConnectionManager.cs ExecuteAsync,
 *     Server/Utilities/ResultData.cs ConvertCellValue,
 *     Server/Charting/ChartOptions.cs FromChartVisualizationOptions
 *   - errors: Server/Utilities/ErrorDecoder.cs
 *   - schema: Server/Schema/ServerSchemaSource.cs
 *   - query ranges: Kusto.Language CodeScript blocks (blank-line separated)
 */

import type {
    ChartOptions, DatabaseColumnInfo, DatabaseInfo, Position, QueryDiagnostic, Range,
    ResultChart, ResultColumn, ResultData, ResultTable
} from './server';

// =============================================================================
// Raw response shapes
// =============================================================================

export interface RawColumn {
    ColumnName: string;
    ColumnType?: string;
    DataType?: string;
}

export interface RawTable {
    TableName: string;
    TableKind?: string;
    TableId?: number;
    Columns: RawColumn[];
    Rows: unknown[];
}

interface RawV2Frame extends Partial<RawTable> {
    FrameType?: string;
    HasErrors?: boolean;
    OneApiErrors?: unknown[];
}

/** Raised when a successful HTTP response carries an in-band Kusto error. */
export class KustoInBandError extends Error {
    constructor(message: string, readonly body: unknown) {
        super(message);
        this.name = 'KustoInBandError';
    }
}

// =============================================================================
// JSON parsing
// =============================================================================

/**
 * Parses JSON, keeping integers outside the IEEE-754 safe range as their exact
 * decimal string instead of silently rounding them. Kusto `long` values above
 * 2^53 would otherwise display wrong. Uses the JSON.parse reviver `context.source`
 * argument where the runtime provides it (Chromium, recent Firefox/Safari);
 * elsewhere it degrades to plain JSON.parse, which is what desktop does today.
 */
export function parseJsonPreservingBigInts(text: string): unknown {
    return JSON.parse(text, function (_key: string, value: unknown, context?: { source?: string }) {
        if (typeof value === 'number'
            && !Number.isSafeInteger(value)
            && context?.source !== undefined
            && /^-?\d+$/.test(context.source)) {
            return context.source;
        }
        return value;
    } as (this: unknown, key: string, value: unknown) => unknown);
}

// =============================================================================
// Query text helpers
// =============================================================================

/** Removes leading whitespace and `//` comment lines, like Kusto.Language trivia. */
export function stripLeadingTrivia(text: string): string {
    let rest = text;
    for (;;) {
        const trimmed = rest.replace(/^\s+/, '');
        if (trimmed.startsWith('//')) {
            const newline = trimmed.indexOf('\n');
            rest = newline < 0 ? '' : trimmed.substring(newline + 1);
            continue;
        }
        return trimmed;
    }
}

/** True when the text is a management (control) command, which goes to the mgmt endpoint. */
export function isCommand(text: string): boolean {
    return stripLeadingTrivia(text).startsWith('.');
}

/** True when the text is a client directive such as `#connect`. */
export function isClientDirective(text: string): boolean {
    return stripLeadingTrivia(text).startsWith('#');
}

/** Quotes a value as a Kusto string literal. */
export function kustoStringLiteral(value: string): string {
    return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Brackets a name as `['name']` for use in commands. */
export function kustoBracketedName(name: string): string {
    return "['" + name.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "']";
}

// =============================================================================
// Query ranges (blank-line separated blocks)
// =============================================================================

/** Returns the ranges of all blank-line separated query blocks in the text. */
export function findQueryRanges(text: string): Range[] {
    const lines = text.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
    const ranges: Range[] = [];
    let start = -1;
    for (let i = 0; i <= lines.length; i++) {
        const blank = i === lines.length || lines[i]!.trim() === '';
        if (!blank && start < 0) {
            start = i;
        } else if (blank && start >= 0) {
            const end = i - 1;
            ranges.push({ start: { line: start, character: 0 }, end: { line: end, character: lines[end]!.length } });
            start = -1;
        }
    }
    return ranges;
}

/**
 * Returns the query block at a position. On a blank line between blocks the
 * preceding block is chosen (the one the user just finished typing), else the next.
 */
export function findQueryRangeAt(text: string, position: Position): Range | null {
    const ranges = findQueryRanges(text);
    const containing = ranges.find(r => position.line >= r.start.line && position.line <= r.end.line);
    if (containing) {
        return containing;
    }
    const before = ranges.filter(r => r.end.line < position.line);
    return before[before.length - 1] ?? ranges.find(r => r.start.line > position.line) ?? null;
}

// =============================================================================
// Connection strings
// =============================================================================

export interface ParsedConnectionString {
    /** Cluster endpoint URL without trailing slash, e.g. https://help.kusto.windows.net */
    clusterUrl: string;
    /** Bare host name, the cluster identity used across the client. */
    cluster: string;
    database?: string;
}

const DATA_SOURCE_KEYS = new Set(['data source', 'addr', 'address', 'network address', 'server']);
const DATABASE_KEYS = new Set(['initial catalog', 'database']);

/**
 * Parses a Kusto connection string, URL or bare host name. Only the data source
 * and database are recognised; authentication keywords are ignored because the
 * web build always authenticates with the signed-in Microsoft account.
 */
export function parseConnectionString(connection: string): ParsedConnectionString | null {
    const parts = connection.split(';').map(p => p.trim()).filter(p => p.length > 0);
    let dataSource: string | undefined;
    let database: string | undefined;
    parts.forEach((part, index) => {
        const eq = part.indexOf('=');
        if (eq < 0) {
            if (index === 0) {
                dataSource = part;
            }
            return;
        }
        const key = part.substring(0, eq).trim().toLowerCase();
        const value = part.substring(eq + 1).trim();
        if (DATA_SOURCE_KEYS.has(key)) {
            dataSource = value;
        } else if (DATABASE_KEYS.has(key)) {
            database = value;
        }
    });
    if (!dataSource) {
        return null;
    }
    let url: URL;
    try {
        url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(dataSource) ? dataSource : `https://${dataSource}`);
    } catch {
        return null;
    }
    if (!database) {
        const pathDb = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, ''));
        if (pathDb) {
            database = pathDb;
        }
    }
    const result: ParsedConnectionString = {
        clusterUrl: `${url.protocol}//${url.host}`,
        cluster: url.hostname,
    };
    if (database) {
        result.database = database;
    }
    return result;
}

// =============================================================================
// Result tables
// =============================================================================

const TYPE_ALIASES: Record<string, string> = {
    boolean: 'bool',
    date: 'datetime',
    double: 'real',
    float: 'real',
    int32: 'int',
    int64: 'long',
    time: 'timespan',
    uniqueid: 'guid',
    uuid: 'guid',
    object: 'dynamic',
    // .NET DataType names used by v1 responses that lack ColumnType
    sbyte: 'bool',
    'system.boolean': 'bool',
    'system.sbyte': 'bool',
    'system.datetime': 'datetime',
    'system.timespan': 'timespan',
    'system.guid': 'guid',
    'system.int32': 'int',
    'system.int64': 'long',
    'system.double': 'real',
    'system.string': 'string',
    'system.object': 'dynamic',
    'system.data.sqltypes.sqldecimal': 'decimal',
};

/** Normalises a Kusto/.NET type name to the Kusto.Language scalar type name. */
export function normalizeKustoType(type: string | undefined): string {
    if (!type) {
        return 'string';
    }
    const lower = type.trim().toLowerCase();
    return TYPE_ALIASES[lower] ?? lower;
}

function columnType(column: RawColumn): string {
    return normalizeKustoType(column.ColumnType ?? column.DataType);
}

const ISO_DATETIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/;

/** Converts a raw cell to what the C# server sends (ResultData.ConvertCellValue). */
export function convertCellValue(value: unknown, kustoType: string): unknown {
    if (value === null || value === undefined) {
        return null;
    }
    if (kustoType === 'bool') {
        if (typeof value === 'number') {
            return value !== 0;
        }
        if (typeof value === 'string' && /^(true|false)$/i.test(value)) {
            return value.toLowerCase() === 'true';
        }
        return value;
    }
    if (kustoType === 'datetime' && typeof value === 'string') {
        // .NET DateTime "o" format always has seven fractional digits.
        const match = ISO_DATETIME.exec(value);
        if (match) {
            return `${match[1]}.${(match[2] ?? '').padEnd(7, '0').substring(0, 7)}Z`;
        }
    }
    return value;
}

/** Maps a raw table to a ResultTable. */
export function toResultTable(table: RawTable, name: string = table.TableName): ResultTable {
    const columns: ResultColumn[] = table.Columns.map(c => ({ name: c.ColumnName, type: columnType(c) }));
    const rows = table.Rows
        .filter((row): row is unknown[] => Array.isArray(row))
        .map(row => row.map((value, i) => convertCellValue(value, columns[i]?.type ?? 'string')));
    return { name, columns, rows };
}

/** Returns the rows of a raw table as objects keyed by column name. */
export function tableToObjects(table: RawTable): Record<string, unknown>[] {
    return resultTableToObjects(toResultTable(table));
}

/** Returns the rows of a result table as objects keyed by column name. */
export function resultTableToObjects(resultTable: ResultTable): Record<string, unknown>[] {
    return resultTable.rows.map(row => {
        const record: Record<string, unknown> = {};
        resultTable.columns.forEach((c, i) => { record[c.name] = row[i]; });
        return record;
    });
}

/** Extracts the first in-band OneApiError from a v2 response, if any. */
function findInBandError(frames: RawV2Frame[]): unknown {
    for (const frame of frames) {
        if (frame.FrameType === 'DataTable' && Array.isArray(frame.Rows)) {
            for (const row of frame.Rows) {
                if (row && !Array.isArray(row) && typeof row === 'object') {
                    const errors = (row as { OneApiErrors?: unknown[] }).OneApiErrors;
                    if (errors && errors.length > 0) {
                        return errors[0];
                    }
                }
            }
        }
        if (frame.FrameType === 'DataSetCompletion' && frame.HasErrors) {
            return frame.OneApiErrors?.[0] ?? { error: { message: 'The query completed with errors.' } };
        }
    }
    return undefined;
}

/** Extracts the primary result tables of a v1 response (mgmt commands). */
export function primaryTablesFromV1(response: { Tables?: RawTable[] }): { table: RawTable; name: string }[] {
    const tables = response.Tables ?? [];
    if (tables.length > 1) {
        const toc = tables[tables.length - 1]!;
        const names = toc.Columns.map(c => c.ColumnName);
        if (names.includes('Kind') && names.includes('Ordinal') && names.includes('Name')) {
            const primary: { table: RawTable; name: string }[] = [];
            for (const row of tableToObjects(toc)) {
                const table = tables[Number(row['Ordinal'])];
                if (row['Kind'] === 'QueryResult' && table) {
                    primary.push({ table, name: String(row['Name'] ?? table.TableName) });
                }
            }
            return primary;
        }
    }
    return tables.slice(0, 1).map(table => ({ table, name: table.TableName }));
}

/** Maps a raw query (v2) or command (v1) response to tables and charts. */
export function mapResponse(response: unknown): { tables: ResultTable[]; charts?: ResultChart[] } {
    if (Array.isArray(response)) {
        const frames = response as RawV2Frame[];
        const error = findInBandError(frames);
        if (error !== undefined) {
            throw new KustoInBandError(errorMessageFromBody(error) ?? 'The query completed with errors.', error);
        }

        const visualizations = new Map<number, Record<string, unknown>>();
        for (const frame of frames) {
            if (frame.FrameType === 'DataTable' && frame.TableKind === 'QueryProperties' && frame.Rows) {
                for (const row of frame.Rows) {
                    if (Array.isArray(row) && row[1] === 'Visualization' && typeof row[0] === 'number') {
                        const value = typeof row[2] === 'string' ? safeParse(row[2]) : row[2];
                        if (value && typeof value === 'object') {
                            visualizations.set(row[0], value as Record<string, unknown>);
                        }
                    }
                }
            }
        }

        const tables: ResultTable[] = [];
        const charts: ResultChart[] = [];
        for (const frame of frames) {
            if (frame.FrameType !== 'DataTable' || frame.TableKind !== 'PrimaryResult') {
                continue;
            }
            const table = toResultTable(frame as RawTable);
            tables.push(table);
            const viz = frame.TableId !== undefined ? visualizations.get(frame.TableId) : undefined;
            const options = viz ? visualizationToChartOptions(viz) : null;
            if (options) {
                charts.push({ tableName: table.name, options });
            }
        }
        return charts.length > 0 ? { tables, charts } : { tables };
    }

    if (response && typeof response === 'object' && Array.isArray((response as { Tables?: unknown }).Tables)) {
        const tables = primaryTablesFromV1(response as { Tables: RawTable[] }).map(t => toResultTable(t.table, t.name));
        return { tables };
    }

    throw new Error('Unrecognized Kusto response.');
}

function safeParse(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

// =============================================================================
// Charts
// =============================================================================

function capitalize(value: string): string {
    return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function lower(value: unknown): string | undefined {
    return typeof value === 'string' ? value.toLowerCase() : undefined;
}

/** Mirrors ChartOptions.VisualizationToChartType. */
export function visualizationToChartType(visualization: string, kind: string | undefined): string {
    const stacked = (plain: string) =>
        kind === 'stacked' ? `${plain}Stacked` : kind === 'stacked100' ? `${plain}Stacked100` : plain;
    switch (visualization.toLowerCase()) {
        case 'areachart': return stacked('Area');
        case 'barchart': return stacked('Bar');
        case 'columnchart': return stacked('Column');
        case 'card': return 'Card';
        case 'graph': return 'Graph';
        case 'linechart': return 'Line';
        case 'piechart': return 'Pie';
        case 'pivotchart': return 'Line';
        case 'plotly': return 'Plotly';
        case 'sankey': return 'Sankey';
        case 'scatterchart': return 'Scatter';
        case 'stackedareachart': return 'AreaStacked';
        case '3dchart': return 'ThreeD';
        case 'ladderchart':
        case 'timeladderchart': return 'Ladder';
        case 'timechart': return 'TimeLine';
        case 'anomalychart': return 'TimeLineAnomaly';
        case 'timepivot': return 'TimePivot';
        case 'treemap': return 'TreeMap';
        default: return 'None';
    }
}

function axisLimit(value: unknown): unknown {
    if (value === 'NaN') return null;
    if (value === 'Infinity') return Number.MAX_VALUE;
    if (value === '-Infinity') return -Number.MAX_VALUE;
    return value;
}

function stringList(value: unknown): string[] | undefined {
    if (Array.isArray(value)) {
        return value.map(v => String(v));
    }
    if (typeof value === 'string' && value.length > 0) {
        return value.split(',').map(v => v.trim()).filter(v => v.length > 0);
    }
    return undefined;
}

/**
 * Maps a `render` Visualization property (from the QueryProperties table) to
 * ChartOptions, like ChartOptions.FromChartVisualizationOptions. Returns null
 * when the table has no visualization.
 */
export function visualizationToChartOptions(viz: Record<string, unknown>): ChartOptions | null {
    const visualization = viz['Visualization'];
    if (typeof visualization !== 'string' || visualization === '' || visualization.toLowerCase() === 'none') {
        return null;
    }

    const options: ChartOptions = {
        type: visualizationToChartType(visualization, lower(viz['Kind'])),
        xAxis: capitalize(lower(viz['XAxis']) ?? 'linear'),
        yAxis: capitalize(lower(viz['YAxis']) ?? 'linear'),
        accumulate: viz['Accumulate'] === true,
    };

    const text = (key: string): string | undefined => typeof viz[key] === 'string' ? viz[key] as string : undefined;
    const title = text('Title');
    if (title !== undefined) options.title = title;
    const xTitle = text('XTitle');
    if (xTitle !== undefined) options.xTitle = xTitle;
    const yTitle = text('YTitle');
    if (yTitle !== undefined) options.yTitle = yTitle;
    const xColumn = text('XColumn');
    if (xColumn !== undefined) options.xColumn = xColumn;
    const yColumns = stringList(viz['YColumns']);
    if (yColumns) options.yColumns = yColumns;
    const series = stringList(viz['Series']);
    if (series) options.seriesColumns = series;
    const anomalyColumns = stringList(viz['AnomalyColumns']);
    if (anomalyColumns) options.anomalyColumns = anomalyColumns;
    if (lower(viz['Legend']) === 'hidden') options.legendPosition = 'None';

    const ySplit = lower(viz['YSplit']);
    if (ySplit === 'axes') options.yLayout = 'DualAxis';
    else if (ySplit === 'panels') options.yLayout = 'SeparatePanels';

    options.xMin = axisLimit(viz['Xmin'] ?? null);
    options.xMax = axisLimit(viz['Xmax'] ?? null);
    options.yMin = axisLimit(viz['Ymin'] ?? null);
    options.yMax = axisLimit(viz['Ymax'] ?? null);
    return options;
}

// =============================================================================
// Errors
// =============================================================================

interface OneApiError {
    code?: string;
    message?: string;
    '@message'?: string;
    '@permanent'?: boolean;
    '@line'?: string | number;
    '@pos'?: string | number;
    '@token'?: string;
    innererror?: OneApiError;
}

function asOneApiError(body: unknown): OneApiError | undefined {
    if (!body || typeof body !== 'object') {
        return undefined;
    }
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === 'object') {
        return error as OneApiError;
    }
    return body as OneApiError;
}

/** Returns the error chain from outermost to innermost. */
function errorChain(error: OneApiError): OneApiError[] {
    const chain: OneApiError[] = [];
    for (let e: OneApiError | undefined = error; e && chain.length < 16; e = e.innererror) {
        chain.push(e);
    }
    return chain;
}

/** The most specific message carried by a OneApiError body, if any. */
export function errorMessageFromBody(body: unknown): string | undefined {
    if (typeof body === 'string') {
        const parsed = safeParse(body);
        return parsed === undefined ? (body.trim() || undefined) : errorMessageFromBody(parsed);
    }
    const error = asOneApiError(body);
    if (!error) {
        return undefined;
    }
    const chain = errorChain(error);
    for (let i = chain.length - 1; i >= 0; i--) {
        const message = chain[i]!['@message'] ?? chain[i]!.message;
        if (message) {
            return message;
        }
    }
    return undefined;
}

function offsetToPosition(text: string, offset: number): Position {
    const clamped = Math.max(0, Math.min(offset, text.length));
    let line = 0;
    let lineStart = 0;
    for (let i = 0; i < clamped; i++) {
        if (text.charCodeAt(i) === 10) {
            line++;
            lineStart = i + 1;
        }
    }
    return { line, character: clamped - lineStart };
}

function positionToOffset(text: string, line: number, character: number): number | undefined {
    let offset = 0;
    for (let l = 0; l < line; l++) {
        const next = text.indexOf('\n', offset);
        if (next < 0) {
            return undefined;
        }
        offset = next + 1;
    }
    return offset + character;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Finds the query-relative range an error refers to (ErrorDecoder's position resolution). */
function findErrorRange(query: string, chain: OneApiError[], message: string): Range {
    let line: number | undefined;
    let pos: number | undefined;
    let token: string | undefined;
    for (const e of chain) {
        if (e['@line'] !== undefined && e['@pos'] !== undefined) {
            line = Number(e['@line']);
            pos = Number(e['@pos']);
            token = e['@token'];
        }
    }
    if (line === undefined || pos === undefined || Number.isNaN(line) || Number.isNaN(pos)) {
        const match = /\[line:position=(\d+):(\d+)\]/.exec(message);
        if (match) {
            line = Number(match[1]);
            pos = Number(match[2]);
        }
    }
    if (line !== undefined && pos !== undefined && line >= 1 && pos >= 1) {
        const start = positionToOffset(query, line - 1, pos - 1);
        if (start !== undefined) {
            const length = token ? token.length : 1;
            return { start: offsetToPosition(query, start), end: offsetToPosition(query, start + length) };
        }
    }

    const semantic = /(?:Failed to resolve entity|named) '(.+?)'/.exec(message);
    if (semantic && semantic[1]) {
        const match = new RegExp(`\\b${escapeRegExp(semantic[1])}\\b`).exec(query);
        if (match) {
            return { start: offsetToPosition(query, match.index), end: offsetToPosition(query, match.index + semantic[1].length) };
        }
    }

    const leading = query.length - query.replace(/^\s+/, '').length;
    const trailing = query.replace(/\s+$/, '').length;
    return { start: offsetToPosition(query, leading), end: offsetToPosition(query, Math.max(leading, trailing)) };
}

/**
 * Maps a Kusto error response body to a QueryDiagnostic with a query-relative
 * range, like ErrorDecoder.GetDiagnostic. `fallbackMessage` is used when the
 * body has no OneApiError (network failures, empty 401 bodies, ...).
 */
export function diagnosticFromError(body: unknown, query: string, fallbackMessage: string): QueryDiagnostic {
    const parsed = typeof body === 'string' ? (safeParse(body) ?? body) : body;
    const error = asOneApiError(parsed);
    const message = errorMessageFromBody(parsed) ?? fallbackMessage;
    if (!error || typeof parsed !== 'object') {
        return { message };
    }
    const chain = errorChain(error);
    const permanent = chain.some(e => e['@permanent'] === true);
    return {
        message,
        details: permanent
            ? 'Error is permanent, retrying will not help'
            : 'Error may be transient, retrying may result in successful request',
        range: findErrorRange(query, chain, message),
    };
}

// =============================================================================
// Schema
// =============================================================================

/** Splits on commas that are not nested inside brackets, parentheses or quotes. */
export function splitTopLevel(text: string, separator = ','): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let current = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]!;
        if (quote) {
            current += ch;
            if (ch === '\\' && i + 1 < text.length) {
                current += text[++i];
            } else if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === '(' || ch === '[' || ch === '{') {
            depth++;
        } else if (ch === ')' || ch === ']' || ch === '}') {
            depth--;
        } else if (ch === separator && depth === 0) {
            parts.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim().length > 0) {
        parts.push(current.trim());
    }
    return parts;
}

function unbracketName(name: string): string {
    const match = /^\[\s*(['"])(.*)\1\s*\]$/.exec(name);
    if (match) {
        return match[2]!.replace(/\\(.)/g, '$1');
    }
    return name;
}

/** Parses a CslOutputSchema such as `A:string, ['b c']:int` into columns. */
export function parseCslSchema(schema: string | null | undefined): DatabaseColumnInfo[] {
    if (!schema) {
        return [];
    }
    const trimmed = schema.trim().replace(/^\(([\s\S]*)\)$/, '$1');
    return splitTopLevel(trimmed).flatMap(part => {
        const colon = part.lastIndexOf(':');
        if (colon <= 0) {
            return [];
        }
        return [{ name: unbracketName(part.substring(0, colon).trim()), type: normalizeKustoType(part.substring(colon + 1)) }];
    });
}

/** Parses an entity group definition into its entity expressions. */
export function parseEntityGroup(definition: string | null | undefined): string[] {
    let text = (definition ?? '').trim();
    const prefix = /^entity_group\s*/.exec(text);
    if (prefix) {
        text = text.substring(prefix[0].length).trim();
    }
    if (text.startsWith('[') && text.endsWith(']')) {
        text = text.substring(1, text.length - 1).trim();
    }
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
        text = text.substring(1, text.length - 1).replace(/\\(.)/g, '$1').trim();
        if (text.startsWith('[') && text.endsWith(']')) {
            text = text.substring(1, text.length - 1).trim();
        }
    }
    return splitTopLevel(text);
}

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function withOptional<T extends object>(target: T, values: Record<string, unknown>): T {
    for (const [key, value] of Object.entries(values)) {
        if (value !== undefined) {
            (target as Record<string, unknown>)[key] = value;
        }
    }
    return target;
}

function snapshotList(value: unknown): string[] {
    const parsed = typeof value === 'string' ? safeParse(value) : value;
    return Array.isArray(parsed) ? parsed.map(v => String(v)) : [];
}

export interface SchemaRows {
    identity: Record<string, unknown> | undefined;
    entities: Record<string, unknown>[];
    materializedViews?: Record<string, unknown>[];
    graphSnapshots?: Record<string, unknown>[];
}

/**
 * Builds a DatabaseInfo from `.show database identity`, `.show databases (...) entities`,
 * `.show materialized-views` and `.show graph_snapshots` rows, like ServerSchemaSource.
 */
export function buildDatabaseInfo(fallbackName: string, rows: SchemaRows): DatabaseInfo {
    const name = optionalString(rows.identity?.['DatabaseName']) ?? fallbackName;
    const info: DatabaseInfo = withOptional({ name } as DatabaseInfo, {
        alternateName: optionalString(rows.identity?.['PrettyName']),
    });

    const ofType = (type: string) => rows.entities.filter(e => e['EntityType'] === type);
    const common = (e: Record<string, unknown>) => ({
        description: optionalString(e['DocString']),
        folder: optionalString(e['Folder']),
    });
    const entityName = (e: Record<string, unknown>) => String(e['EntityName'] ?? '');

    info.tables = ofType('Table').map(e => withOptional(
        { name: entityName(e), columns: parseCslSchema(e['CslOutputSchema'] as string) }, common(e)));
    info.externalTables = ofType('ExternalTable').map(e => withOptional(
        { name: entityName(e), columns: parseCslSchema(e['CslOutputSchema'] as string) }, common(e)));

    const mvByName = new Map((rows.materializedViews ?? []).map(r => [String(r['Name']), r]));
    info.materializedViews = ofType('MaterializedView').flatMap(e => {
        const mv = mvByName.get(entityName(e));
        if (!mv) {
            return [];
        }
        return [withOptional({
            name: entityName(e),
            source: String(mv['SourceTable'] ?? ''),
            query: String(mv['Query'] ?? ''),
            columns: parseCslSchema(e['CslOutputSchema'] as string),
        }, common(e))];
    });

    info.functions = ofType('Function').map(e => withOptional({ name: entityName(e) }, {
        parameters: typeof e['CslInputSchema'] === 'string' ? e['CslInputSchema'] : undefined,
        body: typeof e['Content'] === 'string' ? e['Content'] : undefined,
        ...common(e),
    }));

    info.entityGroups = ofType('EntityGroup').map(e => withOptional(
        { name: entityName(e), entities: parseEntityGroup(e['Content'] as string) }, common(e)));

    const snapshots = new Map((rows.graphSnapshots ?? []).map(r => [String(r['ModelName']), snapshotList(r['Snapshots'])]));
    info.graphModels = ofType('Graph').map(e => withOptional(
        { name: entityName(e), snapshots: snapshots.get(entityName(e)) ?? [] },
        { model: typeof e['Content'] === 'string' ? e['Content'] : undefined, ...common(e) }));

    info.storedQueryResults = ofType('StoredQueryResult').map(e => withOptional(
        { name: entityName(e), columns: parseCslSchema(e['CslOutputSchema'] as string) }, common(e)));

    return info;
}

/** Builds the ResultData for a successful run. */
export function toResultData(response: unknown, query: string, cluster: string, database: string | undefined): ResultData {
    const mapped = mapResponse(response);
    const data: ResultData = { query, cluster, tables: mapped.tables };
    if (database !== undefined) {
        data.database = database;
    }
    if (mapped.charts) {
        data.charts = mapped.charts;
    }
    return data;
}
