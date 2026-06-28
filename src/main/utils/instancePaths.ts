import { app } from 'electron';
import path from 'path';
import fs from 'fs';

/**
 * Per-modpack instance directories under userData/instances.
 *
 * Instances are keyed by game id AND name so two packs for different games that
 * share a name don't collide (which previously deployed e.g. R.E.P.O BepInEx
 * mods into Stardew's Mods folder). Minecraft (game 1) keeps the legacy flat
 * path because its instance dir holds real game data (saves, worlds, configs);
 * other games stage downloads under `.games/<id>/`. The `.games` segment can't
 * clash with a real pack name because validateSafeName strips '.' characters.
 */

const instancesRoot = (): string => path.join(app.getPath('userData'), 'instances');

export function getModpackInstanceDir(gameId: number, safeName: string): string {
    return gameId === 1
        ? path.join(instancesRoot(), safeName)
        : path.join(instancesRoot(), '.games', String(gameId), safeName);
}

export function getModpackModsDir(gameId: number, safeName: string): string {
    return path.join(getModpackInstanceDir(gameId, safeName), 'mods');
}

/**
 * Removes every instance directory for a modpack name across all games. Used on
 * delete, where the game id isn't known: the legacy path plus each `.games/<id>`
 * namespace are cleaned.
 */
export function removeInstanceDirsForName(safeName: string): void {
    const root = instancesRoot();
    const candidates = [path.join(root, safeName)];

    const gamesRoot = path.join(root, '.games');
    try {
        for (const entry of fs.readdirSync(gamesRoot, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                candidates.push(path.join(gamesRoot, entry.name, safeName));
            }
        }
    } catch { /* no namespaced instances yet */ }

    for (const dir of candidates) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}
