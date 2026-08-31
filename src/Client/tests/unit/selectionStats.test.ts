// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';
import { computeSelectionStats, formatSelectionStats, formatStatValue } from '../../features/selectionStats';
import type { ResultTable } from '../../features/server';

function makeTable(): ResultTable {
    return {
        name: 'T',
        columns: [
            { name: 'Category', type: 'string' },
            { name: 'Value', type: 'real' },
            { name: 'Count', type: 'long' },
        ],
        rows: [
            ['A', 10, 1],
            ['B', 20, 2],
            ['C', 30, 3],
        ],
    };
}

describe('computeSelectionStats', () => {
    it('aggregates a single numeric column', () => {
        const stats = computeSelectionStats(makeTable(), [0, 1, 2], [1]);
        expect(stats).toEqual({ cellCount: 3, numericCount: 3, sum: 60, avg: 20, min: 10, max: 30 });
    });

    it('aggregates across multiple numeric columns', () => {
        const stats = computeSelectionStats(makeTable(), [0, 1], [1, 2]);
        expect(stats).toEqual({ cellCount: 4, numericCount: 4, sum: 33, avg: 8.25, min: 1, max: 20 });
    });

    it('counts every selected cell but aggregates only numeric ones', () => {
        const stats = computeSelectionStats(makeTable(), [0, 1], [0, 1]);
        expect(stats?.cellCount).toBe(4);
        expect(stats?.numericCount).toBe(2);
        expect(stats?.sum).toBe(30);
        expect(stats?.min).toBe(10);
        expect(stats?.max).toBe(20);
    });

    it('reports count only when no numeric cells are selected', () => {
        const stats = computeSelectionStats(makeTable(), [0, 1, 2], [0]);
        expect(stats).toEqual({ cellCount: 3, numericCount: 0 });
    });

    it('skips nulls rather than counting them as zero', () => {
        const table: ResultTable = {
            name: 'T',
            columns: [{ name: 'V', type: 'real' }],
            rows: [[10], [null], [20]],
        };
        const stats = computeSelectionStats(table, [0, 1, 2], [0]);
        expect(stats).toEqual({ cellCount: 3, numericCount: 2, sum: 30, avg: 15, min: 10, max: 20 });
    });

    it('parses numeric values delivered as strings', () => {
        const table: ResultTable = {
            name: 'T',
            columns: [{ name: 'V', type: 'decimal' }],
            rows: [['1.5'], ['2.5']],
        };
        expect(computeSelectionStats(table, [0, 1], [0])?.sum).toBe(4);
    });

    it('ignores numeric-looking values in non-numeric columns', () => {
        const table: ResultTable = {
            name: 'T',
            columns: [{ name: 'S', type: 'string' }],
            rows: [['10'], ['20']],
        };
        expect(computeSelectionStats(table, [0, 1], [0])).toEqual({ cellCount: 2, numericCount: 0 });
    });

    it('handles negative values in min and max', () => {
        const table: ResultTable = {
            name: 'T',
            columns: [{ name: 'V', type: 'int' }],
            rows: [[-5], [-1], [-10]],
        };
        const stats = computeSelectionStats(table, [0, 1, 2], [0]);
        expect(stats?.min).toBe(-10);
        expect(stats?.max).toBe(-1);
        expect(stats?.sum).toBe(-16);
    });

    it('ignores out-of-range indices from a stale selection', () => {
        const stats = computeSelectionStats(makeTable(), [0, 99, -1], [1, 42]);
        expect(stats).toEqual({ cellCount: 1, numericCount: 1, sum: 10, avg: 10, min: 10, max: 10 });
    });

    it('returns undefined for an empty selection', () => {
        expect(computeSelectionStats(makeTable(), [], [1])).toBeUndefined();
        expect(computeSelectionStats(makeTable(), [0], [])).toBeUndefined();
    });

    it('excludes non-finite numbers', () => {
        const table: ResultTable = {
            name: 'T',
            columns: [{ name: 'V', type: 'real' }],
            rows: [[Number.NaN], [Number.POSITIVE_INFINITY], [5]],
        };
        expect(computeSelectionStats(table, [0, 1, 2], [0])).toEqual({
            cellCount: 3, numericCount: 1, sum: 5, avg: 5, min: 5, max: 5,
        });
    });

    // Documents the module's stated precision policy: aggregation is done in
    // double precision, so a `long` past 2^53 is included but rounded rather
    // than silently dropped.
    it('includes large longs subject to double precision', () => {
        const table: ResultTable = {
            name: 'T',
            columns: [{ name: 'V', type: 'long' }],
            rows: [['9223372036854775807'], [1]],
        };
        const stats = computeSelectionStats(table, [0, 1], [0]);
        expect(stats?.numericCount).toBe(2);
        expect(stats?.max).toBe(Number('9223372036854775807'));
        expect(stats?.min).toBe(1);
    });

    it('accepts bigint cell values', () => {
        const table: ResultTable = {
            name: 'T',
            columns: [{ name: 'V', type: 'long' }],
            rows: [[10n], [20n]],
        };
        expect(computeSelectionStats(table, [0, 1], [0])).toEqual({
            cellCount: 2, numericCount: 2, sum: 30, avg: 15, min: 10, max: 20,
        });
    });

    // A bigint beyond the double range converts to Infinity; skip it like the
    // number and string paths do, so it cannot poison sum/min/max and leave a
    // labelled-but-empty aggregate in the status bar.
    it('excludes bigints too large to represent as a finite double', () => {
        const table: ResultTable = {
            name: 'T',
            columns: [{ name: 'V', type: 'long' }],
            rows: [[(10n ** 400n)], [5n]],
        };
        expect(computeSelectionStats(table, [0, 1], [0])).toEqual({
            cellCount: 2, numericCount: 1, sum: 5, avg: 5, min: 5, max: 5,
        });
    });
});

describe('formatStatValue', () => {
    it('renders integral values without a decimal point', () => {
        expect(formatStatValue(60)).toBe('60');
        expect(formatStatValue(-3)).toBe('-3');
    });

    it('trims trailing zeros on fractional values', () => {
        expect(formatStatValue(8.25)).toBe('8.25');
        expect(formatStatValue(1 / 3)).toBe('0.333333');
    });
});

describe('formatSelectionStats', () => {
    it('renders all aggregates for a numeric selection', () => {
        const text = formatSelectionStats({ cellCount: 3, numericCount: 3, sum: 60, avg: 20, min: 10, max: 30 });
        expect(text).toContain('Count: 3');
        expect(text).toContain('Sum: 60');
        expect(text).toContain('Avg: 20');
        expect(text).toContain('Min: 10');
        expect(text).toContain('Max: 30');
    });

    it('renders count alone when nothing numeric is selected', () => {
        expect(formatSelectionStats({ cellCount: 4, numericCount: 0 })).toBe('Count: 4');
    });

    it('renders nothing for an absent or empty selection', () => {
        expect(formatSelectionStats(undefined)).toBe('');
        expect(formatSelectionStats({ cellCount: 0, numericCount: 0 })).toBe('');
    });
});
