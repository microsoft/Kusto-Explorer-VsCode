// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * This module implements the HistoryManager class.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as server from './server';

// =============================================================================
// Constants
// =============================================================================

/** Maximum number of history entries to keep. */
const MAX_HISTORY_ENTRIES = 200;

/** Filename for the lightweight index that powers the tree view. */
const INDEX_FILE = 'history-index.json';

/** Lightweight metadata for a history entry (stored in the index file). */
export interface HistoryEntry {
    /** Filename of the .kqr file in the history directory. */
    fileName: string;
    /** ISO 8601 timestamp of when the query was executed. */
    timestamp: string;
    /**
     * Short, human-friendly label for display. Derived from the first
     * meaningful leading comment in the query when available, otherwise
     * from the comment-stripped (server-minified) query text.
     */
    queryPreview: string;
    /**
     * Truncated server-minified (comment-stripped) query text, suitable for
     * showing in a tooltip alongside `queryPreview`.
     */
    minifiedPreview?: string;
    /** Cluster the query was run against. */
    cluster?: string;
    /** Database the query was run against. */
    database?: string;
    /** Number of result rows. */
    rowCount?: number;
    /** ISO 8601 timestamp of when query execution started. */
    executionStartedAt?: string;
    /** Query execution duration measured by the client, in milliseconds. */
    executionDurationMs?: number;
    /** Client request id used for the Kusto query. */
    clientRequestId?: string;
    /** FNV-1a hash of the server-minified query text, for CodeLens and result lookup. */
    queryHash?: number;
}

/** Maximum length of the display label stored in `queryPreview`. */
const MAX_LABEL_LENGTH = 60;

/** Maximum length of the minified query snippet stored in `minifiedPreview`. */
const MAX_MINIFIED_PREVIEW_LENGTH = 200;

/**
 * Computes a 32-bit FNV-1a hash of a string.
 */
function fnv1aHash(str: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0; // ensure unsigned
}

/**
 * Strips leading/trailing decorative "border" characters and whitespace from a
 * comment line (e.g. the `/`, `=`, `-`, `_`, `#`, `~` chars used to draw
 * banners around comments).
 */
function stripCommentBorder(text: string): string {
    return text
        .replace(/^[\s/=\-_#~]+/, '')
        .replace(/[\s/=\-_#~]+$/, '');
}

/** Returns true if the string contains at least one letter or digit (any script). */
function hasMeaningfulText(text: string): boolean {
    return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Collapses whitespace and truncates to at most `max` Unicode code points.
 * Uses `Array.from` so surrogate pairs (e.g., emoji, supplementary-plane CJK)
 * are kept intact rather than split mid-character.
 */
function collapseAndTruncate(text: string, max: number): string {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    const codePoints = Array.from(collapsed);
    return codePoints.length > max ? codePoints.slice(0, max).join('') : collapsed;
}

/**
 * Computes a human-friendly display label for a query result history entry.
 *
 * Strategy (Kusto only has `//` line comments):
 *   1. Walk leading lines, skipping blanks and decorative-only comment lines.
 *   2. Strip border characters (`/`, `=`, `-`, `_`, `#`, `~`) from comments.
 *   3. Use the first comment line that contains real text (letters/digits).
 *   4. Otherwise fall back to the minified query (no comments) if available,
 *      else the remaining query text past the leading comment block.
 *
 * Exported for unit testing.
 */
export function computeHistoryDisplayLabel(query: string | undefined, minifiedQuery?: string): string {
    const fallback = 'query';
    if (!query || query.trim() === '') {
        const minTrim = minifiedQuery?.trim();
        return minTrim ? collapseAndTruncate(minTrim, MAX_LABEL_LENGTH) : fallback;
    }

    const lines = query.split(/\r?\n/);
    let firstCodeLine = lines.length;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i]!.trim();
        if (trimmed === '') {
            continue;
        }

        // Single-line comment.
        if (trimmed.startsWith('//')) {
            const content = stripCommentBorder(trimmed.slice(2));
            if (hasMeaningfulText(content)) {
                return collapseAndTruncate(content, MAX_LABEL_LENGTH);
            }
            continue;
        }

        // First non-blank, non-comment line — leading comment block (if any)
        // had no meaningful text. Stop walking and use the fallback below.
        firstCodeLine = i;
        break;
    }

    // Fall back to the comment-stripped server-minified query when available;
    // otherwise use the original query text past the leading comment block.
    const minTrim = minifiedQuery?.trim();
    if (minTrim && minTrim.length > 0) {
        return collapseAndTruncate(minTrim, MAX_LABEL_LENGTH);
    }
    const remainder = lines.slice(firstCodeLine).join('\n');
    const collapsed = collapseAndTruncate(remainder, MAX_LABEL_LENGTH);
    return collapsed.length > 0 ? collapsed : fallback;
}

/**
 * Manages a persitent list of query history data
 */
export class HistoryManager {
    private readonly historyDir: string;
    private readonly indexPath: string;
    private readonly server: server.IServer;
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    private readonly _onDidAddEntry = new vscode.EventEmitter<HistoryEntry>();

    /** Fires after any mutation (add, delete, clear) so the UI can refresh. */
    readonly onDidChange = this._onDidChange.event;

    /** Fires after a new entry is added, carrying its metadata for UI reveal. */
    readonly onDidAddEntry = this._onDidAddEntry.event;

    constructor(context: vscode.ExtensionContext, server: server.IServer) {
        this.server = server;
        this.historyDir = path.join(context.globalStorageUri.fsPath, 'history');
        fs.mkdirSync(this.historyDir, { recursive: true });
        this.indexPath = path.join(this.historyDir, INDEX_FILE);
    }

    // ─── Index I/O ──────────────────────────────────────────────────────

    private readIndex(): HistoryEntry[] {
        try {
            if (fs.existsSync(this.indexPath)) {
                return JSON.parse(fs.readFileSync(this.indexPath, 'utf-8')) as HistoryEntry[];
            }
        } catch { /* corrupt index — start fresh */ }
        return [];
    }

    private writeIndex(entries: HistoryEntry[]): void {
        fs.writeFileSync(this.indexPath, JSON.stringify(entries, null, 2), 'utf-8');
    }

    // ─── Public API ─────────────────────────────────────────────────────

    /**
     * Returns the server-minified (comment-stripped, whitespace-collapsed)
     * form of `query`, or the original query if minification isn't available.
     */
    private async getMinifiedQuery(query: string): Promise<string> {
        return (await this.server.getMinifiedQuery(query))?.minifiedQuery ?? query;
    }

    /** Computes the canonical history hash for an already-minified query. */
    private hashMinifiedQuery(minifiedQuery: string): number {
        return fnv1aHash(minifiedQuery);
    }

    /** Computes a hash of the server-minified query text. */
    private async computeQueryHash(query: string): Promise<number> {
        return this.hashMinifiedQuery(await this.getMinifiedQuery(query));
    }

    /** Returns all history entry metadata, most recent first. */
    getEntries(): HistoryEntry[] {
        return this.readIndex();
    }

    /**
     * Adds a query result to the history. Writes a .kqr file and prepends
     * the entry to the index. Returns the URI of the new history file.
     */
    async addHistoryEntry(resultData: server.ResultData): Promise<vscode.Uri> {
        const now = new Date();
        const timestamp = now.toISOString();
        const datePart = timestamp.replace(/[-:]/g, '').replace('T', '_').replace(/\.\d+Z$/, '');

        // Fetch the server-minified (comment-stripped) query once so we can
        // use it both to derive a meaningful display label and to compute the
        // query hash.
        const minifiedQuery = resultData.query
            ? await this.getMinifiedQuery(resultData.query)
            : undefined;

        // Build a short display label from the query text, preferring a
        // meaningful comment when present and otherwise falling back to the
        // minified query.
        const querySnippet = computeHistoryDisplayLabel(resultData.query, minifiedQuery);
        // Sanitize for use as a filename
        const safeName = querySnippet.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 40);
        const fileName = `${datePart}_${safeName}.kqr`;

        const filePath = path.join(this.historyDir, fileName);
        const content = JSON.stringify(resultData, null, 2);
        await fs.promises.writeFile(filePath, content, 'utf-8');

        const rowCount = resultData.tables.reduce((sum, t) => sum + (t.rows?.length ?? 0), 0);
        const queryHash = minifiedQuery !== undefined ? this.hashMinifiedQuery(minifiedQuery) : undefined;
        const minifiedPreview = minifiedQuery !== undefined
            ? collapseAndTruncate(minifiedQuery, MAX_MINIFIED_PREVIEW_LENGTH)
            : undefined;

        const meta: HistoryEntry = {
            fileName,
            timestamp,
            queryPreview: querySnippet,
            ...(minifiedPreview && { minifiedPreview }),
            ...(resultData.cluster !== undefined && { cluster: resultData.cluster }),
            ...(resultData.database !== undefined && { database: resultData.database }),
            rowCount,
            ...(resultData.executionStartedAt !== undefined && { executionStartedAt: resultData.executionStartedAt }),
            ...(resultData.executionDurationMs !== undefined && { executionDurationMs: resultData.executionDurationMs }),
            ...(resultData.clientRequestId !== undefined && { clientRequestId: resultData.clientRequestId }),
            ...(queryHash !== undefined && { queryHash }),
        };

        // Prepend to index and enforce max size
        const index = this.readIndex();
        index.unshift(meta);
        if (index.length > MAX_HISTORY_ENTRIES) {
            // Remove oldest entries and delete their files
            const removed = index.splice(MAX_HISTORY_ENTRIES);
            for (const entry of removed) {
                const p = path.join(this.historyDir, entry.fileName);
                try { await fs.promises.unlink(p); } catch { /* ignore */ }
            }
        }
        this.writeIndex(index);
        this._onDidChange.fire();
        this._onDidAddEntry.fire(meta);

        return vscode.Uri.file(filePath);
    }

    /** Reads the ResultData from a history .kqr file. */
    async readHistoryFile(uri: vscode.Uri): Promise<server.ResultData | undefined> {
        try {
            const content = await fs.promises.readFile(uri.fsPath, 'utf-8');
            return JSON.parse(content) as server.ResultData;
        } catch {
            return undefined;
        }
    }

    /** Writes updated ResultData back to a history .kqr file. */
    async writeHistoryFile(uri: vscode.Uri, data: server.ResultData): Promise<void> {
        const content = JSON.stringify(data, null, 2);
        await fs.promises.writeFile(uri.fsPath, content, 'utf-8');
    }

    /** Returns the URI for a history entry's backing file. */
    getHistoryFileUri(fileName: string): vscode.Uri {
        return vscode.Uri.file(path.join(this.historyDir, fileName));
    }

    /**
     * Returns true if any history entry is a match for the query, ignoring insignificant whitespace and comments.
     * It is unlikely, but possible, that this produces a false positive, as the match is hash based.
     */
    async hasEntryForQuery(query: string): Promise<boolean> {
        const queryHash = await this.computeQueryHash(query);
        return this.readIndex().some(e => e.queryHash === queryHash);
    }

    /**
     * Finds the most recent history entry whose query matches,
     * or undefined if no match is found.
     */
    async getMatchingEntry(query: string): Promise<HistoryEntry | undefined> {
        const queryHash = await this.computeQueryHash(query);
        return this.readIndex().find(e => e.queryHash === queryHash);
    }

    /**
     * Reads the ResultData for a history entry.
     */
    async getEntryData(entry: HistoryEntry): Promise<server.ResultData | undefined> {
        const uri = this.getHistoryFileUri(entry.fileName);
        return this.readHistoryFile(uri);
    }

    /** Deletes a single history entry's file and removes it from the index. */
    async deleteEntry(fileName: string): Promise<void> {
        const filePath = path.join(this.historyDir, fileName);
        try { await fs.promises.unlink(filePath); } catch { /* ignore */ }

        const index = this.readIndex();
        const filtered = index.filter(e => e.fileName !== fileName);
        this.writeIndex(filtered);
        this._onDidChange.fire();
    }

    /** Deletes all history entries and clears the index. */
    async clearAllEntries(): Promise<void> {
        const index = this.readIndex();
        for (const entry of index) {
            const filePath = path.join(this.historyDir, entry.fileName);
            try { await fs.promises.unlink(filePath); } catch { /* ignore */ }
        }
        this.writeIndex([]);
        this._onDidChange.fire();
    }
}
