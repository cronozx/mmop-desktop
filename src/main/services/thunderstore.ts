import axios from 'axios';
import type { ModSearchResult, ModSummary, NormalizedModFile } from './modProvider.js';
import { getGameDefinition } from '../../config/games.js';

/**
 * Thunderstore mod provider (BepInEx games: Lethal Company, R.E.P.O, …).
 *
 * Thunderstore has no server-side search: the full package index for a
 * community is fetched once and filtered/paginated locally (cached briefly,
 * since the index is large). Individual packages and their downloadable files
 * are resolved through the experimental package endpoint, which is keyed by
 * `namespace/name` and resolves globally.
 *
 * Native mod ids are a package's `full_name` ("namespace-name"); the provider
 * layer prefixes them with `ts:` for storage. Thunderstore package names and
 * namespaces contain no hyphens, so splitting on the first hyphen is safe.
 */

const BASE_URL = 'https://thunderstore.io';
const INDEX_TTL_MS = 10 * 60 * 1000;

interface ThunderstoreVersion {
    full_name: string;
    description: string;
    icon: string;
    version_number: string;
    dependencies: string[];
    download_url: string;
    date_created: string;
    file_size?: number;
}

interface ThunderstorePackage {
    name: string;
    full_name: string;
    owner: string;
    package_url?: string;
    donation_link?: string | null;
    is_deprecated: boolean;
    is_pinned: boolean;
    total_downloads: number;
    rating_score: number;
    versions: ThunderstoreVersion[];
}

interface ThunderstorePackageDetail {
    namespace: string;
    name: string;
    full_name: string;
    owner?: string;
    package_url?: string;
    donation_link?: string | null;
    latest?: ThunderstoreVersion;
}

const indexCache = new Map<string, { fetchedAt: number; packages: ThunderstorePackage[] }>();

// Resolving a deep dependency tree (a single mod can pull 30+ transitive deps,
// many shared) hits the experimental package endpoint once per package — twice,
// since getModsByIds and getFilesForMod both resolve it. Without care that burst
// trips Thunderstore's rate limiter (HTTP 429), which fails the dependency and
// silently prunes its subtree. So package lookups are cached (dedupes the double
// fetch and the diamond-shaped graph), concurrency-limited, and retried on
// 429/5xx with backoff.
const PACKAGE_TTL_MS = 10 * 60 * 1000;
const MAX_CONCURRENT_PACKAGE_REQUESTS = 4;
const MAX_PACKAGE_RETRIES = 5;

const packageCache = new Map<string, { fetchedAt: number; pkg: ThunderstorePackageDetail }>();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Minimal concurrency gate so package lookups don't fan out all at once. On
// release the freed slot is handed straight to the next waiter (the count stays
// put), so it can never exceed the limit.
let activePackageRequests = 0;
const packageRequestWaiters: Array<() => void> = [];
function acquirePackageSlot(): Promise<void> {
    if (activePackageRequests < MAX_CONCURRENT_PACKAGE_REQUESTS) {
        activePackageRequests += 1;
        return Promise.resolve();
    }
    return new Promise<void>((resolve) => packageRequestWaiters.push(resolve));
}
function releasePackageSlot(): void {
    const next = packageRequestWaiters.shift();
    if (next) {
        next(); // hand this slot to the next waiter; active count is unchanged
    } else {
        activePackageRequests -= 1;
    }
}

function communityForGame(gameId: number): string | null {
    return getGameDefinition(gameId)?.thunderstoreCommunity ?? null;
}

async function getCommunityIndex(community: string): Promise<ThunderstorePackage[]> {
    const cached = indexCache.get(community);
    if (cached && Date.now() - cached.fetchedAt < INDEX_TTL_MS) {
        return cached.packages;
    }

    const response = await axios.get(`${BASE_URL}/c/${community}/api/v1/package/`, {
        timeout: 30000,
        headers: { 'User-Agent': 'MMOP/1.0' },
    });
    const packages = Array.isArray(response.data) ? (response.data as ThunderstorePackage[]) : [];
    indexCache.set(community, { fetchedAt: Date.now(), packages });
    return packages;
}

async function fetchPackage(fullName: string): Promise<ThunderstorePackageDetail | null> {
    const dash = fullName.indexOf('-');
    if (dash <= 0) {
        return null;
    }

    const cached = packageCache.get(fullName);
    if (cached && Date.now() - cached.fetchedAt < PACKAGE_TTL_MS) {
        return cached.pkg;
    }

    const namespace = fullName.slice(0, dash);
    const name = fullName.slice(dash + 1);
    const url = `${BASE_URL}/api/experimental/package/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/`;

    await acquirePackageSlot();
    try {
        for (let attempt = 0; attempt < MAX_PACKAGE_RETRIES; attempt += 1) {
            try {
                const response = await axios.get(url, {
                    timeout: 20000,
                    headers: { 'User-Agent': 'MMOP/1.0' },
                    validateStatus: () => true,
                });

                if (response.status === 200 && response.data) {
                    const pkg = response.data as ThunderstorePackageDetail;
                    packageCache.set(fullName, { fetchedAt: Date.now(), pkg });
                    return pkg;
                }

                // Rate-limited or transient server error: back off and retry. Honor
                // Retry-After when present, else exponential backoff (capped).
                if (response.status === 429 || response.status >= 500) {
                    const retryAfter = Number(response.headers?.['retry-after']);
                    const backoff = Number.isFinite(retryAfter) && retryAfter > 0
                        ? retryAfter * 1000
                        : Math.min(1000 * 2 ** attempt, 15000);
                    if (attempt < MAX_PACKAGE_RETRIES - 1) {
                        await sleep(backoff);
                        continue;
                    }
                }

                // 404 / other client errors: a genuine miss, don't retry.
                return null;
            } catch {
                // Network error: brief backoff then retry.
                if (attempt < MAX_PACKAGE_RETRIES - 1) {
                    await sleep(Math.min(1000 * 2 ** attempt, 15000));
                    continue;
                }
                return null;
            }
        }
        return null;
    } finally {
        releasePackageSlot();
    }
}

/** A dependency string is "namespace-name-version"; the mod id drops the version. */
function dependencyToModId(dependency: string): string {
    const parts = dependency.split('-');
    return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : dependency;
}

export const thunderstoreAPI = {
    async searchMods(gameId: number, searchFilter?: string, pageIndex = 0, pageSize = 50): Promise<ModSearchResult> {
        const community = communityForGame(gameId);
        if (!community) {
            return { mods: [], pagination: { hasMore: false, totalCount: 0, currentPage: pageIndex } };
        }

        let packages = (await getCommunityIndex(community)).filter((pkg) => !pkg.is_deprecated && pkg.versions.length > 0);

        const query = (searchFilter ?? '').trim().toLowerCase();
        if (query) {
            packages = packages.filter((pkg) =>
                pkg.name.toLowerCase().includes(query)
                || pkg.owner.toLowerCase().includes(query)
                || (pkg.versions[0]?.description ?? '').toLowerCase().includes(query));
        }

        packages.sort((a, b) =>
            (Number(b.is_pinned) - Number(a.is_pinned))
            || (b.rating_score - a.rating_score)
            || (b.total_downloads - a.total_downloads));

        const totalCount = packages.length;
        const start = pageIndex * pageSize;
        const slice = packages.slice(start, start + pageSize);

        return {
            mods: slice.map((pkg) => ({
                _id: pkg.full_name,
                name: pkg.name,
                author: pkg.owner,
                summary: pkg.versions[0]?.description,
                logo: pkg.versions[0]?.icon,
                sourceUrl: pkg.package_url,
                donationUrl: pkg.donation_link ?? undefined,
            })),
            pagination: { hasMore: start + pageSize < totalCount, totalCount, currentPage: pageIndex },
        };
    },

    async getModsByIds(fullNames: string[]): Promise<ModSummary[]> {
        const results = await Promise.all(fullNames.map((fullName) => fetchPackage(fullName)));
        return results
            .filter((pkg): pkg is ThunderstorePackageDetail => !!pkg)
            .map((pkg) => ({
                _id: pkg.full_name,
                name: pkg.name,
                author: pkg.owner ?? pkg.namespace,
                summary: pkg.latest?.description,
                logo: pkg.latest?.icon,
                sourceUrl: pkg.package_url ?? `https://thunderstore.io/package/${pkg.namespace}/${pkg.name}/`,
                donationUrl: pkg.donation_link ?? undefined,
            }));
    },

    async getModDescription(fullName: string): Promise<{ description: string; format: 'markdown'; url?: string }> {
        const pkg = await fetchPackage(fullName);
        if (!pkg) {
            return { description: '', format: 'markdown' };
        }
        const url = pkg.package_url
            ?? `${BASE_URL}/package/${encodeURIComponent(pkg.namespace)}/${encodeURIComponent(pkg.name)}/`;

        // Best-effort full readme; fall back to the short package description.
        if (pkg.latest?.version_number) {
            try {
                const readmeUrl = `${BASE_URL}/api/experimental/package/${encodeURIComponent(pkg.namespace)}/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.latest.version_number)}/readme/`;
                const response = await axios.get(readmeUrl, { timeout: 15000, headers: { 'User-Agent': 'MMOP/1.0' }, validateStatus: () => true });
                const markdown = typeof response.data?.markdown === 'string' ? response.data.markdown.trim() : '';
                if (markdown) {
                    return { description: markdown, format: 'markdown', url };
                }
            } catch {
                // Fall through to the short description below.
            }
        }

        return { description: pkg.latest?.description ?? '', format: 'markdown', url };
    },

    async getFilesForMod(fullName: string): Promise<NormalizedModFile[]> {
        const pkg = await fetchPackage(fullName);
        // The experimental endpoint occasionally returns an empty `latest` ({}),
        // which would otherwise yield a file with no download URL. Require the
        // download URL so the caller treats it as "no file" rather than a failure.
        if (!pkg?.latest?.download_url || !pkg.latest.full_name) {
            return [];
        }
        const version = pkg.latest;
        return [{
            id: version.full_name,
            displayName: `${pkg.name} ${version.version_number}`,
            fileName: `${version.full_name}.zip`,
            fileDate: version.date_created,
            downloadUrl: version.download_url,
            gameVersions: [],
            dependencies: (version.dependencies ?? []).map((dep) => ({ modId: dependencyToModId(dep), required: true })),
            fileSize: version.file_size,
        }];
    },
};
