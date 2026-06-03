// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect, vi } from 'vitest';
import { RelationshipManager, type SchemaProvider } from '../../features/relationshipManager';
import type { ForeignKeyEdge } from '../../features/relationshipModel';
import type { DatabaseInfo } from '../../features/server';

function makeDb(tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }>): DatabaseInfo {
    return { name: 'TestDb', tables };
}

const SAMPLE = makeDb([
    { name: 'Users', columns: [{ name: 'Id', type: 'long' }] },
    { name: 'Events', columns: [{ name: 'UserId', type: 'long' }] },
]);

function provider(schema: DatabaseInfo | undefined): SchemaProvider & { calls: number } {
    const obj = {
        calls: 0,
        async getDatabaseSchema(): Promise<DatabaseInfo | undefined> {
            obj.calls++;
            return schema;
        },
    };
    return obj;
}

describe('RelationshipManager', () => {
    it('builds and returns an inferred model', async () => {
        const mgr = new RelationshipManager(provider(SAMPLE));
        const model = await mgr.getModel('c', 'd');
        expect(model).toBeDefined();
        expect(model!.source).toBe('inferred');
        expect(model!.edges.map(e => e.toTable)).toEqual(['Users']);
    });

    it('returns undefined when schema cannot be loaded', async () => {
        const mgr = new RelationshipManager(provider(undefined));
        expect(await mgr.getModel('c', 'd')).toBeUndefined();
    });

    it('reuses the cached inferred model when schema is unchanged', async () => {
        const p = provider(SAMPLE);
        const buildSpy = vi.fn();
        const mgr = new RelationshipManager(p);
        const first = await mgr.getModel('c', 'd');
        const second = await mgr.getModel('c', 'd');
        // Same object identity → not rebuilt.
        expect(first).toBe(second);
        void buildSpy;
    });

    it('rebuilds when the schema version changes', async () => {
        let schema = SAMPLE;
        const p: SchemaProvider = { getDatabaseSchema: async () => schema };
        const mgr = new RelationshipManager(p);
        const first = await mgr.getModel('c', 'd');

        // Change the schema (add a table) → different schemaVersion → rebuild.
        schema = makeDb([
            { name: 'Users', columns: [{ name: 'Id', type: 'long' }] },
            { name: 'Events', columns: [{ name: 'UserId', type: 'long' }] },
            { name: 'Orders', columns: [{ name: 'UserId', type: 'long' }] },
        ]);
        const second = await mgr.getModel('c', 'd');
        expect(first).not.toBe(second);
        expect(second!.edges.length).toBe(2);
    });

    it('rebuilds after invalidate()', async () => {
        const mgr = new RelationshipManager(provider(SAMPLE));
        const first = await mgr.getModel('c', 'd');
        mgr.invalidate('c', 'd');
        const second = await mgr.getModel('c', 'd');
        expect(first).not.toBe(second);
        expect(second!.edges).toEqual(first!.edges); // same content, fresh object
    });

    it('invalidateCluster drops only that cluster', async () => {
        const mgr = new RelationshipManager(provider(SAMPLE));
        const a1 = await mgr.getModel('clusterA', 'd');
        const b1 = await mgr.getModel('clusterB', 'd');
        mgr.invalidateCluster('clusterA');
        const a2 = await mgr.getModel('clusterA', 'd');
        const b2 = await mgr.getModel('clusterB', 'd');
        expect(a1).not.toBe(a2); // A rebuilt
        expect(b1).toBe(b2);     // B untouched
    });

    describe('authored relationships', () => {
        const authoredEdge: ForeignKeyEdge = {
            fromTable: 'Events',
            fromColumn: 'UserId',
            toTable: 'Users',
            toColumn: 'Id',
            confidence: 0.5,        // should be normalized to 1
            basis: 'declared by user',
            source: 'inferred',     // should be overwritten with 'user'
        };

        it('overrides a conflicting inferred edge and normalizes confidence/source', async () => {
            const mgr = new RelationshipManager(provider(SAMPLE));
            mgr.setAuthored('c', 'd', 'user', [authoredEdge]);
            const model = await mgr.getModel('c', 'd');
            // Only one edge for Events.UserId, and it's the authored one.
            const eventEdges = model!.edges.filter(e => e.fromTable === 'Events' && e.fromColumn === 'UserId');
            expect(eventEdges).toHaveLength(1);
            expect(eventEdges[0].source).toBe('user');
            expect(eventEdges[0].confidence).toBe(1);
            expect(model!.source).toBe('user');
        });

        it('keeps inferred edges that are not overridden', async () => {
            const db = makeDb([
                { name: 'Users', columns: [{ name: 'Id', type: 'long' }] },
                { name: 'Events', columns: [{ name: 'UserId', type: 'long' }, { name: 'DeviceId', type: 'long' }] },
                { name: 'Devices', columns: [{ name: 'Id', type: 'long' }] },
            ]);
            const mgr = new RelationshipManager(provider(db));
            mgr.setAuthored('c', 'd', 'user', [authoredEdge]);
            const model = await mgr.getModel('c', 'd');
            // Authored UserId→Users plus inferred DeviceId→Devices.
            const targets = model!.edges.map(e => `${e.fromColumn}->${e.toTable}`).sort();
            expect(targets).toEqual(['DeviceId->Devices', 'UserId->Users']);
        });

        it('clearAuthored reverts to the inferred model', async () => {
            const mgr = new RelationshipManager(provider(SAMPLE));
            mgr.setAuthored('c', 'd', 'user', [authoredEdge]);
            expect((await mgr.getModel('c', 'd'))!.source).toBe('user');
            mgr.clearAuthored('c', 'd');
            expect((await mgr.getModel('c', 'd'))!.source).toBe('inferred');
        });

        it('native outranks user in the model source', async () => {
            const mgr = new RelationshipManager(provider(SAMPLE));
            mgr.setAuthored('c', 'd', 'native', [{ ...authoredEdge }]);
            const model = await mgr.getModel('c', 'd');
            expect(model!.source).toBe('native');
        });
    });
});
