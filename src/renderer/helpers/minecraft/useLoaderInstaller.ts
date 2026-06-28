import { useEffect, useState } from "react";
import { ModpackType } from "../../../types/sharedTypes";
import { resolveModpackLoader } from "./constants";
import { supportsVersionAndLoaderSelection } from "../../../config/games";
import { getErrorMessage } from "../../utils/errors";

export interface LoaderResult {
    success: boolean;
    step?: string;
    error?: string;
    profileId?: string;
    loaderVersionId?: string;
    profilesPath?: string;
}

/**
 * Auto-checks whether the modpack's mod loader is installed, and installs it on demand.
 * Only active for games that enable loader/version support and have a valid loader + version.
 */
export function useLoaderInstaller(modpack: ModpackType | null) {
    const [installingLoader, setInstallingLoader] = useState(false);
    const [loaderInstalled, setLoaderInstalled] = useState(true);
    const [loaderResult, setLoaderResult] = useState<LoaderResult | null>(null);

    useEffect(() => {
        if (!modpack || !supportsVersionAndLoaderSelection(modpack.gameID)) return;
        const { loader, version } = resolveModpackLoader(modpack);
        if (!modpack.minecraftVersion || !loader || !version) {
            setLoaderInstalled(false);
            return;
        }

        window.db.checkLoaderInstalled(loader, modpack.minecraftVersion, version).then(installed => {
            setLoaderInstalled(installed);
        });
    }, [modpack?.gameID, modpack?.minecraftVersion, modpack?.modLoader, modpack?.loaderVersion, modpack?.forgeVersion, modpack?.name]);

    const ensureLoaderInstalled = async (): Promise<LoaderResult> => {
        if (!modpack || !supportsVersionAndLoaderSelection(modpack.gameID)) {
            return { success: true };
        }

        const { loader, version } = resolveModpackLoader(modpack);

        // Vanilla modpack: nothing to install here, the main process installs
        // Minecraft itself during launch.
        if (modpack.minecraftVersion && !loader && !version) {
            return { success: true };
        }

        if (!modpack.minecraftVersion || !loader || !version) {
            const result: LoaderResult = {
                success: false,
                error: 'Missing Minecraft version or loader configuration.',
            };
            setLoaderInstalled(false);
            setLoaderResult(result);
            return result;
        }

        const alreadyInstalled = await window.db.checkLoaderInstalled(loader, modpack.minecraftVersion, version);
        if (alreadyInstalled) {
            setLoaderInstalled(true);
            return { success: true };
        }

        setInstallingLoader(true);
        try {
            const result = await window.db.installLoader(loader, modpack.name, modpack.minecraftVersion, version);
            setLoaderInstalled(result.success);
            setLoaderResult(result);
            return result;
        } catch (error) {
            const result: LoaderResult = {
                success: false,
                error: getErrorMessage(error) || 'Failed to install the mod loader.',
            };
            setLoaderInstalled(false);
            setLoaderResult(result);
            return result;
        } finally {
            setInstallingLoader(false);
        }
    };

    return {
        installingLoader,
        loaderInstalled,
        loaderResult,
        clearLoaderResult: () => setLoaderResult(null),
        ensureLoaderInstalled,
    };
}
