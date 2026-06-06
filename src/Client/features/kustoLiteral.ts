// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * kustoLiteral.ts — render a JS value as a Kusto scalar literal of a given
 * column type.
 *
 * This is the client-side counterpart of the server's
 * `KustoGenerator.GetLiteral` (which builds the `datatable(...)` expression for
 * results-viewer drag-and-drop / "Copy as datatable"). Both must agree on the
 * literal FORMS so a value compares equal to the column it came from:
 *   - numeric  → bare number (long/int/real/double/decimal)
 *   - bool     → `true`/`false`
 *   - datetime → `datetime(...)` / `todatetime('...')`
 *   - guid     → `guid(...)`
 *   - timespan → `timespan(...)`
 *   - string / unknown → single-quoted, escaped string literal
 *
 * Emitting a value as its NATIVE type matters for query performance as well as
 * correctness: comparing a column to a typed literal (e.g. `id == long(5)`) lets
 * the engine use the column index and per-shard min/max to prune, whereas
 * wrapping the column in `tostring(...)` to compare strings defeats the index
 * and forces a full scan.
 *
 * Pure module (no VS Code) so it is shared by the Explore panel (drill-lock
 * predicates) and the relationship verifier (containment lookups), and is
 * unit-testable on its own.
 *
 * TODO (tech debt): this duplicates the server's authoritative
 * `KustoGenerator.GetLiteral` (Server/Utilities/KustoGenerator.cs). The two must
 * agree on literal forms; eventually the client should delegate value→literal
 * rendering to the server (an LSP request, or by reusing the datatable-expression
 * path) rather than maintaining a parallel implementation here.
 */

/** Single-quotes and escapes a value as a Kusto string literal: `'a\'b'`. */
export function kustoStringLiteral(value: string): string {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** The set of Kusto scalar type tokens this module renders natively. */
const NATIVE_TYPE = /^(string|long|int|integer|real|double|decimal|bool|boolean|datetime|date|timespan|guid|uuid)$/;

/**
 * Whether `type` is a known Kusto scalar type that {@link kustoLiteral} renders
 * with a native (index-friendly) literal form. Callers comparing against a
 * column can use this to decide whether to compare NATIVELY (`col in (lits)`)
 * or fall back to a type-agnostic `tostring(col)` comparison for unknown types.
 */
export function isNativeScalarType(type: string | undefined): boolean {
    return NATIVE_TYPE.test(normalizeScalarType(type));
}

/** Reduces a Kusto/CLR type spelling to a short, lowercased token. */
function normalizeScalarType(type: string | undefined): string {
    let t = (type ?? '').toLowerCase().trim();
    if (t.startsWith('system.')) { t = t.slice('system.'.length); }
    if (t === 'int64') { return 'long'; }
    if (t === 'int32' || t === 'int16') { return 'int'; }
    if (t === 'single') { return 'real'; }
    return t;
}

/**
 * Renders `value` as a Kusto literal of column type `type`. Numbers and booleans
 * pass through to their native forms; strings are parsed according to `type`
 * (e.g. a `'5'` against a `long` column becomes `long(5)`); anything unrecognized
 * falls back to a quoted string literal — always a valid, if non-indexed, form.
 */
export function kustoLiteral(value: unknown, type?: string): string {
    const t = normalizeScalarType(type);

    // A binned datetime/date key locks as a range bound, so it must emit a real
    // datetime literal (not a quoted string) for `col >= lo and col < lo + size`.
    if ((t === 'datetime' || t === 'date') && typeof value !== 'number') {
        return `todatetime(${kustoStringLiteral(String(value))})`;
    }
    if (typeof value === 'number') { return Number.isFinite(value) ? String(value) : '0'; }
    if (typeof value === 'boolean') { return value ? 'true' : 'false'; }

    const s = String(value);
    if (t === 'long' || t === 'int' || t === 'integer' || t === 'real' || t === 'double' || t === 'decimal') {
        const n = Number(s);
        if (Number.isFinite(n)) { return String(n); }
    }
    if ((t === 'bool' || t === 'boolean') && (s === 'true' || s === 'false')) { return s; }
    if (t === 'guid' || t === 'uuid') { return `guid(${kustoStringLiteral(s)})`; }
    if (t === 'timespan') { return `timespan(${kustoStringLiteral(s)})`; }
    return kustoStringLiteral(s);
}
