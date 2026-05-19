// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * This module converts query result data into tab-separated-values (TSV)
 * text suitable for the system clipboard. Excel, Google Sheets, and most
 * plain-text editors paste TSV cleanly. The single-cell case (one row,
 * one column) naturally degenerates to the raw cell value with no quoting
 * or separators added.
 */

import { ResultTable } from './server';

/**
 * Converts a ResultTable to TSV text including a header row.
 * @param table The result table to convert
 * @returns Tab-separated text, one row per line; empty string if the
 *          table has no columns.
 */
export function resultTableToTsv(table: ResultTable): string {
    if (table.columns.length === 0) {
        return '';
    }

    const lines: string[] = [];
    lines.push(table.columns.map(col => escapeTsv(col.name)).join('\t'));
    for (const row of table.rows) {
        lines.push(row.map(cell => escapeTsv(formatCellValue(cell))).join('\t'));
    }
    return lines.join('\n');
}

/**
 * Formats a cell value for TSV output.
 */
export function formatCellValue(value: unknown | null): string {
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    return String(value);
}

/**
 * Excel-style TSV escaping: if the value contains a tab, newline,
 * carriage return, or double-quote, wrap it in double quotes and double
 * any inner quotes. Otherwise the value is emitted verbatim. Excel and
 * other spreadsheet apps decode this back to the original value on
 * paste, preserving multi-line and tab-containing cells.
 */
function escapeTsv(value: string): string {
    if (/[\t\r\n"]/.test(value)) {
        return '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
}
