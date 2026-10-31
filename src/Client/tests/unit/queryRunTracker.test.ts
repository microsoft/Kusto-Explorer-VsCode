// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';
import { QueryRunTracker } from '../../features/queryRunTracker';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

describe('QueryRunTracker', () => {
    it('returns the request value when not cancelled', async () => {
        const tracker = new QueryRunTracker();
        const run = tracker.start('id-1', 'range-a');

        const outcome = await tracker.whenCompletedOrCancelled(run, Promise.resolve(42));

        expect(outcome).toEqual({ cancelled: false, value: 42 });
    });

    it('resolves as cancelled immediately, before the request completes, and passes the run id to cancel', async () => {
        const tracker = new QueryRunTracker();
        const run = tracker.start('KustoExplorerVsCode;abc', 'range-a');
        const request = deferred<string>();

        const pending = tracker.whenCompletedOrCancelled(run, request.promise);
        expect(tracker.cancel()).toEqual(['KustoExplorerVsCode;abc']);

        expect(await pending).toEqual({ cancelled: true });
        expect(run.isCancelled).toBe(true);

        // a late result or failure is ignored
        request.reject(new Error('The query was cancelled.'));
    });

    it('cancels only the runs of the given range', async () => {
        const tracker = new QueryRunTracker();
        const a = tracker.start('id-a', 'range-a');
        const b = tracker.start('id-b', 'range-b');

        expect(tracker.cancel('range-a')).toEqual(['id-a']);
        expect(a.isCancelled).toBe(true);
        expect(b.isCancelled).toBe(false);
        expect(await tracker.whenCompletedOrCancelled(b, Promise.resolve('ok'))).toEqual({ cancelled: false, value: 'ok' });
    });

    it('does not cancel a run twice or after it finished', () => {
        const tracker = new QueryRunTracker();
        const a = tracker.start('id-a', 'range-a');
        const b = tracker.start('id-b', 'range-b');

        expect(tracker.cancel('range-a')).toEqual(['id-a']);
        expect(tracker.cancel()).toEqual(['id-b']);
        expect(tracker.cancel()).toEqual([]);

        tracker.finish(a);
        tracker.finish(b);
        expect(tracker.count).toBe(0);
        expect(tracker.cancel()).toEqual([]);
    });

    it('treats a request that completes after cancellation as cancelled', async () => {
        const tracker = new QueryRunTracker();
        const run = tracker.start('id-1', 'range-a');
        tracker.cancel();

        expect(await tracker.whenCompletedOrCancelled(run, Promise.resolve('late'))).toEqual({ cancelled: true });
    });

    it('propagates request failures when not cancelled', async () => {
        const tracker = new QueryRunTracker();
        const run = tracker.start('id-1', 'range-a');

        await expect(tracker.whenCompletedOrCancelled(run, Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    });
});
