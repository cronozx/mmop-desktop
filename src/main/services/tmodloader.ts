import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * tModLoader (Terraria) integration shared by the download pipeline, the deploy
 * step, and the launch flow.
 *
 * tModLoader keeps locally-installed mods in a single per-user `Mods` folder and
 * decides which load from a `Mods/enabled.json` array of internal mod names. A
 * built/Workshop mod ships as `<InternalName>.tmod`, so the internal name is just
 * the file name without its extension.
 *
 * Steam Workshop `.tmod` files keep their real names on disk (those names aren't
 * derivable from a workshop id), so each modpack instance keeps a small manifest
 * mapping prefixed mod id → downloaded file name. Main-process only.
 */

/** Per-instance manifest file: prefixed mod id (`sw:<appId>/<id>`) → file name. */
export const STEAM_INSTANCE_MANIFEST = '.mmop-steam.json';

/** The per-user tModLoader Mods folder for the current platform. */
export function tModLoaderModsDir(): string {
    const home = os.homedir();
    if (process.platform === 'win32') {
        const documents = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Documents') : path.join(home, 'Documents');
        return path.join(documents, 'My Games', 'Terraria', 'tModLoader', 'Mods');
    }
    if (process.platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'Terraria', 'tModLoader', 'Mods');
    }
    return path.join(home, '.local', 'share', 'Terraria', 'tModLoader', 'Mods');
}

function manifestPath(instanceModsDir: string): string {
    return path.join(instanceModsDir, STEAM_INSTANCE_MANIFEST);
}

/** Reads a modpack instance's Steam manifest (id → downloaded file name). */
export function readSteamManifest(instanceModsDir: string): Record<string, string> {
    try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath(instanceModsDir), 'utf-8'));
        return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
    } catch {
        return {};
    }
}

/** Records the downloaded file name for a prefixed mod id in the instance manifest. */
export function writeSteamManifestEntry(instanceModsDir: string, rawId: string, fileName: string): void {
    const manifest = readSteamManifest(instanceModsDir);
    manifest[rawId] = fileName;
    try {
        fs.writeFileSync(manifestPath(instanceModsDir), JSON.stringify(manifest, null, 2), 'utf-8');
    } catch (error) {
        console.error('Failed to write Steam manifest:', error);
    }
}

/** The internal mod name tModLoader uses for a `.tmod` file (its base name). */
export function internalModName(tmodFileName: string): string {
    return tmodFileName.replace(/\.tmod$/i, '');
}

/**
 * Makes a modpack's mods the active set in tModLoader: writes `Mods/enabled.json`
 * to exactly the modpack's deployed mods, which disables every other mod in the
 * shared Mods folder. Called on launch so pressing Play swaps the enabled mods to
 * the chosen pack. Only mods whose `.tmod` is actually present are enabled
 * (so a not-yet-downloaded or removed mod is simply left off).
 */
export function applyModpackEnabledMods(instanceModsDir: string): { enabled: string[] } {
    const manifest = readSteamManifest(instanceModsDir);
    const modsDir = tModLoaderModsDir();

    const enabled: string[] = [];
    for (const fileName of Object.values(manifest)) {
        if (typeof fileName === 'string' && fs.existsSync(path.join(modsDir, fileName))) {
            enabled.push(internalModName(fileName));
        }
    }

    try {
        fs.mkdirSync(modsDir, { recursive: true });
        // tModLoader's enabled.json is a plain JSON array of internal mod names.
        fs.writeFileSync(path.join(modsDir, 'enabled.json'), JSON.stringify(enabled, null, '\t'), 'utf-8');
    } catch (error) {
        console.error('Failed to write tModLoader enabled.json:', error);
    }

    return { enabled };
}
