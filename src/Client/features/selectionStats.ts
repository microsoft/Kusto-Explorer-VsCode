// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Selection statistics — aggregate math for the results grid status bar.
 *
 * The webview owns the selection but only ever receives display strings, so
 * the aggregates are computed here in the extension host where the raw typed
 * cell values and their Kusto column types are still available. This module
 * is deliberately pure so it can be unit-tested without a webview.
 *
 * Precision policy: aggregates are computed in IEEE-754 double precision, so
 * `long` values beyond 2^53 and high-precision `decimal` values are subject to
 * the same rounding any double-based arithmetic would incur. That matches what
 * the grid can meaningfully display in a one-line status bar; callers needing
 * exact 64/128-bit results should aggregate in the query itself.
 */

import { isNumericType } from './chartProvider';
import type { ResultTable } from './server';

/**
 * Aggregates for the current grid selection.
 *
 * `cellCount` counts every selected cell regardless of type, so the status
 * bar can always report a selection size. The numeric aggregates describe
 * only the numeric, non-null cells within the selection and are `undefined`
 * when there are none — a mixed selection still reports Count plus the
 * aggregates for whichever cells are numeric.
 */
export interface SelectionStats {
    /** Total selected cells, including non-numeric and null cells. */
    cellCount: number;
    /** Selected cells that contributed to the numeric aggregates. */
    numericCount: number;
    sum?: number;
    avg?: number;
    min?: number;
    max?: number;
}

/**
 * Reads a cell as a finite number, or returns undefined when it should not
 * participate in the aggregates.
 *
 * Only cells in numeric columns are considered, so a numeric-looking string
 * in a `string` column is deliberately ignored. Kusto's `decimal` and 64-bit
 * `long` values can arrive as strings to avoid precision loss in JSON, so
 * numeric columns accept a string that parses cleanly. `null` (and the empty
 * string that represents it) is skipped rather than counted as zero, which
 * would drag Avg and Min toward zero.
 */
function toNumericValue(value: unknown): number | undefined {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed === '') return undefined;
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    if (typeof value === 'bigint') {
        // Mirror the number/string paths: a bigint beyond the double range
        // converts to Infinity, which would poison sum/min/max and render a
        // labelled-but-empty aggregate ("Sum:") once formatStatValue drops it.
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

/**
 * Computes selection aggregates over the given original-data row and column
 * indices. Out-of-range indices are ignored so a stale selection reported by
 * the webview can never throw. Returns undefined when the selection is empty,
 * meaning the status bar should be hidden.
 *
 * @param table The full result table holding raw typed values.
 * @param rows  Original-data row indices in the selection.
 * @param cols  Original-data column indices in the selection.
 */
export function computeSelectionStats(
    table: ResultTable,
    rows: readonly number[],
    cols: readonly number[],
): SelectionStats | undefined {
    const rowIdx = rows.filter(i => Number.isInteger(i) && i >= 0 && i < table.rows.length);
    const colIdx = cols.filter(i => Number.isInteger(i) && i >= 0 && i < table.columns.length);
    if (rowIdx.length === 0 || colIdx.length === 0) return undefined;

    let cellCount = 0;
    let numericCount = 0;
    let sum = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;

    for (const c of colIdx) {
        const numericColumn = isNumericType(table.columns[c]!.type);
        for (const r of rowIdx) {
            cellCount++;
            if (!numericColumn) continue;
            const value = toNumericValue(table.rows[r]![c]);
            if (value === undefined) continue;
            numericCount++;
            sum += value;
            if (value < min) min = value;
            if (value > max) max = value;
        }
    }

    if (cellCount === 0) return undefined;
    if (numericCount === 0) return { cellCount, numericCount: 0 };
    return { cellCount, numericCount, sum, avg: sum / numericCount, min, max };
}

/**
 * Formats an aggregate for display. Integral results render without a
 * decimal point; fractional results are rounded to six decimal places
 * and trimmed of trailing zeros so Avg stays readable without inventing
 * precision. Magnitudes beyond the readable fixed range fall back to
 * exponential notation.
 */
export function formatStatValue(value: number): string {
    if (!Number.isFinite(value)) return '';
    if (Number.isInteger(value) && Math.abs(value) < 1e21) return String(value);
    if (value !== 0 && (Math.abs(value) < 1e-6 || Math.abs(value) >= 1e21)) {
        return value.toExponential(6).replace(/\.?0+e/, 'e');
    }
    return value.toFixed(6).replace(/\.?0+$/, '');
}

/**
 * Renders the status bar text, e.g. `Count: 6  Sum: 60  Avg: 10  Min: 5  Max: 15`.
 * A selection with no numeric cells reports Count alone. Returns an empty
 * string when there is nothing to show.
 */
export function formatSelectionStats(stats: SelectionStats | undefined): string {
    if (!stats || stats.cellCount === 0) return '';
    const parts = [`Count: ${stats.cellCount}`];
    if (stats.numericCount > 0) {
        parts.push(`Sum: ${formatStatValue(stats.sum!)}`);
        parts.push(`Avg: ${formatStatValue(stats.avg!)}`);
        parts.push(`Min: ${formatStatValue(stats.min!)}`);
        parts.push(`Max: ${formatStatValue(stats.max!)}`);
    }
    return parts.join('\u2003');
}
