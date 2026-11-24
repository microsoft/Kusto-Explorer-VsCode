// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';
import {
    buildContentSecurityPolicy,
    createNonce,
    escapeForInlineScript,
    finalizeWebviewHtml,
    WebviewLibraries,
} from '../../features/webviewHtml';

const context = { cspSource: 'https://csp.example', mediaUri: 'https://media.example/dist/media' };

describe('webviewHtml', () => {
    describe('createNonce', () => {
        it('returns distinct 32-character hex strings', () => {
            const a = createNonce();
            const b = createNonce();
            expect(a).toMatch(/^[0-9a-f]{32}$/);
            expect(a).not.toBe(b);
        });
    });

    describe('buildContentSecurityPolicy', () => {
        it('allows only nonce scripts and webview resources', () => {
            expect(buildContentSecurityPolicy('https://csp.example', 'abc')).toBe(
                "default-src 'none'; script-src 'nonce-abc' https://csp.example; "
                + "style-src https://csp.example 'unsafe-inline'; img-src https://csp.example data: blob:; "
                + 'font-src https://csp.example data:');
        });
    });

    describe('finalizeWebviewHtml', () => {
        it('adds the nonce to every script tag', () => {
            const html = finalizeWebviewHtml(
                '<html><head><script src="a.js"></script></head><body><SCRIPT>x()</SCRIPT><script\ttype="module"></script></body></html>',
                context, 'n1');
            expect(html).toContain('<script nonce="n1" src="a.js">');
            expect(html).toContain('<script nonce="n1">x()');
            expect(html).toContain('<script nonce="n1"\ttype="module">');
            expect(html).not.toMatch(/<script(?! nonce="n1")/i);
        });

        it('does not touch elements that only start with "script"', () => {
            const html = finalizeWebviewHtml('<head></head><scripted></scripted>', context, 'n1');
            expect(html).toContain('<scripted>');
        });

        it('replaces the media placeholder with the webview media URI', () => {
            const html = finalizeWebviewHtml(
                `<head><link href="${WebviewLibraries.simpleDataTablesStyle}"></head><script src="${WebviewLibraries.plotly}"></script>`,
                context, 'n1');
            expect(html).toContain('href="https://media.example/dist/media/simple-datatables.css"');
            expect(html).toContain('src="https://media.example/dist/media/plotly-strict.min.js"');
            expect(html).not.toContain('{{');
        });

        it('inserts the CSP meta at the start of an existing head', () => {
            const html = finalizeWebviewHtml('<!DOCTYPE html><html><head lang="en"><title>t</title></head></html>', context, 'n1');
            expect(html).toMatch(/^<!DOCTYPE html><html><head lang="en"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-n1' https:\/\/csp.example;[^"]*"><title>/);
        });

        it('adds a head after the html tag when there is none', () => {
            const html = finalizeWebviewHtml('<html lang="en"><body></body></html>', context, 'n1');
            expect(html).toMatch(/^<html lang="en"><head><meta http-equiv="Content-Security-Policy" [^>]*><\/head><body>/);
        });

        it('prepends a head to a fragment', () => {
            const html = finalizeWebviewHtml('<div>x</div>', context, 'n1');
            expect(html).toMatch(/^<head><meta http-equiv="Content-Security-Policy" [^>]*><\/head><div>x<\/div>$/);
        });

        it('does not treat a header element as the head', () => {
            const html = finalizeWebviewHtml('<html><header></header></html>', context, 'n1');
            expect(html).toMatch(/^<html><head><meta [^>]*><\/head><header>/);
        });
    });

    describe('escapeForInlineScript', () => {
        const tricky = {
            close: '</script><script>alert(1)</script>',
            comment: '<!-- x',
            quote: "it's",
            backslash: 'a\\b"c',
            separators: 'a\u2028b\u2029c',
        };

        it('round-trips as a JS literal without markup characters', () => {
            const escaped = escapeForInlineScript(JSON.stringify(tricky), false);
            expect(escaped).not.toContain('<');
            expect(escaped).not.toMatch(/[\u2028\u2029]/);
            expect(new Function(`return ${escaped};`)()).toEqual(tricky);
        });

        it('round-trips inside a single-quoted string passed to JSON.parse', () => {
            const escaped = escapeForInlineScript(JSON.stringify(tricky), true);
            expect(escaped).not.toContain('<');
            expect(escaped).not.toMatch(/[\u2028\u2029]/);
            expect(new Function(`return JSON.parse('${escaped}');`)()).toEqual(tricky);
        });

        it('leaves no script tag for finalizeWebviewHtml to mistake for markup', () => {
            const script = `<script>var d = ${escapeForInlineScript(JSON.stringify(tricky), false)};</script>`;
            const html = finalizeWebviewHtml(script, context, 'n1');
            expect(html.match(/<script/g)).toHaveLength(1);
        });
    });
});
