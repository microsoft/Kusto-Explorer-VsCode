// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';
import { csvFileNameForTable, escapeCsvField, formatCsvValue, resultTableToCsv } from '../../features/csv';
import { parseJsonPreservingBigInts, toResultTable } from '../../features/kustoResponse';
import type { ResultTable } from '../../features/server';

function table(columns: [string, string][], rows: unknown[][], name = 'PrimaryResult'): ResultTable {
    return { name, columns: columns.map(([n, type]) => ({ name: n, type })), rows };
}

describe('escapeCsvField', () => {
    it.each([
        ['plain', 'plain'],
        ['', ''],
        ['a,b', '"a,b"'],
        ['say "hi"', '"say ""hi"""'],
        ['"', '""""'],
        ['line1\nline2', '"line1\nline2"'],
        ['line1\r\nline2', '"line1\r\nline2"'],
        ['cr\ronly', '"cr\ronly"'],
        ['tab\tis fine', 'tab\tis fine'],
        [' padded ', ' padded '],
    ])('%j -> %j', (input, expected) => {
        expect(escapeCsvField(input)).toBe(expected);
    });
});

describe('formatCsvValue', () => {
    it('writes null and undefined as empty fields', () => {
        expect(formatCsvValue(null)).toBe('');
        expect(formatCsvValue(undefined)).toBe('');
    });

    it('keeps long values that arrive as decimal strings exact', () => {
        expect(formatCsvValue('9223372036854775807')).toBe('9223372036854775807');
        expect(formatCsvValue('-9223372036854775808')).toBe('-9223372036854775808');
        expect(formatCsvValue('9007199254740993')).toBe('9007199254740993');
    });

    it('writes bigint values exactly', () => {
        expect(formatCsvValue(9223372036854775807n)).toBe('9223372036854775807');
    });

    it('writes safe integers and reals in their shortest round-trip form', () => {
        expect(formatCsvValue(9007199254740991)).toBe('9007199254740991');
        expect(formatCsvValue(-42)).toBe('-42');
        expect(formatCsvValue(0.1)).toBe('0.1');
        expect(formatCsvValue(1.5e-7)).toBe('1.5e-7');
    });

    it('writes datetime, timespan, and guid text verbatim', () => {
        expect(formatCsvValue('2024-01-02T03:04:05.1234567Z')).toBe('2024-01-02T03:04:05.1234567Z');
        expect(formatCsvValue('1.02:03:04.5000000')).toBe('1.02:03:04.5000000');
        expect(formatCsvValue('00000000-0000-0000-0000-000000000001')).toBe('00000000-0000-0000-0000-000000000001');
    });

    it('writes dynamic objects and arrays as JSON', () => {
        expect(formatCsvValue({ a: 1, b: [true, null, 'x'] })).toBe('{"a":1,"b":[true,null,"x"]}');
        expect(formatCsvValue([1, 2])).toBe('[1,2]');
    });

    it('writes booleans as true/false', () => {
        expect(formatCsvValue(true)).toBe('true');
        expect(formatCsvValue(false)).toBe('false');
    });
});

describe('resultTableToCsv', () => {
    it('returns an empty string for a table with no columns', () => {
        expect(resultTableToCsv(table([], []))).toBe('');
    });

    it('writes a header and CRLF-terminated records without a BOM', () => {
        const csv = resultTableToCsv(table([['Name', 'string'], ['Count', 'long']], [['a', 1], ['b', 2]]));
        expect(csv).toBe('Name,Count\r\na,1\r\nb,2\r\n');
        expect(csv.charCodeAt(0)).not.toBe(0xfeff);
    });

    it('writes only the header for an empty result', () => {
        expect(resultTableToCsv(table([['x', 'int']], []))).toBe('x\r\n');
    });

    it('quotes column names that need it', () => {
        expect(resultTableToCsv(table([['a,b', 'string'], ['say "x"', 'string']], []))).toBe('"a,b","say ""x"""\r\n');
    });

    it('round-trips commas, quotes, and embedded newlines per RFC 4180', () => {
        const rows = [['x, y', 'he said "no"', 'multi\nline\r\ntext', '']];
        const csv = resultTableToCsv(table([['A', 'string'], ['B', 'string'], ['C', 'string'], ['D', 'string']], rows));
        expect(csv).toBe('A,B,C,D\r\n"x, y","he said ""no""","multi\nline\r\ntext",\r\n');
    });

    it('exports every row, not a page', () => {
        const rows = Array.from({ length: 2500 }, (_, i) => [i]);
        const lines = resultTableToCsv(table([['i', 'int']], rows)).split('\r\n');
        expect(lines).toHaveLength(2502); // header + 2500 rows + trailing empty
        expect(lines[2500]).toBe('2499');
    });

    it('writes short rows with empty trailing fields', () => {
        expect(resultTableToCsv(table([['a', 'int'], ['b', 'int']], [[1]]))).toBe('a,b\r\n1,\r\n');
    });

    it('keeps long values beyond 2^53 exact when the transport preserved them (web host)', () => {
        const body = '{"TableName":"T","Columns":[{"ColumnName":"v","ColumnType":"long"},{"ColumnName":"d","ColumnType":"dynamic"},{"ColumnName":"t","ColumnType":"datetime"}],'
            + '"Rows":[[9223372036854775807,{"k":"v, \\"q\\""},"2024-01-02T03:04:05Z"],[-9007199254740993,null,null]]}';
        const parsed = parseJsonPreservingBigInts(body) as Parameters<typeof toResultTable>[0];
        const csv = resultTableToCsv(toResultTable(parsed));
        expect(csv).toBe(
            'v,d,t\r\n'
            + '9223372036854775807,"{""k"":""v, \\""q\\""""}",2024-01-02T03:04:05.0000000Z\r\n'
            + '-9007199254740993,,\r\n');
    });
});

describe('csvFileNameForTable', () => {
    it.each([
        ['PrimaryResult', 'PrimaryResult.csv'],
        ['', 'results.csv'],
        [undefined, 'results.csv'],
        ['a/b:c*?', 'a_b_c__.csv'],
    ])('%j -> %j', (name, expected) => {
        expect(csvFileNameForTable(name)).toBe(expected);
    });
});
