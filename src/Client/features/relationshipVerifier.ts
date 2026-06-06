// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * relationshipVerifier.ts — data-driven verification of candidate FK/PK edges.
 *
 * Inference (heuristic or AI) only looks at NAMES and TYPES, so it can't tell a
 * real foreign key from a coincidental name match (or an AI hallucination). This
 * module checks each candidate edge against the actual DATA: sample a few values
 * from the suspected FK column, then look them up in the suspected PK column of
 * the target table. If at least one sampled value is found, the edge is confirmed
 * by data; if none match, it's almost certainly spurious and can be dropped.
 *
 * The core is pure (query strings + result interpretation) with the query runner
 * injected, so it's unit-testable without VS Code or a live cluster. The wiring
 * (`createServerRunQuery`) binds it to the language server's runQuery.
 *
 * Verification is best-effort and never throws: an empty table, a missing column,
 * or a query error yields an 'unverifiable'/'error' status (the edge is KEPT but
 * flagged) — absence of data is not disproof. Only a sample that produced values
 * with ZERO matches is treated as disproof ('unmatched').
 */

import type { IServer, ResultTable } from './server';
import type { ForeignKeyEdge } from './relationshipModel';
import type { CancellationLike } from './relationshipManager';
import { kustoLiteral, isNativeScalarType } from './kustoLiteral';

/** Default number of distinct FK values to sample per edge. */
export const DEFAULT_VERIFY_SAMPLE_SIZE = 5;

/**
 * Default minimum distinct/total ratio for a target column to be accepted as a
 * key (primary-key-like). A real PK is unique (ratio 1); we allow a margin for
 * sampling/soft-delete noise. Below this the target isn't key-like and the edge
 * is rejected before the (more expensive) containment lookup.
 */
export const DEFAULT_MIN_KEY_UNIQUENESS = 0.95;

/**
 * Tables smaller than this are exempt from the uniqueness gate: with very few
 * rows a legitimate key can have a low absolute distinct count purely by chance,
 * and the gate would produce false negatives.
 */
export const MIN_ROWS_FOR_KEY_GATE = 20;

/**
 * Default number of edges to verify concurrently. Each edge issues up to three
 * small sequential queries (sample → key gate → lookup), so verifying many edges
 * in parallel is the biggest wall-clock lever: the queries are tiny and read-only,
 * and the cluster handles many at once. Kept modest enough not to flood a small
 * cluster while still hiding per-query latency for the common 10–30 edge case.
 */
export const DEFAULT_VERIFY_CONCURRENCY = 12;

/**
 * Default per-query timeout in milliseconds. The language server's runQuery has
 * no timeout of its own, so a single pathological verification query (e.g. a
 * dcount over a huge table) can run for minutes and — because the pipeline waits
 * on every edge — stall the whole build indefinitely. Abandoning a query that
 * exceeds this budget lets the edge degrade to 'error' (KEPT — a slow answer
 * isn't disproof) and the rest of the pipeline proceed. 0 disables the timeout.
 */
export const DEFAULT_VERIFY_QUERY_TIMEOUT_MS = 20000;

/**
 * Default hard cap on rows scanned by the FK sample query. Sampling only needs a
 * few distinct values to test containment, so we read at most this many rows
 * (via `take`, which short-circuits) and dedup within that bounded slice. This
 * keeps the sample cheap REGARDLESS of the column's distinct cardinality: a
 * `distinct` over the whole column, or `sample-distinct N` when fewer than N
 * distinct values exist, both degrade to a FULL TABLE SCAN on a huge table. A row
 * cap can't. 0 disables the cap (scan the whole table).
 */
export const DEFAULT_VERIFY_SCAN_LIMIT = 50000;

/** Runs a read-only KQL query and returns its first result table (or undefined). */
export type RunQuery = (query: string, token?: CancellationLike) => Promise<ResultTable | undefined>;

/** Outcome of verifying one candidate edge against data. */
export type VerificationStatus =
    /** At least one sampled FK value was found in the target PK column. */
    | 'verified'
    /** Sampled FK values exist, but NONE were found in the target — likely spurious. */
    | 'unmatched'
    /** The target column isn't key-like (too many duplicate values) — not a PK. */
    | 'not-a-key'
    /** No FK values to sample (empty/all-null column) — can't prove or disprove. */
    | 'unverifiable'
    /** A query failed — can't prove or disprove. */
    | 'error';

/** The result of verifying a single edge. */
export interface EdgeVerification {
    edge: ForeignKeyEdge;
    status: VerificationStatus;
    /** Number of distinct FK values sampled from the child column. */
    sampled: number;
    /** How many of the sampled values were found in the target PK column. */
    matched: number;
    /** Human-readable detail (e.g. an error message). */
    detail: string;
}

export interface VerifyOptions {
    /** Distinct FK values to sample per edge (>=1). */
    sampleSize?: number;
    /** Minimum distinct/total ratio for the target column to count as a key (0..1). */
    minKeyUniqueness?: number;
    /** Skip the PK-cardinality gate (containment lookup only). */
    skipKeyGate?: boolean;
    /** Skip the `.show table … dimensions` metadata pre-gate (per target table). */
    skipDimensionGate?: boolean;
    /** Max edges to verify concurrently (>=1). Defaults to DEFAULT_VERIFY_CONCURRENCY. */
    concurrency?: number;
    /** Per-query timeout in ms (>0); 0/undefined disables. Defaults to DEFAULT_VERIFY_QUERY_TIMEOUT_MS. */
    queryTimeoutMs?: number;
    /** Hard cap on rows scanned by the FK sample query (>0); 0 disables. Defaults to DEFAULT_VERIFY_SCAN_LIMIT. */
    scanLimit?: number;
    /** Optional sink for timing/diagnostic messages (e.g. an output channel). */
    onDiagnostic?: (message: string) => void;
}

// ─── KQL building (pure, testable) ───────────────────────────────────────────

/** Escapes a table/column name as a bracket-quoted Kusto identifier: `['name']`. */
export function escapeKqlIdent(name: string): string {
    const inner = (name ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `['${inner}']`;
}

/** Escapes a value as a single-quoted Kusto string literal. */
export function escapeKqlString(value: string): string {
    const inner = (value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `'${inner}'`;
}

/**
 * Builds a query that samples up to `sampleSize` DISTINCT, non-empty values from
 * the suspected FK column, compared as strings so any key type works. The single
 * result column is `__fk`.
 *
 * Bounds the work with `take scanLimit` FIRST so the engine reads at most that
 * many rows (it short-circuits), THEN dedups within that bounded slice. This is
 * cheap no matter the column's distinct cardinality — unlike `distinct | take N`
 * (dedups the WHOLE column) or `sample-distinct N` (scans everything when fewer
 * than N distinct values exist), both of which become full table scans on a huge
 * table. `scanLimit <= 0` removes the cap (scan the whole table).
 */
export function buildSampleQuery(fromTable: string, fromColumn: string, sampleSize: number, scanLimit = DEFAULT_VERIFY_SCAN_LIMIT): string {
    const n = Math.max(1, Math.floor(sampleSize));
    const t = escapeKqlIdent(fromTable);
    const c = escapeKqlIdent(fromColumn);
    const lines = [`${t}`];
    if (scanLimit > 0) { lines.push(`| take ${Math.floor(scanLimit)}`); }
    lines.push(
        `| where isnotnull(${c})`,
        `| extend __fk = tostring(${c})`,
        `| where isnotempty(__fk)`,
        `| distinct __fk`,
        `| take ${n}`,
    );
    return lines.join('\n');
}

/**
 * Builds the key-cardinality GATE query: a single-row summary of the target
 * column's row count (`__total`) and distinct-value count (`__distinct`). Run
 * BEFORE the containment lookup so a target that isn't key-like (too many
 * duplicate values, e.g. a category column) is rejected without ever paying for
 * the lookup. `dcount` is HyperLogLog over per-shard sketches, so it's fast even
 * on large indexed columns — whereas the containment lookup must evaluate a
 * predicate row-wise. Result is a single row.
 */
export function buildKeyGateQuery(toTable: string, toColumn: string): string {
    const t = escapeKqlIdent(toTable);
    const c = escapeKqlIdent(toColumn);
    return `${t}\n| summarize __total = count(), __distinct = dcount(${c})`;
}

/**
 * Builds the containment LOOKUP query: filters the target table to rows whose key
 * falls in the sampled FK set, then counts the distinct matches as `__matched`.
 * Filtering first lets the engine use the column index for the `in (…)` set. Only
 * run on targets that PASSED the key gate, so this scan is paid only for
 * plausibly-real keys. Result is a single row.
 *
 * CRITICAL for performance: when `toColumnType` names a known Kusto scalar type,
 * the column is compared in its NATIVE type with typed literals (built by the
 * shared {@link kustoLiteral}, the same logic behind the datatable/drag-drop
 * expression), so the engine can use the column index and per-shard min/max to
 * prune most data. For an UNKNOWN type we fall back to wrapping the column in
 * `tostring(…)` — correct for any key type, but it defeats the index and forces a
 * row-wise scan of the whole target table (the dominant cost on large tables).
 */
export function buildLookupQuery(toTable: string, toColumn: string, values: string[], toColumnType?: string): string {
    const t = escapeKqlIdent(toTable);
    const c = escapeKqlIdent(toColumn);

    // Native, index-friendly comparison for known scalar key types.
    if (isNativeScalarType(toColumnType)) {
        const list = values.map(v => kustoLiteral(v, toColumnType)).join(', ');
        return `${t}\n| where ${c} in (${list})\n| summarize __matched = dcount(${c})`;
    }

    // Unknown type: type-agnostic string comparison. Correct for any key type,
    // but `tostring(col)` defeats the index — a full scan.
    const list = values.map(escapeKqlString).join(', ');
    return `${t}\n| where tostring(${c}) in (${list})\n| summarize __matched = dcount(tostring(${c}))`;
}

/**
 * Builds the `.show table <T> dimensions` management command, reduced to just the
 * names of columns the engine classifies as dimensions. The base command emits
 * one row per profiled dimension VALUE (with popularity); we don't need that
 * detail, so we summarize to one row per column and keep only the dimensions.
 * Served from statistics/metadata (NOT a table scan).
 *
 * We use it only as a cheap NEGATIVE signal: a column the engine dictionary-
 * encodes as a low-cardinality dimension can't be a primary key, so any edge
 * targeting it can be rejected for free — without a per-edge `dcount`. It never
 * confirms a key (a real key is too high-cardinality to appear), so columns
 * absent from the result still fall through to the dcount gate + lookup.
 */
export function buildDimensionsQuery(table: string): string {
    return `.show table ${escapeKqlIdent(table)} dimensions\n| summarize IsDimension = max(IsDimension) by AttributeName\n| where IsDimension\n| project AttributeName`;
}

/**
 * Parses the result of {@link buildDimensionsQuery} into the set of dimension
 * column names. The query already filters to dimensions and projects only
 * `AttributeName`, so every row's name is a dimension. Tolerant of a missing
 * column/rows; returns an empty set if unrecognizable (caller falls back to the
 * dcount gate).
 */
export function parseDimensionColumns(table: ResultTable | undefined): Set<string> {
    const out = new Set<string>();
    if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) { return out; }
    const nameIdx = table.columns.findIndex(c => c.name === 'AttributeName');
    if (nameIdx < 0) { return out; }
    for (const row of table.rows) {
        const name = row[nameIdx];
        if (name !== null && name !== undefined) { out.add(String(name)); }
    }
    return out;
}

// ─── Result interpretation ───────────────────────────────────────────────────

/** Reads a named numeric scalar from the first row of a result table. */
function firstRowNumber(table: ResultTable | undefined, columnName: string): number | undefined {
    const row = table?.rows?.[0];
    if (!row || !Array.isArray(table!.columns)) { return undefined; }
    const idx = table!.columns.findIndex(c => c.name === columnName);
    if (idx < 0) { return undefined; }
    const value = row[idx];
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : undefined;
}

/** Reads the first column of a result table as a list of string values. */
function firstColumnStrings(table: ResultTable | undefined): string[] {
    if (!table || !Array.isArray(table.rows)) { return []; }
    const out: string[] = [];
    for (const row of table.rows) {
        const cell = Array.isArray(row) ? row[0] : undefined;
        if (cell === null || cell === undefined) { continue; }
        out.push(String(cell));
    }
    return out;
}

// ─── Verification ────────────────────────────────────────────────────────────

/** Sentinel returned by {@link runWithTimeout} when a query exceeds its budget. */
const QUERY_TIMEOUT = Symbol('query-timeout');
/**
 * Runs a query but gives up waiting after `timeoutMs`, resolving to the
 * {@link QUERY_TIMEOUT} sentinel instead of hanging forever. The underlying
 * server request is abandoned (not cancelled) but the caller is freed so one slow
 * edge can't stall the whole pipeline. `timeoutMs <= 0` disables the timeout.
 */
async function runWithTimeout(
    runQuery: RunQuery,
    query: string,
    timeoutMs: number,
    token?: CancellationLike,
): Promise<ResultTable | undefined | typeof QUERY_TIMEOUT> {
    if (!(timeoutMs > 0)) { return runQuery(query, token); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof QUERY_TIMEOUT>(resolve => {
        timer = setTimeout(() => resolve(QUERY_TIMEOUT), timeoutMs);
    });
    try {
        return await Promise.race([runQuery(query, token), timeout]);
    } finally {
        if (timer) { clearTimeout(timer); }
    }
}

/**
 * Verifies a single edge against data. Never throws; a failed query yields an
 * 'error' status. See module header for the status semantics.
 */
export async function verifyEdge(
    edge: ForeignKeyEdge,
    runQuery: RunQuery,
    options?: VerifyOptions,
    token?: CancellationLike,
): Promise<EdgeVerification> {
    const sampleSize = options?.sampleSize ?? DEFAULT_VERIFY_SAMPLE_SIZE;
    const timeoutMs = options?.queryTimeoutMs ?? DEFAULT_VERIFY_QUERY_TIMEOUT_MS;
    const diag = options?.onDiagnostic;
    const edgeLabel = `${edge.fromTable}.${edge.fromColumn} → ${edge.toTable}.${edge.toColumn}`;
    const base = { edge, sampled: 0, matched: 0 };

    if (token?.isCancellationRequested) {
        return { ...base, status: 'error', detail: 'cancelled' };
    }

    let sampleTable: ResultTable | undefined;
    try {
        const t0 = Date.now();
        const r = await runWithTimeout(runQuery, buildSampleQuery(edge.fromTable, edge.fromColumn, sampleSize, options?.scanLimit ?? DEFAULT_VERIFY_SCAN_LIMIT), timeoutMs, token);
        diag?.(`      · sample ${edgeLabel} took ${Date.now() - t0}ms`);
        if (r === QUERY_TIMEOUT) {
            return { ...base, status: 'error', detail: `sample query timed out after ${timeoutMs}ms` };
        }
        sampleTable = r;
    } catch (err) {
        return { ...base, status: 'error', detail: `sample query failed: ${errText(err)}` };
    }

    const values = unique(firstColumnStrings(sampleTable));
    if (values.length === 0) {
        return { ...base, status: 'unverifiable', detail: 'no non-null values to sample' };
    }

    if (token?.isCancellationRequested) {
        return { ...base, sampled: values.length, status: 'error', detail: 'cancelled' };
    }

    // Key-cardinality gate FIRST (a cheap dcount). A target that isn't key-like —
    // e.g. an edge pointing at a low-cardinality category posing as a key (a
    // 3-value `vendor_id`) — is rejected here, BEFORE the more expensive
    // containment lookup runs. This is the win: spurious edges never pay for the
    // row-wise lookup scan, so they fail fast instead of timing out.
    if (!options?.skipKeyGate) {
        let gateTable: ResultTable | undefined;
        try {
            const t0 = Date.now();
            const r = await runWithTimeout(runQuery, buildKeyGateQuery(edge.toTable, edge.toColumn), timeoutMs, token);
            diag?.(`      · key gate ${edge.toTable}.${edge.toColumn} took ${Date.now() - t0}ms`);
            if (r === QUERY_TIMEOUT) {
                return { ...base, sampled: values.length, status: 'error', detail: `key gate query timed out after ${timeoutMs}ms` };
            }
            gateTable = r;
        } catch (err) {
            return { ...base, sampled: values.length, status: 'error', detail: `key gate query failed: ${errText(err)}` };
        }

        const total = firstRowNumber(gateTable, '__total');
        const distinct = firstRowNumber(gateTable, '__distinct');
        // Only judge when we have a meaningful row count; tiny tables are exempt
        // (a real key can look non-unique by chance), and a missing count can't disprove.
        if (total !== undefined && distinct !== undefined && total >= MIN_ROWS_FOR_KEY_GATE) {
            const minUniqueness = options?.minKeyUniqueness ?? DEFAULT_MIN_KEY_UNIQUENESS;
            const uniqueness = total > 0 ? distinct / total : 0;
            if (uniqueness < minUniqueness) {
                return {
                    ...base,
                    sampled: values.length,
                    status: 'not-a-key',
                    detail: `target ${edge.toTable}.${edge.toColumn} is not key-like (${distinct}/${total} distinct = ${uniqueness.toFixed(2)} < ${minUniqueness})`,
                };
            }
        }
    }

    if (token?.isCancellationRequested) {
        return { ...base, sampled: values.length, status: 'error', detail: 'cancelled' };
    }

    // Containment lookup — only reached for targets that PASSED the key gate.
    let lookupTable: ResultTable | undefined;
    try {
        const t0 = Date.now();
        const r = await runWithTimeout(runQuery, buildLookupQuery(edge.toTable, edge.toColumn, values, edge.toColumnType), timeoutMs, token);
        diag?.(`      · lookup ${edgeLabel} took ${Date.now() - t0}ms`);
        if (r === QUERY_TIMEOUT) {
            return { ...base, sampled: values.length, status: 'error', detail: `lookup query timed out after ${timeoutMs}ms` };
        }
        lookupTable = r;
    } catch (err) {
        return { ...base, sampled: values.length, status: 'error', detail: `lookup query failed: ${errText(err)}` };
    }

    const matched = firstRowNumber(lookupTable, '__matched') ?? 0;
    if (matched > 0) {
        return { edge, sampled: values.length, matched, status: 'verified', detail: `${matched}/${values.length} sampled values matched` };
    }
    return { edge, sampled: values.length, matched: 0, status: 'unmatched', detail: `0/${values.length} sampled values matched` };
}

/**
 * Prefetches the dimension-column set for every distinct TARGET table among the
 * edges, via one `.show table <T> dimensions` command each (cheap, metadata-
 * served, cached here). Lets {@link verifyEdges} reject edges pointing at low-
 * cardinality dimension columns for FREE — no per-edge dcount. Best-effort: a
 * table whose command times out or errors is simply omitted (its edges fall back
 * to the normal dcount gate).
 */
async function prefetchDimensions(
    edges: ForeignKeyEdge[],
    runQuery: RunQuery,
    timeoutMs: number,
    token?: CancellationLike,
    diag?: (message: string) => void,
): Promise<Map<string, Set<string>>> {
    const map = new Map<string, Set<string>>();
    const tables = [...new Set(edges.map(e => e.toTable))];
    const t0 = Date.now();
    await Promise.all(tables.map(async t => {
        if (token?.isCancellationRequested) { return; }
        try {
            const r = await runWithTimeout(runQuery, buildDimensionsQuery(t), timeoutMs, token);
            if (r === QUERY_TIMEOUT) { diag?.(`      · dimensions ${t} timed out`); return; }
            const dims = parseDimensionColumns(r);
            map.set(t, dims);
            diag?.(`      · dimensions ${t}: ${dims.size} dimension column(s)`);
        } catch {
            // Command unavailable/blocked on this cluster — fall back to the dcount gate.
        }
    }));
    diag?.(`    dimension prefetch for ${tables.length} table(s) took ${Date.now() - t0}ms`);
    return map;
}

/**
 * Verifies a list of edges with bounded concurrency (a few at a time, to cut
 * wall-clock time without hammering the cluster). Returns one EdgeVerification
 * per input edge, in the SAME order as the input. `onProgress` fires once per
 * edge as it COMPLETES (so it may arrive out of input order). Edges not started
 * before cancellation are marked 'error'/'cancelled'.
 */
export async function verifyEdges(
    edges: ForeignKeyEdge[],
    runQuery: RunQuery,
    options?: VerifyOptions,
    token?: CancellationLike,
    onProgress?: (v: EdgeVerification) => void,
): Promise<EdgeVerification[]> {
    const results: EdgeVerification[] = new Array<EdgeVerification>(edges.length);
    const limit = Math.max(1, Math.floor(options?.concurrency ?? DEFAULT_VERIFY_CONCURRENCY));
    const timeoutMs = options?.queryTimeoutMs ?? DEFAULT_VERIFY_QUERY_TIMEOUT_MS;

    // Metadata pre-gate: one `.show table … dimensions` per distinct target table
    // (cheap, served from stats) reveals which columns are low-cardinality
    // dimensions and therefore can't be keys — so those edges are rejected for
    // FREE, before any per-edge dcount or lookup scan. This is what stops spurious
    // edges (which point at category columns) from each paying a slow gate query.
    const dimensions = (options?.skipDimensionGate || options?.skipKeyGate)
        ? new Map<string, Set<string>>()
        : await prefetchDimensions(edges, runQuery, timeoutMs, token, options?.onDiagnostic);

    let next = 0;

    const worker = async (): Promise<void> => {
        for (;;) {
            const i = next++;
            if (i >= edges.length) { return; }
            const edge = edges[i]!;
            let v: EdgeVerification;
            if (token?.isCancellationRequested) {
                v = { edge, status: 'error', sampled: 0, matched: 0, detail: 'cancelled' };
            } else if (dimensions.get(edge.toTable)?.has(edge.toColumn)) {
                v = { edge, status: 'not-a-key', sampled: 0, matched: 0, detail: `target ${edge.toTable}.${edge.toColumn} is a low-cardinality dimension (metadata)` };
            } else {
                v = await verifyEdge(edge, runQuery, options, token);
            }
            results[i] = v;
            onProgress?.(v);
        }
    };

    const workers = Array.from({ length: Math.min(limit, edges.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

/**
 * Applies the "ignore any that don't match" rule: drops edges that data
 * positively DISPROVED — either the sampled FK values matched nothing in the
 * target ('unmatched') or the target column isn't key-like ('not-a-key').
 * Verified, unverifiable (no data), and errored edges are KEPT — absence of data
 * isn't disproof. Verified edges get a basis note appended.
 */
export function pruneUnmatched(verifications: EdgeVerification[]): ForeignKeyEdge[] {
    const kept: ForeignKeyEdge[] = [];
    for (const v of verifications) {
        if (v.status === 'unmatched' || v.status === 'not-a-key') { continue; }
        if (v.status === 'verified') {
            kept.push({ ...v.edge, basis: `${v.edge.basis} · data-verified (${v.matched}/${v.sampled})` });
        } else {
            kept.push(v.edge);
        }
    }
    return kept;
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

/**
 * Builds a RunQuery bound to a specific cluster/database via the language server.
 * Read-only, row-capped, and tolerant: returns undefined if the server reports an
 * error or no table.
 */
export function createServerRunQuery(server: IServer, cluster: string, database: string, maxRows = 1000): RunQuery {
    return async (query: string): Promise<ResultTable | undefined> => {
        const result = await server.runQuery(query, cluster, database, /*isReadOnly*/ true, maxRows);
        if (!result || result.error || !result.data || !Array.isArray(result.data.tables)) {
            return undefined;
        }
        return result.data.tables[0];
    };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function unique(values: string[]): string[] {
    return [...new Set(values)];
}

function errText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
