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
 * On top of the inferred base, an authored tier can layer in, by precedence
 * native > user > inferred:
 *   - Authored    — user-supplied today (hopefully Kusto-native in future).
 * An edge from a higher tier overrides any lower-tier edge for the same
 * (table, column). Authored edges are NOT gated by algorithmVersion (they
 * aren't products of our heuristics). The merge seam is here from day one so
 * adding a provider later touches no call sites.
 *
 * The cache is in-memory only: inferred relationships are derived data that must
 * track live schema. Authored relationships are the things worth persisting
 * later.
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

/** Sources that may be authored (declared) rather than inferred. */
type AuthoredSource = Exclude<RelationshipSource, 'inferred'>;

/** A set of authored (non-inferred) relationships for one database. */
interface AuthoredRelationships {
    source: AuthoredSource;
    edges: ForeignKeyEdge[];
}

/** A cached FINAL (verified + named) model, gated by schema + naming version. */
interface FinalModel {
    schemaVersion: string;
    namingVersion: number;
    model: DatabaseRelationshipModel;
}

/**
 * A serializable snapshot of a FINAL model, suitable for persisting across
 * sessions (e.g. in VS Code globalState). The live model carries methods
 * (getLinks), so it can't be stored directly; this captures the plain fields
 * `createRelationshipModel` needs to rebuild it. Validity is re-checked on load
 * against the live `schemaVersion` + `namingVersion`, so a stale snapshot is
 * simply ignored (and overwritten on the next rebuild) — no explicit eviction
 * is required.
 */
export interface PersistedRelationshipModel {
    schemaVersion: string;
    namingVersion: number;
    cluster: string;
    database: string;
    source: RelationshipSource;
    algorithmVersion: number;
    edges: ForeignKeyEdge[];
}

/**
 * Optional persistent backing for the final-model cache, injected so this module
 * stays VS Code-free. Implemented over `context.globalState` in extension.ts.
 * `load`/`save` are keyed by the same `cluster::database` key used in-memory.
 */
export interface RelationshipModelStore {
    load(key: string): PersistedRelationshipModel | undefined;
    save(key: string, model: PersistedRelationshipModel): void;
}

/** Minimal cancellation contract (vscode.CancellationToken satisfies it structurally). */
export interface CancellationLike {
    readonly isCancellationRequested: boolean;
}

/**
 * Verifies candidate edges against the actual data (sampling FK values, checking
 * target key cardinality + containment) and returns the SURVIVING (pruned) set.
 * Injected so this module stays VS Code-free; implemented over relationshipVerifier
 * in extension.ts. `onProgress(done, total)` fires as each edge is checked.
 */
export type RelationshipVerifier = (
    cluster: string,
    database: string,
    edges: ForeignKeyEdge[],
    token?: CancellationLike,
    onProgress?: (done: number, total: number) => void,
) => Promise<ForeignKeyEdge[]>;

/** Assigns forward/reverse navigation names to a set of edges. */
export type RelationshipNamer = (edges: ForeignKeyEdge[], token?: CancellationLike) => Promise<ForeignKeyEdge[]>;

/** The injected work that turns the heuristic base into a verified, named model. */
export interface RelationshipBuildDeps {
    /** Verifies + prunes candidate edges against data. Omit to skip verification. */
    verifier?: RelationshipVerifier;
    /** Assigns forward/reverse navigation names. Omit to skip naming. */
    namer?: RelationshipNamer;
    /** Naming/prompt version gating the final-model cache. Defaults to 0. */
    namingVersion?: number;
}

/** A phase of the relationship build, reported so callers can show live status. */
export type RelationshipBuildPhase =
    | { kind: 'inferring' }
    | { kind: 'verifying'; done: number; total: number }
    | { kind: 'naming'; total: number };

/** Receives build-phase updates so a caller (e.g. the Explore panel) can show progress. */
export type RelationshipBuildProgress = (phase: RelationshipBuildPhase) => void;

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
    /** Cached FINAL (verified + named) models, keyed by cluster::database. */
    private readonly finalCache = new Map<string, FinalModel>();

    constructor(
        private readonly schema: SchemaProvider,
        private readonly store?: RelationshipModelStore,
    ) {}

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
        const key = this.key(cluster, database);
        return this.compose(base, this.authored.get(key));
    }

    /**
     * Layers any authored edges over an inferred base. When there are no
     * overlays the base object is returned as-is (identity preserved, which the
     * inferred-cache reuse tests rely on).
     */
    private compose(
        base: DatabaseRelationshipModel,
        authored: AuthoredRelationships | undefined,
    ): DatabaseRelationshipModel {
        const layers: EdgeLayer[] = [];
        if (authored && authored.edges.length > 0) {
            layers.push({ rank: SOURCE_RANK[authored.source], source: authored.source, edges: authored.edges });
        }
        if (layers.length === 0) {
            return base; // common case: no overlays, return the cached object as-is (identity preserved).
        }
        layers.unshift({ rank: SOURCE_RANK.inferred, source: 'inferred', edges: base.edges });
        return mergeLayers(base, layers);
    }

    /**
     * Builds (or returns a cached) FINAL relationship model for a database — the
     * end-to-end pipeline the Explore panel asks for: infer (heuristic) → verify
     * against data (prune) → name (forward/reverse). This is where the
     * "expensive work" happens; the result is cached per database and reused
     * until the schema or the naming version changes, so a database is only
     * built once per session (the first explore pays the cost).
     *
     * `onProgress` reports each phase so the caller can show in-place status while
     * the build runs (the first build can take tens of seconds). Cancellation is
     * cooperative: the partially-built model is returned rather than throwing.
     * Returns undefined only if the schema can't be loaded.
     */
    async getRelationships(
        cluster: string,
        database: string,
        deps: RelationshipBuildDeps,
        token?: CancellationLike,
        onProgress?: RelationshipBuildProgress,
        options?: { bypassCache?: boolean },
    ): Promise<DatabaseRelationshipModel | undefined> {
        const db = await this.schema.getDatabaseSchema(cluster, database);
        if (!db) { return undefined; }

        const base = this.ensureInferred(cluster, database, db);
        const key = this.key(cluster, database);
        const namingVersion = deps.namingVersion ?? 0;
        const bypassCache = options?.bypassCache === true;

        const cached = this.finalCache.get(key);
        if (!bypassCache
            && cached
            && cached.schemaVersion === base.schemaVersion
            && cached.namingVersion === namingVersion) {
            return cached.model;
        }

        // Fall back to the persistent store (survives across sessions). A snapshot
        // is only honored when both version axes still match the live schema; a
        // stale one is ignored and overwritten by the rebuild below.
        if (!bypassCache) {
            const persisted = this.loadPersisted(key, base.schemaVersion, namingVersion);
            if (persisted) { return persisted; }
        }

        // 1. Heuristic inference (composed with any authored overlay).
        onProgress?.({ kind: 'inferring' });
        const merged = this.compose(base, this.authored.get(key));
        if (!merged) { return undefined; }

        // 2. Data verification (prune spurious/hallucinated edges).
        let edges = merged.edges;
        if (deps.verifier && edges.length > 0 && !token?.isCancellationRequested) {
            edges = await deps.verifier(
                cluster,
                database,
                edges,
                token,
                (done, total) => onProgress?.({ kind: 'verifying', done, total }),
            );
        }

        // 3. Naming (forward/reverse navigation names for the survivors).
        if (deps.namer && edges.length > 0 && !token?.isCancellationRequested) {
            onProgress?.({ kind: 'naming', total: edges.length });
            edges = await deps.namer(edges, token);
        }

        const finalModel = createRelationshipModel(
            cluster,
            database,
            highestSource(edges, merged.source),
            base.schemaVersion,
            base.algorithmVersion,
            edges,
        );

        // Don't cache a partial (cancelled) build, so a real one runs next time.
        if (!bypassCache && !token?.isCancellationRequested) {
            this.finalCache.set(key, {
                schemaVersion: base.schemaVersion,
                namingVersion,
                model: finalModel,
            });
            this.store?.save(key, {
                schemaVersion: base.schemaVersion,
                namingVersion,
                cluster,
                database,
                source: finalModel.source,
                algorithmVersion: base.algorithmVersion,
                edges: finalModel.edges,
            });
        }
        return finalModel;
    }

    /**
     * Rebuilds a final model from a persisted snapshot when it's still valid for
     * the live schema + naming version, warming the in-memory cache so subsequent
     * calls hit it directly. Returns undefined when there's no store, no snapshot,
     * or the snapshot is stale.
     */
    private loadPersisted(
        key: string,
        schemaVersion: string,
        namingVersion: number,
    ): DatabaseRelationshipModel | undefined {
        const snap = this.store?.load(key);
        if (!snap || snap.schemaVersion !== schemaVersion || snap.namingVersion !== namingVersion) {
            return undefined;
        }
        const model = createRelationshipModel(
            snap.cluster,
            snap.database,
            snap.source,
            snap.schemaVersion,
            snap.algorithmVersion,
            snap.edges,
        );
        this.finalCache.set(key, { schemaVersion, namingVersion, model });
        return model;
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
        source: AuthoredSource,
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
        const key = this.key(cluster, database);
        this.inferredCache.delete(key);
        this.finalCache.delete(key);
    }

    /** Drops every cached inferred model for a cluster (e.g. on cluster schema refresh). */
    invalidateCluster(cluster: string): void {
        const prefix = `${cluster}::`;
        for (const key of [...this.inferredCache.keys()]) {
            if (key.startsWith(prefix)) {
                this.inferredCache.delete(key);
            }
        }
        for (const key of [...this.finalCache.keys()]) {
            if (key.startsWith(prefix)) {
                this.finalCache.delete(key);
            }
        }
    }

    /** Clears the entire cache (inferred + authored). */
    clear(): void {
        this.inferredCache.clear();
        this.authored.clear();
        this.finalCache.clear();
    }
}

/** One precedence tier of edges to merge. Higher `rank` overrides lower for a shared column. */
interface EdgeLayer {
    rank: number;
    source: RelationshipSource;
    edges: ForeignKeyEdge[];
}

/** Stable per-child-column key used to resolve conflicts across tiers. */
function edgeColumnKey(e: ForeignKeyEdge): string {
    return `${e.fromTable.toLowerCase()}::${e.fromColumn.toLowerCase()}`;
}

/** The highest-precedence source present among the edges, or `fallback` if none. */
function highestSource(edges: ForeignKeyEdge[], fallback: RelationshipSource): RelationshipSource {
    let best = fallback;
    let bestRank = -1;
    for (const e of edges) {
        const rank = SOURCE_RANK[e.source];
        if (rank > bestRank) { bestRank = rank; best = e.source; }
    }
    return best;
}

/**
 * Merges several precedence tiers of edges over an inferred base. For each child
 * column (fromTable, fromColumn) only the highest-ranked tier that has any edge
 * survives — the same child column can't have parents declared by two different
 * sources; the higher-rank source wins (and contributes ALL its edges for that
 * column, so an AI/authored disambiguation collapses multiple ambiguous inferred
 * candidates). The resulting model's `source` reflects the highest source that
 * actually contributed an edge.
 */
function mergeLayers(
    base: DatabaseRelationshipModel,
    layers: EdgeLayer[],
): DatabaseRelationshipModel {
    // Find, per child column, the highest tier rank that has an edge for it.
    const maxRankForKey = new Map<string, number>();
    for (const layer of layers) {
        for (const e of layer.edges) {
            const k = edgeColumnKey(e);
            const cur = maxRankForKey.get(k);
            if (cur === undefined || layer.rank > cur) {
                maxRankForKey.set(k, layer.rank);
            }
        }
    }

    // Keep only edges whose tier is the winning tier for their child column.
    const merged: ForeignKeyEdge[] = [];
    let topRank = SOURCE_RANK.inferred;
    let topSource: RelationshipSource = 'inferred';
    for (const layer of layers) {
        for (const e of layer.edges) {
            if (maxRankForKey.get(edgeColumnKey(e)) === layer.rank) {
                merged.push(e);
                if (layer.rank >= topRank) {
                    topRank = layer.rank;
                    topSource = layer.source;
                }
            }
        }
    }

    return createRelationshipModel(
        base.cluster,
        base.database,
        topSource,
        base.schemaVersion,
        base.algorithmVersion,
        merged,
    );
}
