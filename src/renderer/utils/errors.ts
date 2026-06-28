/**
 * Normalizes an unknown thrown value into a human-readable message.
 * Use in catch blocks instead of `catch (error: any)` + `error.message`.
 */
export function getErrorMessage(err: unknown): string {
    if (err instanceof Error) {
        return err.message;
    }

    if (typeof err === 'string') {
        return err;
    }

    if (
        err &&
        typeof err === 'object' &&
        'message' in err &&
        typeof (err as { message: unknown }).message === 'string'
    ) {
        return (err as { message: string }).message;
    }

    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
}
