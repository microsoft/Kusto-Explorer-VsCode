// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { Position, Range, SelectionRange } from './server';

function comparePositions(left: Position, right: Position): number {
    if (left.line !== right.line) {
        return left.line - right.line;
    }

    return left.character - right.character;
}

function isEmptyRange(range: SelectionRange): boolean {
    return comparePositions(range.start, range.end) === 0;
}

function normalizeRange(range: SelectionRange): SelectionRange {
    return comparePositions(range.start, range.end) <= 0
        ? range
        : { start: range.end, end: range.start };
}

function containsPosition(range: Range, position: Position): boolean {
    return comparePositions(position, range.start) >= 0
        && comparePositions(position, range.end) <= 0;
}

function intersectsRange(queryRange: Range, selectionRange: SelectionRange): boolean {
    return comparePositions(selectionRange.start, queryRange.end) < 0
        && comparePositions(selectionRange.end, queryRange.start) > 0;
}

export function isQueryRangeInScope(queryRange: Range, selections: readonly SelectionRange[]): boolean {
    return selections.some(selection => {
        const normalizedSelection = normalizeRange(selection);
        return isEmptyRange(normalizedSelection)
            ? containsPosition(queryRange, normalizedSelection.start)
            : intersectsRange(queryRange, normalizedSelection);
    });
}
