// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';
import {
    parseJsonPreservingBigInts,
    stripLeadingTrivia,
    isCommand,
    isClientDirective,
    kustoStringLiteral,
    kustoBracketedName,
    findQueryRanges,
    findQueryRangeAt,
    parseConnectionString,
    normalizeKustoType,
    convertCellValue,
    mapResponse,
    primaryTablesFromV1,
    visualizationToChartOptions,
    visualizationToChartType,
    diagnosticFromError,
    errorMessageFromBody,
    splitTopLevel,
    parseCslSchema,
    parseEntityGroup,
    buildDatabaseInfo,
    toResultData,
    KustoInBandError,
} from '../../features/kustoResponse';
import type { RawTable } from '../../features/kustoResponse';

const VIZ_NONE = {
    Visualization: null, Title: null, XColumn: null, Series: null, YColumns: null, AnomalyColumns: null,
    XTitle: null, YTitle: null, XAxis: null, YAxis: null, Legend: null, YSplit: null, Accumulate: false,
    IsQuerySorted: false, Kind: null, Ymin: 'NaN', Ymax: 'NaN', Xmin: null, Xmax: null,
};

function v2Response(primary: { id: number; columns: [string, string][]; rows: unknown[][] }[], viz: Record<number, object> = {}): unknown[] {
    const frames: unknown[] = [
        { FrameType: 'DataSetHeader', IsProgressive: false, Version: 'v2.0' },
        {
            FrameType: 'DataTable', TableId: 0, TableKind: 'QueryProperties', TableName: '@ExtendedProperties',
            Columns: [{ ColumnName: 'TableId', ColumnType: 'int' }, { ColumnName: 'Key', ColumnType: 'string' }, { ColumnName: 'Value', ColumnType: 'dynamic' }],
            Rows: Object.entries(viz).map(([id, v]) => [Number(id), 'Visualization', JSON.stringify(v)]),
        },
    ];
    for (const t of primary) {
        frames.push({
            FrameType: 'DataTable', TableId: t.id, TableKind: 'PrimaryResult', TableName: 'PrimaryResult',
            Columns: t.columns.map(([ColumnName, ColumnType]) => ({ ColumnName, ColumnType })),
            Rows: t.rows,
        });
    }
    frames.push({ FrameType: 'DataTable', TableId: 99, TableKind: 'QueryCompletionInformation', TableName: 'QueryCompletionInformation', Columns: [], Rows: [] });
    frames.push({ FrameType: 'DataSetCompletion', HasErrors: false, Cancelled: false });
    return frames;
}

describe('parseJsonPreservingBigInts', () => {
    it('keeps unsafe integers as exact strings when the runtime exposes the source', () => {
        const parsed = parseJsonPreservingBigInts('{"big":9007199254740993,"small":42,"neg":-9223372036854775808,"real":1.5e300}') as Record<string, unknown>;
        // Node 22+ / Chromium expose context.source; older runtimes degrade to plain numbers.
        const supportsSource = parsed['big'] !== 9007199254740992;
        if (supportsSource) {
            expect(parsed['big']).toBe('9007199254740993');
            expect(parsed['neg']).toBe('-9223372036854775808');
        }
        expect(parsed['small']).toBe(42);
        expect(parsed['real']).toBe(1.5e300);
    });

    it('throws on invalid JSON', () => {
        expect(() => parseJsonPreservingBigInts('{')).toThrow();
    });
});

describe('query text helpers', () => {
    it('strips leading whitespace and comment lines', () => {
        expect(stripLeadingTrivia('  // c1\n\t// c2\r\n  .show tables')).toBe('.show tables');
        expect(stripLeadingTrivia('// only')).toBe('');
    });

    it('classifies commands and directives', () => {
        expect(isCommand('// note\n.show version')).toBe(true);
        expect(isCommand('StormEvents | take 1')).toBe(false);
        expect(isClientDirective('  #connect cluster("x")')).toBe(true);
        expect(isClientDirective('print 1')).toBe(false);
    });

    it('escapes literals and names', () => {
        expect(kustoStringLiteral('a"b\\c')).toBe('"a\\"b\\\\c"');
        expect(kustoBracketedName("it's")).toBe("['it\\'s']");
    });
});

describe('query ranges', () => {
    const text = 'print 1\n| take 1\n\n\nprint 2\r\n\r\nprint 3';

    it('finds blank-line separated blocks', () => {
        expect(findQueryRanges(text)).toEqual([
            { start: { line: 0, character: 0 }, end: { line: 1, character: 8 } },
            { start: { line: 4, character: 0 }, end: { line: 4, character: 7 } },
            { start: { line: 6, character: 0 }, end: { line: 6, character: 7 } },
        ]);
    });

    it('resolves the block at, before or after a position', () => {
        expect(findQueryRangeAt(text, { line: 1, character: 2 })?.start.line).toBe(0);
        expect(findQueryRangeAt(text, { line: 3, character: 0 })?.start.line).toBe(0);
        expect(findQueryRangeAt('\n\nprint 1', { line: 0, character: 0 })?.start.line).toBe(2);
        expect(findQueryRangeAt('  \n', { line: 0, character: 0 })).toBeNull();
    });
});

describe('parseConnectionString', () => {
    it('parses connection strings with data source and catalog keywords', () => {
        expect(parseConnectionString('Data Source=https://help.kusto.windows.net;Initial Catalog=Samples;Fed=True')).toEqual({
            clusterUrl: 'https://help.kusto.windows.net', cluster: 'help.kusto.windows.net', database: 'Samples',
        });
        expect(parseConnectionString('Server=mycluster.westus.kusto.windows.net:443; Database=db')).toEqual({
            clusterUrl: 'https://mycluster.westus.kusto.windows.net', cluster: 'mycluster.westus.kusto.windows.net', database: 'db',
        });
    });

    it('accepts bare hosts and URLs with a database path', () => {
        expect(parseConnectionString('help.kusto.windows.net')).toEqual({
            clusterUrl: 'https://help.kusto.windows.net', cluster: 'help.kusto.windows.net',
        });
        expect(parseConnectionString('https://trd-abc.z1.kusto.fabric.microsoft.com/My%20DB')).toEqual({
            clusterUrl: 'https://trd-abc.z1.kusto.fabric.microsoft.com', cluster: 'trd-abc.z1.kusto.fabric.microsoft.com', database: 'My DB',
        });
        expect(parseConnectionString('https://localhost:8080;Initial Catalog=x')?.clusterUrl).toBe('https://localhost:8080');
    });

    it('returns null when there is no data source', () => {
        expect(parseConnectionString('Initial Catalog=x')).toBeNull();
        expect(parseConnectionString('')).toBeNull();
    });
});

describe('cell and type conversion', () => {
    it('normalizes type aliases', () => {
        expect(normalizeKustoType('Int64')).toBe('long');
        expect(normalizeKustoType('System.Boolean')).toBe('bool');
        expect(normalizeKustoType('Double')).toBe('real');
        expect(normalizeKustoType(undefined)).toBe('string');
        expect(normalizeKustoType('decimal')).toBe('decimal');
    });

    it('converts cells like the C# server', () => {
        expect(convertCellValue(1, 'bool')).toBe(true);
        expect(convertCellValue(0, 'bool')).toBe(false);
        expect(convertCellValue('2020-01-01T00:00:00Z', 'datetime')).toBe('2020-01-01T00:00:00.0000000Z');
        expect(convertCellValue('2020-01-01T00:00:00.123Z', 'datetime')).toBe('2020-01-01T00:00:00.1230000Z');
        expect(convertCellValue('1.02:03:04.5000000', 'timespan')).toBe('1.02:03:04.5000000');
        expect(convertCellValue({ a: 1 }, 'dynamic')).toEqual({ a: 1 });
        expect(convertCellValue('NaN', 'real')).toBe('NaN');
        expect(convertCellValue(null, 'long')).toBeNull();
    });
});

describe('mapResponse', () => {
    it('maps v2 primary results and their charts', () => {
        const response = v2Response(
            [
                { id: 1, columns: [['x', 'datetime'], ['y', 'long']], rows: [['2020-01-01T00:00:00Z', 5]] },
                { id: 2, columns: [['b', 'bool']], rows: [[1]] },
            ],
            { 1: { ...VIZ_NONE, Visualization: 'timechart', Title: 'T', YColumns: ['y'], Legend: 'hidden', YSplit: 'panels', Ymin: -5.0 } },
        );
        const result = mapResponse(response);
        expect(result.tables).toEqual([
            { name: 'PrimaryResult', columns: [{ name: 'x', type: 'datetime' }, { name: 'y', type: 'long' }], rows: [['2020-01-01T00:00:00.0000000Z', 5]] },
            { name: 'PrimaryResult', columns: [{ name: 'b', type: 'bool' }], rows: [[true]] },
        ]);
        expect(result.charts).toHaveLength(1);
        expect(result.charts?.[0]?.options).toMatchObject({
            type: 'TimeLine', title: 'T', yColumns: ['y'], legendPosition: 'None', yLayout: 'SeparatePanels', yMin: -5, yMax: null,
        });
    });

    it('omits charts when nothing is rendered', () => {
        expect(mapResponse(v2Response([{ id: 1, columns: [['a', 'int']], rows: [[1]] }])).charts).toBeUndefined();
    });

    it('throws in-band errors from v2 responses', () => {
        const frames = v2Response([{ id: 1, columns: [['a', 'int']], rows: [] }]);
        (frames[frames.length - 1] as Record<string, unknown>)['HasErrors'] = true;
        (frames[frames.length - 1] as Record<string, unknown>)['OneApiErrors'] = [{ error: { code: 'LimitsExceeded', message: 'Too much', '@message': 'Query result set has exceeded the limit' } }];
        expect(() => mapResponse(frames)).toThrow(KustoInBandError);
        expect(() => mapResponse(frames)).toThrow('Query result set has exceeded the limit');
    });

    it('throws errors embedded in table rows', () => {
        const frames = v2Response([{ id: 1, columns: [['a', 'int']], rows: [[1], { OneApiErrors: [{ error: { message: 'partial failure' } }] }] }]);
        expect(() => mapResponse(frames)).toThrow('partial failure');
    });

    it('maps v1 command responses using the table of contents', () => {
        const v1 = {
            Tables: [
                { TableName: 'Table_0', Columns: [{ ColumnName: 'DatabaseName', DataType: 'String', ColumnType: 'string' }], Rows: [['Samples']] },
                { TableName: 'Table_1', Columns: [{ ColumnName: 'Value', DataType: 'String' }], Rows: [['stats']] },
                {
                    TableName: 'Table_2',
                    Columns: ['Ordinal', 'Kind', 'Name', 'Id', 'PrettyName'].map(c => ({ ColumnName: c, DataType: c === 'Ordinal' ? 'Int64' : 'String' })),
                    Rows: [[0, 'QueryResult', 'PrimaryResult', 'id0', ''], [1, 'QueryProperties', '@ExtendedProperties', 'id1', '']],
                },
            ],
        };
        expect(mapResponse(v1).tables).toEqual([
            { name: 'PrimaryResult', columns: [{ name: 'DatabaseName', type: 'string' }], rows: [['Samples']] },
        ]);
    });

    it('uses the first v1 table when there is no table of contents', () => {
        const table: RawTable = { TableName: 'Table_0', Columns: [{ ColumnName: 'a', DataType: 'Int32' }], Rows: [[1]] };
        expect(primaryTablesFromV1({ Tables: [table] })).toEqual([{ table, name: 'Table_0' }]);
    });

    it('rejects unknown shapes', () => {
        expect(() => mapResponse('nope')).toThrow('Unrecognized Kusto response.');
    });

    it('builds ResultData with connection details', () => {
        const data = toResultData(v2Response([{ id: 1, columns: [['a', 'int']], rows: [[1]] }]), 'print a=1', 'help.kusto.windows.net', 'Samples');
        expect(data).toEqual({
            query: 'print a=1', cluster: 'help.kusto.windows.net', database: 'Samples',
            tables: [{ name: 'PrimaryResult', columns: [{ name: 'a', type: 'int' }], rows: [[1]] }],
        });
    });
});

describe('visualizationToChartOptions', () => {
    it('returns null without a visualization', () => {
        expect(visualizationToChartOptions(VIZ_NONE)).toBeNull();
        expect(visualizationToChartOptions({ ...VIZ_NONE, Visualization: 'none' })).toBeNull();
    });

    it('maps the table visualization to type None like the server', () => {
        expect(visualizationToChartOptions({ ...VIZ_NONE, Visualization: 'table' })?.type).toBe('None');
    });

    it('maps axes, kinds and limits', () => {
        const options = visualizationToChartOptions({
            ...VIZ_NONE, Visualization: 'columnchart', Kind: 'stacked100', XAxis: 'log', YSplit: 'axes',
            Series: ['s'], AnomalyColumns: ['a'], XColumn: 'x', XTitle: 'xt', YTitle: 'yt', Accumulate: true,
            Ymin: 'NaN', Ymax: 'Infinity', Xmin: '-Infinity', Xmax: 10,
        });
        expect(options).toEqual({
            type: 'ColumnStacked100', xAxis: 'Log', yAxis: 'Linear', accumulate: true, xTitle: 'xt', yTitle: 'yt',
            xColumn: 'x', seriesColumns: ['s'], anomalyColumns: ['a'], yLayout: 'DualAxis',
            xMin: -Number.MAX_VALUE, xMax: 10, yMin: null, yMax: Number.MAX_VALUE,
        });
    });

    it('maps every documented visualization name', () => {
        const cases: [string, string | null, string][] = [
            ['areachart', 'stacked', 'AreaStacked'], ['barchart', null, 'Bar'], ['card', null, 'Card'],
            ['graph', null, 'Graph'], ['linechart', null, 'Line'], ['piechart', null, 'Pie'], ['pivotchart', null, 'Line'],
            ['plotly', null, 'Plotly'], ['sankey', null, 'Sankey'], ['scatterchart', null, 'Scatter'],
            ['stackedareachart', null, 'AreaStacked'], ['3Dchart', null, 'ThreeD'], ['ladderchart', null, 'Ladder'],
            ['timeladderchart', null, 'Ladder'], ['timechart', null, 'TimeLine'], ['anomalychart', null, 'TimeLineAnomaly'],
            ['timepivot', null, 'TimePivot'], ['treemap', null, 'TreeMap'], ['somethingnew', null, 'None'],
        ];
        for (const [viz, kind, expected] of cases) {
            expect(visualizationToChartType(viz, kind ?? undefined), viz).toBe(expected);
        }
    });
});

describe('errors', () => {
    const syntaxError = {
        error: {
            code: 'General_BadRequest', message: 'Request is invalid and cannot be executed.', '@type': 'Kusto.Data.Exceptions.KustoBadRequestException',
            '@message': 'Request is invalid and cannot be processed: Syntax error: SYN0002: Query operator expected. [line:position=2:3]', '@permanent': true,
            innererror: { code: 'SYN0002', message: 'Query operator expected.', '@message': 'Syntax error: SYN0002: Query operator expected. [line:position=2:3]', '@line': '2', '@pos': '3', '@token': 'tkae' },
        },
    };

    it('uses the innermost message and the reported position', () => {
        const query = 'StormEvents\n| tkae 1';
        expect(diagnosticFromError(syntaxError, query, 'Request failed with status code 400')).toEqual({
            message: 'Syntax error: SYN0002: Query operator expected. [line:position=2:3]',
            details: 'Error is permanent, retrying will not help',
            range: { start: { line: 1, character: 2 }, end: { line: 1, character: 6 } },
        });
    });

    it('parses JSON string bodies and positions embedded in messages', () => {
        const body = JSON.stringify({ error: { message: 'x', '@message': 'Bad thing [line:position=1:7]' } });
        const diagnostic = diagnosticFromError(body, 'print a', 'fallback');
        expect(diagnostic.details).toBe('Error may be transient, retrying may result in successful request');
        expect(diagnostic.range).toEqual({ start: { line: 0, character: 6 }, end: { line: 0, character: 7 } });
    });

    it('locates unresolved entities by name', () => {
        const body = { error: { '@message': "Semantic error: 'take' operator: Failed to resolve table or column expression named 'Storm'" } };
        expect(diagnosticFromError(body, 'print 1;\nStorm | take 1', 'f').range).toEqual({
            start: { line: 1, character: 0 }, end: { line: 1, character: 5 },
        });
    });

    it('falls back to the trimmed query range', () => {
        const body = { error: { message: 'Something went wrong' } };
        expect(diagnosticFromError(body, '  print 1  ', 'f').range).toEqual({
            start: { line: 0, character: 2 }, end: { line: 0, character: 9 },
        });
    });

    it('uses the fallback message when there is no body', () => {
        expect(diagnosticFromError(undefined, 'print 1', 'Network Error')).toEqual({ message: 'Network Error' });
        expect(diagnosticFromError('', 'print 1', 'Request failed with status code 401')).toEqual({ message: 'Request failed with status code 401' });
    });

    it('extracts messages from bodies', () => {
        expect(errorMessageFromBody({ error: { message: 'outer' } })).toBe('outer');
        expect(errorMessageFromBody('plain text')).toBe('plain text');
        expect(errorMessageFromBody(null)).toBeUndefined();
    });
});

describe('schema parsing', () => {
    it('splits on top-level separators only', () => {
        expect(splitTopLevel("a, f(b, c), 'd,e', [g, h]")).toEqual(['a', 'f(b, c)', "'d,e'", '[g, h]']);
    });

    it('parses CSL schemas', () => {
        expect(parseCslSchema("A:string, ['B c']:int, [\"D\"]:Int64, E:dynamic")).toEqual([
            { name: 'A', type: 'string' }, { name: 'B c', type: 'int' }, { name: 'D', type: 'long' }, { name: 'E', type: 'dynamic' },
        ]);
        expect(parseCslSchema('(x:real)')).toEqual([{ name: 'x', type: 'real' }]);
        expect(parseCslSchema(null)).toEqual([]);
    });

    it('parses entity groups', () => {
        expect(parseEntityGroup("[cluster('a').database('b'), database('c')]")).toEqual(["cluster('a').database('b')", "database('c')"]);
        expect(parseEntityGroup('entity_group [T1, T2]')).toEqual(['T1', 'T2']);
        expect(parseEntityGroup('"[A, B]"')).toEqual(['A', 'B']);
        expect(parseEntityGroup('')).toEqual([]);
    });

    it('builds DatabaseInfo from command rows', () => {
        const entity = (EntityType: string, EntityName: string, extra: Record<string, unknown> = {}) =>
            ({ DatabaseName: 'Samples', EntityType, EntityName, DocString: '', Folder: '', CslInputSchema: '', Content: '', CslOutputSchema: '', ...extra });
        const info = buildDatabaseInfo('fallback', {
            identity: { DatabaseName: 'Samples', PrettyName: 'Pretty' },
            entities: [
                entity('Table', 'StormEvents', { CslOutputSchema: 'StartTime:datetime, State:string', DocString: 'Storms', Folder: 'Weather' }),
                entity('ExternalTable', 'Ext', { CslOutputSchema: 'a:int' }),
                entity('MaterializedView', 'MV', { CslOutputSchema: 'n:long' }),
                entity('MaterializedView', 'MissingMV'),
                entity('Function', 'F', { CslInputSchema: '(x:int)', Content: '{ print x }' }),
                entity('EntityGroup', 'EG', { Content: '[T1, T2]' }),
                entity('Graph', 'G', { Content: '{"Schema":{}}' }),
                entity('StoredQueryResult', 'SQR', { CslOutputSchema: 'c:guid' }),
            ],
            materializedViews: [{ Name: 'MV', SourceTable: 'StormEvents', Query: 'StormEvents | count' }],
            graphSnapshots: [{ ModelName: 'G', Snapshots: '["s1","s2"]' }],
        });
        expect(info).toEqual({
            name: 'Samples',
            alternateName: 'Pretty',
            tables: [{ name: 'StormEvents', columns: [{ name: 'StartTime', type: 'datetime' }, { name: 'State', type: 'string' }], description: 'Storms', folder: 'Weather' }],
            externalTables: [{ name: 'Ext', columns: [{ name: 'a', type: 'int' }] }],
            materializedViews: [{ name: 'MV', source: 'StormEvents', query: 'StormEvents | count', columns: [{ name: 'n', type: 'long' }] }],
            functions: [{ name: 'F', parameters: '(x:int)', body: '{ print x }' }],
            entityGroups: [{ name: 'EG', entities: ['T1', 'T2'] }],
            graphModels: [{ name: 'G', snapshots: ['s1', 's2'], model: '{"Schema":{}}' }],
            storedQueryResults: [{ name: 'SQR', columns: [{ name: 'c', type: 'guid' }] }],
        });
    });

    it('falls back to the requested name without an identity row', () => {
        expect(buildDatabaseInfo('Db', { identity: undefined, entities: [] }).name).toBe('Db');
    });
});
