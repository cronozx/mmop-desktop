import { modrinthAPI } from './modrinth.js';
import { thunderstoreAPI } from './thunderstore.js';
import { steamAPI } from './steam.js';
import { curseforgeAPI } from './curseforge.js';
import { getGameDefinition } from '../../config/games.js';
import type { ModDescription } from '../../types/sharedTypes.js';

export type { ModDescription };

/**
 * Mod-source provider abstraction.
 *
 * Mod ids are stored in modpacks as strings using a provider prefix:
 *   - `mr:<projectId>`         → Modrinth (base62 project id)
 *   - `ts:<namespace-name>`    → Thunderstore (package full_name)
 *   - `sw:<appId>/<pubFileId>` → Steam Workshop (tModLoader item, via SteamCMD)
 *   - `cf:<modId>`             → CurseForge (numeric mod id)
 *
 * Searches return prefixed ids only.
 */

export type ModProviderId = 'modrinth' | 'thunderstore' | 'steam' | 'curseforge';

/** Normalized mod summary shape shared by search and by-ids lookups. */
export interface ModSummary {
    _id: string;
    name: string;
    author: string;
    summary?: string;
    logo?: string;
    /** The mod's page on its source platform (Modrinth/Thunderstore/CurseForge). */
    sourceUrl?: string;
    /** The author's donation link (Ko-fi, Patreon, GitHub Sponsors, …), if set. */
    donationUrl?: string;
}

export interface ModSearchResult {
    mods: ModSummary[];
    pagination: {
        hasMore: boolean;
        totalCount: number;
        currentPage: number;
    };
}

/** Normalized downloadable file shape. Dependency ids are provider-prefixed. */
export interface NormalizedModFile {
    id: string;
    displayName: string;
    fileName: string;
    fileDate: string;
    downloadUrl: string;
    gameVersions: string[];
    dependencies: Array<{ modId: string; required: boolean }>;
    /** Lowercase hex sha1, when the provider reports one (used by modpack export). */
    sha1?: string;
    /** Lowercase hex sha512 (Modrinth only). */
    sha512?: string;
    /** File size in bytes, when reported. */
    fileSize?: number;
}

export interface ModProvider {
    readonly id: ModProviderId;
    /**
     * Search mods. `modLoader` is a lowercase loader name ("forge", "fabric",
     * "quilt", "neoforge"); each provider maps it to its own representation.
     * Returned summaries always carry prefixed `_id`s.
     */
    search(
        gameId: number,
        searchFilter?: string,
        pageIndex?: number,
        pageSize?: number,
        gameVersion?: string,
        modLoader?: string
    ): Promise<ModSearchResult>;
    /** Fetch summaries for provider-native (unprefixed) ids. `_id`s come back prefixed. */
    getModsByIds(ids: string[]): Promise<ModSummary[]>;
    /** Fetch files for a provider-native (unprefixed) id, newest first. */
    getFilesForMod(id: string, gameVersion?: string, modLoader?: string): Promise<NormalizedModFile[]>;
    /** Fetch a provider-native (unprefixed) id's full description. */
    getModDescription(id: string): Promise<ModDescription>;
}

const PROVIDER_PREFIXES: Record<string, ModProviderId> = {
    mr: 'modrinth',
    ts: 'thunderstore',
    sw: 'steam',
    cf: 'curseforge',
};

const PROVIDER_SHORT_CODES: Record<ModProviderId, string> = {
    modrinth: 'mr',
    thunderstore: 'ts',
    steam: 'sw',
    curseforge: 'cf',
};

const MODRINTH_ID_PATTERN = /^[\w-]{1,64}$/;
// Thunderstore package full_name: "namespace-name". Names/namespaces are
// alphanumeric/underscore, joined by a single hyphen.
const THUNDERSTORE_ID_PATTERN = /^\w+-\w+$/;
// Steam Workshop native id: "<appId>/<publishedFileId>" e.g. "1281930/2824688072".
const STEAM_ID_PATTERN = /^\d{1,10}\/\d{1,20}$/;
// CurseForge native id: a numeric mod id, e.g. "238222".
const CURSEFORGE_ID_PATTERN = /^\d{1,12}$/;

/**
 * Parses a stored/transferred mod id into its provider and provider-native id.
 * Returns null when the id is not recognizable for any provider.
 */
export function parseModId(id: string): { provider: ModProviderId; id: string } | null {
    if (typeof id !== 'string') {
        return null;
    }

    const trimmed = id.trim();
    const separatorIndex = trimmed.indexOf(':');

    if (separatorIndex > 0) {
        const provider = PROVIDER_PREFIXES[trimmed.slice(0, separatorIndex)];
        const nativeId = trimmed.slice(separatorIndex + 1);
        if (!provider) {
            return null;
        }
        if (provider === 'modrinth' && MODRINTH_ID_PATTERN.test(nativeId)) {
            return { provider, id: nativeId };
        }
        if (provider === 'thunderstore' && THUNDERSTORE_ID_PATTERN.test(nativeId)) {
            return { provider, id: nativeId };
        }
        if (provider === 'steam' && STEAM_ID_PATTERN.test(nativeId)) {
            return { provider, id: nativeId };
        }
        if (provider === 'curseforge' && CURSEFORGE_ID_PATTERN.test(nativeId)) {
            return { provider, id: nativeId };
        }
        return null;
    }

    return null;
}

/** Formats a provider-native id into the prefixed storage form. */
export function formatModId(provider: ModProviderId, id: string | number): string {
    return `${PROVIDER_SHORT_CODES[provider]}:${id}`;
}

const modrinthProvider: ModProvider = {
    id: 'modrinth',

    async search(_gameId, searchFilter, pageIndex = 0, pageSize = 50, gameVersion, modLoader) {
        // Modrinth is Minecraft-only; the internal gameId is not used.
        return await modrinthAPI.searchMods(searchFilter, pageIndex, pageSize, gameVersion, modLoader);
    },

    async getModsByIds(ids) {
        return await modrinthAPI.getModsByIds(ids);
    },

    async getFilesForMod(id, gameVersion, modLoader) {
        return await modrinthAPI.getFilesForMod(id, gameVersion, modLoader);
    },

    async getModDescription(id) {
        return await modrinthAPI.getModDescription(id);
    },
};

const thunderstoreProvider: ModProvider = {
    id: 'thunderstore',

    async search(gameId, searchFilter, pageIndex = 0, pageSize = 50) {
        // Thunderstore has no loader/version filtering; it browses by community.
        const result = await thunderstoreAPI.searchMods(gameId, searchFilter, pageIndex, pageSize);
        return {
            mods: result.mods.map((mod) => ({ ...mod, _id: formatModId('thunderstore', mod._id) })),
            pagination: result.pagination,
        };
    },

    async getModsByIds(ids) {
        const mods = await thunderstoreAPI.getModsByIds(ids);
        return mods.map((mod) => ({ ...mod, _id: formatModId('thunderstore', mod._id) }));
    },

    async getFilesForMod(id) {
        const files = await thunderstoreAPI.getFilesForMod(id);
        return files.map((file) => ({
            ...file,
            dependencies: file.dependencies.map((dep) => ({
                modId: formatModId('thunderstore', dep.modId),
                required: dep.required,
            })),
        }));
    },

    async getModDescription(id) {
        return await thunderstoreAPI.getModDescription(id);
    },
};

const steamProvider: ModProvider = {
    id: 'steam',

    async search(gameId, searchFilter, pageIndex = 0, pageSize = 50) {
        const appId = getGameDefinition(gameId)?.steamWorkshopAppId;
        if (!appId) {
            return { mods: [], pagination: { hasMore: false, totalCount: 0, currentPage: pageIndex } };
        }
        const result = await steamAPI.searchMods(appId, searchFilter, pageIndex, pageSize);
        return {
            mods: result.mods.map((mod) => ({ ...mod, _id: formatModId('steam', mod._id) })),
            pagination: result.pagination,
        };
    },

    async getModsByIds(ids) {
        const mods = await steamAPI.getModsByIds(ids);
        return mods.map((mod) => ({ ...mod, _id: formatModId('steam', mod._id) }));
    },

    async getFilesForMod(id) {
        return await steamAPI.getModFiles(id);
    },

    async getModDescription(id) {
        return await steamAPI.getModDescription(id);
    },
};

const curseforgeProvider: ModProvider = {
    id: 'curseforge',

    async search(gameId, searchFilter, pageIndex = 0, pageSize = 50, gameVersion, modLoader) {
        const cfGameId = getGameDefinition(gameId)?.curseForgeGameId;
        if (cfGameId === undefined) {
            return { mods: [], pagination: { hasMore: false, totalCount: 0, currentPage: pageIndex } };
        }
        const result = await curseforgeAPI.searchMods(cfGameId, searchFilter, pageIndex, pageSize, gameVersion, modLoader);
        return {
            mods: result.mods.map((mod) => ({ ...mod, _id: formatModId('curseforge', mod._id) })),
            pagination: result.pagination,
        };
    },

    async getModsByIds(ids) {
        const mods = await curseforgeAPI.getModsByIds(ids);
        return mods.map((mod) => ({ ...mod, _id: formatModId('curseforge', mod._id) }));
    },

    async getFilesForMod(id, gameVersion, modLoader) {
        // curseforgeAPI already returns dependency ids cf:-prefixed.
        return await curseforgeAPI.getFilesForMod(id, gameVersion, modLoader);
    },

    async getModDescription(id) {
        return await curseforgeAPI.getModDescription(id);
    },
};

const providers: Record<ModProviderId, ModProvider> = {
    modrinth: modrinthProvider,
    thunderstore: thunderstoreProvider,
    steam: steamProvider,
    curseforge: curseforgeProvider,
};

/** Returns the provider implementation for the given provider id. */
export function getModProvider(provider: ModProviderId): ModProvider {
    return providers[provider];
}

/**
 * Fetches the full description for a single prefixed mod id, routing to the
 * owning provider. Returns an empty description when the id is unrecognized.
 */
export async function getModDescriptionById(modId: string): Promise<ModDescription> {
    const parsed = parseModId(modId);
    if (!parsed) {
        return { description: '', format: 'text' };
    }
    return await getModProvider(parsed.provider).getModDescription(parsed.id);
}

/**
 * Fetches normalized summaries for a mixed list of prefixed mod ids, splitting
 * by provider and merging the results. Each returned summary keeps the exact
 * `_id` string it was requested with. Unknown / unresolvable ids are dropped.
 */
export async function getModSummariesByIds(modIds: string[]): Promise<ModSummary[]> {
    const requested: Array<{ raw: string; provider: ModProviderId; nativeId: string }> = [];
    const seenRaw = new Set<string>();

    for (const raw of modIds) {
        if (typeof raw !== 'string' || seenRaw.has(raw)) {
            continue;
        }
        const parsed = parseModId(raw);
        if (!parsed) {
            continue;
        }
        seenRaw.add(raw);
        requested.push({ raw, provider: parsed.provider, nativeId: parsed.id });
    }

    if (requested.length === 0) {
        return [];
    }

    const idsByProvider = new Map<ModProviderId, string[]>();
    for (const request of requested) {
        const ids = idsByProvider.get(request.provider) ?? [];
        if (!ids.includes(request.nativeId)) {
            ids.push(request.nativeId);
        }
        idsByProvider.set(request.provider, ids);
    }

    const summariesByPrefixedId = new Map<string, ModSummary>();
    await Promise.all(
        Array.from(idsByProvider.entries()).map(async ([providerId, ids]) => {
            try {
                const mods = await getModProvider(providerId).getModsByIds(ids);
                for (const mod of mods) {
                    summariesByPrefixedId.set(mod._id, mod);
                }
            } catch (error) {
                console.error(`Failed to fetch mods from ${providerId}:`, error);
            }
        })
    );

    const merged: ModSummary[] = [];
    for (const request of requested) {
        const summary = summariesByPrefixedId.get(formatModId(request.provider, request.nativeId));
        if (summary) {
            merged.push({ ...summary, _id: request.raw });
        }
    }

    return merged;
}
