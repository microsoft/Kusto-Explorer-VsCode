// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';
import { getQueryLensVisibility, isQueryRangeInScope } from '../../features/queryRangeScope';
import type { Range, SelectionRange } from '../../features/server';

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number): Range {
    return {
        start: { line: startLine, character: startCharacter },
        end: { line: endLine, character: endCharacter }
    };
}

function selection(startLine: number, startCharacter: number, endLine: number, endCharacter: number): SelectionRange {
    return range(startLine, startCharacter, endLine, endCharacter);
}

const queryRange = range(2, 0, 4, 20);

describe('isQueryRangeInScope', () => {
    it('returns true when the cursor is inside the query range', () => {
        expect(isQueryRangeInScope(queryRange, [selection(3, 5, 3, 5)])).toBe(true);
    });

    it('returns true when the cursor is at the start of the query range', () => {
        expect(isQueryRangeInScope(queryRange, [selection(2, 0, 2, 0)])).toBe(true);
    });

    it('returns true when the cursor is at the end of the query range', () => {
        expect(isQueryRangeInScope(queryRange, [selection(4, 20, 4, 20)])).toBe(true);
    });

    it('returns true when a selection intersects the query range', () => {
        expect(isQueryRangeInScope(queryRange, [selection(1, 0, 2, 5)])).toBe(true);
    });

    it('returns true when any selection in a multi-selection intersects the query range', () => {
        expect(isQueryRangeInScope(queryRange, [
            selection(0, 0, 0, 0),
            selection(3, 0, 3, 8)
        ])).toBe(true);
    });

    it('normalizes reversed selections before checking scope', () => {
        expect(isQueryRangeInScope(queryRange, [selection(3, 8, 3, 0)])).toBe(true);
    });

    it('returns false when there are no active selections', () => {
        expect(isQueryRangeInScope(queryRange, [])).toBe(false);
    });

    it('returns false when the cursor is outside the query range', () => {
        expect(isQueryRangeInScope(queryRange, [selection(5, 0, 5, 0)])).toBe(false);
    });

    it('returns false when a selection only touches the query start boundary', () => {
        expect(isQueryRangeInScope(queryRange, [selection(1, 0, 2, 0)])).toBe(false);
    });

    it('returns false when a selection only touches the query end boundary', () => {
        expect(isQueryRangeInScope(queryRange, [selection(4, 20, 5, 0)])).toBe(false);
    });
});

describe('getQueryLensVisibility', () => {
    describe('when scoping to the active query is disabled (default)', () => {
        const options = { scopeToActiveQuery: false, isRunning: false };

        it('shows lenses for a query range that holds the cursor', () => {
            expect(getQueryLensVisibility(queryRange, [selection(3, 0, 3, 0)], options))
                .toEqual({ showQueryLenses: true, showRunningLens: false });
        });

        it('shows lenses for a query range that does not hold the cursor', () => {
            expect(getQueryLensVisibility(queryRange, [selection(9, 0, 9, 0)], options))
                .toEqual({ showQueryLenses: true, showRunningLens: false });
        });

        it('shows lenses when there is no active selection at all', () => {
            expect(getQueryLensVisibility(queryRange, [], options))
                .toEqual({ showQueryLenses: true, showRunningLens: false });
        });

        it('shows the full lens set for a running query rather than only the indicator', () => {
            expect(getQueryLensVisibility(queryRange, [], { scopeToActiveQuery: false, isRunning: true }))
                .toEqual({ showQueryLenses: true, showRunningLens: false });
        });
    });

    describe('when scoping to the active query is enabled', () => {
        it('shows lenses only for the query range that holds the cursor', () => {
            expect(getQueryLensVisibility(queryRange, [selection(3, 0, 3, 0)], { scopeToActiveQuery: true, isRunning: false }))
                .toEqual({ showQueryLenses: true, showRunningLens: false });
        });

        it('hides lenses for a query range that does not hold the cursor', () => {
            expect(getQueryLensVisibility(queryRange, [selection(9, 0, 9, 0)], { scopeToActiveQuery: true, isRunning: false }))
                .toEqual({ showQueryLenses: false, showRunningLens: false });
        });

        it('hides lenses when the document has no active selection', () => {
            expect(getQueryLensVisibility(queryRange, [], { scopeToActiveQuery: true, isRunning: false }))
                .toEqual({ showQueryLenses: false, showRunningLens: false });
        });

        it('keeps the running indicator for an out-of-scope query that is still running', () => {
            expect(getQueryLensVisibility(queryRange, [selection(9, 0, 9, 0)], { scopeToActiveQuery: true, isRunning: true }))
                .toEqual({ showQueryLenses: false, showRunningLens: true });
        });

        it('shows the full lens set, not just the indicator, for a running query in scope', () => {
            expect(getQueryLensVisibility(queryRange, [selection(3, 0, 3, 0)], { scopeToActiveQuery: true, isRunning: true }))
                .toEqual({ showQueryLenses: true, showRunningLens: false });
        });
    });
});
