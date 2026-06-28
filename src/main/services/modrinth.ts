import axios, { AxiosInstance } from 'axios';
import type { ModSearchResult, ModSummary, NormalizedModFile } from './modProvider.js';
import type { ProviderModpackSearchResult } from '../../types/sharedTypes.js';

const MODRINTH_BASE_URL = 'https://api.modrinth.com/v2';
const MODRINTH_USER_AGENT = 'MMOP/1.0 (mmop.app)';
const MODRINTH_ID_PREFIX = 'mr:';

interface ModrinthSearchHit {
    project_id: string;
    slug?: string;
    title: string;
    author?: string;
    description?: string;
    icon_url?: string | null;
    downloads?: number;
}

interface ModrinthSearchResponse {
    hits: ModrinthSearchHit[];
    offset: number;
    limit: number;
    total_hits: number;
}

interface ModrinthProject {
    id: string;
    slug?: string;
    title: string;
    description?: string;
    body?: string;
    icon_url?: string | null;
    team?: string;
    donation_urls?: Array<{ url?: string }>;
}

/** Modrinth mod page from a project's id or slug. */
function modrinthSourceUrl(idOrSlug: string): string {
    return `https://modrinth.com/mod/${idOrSlug}`;
}

interface ModrinthTeamMember {
    role?: string;
    user?: {
        username?: string;
    };
}

interface ModrinthVersionFile {
    url: string;
    filename: string;
    primary?: boolean;
    hashes?: {
        sha1?: string;
        sha512?: string;
    };
    size?: number;
}

interface ModrinthVersionDependency {
    project_id: string | null;
    dependency_type: 'required' | 'optional' | 'incompatible' | 'embedded';
}

interface ModrinthVersion {
    id: string;
    name: string;
    date_published: string;
    game_versions?: string[];
    files?: ModrinthVersionFile[];
    dependencies?: ModrinthVersionDependency[];
}

/** Maps a Modrinth search hit to the normalized mod summary shape (prefixed `_id`). */
export function normalizeModrinthSearchHit(hit: ModrinthSearchHit): ModSummary {
    return {
        _id: `${MODRINTH_ID_PREFIX}${hit.project_id}`,
        name: hit.title,
        author: hit.author || 'Unknown',
        summary: hit.description,
        logo: hit.icon_url || undefined,
        sourceUrl: modrinthSourceUrl(hit.slug || hit.project_id),
    };
}

/** Maps a Modrinth project to the normalized mod summary shape (prefixed `_id`). */
export function normalizeModrinthProject(project: ModrinthProject, author?: string): ModSummary {
    return {
        _id: `${MODRINTH_ID_PREFIX}${project.id}`,
        name: project.title,
        author: author || 'Unknown',
        summary: project.description,
        logo: project.icon_url || undefined,
        sourceUrl: modrinthSourceUrl(project.slug || project.id),
        donationUrl: project.donation_urls?.find((d) => d.url)?.url,
    };
}

/**
 * Maps a Modrinth version to the normalized file shape using its primary file.
 * Dependency ids come back prefixed (`mr:<projectId>`); the `required`
 * dependency type maps to the required relation. Returns null when the
 * version carries no usable file.
 */
export function normalizeModrinthVersion(version: ModrinthVersion): NormalizedModFile | null {
    const files = version.files ?? [];
    const primaryFile = files.find((file) => file.primary) ?? files[0];
    if (!primaryFile?.url || !primaryFile?.filename) {
        return null;
    }

    return {
        id: version.id,
        displayName: version.name,
        fileName: primaryFile.filename,
        fileDate: version.date_published,
        downloadUrl: primaryFile.url,
        gameVersions: version.game_versions ?? [],
        sha1: typeof primaryFile.hashes?.sha1 === 'string' ? primaryFile.hashes.sha1.toLowerCase() : undefined,
        sha512: typeof primaryFile.hashes?.sha512 === 'string' ? primaryFile.hashes.sha512.toLowerCase() : undefined,
        fileSize: typeof primaryFile.size === 'number' ? primaryFile.size : undefined,
        dependencies: (version.dependencies ?? [])
            .filter((dep): dep is ModrinthVersionDependency & { project_id: string } =>
                typeof dep.project_id === 'string' && dep.project_id.length > 0)
            .map((dep) => ({
                modId: `${MODRINTH_ID_PREFIX}${dep.project_id}`,
                required: dep.dependency_type === 'required',
            })),
    };
}

/** Result of a `POST /version_files` hash lookup: hash → owning project/version. */
export interface ModrinthHashLookupHit {
    projectId: string;
    versionId: string;
}

/**
 * Normalizes the raw `POST /version_files` response (a map of requested hash →
 * version object) into a `Map<lowercase hash, { projectId, versionId }>`.
 * Hashes the API did not recognize are simply absent from the result.
 */
export function normalizeVersionFilesResponse(data: unknown): Map<string, ModrinthHashLookupHit> {
    const result = new Map<string, ModrinthHashLookupHit>();
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return result;
    }

    for (const [hash, version] of Object.entries(data as Record<string, unknown>)) {
        const projectId = (version as { project_id?: unknown } | null)?.project_id;
        const versionId = (version as { id?: unknown } | null)?.id;
        if (typeof projectId === 'string' && projectId.length > 0) {
            result.set(hash.toLowerCase(), {
                projectId,
                versionId: typeof versionId === 'string' ? versionId : '',
            });
        }
    }

    return result;
}

class ModrinthAPIService {
    private client: AxiosInstance;

    constructor() {
        // The public Modrinth API requires no API key, only a User-Agent.
        this.client = axios.create({
            baseURL: MODRINTH_BASE_URL,
            headers: {
                'User-Agent': MODRINTH_USER_AGENT,
                'Content-Type': 'application/json',
            },
            timeout: 15000,
        });
    }

    /**
     * Search Modrinth mods (Minecraft-only).
     * @param searchFilter - Optional search term
     * @param pageIndex - Page index (default: 0)
     * @param pageSize - Number of results per page (default: 50)
     * @param gameVersion - e.g. "1.20.1"
     * @param modLoader - lowercase loader name ("forge"/"fabric"/"quilt"/"neoforge")
     */
    async searchMods(
        searchFilter?: string,
        pageIndex: number = 0,
        pageSize: number = 50,
        gameVersion?: string,
        modLoader?: string
    ): Promise<ModSearchResult> {
        const facets: string[][] = [['project_type:mod']];
        if (gameVersion) {
            facets.push([`versions:${gameVersion}`]);
        }
        if (modLoader) {
            facets.push([`categories:${modLoader.toLowerCase()}`]);
        }

        try {
            const response = await this.client.get<ModrinthSearchResponse>('/search', {
                params: {
                    query: searchFilter || undefined,
                    facets: JSON.stringify(facets),
                    limit: pageSize,
                    offset: pageIndex * pageSize,
                    // Sort by popularity when browsing without a query.
                    index: searchFilter ? 'relevance' : 'downloads',
                },
            });

            const mods = (response.data.hits ?? []).map(normalizeModrinthSearchHit);
            const totalCount = response.data.total_hits ?? 0;
            const hasMore = (pageIndex + 1) * pageSize < totalCount;

            // Enrich with donation URLs via a single batch project fetch.
            const projectIds = (response.data.hits ?? []).map((h: ModrinthSearchHit) => h.project_id);
            if (projectIds.length > 0) {
                const projects = await this.getProjectsByIds(projectIds);
                const donationByProjectId = new Map(
                    projects.map((p) => [p.id, p.donation_urls?.find((d) => d.url)?.url])
                );
                for (const mod of mods) {
                    const rawId = mod._id.slice(MODRINTH_ID_PREFIX.length);
                    mod.donationUrl = donationByProjectId.get(rawId);
                }
            }

            console.log(`Fetched Modrinth page ${pageIndex + 1}, ${mods.length} mods (${totalCount} total)`);

            return {
                mods,
                pagination: {
                    hasMore,
                    totalCount,
                    currentPage: pageIndex,
                },
            };
        } catch (error: unknown) {
            if (axios.isAxiosError(error)) {
                console.error('Modrinth API Error:', error.response?.data || error.message);
                throw new Error(`Failed to fetch mods from Modrinth: ${error.response?.data?.description || error.message}`);
            }
            throw error;
        }
    }

    /** Get multiple raw projects by their Modrinth project ids. */
    async getProjectsByIds(projectIds: string[]): Promise<ModrinthProject[]> {
        if (projectIds.length === 0) {
            return [];
        }

        try {
            const response = await this.client.get<ModrinthProject[]>('/projects', {
                params: { ids: JSON.stringify(projectIds) },
            });
            return Array.isArray(response.data) ? response.data : [];
        } catch (error: unknown) {
            if (axios.isAxiosError(error)) {
                console.error('Modrinth API Error:', error.response?.data || error.message);
                return [];
            }
            throw error;
        }
    }

    /**
     * Resolve team owners' usernames for the given team ids. Best effort:
     * failures simply produce an empty map (callers fall back to "Unknown").
     */
    private async getTeamOwnersByTeamId(teamIds: string[]): Promise<Map<string, string>> {
        const owners = new Map<string, string>();
        if (teamIds.length === 0) {
            return owners;
        }

        try {
            const response = await this.client.get<ModrinthTeamMember[][]>('/teams', {
                params: { ids: JSON.stringify(teamIds) },
            });

            const teams = Array.isArray(response.data) ? response.data : [];
            teams.forEach((members, index) => {
                const teamId = teamIds[index];
                if (!teamId || !Array.isArray(members)) {
                    return;
                }
                const owner = members.find((member) => member.role?.toLowerCase() === 'owner') ?? members[0];
                const username = owner?.user?.username;
                if (username) {
                    owners.set(teamId, username);
                }
            });
        } catch (error: unknown) {
            if (axios.isAxiosError(error)) {
                console.error('Modrinth teams lookup failed:', error.response?.data || error.message);
            }
        }

        return owners;
    }

    /**
     * Get normalized mod summaries by Modrinth project ids (`GET /projects`).
     * Project responses do not include an author, so team owners are resolved
     * in one extra batched call (best effort).
     */
    async getModsByIds(projectIds: string[]): Promise<ModSummary[]> {
        const projects = await this.getProjectsByIds(projectIds);
        if (projects.length === 0) {
            return [];
        }

        const teamIds = projects
            .map((project) => project.team)
            .filter((team): team is string => typeof team === 'string' && team.length > 0);
        const ownersByTeamId = await this.getTeamOwnersByTeamId(Array.from(new Set(teamIds)));

        return projects.map((project) =>
            normalizeModrinthProject(project, project.team ? ownersByTeamId.get(project.team) : undefined)
        );
    }

    /**
     * Resolve mod files by hash in ONE batched request
     * (`POST /version_files`, body `{"hashes": [...], "algorithm": "sha1"}`).
     * Returns a map of lowercase hash → `{ projectId, versionId }`; hashes that
     * Modrinth does not recognize are absent from the map. Throws on network /
     * API failure so callers can distinguish "unknown hash" from "lookup failed".
     */
    async getVersionsByFileHashes(
        hashes: string[],
        algorithm: 'sha1' | 'sha512' = 'sha1'
    ): Promise<Map<string, ModrinthHashLookupHit>> {
        if (hashes.length === 0) {
            return new Map();
        }

        try {
            const response = await this.client.post<Record<string, unknown>>('/version_files', {
                hashes,
                algorithm,
            });
            return normalizeVersionFilesResponse(response.data);
        } catch (error: unknown) {
            if (axios.isAxiosError(error)) {
                console.error('Modrinth version_files lookup failed:', error.response?.data || error.message);
                throw new Error(`Modrinth hash lookup failed: ${error.response?.data?.description || error.message}`);
            }
            throw error;
        }
    }

    /**
     * Get normalized files for a project, optionally filtered by game version
     * and loader (`GET /project/{id}/version`). Newest first.
     */
    async getFilesForMod(projectId: string, gameVersion?: string, modLoader?: string): Promise<NormalizedModFile[]> {
        try {
            const response = await this.client.get<ModrinthVersion[]>(`/project/${encodeURIComponent(projectId)}/version`, {
                params: {
                    ...(gameVersion ? { game_versions: JSON.stringify([gameVersion]) } : {}),
                    ...(modLoader ? { loaders: JSON.stringify([modLoader.toLowerCase()]) } : {}),
                },
            });

            const versions = Array.isArray(response.data) ? response.data : [];
            return versions
                .map(normalizeModrinthVersion)
                .filter((file): file is NormalizedModFile => file !== null)
                .sort((a, b) => new Date(b.fileDate).getTime() - new Date(a.fileDate).getTime());
        } catch (error: unknown) {
            if (axios.isAxiosError(error)) {
                console.error('Modrinth getFilesForMod error:', error.response?.data || error.message);
                return [];
            }
            throw error;
        }
    }

    /**
     * Search Modrinth for existing modpacks (project_type:modpack), newest /
     * most-downloaded first. Optionally narrowed to a Minecraft version.
     */
    async searchModpacks(
        searchFilter?: string,
        pageIndex: number = 0,
        pageSize: number = 30,
        gameVersion?: string
    ): Promise<ProviderModpackSearchResult> {
        const facets: string[][] = [['project_type:modpack']];
        if (gameVersion) {
            facets.push([`versions:${gameVersion}`]);
        }

        try {
            const response = await this.client.get<ModrinthSearchResponse>('/search', {
                params: {
                    query: searchFilter || undefined,
                    facets: JSON.stringify(facets),
                    limit: pageSize,
                    offset: pageIndex * pageSize,
                    index: searchFilter ? 'relevance' : 'downloads',
                },
            });

            const hits = response.data.hits ?? [];
            const totalCount = response.data.total_hits ?? 0;
            return {
                modpacks: hits.map((hit) => ({
                    id: hit.project_id,
                    name: hit.title,
                    author: hit.author || 'Unknown',
                    summary: hit.description,
                    logo: hit.icon_url || undefined,
                    downloads: typeof hit.downloads === 'number' ? hit.downloads : undefined,
                    provider: 'modrinth' as const,
                })),
                hasMore: (pageIndex + 1) * pageSize < totalCount,
                totalCount,
            };
        } catch (error: unknown) {
            if (axios.isAxiosError(error)) {
                console.error('Modrinth modpack search error:', error.response?.data || error.message);
                return { modpacks: [], hasMore: false, totalCount: 0 };
            }
            throw error;
        }
    }

    /**
     * Resolve the newest version's `.mrpack` download URL for a modpack project.
     * Returns null when the project has no published .mrpack file.
     */
    async getModpackFileUrl(projectId: string): Promise<{ url: string; fileName: string } | null> {
        try {
            const response = await this.client.get<ModrinthVersion[]>(`/project/${encodeURIComponent(projectId)}/version`);
            const versions = Array.isArray(response.data) ? response.data : [];
            versions.sort((a, b) => new Date(b.date_published).getTime() - new Date(a.date_published).getTime());
            for (const version of versions) {
                const files = version.files ?? [];
                const mrpack = files.find((file) => file.filename?.toLowerCase().endsWith('.mrpack'))
                    ?? files.find((file) => file.primary)
                    ?? files[0];
                if (mrpack?.url && mrpack.filename?.toLowerCase().endsWith('.mrpack')) {
                    return { url: mrpack.url, fileName: mrpack.filename };
                }
            }
            return null;
        } catch (error: unknown) {
            if (axios.isAxiosError(error)) {
                console.error('Modrinth getModpackFileUrl error:', error.response?.data || error.message);
                return null;
            }
            throw error;
        }
    }

    /**
     * Fetch a single project's full long-form description (`body`, markdown) plus
     * a canonical web URL. Falls back to the short description when no body is set.
     */
    async getModDescription(projectId: string): Promise<{ description: string; format: 'markdown'; url?: string }> {
        try {
            const response = await this.client.get<ModrinthProject>(`/project/${encodeURIComponent(projectId)}`);
            const project = response.data;
            const body = typeof project?.body === 'string' && project.body.trim()
                ? project.body
                : (project?.description ?? '');
            const slug = project?.slug || project?.id || projectId;
            return { description: body, format: 'markdown', url: `https://modrinth.com/mod/${slug}` };
        } catch (error: unknown) {
            if (axios.isAxiosError(error)) {
                console.error('Modrinth getModDescription error:', error.response?.data || error.message);
                return { description: '', format: 'markdown' };
            }
            throw error;
        }
    }
}

// Export singleton instance
export const modrinthAPI = new ModrinthAPIService();
