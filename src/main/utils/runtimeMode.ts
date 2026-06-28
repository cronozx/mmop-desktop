interface RuntimeModeOptions {
    nodeEnv?: string;
    backendApiUrl?: string;
    isPackaged?: boolean;
    requireBackendApiInProduction?: boolean;
}

export function isProductionRuntime(options: RuntimeModeOptions): boolean {
    return options.nodeEnv === 'production' || options.isPackaged === true;
}

export function normalizeBackendApiUrl(rawUrl?: string): string | null {
    const value = rawUrl?.trim();
    if (!value) {
        return null;
    }

    try {
        const parsed = new URL(value);
        if ((parsed.pathname === '' || parsed.pathname === '/') && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
            parsed.pathname = '/api';
        }

        return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
    } catch {
        return value.replace(/\/+$/, '');
    }
}

export function assertBackendConfiguredForRuntime(options: RuntimeModeOptions): void {
    if (!isProductionRuntime(options)) {
        return;
    }

    if (!normalizeBackendApiUrl(options.backendApiUrl) && options.requireBackendApiInProduction === true) {
        throw new Error('BACKEND_API_URL must be configured in production runtime; local fallback is disabled.');
    }
}
