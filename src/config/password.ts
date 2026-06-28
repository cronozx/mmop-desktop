// Shared password policy: a single source of truth so the desktop UI, the
// main-process IPC guards, and the backend Zod schemas all enforce the same
// standards. (The backend imports this the same way it imports the game
// catalog.)

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export interface PasswordRule {
    id: string;
    /** Short human-readable requirement, shown as a live checklist in the UI. */
    label: string;
    test: (password: string) => boolean;
}

export const PASSWORD_RULES: PasswordRule[] = [
    { id: 'length', label: `At least ${PASSWORD_MIN_LENGTH} characters`, test: (p) => p.length >= PASSWORD_MIN_LENGTH },
    { id: 'lower', label: 'A lowercase letter', test: (p) => /[a-z]/.test(p) },
    { id: 'upper', label: 'An uppercase letter', test: (p) => /[A-Z]/.test(p) },
    { id: 'number', label: 'A number', test: (p) => /[0-9]/.test(p) },
    { id: 'special', label: 'A symbol (e.g. !?@#$)', test: (p) => /[^A-Za-z0-9]/.test(p) },
];

export interface PasswordValidation {
    valid: boolean;
    /** Labels of the unmet requirements. */
    errors: string[];
}

/** Validate a password against the shared policy. */
export function validatePassword(password: string): PasswordValidation {
    const errors = PASSWORD_RULES.filter((rule) => !rule.test(password)).map((rule) => rule.label);
    if (password.length > PASSWORD_MAX_LENGTH) {
        errors.push(`At most ${PASSWORD_MAX_LENGTH} characters`);
    }
    return { valid: errors.length === 0, errors };
}

/** A single sentence summarizing why a password is rejected (for API errors). */
export function describePasswordErrors(errors: string[]): string {
    return `Password must include: ${errors.join(', ')}.`;
}
