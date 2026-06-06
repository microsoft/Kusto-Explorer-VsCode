// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';
import {
    stripIdSuffix,
    humanizeIdentifier,
    pluralizeWord,
    nameEdgesHeuristic,
    nameEdgesByLink,
} from '../../features/relationshipModel';
import type { ForeignKeyEdge } from '../../features/relationshipModel';

function edge(partial: Partial<ForeignKeyEdge>): ForeignKeyEdge {
    return {
        fromTable: 'Orders',
        fromColumn: 'CustomerId',
        toTable: 'Customers',
        toColumn: 'Id',
        confidence: 0.8,
        basis: 'test',
        source: 'inferred',
        ...partial,
    };
}

describe('stripIdSuffix', () => {
    it('strips Id/Key/Ref at a word boundary', () => {
        expect(stripIdSuffix('CustomerId')).toBe('Customer');
        expect(stripIdSuffix('customer_id')).toBe('customer');
        expect(stripIdSuffix('OrderKey')).toBe('Order');
        expect(stripIdSuffix('parent_ref')).toBe('parent');
    });
    it('preserves casing of the stem', () => {
        expect(stripIdSuffix('ShipToCustomerId')).toBe('ShipToCustomer');
    });
    it('returns the original for a bare id', () => {
        expect(stripIdSuffix('Id')).toBe('Id');
    });
});

describe('humanizeIdentifier', () => {
    it('splits camelCase and snake_case and titlecases', () => {
        expect(humanizeIdentifier('ShipToCustomer')).toBe('Ship To Customer');
        expect(humanizeIdentifier('customer_account')).toBe('Customer Account');
        expect(humanizeIdentifier('customer')).toBe('Customer');
    });
});

describe('pluralizeWord', () => {
    it('handles common english endings', () => {
        expect(pluralizeWord('Order')).toBe('Orders');
        expect(pluralizeWord('Category')).toBe('Categories');
        expect(pluralizeWord('Box')).toBe('Boxes');
        expect(pluralizeWord('Address')).toBe('Addresses');
    });
    it('leaves already-plural words alone', () => {
        expect(pluralizeWord('Orders')).toBe('Orders');
    });
    it('pluralizes only the last word', () => {
        expect(pluralizeWord('Ship To Customer')).toBe('Ship To Customers');
    });
});

describe('nameEdgesHeuristic', () => {
    it('names the canonical customer/orders case', () => {
        const [e] = nameEdgesHeuristic([edge({})]);
        expect(e.forwardName).toBe('Customer'); // Orders.CustomerId → Customers
        expect(e.reverseName).toBe('Orders');   // Customers ← Orders
    });

    it('falls back to the parent table for a bare Id column', () => {
        const [e] = nameEdgesHeuristic([edge({ fromColumn: 'Id', fromTable: 'OrderLines', toTable: 'Orders' })]);
        expect(e.forwardName).toBe('Order');        // singularized parent
        expect(e.reverseName).toBe('Order Lines');  // pluralized child
    });

    it('disambiguates reverse names for multiple FKs to the same parent', () => {
        const named = nameEdgesHeuristic([
            edge({ fromColumn: 'ShipToCustomerId' }),
            edge({ fromColumn: 'BillToCustomerId' }),
        ]);
        // Forward names differ naturally…
        expect(named.map(e => e.forwardName).sort()).toEqual(['Bill To Customer', 'Ship To Customer']);
        // …and reverse names (both base "Orders") get qualified to stay unique.
        const reverses = named.map(e => e.reverseName);
        expect(new Set(reverses).size).toBe(2);
        expect(reverses.every(r => r!.startsWith('Orders ('))).toBe(true);
    });

    it('does not mutate the input edges', () => {
        const input = edge({});
        nameEdgesHeuristic([input]);
        expect(input.forwardName).toBeUndefined();
        expect(input.reverseName).toBeUndefined();
    });
});

describe('nameEdgesByLink', () => {
    it('labels each direction by the table it leads to and the FK column', () => {
        const [named] = nameEdgesByLink([edge({})]);
        // Viewing Orders, following its CustomerId FK up to the parent.
        expect(named!.forwardName).toBe('Customers (CustomerId)');
        // Viewing Customers, an Orders row points back via CustomerId.
        expect(named!.reverseName).toBe('Orders (CustomerId)');
    });

    it('distinguishes two relationships between the same pair of tables by column', () => {
        const named = nameEdgesByLink([
            edge({ fromColumn: 'BillToId' }),
            edge({ fromColumn: 'ShipToId' }),
        ]);
        expect(named.map(e => e.forwardName)).toEqual(['Customers (BillToId)', 'Customers (ShipToId)']);
        expect(named.map(e => e.reverseName)).toEqual(['Orders (BillToId)', 'Orders (ShipToId)']);
        expect(new Set(named.map(e => e.forwardName)).size).toBe(2);
    });

    it('does not mutate the input edges', () => {
        const input = edge({});
        nameEdgesByLink([input]);
        expect(input.forwardName).toBeUndefined();
        expect(input.reverseName).toBeUndefined();
    });
});
