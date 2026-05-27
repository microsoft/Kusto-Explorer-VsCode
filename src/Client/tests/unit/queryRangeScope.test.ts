// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';
import { isQueryRangeInScope } from '../../features/queryRangeScope';
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

describe('isQueryRangeInScope', () => {
    const queryRange = range(2, 0, 4, 20);

    it('returns true when the cursor is inside the query range', () => {
        expect(isQueryRangeInScope(queryRange, [selection(3, 5, 3, 5)])).toBe(true);
    });

    it('returns true when the cursor is at the end of the query range', () => {
        expect(isQueryRangeInScope(queryRange, [selection(4, 20, 4, 20)])).toBe(true);
    });

    it('returns true when a selection intersects the query range', () => {
        expect(isQueryRangeInScope(queryRange, [selection(1, 0, 2, 5)])).toBe(true);
    });

    it('returns true when any selection intersects the query range', () => {
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
});
