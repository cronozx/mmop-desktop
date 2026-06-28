import { ipcMain, dialog } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import store from '../utils/store.js';
import { getGameDefinition, GAME_DEFINITIONS } from '../../config/games.js';
import { getEpicGameInstallFolders } from '../utils/epicLibraryScanner.js';
import { findSteamGameFolders, getAllSteamCommonGameFolders, getSteamLibraryFolders } from '../utils/steamLibraryScanner.js';
import { gameIdSchema, isValid } from '../validation.js';
import { installSmapi, isSmapiInstalledInDir } from '../services/smapiInstaller.js';
import { getErrorMessage } from '../utils/errors.js';

/**
 * Native (non-Minecraft) game executable management: locating, storing, and
 * launching the real game binary for Steam/Epic installs, plus the SMAPI
 * (Stardew Valley) install flow. Minecraft is installed/launched through MCLC
 * and never goes through here. See src/main/ipc/minecraft.ts for that path and
 * src/main/ipc/gameLaunch.ts for the launch dispatcher that bridges both.
 */

const dedupeCandidates = (candidates: Array<string | null | undefined>): string[] => {
    const normalized = candidates
        .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
        .map((candidate) => candidate.trim());
    return Array.from(new Set(normalized));
};

// ── Game executable storage / detection ─────────────────────────────────────

export const getStoredGameExecutables = (): Record<number, string> => (store.get('gameExecutables') ?? {}) as Record<number, string>;

const saveGameExecutable = (gameId: number, executablePath: string): void => {
    const exes = getStoredGameExecutables();
    exes[gameId] = executablePath;
    store.set('gameExecutables', exes);
};

const clearStoredGameExecutable = (gameId: number): void => {
    const exes = getStoredGameExecutables();
    if (!(gameId in exes)) {
        return;
    }

    delete exes[gameId];
    store.set('gameExecutables', exes);
};

export const isExecutablePathAvailable = (executablePath: string | null | undefined): executablePath is string => {
    if (typeof executablePath !== 'string' || executablePath.length === 0) {
        return false;
    }

    if (/WindowsApps/i.test(executablePath)) {
        return false;
    }

    if (!fs.existsSync(executablePath)) {
        return false;
    }

    try {
        const stats = fs.statSync(executablePath);
        if (stats.isDirectory()) {
            return process.platform === 'darwin' && /\.app$/i.test(executablePath);
        }
    } catch {
        return false;
    }
    return true;
};

const gameAliasOverridesById: Record<number, string[]> = {
    1: ['Minecraft Launcher', 'MultiMC', 'ATLauncher'],
    // R.E.P.O ships as REPO on Steam (folder "REPO", binary "REPO.exe"); the
    // punctuated display name never matches the on-disk name without this.
    35: ['REPO'],
};

// Helper binaries that ship alongside Unity/Steam games but are never the game
// itself. Skipped during auto-detection so we don't launch the wrong .exe
// (which, for BepInEx games, would also mean mods never inject).
const NON_GAME_EXE_PATTERN = /^(unitycrashhandler(32|64)?|crashhandler|unins\w*|vcredist\w*|dxsetup|dotnet\w*|nvngx\w*|launcher_helper|steam_\w+)\.exe$/i;

const getGameNameAliases = (gameId: number): string[] => {
    const gameName = getGameDefinition(gameId)?.name ?? `Game ${gameId}`;
    const aliases = [gameName, ...(gameAliasOverridesById[gameId] ?? [])];
    return dedupeCandidates(aliases);
};

const normalizeForMatch = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

const collectLikelyExePaths = (rootFolder: string, aliases: string[]): string[] => {
    const candidates: string[] = [];
    const normalizedAliases = aliases.map(normalizeForMatch).filter(Boolean);

    const addIfExe = (candidatePath: string): void => {
        if (!/\.exe$/i.test(candidatePath)) {
            return;
        }
        // Never offer obvious helper binaries as the game executable.
        if (NON_GAME_EXE_PATTERN.test(path.basename(candidatePath))) {
            return;
        }
        candidates.push(candidatePath);
    };

    const pushImmediateExeCandidates = (folder: string): void => {
        try {
            const entries = fs.readdirSync(folder, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(folder, entry.name);
                if (entry.isFile()) {
                    addIfExe(fullPath);
                }

                if (entry.isDirectory() && /^(bin|binaries|win64|win64steam)$/i.test(entry.name)) {
                    try {
                        const nestedEntries = fs.readdirSync(fullPath, { withFileTypes: true });
                        for (const nested of nestedEntries) {
                            if (nested.isFile()) {
                                addIfExe(path.join(fullPath, nested.name));
                            }
                        }
                    } catch {
                        // Ignore unreadable nested folders.
                    }
                }
            }
        } catch {
            // Ignore unreadable folders.
        }
    };

    pushImmediateExeCandidates(rootFolder);

    const folderBase = normalizeForMatch(path.basename(rootFolder));
    if (normalizedAliases.some((alias) => alias.length > 0 && (folderBase.includes(alias) || alias.includes(folderBase)))) {
        pushImmediateExeCandidates(rootFolder);
    }

    // Rank executables whose name matches the game ahead of unrelated ones, so
    // e.g. "REPO.exe" wins over a bundled tool that happens to sort first.
    const unique = dedupeCandidates(candidates);
    const nameMatches = (candidatePath: string): boolean => {
        const base = normalizeForMatch(path.basename(candidatePath).replace(/\.exe$/i, ''));
        return normalizedAliases.some((alias) => alias.length > 0 && (base.includes(alias) || alias.includes(base)));
    };
    return [...unique.filter(nameMatches), ...unique.filter((c) => !nameMatches(c))];
};

// macOS executable candidates for a Steam game install folder. Returns paths
// whose name matches the game first (so the right binary is preferred), then any
// other binaries found, then .app bundles. The game's mod folder is derived from
// the executable's directory, so any file inside Contents/MacOS resolves it.
const collectMacExecutableCandidates = (folder: string, aliases: string[]): string[] => {
    const normalizedAliases = aliases.map(normalizeForMatch).filter(Boolean);
    const matched: string[] = [];
    const others: string[] = [];

    const consider = (filePath: string): void => {
        const base = normalizeForMatch(path.basename(filePath).replace(/\.app$/i, ''));
        if (base && normalizedAliases.some((alias) => base.includes(alias) || alias.includes(base))) {
            matched.push(filePath);
        } else {
            others.push(filePath);
        }
    };

    const readFiles = (dir: string): void => {
        try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.isFile()) {
                    consider(path.join(dir, entry.name));
                }
            }
        } catch {
            // Ignore unreadable directories.
        }
    };

    readFiles(path.join(folder, 'Contents', 'MacOS'));

    try {
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
            if (entry.isDirectory() && /\.app$/i.test(entry.name)) {
                const appPath = path.join(folder, entry.name);
                consider(appPath); // a .app bundle is itself a valid executable on macOS
                readFiles(path.join(appPath, 'Contents', 'MacOS'));
            }
        }
    } catch {
        // Ignore unreadable folders.
    }

    return dedupeCandidates([...matched, ...others]);
};

const getGameSpecificExecutableCandidates = (gameId: number): string[] => {
    const aliases = getGameNameAliases(gameId);

    if (process.platform === 'win32') {
        const roots = dedupeCandidates([
            process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : null,
            process.env['ProgramFiles'] ?? null,
            process.env['ProgramFiles(x86)'] ?? null,
            process.env['SystemDrive'] ? path.join(process.env['SystemDrive'], '/') : null,
        ]);

        const candidates: string[] = [];

        // Game-specific well-known paths and Steam/Epic library scan for all games
        const gameDef = getGameDefinition(gameId);
        if (gameDef) {
            // Add Steam library scan for all games
            const allSteamNames = [gameDef.name, ...(gameAliasOverridesById[gameId] ?? [])];
            for (const steamName of allSteamNames) {
                findSteamGameFolders(steamName).forEach(folder => {
                    candidates.push(path.join(folder, `${steamName}.exe`));
                    candidates.push(path.join(folder, 'bin', `${steamName}.exe`));
                    if (steamName === "Stardew Valley") {
                        candidates.push(path.join(folder, 'Stardew Valley.exe'));
                    }
                });
            }

            // Fallback scan across all Steam common folders with fuzzy name matching.
            const normalizedAliases = dedupeCandidates([gameDef.name, ...(gameAliasOverridesById[gameId] ?? [])])
                .map(normalizeForMatch)
                .filter(Boolean);
            for (const steamFolder of getAllSteamCommonGameFolders()) {
                const normalizedFolder = normalizeForMatch(path.basename(steamFolder));
                if (normalizedAliases.some((alias) => normalizedFolder.includes(alias) || alias.includes(normalizedFolder))) {
                    candidates.push(...collectLikelyExePaths(steamFolder, allSteamNames));
                }
            }

            // Add Epic Games scan for all games
            const epicFolders = getEpicGameInstallFolders();
            for (const folder of epicFolders) {
                // Try all aliases as possible subfolders or exe names
                for (const epicName of [gameDef.name, ...(gameAliasOverridesById[gameId] ?? [])]) {
                    candidates.push(path.join(folder, `${epicName}.exe`));
                    candidates.push(path.join(folder, 'bin', `${epicName}.exe`));
                    candidates.push(...collectLikelyExePaths(folder, [epicName]));
                    if (epicName === "Stardew Valley") {
                        candidates.push(path.join(folder, 'Stardew Valley.exe'));
                    }
                }
            }
        }

        // Fallback: generic search using aliases and variants
        const folderNameVariants = (alias: string): string[] => dedupeCandidates([
            alias,
            alias.replace(/[:]/g, ''),
            alias.replace(/\s+/g, ''),
            alias.replace(/\s+/g, '-'),
        ]);

        const exeNameVariants = (alias: string): string[] => {
            const compact = alias.replace(/\s+/g, '');
            return dedupeCandidates([
                `${alias}.exe`,
                `${compact}.exe`,
                `${compact}Launcher.exe`,
                'Launcher.exe',
            ]);
        };

        for (const root of roots) {
            for (const alias of aliases) {
                for (const folderVariant of folderNameVariants(alias)) {
                    for (const exeVariant of exeNameVariants(alias)) {
                        candidates.push(path.join(root, folderVariant, exeVariant));
                        candidates.push(path.join(root, folderVariant, 'bin', exeVariant));
                        candidates.push(path.join(root, `${folderVariant} Launcher`, exeVariant));
                    }
                }
            }
        }

        return dedupeCandidates(candidates.filter(Boolean));
    }

    if (process.platform === 'darwin') {
        // macOS Steam games live under
        // ~/Library/Application Support/Steam/steamapps/common/<Game>/, where the
        // binary is typically Contents/MacOS/<Name> (Steam flattens the .app).
        const candidates: string[] = [];
        const gameDef = getGameDefinition(gameId);
        if (gameDef) {
            const allSteamNames = dedupeCandidates([gameDef.name, ...(gameAliasOverridesById[gameId] ?? [])]);
            for (const steamName of allSteamNames) {
                for (const folder of findSteamGameFolders(steamName)) {
                    candidates.push(...collectMacExecutableCandidates(folder, allSteamNames));
                }
            }

            // Fuzzy scan across every Steam common folder by normalized name.
            const normalizedAliases = allSteamNames.map(normalizeForMatch).filter(Boolean);
            for (const steamFolder of getAllSteamCommonGameFolders()) {
                const normalizedFolder = normalizeForMatch(path.basename(steamFolder));
                if (normalizedAliases.some((alias) => normalizedFolder.includes(alias) || alias.includes(normalizedFolder))) {
                    candidates.push(...collectMacExecutableCandidates(steamFolder, allSteamNames));
                }
            }
        }

        return dedupeCandidates(candidates.filter(Boolean));
    }

    return [];
};

const getAutoDetectExecutableCandidates = (gameId: number): string[] => {
    const gameSpecificCandidates = getGameSpecificExecutableCandidates(gameId);

    return gameSpecificCandidates;
};

const autoDetectGameExecutable = (gameId: number): string | null => {
    const candidates = getAutoDetectExecutableCandidates(gameId);
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
};

// Whether Steam has the given app installed, via its appmanifest_<appId>.acf in
// any library's steamapps folder. This is the canonical, reliable signal — far
// more so than scanning for an executable by name, which would e.g. match a
// vanilla Terraria install (app 105600) when the game actually needs tModLoader.
const isSteamAppInstalled = (steamAppId: number): boolean => {
    for (const lib of getSteamLibraryFolders()) {
        if (fs.existsSync(path.join(lib, 'steamapps', `appmanifest_${steamAppId}.acf`))) {
            return true;
        }
    }
    return false;
};

// Whether a game is "downloaded" — i.e. the user can actually play it. Minecraft
// (id 1) is installed and managed by the app itself (MCLC), so it always counts.
export const isGameInstalled = (gameId: number): boolean => {
    if (gameId === 1) {
        return true;
    }
    // A manually-configured executable that still exists always counts.
    const stored = getStoredGameExecutables()[gameId];
    if (isExecutablePathAvailable(stored)) {
        return true;
    }
    // Steam-launched games (Terraria via tModLoader's workshop app id, and the
    // BepInEx games via their steam app id) are installed exactly when Steam has
    // that app — checked via its appmanifest, not a fuzzy executable scan.
    const def = getGameDefinition(gameId);
    const steamAppId = def?.steamWorkshopAppId ?? def?.steamAppId;
    if (steamAppId !== undefined) {
        return isSteamAppInstalled(steamAppId);
    }
    // Everything else (e.g. Stardew via SMAPI): an auto-detected install on disk.
    return autoDetectGameExecutable(gameId) !== null;
};

const getGameDisplayName = (gameId: number): string => {
    return getGameDefinition(gameId)?.name ?? `Game ${gameId}`;
};

const pickExecutableFromDialog = async (gameName: string): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
        title: `Select ${gameName} Executable`,
        properties: ['openFile'],
        filters: [
            { name: 'Executables', extensions: ['exe', 'bat', 'cmd'] },
            { name: 'All Files', extensions: ['*'] }
        ]
    });

    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }

    const selectedPath = result.filePaths[0];
    return selectedPath;
};

const spawnDetachedAndVerify = async (command: string, args: string[], cwd?: string): Promise<{ success: boolean; error?: string }> =>
    await new Promise((resolve) => {
        try {
            const child = spawn(command, args, { detached: true, stdio: 'ignore', ...(cwd ? { cwd } : {}) });
            let settled = false;
            const finish = (payload: { success: boolean; error?: string }): void => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve(payload);
            };

            child.once('error', (error) => finish({ success: false, error: error.message }));
            child.once('close', (code) => {
                if (typeof code === 'number' && code !== 0) {
                    finish({ success: false, error: `Launcher exited immediately with code ${code}.` });
                }
            });

            child.unref();
            setTimeout(() => finish({ success: true }), 250);
        } catch (error) {
            resolve({ success: false, error: getErrorMessage(error, 'Failed to start launcher process.') });
        }
    });

// Launch a Windows executable via PowerShell Start-Process, which gives it its
// own console. Console-mode launchers like SMAPI's StardewModdingAPI.exe touch
// the console at startup (Console.Clear/buffer ops) and crash with no console —
// which is what a detached spawn (DETACHED_PROCESS, no console) produces, so the
// game never launches. Runs from the executable's folder so loaders resolve the
// game and its Mods folder relative to it.
const launchViaStartProcessWindows = async (inputPath: string): Promise<{ success: boolean; error?: string }> =>
    await new Promise((resolve) => {
        const escape = (value: string): string => value.replace(/'/g, "''");
        const psCommand =
            `try { ` +
            `Start-Process -FilePath '${escape(inputPath)}' -WorkingDirectory '${escape(path.dirname(inputPath))}' -ErrorAction Stop; ` +
            `exit 0 ` +
            `} catch { Write-Error $_.Exception.Message; exit 1 }`;

        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });

        let psError = '';
        child.stderr?.on('data', (chunk) => { psError += chunk.toString(); });

        child.once('error', (error) => resolve({ success: false, error: getErrorMessage(error, 'Failed to start the game.') }));
        child.once('close', (code) => {
            if (code === 0) resolve({ success: true });
            else resolve({ success: false, error: psError.trim() || `The game failed to start (exit code ${code}).` });
        });
    });

export const launchExecutable = async (inputPath: string): Promise<{ success: boolean; error?: string }> => {
    if (!isExecutablePathAvailable(inputPath)) {
        return { success: false, error: 'Configured launcher path is missing or invalid. Please reselect the executable in Settings.' };
    }

    // macOS .app bundles are directories and must be launched via `open`.
    if (process.platform === 'darwin' && /\.app$/i.test(inputPath)) {
        return await spawnDetachedAndVerify('open', [inputPath]);
    }

    if (process.platform === 'win32') {
        return await launchViaStartProcessWindows(inputPath);
    }

    // Run from the executable's own directory so loaders (e.g. SMAPI) resolve
    // the game and its Mods folder relative to it.
    return await spawnDetachedAndVerify(inputPath, [], path.dirname(inputPath));
};

// Some games load mods only when launched through a separate loader installed
// alongside the game. For those we require the loader and never fall back to
// the vanilla executable (which would silently launch without mods). Returns
// the launch target, or an error to surface when the loader is missing.
export const resolveModdedLaunchTarget = (gameId: number, exePath: string): { target: string } | { error: string } => {
    if (gameId === 19) { // Stardew Valley → SMAPI
        const smapiName = process.platform === 'win32' ? 'StardewModdingAPI.exe' : 'StardewModdingAPI';
        const smapiPath = path.join(path.dirname(exePath), smapiName);
        if (fs.existsSync(smapiPath)) {
            return { target: smapiPath };
        }
        return { error: 'SMAPI is not installed for Stardew Valley, so mods cannot load. Install SMAPI from https://smapi.io into your Stardew Valley folder, then launch again.' };
    }
    return { target: exePath };
};

export const resolveGameExecutable = async (gameId: number, promptIfMissing: boolean): Promise<string | null> => {
    if (gameId === 1) {
        // Minecraft is launched and installed directly through MCLC.
        return null;
    }

    // Steam Workshop games (Terraria/tModLoader) launch through Steam by app id
    // and deploy mods into a per-user folder, so no local executable is needed.
    if (getGameDefinition(gameId)?.steamWorkshopAppId) {
        return null;
    }

    const gameName = getGameDisplayName(gameId);
    const exes = getStoredGameExecutables();
    const storedExecutable = exes[gameId];
    if (isExecutablePathAvailable(storedExecutable)) {
        return storedExecutable;
    }

    if (storedExecutable) {
        clearStoredGameExecutable(gameId);
    }

    const detectedExecutable = autoDetectGameExecutable(gameId);
    if (detectedExecutable) {
        saveGameExecutable(gameId, detectedExecutable);
        return detectedExecutable;
    }

    if (!promptIfMissing) {
        return null;
    }

    const prompt = await dialog.showMessageBox({
        type: 'info',
        title: 'Game Executable Required',
        message: `MMOP could not auto-detect a ${gameName} executable.`,
        detail: `Choose the ${gameName} launcher or executable now to continue.`,
        buttons: ['Select Executable', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
    });

    if (prompt.response !== 0) {
        return null;
    }

    const selectedExecutable = await pickExecutableFromDialog(gameName);
    if (!selectedExecutable) {
        return null;
    }

    saveGameExecutable(gameId, selectedExecutable);
    return selectedExecutable;
};

const getFirstOpenHandledMap = (): Record<number, boolean> =>
    (store.get('gameExecutableFirstOpenHandled') ?? {}) as Record<number, boolean>;

const markFirstOpenHandled = (gameId: number): void => {
    const handled = getFirstOpenHandledMap();
    handled[gameId] = true;
    store.set('gameExecutableFirstOpenHandled', handled);
};

// ── IPC registration ────────────────────────────────────────────────────────

export function registerGameExecutableHandlers(): void {
    ipcMain.handle('getGameExecutable', async (_e: IpcMainInvokeEvent, gameId: number) => {
        if (!isValid(gameIdSchema, gameId)) {
            return null;
        }

        return await resolveGameExecutable(gameId, false);
    });

    // Verified games that are actually downloaded/installed on this machine.
    // The Home "Your Games" list filters to these so uninstalled games hide.
    ipcMain.handle('getInstalledGameIds', async (): Promise<number[]> => {
        return GAME_DEFINITIONS
            .filter((game) => game.verified && isGameInstalled(game.id))
            .map((game) => game.id);
    });

    ipcMain.handle('ensureGameExecutableOnFirstOpen', async (_e: IpcMainInvokeEvent, gameId: number): Promise<{ executable: string | null; shouldPrompt: boolean }> => {
        if (!isValid(gameIdSchema, gameId)) {
            return { executable: null, shouldPrompt: false };
        }

        // Steam Workshop games never need a configured executable (they launch
        // through Steam), so never prompt for one on first open.
        if (getGameDefinition(gameId)?.steamWorkshopAppId) {
            return { executable: null, shouldPrompt: false };
        }

        const handled = getFirstOpenHandledMap();
        if (handled[gameId]) {
            return {
                executable: await resolveGameExecutable(gameId, false),
                shouldPrompt: false,
            };
        }

        const detectedExecutable = await resolveGameExecutable(gameId, false);
        markFirstOpenHandled(gameId);

        return {
            executable: detectedExecutable,
            shouldPrompt: !detectedExecutable,
        };
    });

    // Whether the renderer should offer the (modal) SMAPI install for a game:
    // true only for Stardew when its folder is known and SMAPI isn't there yet.
    ipcMain.handle('getSmapiStatus', async (_e: IpcMainInvokeEvent, gameId: number): Promise<{ needed: boolean; installed: boolean }> => {
        if (!isValid(gameIdSchema, gameId) || gameId !== 19) {
            return { needed: false, installed: false };
        }
        const exePath = await resolveGameExecutable(gameId, false);
        if (!exePath) {
            return { needed: false, installed: false };
        }
        const installed = isSmapiInstalledInDir(path.dirname(exePath));
        return { needed: !installed, installed };
    });

    // Runs the SMAPI install, streaming progress to the renderer's modal via
    // 'smapiInstallProgress' events. Used by the in-app install modal instead of
    // the native confirm dialog above.
    ipcMain.handle('installSmapi', async (event: IpcMainInvokeEvent, gameId: number): Promise<{ success: boolean; error?: string }> => {
        if (!isValid(gameIdSchema, gameId) || gameId !== 19) {
            return { success: false, error: 'SMAPI is only used by Stardew Valley.' };
        }
        const exePath = await resolveGameExecutable(gameId, false);
        if (!exePath) {
            return { success: false, error: 'Set the Stardew Valley executable first so MMOP knows where to install SMAPI.' };
        }
        const result = await installSmapi(path.dirname(exePath), (progress) => {
            if (!event.sender.isDestroyed()) {
                event.sender.send('smapiInstallProgress', progress);
            }
        });
        return { success: result.success, ...(result.error ? { error: result.error } : {}) };
    });

    ipcMain.handle('selectAndSaveGameExecutable', async (_e: IpcMainInvokeEvent, gameId: number) => {
        if (!isValid(gameIdSchema, gameId)) {
            return null;
        }

        const selectedExecutable = await pickExecutableFromDialog(getGameDisplayName(gameId));
        if (!selectedExecutable) {
            return null;
        }

        saveGameExecutable(gameId, selectedExecutable);
        return selectedExecutable;
    });
}
