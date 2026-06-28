import { app } from 'electron';
import axios from 'axios';
import {
    clearLogin as clearStoredLogin,
    getAuthToken as getStoredAuthToken,
    getRefreshToken as getStoredRefreshToken,
    setAuthToken,
    setRefreshToken as setStoredRefreshToken,
} from './database/database.js';
import { hasSecureValue, getAuthProvider } from './utils/store.js';
import { normalizeBackendApiUrl } from './utils/runtimeMode.js';
import { refreshAuth0Tokens } from './services/auth0.js';
import type { ProPricing, ProStatus } from '../types/sharedTypes.js';

// Re-exported so existing importers (e.g. ipc/auth.ts) can keep getting them here.
export type { ProPricing, ProStatus };

/**
 * Shared backend API plumbing for all IPC handler modules.
 *
 * Every data IPC handler follows the same dual-mode pattern: when
 * BACKEND_API_URL is configured (or the app is packaged, which defaults to
 * https://www.mmop.app/api) requests are proxied to the backend with bearer
 * auth + refresh-on-401; otherwise handlers fall back to direct local DB calls.
 */

export const BACKEND_TIMEOUT_MS = 15000;

/**
 * Loosely-typed JSON object returned by the backend API. Responses are
 * dynamically shaped, so each call site validates the fields it reads.
 */
export interface BackendJson {
    [key: string]: unknown;
}

const BACKEND_REDIRECT_MAX_HOPS = 5;
const REDIRECT_STATUS_CODES = new Set([301, 302, 307, 308]);
const DEFAULT_PACKAGED_BACKEND_API_URL = 'https://www.mmop.app/api';

export function getBackendApiBaseUrl(): string | null {
    const configured = normalizeBackendApiUrl(process.env.BACKEND_API_URL);
    if (configured) {
        return configured;
    }

    if (app.isPackaged) {
        return DEFAULT_PACKAGED_BACKEND_API_URL;
    }

    return null;
}

export async function requestBackendWithOptionalAuth(options: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    url: string;
    token?: string;
    data?: unknown;
    params?: Record<string, unknown>;
}): Promise<{ status: number; data: BackendJson }> {
    let requestUrl = options.url;

    for (let hop = 0; hop < BACKEND_REDIRECT_MAX_HOPS; hop += 1) {
        const response = await axios.request({
            method: options.method,
            url: requestUrl,
            data: options.data,
            params: options.params,
            headers: options.token
                ? {
                      Authorization: `Bearer ${options.token}`,
                  }
                : undefined,
            timeout: BACKEND_TIMEOUT_MS,
            validateStatus: () => true,
            maxRedirects: 0,
        });

        if (REDIRECT_STATUS_CODES.has(response.status)) {
            const location = response.headers?.location;
            if (typeof location === 'string' && location.length > 0) {
                requestUrl = new URL(location, requestUrl).toString();
                continue;
            }
        }

        return { status: response.status, data: response.data };
    }

    return {
        status: 508,
        data: {
            error: 'Too many redirects while contacting backend API.',
        },
    };
}

export async function refreshBackendSession(): Promise<boolean> {
    const backendBaseUrl = getBackendApiBaseUrl();
    const refreshToken = getStoredRefreshToken();

    if (!backendBaseUrl || !refreshToken || getAuthProvider() !== 'auth0') {
        return false;
    }

    // Sessions are Auth0-issued; refresh against Auth0, not the MMOP backend.
    const tokens = await refreshAuth0Tokens(refreshToken);
    if (!tokens) {
        clearStoredLogin();
        return false;
    }

    const rememberMe = hasSecureValue('authToken');
    setAuthToken(tokens.accessToken, rememberMe);
    if (tokens.refreshToken) {
        setStoredRefreshToken(tokens.refreshToken, rememberMe);
    }
    return true;
}

export async function validateBackendToken(token: string): Promise<{ valid: boolean; indeterminate?: boolean; user?: { _id: string; username: string; passwordSet?: boolean; isPro?: boolean }; error?: string }> {
    const backendBaseUrl = getBackendApiBaseUrl();
    if (!backendBaseUrl || !token) {
        return { valid: false };
    }

    try {
        const response = await requestBackendWithOptionalAuth({
            method: 'GET',
            url: `${backendBaseUrl}/auth/validate`,
            token,
        });

        if (response.status !== 200 || !response.data?.valid) {
            if (response.status === 401 && await refreshBackendSession()) {
                const refreshedToken = getStoredAuthToken();
                if (!refreshedToken) {
                    return { valid: false };
                }

                const retryResponse = await requestBackendWithOptionalAuth({
                    method: 'GET',
                    url: `${backendBaseUrl}/auth/validate`,
                    token: refreshedToken,
                });

                if (retryResponse.status === 200 && retryResponse.data?.valid) {
                    return {
                        valid: true,
                        user: retryResponse.data.user as { _id: string; username: string; passwordSet?: boolean; isPro?: boolean },
                    };
                }
            }

            // A 5xx means the backend couldn't answer — that's not proof the
            // token is bad, so don't treat it as a definitive sign-out.
            if (response.status >= 500) {
                return { valid: false, indeterminate: true };
            }

            // Surface a provisioning reason (e.g. no email shared) when present.
            const error = typeof response.data?.error === 'string' ? response.data.error : undefined;
            return { valid: false, ...(error ? { error } : {}) };
        }

        return {
            valid: true,
            user: response.data.user as { _id: string; username: string; passwordSet?: boolean; isPro?: boolean },
        };
    } catch {
        // Network error (offline, DNS, timeout): can't verify, so keep the
        // session rather than signing the user out on a transient blip.
        return { valid: false, indeterminate: true };
    }
}

/** POST /auth/set-password with bearer auth + refresh-on-401. */
export async function setBackendPassword(token: string, password: string): Promise<{ success: boolean; error?: string }> {
    const response = await callBackendWithAuth({
        method: 'POST',
        path: '/auth/set-password',
        token,
        data: { password },
    });

    if (response && response.status === 200 && response.data?.success) {
        return { success: true };
    }
    const error = typeof response?.data?.error === 'string' ? response.data.error : 'Could not set a password.';
    return { success: false, error };
}

/** GET /billing/status — current Pro entitlement for the signed-in user. */
export async function getBackendBillingStatus(token: string): Promise<ProStatus | null> {
    const response = await callBackendWithAuth({ method: 'GET', path: '/billing/status', token });
    if (response && response.status === 200) {
        return {
            isPro: response.data?.isPro === true,
            configured: response.data?.configured === true,
            subscriptionStatus: typeof response.data?.subscriptionStatus === 'string' ? response.data.subscriptionStatus : null,
            trialEligible: response.data?.trialEligible === true,
            trialEndsAt: typeof response.data?.trialEndsAt === 'string' ? response.data.trialEndsAt : null,
        };
    }
    return null;
}

/** GET /billing/pricing — current Pro pricing for the upgrade UI. */
export async function getBackendPricing(token: string): Promise<ProPricing | null> {
    const response = await callBackendWithAuth({ method: 'GET', path: '/billing/pricing', token });
    if (response && response.status === 200 && response.data) {
        const data = response.data;
        return {
            configured: data.configured === true,
            amount: typeof data.amount === 'number' ? data.amount : null,
            currency: typeof data.currency === 'string' ? data.currency : null,
            interval: typeof data.interval === 'string' ? data.interval : null,
            intervalCount: typeof data.intervalCount === 'number' ? data.intervalCount : null,
            trialDays: typeof data.trialDays === 'number' ? data.trialDays : null,
            compareAtAmount: typeof data.compareAtAmount === 'number' ? data.compareAtAmount : null,
        };
    }
    return null;
}

/** POST /billing/checkout — returns a Stripe Checkout URL to open in a browser. */
export async function createBackendCheckout(token: string): Promise<{ url?: string; error?: string }> {
    const response = await callBackendWithAuth({ method: 'POST', path: '/billing/checkout', token });
    if (response && response.status === 200 && typeof response.data?.url === 'string') {
        return { url: response.data.url };
    }
    const error = typeof response?.data?.error === 'string' ? response.data.error : 'Could not start checkout.';
    return { error };
}

export interface AccountIdentity {
    provider: string;
    connection: string | null;
    userId: string;
    isSocial: boolean;
}

/** PATCH /auth/profile — update username and/or email. */
export async function updateBackendProfile(token: string, fields: { username?: string; email?: string }): Promise<{ success: boolean; error?: string; account?: { _id: string; username: string; email: string } }> {
    const response = await callBackendWithAuth({ method: 'PATCH', path: '/auth/profile', token, data: fields });
    if (response && response.status === 200 && response.data?.success) {
        return { success: true, account: response.data.account as { _id: string; username: string; email: string } };
    }
    return { success: false, error: typeof response?.data?.error === 'string' ? response.data.error : 'Could not update your account.' };
}

/** POST /auth/change-password — set a new password for the account. */
export async function changeBackendPassword(token: string, password: string): Promise<{ success: boolean; error?: string; code?: string }> {
    const response = await callBackendWithAuth({ method: 'POST', path: '/auth/change-password', token, data: { password } });
    if (response && response.status === 200 && response.data?.success) {
        return { success: true };
    }
    return {
        success: false,
        error: typeof response?.data?.error === 'string' ? response.data.error : 'Could not change your password.',
        ...(typeof response?.data?.code === 'string' ? { code: response.data.code } : {}),
    };
}

/** GET /auth/identities — connected logins for the account. */
export async function getBackendIdentities(token: string): Promise<{ configured: boolean; identities: AccountIdentity[]; reason?: string }> {
    const response = await callBackendWithAuth({ method: 'GET', path: '/auth/identities', token });
    if (!response) {
        return { configured: false, identities: [], reason: 'unreachable' };
    }
    if (response.status === 404) {
        // The running backend predates this route — needs a restart/redeploy.
        return { configured: false, identities: [], reason: 'route_missing' };
    }
    if (response.status === 200) {
        return {
            configured: response.data?.configured === true,
            identities: Array.isArray(response.data?.identities) ? response.data.identities as AccountIdentity[] : [],
            ...(response.data?.configured === true ? {} : { reason: 'not_configured' }),
            ...(typeof response.data?.error === 'string' ? { reason: 'management_error' } : {}),
        };
    }
    return { configured: false, identities: [], reason: 'unreachable' };
}

/** POST /auth/unlink-identity — remove a connected social login. */
export async function unlinkBackendIdentity(token: string, provider: string, userId: string): Promise<{ success: boolean; error?: string }> {
    const response = await callBackendWithAuth({ method: 'POST', path: '/auth/unlink-identity', token, data: { provider, userId } });
    if (response && response.status === 200 && response.data?.success) {
        return { success: true };
    }
    return { success: false, error: typeof response?.data?.error === 'string' ? response.data.error : 'Could not unlink that login.' };
}

/** DELETE /auth/account — permanently delete the account and its modpacks. */
export async function deleteBackendAccount(token: string): Promise<{ success: boolean; error?: string }> {
    const response = await callBackendWithAuth({ method: 'DELETE', path: '/auth/account', token });
    if (response && response.status === 200 && response.data?.success) {
        return { success: true };
    }
    return { success: false, error: typeof response?.data?.error === 'string' ? response.data.error : 'Could not delete your account.' };
}

export async function callBackendWithAuth(options: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    token?: string;
    data?: unknown;
    params?: Record<string, unknown>;
}): Promise<{ status: number; data: BackendJson } | null> {
    const backendBaseUrl = getBackendApiBaseUrl();
    if (!backendBaseUrl) {
        return null;
    }

    const performRequest = async (accessToken?: string): Promise<{ status: number; data: BackendJson }> => {
        return await requestBackendWithOptionalAuth({
            method: options.method,
            url: `${backendBaseUrl}${options.path}`,
            data: options.data,
            params: options.params,
            token: accessToken,
        });
    };

    const initialToken = options.token ?? getStoredAuthToken();
    const firstAttempt = await performRequest(initialToken);
    if (firstAttempt.status !== 401) {
        return firstAttempt;
    }

    const refreshed = await refreshBackendSession();
    if (!refreshed) {
        return firstAttempt;
    }

    const refreshedToken = getStoredAuthToken();
    return await performRequest(refreshedToken ?? undefined);
}
