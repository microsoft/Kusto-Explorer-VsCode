// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * This module implements the Clipboard class, which manages clipboard operations with rich context metadata.
 */

import * as vscode from 'vscode';

/** Generic clipboard context that can carry arbitrary metadata. */
export interface ClipboardContext {
    /** The text placed on the system clipboard. Used to verify the clipboard hasn't changed. */
    text: string;
    /** The kind of content that was copied (e.g. 'entity', 'query'). */
    kind: string;
    /** The source cluster name. */
    entityCluster?: string;
    /** The source database name. */
    entityDatabase?: string;
    /** The type of entity being copied (e.g. 'Table', 'Function'). */
    entityType?: string;
    /** The name of the entity being copied. */
    entityName?: string;
}

/** Describes a single item to place on the clipboard. */
export interface ClipboardItem {
    /** The clipboard format name (e.g. 'PNG', 'image/svg+xml', 'Text'). */
    format: string;
    /** The data to place on the clipboard. */
    data: string;
    /** How the data string is encoded. 'base64' decodes to raw bytes, 'utf8' encodes as UTF-8 bytes, 'text' sets the string directly. Defaults to 'utf8'. */
    encoding?: 'base64' | 'utf8' | 'text';
}

/** Interface for clipboard operations with rich context metadata. */
export interface IClipboard {
    setContext(context: ClipboardContext): void;
    getContext(): ClipboardContext | undefined;
    clearContext(): void;
    copyItems(items: ClipboardItem[]): Promise<void>;
    copyText(text: string): Promise<void>;
}

/** Places multiple data formats on the system clipboard (host-specific). */
export type MultiFormatCopier = (items: ClipboardItem[]) => Promise<void>;

/**
 * Manages clipboard operations with rich context metadata.
 */
export class Clipboard implements IClipboard {
    /** Stored clipboard context from the last copy operation with context. */
    private clipboardContext: ClipboardContext | undefined;

    /**
     * @param multiFormatCopier copies rich formats (HTML, PNG, …) where the host supports it
     *   (desktop Windows); without it only plain text is copied.
     */
    constructor(private readonly multiFormatCopier?: MultiFormatCopier) {
    }

    /**
     * Stores clipboard context alongside the system clipboard text.
     * Call this when copying content that should carry source connection metadata.
     */
    setContext(context: ClipboardContext): void {
        this.clipboardContext = context;
    }

    /**
     * Returns the current clipboard context, or undefined if none is set.
     */
    getContext(): ClipboardContext | undefined {
        return this.clipboardContext;
    }

    /**
     * Clears the stored clipboard context.
     */
    clearContext(): void {
        this.clipboardContext = undefined;
    }

    /**
     * Copies multiple data formats to the clipboard.
     * Uses the host's multi-format copier when there is one (PowerShell on Windows);
     * otherwise falls back to plain text only using VS Code's clipboard API.
     */
    async copyItems(items: ClipboardItem[]): Promise<void> {
        if (this.multiFormatCopier) {
            return this.multiFormatCopier(items);
        } else {
            return copyToClipboardFallback(items);
        }
    }

    /**
     * Copies plain text to the system clipboard.
     */
    async copyText(text: string): Promise<void> {
        await vscode.env.clipboard.writeText(text);
    }
}

/**
 * Wraps an HTML fragment in the Windows CF_HTML clipboard format,
 * which includes a header with byte offsets so that applications like
 * Word and Excel recognize the content as rich HTML.
 * @param html The raw HTML fragment to wrap
 * @returns The full CF_HTML formatted string
 */
export function formatCfHtml(html: string): string {
    // The header uses fixed-width 10-digit byte offsets.
    // We build a template first to measure the header length, then fill in real values.
    const header =
        'Version:0.9\r\n' +
        'StartHTML:XXXXXXXXXX\r\n' +
        'EndHTML:XXXXXXXXXX\r\n' +
        'StartFragment:XXXXXXXXXX\r\n' +
        'EndFragment:XXXXXXXXXX\r\n';

    const prefix = '<html><body>\r\n<!--StartFragment-->';
    const suffix = '<!--EndFragment-->\r\n</body></html>';

    const encoder = new TextEncoder();
    const headerBytes = encoder.encode(header).length;
    const prefixBytes = encoder.encode(prefix).length;
    const htmlBytes = encoder.encode(html).length;
    const suffixBytes = encoder.encode(suffix).length;

    const startHtml = headerBytes;
    const startFragment = headerBytes + prefixBytes;
    const endFragment = startFragment + htmlBytes;
    const endHtml = endFragment + suffixBytes;

    const pad = (n: number) => n.toString().padStart(10, '0');

    const filledHeader =
        'Version:0.9\r\n' +
        `StartHTML:${pad(startHtml)}\r\n` +
        `EndHTML:${pad(endHtml)}\r\n` +
        `StartFragment:${pad(startFragment)}\r\n` +
        `EndFragment:${pad(endFragment)}\r\n`;

    return filledHeader + prefix + html + suffix;
}

/**
 * Copies to clipboard using VS Code's plain text API.
 * Used as fallback where the host has no multi-format copier.
 */
async function copyToClipboardFallback(items: ClipboardItem[]): Promise<void> {
    // Find the best text item to use
    const textItem = items.find(i => i.format === 'Text' && i.encoding === 'text')
        ?? items.find(i => i.format === 'Text')
        ?? items.find(i => i.encoding === 'text');
    
    if (textItem) {
        await vscode.env.clipboard.writeText(textItem.data);
    } else {
        // No explicit text item, use first item's data as text if available
        const firstItem = items[0];
        if (firstItem) {
            await vscode.env.clipboard.writeText(firstItem.data);
        }
    }
}
