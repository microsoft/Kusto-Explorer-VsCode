// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';
import {
    classifyColumns,
    classifyColumnFromSchema,
    refineClassification,
    looksLikeIdName,
    selectDimensionNubs,
    selectMeasureNubs,
    MAX_NUB_CARDINALITY,
    type ClassifiedColumn,
} from '../../features/columnClassifier';

describe('looksLikeIdName', () => {
    it('matches identifier-like names', () => {
        expect(looksLikeIdName('Id')).toBe(true);
        expect(looksLikeIdName('id')).toBe(true);
        expect(looksLikeIdName('user_id')).toBe(true);
        expect(looksLikeIdName('UserId')).toBe(true);
        expect(looksLikeIdName('DeviceId')).toBe(true);
        expect(looksLikeIdName('SessionGuid')).toBe(true);
        expect(looksLikeIdName('ManagerKey')).toBe(true);
    });

    it('does not match ordinary words ending in "id"', () => {
        expect(looksLikeIdName('grid')).toBe(false);
        expect(looksLikeIdName('valid')).toBe(false);
        expect(looksLikeIdName('humid')).toBe(false);
    });
});

describe('classifyColumnFromSchema', () => {
    it('classifies temporal types as time', () => {
        expect(classifyColumnFromSchema({ name: 'Timestamp', type: 'datetime' }).role).toBe('time');
        expect(classifyColumnFromSchema({ name: 'Duration', type: 'timespan' }).role).toBe('time');
    });

    it('classifies numeric types as measure', () => {
        expect(classifyColumnFromSchema({ name: 'Amount', type: 'real' }).role).toBe('measure');
        expect(classifyColumnFromSchema({ name: 'Count', type: 'long' }).role).toBe('measure');
    });

    it('classifies string/bool as dimension', () => {
        expect(classifyColumnFromSchema({ name: 'Region', type: 'string' }).role).toBe('dimension');
        expect(classifyColumnFromSchema({ name: 'IsActive', type: 'bool' }).role).toBe('dimension');
    });

    it('classifies id-like names and guids as id', () => {
        expect(classifyColumnFromSchema({ name: 'UserId', type: 'string' }).role).toBe('id');
        expect(classifyColumnFromSchema({ name: 'SessionGuid', type: 'guid' }).role).toBe('id');
        expect(classifyColumnFromSchema({ name: 'AnyName', type: 'guid' }).role).toBe('id');
    });

    it('id-like name beats numeric measure', () => {
        // A numeric foreign key should be an id, not a measure.
        expect(classifyColumnFromSchema({ name: 'ManagerId', type: 'long' }).role).toBe('id');
    });

    it('classifies dynamic/unknown as other', () => {
        expect(classifyColumnFromSchema({ name: 'Props', type: 'dynamic' }).role).toBe('other');
    });

    it('normalizes System.* type names', () => {
        expect(classifyColumnFromSchema({ name: 'Amount', type: 'System.Double' }).role).toBe('measure');
        expect(classifyColumnFromSchema({ name: 'When', type: 'System.DateTime' }).role).toBe('time');
    });
});

describe('classifyColumns', () => {
    it('classifies a mixed schema', () => {
        const result = classifyColumns([
            { name: 'Timestamp', type: 'datetime' },
            { name: 'Region', type: 'string' },
            { name: 'Amount', type: 'real' },
            { name: 'OrderId', type: 'string' },
            { name: 'Props', type: 'dynamic' },
        ]);
        expect(result.map(c => c.role)).toEqual(['time', 'dimension', 'measure', 'id', 'other']);
    });
});

describe('refineClassification', () => {
    const base: ClassifiedColumn[] = [
        { name: 'StatusCode', type: 'long', role: 'measure' },
        { name: 'Amount', type: 'real', role: 'measure' },
        { name: 'Region', type: 'string', role: 'dimension' },
        { name: 'TraceId', type: 'string', role: 'dimension' },
        { name: 'Timestamp', type: 'datetime', role: 'time' },
    ];

    it('demotes low-cardinality numeric measure to dimension', () => {
        const refined = refineClassification(base, {
            totalCount: 10000,
            dcounts: { StatusCode: 5, Amount: 9000, Region: 12, TraceId: 9900, Timestamp: 8000 },
        });
        const status = refined.find(c => c.name === 'StatusCode')!;
        expect(status.role).toBe('dimension');
        expect(status.refined).toBe(true);
    });

    it('keeps a low-cardinality numeric quantity as a measure (count column)', () => {
        const counts: ClassifiedColumn[] = [
            { name: 'DeathsDirect', type: 'int', role: 'measure' },
            { name: 'InjuriesDirect', type: 'int', role: 'measure' },
        ];
        const refined = refineClassification(counts, {
            totalCount: 10000,
            dcounts: { DeathsDirect: 7, InjuriesDirect: 12 },
        });
        expect(refined.map(c => c.role)).toEqual(['measure', 'measure']);
    });

    it('does not demote a low-cardinality numeric with a neutral name', () => {
        const neutral: ClassifiedColumn[] = [{ name: 'Bearing', type: 'real', role: 'measure' }];
        const refined = refineClassification(neutral, {
            totalCount: 10000,
            dcounts: { Bearing: 8 },
        });
        expect(refined[0]!.role).toBe('measure');
    });

    it('keeps high-cardinality numeric as measure', () => {
        const refined = refineClassification(base, {
            totalCount: 10000,
            dcounts: { Amount: 9000 },
        });
        expect(refined.find(c => c.name === 'Amount')!.role).toBe('measure');
    });

    it('promotes near-unique dimension to id on a large table', () => {
        const refined = refineClassification(base, {
            totalCount: 10000,
            dcounts: { TraceId: 9900 },
        });
        const trace = refined.find(c => c.name === 'TraceId')!;
        expect(trace.role).toBe('id');
        expect(trace.refined).toBe(true);
    });

    it('does not promote near-unique dimension on a tiny table', () => {
        const refined = refineClassification(base, {
            totalCount: 20,
            dcounts: { TraceId: 20 },
        });
        expect(refined.find(c => c.name === 'TraceId')!.role).toBe('dimension');
    });

    it('leaves columns without stats unchanged', () => {
        const refined = refineClassification(base, { totalCount: 10000, dcounts: {} });
        expect(refined.map(c => c.role)).toEqual(['measure', 'measure', 'dimension', 'dimension', 'time']);
    });

    it('attaches dcount to refined columns', () => {
        const refined = refineClassification(base, { totalCount: 10000, dcounts: { Region: 12 } });
        expect(refined.find(c => c.name === 'Region')!.dcount).toBe(12);
    });
});

describe('selectDimensionNubs', () => {
    const dim = (name: string, dcount?: number): ClassifiedColumn =>
        ({ name, type: 'string', role: 'dimension', ...(dcount !== undefined ? { dcount } : {}) });

    it('only includes dimension-role columns', () => {
        const cols: ClassifiedColumn[] = [
            dim('Region', 5),
            { name: 'Amount', type: 'real', role: 'measure', dcount: 9000 },
            { name: 'Id', type: 'long', role: 'id', dcount: 9000 },
            { name: 'Ts', type: 'datetime', role: 'time' },
        ];
        expect(selectDimensionNubs(cols).map(c => c.name)).toEqual(['Region']);
    });

    it('excludes single-value and over-cardinality dimensions', () => {
        const cols = [
            dim('Constant', 1),
            dim('Good', 12),
            dim('TooMany', MAX_NUB_CARDINALITY + 1),
        ];
        expect(selectDimensionNubs(cols).map(c => c.name)).toEqual(['Good']);
    });

    it('ranks by ascending distinct count, unprofiled last', () => {
        const cols = [
            dim('Big', 40),
            dim('Unprofiled'),
            dim('Small', 3),
            dim('Mid', 12),
        ];
        expect(selectDimensionNubs(cols).map(c => c.name)).toEqual(['Small', 'Mid', 'Big', 'Unprofiled']);
    });

    it('ranks by type tier (text, then numeric, then other), distinct count within tier', () => {
        const typed = (name: string, type: string, dcount: number): ClassifiedColumn =>
            ({ name, type, role: 'dimension', dcount });
        const cols = [
            typed('LowCount', 'long', 2),
            typed('Category', 'string', 30),
            typed('Code', 'long', 5),
            typed('Region', 'string', 50),
            typed('Blob', 'dynamic', 3),
            typed('Flag', 'bool', 2),
        ];
        // Text/bool tier first (by dcount), then numeric (by dcount), then other.
        expect(selectDimensionNubs(cols, 6).map(c => c.name))
            .toEqual(['Flag', 'Category', 'Region', 'LowCount', 'Code', 'Blob']);
    });

    it('caps the result at max (default 5)', () => {
        const cols = Array.from({ length: 8 }, (_, i) => dim(`D${i}`, i + 2));
        expect(selectDimensionNubs(cols)).toHaveLength(5);
        expect(selectDimensionNubs(cols, 3)).toHaveLength(3);
    });

    it('keeps unprofiled dimensions provisionally eligible', () => {
        const cols = [dim('A'), dim('B')];
        expect(selectDimensionNubs(cols).map(c => c.name)).toEqual(['A', 'B']);
    });
});

describe('selectMeasureNubs', () => {
    it('keeps only numeric measure-role columns, preserving order', () => {
        const cols: ClassifiedColumn[] = [
            { name: 'Amount', type: 'real', role: 'measure' },
            { name: 'Region', type: 'string', role: 'dimension' },
            { name: 'Bytes', type: 'long', role: 'measure' },
            { name: 'Blob', type: 'dynamic', role: 'measure' },
        ];
        expect(selectMeasureNubs(cols).map(c => c.name)).toEqual(['Amount', 'Bytes']);
    });

    it('caps at max', () => {
        const cols: ClassifiedColumn[] = Array.from({ length: 12 }, (_, i) =>
            ({ name: `M${i}`, type: 'long', role: 'measure' }));
        expect(selectMeasureNubs(cols, 3)).toHaveLength(3);
    });
});

