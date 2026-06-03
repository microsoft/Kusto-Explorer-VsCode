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
 * ('inferred' | 'user' | 'native'). Today only 'inferred' is produced here, but
 * the shape is shared so user-supplied or Kusto-native relationship models can
 * be layered in later (merge precedence native > user > inferred).
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
    /** 0..1 confidence. Authored (user/native) edges are 1. */
    confidence: number;
    /** Human-readable explanation of why this edge exists. */
    basis: string;
    /** Provenance of this individual edge. */
    source: RelationshipSource;
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
