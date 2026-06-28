import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { getAllModsForGame, getModsByIds } from '../database/database.js';
import { filterGamesForPlatform, filterVerifiedGames, getModProviders } from '../../config/games.js';
import { buildDefaultGameList } from '../utils/gameCatalog.js';
import { callBackendWithAuth, getBackendApiBaseUrl } from '../backend-client.js';
import type { GameType, ModProviderId, ModProviderOption } from '../../types/sharedTypes.js';

/** Games / mods catalog IPC: game list, public fallback list, mod search, mods by id. */

// The game catalog is static (built from src/config/games.ts); there is no
// longer a `games` collection. Every path resolves to this list, restricted to
// games supported on the current desktop platform (so macOS only sees
// Mac-compatible games).
function getPlatformGames(): GameType[] {
    return filterGamesForPlatform(buildDefaultGameList(), process.platform);
}

export function registerGamesHandlers(): void {
    ipcMain.handle('getAllGames', async (_e: IpcMainInvokeEvent, token: string) => {
        const backendBaseUrl = getBackendApiBaseUrl();

        if (backendBaseUrl) {
            try {
                const response = await callBackendWithAuth({
                    method: 'GET',
                    path: '/games',
                    token,
                });

                if (response && response.status === 200 && Array.isArray(response.data?.games) && response.data.games.length > 0) {
                    // Drop unverified games even if a (stale) backend returns them,
                    // then restrict to the current platform.
                    const backendGames = filterVerifiedGames(response.data.games as GameType[]);
                    return filterGamesForPlatform(backendGames, process.platform);
                }
            } catch {
                // Fall through to the static platform list below.
            }
        }

        return getPlatformGames();
    });

    ipcMain.handle('getPublicGames', async (): Promise<GameType[]> => {
        return getPlatformGames();
    });

    // The mod sources a game can be browsed from (drives the Add Mods source
    // picker, e.g. Minecraft → Modrinth + CurseForge).
    ipcMain.handle('getModProviders', async (_e: IpcMainInvokeEvent, gameId: number): Promise<ModProviderOption[]> => {
        return getModProviders(gameId);
    });

    ipcMain.handle('getAllModsForGame', async (_e: IpcMainInvokeEvent, token: string, gameId: number, provider?: ModProviderId, searchFilter?: string, pageIndex?: number, gameVersion?: string, modLoader?: string) => {
        const backendBaseUrl = getBackendApiBaseUrl();
        if (backendBaseUrl) {
            try {
                const response = await callBackendWithAuth({
                    method: 'GET',
                    path: '/mods/search',
                    token,
                    params: {
                        gameId,
                        ...(provider ? { provider } : {}),
                        ...(searchFilter ? { searchFilter } : {}),
                        ...(typeof pageIndex === 'number' ? { pageIndex } : {}),
                        ...(gameVersion ? { gameVersion } : {}),
                        ...(modLoader ? { modLoader } : {}),
                    },
                });

                if (!response || response.status !== 200) {
                    return { mods: [], hasMore: false, totalCount: 0 };
                }

                return {
                    mods: Array.isArray(response.data?.mods) ? response.data.mods : [],
                    hasMore: !!response.data?.hasMore,
                    totalCount: Number(response.data?.totalCount ?? 0),
                };
            } catch {
                return { mods: [], hasMore: false, totalCount: 0 };
            }
        }

        return await getAllModsForGame(token, gameId, provider, searchFilter, pageIndex, gameVersion, modLoader);
    });

    ipcMain.handle('getModsByIds', async (_e: IpcMainInvokeEvent, token: string, modIds: string[]) => {
        const backendBaseUrl = getBackendApiBaseUrl();
        if (backendBaseUrl) {
            try {
                const response = await callBackendWithAuth({
                    method: 'POST',
                    path: '/mods/by-ids',
                    token,
                    data: { modIds },
                });

                if (!response || response.status !== 200 || !Array.isArray(response.data?.mods)) {
                    return [];
                }

                return response.data.mods;
            } catch {
                return [];
            }
        }

        return await getModsByIds(token, modIds);
    });
}
