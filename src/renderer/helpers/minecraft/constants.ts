import { ModLoaderType } from "../../../types/sharedTypes";

export const LOADER_LABELS: Record<ModLoaderType, string> = {
    forge: 'Forge',
    neoforge: 'NeoForge',
    fabric: 'Fabric',
    quilt: 'Quilt',
};

export const LOADER_COLORS: Record<ModLoaderType, { bg: string; text: string }> = {
    forge: { bg: 'bg-orange-700/30', text: 'text-orange-400' },
    neoforge: { bg: 'bg-red-700/30', text: 'text-red-400' },
    fabric: { bg: 'bg-indigo-700/30', text: 'text-indigo-400' },
    quilt: { bg: 'bg-pink-700/30', text: 'text-pink-400' },
};

export const MOD_LOADERS: { value: ModLoaderType; label: string }[] = [
    { value: 'forge', label: 'Forge' },
    { value: 'neoforge', label: 'NeoForge' },
    { value: 'fabric', label: 'Fabric' },
    { value: 'quilt', label: 'Quilt' },
];

/**
 * Resolve a modpack's loader and version with backward-compat for the deprecated forgeVersion field.
 */
export function resolveModpackLoader(modpack: { modLoader?: ModLoaderType; loaderVersion?: string; forgeVersion?: string }): {
    loader?: ModLoaderType;
    version?: string;
} {
    const loader = modpack.modLoader ?? (modpack.forgeVersion ? 'forge' as ModLoaderType : undefined);
    const version = modpack.loaderVersion ?? modpack.forgeVersion;
    return { loader, version };
}
