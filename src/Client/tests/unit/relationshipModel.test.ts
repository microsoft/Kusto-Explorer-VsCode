// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';
import {
    buildRelationshipModel,
    computeSchemaVersion,
    idToken,
    singularize,
    RELATIONSHIP_ALGORITHM_VERSION,
} from '../../features/relationshipModel';
import type { DatabaseInfo } from '../../features/server';

function db(tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }>): DatabaseInfo {
    return { name: 'TestDb', tables };
}

describe('idToken', () => {
    it('strips id/key/ref suffixes', () => {
        expect(idToken('UserId')).toBe('user');
        expect(idToken('user_id')).toBe('user');
        expect(idToken('ManagerKey')).toBe('manager');
        expect(idToken('OrderRef')).toBe('order');
    });
    it('returns empty for a bare Id/Key', () => {
        expect(idToken('Id')).toBe('');
        expect(idToken('Key')).toBe('');
    });
});

describe('singularize', () => {
    it('handles common plurals', () => {
        expect(singularize('Users')).toBe('user');
        expect(singularize('Categories')).toBe('category');
        expect(singularize('Addresses')).toBe('address');
        expect(singularize('Status')).toBe('status'); // ss not stripped
    });
});

describe('buildRelationshipModel', () => {
    it('infers an FK from a child column to a parent identity (Id)', () => {
        const model = buildRelationshipModel('c', 'd', db([
            { name: 'Users', columns: [{ name: 'Id', type: 'long' }, { name: 'Name', type: 'string' }] },
            { name: 'Events', columns: [{ name: 'UserId', type: 'long' }, { name: 'Time', type: 'datetime' }] },
        ]));
        expect(model.edges).toHaveLength(1);
        const edge = model.edges[0];
        expect(edge.fromTable).toBe('Events');
        expect(edge.fromColumn).toBe('UserId');
        expect(edge.toTable).toBe('Users');
        expect(edge.toColumn).toBe('Id');
        expect(edge.source).toBe('inferred');
        expect(edge.confidence).toBeGreaterThan(0.5);
    });

    it('matches a child column to a parent identity named the same (UserId)', () => {
        const model = buildRelationshipModel('c', 'd', db([
            { name: 'Users', columns: [{ name: 'UserId', type: 'guid' }] },
            { name: 'Sessions', columns: [{ name: 'UserId', type: 'guid' }] },
        ]));
        const edge = model.edges.find(e => e.fromTable === 'Sessions');
        expect(edge).toBeDefined();
        expect(edge!.toTable).toBe('Users');
        expect(edge!.toColumn).toBe('UserId');
        // exact name match + type match → high confidence
        expect(edge!.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('does not treat a table own identity as a foreign key', () => {
        const model = buildRelationshipModel('c', 'd', db([
            { name: 'Users', columns: [{ name: 'UserId', type: 'long' }, { name: 'Name', type: 'string' }] },
        ]));
        expect(model.edges).toHaveLength(0);
    });

    it('penalizes type mismatch', () => {
        const model = buildRelationshipModel('c', 'd', db([
            { name: 'Users', columns: [{ name: 'Id', type: 'long' }] },
            { name: 'Events', columns: [{ name: 'UserId', type: 'string' }] },
        ]));
        expect(model.edges).toHaveLength(1);
        expect(model.edges[0].confidence).toBeLessThan(0.5);
        expect(model.edges[0].basis).toContain('differs');
    });

    it('marks ambiguous targets and lowers confidence', () => {
        // Two tables both own the 'user' token as identity (User.Id and Users.Id),
        // so a child UserId column has two candidate parents.
        const model = buildRelationshipModel('c', 'd', db([
            { name: 'User', columns: [{ name: 'Id', type: 'long' }] },
            { name: 'Users', columns: [{ name: 'Id', type: 'long' }] },
            { name: 'Events', columns: [{ name: 'UserId', type: 'long' }] },
        ]));
        const eventEdges = model.edges.filter(e => e.fromTable === 'Events');
        expect(eventEdges.length).toBe(2);
        expect(eventEdges.every(e => e.basis.includes('ambiguous'))).toBe(true);
    });

    it('exposes inbound and outbound links via getLinks', () => {
        const model = buildRelationshipModel('c', 'd', db([
            { name: 'Users', columns: [{ name: 'Id', type: 'long' }] },
            { name: 'Orders', columns: [{ name: 'Id', type: 'long' }, { name: 'UserId', type: 'long' }] },
            { name: 'OrderLines', columns: [{ name: 'OrderId', type: 'long' }] },
        ]));

        const userLinks = model.getLinks('Users');
        expect(userLinks.outbound).toHaveLength(0);
        expect(userLinks.inbound.map(e => e.fromTable)).toEqual(['Orders']);

        const orderLinks = model.getLinks('Orders');
        expect(orderLinks.outbound.map(e => e.toTable)).toEqual(['Users']);
        expect(orderLinks.inbound.map(e => e.fromTable)).toEqual(['OrderLines']);
    });

    it('indexes external tables and materialized views too', () => {
        const model = buildRelationshipModel('c', 'd', {
            name: 'TestDb',
            tables: [{ name: 'Users', columns: [{ name: 'Id', type: 'long' }] }],
            externalTables: [{ name: 'RawEvents', columns: [{ name: 'UserId', type: 'long' }] }],
            materializedViews: [{ name: 'DailyUsers', source: 'Users', query: '', columns: [{ name: 'UserId', type: 'long' }] }],
        });
        const fromTables = model.edges.map(e => e.fromTable).sort();
        expect(fromTables).toEqual(['DailyUsers', 'RawEvents']);
    });

    it('stamps the model with source, algorithm version, and a schema version', () => {
        const model = buildRelationshipModel('cluster1', 'dbX', db([
            { name: 'Users', columns: [{ name: 'Id', type: 'long' }] },
        ]));
        expect(model.cluster).toBe('cluster1');
        expect(model.database).toBe('dbX');
        expect(model.source).toBe('inferred');
        expect(model.algorithmVersion).toBe(RELATIONSHIP_ALGORITHM_VERSION);
        expect(model.schemaVersion).toMatch(/^[0-9a-f]{8}$/);
    });
});

describe('computeSchemaVersion', () => {
    it('is stable across column/table ordering', () => {
        const a = computeSchemaVersion(db([
            { name: 'Users', columns: [{ name: 'Id', type: 'long' }, { name: 'Name', type: 'string' }] },
            { name: 'Events', columns: [{ name: 'UserId', type: 'long' }] },
        ]));
        const b = computeSchemaVersion(db([
            { name: 'Events', columns: [{ name: 'UserId', type: 'long' }] },
            { name: 'Users', columns: [{ name: 'Name', type: 'string' }, { name: 'Id', type: 'long' }] },
        ]));
        expect(a).toBe(b);
    });

    it('changes when a column type changes', () => {
        const a = computeSchemaVersion(db([{ name: 'Users', columns: [{ name: 'Id', type: 'long' }] }]));
        const b = computeSchemaVersion(db([{ name: 'Users', columns: [{ name: 'Id', type: 'string' }] }]));
        expect(a).not.toBe(b);
    });

    it('changes when a table is added', () => {
        const a = computeSchemaVersion(db([{ name: 'Users', columns: [{ name: 'Id', type: 'long' }] }]));
        const b = computeSchemaVersion(db([
            { name: 'Users', columns: [{ name: 'Id', type: 'long' }] },
            { name: 'Events', columns: [{ name: 'UserId', type: 'long' }] },
        ]));
        expect(a).not.toBe(b);
    });
});
