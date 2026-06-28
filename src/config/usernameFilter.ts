// Shared username word filter: a single source of truth so the desktop UI, the
// backend Zod schemas, and the Auth0 username derivation all reject the same
// offensive words. (Imported the same way as the shared password policy.)
//
// The blocklist holds normalized base forms. Matching first normalizes the
// candidate — lowercasing, folding common leetspeak substitutions, and stripping
// separators — so trivial bypasses ("n_a_z_i", "5h1t") are still caught. This is
// substring matching, so the list is deliberately kept to unambiguous terms to
// limit false positives (the "Scunthorpe problem"); extend it with care.

export const USERNAME_BLOCKLIST: string[] = [
    'nigger',
    'nigga',
    'faggot',
    'retard',
    'rape',
    'rapist',
    'nazi',
    'hitler',
    'kike',
    'spic',
    'chink',
    'cunt',
    'fuck',
    'shit',
    'bitch',
    'whore',
    'slut',
    'pedophile',
    'pedo',
    'molest',
];

// Common leetspeak / homoglyph substitutions, mapped to the plain letter so the
// normalized form collapses onto the blocklist's base words.
const LEET_MAP: Record<string, string> = {
    '0': 'o',
    '1': 'i',
    '!': 'i',
    '|': 'i',
    '3': 'e',
    '4': 'a',
    '@': 'a',
    '5': 's',
    '$': 's',
    '7': 't',
    '8': 'b',
    '9': 'g',
};

/**
 * Folds a username into a comparison form: lowercased, leetspeak-substituted,
 * with all non-letter characters removed. Repeated runs of the same letter are
 * collapsed so "niiigger" matches "nigger".
 */
export function normalizeForUsernameMatch(username: string): string {
    const lowered = username.toLowerCase();
    let folded = '';
    for (const char of lowered) {
        folded += LEET_MAP[char] ?? char;
    }
    return folded
        .replace(/[^a-z]/g, '')
        .replace(/(.)\1+/g, '$1');
}

/**
 * Returns the first blocklisted word contained in the username (after
 * normalization), or null when the username is clean. The blocklist itself is
 * normalized the same way so collapsed-letter entries still match.
 */
export function findBlockedUsernameWord(username: string): string | null {
    const normalized = normalizeForUsernameMatch(username);
    if (!normalized) {
        return null;
    }
    for (const word of USERNAME_BLOCKLIST) {
        const normalizedWord = normalizeForUsernameMatch(word);
        if (normalizedWord && normalized.includes(normalizedWord)) {
            return word;
        }
    }
    return null;
}

/** Convenience predicate: true when the username contains no blocked words. */
export function isUsernameClean(username: string): boolean {
    return findBlockedUsernameWord(username) === null;
}

/** User-facing message for a rejected username. */
export const BLOCKED_USERNAME_MESSAGE = 'That username contains a word that isn’t allowed. Please choose another.';
