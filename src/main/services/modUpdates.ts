import fs from 'fs';
import path from 'path';
import {
    getModProvider,
    getModSummariesByIds,
    parseModId,
} from './modProvider.js';
import type { NormalizedModFile } from './modProvider.js';
import { isSafeModFileName } from '../validation.js';
import type {
    ModCompatibilityResult,
    ModUpdateCheckResult,
    ModUpdateEntry,
    ModUpdateFailure,
} from '../../types/sharedTypes.js';

/**
 * Mod update checking for Minecraft modpack instances.
 *
 * Matching strategy (pragmatic by design): an on-disk file in the instance
 * `mods/` dir "belongs" to a stored mod id when its exact file name appears in
 * the provider's recently known files for that mod — the union of:
 *   - the version+loader-filtered file list (the same query the download flow
 *     uses), and
 *   - the provider's unfiltered recent file list, so files left behind by an
 *     older pack version or a different loader still match.
 * Files renamed by the user, or older than the provider's recent-files window,
 * are not matched; those mods are reported as not installed. The comparison
 * itself is pure (`compareResolvedWithInstalled`) and the provider lookups are
 * injectable (`ModUpdateResolver`) so tests run fully offline.
 */

/** Rival-loader exclusion sets — mirrors the download flow in database.ts. */
const RIVAL_LOADERS: Record<string, string[]> = {
    forge: ['neoforge', 'fabric', 'quilt'],
    neoforge: ['forge', 'fabric', 'quilt'],
    fabric: ['forge', 'neoforge', 'quilt'],
    quilt: ['forge', 'neoforge'],
};

/**
 * Picks the file a download would use: drop files tagged with a rival loader
 * (falling back to the unfiltered list when that empties it, matching
 * `downloadMods`), then take the newest by file date.
 */
export function pickBestFile(files: NormalizedModFile[], modLoader?: string): NormalizedModFile | null {
    const rivals = modLoader ? (RIVAL_LOADERS[modLoader.toLowerCase()] ?? []) : [];
    const isRival = (file: NormalizedModFile): boolean =>
        rivals.some((rival) => (file.gameVersions ?? []).some((v) => v.toLowerCase() === rival));

    const preferred = files.filter((file) => !isRival(file));
    const pool = preferred.length > 0 ? preferred : files;

    return pool
        .slice()
        .sort((a, b) => new Date(b.fileDate).getTime() - new Date(a.fileDate).getTime())[0] ?? null;
}

/** The subset of a modpack the update check needs (validated by the IPC layer). */
export interface UpdatableModpack {
    name: string;
    mods: string[];
    minecraftVersion: string;
    /** Lowercase loader name ("forge" | "neoforge" | "fabric" | "quilt"). */
    modLoader?: string;
}

/** Per-mod provider lookup result consumed by the comparison logic. */
export interface ResolvedModUpdateInfo {
    /** The raw stored id (`mr:…` or `ts:…`). */
    id: string;
    name: string;
    /** Best file for the pack's minecraftVersion+modLoader (download target). */
    bestFile: NormalizedModFile | null;
    /** Recently known fileNames for this mod, used to match on-disk files. */
    knownFileNames: string[];
}

export type ModUpdateResolver = (modpack: UpdatableModpack) => Promise<{
    resolved: ResolvedModUpdateInfo[];
    failures: ModUpdateFailure[];
}>;

/**
 * Default resolver: fetches each mod's filtered (version+loader) and
 * unfiltered file lists from its provider and picks the same "best" file the
 * download/export flows would use (`pickBestFile`). Per-mod provider errors
 * become failures instead of aborting the whole check.
 */
export const resolveModUpdateInfo: ModUpdateResolver = async (modpack) => {
    const namesById = new Map<string, string>();
    try {
        for (const summary of await getModSummariesByIds(modpack.mods)) {
            namesById.set(summary._id, summary.name);
        }
    } catch (error) {
        console.error('Failed to fetch mod names for update check:', error);
    }

    const resolved: ResolvedModUpdateInfo[] = [];
    const failures: ModUpdateFailure[] = [];
    const seen = new Set<string>();

    for (const rawId of modpack.mods) {
        if (typeof rawId !== 'string' || seen.has(rawId)) {
            continue;
        }
        seen.add(rawId);

        const parsed = parseModId(rawId);
        if (!parsed) {
            failures.push({ id: rawId, reason: 'Unrecognized mod id' });
            continue;
        }

        try {
            const provider = getModProvider(parsed.provider);
            // Filtered query: what the download flow would install today.
            const filteredFiles = await provider.getFilesForMod(parsed.id, modpack.minecraftVersion, modpack.modLoader);
            // Unfiltered query: recent files used to match what is on disk.
            const allFiles = await provider.getFilesForMod(parsed.id);
            const knownFileNames = Array.from(new Set(
                [...filteredFiles, ...allFiles].map((file) => file.fileName)
            ));

            resolved.push({
                id: rawId,
                name: namesById.get(rawId) ?? rawId,
                bestFile: pickBestFile(filteredFiles, modpack.modLoader),
                knownFileNames,
            });
        } catch (error) {
            console.error(`Failed to resolve update info for ${rawId}:`, error);
            failures.push({ id: rawId, reason: 'Failed to fetch files from the mod provider' });
        }
    }

    return { resolved, failures };
};

/** Lists the plain file names currently present in an instance mods dir. */
export function listInstalledModFiles(modsDir: string): string[] {
    if (!fs.existsSync(modsDir)) {
        return [];
    }
    try {
        return fs.readdirSync(modsDir, { withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name);
    } catch {
        return [];
    }
}

/**
 * Pure comparison between resolved provider state and the on-disk listing:
 * a mod is updatable when the best file's name differs from the matched
 * installed file, and "not installed" (installedFileName: null) when no
 * on-disk file matches its known file names. Mods without a compatible file
 * become failures.
 */
export function compareResolvedWithInstalled(
    resolved: ResolvedModUpdateInfo[],
    installedFileNames: string[],
    modpack: Pick<UpdatableModpack, 'minecraftVersion' | 'modLoader'>
): { updates: ModUpdateEntry[]; failures: ModUpdateFailure[] } {
    const updates: ModUpdateEntry[] = [];
    const failures: ModUpdateFailure[] = [];

    for (const mod of resolved) {
        if (!mod.bestFile) {
            failures.push({
                id: mod.id,
                reason: `No compatible file found for Minecraft ${modpack.minecraftVersion}${modpack.modLoader ? ` (${modpack.modLoader})` : ''}`,
            });
            continue;
        }

        const known = new Set(mod.knownFileNames);
        const installedFileName = installedFileNames.find((fileName) => known.has(fileName)) ?? null;
        if (installedFileName === mod.bestFile.fileName) {
            continue; // already on the newest compatible file
        }

        updates.push({
            id: mod.id,
            name: mod.name,
            installedFileName,
            latestFileName: mod.bestFile.fileName,
            latestFileDate: mod.bestFile.fileDate,
        });
    }

    return { updates, failures };
}

/** Runs the full update check for a pack against its instance mods dir. */
export async function checkModUpdatesForPack(
    modpack: UpdatableModpack,
    modsDir: string,
    resolver: ModUpdateResolver = resolveModUpdateInfo
): Promise<ModUpdateCheckResult> {
    const { resolved, failures } = await resolver(modpack);
    const { updates, failures: compareFailures } =
        compareResolvedWithInstalled(resolved, listInstalledModFiles(modsDir), modpack);

    return {
        checked: resolved.length + failures.length,
        updates,
        failures: [...failures, ...compareFailures],
    };
}

/**
 * File names to delete before re-downloading the given mods: every installed
 * file that matches a mod's known file list, except the file the download
 * flow would install (kept so an already-current mod is skipped, not
 * re-downloaded). Names are re-validated so a separator or traversal sequence
 * coming from a provider response (or anywhere else) never reaches fs ops.
 */
export function collectStaleModFileNames(
    resolved: ResolvedModUpdateInfo[],
    installedFileNames: string[]
): string[] {
    const stale = new Set<string>();

    for (const mod of resolved) {
        const known = new Set(mod.knownFileNames);
        for (const fileName of installedFileNames) {
            if (!known.has(fileName)) continue;
            if (mod.bestFile && fileName === mod.bestFile.fileName) continue;
            if (!isSafeModFileName(fileName)) continue;
            stale.add(fileName);
        }
    }

    return Array.from(stale);
}

/** Deletes the given file names from the mods dir (unsafe names are ignored). */
export function removeStaleModFiles(modsDir: string, fileNames: string[]): void {
    const resolvedDir = path.resolve(modsDir);

    for (const fileName of fileNames) {
        if (!isSafeModFileName(fileName)) continue;
        const filePath = path.resolve(resolvedDir, fileName);
        // Defense in depth: the resolved path must stay directly in the dir.
        if (path.dirname(filePath) !== resolvedDir) continue;
        try {
            fs.rmSync(filePath, { force: true });
        } catch (error) {
            console.error(`Failed to remove stale mod file ${fileName}:`, error);
        }
    }
}

/**
 * Add-time compatibility guard: true when the provider has at least one file
 * for the given gameVersion+loader (judged by the same `pickBestFile` path the
 * download flow uses). Provider errors fail open (`checked: false`) — this is
 * an availability check, not a security boundary.
 */
export async function checkModFileAvailability(
    modId: string,
    gameVersion: string,
    modLoader?: string
): Promise<ModCompatibilityResult> {
    const parsed = parseModId(modId);
    if (!parsed) {
        return { checked: true, compatible: false };
    }

    try {
        const files = await getModProvider(parsed.provider).getFilesForMod(parsed.id, gameVersion, modLoader);
        return { checked: true, compatible: pickBestFile(files, modLoader) !== null };
    } catch (error) {
        console.warn(`Compatibility check for ${modId} failed (failing open):`, error);
        return { checked: false, compatible: true };
    }
}
