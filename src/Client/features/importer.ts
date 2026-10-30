// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * This module implements the Importer class, which handles the UI concerns
 * of importing connections and scratch pads from desktop Kusto Explorer,
 * importing from user-picked files, and exporting connections.
 * The actual import logic lives in ImportManager.
 */

import * as vscode from 'vscode';
import { type ConnectionManager } from './connectionManager';
import { ImportManager, type ImportFile } from './importManager';
import { pathBaseName, uriFileName } from './fileStore';

// =============================================================================
// Constants
// =============================================================================

/** Configuration key to suppress the import prompt. */
const SUPPRESS_IMPORT_SETTING = 'connections.suppressKustoExplorerImportPrompt';

/** Default file name for exported connections. */
const EXPORT_FILE_NAME = 'kusto-connections.json';

// =============================================================================
// Importer Class
// =============================================================================

/**
 * Handles the UI concerns of importing from desktop Kusto Explorer.
 * Registers commands, shows prompts and confirmation dialogs,
 * and displays result messages. Delegates to ImportManager for the actual logic.
 */
export class Importer {
    constructor(
        private readonly importManager: ImportManager,
        private readonly connections: ConnectionManager,
    ) {}

    /**
     * Checks if Kusto Explorer connections exist and the user hasn't dismissed
     * the prompt, then offers to import. Only prompts when the user has no
     * existing connections.
     * @returns true if the user made a definitive choice (Import or Don't Ask Again),
     *          false if they dismissed or no prompt was shown.
     */
    async promptImportIfAvailable(): Promise<boolean> {
        // Only prompt if user has no connections and hasn't suppressed the prompt
        if (vscode.workspace.getConfiguration('msKustoExplorer').get<boolean>(SUPPRESS_IMPORT_SETTING)) {
            return true;
        }

        const existingConnections = this.connections.getConfiguredConnections();
        if (existingConnections.length > 0) {
            return true;
        }

        const hasConnections = this.importManager.hasConnectionsToImport();
        const hasScratchPads = this.importManager.hasScratchPadsToImport();

        if (!hasConnections && !hasScratchPads) {
            return true;
        }

        const what = hasConnections && hasScratchPads ? 'connections and query set documents'
            : hasConnections ? 'connections'
            : 'query set documents';

        const choice = await vscode.window.showInformationMessage(
            `Kusto Explorer ${what} found. Would you like to import them?`,
            { modal: true },
            'Import',
            "Don't Ask Again"
        );

        if (choice === 'Import') {
            if (hasConnections) {
                await this.importConnections(true);
            }
            if (hasScratchPads) {
                await this.importScratchPads(true);
            }
            return true;
        } else if (choice === "Don't Ask Again") {
            await vscode.workspace.getConfiguration('msKustoExplorer').update(SUPPRESS_IMPORT_SETTING, true, vscode.ConfigurationTarget.Global);
            return true;
        }
        // Dismissed (no choice) — caller may re-prompt later
        return false;
    }

    // ─── Import Connections ───────────────────────────────────────────

    /**
     * Import connections entry point with UI prompts and result messages.
     */
    async importConnections(skipConfirm = false): Promise<void> {
        if (!this.importManager.canReadKustoExplorerData) {
            await this.importFromFile();
            return;
        }

        if (!skipConfirm) {
            const confirm = await vscode.window.showInformationMessage(
                'Import connections from Kusto Explorer?',
                { modal: true },
                'Import'
            );
            if (confirm !== 'Import') { return; }
        }

        try {
            const result = await this.importManager.importConnections();

            if (!result) {
                vscode.window.showErrorMessage('No Kusto Explorer installation found.');
                return;
            }

            const { importedCount, skippedCount } = result;

            if (importedCount > 0) {
                const skippedMsg = skippedCount > 0 ? ` (${skippedCount} duplicates skipped)` : '';
                vscode.window.showInformationMessage(
                    `Imported ${importedCount} connection${importedCount !== 1 ? 's' : ''} from Kusto Explorer${skippedMsg}.`
                );
            } else if (skippedCount > 0) {
                vscode.window.showInformationMessage(
                    `All ${skippedCount} Kusto Explorer connection${skippedCount !== 1 ? 's' : ''} already exist.`
                );
            } else {
                vscode.window.showInformationMessage('No connections found in Kusto Explorer.');
            }
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`Failed to import connections: ${message}`);
        }
    }

    // ─── Import Scratch Pads ────────────────────────────────────────────

    /**
     * Import scratch pads entry point with UI prompts and result messages.
     */
    async importScratchPads(skipConfirm = false): Promise<void> {
        if (!this.importManager.canReadKustoExplorerData) {
            await this.importFromFile();
            return;
        }

        if (!this.importManager.hasScratchPadsToImport()) {
            vscode.window.showInformationMessage('No Kusto Explorer scratch pad documents found to import.');
            return;
        }

        const scratchPadCount = this.importManager.getScratchPadsToImportCount();

        if (!skipConfirm) {
            const confirm = await vscode.window.showInformationMessage(
                `Import ${scratchPadCount} scratch pad document${scratchPadCount !== 1 ? 's' : ''} from Kusto Explorer?`,
                { modal: true },
                'Import'
            );
            if (confirm !== 'Import') { return; }
        }

        const importResult = await this.importManager.importScratchPads();

        if (importResult && importResult.importedCount > 0) {
            vscode.window.showInformationMessage(
                `Imported ${importResult.importedCount} scratch pad document${importResult.importedCount !== 1 ? 's' : ''} from Kusto Explorer.`
            );
        }
    }

    // ─── Import from Files ──────────────────────────────────────────────

    /**
     * Lets the user pick Kusto Explorer connection files (UserConnections.xml,
     * UserConnectionGroups.xml), scratch pad recovery files (.kebak), or a
     * connections export (.json), and imports them.
     */
    async importFromFile(): Promise<void> {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Import',
            title: 'Import Connections or Scratch Pads',
            filters: {
                'Kusto Explorer or connection files': ['xml', 'kebak', 'json'],
                'All files': ['*'],
            },
        });
        if (!uris || uris.length === 0) { return; }

        try {
            const files = await Promise.all(uris.map(uri => this.readImportFile(uri, uris)));
            const result = await this.importManager.importFiles(files);

            const parts: string[] = [];
            if (result.importedConnections > 0) {
                parts.push(`${result.importedConnections} connection${result.importedConnections !== 1 ? 's' : ''}`);
            }
            if (result.importedScratchPads > 0) {
                parts.push(`${result.importedScratchPads} scratch pad document${result.importedScratchPads !== 1 ? 's' : ''}`);
            }
            const skippedMsg = result.skippedConnections > 0 ? ` (${result.skippedConnections} duplicates skipped)` : '';
            if (parts.length > 0) {
                vscode.window.showInformationMessage(`Imported ${parts.join(' and ')}${skippedMsg}.`);
            } else if (result.skippedConnections > 0) {
                vscode.window.showInformationMessage(
                    `All ${result.skippedConnections} connection${result.skippedConnections !== 1 ? 's' : ''} already exist.`
                );
            } else if (result.unrecognizedFiles.length === 0 && result.missingGroupFiles.length === 0) {
                vscode.window.showInformationMessage('Nothing to import in the selected files.');
            }

            if (result.unrecognizedFiles.length > 0) {
                vscode.window.showWarningMessage(
                    `Not a Kusto Explorer connections, scratch pad, or connections export file: ${result.unrecognizedFiles.join(', ')}`
                );
            }
            if (result.missingGroupFiles.length > 0) {
                vscode.window.showWarningMessage(
                    `Couldn't read these connection group files; select them together with UserConnectionGroups.xml: ${result.missingGroupFiles.join(', ')}`
                );
            }
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`Failed to import: ${message}`);
        }
    }

    /** Reads a picked file, resolving the group files a UserConnectionGroups.xml references. */
    private async readImportFile(uri: vscode.Uri, pickedUris: readonly vscode.Uri[]): Promise<ImportFile> {
        return {
            name: uriFileName(uri),
            text: await readText(uri),
            readReferencedFile: async (filePath: string) => {
                // Group files are referenced by absolute Windows paths. Prefer a picked file with
                // the same name, then a file of that name next to this one, then the path itself.
                const name = pathBaseName(filePath).toLowerCase();
                const candidates = [
                    ...pickedUris.filter(u => uriFileName(u).toLowerCase() === name),
                    vscode.Uri.joinPath(uri, '..', pathBaseName(filePath)),
                    ...(uri.scheme === 'file' ? [vscode.Uri.file(filePath)] : []),
                ];
                for (const candidate of candidates) {
                    try {
                        return await readText(candidate);
                    } catch {
                        // Try the next candidate
                    }
                }
                return undefined;
            },
        };
    }

    // ─── Export Connections ─────────────────────────────────────────────

    /** Saves all configured servers and groups to a JSON file the user picks. */
    async exportConnections(): Promise<void> {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
        const uri = await vscode.window.showSaveDialog({
            ...(folder ? { defaultUri: vscode.Uri.joinPath(folder, EXPORT_FILE_NAME) } : {}),
            saveLabel: 'Export',
            title: 'Export Connections',
            filters: { 'JSON': ['json'] },
        });
        if (!uri) { return; }

        try {
            await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(this.importManager.exportConnections()));
            const count = this.connections.getConfiguredConnections().length;
            vscode.window.showInformationMessage(`Exported ${count} connection${count !== 1 ? 's' : ''} to ${uriFileName(uri)}.`);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`Failed to export connections: ${message}`);
        }
    }
}

/** Reads a file as text, honoring a UTF-16 or UTF-8 byte order mark. */
async function readText(uri: vscode.Uri): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
        return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    }
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
        return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    }
    return new TextDecoder('utf-8').decode(bytes);
}
