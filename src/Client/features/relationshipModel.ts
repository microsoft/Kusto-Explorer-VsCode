// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * Database relationship model for the Explore feature.
 *
 * Kusto declares no foreign keys, so cross-table "links" must be INFERRED from
 * schema (table + column names and types). This module turns a whole
 * DatabaseInfo into a graph of candidate foreign-key edges, each carrying a
 * confidence score and a human-readable `basis` explaining why it was inferred.
 *
 * Provenance: every edge and the model as a whole records a `source`
 * ('inferred' | 'user' | 'native'). The heuristics here produce 'inferred'
 * edges; user-supplied or Kusto-native models can be layered in too. Merge
 * precedence is native > user > inferred.
 *
 * Versioning: a model is only safely reusable from cache when BOTH
 *   - schemaVersion  (the DATA it was built from) and
 *   - algorithmVersion (the inference LOGIC that built it)
 * match the current values. Bump RELATIONSHIP_ALGORITHM_VERSION whenever the
 * inference heuristics below change so older cached/persisted inferred models
 * are discarded.
 *
 * This is a pure module with no VS Code dependencies so it is unit-testable.
 */

import type { DatabaseInfo, DatabaseColumnInfo } from './server';
import { looksLikeIdName } from './columnClassifier';

/**
 * Inference-logic version. BUMP THIS whenever the heuristics in
 * `buildRelationshipModel` change, so cached inferred models built by older
 * logic are rejected and rebuilt. User-/native-supplied models are NOT gated
 * by this (they aren't products of our heuristics).
 */
export const RELATIONSHIP_ALGORITHM_VERSION = 1;

/**
 * Naming-logic version for {@link nameEdgesByLink}. BUMP THIS whenever the
 * deterministic link-label format changes, so cached final models built with the
 * old labels are rebuilt.
 */
export const RELATIONSHIP_LINK_NAMING_VERSION = 1;

/** Where a relationship model (or a single edge) came from. */
export type RelationshipSource = 'inferred' | 'user' | 'native';

/** A single inferred (or declared) foreign-key relationship between two entities. */
export interface ForeignKeyEdge {
    /** The referencing entity (the "child", many side). */
    fromTable: string;
    /** The referencing column in `fromTable`. */
    fromColumn: string;
    /** The referenced entity (the "parent", one side). */
    toTable: string;
    /** The identity column in `toTable` being referenced. */
    toColumn: string;
    /**
     * Kusto type of `toColumn` (e.g. `long`, `guid`, `string`), when known.
     * Lets the data verifier compare the target column in its NATIVE type during
     * the containment lookup instead of wrapping it in `tostring()` — the latter
     * defeats the column index and forces a full scan. Optional; absent for
     * edges from sources that don't carry type info (the verifier then falls
     * back to the type-agnostic string comparison).
     */
    toColumnType?: string;
    /** 0..1 confidence. Authored (user/native) edges are 1. */
    confidence: number;
    /** Human-readable explanation of why this edge exists. */
    basis: string;
    /** Provenance of this individual edge. */
    source: RelationshipSource;
    /**
     * Navigation name in the FK direction (child → parent), singular: from
     * `Orders.CustomerId → Customers` this is "Customer". Optional; absent until a
     * naming pass runs. Set by the heuristic namer and refined by the AI namer.
     */
    forwardName?: string;
    /**
     * Navigation name in the reverse direction (parent → child collection),
     * plural: from `Customers ← Orders` this is "Orders". Optional; absent until a
     * naming pass runs.
     */
    reverseName?: string;
}

/** Outbound (drill to parent) and inbound (expand to children) links for one table. */
export interface TableLinks {
    /** Columns in THIS table that reference other tables (many-to-one). */
    outbound: ForeignKeyEdge[];
    /** Columns in OTHER tables that reference this table (one-to-many). */
    inbound: ForeignKeyEdge[];
}

/** A complete relationship model for one database, with cache-validity metadata. */
export interface DatabaseRelationshipModel {
    cluster: string;
    database: string;
    /** How this model as a whole was produced. */
    source: RelationshipSource;
    /** Hash of the schema this model was built from (data identity). */
    schemaVersion: string;
    /** Inference-logic version this model was built with (logic identity). */
    algorithmVersion: number;
    /** All inferred/declared edges. */
    edges: ForeignKeyEdge[];
    /** Returns the inbound + outbound links for a given entity name. */
    getLinks(table: string): TableLinks;
}

// ─── Schema versioning ───────────────────────────────────────────────────────

/**
 * Computes a stable hash over the parts of the schema that affect relationship
 * inference (entity names + column names/types). Two schemas that are identical
 * in those respects produce the same version, so refreshes that don't change
 * the schema don't force a rebuild.
 */
export function computeSchemaVersion(db: DatabaseInfo): string {
    const entities = collectEntities(db);
    const parts: string[] = [];
    // Sort for order-independence.
    for (const e of [...entities].sort((a, b) => a.name.localeCompare(b.name))) {
        const cols = [...e.columns]
            .map(c => `${c.name}:${(c.type ?? '').toLowerCase()}`)
            .sort();
        parts.push(`${e.name}(${cols.join(',')})`);
    }
    return fnv1aHash(parts.join('|'));
}

/** FNV-1a 32-bit hash → hex string. No crypto dependency needed. */
function fnv1aHash(input: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

// ─── Entity collection ───────────────────────────────────────────────────────

interface Entity {
    name: string;
    columns: DatabaseColumnInfo[];
}

/** Flattens tables, external tables, and materialized views into a single list. */
function collectEntities(db: DatabaseInfo): Entity[] {
    const entities: Entity[] = [];
    const push = (name: string, columns?: DatabaseColumnInfo[]) => {
        entities.push({ name, columns: columns ?? [] });
    };
    db.tables?.forEach(t => push(t.name, t.columns));
    db.externalTables?.forEach(t => push(t.name, t.columns));
    db.materializedViews?.forEach(v => push(v.name, v.columns));
    return entities;
}

// ─── Name helpers ────────────────────────────────────────────────────────────

/**
 * Reduces an identifier-like column name to its referenced-entity "token" by
 * stripping a trailing `Id`/`_Id`/`Key`/`_Key`. e.g. `UserId` → `user`,
 * `manager_id` → `manager`. Returns '' for a bare `Id`/`Key`.
 */
export function idToken(name: string): string {
    const n = (name ?? '').trim();
    const stripped = n.replace(/[_]?(id|key|ref)$/i, '');
    return stripped.toLowerCase();
}

/** Naive singularization for matching `Users` table to a `user` token. */
export function singularize(name: string): string {
    const n = (name ?? '').toLowerCase();
    if (n.endsWith('ies') && n.length > 3) { return n.slice(0, -3) + 'y'; }
    if (n.endsWith('ses') && n.length > 3) { return n.slice(0, -2); }
    // Leave 'ss'/'us' endings alone (e.g. address, status, bonus).
    if (n.endsWith('s') && !n.endsWith('ss') && !n.endsWith('us') && n.length > 1) { return n.slice(0, -1); }
    return n;
}

// ─── Heuristic relationship naming ───────────────────────────────────────────
//
// These produce a deterministic English name for each navigation direction
// (singular forward, plural reverse). They cover common English cases only. The
// default pipeline uses the simpler, language-agnostic `nameEdgesByLink`; this
// prettier namer is kept for a future opt-in. The structural CONSTRAINT that two
// links from the same table must have distinct names is enforced here.

/**
 * Strips a trailing id-like suffix (`Id`/`Key`/`Ref`), preserving the casing of
 * the remainder, but only when there's a word boundary (an underscore or a
 * lower→suffix transition) so we don't maul words that merely end in those
 * letters. Returns the original name if stripping would leave nothing.
 */
export function stripIdSuffix(name: string): string {
    const n = (name ?? '').trim();
    const stripped = n.replace(/(?:_|(?<=[a-z0-9]))(id|key|ref)$/i, '');
    const cleaned = stripped.replace(/[_\s]+$/, '');
    return cleaned.length > 0 ? cleaned : n;
}

/**
 * Splits a camelCase / snake_case / PascalCase identifier into space-separated,
 * capitalized words: `ShipToCustomerId` → "Ship To Customer Id",
 * `customer_id` → "Customer Id".
 */
export function humanizeIdentifier(name: string): string {
    const spaced = (name ?? '')
        .replace(/[_\s]+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')      // camelCase boundary
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')   // ACRONYMWord boundary
        .trim();
    return spaced
        .split(/\s+/)
        .filter(w => w.length > 0)
        .map(w => w[0].toUpperCase() + w.slice(1))
        .join(' ');
}

/** Naive English pluralization of the LAST word of a (possibly multi-word) name. */
export function pluralizeWord(name: string): string {
    const n = (name ?? '').trim();
    if (n.length === 0) { return n; }
    const spaceIdx = n.lastIndexOf(' ');
    const head = spaceIdx >= 0 ? n.slice(0, spaceIdx + 1) : '';
    const word = spaceIdx >= 0 ? n.slice(spaceIdx + 1) : n;
    const lower = word.toLowerCase();
    let plural: string;
    if (/[^aeiou]y$/i.test(word)) {
        plural = word.slice(0, -1) + 'ies';
    } else if (/(ss|x|z|ch|sh)$/i.test(word)) {
        plural = word + 'es';
    } else if (lower.endsWith('s')) {
        plural = word; // already plural (best-effort)
    } else {
        plural = word + 's';
    }
    return head + plural;
}

/**
 * Derives the FORWARD (child → parent) navigation name for an edge: strip the
 * FK column's id suffix and humanize it, falling back to the singularized parent
 * table when the column carries no usable stem (a bare `Id`).
 */
function forwardNameFor(edge: ForeignKeyEdge): string {
    const stem = stripIdSuffix(edge.fromColumn);
    // stripIdSuffix returns the original when nothing usable remains (bare `Id`).
    const stemmed = stem.toLowerCase() !== edge.fromColumn.toLowerCase();
    if (stemmed) {
        const name = humanizeIdentifier(stem);
        if (name) { return name; }
    }
    return humanizeIdentifier(singularize(edge.toTable));
}

/** Derives the REVERSE (parent → child collection) name: the pluralized child table. */
function reverseNameFor(edge: ForeignKeyEdge): string {
    return pluralizeWord(humanizeIdentifier(edge.fromTable));
}

/**
 * Assigns deterministic `forwardName`/`reverseName` to every edge and enforces
 * uniqueness of the names exposed from any single table:
 *  - reverse names are unique per PARENT table (a Customer's many "Orders" vs
 *    "Orders Shipped" when there are two FKs from Orders to Customers), and
 *  - forward names are unique per CHILD table.
 * Colliding names are disambiguated by qualifying with the other direction's
 * base name. Returns NEW edge objects (does not mutate the inputs).
 */
export function nameEdgesHeuristic(edges: ForeignKeyEdge[]): ForeignKeyEdge[] {
    const named = edges.map(e => ({
        ...e,
        forwardName: e.forwardName ?? forwardNameFor(e),
        reverseName: e.reverseName ?? reverseNameFor(e),
    }));

    // Disambiguate reverse names that collide within the same parent table.
    disambiguate(
        named,
        e => e.toTable.toLowerCase(),
        e => (e.reverseName ?? '').toLowerCase(),
        (e) => { e.reverseName = `${e.reverseName} (${e.forwardName})`; },
    );
    // Disambiguate forward names that collide within the same child table.
    disambiguate(
        named,
        e => e.fromTable.toLowerCase(),
        e => (e.forwardName ?? '').toLowerCase(),
        (e) => { e.forwardName = `${e.forwardName} (${humanizeIdentifier(stripIdSuffix(e.fromColumn))})`; },
    );
    return named;
}

/**
 * Assigns DETERMINISTIC link labels to every edge, describing each relationship
 * by the table it leads to and the foreign-key column that links the two:
 *   - forward (child → parent): `"{toTable} ({fromColumn})"`
 *       viewing `Orders`, its `CustomerId` FK reads "Customers (CustomerId)".
 *   - reverse (parent → child): `"{fromTable} ({fromColumn})"`
 *       viewing `Customers`, the inbound link reads "Orders (CustomerId)".
 *
 * Because the FK column is part of every label, two relationships between the
 * same pair of tables (e.g. `Orders.BillToId` and `Orders.ShipToId` both to
 * `Customers`) get distinct labels with no extra disambiguation. This is fully
 * deterministic (no AI, no pluralization guesswork): the same edges always
 * produce the same labels. Returns NEW edge objects (does not mutate inputs).
 */
export function nameEdgesByLink(edges: ForeignKeyEdge[]): ForeignKeyEdge[] {
    return edges.map(e => ({
        ...e,
        forwardName: `${e.toTable} (${e.fromColumn})`,
        reverseName: `${e.fromTable} (${e.fromColumn})`,
    }));
}
function disambiguate(
    edges: ForeignKeyEdge[],
    groupKey: (e: ForeignKeyEdge) => string,
    nameKey: (e: ForeignKeyEdge) => string,
    qualify: (e: ForeignKeyEdge) => void,
): void {
    const counts = new Map<string, number>();
    for (const e of edges) {
        const k = `${groupKey(e)}\u0000${nameKey(e)}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    for (const e of edges) {
        const k = `${groupKey(e)}\u0000${nameKey(e)}`;
        if ((counts.get(k) ?? 0) > 1) { qualify(e); }
    }
}

/** Whether two Kusto column types are compatible enough to be a key/foreign-key pair. */
function typesCompatible(a: string, b: string): boolean {
    return normalizeKeyType(a) === normalizeKeyType(b);
}

/** Collapses Kusto/CLR type spellings into a small set of key-comparable buckets. */
function normalizeKeyType(type: string): string {
    let t = (type ?? '').toLowerCase().trim();
    if (t.startsWith('system.')) { t = t.slice('system.'.length); }
    if (t === 'int64' || t === 'int32' || t === 'int' || t === 'integer') { return 'long'; }
    if (t === 'guid' || t === 'uuid') { return 'guid'; }
    if (t === 'string') { return 'string'; }
    return t;
}

// ─── Identity detection ──────────────────────────────────────────────────────

interface IdentityColumn {
    table: string;
    column: string;
    type: string;
    /** The entity token this identity represents (e.g. `user` for `Users.Id`). */
    token: string;
}

/**
 * Determines whether a column is an IDENTITY (primary-key-like) column of its
 * own table, and if so what entity token it represents.
 *  - `Id` → token = singular(table)             (e.g. Users.Id      → 'user')
 *  - `<Singular(table)>Id` → token = that stem  (e.g. Users.UserId  → 'user')
 *  - `<table>Id` → token = that stem            (e.g. Users.UsersId → 'users')
 */
function identityOf(table: string, column: DatabaseColumnInfo): IdentityColumn | null {
    const colName = column.name ?? '';
    if (!looksLikeIdName(colName)) { return null; }

    const lowerCol = colName.toLowerCase();
    const tableSingular = singularize(table);
    const tableLower = (table ?? '').toLowerCase();

    if (lowerCol === 'id') {
        return { table, column: colName, type: column.type, token: tableSingular };
    }

    const token = idToken(colName);
    if (token && (token === tableSingular || token === tableLower)) {
        return { table, column: colName, type: column.type, token };
    }

    return null;
}

// ─── Inference ───────────────────────────────────────────────────────────────

/**
 * Builds an inferred relationship model for a database.
 *
 * Strategy (cheap, schema-only):
 *  1. Index every entity's IDENTITY columns by their entity token
 *     (`Users.Id`/`Users.UserId` → token 'user').
 *  2. For every column that looks like an identifier but is NOT its own table's
 *     identity, derive its token and look it up in the identity index. A match
 *     yields a candidate foreign-key edge (child → parent), scored by name/type
 *     agreement and target uniqueness.
 *
 * No queries are issued; this is a pure function over the cached schema.
 */
export function buildRelationshipModel(
    cluster: string,
    database: string,
    db: DatabaseInfo,
): DatabaseRelationshipModel {
    const entities = collectEntities(db);

    // 1. Index identity columns by token. A token may be owned by >1 table
    //    (ambiguous), which lowers confidence for edges pointing at it.
    const identityByToken = new Map<string, IdentityColumn[]>();
    const identityColsByTable = new Map<string, Set<string>>();
    for (const entity of entities) {
        for (const col of entity.columns) {
            const identity = identityOf(entity.name, col);
            if (identity) {
                const list = identityByToken.get(identity.token) ?? [];
                list.push(identity);
                identityByToken.set(identity.token, list);

                const set = identityColsByTable.get(entity.name) ?? new Set<string>();
                set.add(col.name.toLowerCase());
                identityColsByTable.set(entity.name, set);
            }
        }
    }

    // 2. Scan for foreign-key candidates.
    const edges: ForeignKeyEdge[] = [];
    for (const entity of entities) {
        const ownIdentityCols = identityColsByTable.get(entity.name) ?? new Set<string>();
        for (const col of entity.columns) {
            const colName = col.name ?? '';
            if (!looksLikeIdName(colName)) { continue; }
            // Skip the table's own identity columns — those are PKs, not FKs.
            if (ownIdentityCols.has(colName.toLowerCase())) { continue; }

            const token = idToken(colName);
            if (!token) { continue; } // a bare `Id`/`Key` carries no target token

            const targets = identityByToken.get(token);
            if (!targets || targets.length === 0) { continue; }

            for (const target of targets) {
                // Self-reference to the same column is meaningless.
                if (target.table === entity.name && target.column.toLowerCase() === colName.toLowerCase()) {
                    continue;
                }
                edges.push(scoreEdge(entity.name, col, target, targets.length));
            }
        }
    }

    return new RelationshipModelImpl(
        cluster,
        database,
        'inferred',
        computeSchemaVersion(db),
        RELATIONSHIP_ALGORITHM_VERSION,
        edges,
    );
}

/**
 * Constructs a relationship model from an explicit set of edges (e.g. a merge of
 * authored + inferred edges). Use `buildRelationshipModel` for pure inference;
 * use this when assembling a model from already-known edges.
 */
export function createRelationshipModel(
    cluster: string,
    database: string,
    source: RelationshipSource,
    schemaVersion: string,
    algorithmVersion: number,
    edges: ForeignKeyEdge[],
): DatabaseRelationshipModel {
    return new RelationshipModelImpl(cluster, database, source, schemaVersion, algorithmVersion, edges);
}

/** Scores a single candidate edge and builds its explanation. */
function scoreEdge(
    fromTable: string,
    fromColumn: DatabaseColumnInfo,
    target: IdentityColumn,
    targetCount: number,
): ForeignKeyEdge {
    const exactNameMatch = fromColumn.name.toLowerCase() === target.column.toLowerCase();
    const typeMatch = typesCompatible(fromColumn.type, target.type);
    const ambiguous = targetCount > 1;

    let confidence = 0.5;
    if (exactNameMatch) { confidence += 0.3; }
    if (typeMatch) { confidence += 0.2; } else { confidence -= 0.3; }
    if (ambiguous) { confidence -= 0.2; }
    confidence = Math.max(0, Math.min(1, confidence));

    const reasons: string[] = [];
    reasons.push(exactNameMatch
        ? `column '${fromColumn.name}' matches ${target.table}.${target.column}`
        : `column '${fromColumn.name}' token '${idToken(fromColumn.name)}' matches ${target.table} identity`);
    reasons.push(typeMatch ? `type ${fromColumn.type} matches` : `type ${fromColumn.type} vs ${target.type} differs`);
    if (ambiguous) { reasons.push(`${targetCount} candidate targets (ambiguous)`); }

    return {
        fromTable,
        fromColumn: fromColumn.name,
        toTable: target.table,
        toColumn: target.column,
        toColumnType: target.type,
        confidence,
        basis: reasons.join('; '),
        source: 'inferred',
    };
}

// ─── Model implementation ────────────────────────────────────────────────────

class RelationshipModelImpl implements DatabaseRelationshipModel {
    private readonly outbound = new Map<string, ForeignKeyEdge[]>();
    private readonly inbound = new Map<string, ForeignKeyEdge[]>();

    constructor(
        public readonly cluster: string,
        public readonly database: string,
        public readonly source: RelationshipSource,
        public readonly schemaVersion: string,
        public readonly algorithmVersion: number,
        public readonly edges: ForeignKeyEdge[],
    ) {
        for (const edge of edges) {
            const out = this.outbound.get(edge.fromTable) ?? [];
            out.push(edge);
            this.outbound.set(edge.fromTable, out);

            const inc = this.inbound.get(edge.toTable) ?? [];
            inc.push(edge);
            this.inbound.set(edge.toTable, inc);
        }
    }

    getLinks(table: string): TableLinks {
        const byConfidence = (a: ForeignKeyEdge, b: ForeignKeyEdge) => b.confidence - a.confidence;
        return {
            outbound: [...(this.outbound.get(table) ?? [])].sort(byConfidence),
            inbound: [...(this.inbound.get(table) ?? [])].sort(byConfidence),
        };
    }
}
