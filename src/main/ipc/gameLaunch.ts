import { ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import path from 'path';
import store from '../utils/store.js';
import { getModpackByNameForCurrentUser } from '../database/database.js';
import { getGameDefinition, supportsVersionAndLoaderSelection } from '../../config/games.js';
import { getErrorMessage } from '../utils/errors.js';
import {
    gameIdSchema,
    isValid,
    looseModLoaderNameSchema,
    validateSafeName,
    versionStringSchema,
} from '../validation.js';
import { isSmapiInstalledInDir } from '../services/smapiInstaller.js';
import {
    clampMemoryAllocationMb,
    ensureMinecraftVersionInstalled,
    ensureModpackInstanceDirectories,
    getLoaderVersionId,
    installMinecraftLoaderForModpack,
    launchMinecraftWithMclc,
} from './minecraft.js';
import {
    launchExecutable,
    resolveGameExecutable,
    resolveModdedLaunchTarget,
} from './gameExecutables.js';
import { applyModpackEnabledMods } from '../services/tmodloader.js';
import { getModpackModsDir } from '../utils/instancePaths.js';

/**
 * Launch dispatcher. Minecraft packs are installed/launched through MCLC (see
 * minecraft.ts); every other game launches its native executable (see
 * gameExecutables.ts), enforcing a mod loader (SMAPI / BepInEx) where one is
 * required so mods actually load.
 */

// Launch a Steam game through Steam itself so Steamworks initializes. For
// BepInEx games the doorstop (winhttp.dll) sitting next to the game .exe still
// injects on this launch, so mods load while the game runs as a normal Steam app.
const launchViaSteam = async (steamAppId: number): Promise<{ success: boolean; error?: string }> => {
    try {
        await shell.openExternal(`steam://rungameid/${steamAppId}`);
        return { success: true };
    } catch (error) {
        return { success: false, error: getErrorMessage(error, 'Failed to launch the game through Steam.') };
    }
};

export function registerGameLaunchHandlers(): void {
    ipcMain.handle('launchGame', async (_e: IpcMainInvokeEvent, gameId: number, modpackName: string, memoryAllocationMb?: number, launchConfig?: { minecraftVersion?: string; modLoader?: string; loaderVersion?: string; customJvmArgs?: string }) => {
        if (!isValid(gameIdSchema, gameId)) {
            return { success: false, error: 'Invalid game id.' };
        }

        try {
            const safeName = validateSafeName(modpackName);
            if (!safeName) return { success: false, error: 'Invalid modpack name' };
            const gameDir = ensureModpackInstanceDirectories(gameId, safeName);

            if (supportsVersionAndLoaderSelection(gameId)) {
                // Prefer the launch config supplied by the renderer (the source of
                // truth for the displayed pack). This is required under Auth0:
                // the main process can't decode the Auth0 token to look the pack
                // up locally. Fall back to the local DB lookup for older callers.
                const sanitizeLaunchConfig = (cfg?: { minecraftVersion?: string; modLoader?: string; loaderVersion?: string; customJvmArgs?: string }) => {
                    if (!cfg || !isValid(versionStringSchema, cfg.minecraftVersion ?? '')) return null;
                    const modLoader = isValid(looseModLoaderNameSchema, cfg.modLoader ?? '') ? cfg.modLoader : undefined;
                    const loaderVersion = isValid(versionStringSchema, cfg.loaderVersion ?? '') ? cfg.loaderVersion : undefined;
                    const customJvmArgs = typeof cfg.customJvmArgs === 'string' ? cfg.customJvmArgs.slice(0, 2000) : undefined;
                    return { minecraftVersion: cfg.minecraftVersion as string, modLoader, loaderVersion, customJvmArgs };
                };

                let mcConfig = sanitizeLaunchConfig(launchConfig);
                if (!mcConfig) {
                    const modpack = await getModpackByNameForCurrentUser(modpackName);
                    if (modpack?.minecraftVersion) {
                        mcConfig = { minecraftVersion: modpack.minecraftVersion, modLoader: modpack.modLoader, loaderVersion: modpack.loaderVersion, customJvmArgs: modpack.customJvmArgs };
                    }
                }

                if (mcConfig?.minecraftVersion) {
                    let customVersionId = mcConfig.minecraftVersion;

                    if (mcConfig.modLoader && mcConfig.loaderVersion) {
                        const installResult = await installMinecraftLoaderForModpack(mcConfig.modLoader, modpackName, mcConfig.minecraftVersion, mcConfig.loaderVersion);
                        if (!installResult.success) {
                            return {
                                success: false,
                                error: installResult.error ?? 'Minecraft files are not installed for this modpack.',
                            };
                        }
                        customVersionId = installResult.loaderVersionId ?? getLoaderVersionId(mcConfig.modLoader, mcConfig.minecraftVersion, mcConfig.loaderVersion);
                    } else {
                        // Vanilla modpack (no loader): make sure Minecraft itself is installed.
                        const vanillaResult = await ensureMinecraftVersionInstalled(mcConfig.minecraftVersion);
                        if (!vanillaResult.success) {
                            return { success: false, error: vanillaResult.error ?? 'Failed to install Minecraft.' };
                        }
                    }

                    const defaultMinecraftMemoryMb = clampMemoryAllocationMb(store.get('defaultMinecraftMemoryMb'));
                    const effectiveMemoryAllocationMb = clampMemoryAllocationMb(memoryAllocationMb) ?? defaultMinecraftMemoryMb;
                    const launcherResult = await launchMinecraftWithMclc({
                        minecraftVersion: mcConfig.minecraftVersion,
                        customVersionId,
                        gameDir,
                        memoryAllocationMb: effectiveMemoryAllocationMb,
                        customJvmArgs: mcConfig.customJvmArgs,
                    });
                    if (!launcherResult.success) {
                        return { success: false, error: launcherResult.error ?? 'Failed to launch Minecraft.', authMode: launcherResult.authMode };
                    }
                    return { success: true, authMode: launcherResult.authMode };
                }

                return { success: false, error: 'Missing Minecraft version configuration.' };
            }

            // Non-Minecraft games

            // Steam Workshop games (Terraria/tModLoader) launch through Steam by
            // app id; mods were already deployed into the per-user mod folder at
            // download time, so no local executable needs configuring here.
            const steamWorkshopDef = getGameDefinition(gameId);
            if (steamWorkshopDef?.steamWorkshopAppId) {
                // Make this modpack's mods the active set in tModLoader before
                // launching, so pressing Play swaps enabled.json to this pack
                // (and disables every other mod in the shared Mods folder).
                try {
                    applyModpackEnabledMods(getModpackModsDir(gameId, safeName));
                } catch (error) {
                    console.error('Failed to apply tModLoader enabled mods:', error);
                }

                const launchAppId = steamWorkshopDef.steamAppId ?? steamWorkshopDef.steamWorkshopAppId;
                const steamResult = await launchViaSteam(launchAppId);
                if (!steamResult.success) {
                    return { success: false, error: steamResult.error ?? 'Failed to launch the game through Steam.' };
                }
                return { success: true };
            }

            const exePath = await resolveGameExecutable(gameId, true);
            if (!exePath) return { success: false, error: 'No executable configured for this game.' };

            // Stardew Valley loads mods only through SMAPI. If it's missing, ask
            // the renderer to run the styled install modal and launch again,
            // rather than blocking here with a native dialog.
            if (gameId === 19 && !isSmapiInstalledInDir(path.dirname(exePath))) {
                return {
                    success: false,
                    needsSmapi: true,
                    error: 'Stardew Valley needs SMAPI to load mods.',
                };
            }

            // BepInEx (Thunderstore) games inject mods via an in-folder winhttp.dll
            // doorstop. Launch through Steam so Steamworks initializes (multiplayer,
            // rich presence) while the doorstop still injects BepInEx — a bare-exe
            // launch can run the game outside Steam. Resolving the executable above
            // also guarantees the mod files were deployed into the install folder.
            const gameDef = getGameDefinition(gameId);
            if (gameDef?.thunderstoreCommunity && gameDef.steamAppId) {
                const steamResult = await launchViaSteam(gameDef.steamAppId);
                if (!steamResult.success) {
                    return { success: false, error: steamResult.error ?? 'Failed to launch the game through Steam.' };
                }
                return { success: true };
            }

            const launchTarget = resolveModdedLaunchTarget(gameId, exePath);
            if ('error' in launchTarget) {
                return { success: false, error: launchTarget.error };
            }
            const launchResult = await launchExecutable(launchTarget.target);
            if (!launchResult.success) {
                return { success: false, error: launchResult.error ?? 'Failed to launch game.' };
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: (error as Error).message };
        }
    });
}
