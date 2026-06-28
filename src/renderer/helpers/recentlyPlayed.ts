/**
 * Tracks which modpacks the user has launched, most-recent-first, so Home can
 * offer a "jump back in" shelf. There is no backend field for this, so it lives
 * in localStorage keyed per user. Best-effort: any storage failure is swallowed
 * and simply yields an empty history rather than breaking the screen.
 */

const CAP = 24;

const storageKey = (userId: string) => `mmop:recents:${userId}`;

export function readRecentModpackIds(userId: string | undefined | null): string[] {
    if (!userId) return [];
    try {
        const raw = localStorage.getItem(storageKey(userId));
        const parsed = raw ? JSON.parse(raw) : [];

        if (Array.isArray(parsed)) {
            parsed.length = 3;
        } else {
            return [];
        }

        return parsed.filter((id): id is string => typeof id === 'string');
    } catch {
        return [];
    }
}

export function recordModpackPlayed(userId: string | undefined | null, modpackId: string | undefined | null): void {
    if (!userId || !modpackId) return;
    try {
        const next = [modpackId, ...readRecentModpackIds(userId).filter((id) => id !== modpackId)].slice(0, CAP);
        localStorage.setItem(storageKey(userId), JSON.stringify(next));
    } catch {
        // Non-fatal: the recents shelf just won't update.
    }
}
