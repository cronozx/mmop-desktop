import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import path from 'path';
import fs from 'fs';
import JSZip from 'jszip';
import { downloadMods, removeModFiles, resolveModFileNames, findMissingModIds } from '../database/database.js';
import { parseModId, getModDescriptionById } from '../services/modProvider.js';
import type { ModDescription } from '../services/modProvider.js';
import {
    isValid,
    looseModLoaderNameSchema,
    modIdsSchema,
    modpackUpdateCheckInputSchema,
    validateSafeName,
    versionStringSchema,
} from '../validation.js';
import {
    checkModFileAvailability,
    checkModUpdatesForPack,
    collectStaleModFileNames,
    listInstalledModFiles,
    removeStaleModFiles,
    resolveModUpdateInfo,
} from '../services/modUpdates.js';
import type { UpdatableModpack } from '../services/modUpdates.js';
import type { ModCompatibilityResult, ModUpdateCheckResult } from '../../types/sharedTypes.js';
import { getStoredGameExecutables, isExecutablePathAvailable } from './gameExecutables.js';
import { getModpackModsDir } from '../utils/instancePaths.js';
import { listConfigFiles, readConfigFile, writeConfigFile } from '../services/configFiles.js';
import type { ConfigFileEntry, ConfigRoot } from '../services/configFiles.js';
import { tModLoaderModsDir } from '../services/tmodloader.js';

/**
 * Mod management IPC: download/remove mod files, check for and apply updates,
 * and a pre-add compatibility check. Downloads run through the cross-provider
 * pipeline in database.ts; this layer also deploys downloaded files into a
 * game's real mod directory (Thunderstore/BepInEx layout, SMAPI's Mods folder)
 * for games other than Minecraft, which uses its mods straight from the
 * instance dir.
 */

// ── Deploy downloaded mods into the real mod directory for games with a known layout ──
type GameModsDestination =
    // Copy files as-is (optionally only those matching `onlyExtensions`), or
    // extract zips flat into `dir`.
    | { dir: string; strategy: 'flat'; extractZips: boolean; onlyExtensions?: string[] }
    // Extract Thunderstore zips into the game's BepInEx layout rooted at `dir`.
    | { dir: string; strategy: 'bepinex' };

const resolveGameModsDestination = (gameId: number): GameModsDestination | null => {
    const storedExecutable = getStoredGameExecutables()[gameId];

    switch (gameId) {
        case 19: { // Stardew Valley: SMAPI mods folder inside the game directory.
            if (!isExecutablePathAvailable(storedExecutable)) return null;
            return { dir: path.join(path.dirname(storedExecutable), 'Mods'), strategy: 'flat', extractZips: true };
        }
        case 20: // Terraria: copy .tmod files into the per-user tModLoader Mods folder.
            return { dir: tModLoaderModsDir(), strategy: 'flat', extractZips: false, onlyExtensions: ['.tmod'] };
        case 34: // Lethal Company (Thunderstore / BepInEx).
        case 35: // R.E.P.O (Thunderstore / BepInEx).
        case 36: { // Risk of Rain 2 (Thunderstore / BepInEx).
            if (!isExecutablePathAvailable(storedExecutable)) return null;
            return { dir: path.dirname(storedExecutable), strategy: 'bepinex' };
        }
        default:
            return null;
    }
};

const extractZipSafely = async (zipPath: string, destDir: string): Promise<void> => {
    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
    const resolvedDest = path.resolve(destDir);

    for (const [entryName, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        const outPath = path.resolve(destDir, entryName);
        // Guard against zip-slip path traversal.
        if (!outPath.startsWith(resolvedDest + path.sep)) continue;
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, await entry.async('nodebuffer'));
    }
};

// If every entry lives under a single top-level folder, returns that folder's
// prefix (e.g. "BepInExPack_LethalCompany/"); otherwise null. Used to peel the
// wrapper directory Thunderstore zips sometimes ship with.
const singleTopLevelFolder = (entryNames: string[]): string | null => {
    let prefix: string | null = null;
    for (const name of entryNames) {
        const slash = name.indexOf('/');
        if (slash <= 0) return null; // a root-level file → no common wrapper
        const top = name.slice(0, slash + 1);
        if (prefix === null) {
            prefix = top;
        } else if (prefix !== top) {
            return null;
        }
    }
    return prefix;
};

// Thunderstore packaging files that sit at the archive root of every package.
// They carry no game payload and — critically — defeat wrapper-folder detection
// (a root-level file means "no common wrapper"), so they are dropped up front.
const THUNDERSTORE_META_FILE = /^(manifest\.json|icon\.png|readme(\.md)?|changelog(\.md)?|license(\.md|\.txt)?)$/i;

/**
 * Extracts a Thunderstore (BepInEx) mod zip into the game directory.
 *
 * Two shapes are handled:
 *  - The BepInEx pack and mods that ship their own `BepInEx/` tree (or the
 *    `winhttp.dll`/`doorstop_config.ini` loader files) are written to the game
 *    root, with any single wrapper folder peeled off first. This is what makes
 *    the doorstop (`winhttp.dll`) land next to the game .exe so BepInEx injects.
 *  - Plain plugin mods (a DLL plus manifest/readme at the root) are placed in
 *    `BepInEx/plugins/<full_name>/` so each mod stays self-contained.
 */
const extractThunderstoreZip = async (zipPath: string, gameRoot: string, fullName: string): Promise<void> => {
    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
    // Drop root-level Thunderstore metadata: it pollutes the install and would
    // otherwise stop the wrapper folder (e.g. "BepInExPack/") from being peeled.
    const fileEntries = Object.entries(zip.files).filter(
        ([name, entry]) => !entry.dir && !(name.indexOf('/') === -1 && THUNDERSTORE_META_FILE.test(name))
    );
    if (fileEntries.length === 0) return;

    let wrapper = singleTopLevelFolder(fileEntries.map(([name]) => name));
    // Never peel the BepInEx tree itself — only an extra packaging wrapper such
    // as "BepInExPack/" or "BepInExPack_LethalCompany/". Peeling "BepInEx/" would
    // strip the prefix the structure check relies on.
    if (wrapper && wrapper.replace(/\/$/, '').toLowerCase() === 'bepinex') {
        wrapper = null;
    }
    const normalize = (name: string) => (wrapper ? name.slice(wrapper.length) : name);

    const isBepInExStructured = fileEntries.some(([name]) => {
        const rel = normalize(name).toLowerCase();
        return rel.startsWith('bepinex/') || rel === 'winhttp.dll' || rel === 'doorstop_config.ini' || rel === '.doorstop_version';
    });

    const baseDir = isBepInExStructured
        ? gameRoot
        : path.join(gameRoot, 'BepInEx', 'plugins', fullName);
    const resolvedBase = path.resolve(baseDir);

    for (const [name, entry] of fileEntries) {
        const rel = normalize(name);
        if (!rel) continue;
        const outPath = path.resolve(baseDir, rel);
        // Guard against zip-slip path traversal.
        if (outPath !== resolvedBase && !outPath.startsWith(resolvedBase + path.sep)) continue;
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, await entry.async('nodebuffer'));
    }
};

const deployModFilesToGameDirectory = async (gameId: number, modsDir: string): Promise<string | undefined> => {
    const destination = resolveGameModsDestination(gameId);
    if (!destination) return undefined;

    try {
        fs.mkdirSync(destination.dir, { recursive: true });
        const files = fs.readdirSync(modsDir, { withFileTypes: true }).filter((entry) => entry.isFile());

        for (const file of files) {
            const sourcePath = path.join(modsDir, file.name);
            if (destination.strategy === 'bepinex') {
                if (!/\.zip$/i.test(file.name)) continue;
                // The instance file name is "<namespace-name-version>.zip"; the
                // mod's full_name (namespace-name) is everything but the version.
                const base = file.name.replace(/\.zip$/i, '');
                const fullName = base.split('-').slice(0, 2).join('-') || base;
                await extractThunderstoreZip(sourcePath, destination.dir, fullName);
            } else if (destination.extractZips && /\.zip$/i.test(file.name)) {
                await extractZipSafely(sourcePath, destination.dir);
            } else {
                // Skip files outside the allowed set (e.g. Terraria copies only
                // .tmod, never the instance's bookkeeping files).
                if (destination.onlyExtensions && !destination.onlyExtensions.includes(path.extname(file.name).toLowerCase())) {
                    continue;
                }
                fs.copyFileSync(sourcePath, path.join(destination.dir, file.name));
            }
        }

        return destination.dir;
    } catch (error) {
        console.error(`Failed to deploy mods for game ${gameId}:`, error);
        return undefined;
    }
};

/** The distinct top-level path segments (folder or file names) inside a zip. */
const topLevelZipEntryNames = async (zipPath: string): Promise<string[]> => {
    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
    const names = new Set<string>();
    for (const entryName of Object.keys(zip.files)) {
        const top = entryName.split('/')[0];
        if (top) names.add(top);
    }
    return [...names];
};

/**
 * Removes a removed mod's deployed files from the real game folder (the staged
 * instance files are cleaned separately by removeModFiles). Minecraft is used
 * straight from the instance dir, so it has nothing deployed and is skipped.
 *
 * Mirrors deployModFilesToGameDirectory:
 *  - BepInEx games: each plugin lives in BepInEx/plugins/<full_name>; deleting
 *    that folder removes it. Loader packs deploy to the game root and have no
 *    plugins folder, so the delete is a harmless no-op (we never strip BepInEx).
 *  - Stardew (flat zip extract): each mod was unpacked from its staged zip into
 *    the Mods folder, so its top-level entries are read back from the still-
 *    present staged zip and removed.
 */
const removeDeployedModFiles = async (gameId: number, modIds: string[], modsDir: string): Promise<void> => {
    const destination = resolveGameModsDestination(gameId);
    if (!destination) return;

    try {
        if (destination.strategy === 'bepinex') {
            for (const rawId of modIds) {
                const parsed = parseModId(rawId);
                if (parsed?.provider !== 'thunderstore') continue;
                fs.rmSync(path.join(destination.dir, 'BepInEx', 'plugins', parsed.id), { recursive: true, force: true });
            }
            return;
        }

        const resolvedDest = path.resolve(destination.dir);
        if (destination.extractZips) {
            for (const fileName of await resolveModFileNames(modIds, modsDir)) {
                const zipPath = path.join(modsDir, fileName);
                if (!/\.zip$/i.test(fileName) || !fs.existsSync(zipPath)) continue;
                for (const entry of await topLevelZipEntryNames(zipPath)) {
                    const target = path.resolve(destination.dir, entry);
                    // Stay inside the mods folder (guards against odd zip entries).
                    if (target === resolvedDest || !target.startsWith(resolvedDest + path.sep)) continue;
                    fs.rmSync(target, { recursive: true, force: true });
                }
            }
        } else {
            // Flat copy-as-is (e.g. Terraria .tmod): the deployed file shares its
            // name with the staged file, so delete it straight from the dest.
            for (const fileName of await resolveModFileNames(modIds, modsDir)) {
                const target = path.resolve(destination.dir, fileName);
                if (target === resolvedDest || !target.startsWith(resolvedDest + path.sep)) continue;
                if (fs.existsSync(target)) {
                    try { fs.rmSync(target, { force: true }); } catch { /* ignore */ }
                }
            }
        }
    } catch (error) {
        console.error(`Failed to remove deployed mods for game ${gameId}:`, error);
    }
};

// ── IPC registration ────────────────────────────────────────────────────────

export function registerModManagementHandlers(): void {
    ipcMain.handle('downloadMods', async (event: IpcMainInvokeEvent, token: string, modIds: string[], modpackName: string, gameVersion?: string, modLoader?: string, gameId?: number) => {
        const invalidResult = { successful: [], failed: Array.isArray(modIds) ? modIds : [], skipped: [], dependencies: [], dependencyIds: [], downloadPath: '' };
        // Non-Minecraft (Thunderstore/BepInEx) packs carry no Minecraft version or
        // loader, and the renderer forwards those as empty strings. Treat blank as
        // "not provided" so an empty version doesn't fail validation and reject the
        // whole batch — which previously made every Thunderstore mod download fail.
        gameVersion = gameVersion?.trim() || undefined;
        modLoader = modLoader?.trim() || undefined;
        if (!isValid(modIdsSchema, modIds)) {
            return invalidResult;
        }
        if (gameVersion !== undefined && !isValid(versionStringSchema, gameVersion)) {
            return invalidResult;
        }
        // The loader arrives as a display label here (e.g. "Forge"), so only a
        // loose shape check applies — the provider resolves the actual loader.
        if (modLoader !== undefined && !isValid(looseModLoaderNameSchema, modLoader)) {
            return invalidResult;
        }

        const safeName = validateSafeName(modpackName);
        if (!safeName) return { successful: [], failed: modIds, skipped: [], dependencies: [], dependencyIds: [], downloadPath: '' };
        const modsDir = getModpackModsDir(gameId ?? 1, safeName);
        fs.mkdirSync(modsDir, { recursive: true });
        const results = await downloadMods(token, modIds, modsDir, gameVersion, modLoader, (p) =>
            event.sender.send('modDownloadProgress', { ...p, modpackId: modpackName })
        );

        // Minecraft mods are used straight from the instance dir; other games get
        // copied/extracted into the game's real mod directory when we know it.
        let deployedTo: string | undefined;
        if (typeof gameId === 'number' && gameId !== 1) {
            deployedTo = await deployModFilesToGameDirectory(gameId, modsDir);
        }

        return { ...results, downloadPath: modsDir, ...(deployedTo ? { deployedTo } : {}) };
    });

    // Which of the given mods are NOT yet on disk for this modpack. Used by the
    // UI to accurately decide whether everything is downloaded (an empty result).
    // gameVersion/modLoader mirror downloadMods so the presence check resolves
    // the same files the download writes.
    ipcMain.handle('getMissingModIds', async (_e: IpcMainInvokeEvent, modpackName: string, modIds: string[], gameVersion?: string, modLoader?: string, gameId?: number): Promise<string[]> => {
        if (!isValid(modIdsSchema, modIds)) return Array.isArray(modIds) ? modIds : [];
        const safeName = validateSafeName(modpackName);
        if (!safeName) return modIds;
        const resolvedGameVersion = gameVersion?.trim() || undefined;
        const resolvedModLoader = modLoader?.trim() || undefined;
        const modsDir = getModpackModsDir(gameId ?? 1, safeName);
        return findMissingModIds(modIds, modsDir, resolvedGameVersion, resolvedModLoader);
    });

    ipcMain.handle('removeModFiles', async (_e: IpcMainInvokeEvent, token: string, modIds: string[], modpackName: string, gameId?: number) => {
        if (!isValid(modIdsSchema, modIds)) {
            return;
        }

        const safeName = validateSafeName(modpackName);
        if (!safeName) return;
        const modsDir = getModpackModsDir(gameId ?? 1, safeName);
        // Remove the mods deployed into the real game folder first (non-Minecraft),
        // while their staged files are still present for mapping, then delete the
        // staged files themselves.
        if (typeof gameId === 'number' && gameId !== 1) {
            await removeDeployedModFiles(gameId, modIds, modsDir);
        }
        await removeModFiles(token, modIds, modsDir);
    });

    // ── Mod update check / one-click update (Minecraft packs only) ──────────

    // The update check only needs the modpack object plus the provider APIs, so
    // it works identically in backend and local mode.
    ipcMain.handle('checkModUpdates', async (_e: IpcMainInvokeEvent, _token: string, modpackData: unknown): Promise<ModUpdateCheckResult> => {
        const empty: ModUpdateCheckResult = { checked: 0, updates: [], failures: [] };
        if (!isValid(modpackUpdateCheckInputSchema, modpackData)) {
            return empty;
        }

        const pack = modpackData as UpdatableModpack;
        const safeName = validateSafeName(pack.name);
        if (!safeName) {
            return empty;
        }

        // Mod updates apply to Minecraft packs only (game 1).
        const modsDir = getModpackModsDir(1, safeName);
        try {
            return await checkModUpdatesForPack(
                {
                    name: pack.name,
                    mods: pack.mods,
                    minecraftVersion: pack.minecraftVersion,
                    modLoader: pack.modLoader,
                },
                modsDir
            );
        } catch (error) {
            console.error('Mod update check failed:', error);
            const reason = error instanceof Error ? error.message : 'Update check failed';
            return {
                checked: 0,
                updates: [],
                failures: pack.mods.map((id) => ({ id, reason })),
            };
        }
    });

    ipcMain.handle('updateMods', async (event: IpcMainInvokeEvent, token: string, modpackData: unknown, modIds: string[]) => {
        const failure = (failed: string[]) => ({ successful: [], failed, skipped: [], dependencies: [], downloadPath: '' });
        if (!isValid(modIdsSchema, modIds) || !isValid(modpackUpdateCheckInputSchema, modpackData)) {
            return failure(Array.isArray(modIds) ? modIds : []);
        }

        const pack = modpackData as UpdatableModpack;
        const safeName = validateSafeName(pack.name);
        if (!safeName) {
            return failure(modIds);
        }

        // Only mods actually in the pack may be updated.
        const packMods = new Set(pack.mods);
        const idsToUpdate = modIds.filter((id) => packMods.has(id));
        if (idsToUpdate.length === 0) {
            return failure([]);
        }

        const modsDir = getModpackModsDir(1, safeName);
        fs.mkdirSync(modsDir, { recursive: true });

        // Remove each selected mod's matched on-disk files (everything except
        // the current best file, with file names path-validated), then reuse
        // the regular download flow: it sees the target file missing and
        // downloads it fresh, including required dependencies.
        try {
            const { resolved } = await resolveModUpdateInfo({
                name: pack.name,
                mods: idsToUpdate,
                minecraftVersion: pack.minecraftVersion,
                modLoader: pack.modLoader,
            });
            const staleFileNames = collectStaleModFileNames(resolved, listInstalledModFiles(modsDir));
            removeStaleModFiles(modsDir, staleFileNames);
        } catch (error) {
            console.error('Failed to remove stale mod files before update:', error);
        }

        const results = await downloadMods(token, idsToUpdate, modsDir, pack.minecraftVersion, pack.modLoader, (p) =>
            event.sender.send('modDownloadProgress', { ...p, modpackId: pack.name })
        );
        return { ...results, downloadPath: modsDir };
    });

    // Full mod description for the detail view (browse/add). Read-only and
    // provider-routed; an unrecognized id yields an empty description.
    ipcMain.handle('getModDescription', async (_e: IpcMainInvokeEvent, modId: string): Promise<ModDescription> => {
        if (!isValid(modIdsSchema, [modId])) {
            return { description: '', format: 'text' };
        }
        try {
            return await getModDescriptionById(modId);
        } catch (error) {
            console.error('getModDescription failed:', error);
            return { description: '', format: 'text' };
        }
    });

    // ── Config file editing ─────────────────────────────────────────────────
    // List/read/write a modpack's editable config files. The service resolves the
    // allowed roots per game and path-validates every access (no traversal, text
    // types only, size-bounded), so these handlers only validate the pack name.

    ipcMain.handle('listConfigFiles', async (_e: IpcMainInvokeEvent, modpackName: string, gameId: number): Promise<{ roots: ConfigRoot[]; files: ConfigFileEntry[] }> => {
        const safeName = validateSafeName(modpackName);
        if (!safeName) return { roots: [], files: [] };
        try {
            return listConfigFiles(gameId ?? 1, safeName);
        } catch (error) {
            console.error('listConfigFiles failed:', error);
            return { roots: [], files: [] };
        }
    });

    ipcMain.handle('readConfigFile', async (_e: IpcMainInvokeEvent, modpackName: string, gameId: number, rootIndex: number, relPath: string): Promise<{ contents: string } | { error: string }> => {
        const safeName = validateSafeName(modpackName);
        if (!safeName) return { error: 'Invalid modpack name.' };
        return readConfigFile(gameId ?? 1, safeName, Number(rootIndex), String(relPath));
    });

    ipcMain.handle('writeConfigFile', async (_e: IpcMainInvokeEvent, modpackName: string, gameId: number, rootIndex: number, relPath: string, contents: string): Promise<{ success: boolean; error?: string }> => {
        const safeName = validateSafeName(modpackName);
        if (!safeName) return { success: false, error: 'Invalid modpack name.' };
        return writeConfigFile(gameId ?? 1, safeName, Number(rootIndex), String(relPath), String(contents));
    });

    // Add-time compatibility guard for the Add Mods modal (fail-open).
    ipcMain.handle('checkModCompatibility', async (_e: IpcMainInvokeEvent, modId: string, gameVersion: string, modLoader?: string): Promise<ModCompatibilityResult> => {
        if (!isValid(modIdsSchema, [modId]) || !isValid(versionStringSchema, gameVersion)) {
            return { checked: true, compatible: false };
        }
        if (modLoader !== undefined && !isValid(looseModLoaderNameSchema, modLoader)) {
            return { checked: true, compatible: false };
        }

        return await checkModFileAvailability(modId, gameVersion, modLoader?.toLowerCase());
    });
}
