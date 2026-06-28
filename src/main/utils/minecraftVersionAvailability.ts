import { getErrorMessage } from './errors.js';

export type MinecraftVersionListEntry = {
    id: string;
};

export type MinecraftVersionList = {
    versions: MinecraftVersionListEntry[];
};

export type MinecraftVersionAvailabilityResult = {
    available: boolean;
    reason: 'available' | 'missing-version' | 'version-list-unavailable';
    error: string;
    resolvedVersionId?: string;
};

export async function checkMinecraftVersionAvailability(
    requestedVersion: string,
    getVersionList: () => Promise<MinecraftVersionList>
): Promise<MinecraftVersionAvailabilityResult> {
    const normalizedVersion = typeof requestedVersion === 'string' ? requestedVersion.trim() : '';

    if (!normalizedVersion) {
        return {
            available: false,
            reason: 'missing-version',
            error: 'No Minecraft version was selected.',
        };
    }

    try {
        const versionList = await getVersionList();
        const resolvedVersion = versionList.versions.find((version) => version.id === normalizedVersion);

        if (!resolvedVersion) {
            return {
                available: false,
                reason: 'missing-version',
                error: `Minecraft version ${normalizedVersion} is not available. Select a valid version from the list.`,
            };
        }

        return {
            available: true,
            reason: 'available',
            error: '',
            resolvedVersionId: resolvedVersion.id,
        };
    } catch (error) {
        return {
            available: false,
            reason: 'version-list-unavailable',
            error: getErrorMessage(error, 'Minecraft version list could not be loaded.'),
        };
    }
}