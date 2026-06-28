/**
 * Error-message extraction for main-process code (mirror of
 * src/renderer/utils/errors.ts, with an explicit fallback so call sites
 * keep their existing user-facing default messages).
 */
export function getErrorMessage(err: unknown, fallback: string): string {
    if (err instanceof Error && typeof err.message === 'string' && err.message.length > 0) {
        return err.message;
    }
    if (typeof err === 'string' && err.length > 0) {
        return err;
    }
    if (err && typeof err === 'object' && 'message' in err) {
        const message = (err as { message?: unknown }).message;
        if (typeof message === 'string' && message.length > 0) {
            return message;
        }
    }
    return fallback;
}
