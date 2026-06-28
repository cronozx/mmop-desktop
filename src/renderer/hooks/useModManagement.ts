import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction, UIEvent } from "react";
import type { NavigateFunction } from "react-router";
import { ModDownloadProgress, ModpackType, ModType, ModUpdateCheckResult, ModProviderId, ModProviderOption } from "../../types/sharedTypes";
import { LOADER_LABELS, resolveModpackLoader } from "../helpers/minecraft";
import { getErrorMessage } from "../utils/errors";

export interface DownloadResults {
    successful: string[];
    failed: string[];
    skipped: string[];
    dependencies: string[];
    /** Provider-prefixed ids of auto-resolved dependencies (to add to the pack). */
    dependencyIds?: string[];
    downloadPath: string;
    deployedTo?: string;
}

interface UseModManagementParams {
    modpack: ModpackType | undefined;
    token: string | null;
    navigate: NavigateFunction;
    currentMods: string[];
    setCurrentMods: Dispatch<SetStateAction<string[]>>;
    /** Screen-level loading flag (cleared once the first mods fetch settles). */
    setLoading: Dispatch<SetStateAction<boolean>>;
}

/**
 * Owns the "Add Mods" modal state (search, paging, infinite scroll), adding /
 * removing mods from the working list, the mod download flow, and the
 * download-results banner state.
 */
export function useModManagement({ modpack, token, navigate, currentMods, setCurrentMods, setLoading }: UseModManagementParams) {
    const [loadingMods, setLoadingMods] = useState<boolean>(false);
    const [loadingMoreMods, setLoadingMoreMods] = useState<boolean>(false);
    const [modsError, setModsError] = useState<string>('');
    const [availableMods, setAvailableMods] = useState<ModType[]>([]);
    const [hasMoreMods, setHasMoreMods] = useState<boolean>(false);
    const [currentPage, setCurrentPage] = useState<number>(0);
    const [totalModsCount, setTotalModsCount] = useState<number>(0);
    const [showAddModsModal, setShowAddModsModal] = useState<boolean>(false);
    const [modProviders, setModProviders] = useState<ModProviderOption[]>([]);
    const [modProvider, setModProvider] = useState<ModProviderId | null>(null);
    const [searchQuery, setSearchQuery] = useState<string>("");
    const [debouncedSearch, setDebouncedSearch] = useState<string>("");
    const [downloading, setDownloading] = useState<boolean>(false);
    const [downloadProgress, setDownloadProgress] = useState<ModDownloadProgress | null>(null);
    const [downloadResults, setDownloadResults] = useState<DownloadResults | null>(null);
    const [modsPresent, setModsPresent] = useState<boolean>(false);
    // True once a download finished with no failures for the current mod set.
    // Reset whenever the mod list changes so the button re-enables for new mods.
    const [allModsDownloaded, setAllModsDownloaded] = useState<boolean>(false);
    const [checkingUpdates, setCheckingUpdates] = useState<boolean>(false);
    const [updateCheck, setUpdateCheck] = useState<ModUpdateCheckResult | null>(null);
    const [updatingMods, setUpdatingMods] = useState<boolean>(false);
    // Add-time compatibility guard state: modId → inline message for the card,
    // plus the ids currently being checked. The cache lives for one modal
    // session (cleared on close) so repeated Add clicks don't re-hit the API.
    const [incompatibleMods, setIncompatibleMods] = useState<Record<string, string>>({});
    const [checkingCompatibilityIds, setCheckingCompatibilityIds] = useState<string[]>([]);
    const compatibilityCacheRef = useRef<Map<string, boolean>>(new Map());

    // Debounce search input
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedSearch(searchQuery);
        }, 500);

        return () => clearTimeout(timer);
    }, [searchQuery]);

    // Live per-mod progress from the main process while a download/update runs.
    useEffect(() => {
        if (!modpack) return;
        return window.db.onModDownloadProgress((p) => {
            if (p.modpackId === modpack.name) setDownloadProgress(p);
        });
    }, [modpack?.name]);

    // Accurately reflect what's on disk by asking which of the current mods are
    // still missing their files. Drives `allModsDownloaded` (none missing → hide
    // the Download button) and `modsPresent` (at least one present). Debounced so
    // rapid edits don't spam the check; re-runs on any mod-list change.
    useEffect(() => {
        if (!modpack || currentMods.length === 0) {
            setAllModsDownloaded(false);
            setModsPresent(false);
            return;
        }
        // Resolve presence with the same version/loader the download uses, so a
        // mod already on disk is recognized (not re-flagged as missing).
        const { loader } = resolveModpackLoader(modpack);
        const modLoaderName = loader ? LOADER_LABELS[loader] : undefined;
        let cancelled = false;
        const timer = setTimeout(() => {
            window.db.getMissingModIds(modpack.name, currentMods, modpack.minecraftVersion, modLoaderName, modpack.gameID)
                .then((missing) => {
                    if (cancelled) return;
                    setAllModsDownloaded(missing.length === 0);
                    setModsPresent(missing.length < currentMods.length);
                })
                .catch(() => { /* leave the previous state on error */ });
        }, 300);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [modpack?.name, modpack?.gameID, modpack?.minecraftVersion, modpack?.modLoader, currentMods]);

    // Fetch mods function
    const fetchMods = async (search: string = '', page: number = 0, reset: boolean = false) => {
        if (!modpack) {
            navigate('/');
            return;
        }

        // Prevent loading if already loading
        if (page === 0) {
            setLoadingMods(true);
        } else {
            setLoadingMoreMods(true);
        }

        setModsError('');

        try {
            if (!token) {
                navigate('/login');
                return;
            }

            console.log('Fetching mods for game ID:', modpack.gameID, 'search:', search, 'page:', page);
            // Filter results to the pack's loader and Minecraft version, so only
            // compatible mods are shown. (loader is undefined for non-Minecraft
            // games, which correctly skips the filter.)
            const { loader } = resolveModpackLoader(modpack);
            const result = await window.db.getAllModsForGame(token, modpack.gameID, modProvider ?? undefined, search, page, modpack.minecraftVersion, loader);
            console.log('Received', result.mods.length, 'mods, hasMore:', result.hasMore, 'total:', result.totalCount);

            if (reset || page === 0) {
                setAvailableMods(result.mods);
            } else {
                setAvailableMods(prev => [...prev, ...result.mods]);
            }

            setHasMoreMods(result.hasMore);
            setTotalModsCount(result.totalCount);
            setCurrentPage(page);
        } catch (error) {
            console.error('Error fetching mods:', error);
            setModsError(getErrorMessage(error) || 'Failed to fetch mods');
        } finally {
            setLoadingMods(false);
            setLoadingMoreMods(false);
            setLoading(false);
        }
    };

    // Resolve the game's mod sources when the modal opens (e.g. Minecraft →
    // Modrinth + CurseForge); default to the first. Searching waits for one.
    useEffect(() => {
        if (!showAddModsModal || !modpack) return;
        let cancelled = false;
        setLoadingMods(true);
        window.db.getModProviders(modpack.gameID)
            .then((list) => {
                if (cancelled) return;
                setModProviders(list);
                setModProvider(list[0]?.id ?? null);
                if (list.length === 0) setLoadingMods(false);
            })
            .catch(() => { if (!cancelled) setLoadingMods(false); });
        return () => { cancelled = true; };
    }, [showAddModsModal, modpack?.gameID]);

    // Reset and fetch mods when the source or search changes (once a source is set).
    useEffect(() => {
        if (showAddModsModal && modpack && modProvider) {
            setAvailableMods([]);
            setCurrentPage(0);
            fetchMods(debouncedSearch, 0, true);
        }
    }, [debouncedSearch, showAddModsModal, modProvider]);

    //Mod action handlers
    const handleAddMod = async (modId: string) => {
        if (currentMods.includes(modId)) return;

        // Add-time compatibility guard (Minecraft packs with a pinned
        // version+loader): verify the provider has at least one file for the
        // combination before adding. Provider errors fail open — this is an
        // availability check, not a security boundary.
        const { loader } = modpack ? resolveModpackLoader(modpack) : { loader: undefined };
        if (modpack?.minecraftVersion && loader) {
            const cache = compatibilityCacheRef.current;
            let compatible = cache.get(modId);

            if (compatible === undefined) {
                setCheckingCompatibilityIds(prev => [...prev, modId]);
                try {
                    const result = await window.db.checkModCompatibility(modId, modpack.minecraftVersion, loader);
                    compatible = result.checked ? result.compatible : true;
                    if (result.checked) cache.set(modId, compatible);
                } catch (error) {
                    console.warn('Mod compatibility check failed; adding anyway:', error);
                    compatible = true;
                } finally {
                    setCheckingCompatibilityIds(prev => prev.filter(id => id !== modId));
                }
            }

            if (!compatible) {
                setIncompatibleMods(prev => ({
                    ...prev,
                    [modId]: `No files for ${modpack.minecraftVersion} + ${LOADER_LABELS[loader]}`,
                }));
                return;
            }
        }

        setCurrentMods(prev => (prev.includes(modId) ? prev : [...prev, modId]));
    };

    const handleRemoveMod = (modId: string) => {
        setCurrentMods(currentMods.filter(_id => _id !== modId));
    };

    //Scroll handler for infinite scroll
    const handleScroll = (e: UIEvent<HTMLDivElement>) => {
        const { scrollHeight, scrollTop, clientHeight } = e.currentTarget;
        const bottom = scrollHeight - scrollTop - clientHeight < 50;

        if (bottom && hasMoreMods && !loadingMods && !loadingMoreMods) {
            console.log('Loading more mods, page:', currentPage + 1);
            fetchMods(debouncedSearch, currentPage + 1, false);
        }
    };

    //Modal close handler
    const handleCloseModsModal = () => {
        setShowAddModsModal(false);
        setSearchQuery('');
        setDebouncedSearch('');
        setAvailableMods([]);
        setCurrentPage(0);
        setModProviders([]);
        setModProvider(null);
        setIncompatibleMods({});
        setCheckingCompatibilityIds([]);
        compatibilityCacheRef.current.clear();
    };

    /**
     * Downloads an explicit list of mods for the modpack. Callers decide which
     * mods to download (e.g. filtering out mods that are pending approval).
     */
    const downloadModList = async (modsToDownload: string[]) => {
        if (!modpack) return;
        setDownloading(true);
        setDownloadProgress(null);
        setDownloadResults(null);
        try {
            if (!token) {
                navigate('/login');
                return;
            }
            // Use the modpack's mod loader for download filtering
            const { loader } = resolveModpackLoader(modpack);
            const modLoaderName = loader ? LOADER_LABELS[loader] : undefined;
            const results = await window.db.downloadMods(token, modsToDownload, modpack.name, modpack.minecraftVersion, modLoaderName, modpack.gameID);
            setDownloadResults(results);
            if (results.successful.length > 0 || results.skipped.length > 0) {
                setModsPresent(true);
            }
            // Auto-resolved dependencies were downloaded but aren't user-selected;
            // add them to the mod list so the pack reflects what's installed (the
            // author then saves to persist them).
            if (Array.isArray(results.dependencyIds) && results.dependencyIds.length > 0) {
                setCurrentMods((prev) => {
                    const have = new Set(prev);
                    const additions = results.dependencyIds.filter((id) => !have.has(id));
                    return additions.length > 0 ? [...prev, ...additions] : prev;
                });
            }
            // Everything requested is on disk when nothing failed.
            if (results.failed.length === 0) {
                setAllModsDownloaded(true);
            }
        } catch (error) {
            console.error('Download error:', error);
        } finally {
            setDownloading(false);
            setDownloadProgress(null);
        }
    };

    /**
     * Builds the modpack-shaped payload the update IPCs validate against:
     * the current (possibly unsaved) mod list plus the normalized lowercase
     * loader (handles legacy `forgeVersion`-only packs).
     */
    const buildUpdatePayload = (): ModpackType | null => {
        if (!modpack) return null;
        const { loader } = resolveModpackLoader(modpack);
        return { ...modpack, mods: currentMods, modLoader: loader };
    };

    /** Dry-run check: which mods have a newer (or missing) file on disk. */
    const checkForUpdates = async () => {
        const payload = buildUpdatePayload();
        if (!payload?.minecraftVersion || currentMods.length === 0 || checkingUpdates) return;
        if (!token) {
            navigate('/login');
            return;
        }

        setCheckingUpdates(true);
        setUpdateCheck(null);
        try {
            const result = await window.db.checkModUpdates(token, payload);
            setUpdateCheck(result);
        } catch (error) {
            console.error('Mod update check failed:', error);
        } finally {
            setCheckingUpdates(false);
        }
    };

    /**
     * One-click update: replaces the selected mods' files with the newest
     * compatible ones. Results reuse the download-results banner shape.
     */
    const applyModUpdates = async (modIds: string[]) => {
        const payload = buildUpdatePayload();
        if (!payload || modIds.length === 0 || updatingMods) return;
        if (!token) {
            navigate('/login');
            return;
        }

        setUpdatingMods(true);
        setDownloadProgress(null);
        setDownloadResults(null);
        try {
            const results = await window.db.updateMods(token, payload, modIds);
            setDownloadResults(results);
            if (results.successful.length > 0 || results.skipped.length > 0) {
                setModsPresent(true);
            }
            // Drop entries that were just updated (or turned out current) from
            // the update banner. Download results are keyed by mod name.
            const handled = new Set([...results.successful, ...results.skipped]);
            setUpdateCheck(prev => prev
                ? { ...prev, updates: prev.updates.filter(update => !handled.has(update.name)) }
                : prev);
        } catch (error) {
            console.error('Mod update failed:', error);
        } finally {
            setUpdatingMods(false);
            setDownloadProgress(null);
        }
    };

    return {
        availableMods,
        loadingMods,
        loadingMoreMods,
        modsError,
        hasMoreMods,
        totalModsCount,
        showAddModsModal,
        setShowAddModsModal,
        modProviders,
        modProvider,
        setModProvider,
        searchQuery,
        setSearchQuery,
        debouncedSearch,
        downloading,
        downloadProgress,
        downloadResults,
        setDownloadResults,
        modsPresent,
        allModsDownloaded,
        checkingUpdates,
        updateCheck,
        setUpdateCheck,
        updatingMods,
        checkForUpdates,
        applyModUpdates,
        incompatibleMods,
        checkingCompatibilityIds,
        handleAddMod,
        handleRemoveMod,
        handleScroll,
        handleCloseModsModal,
        downloadModList,
    };
}
