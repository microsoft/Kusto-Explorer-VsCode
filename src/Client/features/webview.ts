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
 * A controller calls `setup()` to declare page-level dependencies
 * (scripts, styles), then uses `setContent()` to push HTML into its
 * region of the page.  `invoke()` / `handle()` provide bidirectional
 * messaging between the extension and the webview page scripts.
 */
export interface IWebView {
    /** Setup: provide HTML for the page &lt;head&gt; and end-of-body scripts. */
    setup(headHtml: string, scriptsHtml: string): void;
    /** Push HTML content into the controller's region of the page. */
    setContent(html: string): void;
    /** Send a command to the webview page scripts. */
    invoke(command: string, args?: Record<string, unknown>): void;
    /** Subscribe to messages from the webview. Returns a disposable to unsubscribe. */
    handle(handler: (message: Record<string, unknown>) => void): { dispose(): void };
}
