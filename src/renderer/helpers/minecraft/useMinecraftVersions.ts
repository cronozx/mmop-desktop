import { useEffect, useState } from "react";
import { ModLoaderType } from "../../../types/sharedTypes";

/**
 * Fetches available Minecraft versions when enabled.
 */
export function useMinecraftVersions(enabled: boolean) {
    const [mcVersions, setMcVersions] = useState<string[]>([]);
    const [loadingMcVersions, setLoadingMcVersions] = useState(false);

    useEffect(() => {
        if (!enabled) return;
        setLoadingMcVersions(true);
        window.db.getMinecraftVersions()
            .then(setMcVersions)
            .catch(() => {})
            .finally(() => setLoadingMcVersions(false));
    }, [enabled]);

    return { mcVersions, loadingMcVersions };
}

/**
 * Fetches loader versions for a given mod loader and Minecraft version.
 * Clears versions when inputs change and re-fetches.
 */
export function useLoaderVersions(modLoader: ModLoaderType | '', mcVersion: string) {
    const [loaderVersions, setLoaderVersions] = useState<string[]>([]);
    const [loadingLoaderVersions, setLoadingLoaderVersions] = useState(false);

    useEffect(() => {
        if (!mcVersion || !modLoader) return;
        setLoaderVersions([]);
        setLoadingLoaderVersions(true);
        window.db.getLoaderVersions(modLoader, mcVersion)
            .then(setLoaderVersions)
            .catch(() => {})
            .finally(() => setLoadingLoaderVersions(false));
    }, [mcVersion, modLoader]);

    return { loaderVersions, loadingLoaderVersions };
}

/**
 * Which loaders have a build for the given Minecraft version. Used to hide
 * loaders that don't work with the selected version. Returns all loaders while
 * loading / before a version is chosen, so nothing is hidden prematurely.
 */
export function useAvailableLoaders(mcVersion: string, enabled: boolean) {
    const [availableLoaders, setAvailableLoaders] = useState<string[] | null>(null);

    useEffect(() => {
        if (!enabled || !mcVersion) {
            setAvailableLoaders(null);
            return;
        }
        let cancelled = false;
        window.db.getAvailableLoaders(mcVersion)
            .then((loaders) => { if (!cancelled) setAvailableLoaders(loaders); })
            .catch(() => { if (!cancelled) setAvailableLoaders(null); });
        return () => { cancelled = true; };
    }, [mcVersion, enabled]);

    return { availableLoaders };
}
