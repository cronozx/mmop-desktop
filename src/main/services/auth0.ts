import { createHash, randomBytes, randomUUID } from 'crypto';
import { BrowserWindow, session } from 'electron';
import axios from 'axios';

/**
 * Auth0 sign-in for the desktop app: Authorization Code flow with PKCE rendered
 * inside an Electron BrowserWindow. The app is a PUBLIC client — there is no
 * client secret on the desktop; PKCE is what proves the token request is
 * legitimate.
 *
 * Rather than serving the redirect URI on a loopback callback server, the flow
 * intercepts the browser window's navigation to the redirect URI, reads the
 * authorization code straight off the URL, and closes the window — so the
 * redirect target is never actually loaded. Sign-out likewise loads Auth0's
 * logout endpoint in a window and closes it once the session is cleared.
 *
 * Auth0's Universal Login hosts email/password and every social connection
 * (Google, GitHub, Microsoft, …), so this single flow replaces the per-provider
 * sign-in handlers.
 */

// All Auth0 web traffic shares one persistent session partition so sign-out can
// clear the SSO cookie that sign-in established (otherwise accounts can't be
// switched).
const AUTH0_PARTITION = 'persist:auth0';

export interface Auth0Tokens {
    accessToken: string;
    refreshToken?: string;
    idToken?: string;
    /** Seconds until the access token expires. */
    expiresIn?: number;
}

interface Auth0Config {
    domain: string;
    clientId: string;
    audience?: string;
    scope: string;
    redirectUri: string;
}

const AUTH_TIMEOUT_MS = 180000;

// Abort handle for the in-flight sign-in (the loopback server is waiting on the
// browser). Lets the renderer or a window-close tear the flow down immediately
// instead of leaving it to time out, so the UI never sticks on "Opening sign-in".
let cancelActiveSignIn: ((reason: string) => void) | null = null;

/** Abort a pending Auth0 sign-in, if one is waiting on the browser callback. */
export function cancelPendingAuth0Login(): void {
    cancelActiveSignIn?.('Sign-in canceled.');
}

function readConfig(): Auth0Config | null {
    const domain = process.env.AUTH0_DOMAIN?.trim();
    const clientId = process.env.AUTH0_CLIENT_ID?.trim();
    if (!domain || !clientId) {
        return null;
    }

    return {
        domain: domain.replace(/^https?:\/\//, '').replace(/\/$/, ''),
        clientId,
        audience: process.env.AUTH0_AUDIENCE?.trim() || undefined,
        scope: process.env.AUTH0_SCOPE?.trim() || 'openid profile email offline_access',
        redirectUri: process.env.AUTH0_OAUTH_REDIRECT_URI?.trim() || 'http://127.0.0.1:42815/oauth/auth0/callback',
    };
}

export function isAuth0Configured(): boolean {
    return readConfig() !== null;
}

function base64Url(input: Buffer): string {
    return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createPkcePair(): { verifier: string; challenge: string } {
    const verifier = base64Url(randomBytes(48));
    const challenge = base64Url(createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
}

/**
 * Open the Auth0 authorize URL in a BrowserWindow and resolve with the
 * authorization code. The window's navigation to the redirect URI is
 * intercepted (and prevented) so the redirect target is never loaded — the code
 * is read off the URL and the window closed.
 */
function awaitAuthorizationCode(redirectUri: string, expectedState: string, authorizeUrl: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        let settled = false;

        const authWindow = new BrowserWindow({
            width: 480,
            height: 760,
            title: 'Sign in to MMOP',
            autoHideMenuBar: true,
            webPreferences: {
                partition: AUTH0_PARTITION,
                nodeIntegration: false,
                contextIsolation: true,
            },
        });

        const cleanup = (): void => {
            cancelActiveSignIn = null;
            clearTimeout(timeoutHandle);
            if (!authWindow.isDestroyed()) {
                authWindow.removeAllListeners('closed');
                authWindow.close();
            }
        };
        const settleError = (message: string): void => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error(message));
        };
        const settleSuccess = (code: string): void => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(code);
        };

        // Returns true when the URL is the redirect target (so navigation to it
        // should be prevented), having settled the flow from its query params.
        const handleRedirect = (targetUrl: string): boolean => {
            if (!targetUrl.startsWith(redirectUri)) {
                return false;
            }

            let params: URLSearchParams;
            try {
                params = new URL(targetUrl).searchParams;
            } catch {
                settleError('Sign-in failed: malformed redirect.');
                return true;
            }

            const error = params.get('error');
            const errorDescription = params.get('error_description');
            const returnedState = params.get('state') || '';
            const code = params.get('code');

            if (error) {
                settleError(error === 'access_denied' ? 'Sign-in was canceled.' : `Auth0 error: ${errorDescription || error}`);
            } else if (returnedState !== expectedState) {
                settleError('Sign-in failed: invalid state.');
            } else if (!code) {
                settleError('Sign-in failed: authorization code was not returned.');
            } else {
                settleSuccess(code);
            }
            return true;
        };

        authWindow.webContents.on('will-redirect', (event, targetUrl) => {
            if (handleRedirect(targetUrl)) event.preventDefault();
        });
        authWindow.webContents.on('will-navigate', (event, targetUrl) => {
            if (handleRedirect(targetUrl)) event.preventDefault();
        });
        authWindow.on('closed', () => settleError('Sign-in was canceled.'));

        // Expose this flow's aborter so a renderer cancel can end it.
        cancelActiveSignIn = settleError;
        const timeoutHandle = setTimeout(() => settleError('Sign-in timed out.'), AUTH_TIMEOUT_MS);

        authWindow.loadURL(authorizeUrl).catch(() => settleError('Unable to open the Auth0 sign-in window.'));
    });
}

export async function loginWithAuth0(
    options?: { promptLogin?: boolean },
): Promise<{ success: boolean; tokens?: Auth0Tokens; error?: string }> {
    const config = readConfig();
    if (!config) {
        return { success: false, error: 'Auth0 is not configured. Add AUTH0_DOMAIN and AUTH0_CLIENT_ID to your .env file.' };
    }

    // Tear down any previous in-flight attempt (its window may still be open).
    cancelPendingAuth0Login();

    try {
        const { verifier, challenge } = createPkcePair();
        const state = randomUUID();

        const authorizeUrl = new URL(`https://${config.domain}/authorize`);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('client_id', config.clientId);
        authorizeUrl.searchParams.set('redirect_uri', config.redirectUri);
        authorizeUrl.searchParams.set('scope', config.scope);
        authorizeUrl.searchParams.set('state', state);
        authorizeUrl.searchParams.set('code_challenge', challenge);
        authorizeUrl.searchParams.set('code_challenge_method', 'S256');
        if (options?.promptLogin) {
            // Force the Auth0 login form even if a browser session exists, so the
            // user can sign in as someone else ("Switch account").
            authorizeUrl.searchParams.set('prompt', 'login');
        }
        if (config.audience) {
            authorizeUrl.searchParams.set('audience', config.audience);
        }

        const code = await awaitAuthorizationCode(config.redirectUri, state, authorizeUrl.toString());

        const tokenResponse = await axios.post(
            `https://${config.domain}/oauth/token`,
            new URLSearchParams({
                grant_type: 'authorization_code',
                client_id: config.clientId,
                code,
                code_verifier: verifier,
                redirect_uri: config.redirectUri,
            }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const data = tokenResponse.data as {
            access_token?: string;
            refresh_token?: string;
            id_token?: string;
            expires_in?: number;
        };
        if (!data.access_token) {
            return { success: false, error: 'Auth0 sign-in failed: no access token was returned.' };
        }

        return {
            success: true,
            tokens: {
                accessToken: data.access_token,
                refreshToken: data.refresh_token,
                idToken: data.id_token,
                expiresIn: data.expires_in,
            },
        };
    } catch (error) {
        const axiosError = error as { response?: { data?: { error_description?: unknown; error?: unknown } } };
        const message = typeof axiosError.response?.data?.error_description === 'string'
            ? axiosError.response.data.error_description
            : error instanceof Error ? error.message : 'Unexpected Auth0 error.';
        return { success: false, error: `Auth0 sign-in failed: ${message}` };
    }
}

export async function refreshAuth0Tokens(refreshToken: string): Promise<Auth0Tokens | null> {
    const config = readConfig();
    if (!config || !refreshToken) {
        return null;
    }

    try {
        const response = await axios.post(
            `https://${config.domain}/oauth/token`,
            new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: config.clientId,
                refresh_token: refreshToken,
            }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const data = response.data as {
            access_token?: string;
            refresh_token?: string;
            id_token?: string;
            expires_in?: number;
        };
        if (!data.access_token) {
            return null;
        }

        return {
            accessToken: data.access_token,
            // Auth0 only returns a new refresh token when rotation is enabled.
            refreshToken: data.refresh_token,
            idToken: data.id_token,
            expiresIn: data.expires_in,
        };
    } catch {
        return null;
    }
}

/**
 * Sign out of the hosted Auth0 session: load the logout endpoint in a window
 * (same partition as sign-in, so its SSO cookie is the one cleared), close the
 * window once it has processed, and wipe the partition's stored data so the next
 * sign-in shows the login form. There is no callback — the window just closes.
 */
export async function logoutWithAuth0(): Promise<void> {
    const config = readConfig();
    if (!config) {
        return;
    }

    const logoutUrl = new URL(`https://${config.domain}/v2/logout`);
    logoutUrl.searchParams.set('client_id', config.clientId);

    await new Promise<void>((resolve) => {
        let settled = false;
        const logoutWindow = new BrowserWindow({
            width: 480,
            height: 640,
            title: 'Signing out…',
            autoHideMenuBar: true,
            webPreferences: { partition: AUTH0_PARTITION, nodeIntegration: false, contextIsolation: true },
        });

        const finish = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (!logoutWindow.isDestroyed()) {
                logoutWindow.removeAllListeners('closed');
                logoutWindow.close();
            }
            resolve();
        };

        // Once the logout endpoint has loaded, the session is cleared; close.
        logoutWindow.webContents.once('did-finish-load', () => setTimeout(finish, 300));
        logoutWindow.on('closed', () => { settled = true; resolve(); });
        const timer = setTimeout(finish, 15000);

        logoutWindow.loadURL(logoutUrl.toString()).catch(() => finish());
    });

    // Belt-and-suspenders: clear the partition's cookies/storage so no SSO
    // cookie lingers to silently re-authenticate the same account.
    try {
        await session.fromPartition(AUTH0_PARTITION).clearStorageData();
    } catch {
        // Non-fatal: local sign-out still proceeds.
    }
}
