import { app, dialog, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import axios from 'axios';
import {
    createModpack,
    getUsersModpacks,
    updateModpack,
    deleteModpack,
} from '../database/database.js';
import { callBackendWithAuth, getBackendApiBaseUrl } from '../backend-client.js';
import {
    isValid,
    gameIdSchema,
    modpackCreateInputSchema,
    modpackUpdateInputSchema,
    validateSafeName,
} from '../validation.js';
import { removeInstanceDirsForName } from '../utils/instancePaths.js';
import { parseModpackArchive, ModpackImportError } from '../services/modpackImport.js';
import { modrinthAPI } from '../services/modrinth.js';
import { curseforgeAPI } from '../services/curseforge.js';
import { getGameDefinition, getModpackProviders } from '../../config/games.js';
import type { ModpackImportFileResult, ModpackType, ProviderModpackSearchResult, ModpackProviderId, ModpackProviderOption } from '../../types/sharedTypes.js';

const MAX_MRPACK_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MODRINTH_PROJECT_ID_PATTERN = /^[\w-]{1,64}$/;
const CURSEFORGE_PROJECT_ID_PATTERN = /^\d{1,12}$/;

/** Modpack CRUD + import IPC. */

export function registerModpackHandlers(): void {
    ipcMain.handle('createModpack', async (_e: IpcMainInvokeEvent, token: string, modpack: ModpackType) => {
        if (!isValid(modpackCreateInputSchema, modpack)) {
            return null;
        }

        const backendBaseUrl = getBackendApiBaseUrl();
        if (backendBaseUrl) {
            try {
                const response = await callBackendWithAuth({
                    method: 'POST',
                    path: '/modpacks',
                    token,
                    data: { modpack },
                });

                // Surface entitlement/limit rejections (402) so the UI can show
                // an upgrade prompt instead of a generic failure.
                if (response && response.status === 402) {
                    return {
                        error: typeof response.data?.error === 'string' ? response.data.error : 'Upgrade required.',
                        code: typeof response.data?.code === 'string' ? response.data.code : 'upgrade_required',
                    };
                }

                if (!response || response.status !== 201 || !response.data?.modpack) {
                    return null;
                }

                return response.data.modpack;
            } catch {
                return null;
            }
        }

        return await createModpack(token, modpack)
    });

    ipcMain.handle('getAllModpacks', async (_e: IpcMainInvokeEvent, token: string) => {
        const backendBaseUrl = getBackendApiBaseUrl();
        if (backendBaseUrl) {
            try {
                const allModpacks: ModpackType[] = [];
                let page = 0;
                const limit = 200;

                while (true) {
                    const response = await callBackendWithAuth({
                        method: 'GET',
                        path: '/modpacks',
                        token,
                        params: { page, limit },
                    });

                    if (!response || response.status !== 200 || !Array.isArray(response.data?.modpacks)) {
                        break;
                    }

                    allModpacks.push(...(response.data.modpacks as ModpackType[]));

                    if (!response.data?.hasMore) {
                        break;
                    }

                    page += 1;
                }

                return allModpacks;
            } catch {
                return [];
            }
        }

        return await getUsersModpacks(token);
    });

    ipcMain.handle('updateModpack', async (_e: IpcMainInvokeEvent, token: string, updatedModpack: ModpackType) => {
        const parsed = modpackUpdateInputSchema.safeParse(updatedModpack);
        if (!parsed.success) {
            console.warn('[updateModpack] local validation rejected payload:', JSON.stringify(parsed.error.issues));
            return false;
        }

        const backendBaseUrl = getBackendApiBaseUrl();
        if (backendBaseUrl) {
            try {
                const modpackId = String(updatedModpack?._id ?? '');
                if (!modpackId) {
                    console.warn('[updateModpack] missing modpack _id; cannot update via backend');
                    return false;
                }

                const response = await callBackendWithAuth({
                    method: 'PUT',
                    path: `/modpacks/${encodeURIComponent(modpackId)}`,
                    token,
                    data: { updatedModpack },
                });

                const ok = !!response && response.status === 200 && !!response.data?.success;
                if (!ok) {
                    console.warn('[updateModpack] backend update failed:', response?.status, JSON.stringify(response?.data));
                }
                return ok;
            } catch (error) {
                console.warn('[updateModpack] backend request threw:', (error as Error).message);
                return false;
            }
        }

        return await updateModpack(token, updatedModpack);
    });

    ipcMain.handle('deleteModpack', async (_e: IpcMainInvokeEvent, token: string, modpackId: string) => {
        let deletedModpackName: string | false = false;

        const backendBaseUrl = getBackendApiBaseUrl();
        if (backendBaseUrl) {
            try {
                const response = await callBackendWithAuth({
                    method: 'DELETE',
                    path: `/modpacks/${encodeURIComponent(modpackId)}`,
                    token,
                });

                if (response && response.status === 200 && response.data?.success && typeof response.data?.name === 'string') {
                    deletedModpackName = response.data.name;
                }
            } catch {
                deletedModpackName = false;
            }
        } else {
            deletedModpackName = await deleteModpack(token, modpackId);
        }

        if (deletedModpackName) {
            const safeName = validateSafeName(deletedModpackName);
            if (safeName) {
                // The game id isn't known here, so clean the name's instance dir
                // across every game namespace (and the legacy Minecraft path).
                removeInstanceDirsForName(safeName);
            }
        }

        return !!deletedModpackName;
    });

    // Opens a file picker, parses the archive, and returns a normalized draft.
    // No database write happens here — the renderer reuses createModpack.
    ipcMain.handle('importModpackFile', async (): Promise<ModpackImportFileResult> => {
        const openResult = await dialog.showOpenDialog({
            title: 'Import Modpack',
            properties: ['openFile'],
            filters: [{ name: 'Modpacks (.mrpack, .zip)', extensions: ['mrpack', 'zip'] }],
        });
        if (openResult.canceled || openResult.filePaths.length === 0) {
            return { success: false, canceled: true };
        }

        try {
            const draft = await parseModpackArchive(openResult.filePaths[0]);
            return { success: true, draft };
        } catch (error) {
            if (!(error instanceof ModpackImportError)) {
                console.error('Modpack import failed:', error);
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to read modpack file.',
            };
        }
    });

    // List the modpack browse sources available for a game (e.g. Minecraft offers
    // both Modrinth and CurseForge). Drives the source picker in the browse modal.
    ipcMain.handle('getModpackProviders', async (_e: IpcMainInvokeEvent, gameId: number): Promise<ModpackProviderOption[]> => {
        if (!isValid(gameIdSchema, gameId)) {
            return [];
        }
        return getModpackProviders(gameId);
    });

    // Browse existing modpacks for a game from a chosen source. The provider must
    // be one the game supports (see getModpackProviders); when omitted/invalid we
    // fall back to the game's default (first available). The importer below turns
    // the chosen pack into a local draft.
    ipcMain.handle('searchProviderModpacks', async (_e: IpcMainInvokeEvent, gameId: number, provider?: ModpackProviderId, searchFilter?: string, pageIndex?: number, gameVersion?: string): Promise<ProviderModpackSearchResult> => {
        const empty: ProviderModpackSearchResult = { modpacks: [], hasMore: false, totalCount: 0 };
        if (!isValid(gameIdSchema, gameId)) {
            return empty;
        }
        const available = getModpackProviders(gameId);
        const chosen = available.find((p) => p.id === provider)?.id ?? available[0]?.id;
        if (!chosen) {
            return empty;
        }
        const def = getGameDefinition(gameId);
        const query = typeof searchFilter === 'string' ? searchFilter.slice(0, 200) : undefined;
        const page = Number.isInteger(pageIndex) && (pageIndex as number) >= 0 ? (pageIndex as number) : 0;
        const version = typeof gameVersion === 'string' && gameVersion.trim() ? gameVersion.trim() : undefined;
        try {
            if (chosen === 'curseforge' && def?.curseForgeGameId !== undefined && def.curseForgeModpackClassId !== undefined) {
                return await curseforgeAPI.searchModpacks(def.curseForgeGameId, def.curseForgeModpackClassId, query, page, 30, version);
            }
            if (chosen === 'modrinth') {
                return await modrinthAPI.searchModpacks(query, page, 30, version);
            }
            return empty;
        } catch (error) {
            console.error('searchProviderModpacks failed:', error);
            return empty;
        }
    });

    // Import an existing provider modpack: download its archive to a temp file,
    // parse it into a draft (reusing the file import pipeline), then clean up. The
    // renderer feeds the draft into createModpack, exactly like file import. The
    // provider must be one the game supports.
    ipcMain.handle('importProviderModpack', async (_e: IpcMainInvokeEvent, gameId: number, provider: ModpackProviderId, modpackId: string): Promise<ModpackImportFileResult> => {
        if (!isValid(gameIdSchema, gameId)) {
            return { success: false, error: 'Invalid game.' };
        }
        const chosen = getModpackProviders(gameId).find((p) => p.id === provider)?.id;
        if (!chosen) {
            return { success: false, error: 'Unsupported modpack source for this game.' };
        }
        const useCurseForge = chosen === 'curseforge';
        const idPattern = useCurseForge ? CURSEFORGE_PROJECT_ID_PATTERN : MODRINTH_PROJECT_ID_PATTERN;
        if (typeof modpackId !== 'string' || !idPattern.test(modpackId)) {
            return { success: false, error: 'Invalid modpack id.' };
        }

        let tempPath: string | null = null;
        try {
            const file = useCurseForge
                ? await curseforgeAPI.getModpackDownload(modpackId)
                : await modrinthAPI.getModpackFileUrl(modpackId);
            if (!file) {
                return { success: false, error: 'That modpack has no downloadable file.' };
            }

            const response = await axios.get<ArrayBuffer>(file.url, {
                responseType: 'arraybuffer',
                timeout: 60000,
                maxContentLength: MAX_MRPACK_DOWNLOAD_BYTES,
                maxBodyLength: MAX_MRPACK_DOWNLOAD_BYTES,
            });

            // parseModpackArchive detects the format from the archive contents
            // (modrinth.index.json vs CurseForge manifest.json), so the temp file
            // extension is irrelevant.
            tempPath = path.join(app.getPath('temp'), `mmop-modpack-${randomUUID()}.zip`);
            fs.writeFileSync(tempPath, Buffer.from(response.data));

            const draft = await parseModpackArchive(tempPath);
            return { success: true, draft };
        } catch (error) {
            if (!(error instanceof ModpackImportError)) {
                console.error('Provider modpack import failed:', error);
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to import that modpack.',
            };
        } finally {
            if (tempPath) {
                try { fs.rmSync(tempPath, { force: true }); } catch { /* ignore cleanup failure */ }
            }
        }
    });
}
