import { app, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import path from 'path';
import fs from 'fs';
import type { SpawnOptions } from 'child_process';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { launch as xmclLaunch, Version as XmclVersion, getPlatform, DEFAULT_EXTRA_JVM_ARGS } from '@xmcl/core';
import type { LaunchOption } from '@xmcl/core';
import {
    getVersionList,
    getPotentialJavaLocations,
    getForgeVersionList,
    getLoaderArtifactListFor,
    getQuiltLoaderVersionsByMinecraft,
    installForge,
    install as installVanillaMinecraft,
    installDependencies,
    installFabric,
    installQuiltVersion,
    installNeoForged,
    fetchJavaRuntimeManifest,
    installJavaRuntimeTask,
} from '@xmcl/installer';
import { getUserDataFromToken as getStoredUserDataFromToken } from '../database/database.js';
import store from '../utils/store.js';
import {
    finiteNumberSchema,
    isValid,
    loaderInstallParamsSchema,
    validateSafeName,
    versionStringSchema,
} from '../validation.js';
import { getMinecraftSession } from '../services/minecraftAuth.js';
import { getErrorMessage } from '../utils/errors.js';
import { getModpackInstanceDir } from '../utils/instancePaths.js';
import { supportsVersionAndLoaderSelection } from '../../config/games.js';

/**
 * Minecraft IPC: xmcl-based vanilla/loader install and MCLC launch, loader and
 * version lists, and Java runtime management. Non-Minecraft concerns live in
 * sibling modules: game executable detection/launch (gameExecutables.ts), the
 * launch dispatcher (gameLaunch.ts), and mod download/deploy (modManagement.ts).
 * Several helpers here are exported for the launch dispatcher.
 */

// Minecraft instances are launched in-place by MCLC, so they get the full
// Minecraft game-directory tree. Other games stage only downloaded mod files
// (which are then deployed into the real game folder), so they need just `mods`.
const MINECRAFT_INSTANCE_DIRS = ['mods', 'config', 'saves', 'resourcepacks', 'shaderpacks', 'screenshots', 'crash-reports'];
const DEFAULT_INSTANCE_DIRS = ['mods'];

// ── Generic helpers ─────────────────────────────────────────────────────────

const dedupeCandidates = (candidates: Array<string | null | undefined>): string[] => {
    const normalized = candidates
        .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
        .map((candidate) => candidate.trim());
    return Array.from(new Set(normalized));
};

// Sort loader/version strings newest → oldest by comparing their numeric
// segments (handles "47.2.20", "0.15.7", "21.1.50", "1.20.1-47.2.20", …).
const sortVersionsDesc = (versions: string[]): string[] => {
    const segments = (version: string): number[] =>
        version.split(/[^0-9]+/).filter((part) => part.length > 0).map((part) => Number(part));
    return [...versions].sort((a, b) => {
        const pa = segments(a);
        const pb = segments(b);
        const length = Math.max(pa.length, pb.length);
        for (let i = 0; i < length; i += 1) {
            const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
            if (diff !== 0) return diff;
        }
        return 0;
    });
};

// Loader versions available for a Minecraft version, newest → oldest. Returns []
// when the loader has no build for that MC version (used to gate the loader UI).
const fetchLoaderVersions = async (modLoader: string, mcVersion: string): Promise<string[]> => {
    try {
        switch (modLoader) {
            case 'forge': {
                const forgeList = await getForgeVersionList({ minecraft: mcVersion });
                const versions = forgeList.versions.map((version) => version.version);
                return sortVersionsDesc(dedupeCandidates(versions));
            }
            case 'neoforge': {
                const res = await axios.get('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge', {
                    headers: { 'User-Agent': 'MMOP/1.0' }, timeout: 10000,
                });
                // NeoForge versions look like 21.1.x for MC 1.21.1.
                const allVersions: string[] = res.data.versions ?? [];
                const mcParts = mcVersion.split('.');
                const neoPrefix = mcParts.length >= 2 ? `${mcParts[1]}.${mcParts[2] ?? '0'}` : '';
                const filtered = allVersions.filter((v) => v.startsWith(neoPrefix + '.'));
                return sortVersionsDesc(filtered).slice(0, 20);
            }
            case 'fabric': {
                const artifacts = await getLoaderArtifactListFor(mcVersion);
                // Fabric flags only the single newest loader "stable"; list all,
                // preferring proper releases over beta/rc builds.
                const all = dedupeCandidates(artifacts.map((artifact) => artifact.loader.version));
                const releases = all.filter((version) => !/-(beta|rc|alpha|pre|snapshot)/i.test(version));
                return sortVersionsDesc(releases.length > 0 ? releases : all).slice(0, 20);
            }
            case 'quilt': {
                const artifacts = await getQuiltLoaderVersionsByMinecraft({ minecraftVersion: mcVersion });
                // Quilt's meta never marks versions "stable"; same handling as Fabric.
                const all = dedupeCandidates(artifacts.map((artifact) => artifact.loader.version));
                const releases = all.filter((version) => !/-(beta|rc|alpha|pre|snapshot)/i.test(version));
                return sortVersionsDesc(releases.length > 0 ? releases : all).slice(0, 20);
            }
            default:
                return [];
        }
    } catch {
        return [];
    }
};

// ── Minecraft install / launch helpers ──────────────────────────────────────
// Keep Minecraft runtime/assets/version installs under MMOP-managed storage.
const getMcDir = () => path.join(app.getPath('userData'), 'minecraft');

const cleanForgeBuild = (mcVersion: string, forgeVersion: string) =>
    forgeVersion.startsWith(`${mcVersion}-`) ? forgeVersion.slice(mcVersion.length + 1) : forgeVersion;

// Build the version ID that appears in .minecraft/versions/
export const getLoaderVersionId = (loader: string, mcVersion: string, loaderVersion: string): string => {
    switch (loader) {
        case 'forge': {
            const clean = cleanForgeBuild(mcVersion, loaderVersion);
            return `${mcVersion}-forge-${clean}`;
        }
        case 'neoforge':
            return `neoforge-${loaderVersion}`;
        case 'fabric':
            return `fabric-loader-${loaderVersion}-${mcVersion}`;
        case 'quilt':
            return `quilt-loader-${loaderVersion}-${mcVersion}`;
        default:
            return `${mcVersion}-${loader}-${loaderVersion}`;
    }
};

const toLauncherSafeProfileId = (name: string): string => {
    const sanitized = name
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9_-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^[-_]+|[-_]+$/g, '');
    return `mmop-${sanitized || randomUUID().slice(0, 8)}`;
};

export const ensureModpackInstanceDirectories = (gameId: number, safeName: string): string => {
    const gameDir = getModpackInstanceDir(gameId, safeName);
    const dirs = supportsVersionAndLoaderSelection(gameId) ? MINECRAFT_INSTANCE_DIRS : DEFAULT_INSTANCE_DIRS;
    for (const dir of dirs) {
        fs.mkdirSync(path.join(gameDir, dir), { recursive: true });
    }
    return gameDir;
};

const toOfflineMinecraftPlayerName = (value: string | undefined): string => {
    const base = (value ?? '').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 16);
    if (base.length > 0) {
        return base;
    }
    return `MMOP_${randomUUID().slice(0, 8)}`;
};

const javaBinaryName = process.platform === 'win32' ? 'java.exe' : 'java';

// Recursively look for bin/java under a runtime directory. Mojang's runtime
// layout differs per platform (macOS nests it inside jre.bundle/Contents/Home).
const findJavaExecutableUnder = (rootDir: string, depth = 6): string | null => {
    if (depth < 0 || !fs.existsSync(rootDir)) {
        return null;
    }

    const directCandidate = path.join(rootDir, 'bin', javaBinaryName);
    if (fs.existsSync(directCandidate)) {
        return directCandidate;
    }

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(rootDir, { withFileTypes: true });
    } catch {
        return null;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const found = findJavaExecutableUnder(path.join(rootDir, entry.name), depth - 1);
        if (found) {
            return found;
        }
    }

    return null;
};

const getJavaComponentForVersion = async (mcDir: string, versionId: string): Promise<string> => {
    try {
        const resolved = await XmclVersion.parse(mcDir, versionId);
        const component = (resolved as { javaVersion?: { component?: unknown } })?.javaVersion?.component;
        if (typeof component === 'string' && component.length > 0) {
            return component;
        }
    } catch {
        // Fall through to a sensible default below.
    }
    return 'java-runtime-gamma';
};

// Make sure a Mojang Java runtime suitable for the given version exists under
// <mcDir>/runtime, downloading it if necessary. Falls back to system Java.
const ensureJavaRuntimeForVersion = async (mcDir: string, versionId: string): Promise<string> => {
    const component = await getJavaComponentForVersion(mcDir, versionId);
    const componentDir = path.join(mcDir, 'runtime', component);

    const existing = findJavaExecutableUnder(componentDir);
    if (existing) {
        return existing;
    }

    try {
        let manifest;
        try {
            manifest = await fetchJavaRuntimeManifest({ target: component });
        } catch (error) {
            // Apple Silicon: Mojang doesn't publish some runtimes (notably
            // jre-legacy, used by older Minecraft versions) for mac-os-arm64,
            // which makes the lookup throw. Retry against the x64 manifest,
            // which runs fine under Rosetta 2.
            const platform = getPlatform();
            if (platform.name === 'osx' && platform.arch !== 'x64') {
                manifest = await fetchJavaRuntimeManifest({ target: component, platform: { ...platform, arch: 'x64' } });
            } else {
                throw error;
            }
        }
        await installJavaRuntimeTask({ manifest, destination: componentDir }).startAndWait();
        const installed = findJavaExecutableUnder(componentDir);
        if (installed) {
            if (process.platform !== 'win32') {
                try { fs.chmodSync(installed, 0o755); } catch {}
            }
            return installed;
        }
    } catch (error) {
        console.error(`Failed to install Java runtime ${component}:`, error);
    }

    return await resolveJavaExecutable(mcDir);
};

const resolveJavaExecutable = async (mcDir: string): Promise<string> => {
    const runtimeRoot = path.join(mcDir, 'runtime');
    const found = findJavaExecutableUnder(runtimeRoot, 8);
    if (found) {
        return found;
    }

    const potentialJavaLocations = await getPotentialJavaLocations();
    for (const candidate of potentialJavaLocations) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return 'java';
};

const isMinecraftVersionInstalled = (mcDir: string, versionId: string): boolean => {
    const versionDir = path.join(mcDir, 'versions', versionId);
    return fs.existsSync(path.join(versionDir, `${versionId}.json`));
};

// Download vanilla Minecraft (version json/jar, libraries, assets) into the
// MMOP-managed minecraft directory using the built-in installer.
export const ensureMinecraftVersionInstalled = async (minecraftVersion: string): Promise<{ success: boolean; error?: string }> => {
    const mcDir = getMcDir();

    try {
        if (!isMinecraftVersionInstalled(mcDir, minecraftVersion)) {
            const versionList = await getVersionList();
            const versionMeta = versionList.versions.find((version) => version.id === minecraftVersion);
            if (!versionMeta) {
                return { success: false, error: `Minecraft version ${minecraftVersion} was not found in the official version list.` };
            }

            console.log(`Installing Minecraft ${minecraftVersion}...`);
            await installVanillaMinecraft(versionMeta, mcDir);
        } else {
            // Repair any missing libraries/assets from interrupted installs.
            const resolved = await XmclVersion.parse(mcDir, minecraftVersion);
            await installDependencies(resolved);
        }

        return { success: true };
    } catch (e) {
        return { success: false, error: getErrorMessage(e, `Failed to install Minecraft ${minecraftVersion}.`) };
    }
};

const installLoaderVersion = async (modLoader: string, minecraftVersion: string, loaderVersion: string): Promise<{ success: boolean; error?: string; loaderVersionId?: string }> => {
    const mcDir = getMcDir();
    const predictedVersionId = getLoaderVersionId(modLoader, minecraftVersion, loaderVersion);

    try {
        let installedVersionId = predictedVersionId;

        if (!isMinecraftVersionInstalled(mcDir, predictedVersionId)) {
            console.log(`Installing ${modLoader} ${loaderVersion} for Minecraft ${minecraftVersion}...`);
            switch (modLoader) {
                case 'forge': {
                    const java = await ensureJavaRuntimeForVersion(mcDir, minecraftVersion);
                    installedVersionId = await installForge(
                        // installForge expects a full ForgeVersion entry; only these two
                        // fields are required to resolve and install the loader.
                        { mcversion: minecraftVersion, version: loaderVersion } as unknown as Parameters<typeof installForge>[0],
                        mcDir,
                        { java }
                    );
                    break;
                }
                case 'neoforge': {
                    const java = await ensureJavaRuntimeForVersion(mcDir, minecraftVersion);
                    installedVersionId = await installNeoForged('neoforge', loaderVersion, mcDir, { java });
                    break;
                }
                case 'fabric': {
                    installedVersionId = await installFabric({
                        minecraftVersion,
                        version: loaderVersion,
                        minecraft: mcDir,
                    });
                    break;
                }
                case 'quilt': {
                    installedVersionId = await installQuiltVersion({
                        minecraftVersion,
                        version: loaderVersion,
                        minecraft: mcDir,
                    });
                    break;
                }
                default:
                    return { success: false, error: `Unknown mod loader: ${modLoader}` };
            }
        }

        // Loader version jsons (especially Fabric/Quilt) declare extra libraries
        // that are not downloaded when the json is written. Resolve and fetch them.
        const resolvedLoader = await XmclVersion.parse(mcDir, installedVersionId);
        await installDependencies(resolvedLoader);

        return { success: true, loaderVersionId: installedVersionId };
    } catch (e) {
        return { success: false, error: getErrorMessage(e, `Failed to install ${modLoader} ${loaderVersion} for ${minecraftVersion}.`) };
    }
};

export const launchMinecraftWithMclc = async (options: {
    minecraftVersion: string;
    customVersionId: string;
    gameDir: string;
    memoryAllocationMb?: number;
    customJvmArgs?: string;
}): Promise<{ success: boolean; error?: string; authMode?: 'microsoft' | 'offline' }> => {
    try {
        const mcDir = getMcDir();
        const javaPath = await ensureJavaRuntimeForVersion(mcDir, options.customVersionId || options.minecraftVersion);
        const clampedMemoryMb = clampMemoryAllocationMb(options.memoryAllocationMb) ?? 4096;
        const minMemoryMb = Math.max(1024, Math.min(4096, Math.floor(clampedMemoryMb / 2)));

        // Prefer a real Microsoft/Minecraft session (auto-refreshed when
        // expired); fall back to the historical offline-mode launch.
        const session = await getMinecraftSession();
        let gameProfile: { name: string; id: string };
        let accessToken: string;
        let authMode: 'microsoft' | 'offline';

        if (session) {
            gameProfile = { name: session.profile.name, id: session.profile.id };
            accessToken = session.accessToken;
            authMode = 'microsoft';
        } else {
            const user = await getStoredUserDataFromToken();
            gameProfile = {
                name: toOfflineMinecraftPlayerName(user?.username),
                id: randomUUID().replace(/-/g, ''),
            };
            accessToken = '0';
            authMode = 'offline';
        }

        // Assemble JVM args. Passing extraJVMArgs to @xmcl replaces its
        // DEFAULT_EXTRA_JVM_ARGS, so whenever we add anything we re-include them
        // (dropping -Xmx2G since maxMemory is set below). User args come last so
        // they can override.
        const autoJvmArgs: string[] = [];

        // macOS: LWJGL3/GLFW must initialize on the process's first thread, or
        // the game crashes during init ("Cocoa: Failed to find service port for
        // display"). Some Forge manifests omit the vanilla macOS rule for it.
        if (process.platform === 'darwin') {
            autoJvmArgs.push('-XstartOnFirstThread');
        }

        // Forge's early loading window (FML) spins up GLFW on a side thread,
        // which clashes with -XstartOnFirstThread on macOS and is fragile on
        // older versions. Disable it for Minecraft < 1.17.
        const minorVersion = (() => {
            const match = /^1\.(\d+)/.exec(options.minecraftVersion);
            return match ? Number.parseInt(match[1], 10) : null;
        })();
        if (minorVersion !== null && minorVersion < 17) {
            autoJvmArgs.push('-Dfml.earlyprogresswindow=false');
        }

        const userJvmArgs = (options.customJvmArgs ?? '')
            .split(/\s+/)
            .map((arg) => arg.trim())
            .filter(Boolean);

        const extraJVMArgs = (autoJvmArgs.length > 0 || userJvmArgs.length > 0)
            ? [...DEFAULT_EXTRA_JVM_ARGS.filter((arg) => arg !== '-Xmx2G'), ...autoJvmArgs, ...userJvmArgs]
            : undefined;

        const launchOptions = {
            gamePath: options.gameDir,
            resourcePath: mcDir,
            javaPath,
            version: options.customVersionId || options.minecraftVersion,
            minMemory: minMemoryMb,
            maxMemory: clampedMemoryMb,
            gameProfile,
            accessToken,
            ...(extraJVMArgs ? { extraJVMArgs } : {}),
            // @xmcl/core's LaunchOption userType only accepts 'mojang' | 'legacy'
            // (no 'msa'), so it is intentionally omitted for both auth modes.
            extraExecOption: { detached: true } as SpawnOptions,
        };

        // launchOptions omits userType (see note above), so it does not structurally
        // match LaunchOption; the cast asserts the shape @xmcl/core's launch() expects.
        const child = await xmclLaunch(launchOptions as unknown as LaunchOption);
        if (!child) return { success: false, error: 'Minecraft process did not start.', authMode };

        // Surface the game's own output so crashes can be diagnosed from the
        // main-process terminal (the JVM exits after a crash, well after we've
        // already reported a successful spawn).
        try {
            child.stdout?.on('data', (chunk) => process.stdout.write(`[mc] ${chunk}`));
            child.stderr?.on('data', (chunk) => process.stderr.write(`[mc:err] ${chunk}`));
            child.on('exit', (code, signal) => console.log(`[mc] process exited code=${code} signal=${signal}`));
        } catch {}

        try { child.unref?.(); } catch {}
        return { success: true, authMode };
    } catch (error) {
        return { success: false, error: getErrorMessage(error, 'Failed to launch Minecraft.') };
    }
};

export const installMinecraftLoaderForModpack = async (modLoader: string, modpackName: string, minecraftVersion: string, loaderVersion: string): Promise<{ success: boolean; step?: string; error?: string; profileId?: string; loaderVersionId?: string; gameDir?: string; profilesPath?: string }> => {
    const safeName = validateSafeName(modpackName);
    if (!safeName) return { success: false, step: 'check', error: 'Invalid modpack name' };
    const gameDir = ensureModpackInstanceDirectories(1, safeName);

    const vanillaResult = await ensureMinecraftVersionInstalled(minecraftVersion);
    if (!vanillaResult.success) {
        return { success: false, step: 'minecraft', error: vanillaResult.error };
    }

    const loaderResult = await installLoaderVersion(modLoader, minecraftVersion, loaderVersion);
    if (!loaderResult.success || !loaderResult.loaderVersionId) {
        return { success: false, step: modLoader, error: loaderResult.error ?? `${modLoader} ${loaderVersion} is not available for ${minecraftVersion}` };
    }

    const profileId = toLauncherSafeProfileId(safeName);
    return { success: true, loaderVersionId: loaderResult.loaderVersionId, gameDir, profilesPath: gameDir, profileId };
};

export const clampMemoryAllocationMb = (memoryAllocationMb: unknown): number | undefined => {
    if (typeof memoryAllocationMb !== 'number' || !Number.isFinite(memoryAllocationMb)) {
        return undefined;
    }
    return Math.max(1024, Math.min(65536, Math.floor(memoryAllocationMb)));
};

// ── IPC registration ────────────────────────────────────────────────────────

export function registerMinecraftHandlers(): void {
    ipcMain.handle('getMinecraftVersions', async () => {
        try {
            const versionList = await getVersionList();
            return versionList.versions
                .filter((version) => version.type === 'release')
                .map((version) => version.id);
        } catch {
            return [];
        }
    });

    ipcMain.handle('getLoaderVersions', async (_e: IpcMainInvokeEvent, modLoader: string, mcVersion: string) => {
        if (!isValid(versionStringSchema, mcVersion)) {
            return [];
        }
        return fetchLoaderVersions(modLoader, mcVersion);
    });

    // Which loaders actually have a build for this Minecraft version. The UI uses
    // this to hide incompatible loaders (e.g. NeoForge on old MC), so a loader and
    // version can't be picked that conflict with the chosen Minecraft version.
    ipcMain.handle('getAvailableLoaders', async (_e: IpcMainInvokeEvent, mcVersion: string): Promise<string[]> => {
        if (!isValid(versionStringSchema, mcVersion)) {
            return [];
        }
        const loaders = ['forge', 'neoforge', 'fabric', 'quilt'];
        const results = await Promise.all(
            loaders.map(async (loader) => ({ loader, ok: (await fetchLoaderVersions(loader, mcVersion)).length > 0 })),
        );
        return results.filter((r) => r.ok).map((r) => r.loader);
    });

    ipcMain.handle('getDefaultMinecraftMemoryMb', () => {
        const value = store.get('defaultMinecraftMemoryMb');
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return null;
        }

        return Math.max(1024, Math.min(65536, Math.floor(value)));
    });

    ipcMain.handle('setDefaultMinecraftMemoryMb', async (_e: IpcMainInvokeEvent, memoryMb: number): Promise<{ success: boolean; error?: string; value?: number }> => {
        // Out-of-range finite values are clamped (existing contract), so only
        // finiteness is validated here.
        if (!isValid(finiteNumberSchema, memoryMb)) {
            return { success: false, error: 'Memory value must be a number.' };
        }

        const clamped = Math.max(1024, Math.min(65536, Math.floor(memoryMb)));
        store.set('defaultMinecraftMemoryMb', clamped);
        return { success: true, value: clamped };
    });

    // ── installLoader: validate the pre-installed loader and Minecraft assets ─────────
    ipcMain.handle('installLoader', async (_e: IpcMainInvokeEvent, modLoader: string, modpackName: string, minecraftVersion: string, loaderVersion: string) => {
        if (!isValid(loaderInstallParamsSchema, { modLoader, minecraftVersion, loaderVersion })) {
            return { success: false, step: 'check', error: 'Invalid mod loader or version.' };
        }

        try {
            return await installMinecraftLoaderForModpack(modLoader, modpackName, minecraftVersion, loaderVersion);
        } catch (e) {
            return { success: false, step: 'unknown', error: (e as Error).message };
        }
    });

    ipcMain.handle('checkLoaderInstalled', (_e: IpcMainInvokeEvent, modLoader: string, minecraftVersion: string, loaderVersion: string): boolean => {
        if (!isValid(loaderInstallParamsSchema, { modLoader, minecraftVersion, loaderVersion })) {
            return false;
        }

        const mcDir = getMcDir();
        const versionId = getLoaderVersionId(modLoader, minecraftVersion, loaderVersion);
        return fs.existsSync(path.join(mcDir, 'versions', versionId));
    });
}
