// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * Desktop-only multi-format clipboard support for Windows, used by the Clipboard class.
 */

import { spawn } from 'child_process';
import type { ClipboardItem } from './clipboard';

/**
 * Copies multiple data formats to the Windows clipboard using PowerShell.
 * Uses System.Windows.Forms.Clipboard to support multiple formats.
 */
export function copyToClipboardWindows(items: ClipboardItem[]): Promise<void> {
    // Use PowerShell to set the clipboard data in multiple formats
    // because vscode does not supply a way to set non-text clipboard data and we want to support both PNG and SVG formats for charts.
    return new Promise<void>((resolve, reject) => {
        const psScript = `
            Add-Type -AssemblyName System.Windows.Forms
            $json = $input | Out-String
            $items = ($json | ConvertFrom-Json)
            $data = New-Object System.Windows.Forms.DataObject
            $streams = @()
            foreach ($item in $items) {
                if ($item.encoding -eq 'text') {
                    $data.SetData($item.format, $item.data)
                } else {
                    if ($item.encoding -eq 'base64') {
                        $bytes = [Convert]::FromBase64String($item.data)
                    } else {
                        $bytes = [System.Text.Encoding]::UTF8.GetBytes($item.data)
                    }
                    $stream = New-Object System.IO.MemoryStream(,$bytes)
                    $streams += $stream
                    $data.SetData($item.format, $false, $stream)
                    # Also set as standard bitmap so Electron apps (Teams, Discord) can paste it
                    if ($item.format -eq 'PNG') {
                        Add-Type -AssemblyName System.Drawing
                        $imgStream = New-Object System.IO.MemoryStream(,$bytes)
                        $streams += $imgStream
                        $bitmap = [System.Drawing.Image]::FromStream($imgStream)
                        # Force 96 DPI so the bitmap renders at full pixel size on HiDPI displays
                        # (otherwise it inherits the screen DPI and appears the same logical size)
                        $bitmap.SetResolution(96, 96)
                        $data.SetImage($bitmap)
                    }
                }
            }
            [System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
            foreach ($s in $streams) { $s.Dispose() }
        `;

        const ps = spawn('powershell', ['-sta', '-NoProfile', '-Command', psScript]);

        const payload = JSON.stringify(items);
        ps.stdin.write(payload);
        ps.stdin.end();

        ps.on('close', (code: number) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`PowerShell exited with code ${code}`));
            }
        });

        ps.on('error', (err: Error) => {
            reject(err);
        });
    });
}
