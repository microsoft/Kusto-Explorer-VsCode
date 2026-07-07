// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Generic webview abstraction for extension ↔ webview communication.
 *
 * Controllers (chart rendering, chart editor, etc.) use this interface
 * to interact with a region of a webview page without depending on
 * VS Code webview types directly.
 */

// ─── Interface ──────────────────────────────────────────────────────────────

/**
 * Abstraction for a region within a webview page.
 *
 * Controllers may call `setup()` multiple times during region construction to
 * declare page-level dependencies (scripts, styles); implementations should
 * accumulate those fragments rather than replacing earlier ones. Re-registering
 * the same fragment should be idempotent so repeated construction attempts do
 * not duplicate page scripts. Controllers then use `setContent()` to push HTML
 * into their region of the page. `invoke()` / `handle()` provide bidirectional
 * messaging between the extension and the webview page scripts.
 */
export interface IWebView {
    /** Setup: add HTML for the page &lt;head&gt; and end-of-body scripts. */
    setup(headHtml: string, scriptsHtml: string): void;
    /** Push HTML content into the controller's region of the page. */
    setContent(html: string): void;
    /** Send a command to the webview page scripts. */
    invoke(command: string, args?: Record<string, unknown>): void;
    /** Subscribe to messages from the webview. Returns a disposable to unsubscribe. */
    handle(handler: (message: Record<string, unknown>) => void): { dispose(): void };
}
