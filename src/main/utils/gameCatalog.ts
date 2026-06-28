import type { GameType } from '../../types/sharedTypes.js';
import { GAME_DEFINITIONS } from '../../config/games.js';

/**
 * Shared game-catalog helper used by the backend API (server/routes/data.ts)
 * and the main-process game-list IPC (src/main/ipc/games.ts).
 *
 * The catalog is fully static (there is no `games` collection): callers map the
 * configured GAME_DEFINITIONS into renderer-facing GameType objects and then
 * apply their own platform filtering (so macOS only surfaces Mac-compatible
 * games).
 */

/**
 * Map the static GAME_DEFINITIONS config into renderer-facing GameType objects.
 * Only verified games are included — unverified definitions stay hidden until
 * each one is tested end-to-end.
 */
export function buildDefaultGameList(): GameType[] {
    return GAME_DEFINITIONS.filter((game) => game.verified).map((game) => ({
        id: game.id,
        name: game.name,
        modCount: game.modCount,
        imagePath: game.imagePath,
        acceptedTypes: game.acceptedTypes,
        extensions: game.extensions,
        description: game.description,
        ...(game.features !== undefined && { features: game.features }),
    }));
}
