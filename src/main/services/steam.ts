import axios from 'axios';
import type { NormalizedModFile } from './modProvider.js';

/**
 * Steam Workshop API client (the mod source for Terraria/tModLoader).
 *
 * Two parts of the public Steam Web API are used:
 *   - IPublishedFileService/QueryFiles  — keyword search / browse (needs a Steam
 *     Web API key in STEAM_API_KEY).
 *   - ISteamRemoteStorage/GetPublishedFileDetails — per-item metadata (keyless).
 *   - ISteamUser/GetPlayerSummaries — resolve author display names (needs key).
 *
 * NOTE: the Web API does NOT serve the actual mod files for Workshop UGC items —
 * `file_url` is empty for tModLoader mods. Downloads happen out of band via
 * SteamCMD (see services/steamcmd.ts). This client only powers search, metadata,
 * and descriptions.
 *
 * Native `_id`s are "<appId>/<publishedFileId>" (e.g. "1281930/2824688072"), so
 * the Workshop app id travels with each id. Imported by modProvider.ts, which
 * runs in BOTH the Electron main process and the Node backend, so this module
 * must not depend on `electron`.
 */

const STEAM_API_KEY = process.env.STEAM_API_KEY;
const API_BASE = 'https://api.steampowered.com';
const USER_AGENT = 'MMOP/desktop (+https://github.com/cronozx/mmop-desktop)';

// QueryFiles query_type values we use.
const QUERY_TYPE_RANKED_BY_TEXT_SEARCH = 9;
const QUERY_TYPE_RANKED_BY_TREND = 3;
const FILE_TYPE_ITEMS = 0; // k_PublishedFileQueryType items (regular Workshop items)

export interface SteamModSummary {
    _id: string;
    name: string;
    author: string;
    summary?: string;
    logo?: string;
}

export interface SteamSearchResult {
    mods: SteamModSummary[];
    pagination: { hasMore: boolean; totalCount: number; currentPage: number };
}

interface PublishedFile {
    publishedfileid?: string;
    title?: string;
    short_description?: string;
    file_description?: string;
    description?: string;
    preview_url?: string;
    creator?: string;
    time_updated?: number;
    file_size?: string | number;
    filename?: string;
}

class SteamWorkshopService {
    constructor() {
        if (!STEAM_API_KEY) {
            console.warn('Steam Web API key not found. Add STEAM_API_KEY to your .env file to enable Workshop search.');
        }
    }

    /** Resolve creator steamid64 → persona name (best effort; needs an API key). */
    private async resolveAuthorNames(steamIds: string[]): Promise<Map<string, string>> {
        const names = new Map<string, string>();
        const unique = Array.from(new Set(steamIds.filter(Boolean)));
        if (!STEAM_API_KEY || unique.length === 0) {
            return names;
        }
        try {
            const { data } = await axios.get(`${API_BASE}/ISteamUser/GetPlayerSummaries/v2/`, {
                params: { key: STEAM_API_KEY, steamids: unique.join(',') },
                headers: { 'User-Agent': USER_AGENT },
                timeout: 15000,
            });
            const players: Array<{ steamid?: string; personaname?: string }> = data?.response?.players ?? [];
            for (const player of players) {
                if (player.steamid && player.personaname) {
                    names.set(player.steamid, player.personaname);
                }
            }
        } catch (error) {
            console.error('Steam GetPlayerSummaries failed:', error);
        }
        return names;
    }

    /**
     * Keyword search (or trend browse when `searchFilter` is empty) of one
     * Workshop app's items, via IPublishedFileService/QueryFiles. Native `_id`s
     * come back as "<appId>/<publishedFileId>".
     */
    async searchMods(appId: number, searchFilter?: string, pageIndex = 0, pageSize = 50): Promise<SteamSearchResult> {
        if (!STEAM_API_KEY) {
            return { mods: [], pagination: { hasMore: false, totalCount: 0, currentPage: pageIndex } };
        }

        const trimmed = searchFilter?.trim();
        const params: Record<string, unknown> = {
            key: STEAM_API_KEY,
            appid: appId,
            query_type: trimmed ? QUERY_TYPE_RANKED_BY_TEXT_SEARCH : QUERY_TYPE_RANKED_BY_TREND,
            filetype: FILE_TYPE_ITEMS,
            page: pageIndex + 1, // QueryFiles pages are 1-based
            numperpage: pageSize,
            return_short_description: true,
            return_previews: true,
            return_metadata: true,
            ...(trimmed ? { search_text: trimmed } : {}),
        };

        try {
            const { data } = await axios.get(`${API_BASE}/IPublishedFileService/QueryFiles/v1/`, {
                params,
                headers: { 'User-Agent': USER_AGENT },
                timeout: 15000,
            });

            const response = data?.response ?? {};
            const files: PublishedFile[] = Array.isArray(response.publishedfiledetails) ? response.publishedfiledetails : [];
            const totalCount = Number(response.total ?? files.length);

            const authorNames = await this.resolveAuthorNames(files.map((file) => file.creator ?? ''));
            const mods = files
                .filter((file) => file.publishedfileid)
                .map((file) => this.toSummary(appId, file, authorNames));

            return {
                mods,
                pagination: {
                    hasMore: (pageIndex + 1) * pageSize < totalCount,
                    totalCount,
                    currentPage: pageIndex,
                },
            };
        } catch (error) {
            console.error('Steam Workshop search failed:', error);
            return { mods: [], pagination: { hasMore: false, totalCount: 0, currentPage: pageIndex } };
        }
    }

    /** Fetch published-file details for native ids ("<appId>/<pubFileId>"). */
    async getModsByIds(nativeIds: string[]): Promise<SteamModSummary[]> {
        const parsed = nativeIds
            .map((nativeId) => {
                const [appId, pubFileId] = nativeId.split('/');
                return appId && pubFileId ? { nativeId, appId: Number(appId), pubFileId } : null;
            })
            .filter((entry): entry is { nativeId: string; appId: number; pubFileId: string } => entry !== null);

        if (parsed.length === 0) {
            return [];
        }

        const detailsById = await this.getPublishedFileDetails(parsed.map((entry) => entry.pubFileId));
        const authorNames = await this.resolveAuthorNames(
            parsed.map((entry) => detailsById.get(entry.pubFileId)?.creator ?? '')
        );

        return parsed
            .map((entry) => {
                const file = detailsById.get(entry.pubFileId);
                if (!file) return null;
                return this.toSummary(entry.appId, file, authorNames);
            })
            .filter((summary): summary is SteamModSummary => summary !== null);
    }

    /** Full description for a native id, plus the public Workshop page URL. */
    async getModDescription(nativeId: string): Promise<{ description: string; format: 'text'; url?: string }> {
        const [, pubFileId] = nativeId.split('/');
        if (!pubFileId) return { description: '', format: 'text' };
        const url = `https://steamcommunity.com/sharedfiles/filedetails/?id=${pubFileId}`;
        const details = await this.getPublishedFileDetails([pubFileId]);
        const file = details.get(pubFileId);
        const raw = file?.file_description || file?.description || file?.short_description || '';
        return { description: stripSteamBBCode(raw), format: 'text', url };
    }

    /**
     * A placeholder "file" for a Workshop item. The real file is fetched via
     * SteamCMD, not a URL, so `downloadUrl` is empty; `fileName` is a stable
     * "<pubFileId>.tmod" used only when a deterministic name is needed (the
     * download path preserves the real .tmod name and tracks it separately).
     */
    async getModFiles(nativeId: string): Promise<NormalizedModFile[]> {
        const [, pubFileId] = nativeId.split('/');
        if (!pubFileId) return [];
        const details = await this.getPublishedFileDetails([pubFileId]);
        const file = details.get(pubFileId);
        const updated = Number(file?.time_updated ?? 0);
        return [{
            id: pubFileId,
            displayName: file?.title ?? `Workshop item ${pubFileId}`,
            fileName: `${pubFileId}.tmod`,
            fileDate: updated > 0 ? new Date(updated * 1000).toISOString() : new Date(0).toISOString(),
            downloadUrl: '',
            gameVersions: [],
            dependencies: [],
            ...(file?.file_size ? { fileSize: Number(file.file_size) } : {}),
        }];
    }

    /** POST ISteamRemoteStorage/GetPublishedFileDetails for a batch of ids. */
    private async getPublishedFileDetails(pubFileIds: string[]): Promise<Map<string, PublishedFile>> {
        const result = new Map<string, PublishedFile>();
        const unique = Array.from(new Set(pubFileIds.filter(Boolean)));
        if (unique.length === 0) {
            return result;
        }

        const body = new URLSearchParams();
        body.set('itemcount', String(unique.length));
        unique.forEach((id, index) => body.set(`publishedfileids[${index}]`, id));

        try {
            const { data } = await axios.post(`${API_BASE}/ISteamRemoteStorage/GetPublishedFileDetails/v1/`, body, {
                headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 15000,
            });
            const files: PublishedFile[] = data?.response?.publishedfiledetails ?? [];
            for (const file of files) {
                if (file.publishedfileid) {
                    result.set(file.publishedfileid, file);
                }
            }
        } catch (error) {
            console.error('Steam GetPublishedFileDetails failed:', error);
        }
        return result;
    }

    private toSummary(appId: number, file: PublishedFile, authorNames: Map<string, string>): SteamModSummary {
        const pubFileId = String(file.publishedfileid);
        const author = (file.creator && authorNames.get(file.creator)) || 'Steam Workshop';
        const summary = file.short_description || file.file_description || file.description;
        return {
            _id: `${appId}/${pubFileId}`,
            name: file.title || `Workshop item ${pubFileId}`,
            author,
            summary: typeof summary === 'string' && summary.trim() ? stripSteamBBCode(summary).slice(0, 400) : undefined,
            logo: typeof file.preview_url === 'string' ? file.preview_url : undefined,
        };
    }
}

/** Steam descriptions are BBCode; convert to readable plain text (never markup). */
export function stripSteamBBCode(input: string): string {
    return input
        .replace(/\[\/?(b|i|u|h1|h2|h3|list|olist|quote|code|spoiler|noparse)\]/gi, '')
        .replace(/\[\*\]/g, '\n• ')
        .replace(/\[url=[^\]]*\]/gi, '')
        .replace(/\[\/url\]/gi, '')
        .replace(/\[img\][^[]*\[\/img\]/gi, '')
        .replace(/\[[^\]]+\]/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export const steamAPI = new SteamWorkshopService();
