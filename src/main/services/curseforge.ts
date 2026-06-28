import axios from 'axios';
import type { ModSummary, ModSearchResult, NormalizedModFile } from './modProvider.js';
import type { ProviderModpackSearchResult } from '../../types/sharedTypes.js';

/**
 * CurseForge Core API client. Powers mods for games whose `curseForgeGameId` is
 * set (Minecraft = 432, Stardew Valley = 669). Native `_id`s are the CurseForge
 * numeric mod id as a string.
 *
 * Auth: every request needs an API key in the `x-api-key` header
 * (CURSEFORGE_API_KEY). Without it the API returns 403 and search/downloads no-op.
 *
 * Author opt-out: when a mod sets `allowModDistribution: false`, CurseForge will
 * not hand out a CDN link (the download-url endpoint 403s and `file.downloadUrl`
 * is null). We surface such files with an empty `downloadUrl` so callers fall
 * back to linking the official page rather than working around the author's
 * choice. We never re-host files — downloads come straight from CurseForge's CDN.
 */

// Read the key lazily (not captured at module load): in packaged builds it is
// populated from client-env.json by loadClientEnv, which may run after this
// module is first imported. Capturing it here once would strand an empty key.
const apiKey = (): string | undefined => process.env.CURSEFORGE_API_KEY;
const API_BASE = 'https://api.curseforge.com/v1';
const USER_AGENT = 'mmop (+https://www.mmop.app)';

// CurseForge modLoaderType enum (subset MMOP cares about).
const MOD_LOADER_TYPE: Record<string, number> = {
    forge: 1,
    fabric: 4,
    quilt: 5,
    neoforge: 6,
};

// CurseForge file relationType: 3 = RequiredDependency.
const REQUIRED_DEPENDENCY = 3;
// CurseForge hash algo: 1 = sha1.
const HASH_SHA1 = 1;

interface CFAuthor { name?: string }
interface CFFile {
    id: number;
    displayName?: string;
    fileName: string;
    fileDate?: string;
    downloadUrl?: string | null;
    gameVersions?: string[];
    dependencies?: Array<{ modId: number; relationType: number }>;
    hashes?: Array<{ value: string; algo: number }>;
    fileLength?: number;
}
interface CFMod {
    id: number;
    name: string;
    summary?: string;
    logo?: { url?: string } | null;
    authors?: CFAuthor[];
    allowModDistribution?: boolean;
    downloadCount?: number;
    latestFiles?: CFFile[];
}

function headers() {
    return { 'x-api-key': apiKey() ?? '', 'User-Agent': USER_AGENT, Accept: 'application/json' };
}

function warnIfNoKey() {
    if (!apiKey()) {
        console.warn('CurseForge API key not found. Add CURSEFORGE_API_KEY to your .env file.');
    }
}

function toSummary(mod: CFMod): ModSummary {
    return {
        _id: String(mod.id),
        name: mod.name,
        author: mod.authors?.[0]?.name ?? 'Unknown',
        summary: mod.summary,
        logo: mod.logo?.url ?? undefined,
    };
}

class CurseForgeAPIService {
    /** Keyword search within a CurseForge game, newest/most-popular first. */
    async searchMods(
        curseForgeGameId: number,
        searchFilter?: string,
        pageIndex = 0,
        pageSize = 50,
        gameVersion?: string,
        modLoader?: string,
    ): Promise<ModSearchResult> {
        warnIfNoKey();
        try {
            const params: Record<string, string | number> = {
                gameId: curseForgeGameId,
                index: pageIndex * pageSize,
                pageSize,
                sortField: 2, // Popularity
                sortOrder: 'desc',
            };
            if (searchFilter) params.searchFilter = searchFilter;
            if (gameVersion) params.gameVersion = gameVersion;
            const loaderType = modLoader ? MOD_LOADER_TYPE[modLoader.toLowerCase()] : undefined;
            if (loaderType !== undefined) params.modLoaderType = loaderType;

            const { data } = await axios.get(`${API_BASE}/mods/search`, { params, headers: headers(), timeout: 15000 });
            const mods: ModSummary[] = (data?.data ?? []).map((mod: CFMod) => toSummary(mod));
            const total = data?.pagination?.totalCount ?? mods.length;
            return {
                mods,
                pagination: {
                    hasMore: (pageIndex + 1) * pageSize < total,
                    totalCount: total,
                    currentPage: pageIndex,
                },
            };
        } catch (error) {
            console.error('CurseForge search failed:', error);
            return { mods: [], pagination: { hasMore: false, totalCount: 0, currentPage: pageIndex } };
        }
    }

    /**
     * Browse existing modpacks for a CurseForge game. `classId` is the game's
     * "Modpacks" category (e.g. 4471 for Minecraft); games without one have no
     * browsable packs and should not call this.
     */
    async searchModpacks(
        curseForgeGameId: number,
        classId: number,
        searchFilter?: string,
        pageIndex = 0,
        pageSize = 30,
        gameVersion?: string,
    ): Promise<ProviderModpackSearchResult> {
        warnIfNoKey();
        try {
            const params: Record<string, string | number> = {
                gameId: curseForgeGameId,
                classId,
                index: pageIndex * pageSize,
                pageSize,
                sortField: 2, // Popularity
                sortOrder: 'desc',
            };
            if (searchFilter) params.searchFilter = searchFilter;
            if (gameVersion) params.gameVersion = gameVersion;

            const { data } = await axios.get(`${API_BASE}/mods/search`, { params, headers: headers(), timeout: 15000 });
            const list: CFMod[] = data?.data ?? [];
            const total = data?.pagination?.totalCount ?? list.length;
            return {
                modpacks: list.map((mod) => ({
                    id: String(mod.id),
                    name: mod.name,
                    author: mod.authors?.[0]?.name ?? 'Unknown',
                    summary: mod.summary,
                    logo: mod.logo?.url ?? undefined,
                    downloads: typeof mod.downloadCount === 'number' ? mod.downloadCount : undefined,
                    provider: 'curseforge' as const,
                })),
                hasMore: (pageIndex + 1) * pageSize < total,
                totalCount: total,
            };
        } catch (error) {
            console.error('CurseForge searchModpacks failed:', error);
            return { modpacks: [], hasMore: false, totalCount: 0 };
        }
    }

    /**
     * Resolve the newest published modpack file (a `.zip`) for a CF project and
     * its CDN download url. Returns null when the project has no downloadable
     * `.zip` (e.g. author opted out of third-party distribution).
     */
    async getModpackDownload(projectId: string): Promise<{ url: string; fileName: string } | null> {
        try {
            const files = await this.getFilesForMod(projectId);
            const file = files.find((f) => f.downloadUrl && /\.zip$/i.test(f.fileName))
                ?? files.find((f) => f.downloadUrl);
            if (!file?.downloadUrl) return null;
            return { url: file.downloadUrl, fileName: file.fileName };
        } catch (error) {
            console.error(`CurseForge getModpackDownload ${projectId} failed:`, error);
            return null;
        }
    }

    /** Fetch summaries for CurseForge numeric mod ids. */
    async getModsByIds(nativeIds: string[]): Promise<ModSummary[]> {
        if (nativeIds.length === 0) return [];
        warnIfNoKey();
        try {
            const modIds = nativeIds.map((id) => Number(id)).filter((n) => Number.isFinite(n));
            const { data } = await axios.post(`${API_BASE}/mods`, { modIds }, { headers: headers(), timeout: 15000 });
            return (data?.data ?? []).map((mod: CFMod) => toSummary(mod));
        } catch (error) {
            console.error('CurseForge getModsByIds failed:', error);
            return [];
        }
    }

    /** Resolve a CDN download url for a specific file (honors author opt-out). */
    private async resolveDownloadUrl(modId: string, file: CFFile): Promise<string> {
        if (file.downloadUrl) return file.downloadUrl;
        try {
            const { data } = await axios.get(
                `${API_BASE}/mods/${modId}/files/${file.id}/download-url`,
                { headers: headers(), timeout: 15000 },
            );
            return data?.data ?? '';
        } catch {
            // 403 here means the author disabled third-party distribution.
            return '';
        }
    }

    /** Files for a CurseForge mod, newest first; dependency ids are cf:-prefixed. */
    async getFilesForMod(nativeId: string, gameVersion?: string, modLoader?: string): Promise<NormalizedModFile[]> {
        warnIfNoKey();
        try {
            const params: Record<string, string | number> = { pageSize: 50 };
            if (gameVersion) params.gameVersion = gameVersion;
            const loaderType = modLoader ? MOD_LOADER_TYPE[modLoader.toLowerCase()] : undefined;
            if (loaderType !== undefined) params.modLoaderType = loaderType;

            const { data } = await axios.get(`${API_BASE}/mods/${nativeId}/files`, { params, headers: headers(), timeout: 15000 });
            const files: CFFile[] = data?.data ?? [];
            // Newest first.
            files.sort((a, b) => new Date(b.fileDate ?? 0).getTime() - new Date(a.fileDate ?? 0).getTime());

            const normalized: NormalizedModFile[] = [];
            for (const file of files) {
                normalized.push({
                    id: String(file.id),
                    displayName: file.displayName ?? file.fileName,
                    fileName: file.fileName,
                    fileDate: file.fileDate ?? '',
                    downloadUrl: await this.resolveDownloadUrl(nativeId, file),
                    gameVersions: file.gameVersions ?? [],
                    dependencies: (file.dependencies ?? [])
                        .filter((dep) => dep.relationType === REQUIRED_DEPENDENCY)
                        .map((dep) => ({ modId: `cf:${dep.modId}`, required: true })),
                    sha1: file.hashes?.find((h) => h.algo === HASH_SHA1)?.value?.toLowerCase(),
                    fileSize: file.fileLength,
                });
            }
            return normalized;
        } catch (error) {
            console.error(`CurseForge getFilesForMod ${nativeId} failed:`, error);
            return [];
        }
    }

    /**
     * Full long-form mod description. CurseForge serves it as rendered HTML, so
     * it's returned as `markdown` — the description modal renders that through a
     * sanitizing pipeline (rehype-raw + rehype-sanitize), which displays HTML
     * safely. Falls back to empty text on error / missing key.
     */
    async getModDescription(nativeId: string): Promise<{ description: string; format: 'markdown' | 'text'; url?: string }> {
        warnIfNoKey();
        try {
            const { data } = await axios.get(`${API_BASE}/mods/${nativeId}/description`, { headers: headers(), timeout: 15000 });
            const html = typeof data?.data === 'string' ? data.data : '';
            return { description: html, format: 'markdown' };
        } catch (error) {
            console.error(`CurseForge getModDescription ${nativeId} failed:`, error);
            return { description: '', format: 'text' };
        }
    }
}

export const curseforgeAPI = new CurseForgeAPIService();
