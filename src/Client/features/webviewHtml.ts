// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
*   Final pass over webview HTML before it is assigned to a webview: points bundled
*   library references at the extension's media folder and applies a nonce-based
*   Content Security Policy. Host-independent (no Node or VS Code APIs), so the
*   desktop and web builds share it.
*/

/**
 * Placeholder for the bundled webview library folder (`dist/media`). Providers emit
 * library references against it because only the webview knows its resource URI.
 */
export const WebviewMediaRoot = '{{kusto-explorer-media}}';

/** Bundled webview libraries, copied into `dist/media` by `scripts/copy-media.mjs`. */
export const WebviewLibraries = {
    plotly: `${WebviewMediaRoot}/plotly-strict.min.js`,
    cytoscape: `${WebviewMediaRoot}/cytoscape.min.js`,
    simpleDataTablesScript: `${WebviewMediaRoot}/simple-datatables.js`,
    simpleDataTablesStyle: `${WebviewMediaRoot}/simple-datatables.css`,
} as const;

export interface WebviewHtmlContext {
    /** The webview's `cspSource`. */
    readonly cspSource: string;
    /** The webview URI of the bundled media folder (`webview.asWebviewUri(...)`). */
    readonly mediaUri: string;
}

// Web Crypto is available in Node 19+ and browsers; tsconfig has no DOM lib.
declare const crypto: { getRandomValues(array: Uint8Array): Uint8Array };

export function createNonce(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function buildContentSecurityPolicy(cspSource: string, nonce: string): string {
    return [
        `default-src 'none'`,
        `script-src 'nonce-${nonce}' ${cspSource}`,
        // Charts and tables set inline styles throughout, and plotly injects <style> at runtime.
        `style-src ${cspSource} 'unsafe-inline'`,
        // Plotly renders images through data: and blob: URLs (e.g. copy-to-clipboard).
        `img-src ${cspSource} data: blob:`,
        `font-src ${cspSource} data:`,
    ].join('; ');
}

/**
 * Resolves bundled library references, adds the nonce to every `<script>` tag and
 * inserts the CSP `<meta>` into `<head>`. Generated HTML must not contain the text
 * `<script` other than as a tag: data embedded in scripts escapes `<` (see
 * {@link escapeForInlineScript}).
 */
export function finalizeWebviewHtml(html: string, context: WebviewHtmlContext, nonce: string = createNonce()): string {
    const withLibraries = html.split(WebviewMediaRoot).join(context.mediaUri);
    const withNonces = withLibraries.replace(/<script(?=[\s>])/gi, `<script nonce="${nonce}"`);
    const meta = `<meta http-equiv="Content-Security-Policy" content="${buildContentSecurityPolicy(context.cspSource, nonce)}">`;

    const head = /<head(\s[^>]*)?>/i.exec(withNonces);
    if (head) {
        const at = head.index + head[0].length;
        return withNonces.slice(0, at) + meta + withNonces.slice(at);
    }
    const root = /<html(\s[^>]*)?>/i.exec(withNonces);
    if (root) {
        const at = root.index + root[0].length;
        return withNonces.slice(0, at) + `<head>${meta}</head>` + withNonces.slice(at);
    }
    return `<head>${meta}</head>${withNonces}`;
}

/**
 * Escapes JSON for embedding in an inline `<script>`, either directly as a literal or
 * inside a single-quoted JS string passed to `JSON.parse`. Escaping every `<` keeps data
 * from closing the script, opening a comment, or being mistaken for a `<script` tag by
 * {@link finalizeWebviewHtml}; U+2028/U+2029 are escaped for pre-ES2019 engines.
 */
export function escapeForInlineScript(json: string, quoted: boolean): string {
    const escaped = quoted
        ? json.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
        : json;
    return escaped
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}
