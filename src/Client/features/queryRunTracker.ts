// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * Tracks in-flight query runs so they can be cancelled by query range or all at once.
 * Pure data model: no VS Code dependencies.
 */

export type QueryRunOutcome<T> =
    | { cancelled: false; value: T }
    | { cancelled: true };

export interface QueryRun {
    /** The client request id the run was started with (sent to the server as-is). */
    readonly clientRequestId: string;
    /** The query range the run belongs to. */
    readonly rangeKey: string;
    readonly isCancelled: boolean;
}

interface TrackedRun extends QueryRun {
    isCancelled: boolean;
    readonly cancelled: Promise<void>;
    readonly signalCancelled: () => void;
}

export class QueryRunTracker {
    private readonly runs = new Map<string, TrackedRun>();

    get count(): number {
        return this.runs.size;
    }

    start(clientRequestId: string, rangeKey: string): QueryRun {
        let signalCancelled!: () => void;
        const cancelled = new Promise<void>(resolve => { signalCancelled = resolve; });
        const run: TrackedRun = { clientRequestId, rangeKey, isCancelled: false, cancelled, signalCancelled };
        this.runs.set(clientRequestId, run);
        return run;
    }

    finish(run: QueryRun): void {
        if (this.runs.get(run.clientRequestId) === run) {
            this.runs.delete(run.clientRequestId);
        }
    }

    /**
     * Marks in-flight runs as cancelled: those for the given query range, or all when no range is given.
     * Returns the client request ids of the runs that were cancelled.
     */
    cancel(rangeKey?: string): string[] {
        const cancelledIds: string[] = [];
        for (const run of this.runs.values()) {
            if (!run.isCancelled && (rangeKey === undefined || run.rangeKey === rangeKey)) {
                run.isCancelled = true;
                run.signalCancelled();
                cancelledIds.push(run.clientRequestId);
            }
        }
        return cancelledIds;
    }

    /**
     * Resolves with the request's value, or as cancelled as soon as the run is cancelled.
     * A result that arrives after cancellation is ignored.
     */
    async whenCompletedOrCancelled<T>(run: QueryRun, request: Promise<T>): Promise<QueryRunOutcome<T>> {
        const tracked = this.runs.get(run.clientRequestId);
        const cancelled = tracked?.cancelled ?? new Promise<never>(() => {});
        const outcome = await Promise.race([
            request.then(value => ({ cancelled: false as const, value })),
            cancelled.then(() => ({ cancelled: true as const }))
        ]);
        return run.isCancelled ? { cancelled: true } : outcome;
    }
}
