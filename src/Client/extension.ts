// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { workspace, ExtensionContext, window } from 'vscode';
import * as dotnet from './features/dotnet'
import { SCRATCH_PAD_SCHEME } from './features/scratchPadManager'
import { ENTITY_DEFINITION_SCHEME } from './features/entityDefinitionProvider'
import { NullServer } from './features/server'
import type { IServer } from './features/server'
import { Server } from './features/lspServer'
import { activateFeatures } from './features/activation'
import { NodeFileStore } from './features/nodeFileStore'
import { KustoExplorerLocalData } from './features/kustoExplorerLocalData'
import { copyToClipboardWindows } from './features/windowsClipboard'
import
    {
        LanguageClient,
        LanguageClientOptions,
        ServerOptions,
        Executable
    } from 'vscode-languageclient/node';

let client: LanguageClient;

export async function activate(context: ExtensionContext)
{
    // Create output channel early so dotnet activation can log to it
    const outputChannel = window.createOutputChannel('Kusto');

    // ─── Language server (optional — requires .NET and Server.dll) ───

    let server: IServer = new NullServer();
    const serverDll = path.join(context.extensionPath, 'server', 'Server.dll');
    const dotnetPath = fs.existsSync(serverDll) ? await dotnet.activate(outputChannel) : undefined;

    if (dotnetPath) {
        const serverExecutable: Executable = {
            command: dotnetPath,
            args: [serverDll, "vscode"]
        };

        const serverOptions: ServerOptions = {
            run: serverExecutable,
            debug: serverExecutable
        };

        const clientOptions: LanguageClientOptions = {
            documentSelector: [
                { scheme: 'file', language: 'kusto' },
                { scheme: ENTITY_DEFINITION_SCHEME, language: 'kusto' },
                { scheme: SCRATCH_PAD_SCHEME, language: 'kusto' }
            ],
            synchronize: { 
                fileEvents: workspace.createFileSystemWatcher('**/*.{kql,csl,kusto}')
            },
            outputChannel: outputChannel,
            middleware: {
                provideCompletionItem: async (document, position, context, token, next) => {
                    const result = await next(document, position, context, token);
                    const globalCommitChars = client?.initializeResult?.capabilities
                        ?.completionProvider?.allCommitCharacters ?? [];
                    return fixCompletionCommit(result, globalCommitChars);
                }
            }
        };

        client = new LanguageClient(
            'kustoLanguageServer',
            'Kusto Language Server',
            serverOptions,
            clientOptions
        );

        try {
            await client.start();
            server = new Server(client, context);
        } catch (error) {
            outputChannel.appendLine(`Failed to start language server: ${error instanceof Error ? error.message : String(error)}`);
            window.showErrorMessage('Kusto language server failed to start. Language features will be unavailable.');
        }
    }

    // Register command to fix doubled commit characters after completion acceptance
    context.subscriptions.push(
        vscode.commands.registerCommand('msKustoExplorer.fixCommitCharDoubling', fixCommitCharDoubling)
    );

    // ─── UI features (always registered so integration tests will run) ────────────────────

    const storageDir = context.globalStorageUri.fsPath;
    const features = await activateFeatures(context, server, {
        scratchPadStore: new NodeFileStore(path.join(storageDir, 'scratchpads')),
        historyStore: new NodeFileStore(path.join(storageDir, 'history')),
        kustoExplorerLocalData: new KustoExplorerLocalData(),
        multiFormatCopier: process.platform === 'win32' ? copyToClipboardWindows : undefined,
    });

    // Expose internal components for integration tests
    return features;
}

export function deactivate(): Thenable<void> | undefined
{
    if (!client)
    {
        return undefined;
    }
    return client.stop();
}

/**
 * Identifies completion items where a commit character also appears in the insertText,
 * which would cause the character to be doubled when used to commit the completion.
 * Attaches a post-completion command that detects and removes the duplicate.
 * @param globalCommitChars Commit characters defined in server capabilities (apply to all items)
 */
function fixCompletionCommit(
    result: vscode.CompletionItem[] | vscode.CompletionList | null | undefined,
    globalCommitChars: string[]
): vscode.CompletionItem[] | vscode.CompletionList | null | undefined {
    if (!result) {
        return result;
    }

    const items = Array.isArray(result) ? result : result.items;

    for (const item of items) {
        // Use per-item commit characters if set, otherwise fall back to global
        const commitChars = (item.commitCharacters && item.commitCharacters.length > 0)
            ? item.commitCharacters
            : globalCommitChars;

        if (commitChars.length === 0) {
            continue;
        }

        const insertText = typeof item.insertText === 'string'
            ? item.insertText
            : item.insertText instanceof vscode.SnippetString
                ? item.insertText.value
                : undefined;

        if (!insertText) {
            continue;
        }

        // Find commit characters that appear in the insert text and could be doubled
        const conflicting = commitChars.filter(ch => insertText.includes(ch));
        if (conflicting.length > 0) {
            // Attach a command that runs after the completion is accepted.
            // It checks if the typed commit character was doubled and removes the duplicate.
            item.command = {
                title: '',
                command: 'msKustoExplorer.fixCommitCharDoubling',
                arguments: [conflicting, item.command]
            };
        }
    }

    return result;
}

/**
 * Handles the post-completion fix for doubled commit characters.
 * The command fires before the commit character is inserted into the document,
 * so we listen for the next document change and use the change event to find
 * where the commit character was inserted, then check if it caused a doubling.
 */
async function fixCommitCharDoubling(commitChars: string[], originalCommand?: vscode.Command): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'kusto') {
        const disposable = vscode.workspace.onDidChangeTextDocument(async (e) => {
            if (e.document !== editor.document) {
                return;
            }
            disposable.dispose();

            // Find a single-character insertion that matches a conflicting commit char
            for (const change of e.contentChanges) {
                if (change.text.length === 1 && commitChars.includes(change.text)) {
                    // The commit char was inserted at change.range.start
                    // Check if the character just before it is the same
                    const insertPos = change.range.start;
                    if (insertPos.character >= 1) {
                        const charBefore = e.document.getText(
                            new vscode.Range(insertPos.translate(0, -1), insertPos)
                        );
                        if (charBefore === change.text) {
                            // Delete the duplicate (the newly inserted one, now at insertPos)
                            await editor.edit(eb => {
                                eb.delete(new vscode.Range(insertPos, insertPos.translate(0, 1)));
                            }, { undoStopBefore: false, undoStopAfter: false });
                        }
                    }
                    break;
                }
            }
        });

        // Safety: dispose the listener if no change comes within 1 second.
        // Note: dispose() is idempotent, so calling it from both the handler and
        // this timeout is harmless. JS is single-threaded, so there is no race.
        setTimeout(() => disposable.dispose(), 1000);
    }

    // Preserve any original command from the server
    if (originalCommand) {
        await vscode.commands.executeCommand(originalCommand.command, ...(originalCommand.arguments ?? []));
    }
}
