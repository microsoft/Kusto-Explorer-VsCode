// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * Desktop-only access to a local Kusto Explorer installation's data folder
 * (%LOCALAPPDATA%\Kusto.Explorer). The web build has no equivalent; users import
 * Kusto Explorer files there with "Import from File…".
 */

import * as fs from 'fs';
import * as path from 'path';
import type { IKustoExplorerLocalData } from './importManager';

/** Kusto Explorer user data directory name under %LOCALAPPDATA%. */
const KUSTO_EXPLORER_DIR = 'Kusto.Explorer';

/** Filename for the groups index. */
const GROUPS_FILE = 'UserConnectionGroups.xml';

/** Recovery directory under Kusto Explorer for scratch pad backup files. */
const RECOVERY_DIR = 'Recovery';

/** Extension for Kusto Explorer scratch pad backup files. */
const RECOVERY_EXT = '.kebak';

/** Reads Kusto Explorer data from %LOCALAPPDATA%\Kusto.Explorer. */
export class KustoExplorerLocalData implements IKustoExplorerLocalData {
    hasGroupsFile(): boolean {
        const groupsPath = this.getGroupsFilePath();
        return !!groupsPath && fs.existsSync(groupsPath);
    }

    async readGroupsFile(): Promise<string | undefined> {
        const groupsPath = this.getGroupsFilePath();
        return groupsPath ? this.readFile(groupsPath) : undefined;
    }

    async readFile(filePath: string): Promise<string | undefined> {
        if (!fs.existsSync(filePath)) {
            return undefined;
        }
        return fs.promises.readFile(filePath, 'utf-8');
    }

    hasRecoveryFiles(): boolean {
        return this.getRecoveryFileNames().length > 0;
    }

    readRecoveryFiles(): string[] {
        const recoveryDir = this.getRecoveryDirPath();
        if (!recoveryDir) {
            return [];
        }

        const contents: string[] = [];
        for (const file of this.getRecoveryFileNames()) {
            try {
                contents.push(fs.readFileSync(path.join(recoveryDir, file), 'utf-8'));
            } catch {
                // Skip unreadable files
            }
        }
        return contents;
    }

    private getRecoveryFileNames(): string[] {
        const recoveryDir = this.getRecoveryDirPath();
        if (!recoveryDir || !fs.existsSync(recoveryDir)) {
            return [];
        }
        return fs.readdirSync(recoveryDir).filter(f => f.endsWith(RECOVERY_EXT));
    }

    /** Returns the path to the Kusto Explorer groups XML file, or undefined. */
    private getGroupsFilePath(): string | undefined {
        const localAppData = process.env.LOCALAPPDATA;
        if (!localAppData) { return undefined; }
        return path.join(localAppData, KUSTO_EXPLORER_DIR, GROUPS_FILE);
    }

    /** Returns the path to the Kusto Explorer Recovery directory, or undefined. */
    private getRecoveryDirPath(): string | undefined {
        const localAppData = process.env.LOCALAPPDATA;
        if (!localAppData) { return undefined; }
        return path.join(localAppData, KUSTO_EXPLORER_DIR, RECOVERY_DIR);
    }
}
