import path from 'path';
import fs from 'fs';
import { getModpackInstanceDir } from '../utils/instancePaths.js';
import { getStoredGameExecutables, isExecutablePathAvailable } from '../ipc/gameExecutables.js';
import type { ConfigFileEntry, ConfigRoot } from '../../types/sharedTypes.js';

export type { ConfigFileEntry, ConfigRoot };

/**
 * Read/write access to a modpack's editable config files. Each modpack exposes
 * one or more "config roots" depending on its game:
 *   - Minecraft (game 1): the instance directory itself (holds config/, options.txt…).
 *   - Stardew Valley (19): the game's SMAPI `Mods` folder, where each mod keeps
 *     its own config.json.
 *   - BepInEx games (34/35/36): the game's `BepInEx/config` folder.
 *
 * Every read/write is validated to stay inside one of these roots (no traversal),
 * limited to known text/config file types, and size-bounded.
 */

// Text/config extensions safe to show in a plain-text editor. Binary mod files
// (.jar, .zip, .dll, images, …) are intentionally excluded.
const EDITABLE_EXTENSIONS = new Set([
    '.json', '.json5', '.jsonc', '.toml', '.cfg', '.conf', '.config', '.ini',
    '.yml', '.yaml', '.properties', '.txt', '.xml', '.snbt', '.md', '.csv', '.env',
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB — configs are small; guards the editor.
const MAX_FILES = 1000;
const MAX_DEPTH = 8;

const isEditableFile = (fileName: string): boolean =>
    EDITABLE_EXTENSIONS.has(path.extname(fileName).toLowerCase());

/** Resolves the config roots that exist for a modpack, in display order. */
export function getConfigRoots(gameId: number, safeName: string): ConfigRoot[] {
    const roots: ConfigRoot[] = [];

    if (gameId === 1) {
        roots.push({ label: 'Instance', dir: getModpackInstanceDir(1, safeName) });
        return roots.filter((root) => directoryExists(root.dir));
    }

    const executable = getStoredGameExecutables()[gameId];
    if (isExecutablePathAvailable(executable)) {
        const gameDir = path.dirname(executable);
        if (gameId === 19) {
            roots.push({ label: 'SMAPI Mods', dir: path.join(gameDir, 'Mods') });
        } else {
            roots.push({ label: 'BepInEx Config', dir: path.join(gameDir, 'BepInEx', 'config') });
        }
    }

    return roots.filter((root) => directoryExists(root.dir));
}

function directoryExists(dir: string): boolean {
    try {
        return fs.statSync(dir).isDirectory();
    } catch {
        return false;
    }
}

/** Recursively lists editable config files under a root (bounded by count/depth). */
function listFilesUnder(root: string): Array<{ relPath: string; size: number }> {
    const out: Array<{ relPath: string; size: number }> = [];

    const walk = (dir: string, depth: number): void => {
        if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (out.length >= MAX_FILES) return;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full, depth + 1);
            } else if (entry.isFile() && isEditableFile(entry.name)) {
                try {
                    const size = fs.statSync(full).size;
                    if (size <= MAX_FILE_BYTES) {
                        out.push({ relPath: path.relative(root, full).split(path.sep).join('/'), size });
                    }
                } catch {
                    // Skip unreadable files.
                }
            }
        }
    };

    walk(root, 0);
    return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/** All editable config files across a modpack's roots. */
export function listConfigFiles(gameId: number, safeName: string): { roots: ConfigRoot[]; files: ConfigFileEntry[] } {
    const roots = getConfigRoots(gameId, safeName);
    const files: ConfigFileEntry[] = [];
    roots.forEach((root, rootIndex) => {
        for (const file of listFilesUnder(root.dir)) {
            files.push({ rootIndex, relPath: file.relPath, size: file.size });
        }
    });
    return { roots, files };
}

/**
 * Resolves a (rootIndex, relPath) pair to an absolute path, asserting it stays
 * inside the resolved root and points at an editable file. Returns null on any
 * violation (bad index, traversal, wrong type), so callers fail closed.
 */
function resolveConfigFilePath(gameId: number, safeName: string, rootIndex: number, relPath: string): string | null {
    const roots = getConfigRoots(gameId, safeName);
    const root = roots[rootIndex];
    if (!root || typeof relPath !== 'string' || relPath.length === 0) {
        return null;
    }
    if (!isEditableFile(relPath)) {
        return null;
    }

    const resolvedRoot = path.resolve(root.dir);
    const target = path.resolve(resolvedRoot, relPath);
    // Guard against path traversal: target must live within the root.
    if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
        return null;
    }
    return target;
}

export function readConfigFile(gameId: number, safeName: string, rootIndex: number, relPath: string): { contents: string } | { error: string } {
    const target = resolveConfigFilePath(gameId, safeName, rootIndex, relPath);
    if (!target) {
        return { error: 'Invalid config file path.' };
    }
    try {
        const stat = fs.statSync(target);
        if (!stat.isFile()) return { error: 'Not a file.' };
        if (stat.size > MAX_FILE_BYTES) return { error: 'File is too large to edit.' };
        return { contents: fs.readFileSync(target, 'utf-8') };
    } catch {
        return { error: 'Could not read that file.' };
    }
}

export function writeConfigFile(gameId: number, safeName: string, rootIndex: number, relPath: string, contents: string): { success: boolean; error?: string } {
    if (typeof contents !== 'string' || Buffer.byteLength(contents, 'utf-8') > MAX_FILE_BYTES) {
        return { success: false, error: 'File contents are missing or too large.' };
    }
    const target = resolveConfigFilePath(gameId, safeName, rootIndex, relPath);
    if (!target) {
        return { success: false, error: 'Invalid config file path.' };
    }
    try {
        // Only overwrite existing files; never create new paths from the editor.
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
            return { success: false, error: 'That file no longer exists.' };
        }
        fs.writeFileSync(target, contents, 'utf-8');
        return { success: true };
    } catch {
        return { success: false, error: 'Could not save that file.' };
    }
}
