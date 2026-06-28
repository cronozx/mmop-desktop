import { useCallback, useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { ModpackType, ModType } from "../../types/sharedTypes";

export interface UseModpackDataResult {
    modpack: ModpackType;
    setModpack: Dispatch<SetStateAction<ModpackType>>;
    loading: boolean;
    setLoading: Dispatch<SetStateAction<boolean>>;
    currentMods: string[];
    setCurrentMods: Dispatch<SetStateAction<string[]>>;
    currentModDetails: ModType[];
    /** Re-fetch the modpack from the backend (used for live refresh). */
    refreshModpack: () => Promise<void>;
}

/**
 * Owns the modpack record, the editable list of mod ids, and the provider
 * details for those mods. Loads the freshest modpack from the backend on mount
 * (so we never work off stale location.state) and exposes `refreshModpack` for
 * live polling — which adopts server-side mod changes only when the user has no
 * unsaved edits, so in-progress work is never clobbered.
 */
export function useModpackData(initialModpack: ModpackType, token: string | null): UseModpackDataResult {
    const [modpack, setModpack] = useState<ModpackType>(initialModpack);
    const [loading, setLoading] = useState<boolean>(true);
    const [currentMods, setCurrentMods] = useState<string[]>([]);
    const [currentModDetails, setCurrentModDetails] = useState<ModType[]>([]);

    // Initial load: take the freshest record from the backend (avoiding stale
    // location.state) and seed the editable mod list from it.
    useEffect(() => {
        let cancelled = false;
        const seed = (pack: ModpackType) => {
            if (cancelled) return;
            setModpack(pack);
            setCurrentMods([...pack.mods]);
        };

        const init = async () => {
            try {
                if (token && initialModpack?._id) {
                    const all = await window.db.getAllModpacks(token);
                    const found = (Array.isArray(all) ? all : []).find((m) => m._id === initialModpack._id);
                    seed(found ?? initialModpack);
                } else if (initialModpack) {
                    seed(initialModpack);
                }
            } catch (_e) {
                if (initialModpack) seed(initialModpack);
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        void init();
        return () => { cancelled = true; };
    }, []);

    // Re-fetch the modpack for live refresh. Only adopt the server's mod list
    // when the working set has no unsaved edits (currentMods still matches the
    // saved mods); otherwise refresh just the record and keep the user's edits.
    const refreshModpack = useCallback(async () => {
        if (!token || !modpack?._id) return;
        try {
            const all = await window.db.getAllModpacks(token);
            const found = (Array.isArray(all) ? all : []).find((m) => m._id === modpack._id);
            if (!found) return;
            const clean = JSON.stringify(currentMods) === JSON.stringify(modpack.mods);
            setModpack(found);
            if (clean) setCurrentMods([...found.mods]);
        } catch (_e) {
            // Non-fatal; keep using current state.
        }
    }, [token, modpack, currentMods]);

    // Fetch current mod details from the provider when currentMods change
    useEffect(() => {
        const fetchCurrentModDetails = async () => {
            if (!currentMods || currentMods.length === 0) {
                setCurrentModDetails([]);
                return;
            }

            try {
                if (!token) {
                    return;
                }

                const modDetails = await window.db.getModsByIds(token, currentMods);
                setCurrentModDetails(modDetails);
            } catch (error) {
                console.error('Error fetching current mod details:', error);
            }
        };

        fetchCurrentModDetails();
    }, [currentMods]);

    return {
        modpack,
        setModpack,
        loading,
        setLoading,
        currentMods,
        setCurrentMods,
        currentModDetails,
        refreshModpack,
    };
}
