// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * Decides which query blocks in a query set document should show query action CodeLens entries.
 * Pure logic so it can be unit tested without the VS Code UI.
 */

import type { Position, Range, SelectionRange } from './server';

/** Which CodeLens entries a single query range should contribute. */
export interface QueryLensVisibility {
    /** Show the query action lenses (Select, Run, Copy, Format, Results). */
    showQueryLenses: boolean;
    /** Show the running indicator lens for a query that is currently executing. */
    showRunningLens: boolean;
}

/** Inputs that determine query lens visibility for a single query range. */
export interface QueryLensVisibilityOptions {
    /** When true, only the query range containing the cursor/selection shows query lenses. */
    scopeToActiveQuery: boolean;
    /** Whether this query range is currently running. */
    isRunning: boolean;
}

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

/**
 * Returns true when any cursor or selection is inside the given query range.
 * An empty selection (a plain cursor) counts when it sits anywhere within the range,
 * including its boundaries; a non-empty selection counts when it overlaps the range.
 */
export function isQueryRangeInScope(queryRange: Range, selections: readonly SelectionRange[]): boolean {
    return selections.some(selection => {
        const normalizedSelection = normalizeRange(selection);
        return isEmptyRange(normalizedSelection)
            ? containsPosition(queryRange, normalizedSelection.start)
            : intersectsRange(queryRange, normalizedSelection);
    });
}

/**
 * Decides which lenses a query range contributes.
 *
 * By default every query range shows its lenses. When scoping to the active query is enabled,
 * only the range holding the cursor/selection does — except that a running query keeps its
 * running indicator visible so moving the cursor away doesn't hide that it is still executing.
 */
export function getQueryLensVisibility(
    queryRange: Range,
    selections: readonly SelectionRange[],
    options: QueryLensVisibilityOptions
): QueryLensVisibility {
    const showQueryLenses = !options.scopeToActiveQuery || isQueryRangeInScope(queryRange, selections);

    return {
        showQueryLenses,
        showRunningLens: !showQueryLenses && options.isRunning
    };
}
