// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * Column role classifier for the Explore feature.
 *
 * Given a table's column schema (name + Kusto type), it infers a ROLE for each
 * column: time, measure, dimension, id/link, or other. Classification is
 * heuristic-first (instant, from schema alone) and can then be refined with
 * cheap profiling stats (per-column distinct counts + total row count).
 *
 * This is a pure module with no VS Code dependencies so it is unit-testable.
 */

/** The inferred role of a column. */
export type ColumnRole = 'time' | 'measure' | 'dimension' | 'id' | 'other';

/** Minimal column schema input (matches DatabaseColumnInfo's relevant fields). */
export interface ColumnSchema {
    name: string;
    type: string;
}

/** A column with its inferred role and (optionally) the stats used to refine it. */
export interface ClassifiedColumn {
    name: string;
    type: string;
    role: ColumnRole;
    /** Distinct value count, when profiling has been applied. */
    dcount?: number;
    /** True when a profiling pass changed the role from its schema-only guess. */
    refined?: boolean;
}

/** Profiling stats used to refine a schema-only classification. */
export interface ProfileStats {
    /** Total number of rows in the source. */
    totalCount: number;
    /** Map of column name → distinct value count. */
    dcounts: Record<string, number>;
}

// ─── Thresholds ──────────────────────────────────────────────────────────────

/** A numeric column with at most this many distinct values is treated as a dimension. */
const LOW_CARDINALITY_MAX = 50;
/** A column whose distinct/total ratio is at least this is considered near-unique. */
const NEAR_UNIQUE_RATIO = 0.9;
/** Below this row count we don't promote a near-unique column to an id. */
const MIN_ROWS_FOR_UNIQUE = 100;

// ─── Type helpers ──────────────────────────────────────────────────────────

const TIME_TYPES = new Set(['datetime', 'date', 'timespan']);
const NUMERIC_TYPES = new Set(['long', 'int', 'integer', 'real', 'double', 'decimal']);

function normalizeType(type: string): string {
    // Kusto types may appear as 'System.Int64' etc.; reduce to a short token.
    const t = (type ?? '').toLowerCase().trim();
    if (t.startsWith('system.')) {
        const csharp = t.slice('system.'.length);
        const map: Record<string, string> = {
            'int64': 'long', 'int32': 'int', 'double': 'real', 'single': 'real',
            'datetime': 'datetime', 'timespan': 'timespan', 'string': 'string',
            'boolean': 'bool', 'guid': 'guid', 'sbyte': 'bool', 'object': 'dynamic',
            'decimal': 'decimal',
        };
        return map[csharp] ?? csharp;
    }
    return t;
}

function isTimeType(type: string): boolean {
    return TIME_TYPES.has(type);
}

function isNumericType(type: string): boolean {
    return NUMERIC_TYPES.has(type);
}

/**
 * Whether a column NAME looks like an identifier/foreign-key.
 * Matches `Id`, `*_id`, camelCase `UserId`/`DeviceId`, and guid/uuid/key hints,
 * while avoiding false positives like `grid` or `valid` (all-lowercase, no boundary).
 */
export function looksLikeIdName(name: string): boolean {
    const n = name ?? '';
    if (/(^|_)id$/i.test(n)) { return true; }      // 'id', 'user_id'
    if (/[a-z0-9]Id$/.test(n)) { return true; }    // camelCase boundary: 'UserId', 'Device2Id'
    if (/guid|uuid/i.test(n)) { return true; }      // contains guid/uuid
    if (/(^|_)key$/i.test(n) || /[a-z0-9]Key$/.test(n)) { return true; } // foreign keys
    return false;
}

/**
 * Whether a numeric column NAME reads like a categorical code/enum rather than
 * a quantity — e.g. `StatusCode`, `EventType`, `Severity`, `Year`, `Priority`.
 * Used to decide whether a low-cardinality numeric is a true dimension.
 */
export function looksLikeCategoricalName(name: string): boolean {
    const n = name ?? '';
    return /(code|type|category|status|state|level|kind|class|group|flag|priority|severity|rating|grade|tier|version|year|month|quarter|week|weekday|dayofweek)/i.test(n);
}

/**
 * Whether a numeric column NAME reads like a measurable quantity that should be
 * aggregated (summed/averaged) rather than grouped by — e.g. `DeathsDirect`,
 * `Count`, `Amount`, `DamageProperty`, `Duration`. These stay measures even when
 * their distinct count happens to be small.
 */
export function looksLikeMeasureName(name: string): boolean {
    const n = name ?? '';
    return /(count|deaths?|injur|amount|total|sum|qty|quantity|number|price|cost|value|damage|size|length|duration|score|rate|pct|percent|balance|revenue|profit|weight|height|distance|speed|temp|elevation|magnitude|width|depth|volume|area|capacity)/i.test(n);
}

// ─── Classification ──────────────────────────────────────────────────────────

/**
 * Classifies a single column from schema alone (no profiling).
 * Priority: time → id (by name/guid) → measure (numeric) → dimension (string/bool) → other.
 */
export function classifyColumnFromSchema(column: ColumnSchema): ClassifiedColumn {
    const type = normalizeType(column.type);
    let role: ColumnRole;

    if (isTimeType(type)) {
        role = 'time';
    } else if (type === 'guid' || looksLikeIdName(column.name)) {
        role = 'id';
    } else if (isNumericType(type)) {
        role = 'measure';
    } else if (type === 'string' || type === 'bool') {
        role = 'dimension';
    } else {
        role = 'other';
    }

    return { name: column.name, type, role };
}

/** Classifies all columns from schema alone. */
export function classifyColumns(columns: ColumnSchema[]): ClassifiedColumn[] {
    return columns.map(classifyColumnFromSchema);
}

/**
 * Refines a schema-only classification using profiling stats. Two adjustments:
 *  - A numeric column with low distinct count becomes a `dimension`
 *    (e.g. a status code) rather than a `measure`.
 *  - A `dimension` column that is near-unique over a large table becomes an
 *    `id` (poor group-by, likely an identifier).
 * Time and `other` columns are left unchanged.
 */
export function refineClassification(
    columns: ClassifiedColumn[],
    stats: ProfileStats,
): ClassifiedColumn[] {
    return columns.map((col) => {
        const dcount = stats.dcounts[col.name];
        if (dcount === undefined) {
            return col;
        }

        const refined: ClassifiedColumn = { ...col, dcount };

        // Numeric measure with few distinct values → categorical dimension, but
        // ONLY when the name reads like a code/enum (e.g. StatusCode, Severity).
        // A small-valued quantity (DeathsDirect, Count, Amount) is still a
        // measure — low cardinality alone is not enough to demote it.
        if (col.role === 'measure'
            && dcount > 1 && dcount <= LOW_CARDINALITY_MAX
            && looksLikeCategoricalName(col.name)
            && !looksLikeMeasureName(col.name)) {
            refined.role = 'dimension';
            refined.refined = true;
            return refined;
        }

        // Dimension that is near-unique over a large table → identifier.
        if (col.role === 'dimension'
            && stats.totalCount >= MIN_ROWS_FOR_UNIQUE
            && dcount / stats.totalCount >= NEAR_UNIQUE_RATIO) {
            refined.role = 'id';
            refined.refined = true;
            return refined;
        }

        return refined;
    });
}

// ─── Dimension nub selection ─────────────────────────────────────────────────

/**
 * Upper bound on a dimension's distinct count for it to earn a rim nub. Past
 * this, grouping would flower into too many bubbles to be useful (explosion
 * guard); such a dimension stays behind the "open card" thumb.
 */
export const MAX_NUB_CARDINALITY = 1000;

/**
 * Picks the dimension columns that earn a "nub" on the collapsed bubble rim.
 *
 * Quality gates (a cap is a maximum, not a quota — junk is never padded in):
 *  - role must be `dimension`;
 *  - a profiled dimension needs distinct count in (1, MAX_NUB_CARDINALITY]
 *    (a single value is a useless group-by; too many explodes the cloud);
 *  - an unprofiled dimension (no dcount yet) is provisionally eligible.
 *
 * Ranking prefers genuine categorical dimensions. Types fall into tiers:
 * text/bool (best — true categories), then numeric (a low-cardinality number is
 * often a count/code, usable but weaker), then everything else (guid, dynamic,
 * etc. — rarely meaningful to group by). Type tier dominates distinct count, so
 * a text column always outranks a numeric one. Within a tier the cleanest,
 * lowest-cardinality flowers surface first; unprofiled columns sort last.
 */
export function selectDimensionNubs(columns: ClassifiedColumn[], max = 5): ClassifiedColumn[] {
    const candidates = columns.filter(c =>
        c.role === 'dimension'
        && (c.dcount === undefined || (c.dcount > 1 && c.dcount <= MAX_NUB_CARDINALITY)));

    const sorted = [...candidates].sort((a, b) => {
        const at = nubTypeTier(a.type);
        const bt = nubTypeTier(b.type);
        if (at !== bt) { return at - bt; }
        const ad = a.dcount ?? Number.POSITIVE_INFINITY;
        const bd = b.dcount ?? Number.POSITIVE_INFINITY;
        return ad - bd;
    });

    return sorted.slice(0, Math.max(0, max));
}

/**
 * Ranking tier for a dimension's type: 0 = text/bool (best categorical),
 * 1 = numeric (weaker — often a count/code), 2 = everything else (guid,
 * dynamic, etc. — rarely a meaningful grouping). Lower sorts first.
 */
function nubTypeTier(type: string): number {
    const t = normalizeType(type);
    if (t === 'string' || t === 'bool') { return 0; }
    if (isNumericType(t)) { return 1; }
    return 2;
}

/** Max measure nubs offered in the measure category bloom. */
export const MAX_MEASURE_NUBS = 8;

/**
 * Picks the measure columns offered in the "measure" category bloom — the
 * numeric quantities a user might sum/avg/etc. Only numeric `measure`-role
 * columns qualify; order is preserved (schema order is meaningful to authors)
 * and the list is capped.
 */
export function selectMeasureNubs(columns: ClassifiedColumn[], max = MAX_MEASURE_NUBS): ClassifiedColumn[] {
    const candidates = columns.filter(c => c.role === 'measure' && isNumericType(normalizeType(c.type)));
    return candidates.slice(0, Math.max(0, max));
}

// ─── Binnable (continuous) group-key selection ───────────────────────────────

/**
 * Whether a column can serve as a BINNED group key (a continuous axis bucketed
 * into ranges), and of which flavor:
 *  - 'time'    → a datetime/date column (bucket by a timespan, e.g. bin(ts, 1h));
 *  - 'numeric' → a numeric MEASURE column (bucket by a number, e.g. bin(x, 100)).
 * Returns null for anything that should be grouped DISCRETELY instead (a
 * dimension — even a low-cardinality numeric code), or that can't bin at all
 * (ids, strings, timespans, dynamic). A binned column is the continuous twin of
 * a dimension: both are `summarize <measure> by <key>`, the bin just buckets a
 * continuous key so it can be a group axis.
 */
export function binKindForColumn(col: ClassifiedColumn): 'time' | 'numeric' | null {
    const t = normalizeType(col.type);
    if (col.role === 'time' && (t === 'datetime' || t === 'date')) { return 'time'; }
    if (col.role === 'measure' && isNumericType(t)) { return 'numeric'; }
    return null;
}

/**
 * The continuous columns offered as BIN group keys in the field wheel, alongside
 * the discrete dimensions. Schema order is preserved (meaningful to authors).
 */
export function selectBinnableColumns(columns: ClassifiedColumn[]): ClassifiedColumn[] {
    return columns.filter(c => binKindForColumn(c) !== null);
}


