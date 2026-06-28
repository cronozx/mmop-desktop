import { ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import {
    validateWebToken,
    getAllUsers,
    getAuthToken as getStoredAuthToken,
    setAuthToken,
    setRefreshToken as setStoredRefreshToken,
    clearLogin as clearStoredLogin,
    getUserDataFromToken as getStoredUserDataFromToken,
    getAccountSettings as getLocalAccountSettings,
} from '../database/database.js';
import { setAuthProvider, getAuthProvider, clearAuthProvider } from '../utils/store.js';
import { validatePassword, describePasswordErrors } from '../../config/password.js';
import { isAuth0Configured, loginWithAuth0 as runAuth0Login, cancelPendingAuth0Login, logoutWithAuth0 } from '../services/auth0.js';
import { openInAppVerification, closeInAppVerification } from '../services/inAppBrowser.js';
import {
    getMinecraftAccountStatus,
    signOutMinecraftAccount,
    startMinecraftSignIn,
    waitMinecraftSignIn,
} from '../services/minecraftAuth.js';
import {
    callBackendWithAuth,
    getBackendApiBaseUrl,
    setBackendPassword,
    validateBackendToken,
    getBackendBillingStatus,
    getBackendPricing,
    type ProStatus,
    createBackendCheckout,
    updateBackendProfile,
    changeBackendPassword,
    getBackendIdentities,
    unlinkBackendIdentity,
    deleteBackendAccount,
    type AccountIdentity,
    type ProPricing,
} from '../backend-client.js';

/**
 * Auth IPC: Auth0 sign-in (desktop PKCE), account settings, user lookup,
 * token storage, logout, and the separate Minecraft (Microsoft) account flow.
 */

export function registerAuthHandlers(): void {

    // Last successfully validated user, so a transient backend hiccup doesn't
    // drop the user's identity (and log them out) on the next revalidation.
    let lastKnownUser: { username: string; _id: string; passwordSet?: boolean; isPro?: boolean } | null = null;

    ipcMain.handle('getAllUsers', async (_e: IpcMainInvokeEvent, token: string) => {
        const backendBaseUrl = getBackendApiBaseUrl();
        if (backendBaseUrl) {
            try {
                const response = await callBackendWithAuth({
                    method: 'GET',
                    path: '/users',
                    token,
                });

                if (!response || response.status !== 200 || !Array.isArray(response.data?.users)) {
                    return null;
                }

                return response.data.users;
            } catch {
                return null;
            }
        }

        return await getAllUsers(token)
    });

    ipcMain.handle('getAccountSettings', async (_e: IpcMainInvokeEvent, token: string) => {
        const backendBaseUrl = getBackendApiBaseUrl();
        if (backendBaseUrl) {
            try {
                const response = await callBackendWithAuth({
                    method: 'GET',
                    path: '/auth/account',
                    token,
                });

                if (!response || response.status !== 200 || !response.data?.account) {
                    return null;
                }

                return response.data.account;
            } catch {
                return null;
            }
        }

        return await getLocalAccountSettings(token);
    });

    ipcMain.handle('getAuthToken', () => {
        return getStoredAuthToken();
    });

    ipcMain.handle('getUserDataFromToken', async () => {
        const backendBaseUrl = getBackendApiBaseUrl();
        if (backendBaseUrl) {
            const token = getStoredAuthToken();
            if (!token) {
                return null;
            }

            const validation = await validateBackendToken(token);
            if (validation.valid && validation.user?._id && validation.user?.username) {
                lastKnownUser = {
                    username: validation.user.username,
                    _id: validation.user._id,
                    passwordSet: validation.user.passwordSet !== false,
                    isPro: validation.user.isPro === true,
                };
                return lastKnownUser;
            }

            // Couldn't reach/verify the backend: keep the user signed in with
            // their last-known identity instead of logging them out.
            if (validation.indeterminate) {
                return lastKnownUser;
            }

            clearStoredLogin();
            lastKnownUser = null;
            return null;
        }

        return getStoredUserDataFromToken();
    });

    // Pro subscription: report entitlement and start a Stripe checkout. Checkout
    // opens in the user's real browser (Stripe's hosted page can't run inside an
    // Electron BrowserWindow reliably and shouldn't see the app's session).
    ipcMain.handle('getProStatus', async (): Promise<ProStatus> => {
        const unconfigured: ProStatus = {
            isPro: false, configured: false, subscriptionStatus: null,
            trialEligible: false, trialEndsAt: null,
        };
        const token = getStoredAuthToken();
        if (!token || !getBackendApiBaseUrl()) {
            return unconfigured;
        }
        return (await getBackendBillingStatus(token)) ?? unconfigured;
    });

    ipcMain.handle('getProPricing', async (): Promise<ProPricing> => {
        const unconfigured: ProPricing = {
            configured: false, amount: null, currency: null,
            interval: null, intervalCount: null, trialDays: null, compareAtAmount: null,
        };
        const token = getStoredAuthToken();
        if (!token || !getBackendApiBaseUrl()) {
            return unconfigured;
        }
        return (await getBackendPricing(token)) ?? unconfigured;
    });

    ipcMain.handle('startProCheckout', async (): Promise<{ success: boolean; error?: string }> => {
        if (!getBackendApiBaseUrl()) {
            return { success: false, error: 'Subscriptions require the MMOP backend to be configured.' };
        }
        const token = getStoredAuthToken();
        if (!token) {
            return { success: false, error: 'You must be signed in to subscribe.' };
        }
        const result = await createBackendCheckout(token);
        if (result.url) {
            await shell.openExternal(result.url);
            return { success: true };
        }
        return { success: false, error: result.error ?? 'Could not start checkout.' };
    });

    // ── Account management (Auth0 Management API, proxied via the backend) ──────
    const requireBackendToken = (): { token: string } | { error: string } => {
        if (!getBackendApiBaseUrl()) {
            return { error: 'Account management requires the MMOP backend to be configured.' };
        }
        const token = getStoredAuthToken();
        if (!token) {
            return { error: 'You must be signed in.' };
        }
        return { token };
    };

    ipcMain.handle('updateAccountProfile', async (_e: IpcMainInvokeEvent, fields: { username?: string; email?: string }): Promise<{ success: boolean; error?: string }> => {
        const auth = requireBackendToken();
        if ('error' in auth) return { success: false, error: auth.error };
        const safe: { username?: string; email?: string } = {};
        if (typeof fields?.username === 'string') safe.username = fields.username.trim();
        if (typeof fields?.email === 'string') safe.email = fields.email.trim();
        const result = await updateBackendProfile(auth.token, safe);
        return { success: result.success, ...(result.error ? { error: result.error } : {}) };
    });

    ipcMain.handle('changeAccountPassword', async (_e: IpcMainInvokeEvent, password: string): Promise<{ success: boolean; error?: string; code?: string }> => {
        if (typeof password !== 'string') {
            return { success: false, error: 'Invalid password.' };
        }
        const check = validatePassword(password);
        if (!check.valid) {
            return { success: false, error: describePasswordErrors(check.errors) };
        }
        const auth = requireBackendToken();
        if ('error' in auth) return { success: false, error: auth.error };
        return await changeBackendPassword(auth.token, password);
    });

    ipcMain.handle('getAccountIdentities', async (): Promise<{ configured: boolean; identities: AccountIdentity[]; reason?: string }> => {
        const auth = requireBackendToken();
        if ('error' in auth) return { configured: false, identities: [], reason: 'no_backend' };
        return await getBackendIdentities(auth.token);
    });

    ipcMain.handle('unlinkAccountIdentity', async (_e: IpcMainInvokeEvent, provider: string, userId: string): Promise<{ success: boolean; error?: string }> => {
        if (typeof provider !== 'string' || typeof userId !== 'string' || !provider || !userId) {
            return { success: false, error: 'Invalid login to unlink.' };
        }
        const auth = requireBackendToken();
        if ('error' in auth) return { success: false, error: auth.error };
        return await unlinkBackendIdentity(auth.token, provider, userId);
    });

    // Permanently delete the account (and every modpack it owns) via the backend.
    // The renderer signs out + navigates to login on success.
    ipcMain.handle('deleteAccount', async (): Promise<{ success: boolean; error?: string }> => {
        const auth = requireBackendToken();
        if ('error' in auth) return { success: false, error: auth.error };
        return await deleteBackendAccount(auth.token);
    });

    // Give a social (OAuth) signup a password so they can also use the
    // email/password login (proxied to the backend Auth0 Management flow).
    ipcMain.handle('setAuth0Password', async (_e: IpcMainInvokeEvent, password: string): Promise<{ success: boolean; error?: string }> => {
        if (typeof password !== 'string') {
            return { success: false, error: 'Invalid password.' };
        }
        const check = validatePassword(password);
        if (!check.valid) {
            return { success: false, error: describePasswordErrors(check.errors) };
        }
        if (!getBackendApiBaseUrl()) {
            return { success: false, error: 'Password sign-in requires the MMOP backend to be configured.' };
        }
        const token = getStoredAuthToken();
        if (!token) {
            return { success: false, error: 'You must be signed in to set a password.' };
        }
        return await setBackendPassword(token, password);
    });

    ipcMain.handle('validateAuthToken', async (_e: IpcMainInvokeEvent, token: string) => {
        const backendBaseUrl = getBackendApiBaseUrl();
        if (backendBaseUrl) {
            const validation = await validateBackendToken(token);
            // Only sign out on a definitive "invalid" — a network/5xx blip is
            // indeterminate, so keep the session instead of logging the user out.
            if (validation.indeterminate) {
                return true;
            }
            if (!validation.valid) {
                clearStoredLogin();
                lastKnownUser = null;
            }
            return validation.valid;
        }

        return validateWebToken(token);
    });

    // Returns a human-readable reason the most recent sign-in couldn't be
    // completed (e.g. an Auth0 connection that didn't share an email), or null.
    ipcMain.handle('getSignInDiagnostic', async (): Promise<string | null> => {
        if (!getBackendApiBaseUrl()) {
            return null;
        }
        const token = getStoredAuthToken();
        if (!token) {
            return null;
        }
        const validation = await validateBackendToken(token);
        return validation.valid ? null : validation.error ?? null;
    });

    // ── Minecraft (Microsoft) account ────────────────────────────────────
    // Two-step device-code flow for launching Minecraft (separate from app
    // sign-in): 'start' returns the user code + verification URI immediately
    // (and opens the browser) while polling continues in the background;
    // 'wait' resolves once the user approves (or the flow fails/expires).
    ipcMain.handle('getMinecraftAccountStatus', (): { signedIn: boolean; profileName?: string } => {
        return getMinecraftAccountStatus();
    });

    ipcMain.handle('signInMinecraftAccount', async (_e: IpcMainInvokeEvent, step?: 'start' | 'wait'): Promise<{ success: boolean; userCode?: string; verificationUri?: string; profileName?: string; error?: string }> => {
        if (step === 'wait') {
            const result = await waitMinecraftSignIn();
            // Close the in-app verification window once the flow resolves.
            closeInAppVerification();
            return result;
        }

        const started = await startMinecraftSignIn();
        if (started.success && started.verificationUri) {
            // Show the device-code verification page in-app, not the system browser.
            openInAppVerification(started.verificationUri);
        }
        return started;
    });

    ipcMain.handle('openVerificationWindow', (_e: IpcMainInvokeEvent, url: string): void => {
        openInAppVerification(url);
    });

    ipcMain.handle('signOutMinecraftAccount', (): { success: boolean } => {
        signOutMinecraftAccount();
        return { success: true };
    });

    ipcMain.handle('clearLogin', async () => {
        // For Auth0 sessions, also clear the hosted session so the next sign-in
        // shows the login form instead of silently re-using the SSO cookie —
        // otherwise you can never switch accounts.
        if (getAuthProvider() === 'auth0') {
            try {
                await logoutWithAuth0();
            } catch {
                // Non-fatal: local sign-out still proceeds.
            }
        }

        clearStoredLogin();
        clearAuthProvider();
    });

    ipcMain.handle('isAuth0Enabled', (): boolean => isAuth0Configured());

    ipcMain.handle('cancelAuth0Login', (): void => {
        cancelPendingAuth0Login();
    });

    ipcMain.handle('loginWithAuth0', async (_e: IpcMainInvokeEvent, rememberMe?: boolean, promptLogin?: boolean): Promise<{ success: boolean; error?: string }> => {
        if (!getBackendApiBaseUrl()) {
            return { success: false, error: 'Auth0 sign-in requires the MMOP backend (BACKEND_API_URL) to be configured.' };
        }

        const result = await runAuth0Login({ promptLogin: !!promptLogin });
        if (!result.success || !result.tokens) {
            return { success: false, error: result.error ?? 'Auth0 sign-in failed.' };
        }

        const persistSession = rememberMe ?? true;
        // The Auth0 access token is the bearer the backend now validates; mark the
        // session so refresh-on-401 goes to Auth0 instead of the MMOP backend.
        setAuthToken(result.tokens.accessToken, persistSession);
        if (result.tokens.refreshToken) {
            setStoredRefreshToken(result.tokens.refreshToken, persistSession);
        }
        setAuthProvider('auth0');

        return { success: true };
    });
}
