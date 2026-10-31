// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * This module converts a query result table into RFC 4180 comma-separated
 * values (CSV) for export to a file. It is pure (no VS Code APIs) so it runs
 * unchanged on the desktop and web extension hosts.
 */

import type { ResultTable } from './server';

const CRLF = '\r\n';

/**
 * Converts a ResultTable to RFC 4180 CSV text: a header row of column names,
 * then one record per row, every record terminated by CRLF. No byte-order mark
 * is written. Returns an empty string if the table has no columns.
 */
export function resultTableToCsv(table: ResultTable): string {
    if (table.columns.length === 0) {
        return '';
    }

    let csv = table.columns.map(col => escapeCsvField(col.name)).join(',') + CRLF;
    for (const row of table.rows) {
        csv += table.columns.map((_, i) => escapeCsvField(formatCsvValue(row[i]))).join(',') + CRLF;
    }
    return csv;
}

/**
 * Formats a cell as the exact text the result carries: strings (datetime,
 * timespan, guid, and longs the web host kept as decimal strings) verbatim,
 * dynamic objects as JSON, null as an empty field.
 *
 * Integers are only as exact as the transport that delivered them: on desktop
 * the C# server sends `long` as a JSON number and the LSP client's JSON.parse
 * rounds values beyond ±2^53 before they reach this module.
 */
export function formatCsvValue(value: unknown): string {
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    return String(value);
}

/**
 * Quotes a field when it contains a comma, double quote, CR, or LF, doubling
 * any inner quotes (RFC 4180 §2.6–2.7). Other fields are written verbatim.
 */
export function escapeCsvField(value: string): string {
    if (/[",\r\n]/.test(value)) {
        return '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
}

/** Returns a file name for exporting a table, replacing characters that file systems reject. */
export function csvFileNameForTable(tableName: string | undefined): string {
    const base = (tableName ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
    return `${base || 'results'}.csv`;
}
