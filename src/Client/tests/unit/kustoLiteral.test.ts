// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';
import { kustoLiteral, kustoStringLiteral, isNativeScalarType } from '../../features/kustoLiteral';

describe('kustoStringLiteral', () => {
    it('single-quotes and escapes backslashes and quotes', () => {
        expect(kustoStringLiteral('abc')).toBe("'abc'");
        expect(kustoStringLiteral("a'b")).toBe("'a\\'b'");
        expect(kustoStringLiteral('a\\b')).toBe("'a\\\\b'");
    });
});

describe('isNativeScalarType', () => {
    it('recognizes known scalar types (case/alias-insensitive)', () => {
        for (const t of ['string', 'long', 'int', 'Int64', 'System.Int32', 'real', 'double', 'decimal', 'bool', 'boolean', 'datetime', 'date', 'timespan', 'guid', 'uuid']) {
            expect(isNativeScalarType(t)).toBe(true);
        }
    });
    it('rejects unknown/empty types', () => {
        expect(isNativeScalarType(undefined)).toBe(false);
        expect(isNativeScalarType('')).toBe(false);
        expect(isNativeScalarType('dynamic')).toBe(false);
    });
});

describe('kustoLiteral', () => {
    it('passes JS numbers and booleans through to native forms', () => {
        expect(kustoLiteral(5)).toBe('5');
        expect(kustoLiteral(5.5, 'real')).toBe('5.5');
        expect(kustoLiteral(true)).toBe('true');
        expect(kustoLiteral(false, 'bool')).toBe('false');
        expect(kustoLiteral(Infinity)).toBe('0');
    });
    it('parses numeric strings against a numeric column type', () => {
        expect(kustoLiteral('42', 'long')).toBe('42');
        expect(kustoLiteral('3.14', 'double')).toBe('3.14');
        // Non-numeric value against a numeric type degrades to a quoted string.
        expect(kustoLiteral('abc', 'long')).toBe("'abc'");
    });
    it('renders datetime/guid/timespan with typed literal wrappers', () => {
        expect(kustoLiteral('2020-01-02T03:04:05Z', 'datetime')).toBe("todatetime('2020-01-02T03:04:05Z')");
        expect(kustoLiteral('11111111-1111-1111-1111-111111111111', 'guid')).toBe("guid('11111111-1111-1111-1111-111111111111')");
        expect(kustoLiteral('1.02:03:04', 'timespan')).toBe("timespan('1.02:03:04')");
    });
    it('renders bool strings natively and falls back otherwise', () => {
        expect(kustoLiteral('true', 'bool')).toBe('true');
        expect(kustoLiteral('false', 'boolean')).toBe('false');
        expect(kustoLiteral('yes', 'bool')).toBe("'yes'");
    });
    it('quotes plain strings and unknown types', () => {
        expect(kustoLiteral('hello', 'string')).toBe("'hello'");
        expect(kustoLiteral("o'brien")).toBe("'o\\'brien'");
        expect(kustoLiteral('whatever', 'dynamic')).toBe("'whatever'");
    });
});
