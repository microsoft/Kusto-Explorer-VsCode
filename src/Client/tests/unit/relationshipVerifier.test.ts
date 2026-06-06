// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';
import {
    escapeKqlIdent,
    escapeKqlString,
    buildSampleQuery,
    buildKeyGateQuery,
    buildLookupQuery,
    buildDimensionsQuery,
    parseDimensionColumns,
    verifyEdge,
    verifyEdges,
    pruneUnmatched,
    type RunQuery,
} from '../../features/relationshipVerifier';
import type { ForeignKeyEdge } from '../../features/relationshipModel';
import type { ResultTable } from '../../features/server';

function edge(partial: Partial<ForeignKeyEdge> = {}): ForeignKeyEdge {
    return {
        fromTable: 'Orders',
        fromColumn: 'CustomerId',
        toTable: 'Customers',
        toColumn: 'Id',
        confidence: 0.7,
        basis: 'inferred',
        source: 'inferred',
        ...partial,
    };
}

/** Builds a one-column ResultTable from string values. */
function table(colName: string, values: Array<string | null>): ResultTable {
    return {
        name: 'T',
        columns: [{ name: colName, type: 'string' }],
        rows: values.map(v => [v]),
    };
}

/** Builds the two-scalar cardinality spec the key-gate reads. */
function keyTable(total: number, distinct: number): ResultTable {
    return {
        name: 'K',
        columns: [{ name: '__total', type: 'long' }, { name: '__distinct', type: 'long' }],
        rows: [[total, distinct]],
    };
}

/** Builds the single-row result of the containment lookup query (`__matched`). */
function matchTable(matched: number): ResultTable {
    return {
        name: 'L',
        columns: [{ name: '__matched', type: 'long' }],
        rows: [[matched]],
    };
}

function distinctNonNull(t: ResultTable | undefined): number {
    if (!t) { return 0; }
    return new Set(t.rows.map(r => r[0]).filter(v => v !== null && v !== undefined)).size;
}

/**
 * A RunQuery that routes by query shape: the sample query (`__fk`) returns
 * `sample`; the key-gate query (`__distinct`) returns `key` (total/distinct); any
 * other query is the containment lookup, whose `__matched` count is synthesized
 * from `lookup`. This keeps the (sample, lookup, key) call sites unchanged across
 * the gate-first split (separate gate and lookup queries).
 */
function fakeRunner(
    sample: ResultTable | undefined,
    lookup: ResultTable | undefined,
    key: ResultTable | undefined = keyTable(100, 100),
): RunQuery {
    return async (query: string) => {
        if (query.includes('__fk')) { return sample; }
        if (query.includes('__distinct')) { return key; }
        return matchTable(distinctNonNull(lookup));
    };
}

describe('escapeKqlIdent / escapeKqlString', () => {
    it('bracket-quotes identifiers and escapes quotes/backslashes', () => {
        expect(escapeKqlIdent('Customer Id')).toBe("['Customer Id']");
        expect(escapeKqlIdent("o'brien")).toBe("['o\\'brien']");
    });
    it('single-quotes string literals', () => {
        expect(escapeKqlString('abc')).toBe("'abc'");
        expect(escapeKqlString("a'b")).toBe("'a\\'b'");
    });
});

describe('buildSampleQuery / buildKeyGateQuery / buildLookupQuery', () => {
    it('samples distinct non-null FK values within a bounded row scan', () => {
        const q = buildSampleQuery('Orders', 'CustomerId', 3);
        expect(q).toContain("['Orders']");
        expect(q).toContain("extend __fk = tostring(['CustomerId'])");
        expect(q).toContain('| distinct __fk');
        expect(q).toContain('| take 3');
        // The row cap must come BEFORE the filters/distinct so it bounds the scan.
        expect(q).toMatch(/\['Orders'\]\n\| take \d+\n\| where isnotnull/);
    });
    it('clamps sample size to at least 1', () => {
        expect(buildSampleQuery('T', 'C', 0)).toContain('| take 1');
    });
    it('caps the rows scanned by default', () => {
        const q = buildSampleQuery('Big', 'Fk', 5);
        expect(q).toContain('| take 50000');
    });
    it('honors a custom scan limit and omits the cap when 0', () => {
        expect(buildSampleQuery('Big', 'Fk', 5, 1000)).toContain('| take 1000');
        const uncapped = buildSampleQuery('Big', 'Fk', 5, 0);
        // No leading row cap — only the trailing `take 5` for the distinct values.
        expect(uncapped).not.toMatch(/\['Big'\]\n\| take/);
        expect(uncapped).toContain('| take 5');
    });
    it('looks up sampled values via a string comparison when the target type is unknown', () => {
        const q = buildLookupQuery('Customers', 'Id', ['1', '2']);
        expect(q).toContain("['Customers']");
        expect(q).toContain("where tostring(['Id']) in ('1', '2')");
        expect(q).toContain("__matched = dcount(tostring(['Id']))");
    });
    it('compares a numeric target column NATIVELY (no tostring) so the index applies', () => {
        const q = buildLookupQuery('Customers', 'Id', ['1', '2'], 'long');
        expect(q).toContain("where ['Id'] in (1, 2)");
        expect(q).toContain("__matched = dcount(['Id'])");
        expect(q).not.toContain('tostring');
    });
    it('renders guid / datetime targets as typed literals', () => {
        const g = buildLookupQuery('T', 'Key', ['11111111-1111-1111-1111-111111111111'], 'guid');
        expect(g).toContain("where ['Key'] in (guid('11111111-1111-1111-1111-111111111111'))");
        expect(g).not.toContain('tostring');
        const d = buildLookupQuery('T', 'When', ['2020-01-02T03:04:05Z'], 'datetime');
        expect(d).toContain("where ['When'] in (todatetime('2020-01-02T03:04:05Z'))");
        expect(d).not.toContain('tostring');
    });
    it('compares a string target column directly without tostring', () => {
        const q = buildLookupQuery('Customers', 'Code', ['A', 'B'], 'string');
        expect(q).toContain("where ['Code'] in ('A', 'B')");
        expect(q).not.toContain('tostring');
    });
    it('measures target key cardinality in a separate gate query', () => {
        const q = buildKeyGateQuery('Customers', 'Id');
        expect(q).toContain("['Customers']");
        expect(q).toContain('__total = count()');
        expect(q).toContain("__distinct = dcount(['Id'])");
    });
    it('keeps the cardinality gate and the containment lookup as separate queries', () => {
        expect(buildLookupQuery('Customers', 'Id', ['1'])).not.toContain('__total');
        expect(buildLookupQuery('Customers', 'Id', ['1'])).not.toContain('__distinct');
        expect(buildKeyGateQuery('Customers', 'Id')).not.toContain('__matched');
    });
});

describe('verifyEdge', () => {
    it('marks verified when at least one sampled value matches', async () => {
        const run = fakeRunner(table('__fk', ['1', '2', '3']), table('__pk', ['2']));
        const v = await verifyEdge(edge(), run);
        expect(v.status).toBe('verified');
        expect(v.sampled).toBe(3);
        expect(v.matched).toBe(1);
    });

    it('marks unmatched when sampled values exist but none match', async () => {
        const run = fakeRunner(table('__fk', ['1', '2']), table('__pk', []));
        const v = await verifyEdge(edge(), run);
        expect(v.status).toBe('unmatched');
        expect(v.matched).toBe(0);
    });

    it('marks unverifiable when there are no values to sample', async () => {
        const run = fakeRunner(table('__fk', []), table('__pk', ['1']));
        const v = await verifyEdge(edge(), run);
        expect(v.status).toBe('unverifiable');
    });

    it('marks error when the sample query throws', async () => {
        const run: RunQuery = async () => { throw new Error('boom'); };
        const v = await verifyEdge(edge(), run);
        expect(v.status).toBe('error');
        expect(v.detail).toContain('boom');
    });

    it('dedupes sampled values before counting', async () => {
        const run = fakeRunner(table('__fk', ['1', '1', '2']), table('__pk', ['1']));
        const v = await verifyEdge(edge(), run);
        expect(v.sampled).toBe(2); // distinct
        expect(v.matched).toBe(1);
    });

    it('rejects an edge whose target column is not key-like (low cardinality)', async () => {
        // 3 distinct out of 100 rows = 0.03 uniqueness → not a key.
        const run = fakeRunner(table('__fk', ['1', '2']), table('__pk', ['1']), keyTable(100, 3));
        const v = await verifyEdge(edge(), run);
        expect(v.status).toBe('not-a-key');
        expect(v.detail).toContain('not key-like');
    });

    it('passes the key gate when the target column is near-unique', async () => {
        const run = fakeRunner(table('__fk', ['1', '2']), table('__pk', ['1']), keyTable(100, 99));
        const v = await verifyEdge(edge(), run);
        expect(v.status).toBe('verified');
    });

    it('exempts tiny target tables from the key gate', async () => {
        // 5 rows is below MIN_ROWS_FOR_KEY_GATE → gate is skipped even though 2/5 is low.
        const run = fakeRunner(table('__fk', ['1']), table('__pk', ['1']), keyTable(5, 2));
        const v = await verifyEdge(edge(), run);
        expect(v.status).toBe('verified');
    });

    it('skips the key gate entirely when skipKeyGate is set', async () => {
        const run = fakeRunner(table('__fk', ['1']), table('__pk', ['1']), keyTable(100, 3));
        const v = await verifyEdge(edge(), run, { skipKeyGate: true });
        expect(v.status).toBe('verified');
    });

    it('marks error when the key gate query throws', async () => {
        const run: RunQuery = async (query: string) => {
            if (query.includes('__fk')) { return table('__fk', ['1']); }
            throw new Error('gate boom');
        };
        const v = await verifyEdge(edge(), run);
        expect(v.status).toBe('error');
        expect(v.detail).toContain('gate boom');
    });

    it('times out a hanging query instead of waiting forever', async () => {
        // A runner whose sample query never resolves — without a timeout this would
        // hang the whole pipeline (the reported "stuck at 12/14" symptom).
        const run: RunQuery = (query: string) => {
            if (query.includes('__fk')) { return new Promise<ResultTable>(() => { /* never resolves */ }); }
            return Promise.resolve(table('__pk', ['1']));
        };
        const v = await verifyEdge(edge(), run, { queryTimeoutMs: 20 });
        expect(v.status).toBe('error');
        expect(v.detail).toContain('timed out');
    });

    it('does not time out a query that resolves within the budget', async () => {
        const run: RunQuery = (query: string) => new Promise<ResultTable>(resolve => setTimeout(() => {
            if (query.includes('__fk')) { resolve(table('__fk', ['1'])); }
            else if (query.includes('__distinct')) { resolve(keyTable(100, 100)); }
            else { resolve(matchTable(1)); }
        }, 5));
        const v = await verifyEdge(edge(), run, { queryTimeoutMs: 200 });
        expect(v.status).toBe('verified');
    });
});

describe('verifyEdges + pruneUnmatched', () => {
    it('keeps verified/unverifiable/error and drops unmatched, annotating verified', async () => {
        const edges = [
            edge({ fromColumn: 'GoodId' }),  // verified
            edge({ fromColumn: 'BadId' }),   // unmatched
            edge({ fromColumn: 'EmptyId' }), // unverifiable
        ];
        const run: RunQuery = async (query: string) => {
            if (query.includes('__fk')) {
                if (query.includes('GoodId')) { return table('__fk', ['1']); }
                if (query.includes('BadId')) { return table('__fk', ['9']); }
                if (query.includes('EmptyId')) { return table('__fk', []); }
                return table('__fk', []);
            }
            if (query.includes('__distinct')) { return keyTable(100, 100); }
            // Containment lookup: GoodId's sampled value ('1') matches; BadId's
            // ('9') does not. EmptyId never reaches here (no values to sample).
            return matchTable(query.includes("in ('1')") ? 1 : 0);
        };
        const verifications = await verifyEdges(edges, run);
        expect(verifications.map(v => v.status)).toEqual(['verified', 'unmatched', 'unverifiable']);

        const kept = pruneUnmatched(verifications);
        expect(kept.map(e => e.fromColumn)).toEqual(['GoodId', 'EmptyId']);
        expect(kept[0].basis).toContain('data-verified (1/1)');
    });

    it('drops not-a-key edges', () => {
        const kept = pruneUnmatched([
            { edge: edge({ fromColumn: 'KeepId' }), status: 'verified', sampled: 2, matched: 2, detail: '' },
            { edge: edge({ fromColumn: 'DropId' }), status: 'not-a-key', sampled: 2, matched: 0, detail: '' },
        ]);
        expect(kept.map(e => e.fromColumn)).toEqual(['KeepId']);
    });

    it('preserves input order in results even when verifying concurrently', async () => {
        // Each edge resolves after a delay inversely proportional to its index, so
        // later edges finish FIRST — results must still come back in input order.
        const edges = [0, 1, 2, 3].map(i => edge({ fromColumn: `Col${i}` }));
        const run: RunQuery = (query: string) => {
            const idx = Number(/Col(\d)/.exec(query)?.[1] ?? 0);
            const delay = (edges.length - idx) * 5;
            return new Promise(resolve => setTimeout(() => {
                if (query.includes('__fk')) { resolve(table('__fk', ['1'])); }
                else if (query.includes('__distinct')) { resolve(keyTable(100, 100)); }
                else { resolve(matchTable(1)); }
            }, delay));
        };
        const results = await verifyEdges(edges, run, { concurrency: 4 });
        expect(results.map(v => v.edge.fromColumn)).toEqual(['Col0', 'Col1', 'Col2', 'Col3']);
        expect(results.every(v => v.status === 'verified')).toBe(true);
    });

    it('runs edges concurrently up to the limit', async () => {
        let active = 0;
        let peak = 0;
        const edges = [0, 1, 2, 3, 4, 5].map(i => edge({ fromColumn: `Col${i}` }));
        const run: RunQuery = async (query: string) => {
            active++;
            peak = Math.max(peak, active);
            await new Promise(r => setTimeout(r, 5));
            active--;
            if (query.includes('__fk')) { return table('__fk', ['1']); }
            if (query.includes('__distinct')) { return keyTable(100, 100); }
            return matchTable(1);
        };
        await verifyEdges(edges, run, { concurrency: 3 });
        // With 6 edges and a limit of 3, at least 2 queries must overlap.
        expect(peak).toBeGreaterThan(1);
        expect(peak).toBeLessThanOrEqual(3);
    });
});

describe('dimension metadata pre-gate', () => {
    /** Result of the summarized `.show table … dimensions` query: one name column. */
    function dimResult(names: string[]): ResultTable {
        return {
            name: 'D',
            columns: [{ name: 'AttributeName', type: 'string' }],
            rows: names.map(n => [n]),
        };
    }

    it('builds the summarized dimensions command', () => {
        const q = buildDimensionsQuery('Trips');
        expect(q).toContain(".show table ['Trips'] dimensions");
        expect(q).toContain('summarize IsDimension = max(IsDimension) by AttributeName');
        expect(q).toContain('where IsDimension');
        expect(q).toContain('project AttributeName');
    });

    it('parses the projected dimension column names', () => {
        const set = parseDimensionColumns(dimResult(['vendor_id', 'payment_type']));
        expect(set.has('vendor_id')).toBe(true);
        expect(set.has('payment_type')).toBe(true);
        expect(set.size).toBe(2);
    });

    it('returns an empty set for an unrecognizable result', () => {
        expect(parseDimensionColumns(undefined).size).toBe(0);
        expect(parseDimensionColumns(table('Other', ['x'])).size).toBe(0);
    });

    it('rejects an edge whose target is a dimension column without any dcount/lookup', async () => {
        let scanned = false;
        const run: RunQuery = async (query: string) => {
            if (query.includes('dimensions')) { return dimResult(['vendor_id']); }
            scanned = true; // any sample/gate/lookup query means we did NOT short-circuit
            return table('__fk', ['1']);
        };
        const [v] = await verifyEdges([edge({ toColumn: 'vendor_id' })], run);
        expect(v.status).toBe('not-a-key');
        expect(v.detail).toContain('dimension');
        expect(scanned).toBe(false);
    });

    it('lets a non-dimension target fall through to the normal data path', async () => {
        const run: RunQuery = async (query: string) => {
            if (query.includes('dimensions')) { return dimResult(['vendor_id']); }
            if (query.includes('__fk')) { return table('__fk', ['1']); }
            if (query.includes('__distinct')) { return keyTable(100, 100); }
            return matchTable(1);
        };
        const [v] = await verifyEdges([edge({ toColumn: 'Id' })], run);
        expect(v.status).toBe('verified');
    });

    it('skips the dimension pre-gate when skipDimensionGate is set', async () => {
        let askedDimensions = false;
        const run: RunQuery = async (query: string) => {
            if (query.includes('dimensions')) { askedDimensions = true; return dimResult(['Id']); }
            if (query.includes('__fk')) { return table('__fk', ['1']); }
            if (query.includes('__distinct')) { return keyTable(100, 100); }
            return matchTable(1);
        };
        const [v] = await verifyEdges([edge({ toColumn: 'Id' })], run, { skipDimensionGate: true });
        expect(askedDimensions).toBe(false);
        expect(v.status).toBe('verified');
    });
});
