import { app, BrowserWindow, ipcMain } from 'electron';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { getErrorMessage } from '../utils/errors.js';

/** System-level IPC: update check, window controls, randUUID. */

const DEFAULT_UPDATE_CHECK_URL = 'https://www.mmop.app/api/latest.json';

type UpdateAsset = {
    name: string;
    browser_download_url?: string;
};

type UpdateEndpointResponse = {
    version?: string;
    notes?: string;
    downloadUrl?: string;
    assets?: UpdateAsset[];
};

function normalizeVersion(version: string): string {
    return version.trim().replace(/^v/i, '');
}

function compareSemver(left: string, right: string): number {
    const leftMain = normalizeVersion(left).split('-')[0];
    const rightMain = normalizeVersion(right).split('-')[0];
    const leftParts = leftMain.split('.').map((part) => Number.parseInt(part, 10) || 0);
    const rightParts = rightMain.split('.').map((part) => Number.parseInt(part, 10) || 0);
    const maxLen = Math.max(leftParts.length, rightParts.length);

    for (let index = 0; index < maxLen; index += 1) {
        const l = leftParts[index] ?? 0;
        const r = rightParts[index] ?? 0;
        if (l > r) return 1;
        if (l < r) return -1;
    }

    return 0;
}

// Squirrel/auto-update artifacts that a user can't run directly. These exist in
// the release for the background updater, but must never be offered as a manual
// download (a .nupkg can't be installed by hand).
const UPDATE_ONLY_ARTIFACT = /\.nupkg$|\.blockmap$|^RELEASES$/i;

function pickPlatformAssetDownloadUrl(assets: UpdateAsset[]): string | undefined {
    if (!Array.isArray(assets) || assets.length === 0) {
        return undefined;
    }

    const platformExtensions = process.platform === 'win32'
        ? ['.exe', '.msi']
        : process.platform === 'darwin'
        ? ['.dmg', '.zip', '.pkg']
        : ['.AppImage', '.deb', '.rpm', '.tar.gz'];

    const found = assets.find((asset) => {
        const name = typeof asset?.name === 'string' ? asset.name : '';
        return platformExtensions.some((ext) => name.endsWith(ext));
    });

    if (found?.browser_download_url) {
        return found.browser_download_url;
    }

    // Last resort: any installer asset, but never an update-only artifact.
    return assets.find((asset) => {
        const name = typeof asset?.name === 'string' ? asset.name : '';
        return typeof asset?.browser_download_url === 'string' && !UPDATE_ONLY_ARTIFACT.test(name);
    })?.browser_download_url;
}

async function checkForCustomUpdate(): Promise<{
    updateAvailable: boolean;
    currentVersion: string;
    latestVersion?: string;
    downloadUrl?: string;
    notes?: string;
    error?: string;
}> {
    const updateCheckUrl = process.env.UPDATE_CHECK_URL || DEFAULT_UPDATE_CHECK_URL;
    const currentVersion = app.getVersion();

    if (process.env.NODE_ENV === 'development') {
        return {
            updateAvailable: false,
            currentVersion
        }
    }

    try {
        const response = await axios.get<UpdateEndpointResponse>(updateCheckUrl, {
            timeout: 10000,
            validateStatus: (status) => status >= 200 && status < 300,
        });

        const latestVersionRaw = typeof response.data?.version === 'string' ? response.data.version : '';
        const latestVersion = normalizeVersion(latestVersionRaw);
        if (!latestVersion) {
            return {
                updateAvailable: false,
                currentVersion,
                error: 'Update metadata did not include a version.',
            };
        }

        const updateAvailable = compareSemver(latestVersion, currentVersion) > 0;
        // Prefer the platform-specific installer (.exe/.dmg/…) over the server's
        // generic downloadUrl, which can point at an update-only .nupkg.
        const downloadUrl = pickPlatformAssetDownloadUrl(response.data?.assets ?? []) || response.data?.downloadUrl;

        return {
            updateAvailable,
            currentVersion,
            latestVersion,
            downloadUrl,
            notes: typeof response.data?.notes === 'string' ? response.data.notes : '',
        };
    } catch (error) {
        return {
            updateAvailable: false,
            currentVersion,
            error: getErrorMessage(error, 'Failed to check for updates.'),
        };
    }
}

export function registerSystemHandlers(): void {
    ipcMain.handle('checkForCustomUpdate', async () => {
        return await checkForCustomUpdate();
    });

    ipcMain.handle('windowMinimize', () => {
        const targetWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        if (targetWindow) {
            targetWindow.minimize();
            return true;
        }

        return false;
    });

    ipcMain.handle('windowClose', () => {
        const targetWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        if (targetWindow) {
            targetWindow.close();
            return true;
        }

        return false;
    });

    ipcMain.handle('randUUID', () => randomUUID().toString());
}
