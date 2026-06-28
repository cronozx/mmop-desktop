import type { GameType, ModpackProviderOption, ModProviderOption } from "../types/sharedTypes.js";

export type SupportedRuntimePlatform = 'darwin' | 'win32' | 'linux';
const ALL_DESKTOP_PLATFORMS: SupportedRuntimePlatform[] = ['darwin', 'win32', 'linux'];

// Keep this map explicit so UI only shows games supported by the current desktop platform.
const WINDOWS_ONLY: SupportedRuntimePlatform[] = ['win32'];

const SUPPORTED_PLATFORMS_BY_GAME_ID: Record<number, SupportedRuntimePlatform[]> = {
    1: ALL_DESKTOP_PLATFORMS, // Minecraft
    19: ALL_DESKTOP_PLATFORMS, // Stardew Valley (Win/Mac/Linux)
    20: ALL_DESKTOP_PLATFORMS, // Terraria (Win/Mac/Linux)
    34: WINDOWS_ONLY, // Lethal Company
    35: WINDOWS_ONLY, // R.E.P.O
    36: WINDOWS_ONLY, // Risk of Rain 2 (BepInEx winhttp doorstop is Windows-only)
};

export function normalizeRuntimePlatform(platform: string | undefined | null): SupportedRuntimePlatform {
    const normalized = String(platform ?? '').toLowerCase();
    // Check macOS first: the substring "win" appears inside "darwin", so a
    // naive includes('win') would misclassify macOS as Windows.
    if (normalized.includes('darwin') || normalized.includes('mac')) {
        return 'darwin';
    }

    if (normalized.includes('win')) {
        return 'win32';
    }

    return 'linux';
}

export function isGameSupportedOnPlatform(gameId: number, platform: string | undefined | null): boolean {
    const normalizedPlatform = normalizeRuntimePlatform(platform);
    const supportedPlatforms = SUPPORTED_PLATFORMS_BY_GAME_ID[gameId] ?? ALL_DESKTOP_PLATFORMS;
    return supportedPlatforms.includes(normalizedPlatform);
}

export function filterGamesForPlatform<T extends { id: number }>(games: T[], platform: string | undefined | null): T[] {
    return games.filter((game) => isGameSupportedOnPlatform(Number(game.id), platform));
}

export interface GameDefinition extends GameType {
    // Thunderstore community slug (e.g. "lethal-company"); set for BepInEx games
    // whose mods come from Thunderstore.
    thunderstoreCommunity?: string;
    // Steam Workshop app id whose published files are this game's mods (e.g.
    // tModLoader's 1281930 for Terraria); set for games whose mods come from the
    // Steam Workshop and are fetched via SteamCMD.
    steamWorkshopAppId?: number;
    // CurseForge game id (e.g. 432 = Minecraft, 669 = Stardew Valley); set for
    // games whose mods are fetched from the CurseForge Core API.
    curseForgeGameId?: number;
    // CurseForge "Modpacks" category classId (e.g. 4471 for Minecraft); set only
    // for games that have browsable CurseForge modpacks. Absent → no modpack
    // browsing for that game.
    curseForgeModpackClassId?: number;
    // Steam app id. For BepInEx games we launch via Steam (steam://rungameid)
    // so Steamworks initializes while the in-folder winhttp.dll doorstop injects.
    steamAppId?: number;
    features?: {
        // Enables Minecraft-specific version + loader selection UI.
        supportsVersionAndLoaderSelection?: boolean;
    };
    // Only verified games are surfaced anywhere in the app (see VERIFIED_GAME_IDS).
    verified: boolean;
}

interface GameSpecificSettings {
    features?: GameDefinition['features'];
}

const GAME_SPECIFIC_SETTINGS_BY_ID: Record<number, GameSpecificSettings> = {
    1: {
        // Minecraft uses the loader/version setup UI.
        features: {
            supportsVersionAndLoaderSelection: true,
        },
    },
};

// Games verified to work end-to-end (mod search, mod download, launch).
// Only verified games are shown in the app; unverified GAME_DEFINITIONS entries
// are kept (not deleted) so each can be re-introduced by adding its id here once
// it has been tested.
const VERIFIED_GAME_IDS = new Set<number>([
    1, // Minecraft
    19, // Stardew Valley
    20, // Terraria (Steam Workshop)
    34, // Lethal Company
    35, // R.E.P.O
    36, // Risk of Rain 2
]);

const createGameDefinition = (
    id: number,
    name: string,
    imagePath: string,
    opts: { curseForgeGameId?: number; curseForgeModpackClassId?: number; extensions?: string } = {}
): GameDefinition => {
    const specific = GAME_SPECIFIC_SETTINGS_BY_ID[id];
    return {
        id,
        name,
        modCount: 0,
        imagePath,
        acceptedTypes: {},
        extensions: opts.extensions ?? ".jar",
        description: `Create and manage ${name} modpacks.`,
        verified: VERIFIED_GAME_IDS.has(id),
        ...(opts.curseForgeGameId !== undefined && { curseForgeGameId: opts.curseForgeGameId }),
        ...(opts.curseForgeModpackClassId !== undefined && { curseForgeModpackClassId: opts.curseForgeModpackClassId }),
        ...(specific?.features !== undefined && { features: specific.features }),
    };
};

// Builds a definition for a Thunderstore (BepInEx) game. Mods come from the
// given Thunderstore community and art is supplied explicitly (a Steam header).
const createThunderstoreGameDefinition = (
    id: number,
    name: string,
    thunderstoreCommunity: string,
    imagePath: string,
    steamAppId?: number
): GameDefinition => ({
    id,
    name,
    modCount: 0,
    imagePath,
    acceptedTypes: {},
    extensions: ".zip",
    description: `Create and manage ${name} modpacks.`,
    thunderstoreCommunity,
    ...(steamAppId !== undefined && { steamAppId }),
    verified: VERIFIED_GAME_IDS.has(id),
});

// Builds a definition for a Steam Workshop game. Mods are the published files of
// the given Workshop app id (fetched via SteamCMD); `steamAppId` is what we
// launch through Steam (for Terraria/tModLoader these are the same id).
const createSteamGameDefinition = (
    id: number,
    name: string,
    steamWorkshopAppId: number,
    imagePath: string,
    extensions: string,
    steamAppId?: number
): GameDefinition => ({
    id,
    name,
    modCount: 0,
    imagePath,
    acceptedTypes: {},
    extensions,
    description: `Create and manage ${name} modpacks.`,
    steamWorkshopAppId,
    ...(steamAppId !== undefined && { steamAppId }),
    verified: VERIFIED_GAME_IDS.has(id),
});

// To add a new game, add one entry here.
// NOTE: only entries whose id is in VERIFIED_GAME_IDS are surfaced in the app.
export const GAME_DEFINITIONS: GameDefinition[] = [
    createGameDefinition(1, "Minecraft", "https://www.mmop.app/games/minecraft.png", { curseForgeGameId: 432, curseForgeModpackClassId: 4471 }),
    createGameDefinition(19, "Stardew Valley", "https://cdn.cloudflare.steamstatic.com/steam/apps/413150/header.jpg", { curseForgeGameId: 669, extensions: ".zip" }),
    // Terraria mods are tModLoader Workshop items (app 1281930); both fetch and
    // launch go through that app id.
    createSteamGameDefinition(20, "Terraria", 1281930, "https://cdn.cloudflare.steamstatic.com/steam/apps/105600/header.jpg", ".tmod", 1281930),
    createThunderstoreGameDefinition(
        34,
        "Lethal Company",
        "lethal-company",
        "https://cdn.cloudflare.steamstatic.com/steam/apps/1966720/header.jpg",
        1966720
    ),
    createThunderstoreGameDefinition(
        35,
        "R.E.P.O",
        "repo",
        "https://cdn.cloudflare.steamstatic.com/steam/apps/3241660/header.jpg",
        3241660
    ),
    createThunderstoreGameDefinition(
        36,
        "Risk of Rain 2",
        "riskofrain2",
        "https://cdn.cloudflare.steamstatic.com/steam/apps/632360/header.jpg",
        632360
    ),
];

export const GAME_DEFINITION_BY_ID: Record<number, GameDefinition> = Object.fromEntries(
    GAME_DEFINITIONS.map((game) => [game.id, game])
);

export function getGameDefinition(gameId: number): GameDefinition | undefined {
    return GAME_DEFINITION_BY_ID[gameId];
}

/** True when the game id maps to a definition that has been verified end-to-end. */
export function isGameVerified(gameId: number): boolean {
    return !!GAME_DEFINITION_BY_ID[gameId]?.verified;
}

/**
 * Keep only games whose id corresponds to a verified definition. This also
 * drops db-sourced game docs with no (verified) entry in GAME_DEFINITIONS, so
 * the Mongo `games` collection cannot re-introduce hidden games.
 */
export function filterVerifiedGames<T extends { id: number }>(games: T[]): T[] {
    return games.filter((game) => isGameVerified(Number(game.id)));
}

export function supportsVersionAndLoaderSelection(gameId?: number): boolean {
    if (gameId === undefined) {
        return false;
    }

    return !!GAME_DEFINITION_BY_ID[gameId]?.features?.supportsVersionAndLoaderSelection;
}

/**
 * Mod browse sources available for a game, in display order. Thunderstore and
 * Steam Workshop games have a single source; Minecraft offers both Modrinth and
 * CurseForge (Modrinth first, the default); a non-Minecraft CurseForge game
 * (e.g. Stardew) offers CurseForge. Mirrors the single-provider routing in
 * database.ts / data.ts, but lists every applicable source.
 */
export function getModProviders(gameId?: number): ModProviderOption[] {
    if (gameId === undefined) {
        return [];
    }
    const def = GAME_DEFINITION_BY_ID[gameId];
    if (def?.thunderstoreCommunity) {
        return [{ id: 'thunderstore', label: 'Thunderstore' }];
    }
    if (def?.steamWorkshopAppId !== undefined) {
        return [{ id: 'steam', label: 'Steam Workshop' }];
    }
    const providers: ModProviderOption[] = [];
    if (gameId === 1) {
        providers.push({ id: 'modrinth', label: 'Modrinth' });
    }
    if (def?.curseForgeGameId !== undefined) {
        providers.push({ id: 'curseforge', label: 'CurseForge' });
    }
    return providers;
}

/**
 * Modpack browse sources available for a game, in display order. A loader game
 * (Minecraft) offers Modrinth; a game with a CurseForge modpack class offers
 * CurseForge. Minecraft has both — Modrinth is listed first (the default).
 * Empty when the game has no browsable modpacks.
 */
export function getModpackProviders(gameId?: number): ModpackProviderOption[] {
    if (gameId === undefined) {
        return [];
    }
    const def = GAME_DEFINITION_BY_ID[gameId];
    const providers: ModpackProviderOption[] = [];
    if (supportsVersionAndLoaderSelection(gameId)) {
        providers.push({ id: 'modrinth', label: 'Modrinth' });
    }
    if (def?.curseForgeGameId !== undefined && def.curseForgeModpackClassId !== undefined) {
        providers.push({ id: 'curseforge', label: 'CurseForge' });
    }
    return providers;
}
