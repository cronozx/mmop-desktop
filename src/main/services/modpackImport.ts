import fs from 'fs';
import JSZip from 'jszip';
import { z } from 'zod';
import { formatModId } from './modProvider.js';
import { modrinthAPI } from './modrinth.js';
import type { ModrinthHashLookupHit } from './modrinth.js';
import { versionStringSchema } from '../validation.js';
import type {
    ModLoaderType,
    ModpackImportDraft,
    ModpackImportUnresolvedEntry,
} from '../../types/sharedTypes.js';

/**
 * Modpack import: parse Modrinth `.mrpack` archives into a normalized draft the
 * renderer feeds into the existing createModpack flow.
 *
 * SECURITY: archive contents are UNTRUSTED input.
 *  - Nothing is ever extracted to disk here — only the manifest JSON entry is
 *    read from the zip in memory, so there is no zip-slip exposure.
 *  - Manifest JSON is validated with bounded zod schemas (name/description
 *    lengths, entry counts, id/hash/version shapes) before any use.
 *  - File paths inside manifests are still checked for traversal patterns so a
 *    hostile manifest cannot smuggle unsafe paths into the draft.
 *  - `overrides/` contents are intentionally ignored for now (config files,
 *    resource packs). Future enhancement: extract overrides into the instance
 *    directory with full zip-slip protection (see extractZipSafely in
 *    src/main/ipc/minecraft.ts).
 */

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024; // refuse to load absurdly large archives into memory
const MAX_MANIFEST_CHARS = 10 * 1024 * 1024; // decompressed manifest JSON cap
const MAX_NAME_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_FILE_ENTRIES = 5000;

const MODRINTH_PROJECT_ID_PATTERN = /^[\w-]{1,64}$/;

export class ModpackImportError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ModpackImportError';
    }
}

// ── Schemas (untrusted input) ────────────────────────────────────────────────

const sha1Schema = z.string().regex(/^[a-fA-F0-9]{40}$/);
const sha512Schema = z.string().regex(/^[a-fA-F0-9]{128}$/);

const mrpackIndexSchema = z.looseObject({
    formatVersion: z.literal(1),
    game: z.literal('minecraft'),
    name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
    summary: z.string().max(50_000).optional(),
    // Entries are validated individually so one malformed entry does not
    // reject the whole pack — it just lands in `unresolved`.
    files: z.array(z.unknown()).max(MAX_FILE_ENTRIES).default([]),
    dependencies: z.record(z.string().max(64), z.string().max(64)),
});

const mrpackFileSchema = z.looseObject({
    path: z.string().min(1).max(1024),
    hashes: z.looseObject({
        sha1: sha1Schema.optional(),
        sha512: sha512Schema.optional(),
    }).optional(),
    downloads: z.array(z.string().max(4096)).max(16).optional(),
    fileSize: z.number().int().nonnegative().optional(),
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * True when a manifest-declared archive path is a plain relative path with no
 * traversal: no absolute paths, drive letters, backslashes, `.`/`..` segments.
 */
export function isSafeArchivePath(archivePath: string): boolean {
    if (typeof archivePath !== 'string' || archivePath.length === 0 || archivePath.length > 1024) {
        return false;
    }
    if (archivePath.includes('\\') || archivePath.startsWith('/') || /^[a-zA-Z]:/.test(archivePath)) {
        return false;
    }
    return archivePath
        .split('/')
        .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/** mrpack dependency key → our loader name. */
const MRPACK_LOADER_KEYS: Array<{ key: string; loader: ModLoaderType }> = [
    { key: 'forge', loader: 'forge' },
    { key: 'neoforge', loader: 'neoforge' },
    { key: 'fabric-loader', loader: 'fabric' },
    { key: 'quilt-loader', loader: 'quilt' },
];

function loaderFromMrpackDependencies(dependencies: Record<string, string>): { modLoader?: ModLoaderType; loaderVersion?: string } {
    for (const { key, loader } of MRPACK_LOADER_KEYS) {
        const version = dependencies[key];
        if (typeof version === 'string' && version.length > 0) {
            return {
                modLoader: loader,
                loaderVersion: versionStringSchema.safeParse(version).success ? version : undefined,
            };
        }
    }
    return {};
}

function firstIssueSummary(error: z.ZodError): string {
    const issue = error.issues[0];
    if (!issue) {
        return 'invalid manifest';
    }
    const where = issue.path.length > 0 ? ` at "${issue.path.join('.')}"` : '';
    return `${issue.message}${where}`;
}

// ── Normalization (pure; exported for offline tests) ───────────────────────

export interface MrpackHashEntry {
    path: string;
    sha1: string;
}

/**
 * Validates and normalizes a parsed `modrinth.index.json`. Returns the draft
 * (mods still empty) plus the sha1 entries to resolve via the Modrinth hash
 * lookup API. Throws ModpackImportError when the index is structurally invalid.
 */
export function normalizeMrpackIndex(data: unknown): { draft: ModpackImportDraft; hashEntries: MrpackHashEntry[] } {
    const parsed = mrpackIndexSchema.safeParse(data);
    if (!parsed.success) {
        throw new ModpackImportError(`Invalid Modrinth modpack manifest: ${firstIssueSummary(parsed.error)}`);
    }

    const index = parsed.data;
    const minecraftVersion = index.dependencies['minecraft'];
    if (!minecraftVersion || !versionStringSchema.safeParse(minecraftVersion).success) {
        throw new ModpackImportError('Modrinth modpack manifest is missing a valid Minecraft version.');
    }

    const { modLoader, loaderVersion } = loaderFromMrpackDependencies(index.dependencies);
    const unresolved: ModpackImportUnresolvedEntry[] = [];
    const hashEntries: MrpackHashEntry[] = [];

    for (const rawFile of index.files) {
        const fileParsed = mrpackFileSchema.safeParse(rawFile);
        if (!fileParsed.success) {
            const rawPath = (rawFile as { path?: unknown } | null)?.path;
            unresolved.push({
                path: typeof rawPath === 'string' ? rawPath.slice(0, 256) : undefined,
                reason: 'Malformed file entry',
            });
            continue;
        }

        const file = fileParsed.data;
        if (!isSafeArchivePath(file.path)) {
            unresolved.push({ path: file.path.slice(0, 256), reason: 'Unsafe file path' });
            continue;
        }
        if (!file.path.startsWith('mods/')) {
            unresolved.push({ path: file.path, reason: 'Not a mod file (only mods/ entries are imported)' });
            continue;
        }

        const sha1 = file.hashes?.sha1?.toLowerCase();
        if (!sha1) {
            unresolved.push({ path: file.path, reason: 'Missing sha1 hash' });
            continue;
        }

        hashEntries.push({ path: file.path, sha1 });
    }

    const draft: ModpackImportDraft = {
        name: index.name,
        description: index.summary ? index.summary.slice(0, MAX_DESCRIPTION_LENGTH) : undefined,
        minecraftVersion,
        modLoader,
        loaderVersion,
        mods: [],
        unresolved,
        format: 'mrpack',
    };

    return { draft, hashEntries };
}

// ── CurseForge modpack manifests ─────────────────────────────────────────────
// A CurseForge `.zip` pack carries a `manifest.json` listing mods as
// {projectID, fileID} pairs. Unlike .mrpack there is no hash lookup: each
// projectID maps straight to a `cf:` mod id the download pipeline resolves.

const curseForgeManifestSchema = z.looseObject({
    manifestType: z.string().max(64).optional(),
    name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
    minecraft: z.looseObject({
        version: z.string().min(1).max(64),
        modLoaders: z.array(z.looseObject({
            id: z.string().min(1).max(128),
            primary: z.boolean().optional(),
        })).max(16).default([]),
    }),
    // Entries validated individually so one bad entry lands in `unresolved`.
    files: z.array(z.unknown()).max(MAX_FILE_ENTRIES).default([]),
});

const curseForgeFileSchema = z.looseObject({
    projectID: z.number().int().positive(),
    fileID: z.number().int().positive().optional(),
    required: z.boolean().optional(),
});

/** CurseForge modLoader id prefix (e.g. "forge-47.2.0") → our loader name. */
const CURSEFORGE_LOADER_PREFIXES: Array<{ prefix: string; loader: ModLoaderType }> = [
    { prefix: 'neoforge', loader: 'neoforge' },
    { prefix: 'forge', loader: 'forge' },
    { prefix: 'fabric', loader: 'fabric' },
    { prefix: 'quilt', loader: 'quilt' },
];

function loaderFromCurseForge(
    modLoaders: Array<{ id: string; primary?: boolean }>
): { modLoader?: ModLoaderType; loaderVersion?: string } {
    const chosen = modLoaders.find((entry) => entry.primary) ?? modLoaders[0];
    if (!chosen) return {};
    const id = chosen.id.toLowerCase();
    for (const { prefix, loader } of CURSEFORGE_LOADER_PREFIXES) {
        if (id.startsWith(prefix)) {
            const version = chosen.id.slice(prefix.length).replace(/^[-:]/, '');
            return { modLoader: loader, loaderVersion: versionStringSchema.safeParse(version).success ? version : undefined };
        }
    }
    return {};
}

/**
 * Validates and normalizes a CurseForge `manifest.json` into a draft. Mods are
 * `cf:<projectID>` ids resolved at download time. Throws ModpackImportError when
 * the manifest is structurally invalid.
 */
export function normalizeCurseForgeManifest(data: unknown): ModpackImportDraft {
    const parsed = curseForgeManifestSchema.safeParse(data);
    if (!parsed.success) {
        throw new ModpackImportError(`Invalid CurseForge modpack manifest: ${firstIssueSummary(parsed.error)}`);
    }

    const manifest = parsed.data;
    const minecraftVersion = manifest.minecraft.version;
    if (!versionStringSchema.safeParse(minecraftVersion).success) {
        throw new ModpackImportError('CurseForge modpack manifest is missing a valid Minecraft version.');
    }

    const { modLoader, loaderVersion } = loaderFromCurseForge(manifest.minecraft.modLoaders);
    const unresolved: ModpackImportUnresolvedEntry[] = [];
    const mods = new Set<string>();

    for (const rawFile of manifest.files) {
        const fileParsed = curseForgeFileSchema.safeParse(rawFile);
        if (!fileParsed.success) {
            const rawId = (rawFile as { projectID?: unknown } | null)?.projectID;
            unresolved.push({
                projectID: typeof rawId === 'number' ? rawId : undefined,
                reason: 'Malformed file entry',
            });
            continue;
        }
        mods.add(formatModId('curseforge', fileParsed.data.projectID));
    }

    return {
        name: manifest.name,
        minecraftVersion,
        modLoader,
        loaderVersion,
        mods: Array.from(mods),
        unresolved,
        format: 'curseforge',
    };
}

// ── Archive parsing ─────────────────────────────────────────────────────────

/** Injectable hash resolver so tests can run offline (defaults to Modrinth). */
export type MrpackHashResolver = (
    hashes: string[],
    algorithm: 'sha1'
) => Promise<Map<string, ModrinthHashLookupHit>>;

const defaultHashResolver: MrpackHashResolver = (hashes, algorithm) =>
    modrinthAPI.getVersionsByFileHashes(hashes, algorithm);

async function readManifestEntryText(entry: JSZip.JSZipObject): Promise<string> {
    const text = await entry.async('string');
    if (text.length > MAX_MANIFEST_CHARS) {
        throw new ModpackImportError('Modpack manifest is too large.');
    }
    return text;
}

function parseManifestJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        throw new ModpackImportError('Modpack manifest is not valid JSON.');
    }
}

async function resolveMrpackMods(
    draft: ModpackImportDraft,
    hashEntries: MrpackHashEntry[],
    resolveHashes: MrpackHashResolver
): Promise<ModpackImportDraft> {
    if (hashEntries.length === 0) {
        return draft;
    }

    // Batch every sha1 into ONE lookup request.
    const uniqueHashes = Array.from(new Set(hashEntries.map((entry) => entry.sha1)));
    let hits: Map<string, ModrinthHashLookupHit>;
    try {
        hits = await resolveHashes(uniqueHashes, 'sha1');
    } catch (error) {
        throw new ModpackImportError(
            `Could not resolve mod files via Modrinth: ${error instanceof Error ? error.message : 'lookup failed'}`
        );
    }

    const mods = new Set<string>(draft.mods);
    for (const entry of hashEntries) {
        const hit = hits.get(entry.sha1);
        if (hit && MODRINTH_PROJECT_ID_PATTERN.test(hit.projectId)) {
            mods.add(formatModId('modrinth', hit.projectId));
        } else {
            draft.unresolved.push({ path: entry.path, reason: 'No matching Modrinth project for file hash' });
        }
    }

    draft.mods = Array.from(mods);
    return draft;
}

/**
 * Opens a Modrinth `.mrpack` archive, validates the manifest, and returns a
 * normalized draft. Throws ModpackImportError with a user-presentable message
 * on any failure.
 *
 * Only the manifest JSON entry is read; no archive content touches the disk.
 */
export async function parseModpackArchive(
    filePath: string,
    resolveHashes: MrpackHashResolver = defaultHashResolver
): Promise<ModpackImportDraft> {
    let stats: fs.Stats;
    try {
        stats = await fs.promises.stat(filePath);
    } catch {
        throw new ModpackImportError('Modpack file could not be read.');
    }
    if (!stats.isFile() || stats.size === 0) {
        throw new ModpackImportError('Modpack file could not be read.');
    }
    if (stats.size > MAX_ARCHIVE_BYTES) {
        throw new ModpackImportError('Modpack archive is too large to import.');
    }

    let zip: JSZip;
    try {
        zip = await JSZip.loadAsync(await fs.promises.readFile(filePath));
    } catch {
        throw new ModpackImportError('File is not a valid modpack archive (could not open zip).');
    }

    const mrpackEntry = zip.file('modrinth.index.json');
    if (mrpackEntry) {
        const data = parseManifestJson(await readManifestEntryText(mrpackEntry));
        const { draft, hashEntries } = normalizeMrpackIndex(data);
        return await resolveMrpackMods(draft, hashEntries, resolveHashes);
    }

    const curseForgeEntry = zip.file('manifest.json');
    if (curseForgeEntry) {
        const data = parseManifestJson(await readManifestEntryText(curseForgeEntry));
        return normalizeCurseForgeManifest(data);
    }

    throw new ModpackImportError('Not a recognized modpack archive (no modrinth.index.json or CurseForge manifest.json).');
}
