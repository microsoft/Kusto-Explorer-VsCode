// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * This module acquires the .NET runtime needed to run the Kusto Language Server.
 * It first checks for a system-installed dotnet (version 10+), and falls back to the
 * VS Code .NET Runtime Acquisition extension if not found or if the user has opted out.
 */

import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

// Interface for the .NET Runtime Acquisition Extension API
interface IDotnetAcquireResult {
    dotnetPath: string;
}

const execFileAsync = promisify(execFile);

// Output channel for logging - will be set during activation
let outputChannel: vscode.OutputChannel | undefined;

function log(message: string): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [dotnet] ${message}`;
    outputChannel?.appendLine(logMessage);
    console.log(logMessage);
}

/**
 * Checks if dotnet is available in the system PATH.
 * @returns The path to dotnet if found and version is sufficient, undefined otherwise.
 */
async function findSystemDotnet(): Promise<string | undefined> {
    try
    {
        // call out to dotnet --version to check if it's available and get the version
        const { stdout } = await execFileAsync('dotnet', ['--version']);
        const version = stdout.trim();
        // Check if major version is 10 or higher
        const majorVersion = parseInt(version.split('.')[0] ?? '0', 10);
        if (majorVersion >= 10) {
            return 'dotnet';
        }
        log(`System dotnet version ${version} is below required version 10.0`);
        return undefined;
    } catch {
        // dotnet not found in PATH
        return undefined;
    }
}

const DOTNET_RUNTIME_EXTENSION_ID = 'ms-dotnettools.vscode-dotnet-runtime';
const EXTENSION_REGISTRATION_TIMEOUT_MS = 30_000;

/**
 * Installs the .NET runtime acquisition extension. It is not declared in
 * extensionDependencies because it has no web build, and a dependency the web
 * extension host cannot load stops this extension from activating there.
 * @returns The installed extension, or undefined if installation failed.
 */
async function installDotnetRuntimeExtension(): Promise<vscode.Extension<unknown> | undefined> {
    log(`Installing ${DOTNET_RUNTIME_EXTENSION_ID}`);
    try {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Kusto Explorer: installing the .NET Install Tool extension...' },
            () => Promise.resolve(vscode.commands.executeCommand('workbench.extensions.installExtension', DOTNET_RUNTIME_EXTENSION_ID))
        );
    } catch (error) {
        log(`Installing ${DOTNET_RUNTIME_EXTENSION_ID} failed: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
    return waitForExtension(DOTNET_RUNTIME_EXTENSION_ID, EXTENSION_REGISTRATION_TIMEOUT_MS);
}

/** Resolves once a newly installed extension is registered with the extension host. */
function waitForExtension(id: string, timeoutMs: number): Promise<vscode.Extension<unknown> | undefined> {
    const existing = vscode.extensions.getExtension(id);
    if (existing) {
        return Promise.resolve(existing);
    }
    return new Promise(resolve => {
        const finish = (extension: vscode.Extension<unknown> | undefined) => {
            clearTimeout(timer);
            listener.dispose();
            resolve(extension);
        };
        const listener = vscode.extensions.onDidChange(() => {
            const extension = vscode.extensions.getExtension(id);
            if (extension) {
                finish(extension);
            }
        });
        const timer = setTimeout(() => finish(vscode.extensions.getExtension(id)), timeoutMs);
    });
}

/**
 * Acquires the .NET runtime using the ms-dotnettools.vscode-dotnet-runtime extension,
 * installing that extension first if needed.
 * @returns The path to the dotnet executable, or undefined if acquisition failed.
 */
async function acquireDotnetFromExtension(): Promise<string | undefined> {
    try {
        const dotnetExtension = vscode.extensions.getExtension(DOTNET_RUNTIME_EXTENSION_ID) ?? await installDotnetRuntimeExtension();
        if (!dotnetExtension) {
            log('.NET Runtime acquisition extension not installed');
            return undefined;
        }

        if (!dotnetExtension.isActive) {
            await dotnetExtension.activate();
        }

        // Use the dotnet.acquire command to acquire the runtime
        const result = await vscode.commands.executeCommand<IDotnetAcquireResult>(
            'dotnet.acquire',
            { version: '10.0', requestingExtensionId: 'ms-kusto.kusto-explorer-vscode' }
        );
        
        if (result?.dotnetPath) {
            return result.dotnetPath;
        }

        log('.NET Runtime acquisition failed.');
        return undefined;
    } catch (error) {
        log(`.NET Runtime acquisition failed with error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        return undefined;
    }
}

/**
 * Finds or acquires the .NET runtime.
 * Tries system dotnet first (if enabled), then falls back to runtime acquisition.
 * @returns The path to the dotnet executable, or undefined if not available.
 */
async function getDotnetPath(): Promise<string | undefined> {
    const config = vscode.workspace.getConfiguration('msKustoExplorer');
    const useSystemDotnet = config.get<boolean>('runtime.useSystemDotnet', true);

    // try system dotnet first (if enabled)
    if (useSystemDotnet) {
        const systemDotnet = await findSystemDotnet();
        if (systemDotnet) {
            log('Using system installed dotnet');
            return systemDotnet;
        }
    }

    // otherwise try to acquire dotnet runtime via extension
    const acquiredDotnet = await acquireDotnetFromExtension();
    if (acquiredDotnet) {
        log(`Using extension installed dotnet: ${acquiredDotnet}`);
        return acquiredDotnet;
    }

    return undefined;
}

/**
 * Activates the dotnet runtime detection/acquisition.
 * Finds or acquires the .NET runtime needed to run the language server.
 * @param channel The output channel to use for logging.
 * @returns The path to the dotnet executable, or undefined if not available.
 */
export async function activate(channel: vscode.OutputChannel): Promise<string | undefined> {
    // Set the output channel for logging
    outputChannel = channel;

    // Find or acquire .NET runtime - wrap in try-catch to ensure we always show error dialog
    let dotnetPath: string | undefined;
    try {
        dotnetPath = await getDotnetPath();
    } catch (error) {
        log(`Unexpected error during .NET runtime detection: ${error instanceof Error ? error.message : String(error)}`);
        dotnetPath = undefined;
    }

    if (!dotnetPath) {
        const action = await vscode.window.showErrorMessage(
            'Kusto Explorer requires .NET Runtime 10.0 or later to be installed.',
            'Download .NET',
            'Dismiss'
        );
        if (action === 'Download .NET') {
            vscode.env.openExternal(vscode.Uri.parse('https://dot.net/download'));
        }
        return undefined;
    }

    return dotnetPath;
}
