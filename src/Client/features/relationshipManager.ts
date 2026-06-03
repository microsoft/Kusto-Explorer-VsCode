// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * RelationshipManager — per-database cache of inferred relationship models.
 *
 * Computing the relationship graph is cheap (pure, schema-only), but we still
 * cache it per cluster+database so the Explore panel doesn't rebuild it on every
 * interaction. A cached INFERRED model is only reused when BOTH version axes
 * still match:
 *   - schemaVersion    — the DATA it was built from (rebuild if schema changed),
 *   - algorithmVersion — the inference LOGIC (rebuild if we improved heuristics).
 * The schemaVersion check also self-heals if an explicit invalidation is missed.
 *
 * Authored models (user-supplied today, hopefully Kusto-native in future) layer
 * ON TOP of inference: an authored edge overrides any inferred edge for the same
 * (table, column), and native overrides user. Authored edges are NOT gated by
 * algorithmVersion (they aren't products of our heuristics). The merge seam is
 * here from day one so adding a provider later touches no call sites.
 *
 * The cache is in-memory only: inferred relationships are derived data that must
 * track live schema. Authored relationships are the thing worth persisting later.
 */

import type { DatabaseInfo } from './server';
import {
    buildRelationshipModel,
    createRelationshipModel,
    computeSchemaVersion,
    RELATIONSHIP_ALGORITHM_VERSION,
    type DatabaseRelationshipModel,
    type ForeignKeyEdge,
    type RelationshipSource,
} from './relationshipModel';

/** Anything that can supply a database's schema (ConnectionManager satisfies this). */
export interface SchemaProvider {
    getDatabaseSchema(cluster: string, database: string): Promise<DatabaseInfo | undefined>;
}

/** A set of authored (non-inferred) relationships for one database. */
interface AuthoredRelationships {
    source: Exclude<RelationshipSource, 'inferred'>;
    edges: ForeignKeyEdge[];
}

/** Precedence for resolving conflicts between models. Higher wins. */
const SOURCE_RANK: Record<RelationshipSource, number> = {
    inferred: 0,
    user: 1,
    native: 2,
};

export class RelationshipManager {
    /** Cached INFERRED base models, keyed by cluster::database. */
    private readonly inferredCache = new Map<string, DatabaseRelationshipModel>();
    /** Authored overrides, keyed by cluster::database. */
    private readonly authored = new Map<string, AuthoredRelationships>();

    constructor(private readonly schema: SchemaProvider) {}

    private key(cluster: string, database: string): string {
        return `${cluster}::${database}`;
    }

    /**
     * Returns the relationship model for a database, building (and caching) the
     * inferred base if needed and merging any authored relationships on top.
     * Returns undefined if the schema can't be loaded.
     */
    async getModel(cluster: string, database: string): Promise<DatabaseRelationshipModel | undefined> {
        const db = await this.schema.getDatabaseSchema(cluster, database);
        if (!db) { return undefined; }

        const base = this.ensureInferred(cluster, database, db);
        const authored = this.authored.get(this.key(cluster, database));
        if (!authored || authored.edges.length === 0) {
            return base;
        }
        return mergeAuthored(base, authored);
    }

    /** Builds or reuses the cached inferred model, validating both version axes. */
    private ensureInferred(cluster: string, database: string, db: DatabaseInfo): DatabaseRelationshipModel {
        const key = this.key(cluster, database);
        const schemaVersion = computeSchemaVersion(db);
        const cached = this.inferredCache.get(key);
        if (cached && this.isInferredValid(cached, schemaVersion)) {
            return cached;
        }
        const model = buildRelationshipModel(cluster, database, db);
        this.inferredCache.set(key, model);
        return model;
    }

    /** An inferred cache entry is valid only if both the schema and the logic version match. */
    private isInferredValid(model: DatabaseRelationshipModel, currentSchemaVersion: string): boolean {
        return model.source === 'inferred'
            && model.schemaVersion === currentSchemaVersion
            && model.algorithmVersion === RELATIONSHIP_ALGORITHM_VERSION;
    }

    /**
     * Supplies authored relationships for a database (user-provided today, or a
     * future Kusto-native model). Overrides conflicting inferred edges on the
     * next `getModel`. Pass an empty array (or call `clearAuthored`) to remove.
     */
    setAuthored(
        cluster: string,
        database: string,
        source: Exclude<RelationshipSource, 'inferred'>,
        edges: ForeignKeyEdge[],
    ): void {
        // Normalize: authored edges are authoritative (confidence 1, stamped source).
        const normalized = edges.map(e => ({ ...e, confidence: 1, source }));
        this.authored.set(this.key(cluster, database), { source, edges: normalized });
    }

    /** Removes any authored relationships for a database. */
    clearAuthored(cluster: string, database: string): void {
        this.authored.delete(this.key(cluster, database));
    }

    /** Drops the cached inferred model for a database (e.g. on schema refresh). */
    invalidate(cluster: string, database: string): void {
        this.inferredCache.delete(this.key(cluster, database));
    }

    /** Drops every cached inferred model for a cluster (e.g. on cluster schema refresh). */
    invalidateCluster(cluster: string): void {
        const prefix = `${cluster}::`;
        for (const key of [...this.inferredCache.keys()]) {
            if (key.startsWith(prefix)) {
                this.inferredCache.delete(key);
            }
        }
    }

    /** Clears the entire cache (inferred + authored). */
    clear(): void {
        this.inferredCache.clear();
        this.authored.clear();
    }
}

/**
 * Merges authored edges over an inferred base. An authored edge replaces any
 * inferred edge sharing the same (fromTable, fromColumn) — i.e. the same child
 * column can't have two declared parents from different sources; the higher-rank
 * source wins. The resulting model's `source` reflects the highest source present.
 */
function mergeAuthored(
    base: DatabaseRelationshipModel,
    authored: AuthoredRelationships,
): DatabaseRelationshipModel {
    const overriddenKeys = new Set(
        authored.edges.map(e => `${e.fromTable.toLowerCase()}::${e.fromColumn.toLowerCase()}`),
    );
    const keptInferred = base.edges.filter(
        e => !overriddenKeys.has(`${e.fromTable.toLowerCase()}::${e.fromColumn.toLowerCase()}`),
    );
    const merged = [...authored.edges, ...keptInferred];

    const topSource: RelationshipSource =
        SOURCE_RANK[authored.source] >= SOURCE_RANK[base.source] ? authored.source : base.source;

    return createRelationshipModel(
        base.cluster,
        base.database,
        topSource,
        base.schemaVersion,
        base.algorithmVersion,
        merged,
    );
}
