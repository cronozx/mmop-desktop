import axios from 'axios';
import { getSecureValue, setSecureValue, deleteSecureValue } from '../utils/store.js';

/**
 * Microsoft → Xbox Live → XSTS → Minecraft auth chain (device-code flow).
 *
 * Every network call goes through an injectable {@link MinecraftAuthHttp}
 * client so the whole chain can be unit-tested offline. The default client is
 * axios with 15s timeouts and `validateStatus: () => true` (Microsoft returns
 * meaningful JSON bodies on 4xx responses, e.g. `authorization_pending`).
 */

const MSA_DEVICE_CODE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode';
const MSA_TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const XBL_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_AUTH_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

const MSA_SCOPE = 'XboxLive.signin offline_access';
const HTTP_TIMEOUT_MS = 15000;
const TOKEN_EXPIRY_LEEWAY_MS = 60_000;
const MINECRAFT_AUTH_STORE_KEY = 'minecraftAuth';

const FORM_HEADERS: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
};

const JSON_HEADERS: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
};

// ── Types ───────────────────────────────────────────────────────────────────

export interface HttpResponse {
    status: number;
    // Remote JSON payloads have no static shape; responses are narrowed below.
    data: Record<string, unknown> | null | undefined;
}

export interface MinecraftAuthHttp {
    post(url: string, body: string | object, headers: Record<string, string>): Promise<HttpResponse>;
    get(url: string, headers: Record<string, string>): Promise<HttpResponse>;
}

export interface MinecraftProfile {
    id: string;
    name: string;
}

export interface MinecraftAuthData {
    msaRefreshToken: string;
    minecraftAccessToken: string;
    minecraftTokenExpiresAt: number;
    profile: MinecraftProfile;
}

export interface MinecraftAuthStorage {
    load(): MinecraftAuthData | null;
    save(data: MinecraftAuthData): void;
    clear(): void;
}

export interface DeviceCodeInfo {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    intervalSec: number;
    expiresInSec: number;
}

export interface MsaTokens {
    accessToken: string;
    refreshToken: string;
    expiresInSec: number;
}

export interface MinecraftSession {
    accessToken: string;
    profile: MinecraftProfile;
}

export interface MinecraftSignInStart {
    success: boolean;
    userCode?: string;
    verificationUri?: string;
    error?: string;
}

export interface MinecraftSignInResult {
    success: boolean;
    profileName?: string;
    error?: string;
}

type SleepFn = (ms: number) => Promise<void>;
type NowFn = () => number;

export interface MinecraftAuthDeps {
    http?: MinecraftAuthHttp;
    storage?: MinecraftAuthStorage;
    clientId?: string;
    sleep?: SleepFn;
    now?: NowFn;
}

// ── Defaults (axios HTTP, encrypted electron-store persistence) ─────────────

const defaultSleep: SleepFn = async (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const defaultHttp: MinecraftAuthHttp = {
    post: async (url, body, headers) => {
        const response = await axios.post(url, body, {
            headers,
            timeout: HTTP_TIMEOUT_MS,
            validateStatus: () => true,
        });
        return { status: response.status, data: response.data };
    },
    get: async (url, headers) => {
        const response = await axios.get(url, {
            headers,
            timeout: HTTP_TIMEOUT_MS,
            validateStatus: () => true,
        });
        return { status: response.status, data: response.data };
    },
};

const isMinecraftAuthData = (value: unknown): value is MinecraftAuthData => {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const data = value as Partial<MinecraftAuthData>;
    return typeof data.msaRefreshToken === 'string'
        && typeof data.minecraftAccessToken === 'string'
        && typeof data.minecraftTokenExpiresAt === 'number'
        && typeof data.profile?.id === 'string'
        && typeof data.profile?.name === 'string';
};

const defaultStorage: MinecraftAuthStorage = {
    load: () => {
        const raw = getSecureValue(MINECRAFT_AUTH_STORE_KEY);
        if (!raw) {
            return null;
        }
        try {
            const parsed: unknown = JSON.parse(raw);
            return isMinecraftAuthData(parsed) ? parsed : null;
        } catch {
            return null;
        }
    },
    save: (data) => {
        setSecureValue(MINECRAFT_AUTH_STORE_KEY, JSON.stringify(data));
    },
    clear: () => {
        deleteSecureValue(MINECRAFT_AUTH_STORE_KEY);
    },
};

export const resolveMicrosoftClientId = (): string | undefined =>
    process.env.MICROSOFT_OAUTH_CLIENT_ID ?? process.env.MSA_CLIENT_ID;

export const MICROSOFT_NOT_CONFIGURED_ERROR =
    'Microsoft sign-in is not configured. Set MICROSOFT_OAUTH_CLIENT_ID in .env.';

const toErrorMessage = (error: unknown, fallback: string): string =>
    error instanceof Error && error.message ? error.message : fallback;

const asString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined;

// ── Pure protocol pieces (exported for offline tests) ───────────────────────

/** Step 1: request a device code the user enters at microsoft.com/link. */
export const requestDeviceCode = async (http: MinecraftAuthHttp, clientId: string): Promise<DeviceCodeInfo> => {
    const response = await http.post(
        MSA_DEVICE_CODE_URL,
        new URLSearchParams({ client_id: clientId, scope: MSA_SCOPE }).toString(),
        FORM_HEADERS
    );

    const data = response.data ?? {};
    const deviceCode = asString(data.device_code);
    const userCode = asString(data.user_code);
    const verificationUri = asString(data.verification_uri);

    if (response.status !== 200 || !deviceCode || !userCode || !verificationUri) {
        throw new Error(asString(data.error_description) ?? 'Failed to start Microsoft sign-in.');
    }

    return {
        deviceCode,
        userCode,
        verificationUri,
        intervalSec: Number(data.interval) || 5,
        expiresInSec: Number(data.expires_in) || 900,
    };
};

/**
 * Step 2: poll the token endpoint until the user approves the device code.
 * Handles `authorization_pending` (keep polling) and `slow_down` (+5s).
 */
export const pollForMsaTokens = async (
    http: MinecraftAuthHttp,
    clientId: string,
    deviceCode: string,
    options: { intervalSec?: number; expiresInSec?: number; sleep?: SleepFn; now?: NowFn } = {}
): Promise<MsaTokens> => {
    const sleep = options.sleep ?? defaultSleep;
    const now = options.now ?? Date.now;
    let intervalSec = Math.max(1, options.intervalSec ?? 5);
    const deadline = now() + Math.max(30, options.expiresInSec ?? 900) * 1000;

    while (now() < deadline) {
        await sleep(intervalSec * 1000);

        const response = await http.post(
            MSA_TOKEN_URL,
            new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                client_id: clientId,
                device_code: deviceCode,
            }).toString(),
            FORM_HEADERS
        );

        const data = response.data ?? {};
        const accessToken = asString(data.access_token);
        if (response.status === 200 && accessToken) {
            return {
                accessToken,
                refreshToken: asString(data.refresh_token) ?? '',
                expiresInSec: Number(data.expires_in) || 3600,
            };
        }

        switch (data.error) {
            case 'authorization_pending':
                continue;
            case 'slow_down':
                intervalSec += 5;
                continue;
            case 'expired_token':
                throw new Error('Microsoft sign-in expired before it was approved. Please start the sign-in again.');
            case 'access_denied':
                throw new Error('Microsoft sign-in was canceled.');
            default:
                throw new Error(asString(data.error_description) ?? 'Unable to complete Microsoft sign-in.');
        }
    }

    throw new Error('Microsoft sign-in timed out. Please start the sign-in again.');
};

/** Step 3: exchange a stored refresh token for fresh MSA tokens. */
export const refreshMsaTokens = async (
    http: MinecraftAuthHttp,
    clientId: string,
    refreshToken: string
): Promise<MsaTokens> => {
    const response = await http.post(
        MSA_TOKEN_URL,
        new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: clientId,
            refresh_token: refreshToken,
            scope: MSA_SCOPE,
        }).toString(),
        FORM_HEADERS
    );

    const data = response.data ?? {};
    const accessToken = asString(data.access_token);
    if (response.status !== 200 || !accessToken) {
        throw new Error(asString(data.error_description) ?? 'Microsoft session expired. Please sign in again.');
    }

    return {
        accessToken,
        // Microsoft may rotate the refresh token; keep the old one if it does not.
        refreshToken: asString(data.refresh_token) ?? refreshToken,
        expiresInSec: Number(data.expires_in) || 3600,
    };
};

/** Step 4: authenticate the MSA access token against Xbox Live. */
export const authenticateWithXboxLive = async (
    http: MinecraftAuthHttp,
    msaAccessToken: string
): Promise<{ xblToken: string; userHash: string }> => {
    const response = await http.post(
        XBL_AUTH_URL,
        {
            Properties: {
                AuthMethod: 'RPS',
                SiteName: 'user.auth.xboxlive.com',
                RpsTicket: `d=${msaAccessToken}`,
            },
            RelyingParty: 'http://auth.xboxlive.com',
            TokenType: 'JWT',
        },
        JSON_HEADERS
    );

    const data = response.data ?? {};
    const xblToken = asString(data.Token);
    const displayClaims = data.DisplayClaims as { xui?: Array<{ uhs?: string }> } | undefined;
    const userHash = asString(displayClaims?.xui?.[0]?.uhs);

    if (response.status !== 200 || !xblToken || !userHash) {
        throw new Error('Xbox Live authentication failed. Please try signing in again.');
    }

    return { xblToken, userHash };
};

/** Maps known XSTS XErr codes to actionable messages. */
export const mapXstsError = (xerr: unknown): string => {
    switch (Number(xerr)) {
        case 2148916233:
            return 'This Microsoft account has no Xbox profile. Sign in at https://www.xbox.com once to create one, then try again.';
        case 2148916238:
            return 'This Microsoft account belongs to a child. An adult must add it to a Microsoft family group before it can sign in.';
        default:
            return 'Xbox Live denied the sign-in for this account.';
    }
};

/** Step 5: get an XSTS token scoped to the Minecraft services relying party. */
export const authorizeWithXsts = async (http: MinecraftAuthHttp, xblToken: string): Promise<string> => {
    const response = await http.post(
        XSTS_AUTH_URL,
        {
            Properties: {
                SandboxId: 'RETAIL',
                UserTokens: [xblToken],
            },
            RelyingParty: 'rp://api.minecraftservices.com/',
            TokenType: 'JWT',
        },
        JSON_HEADERS
    );

    const data = response.data ?? {};
    if (response.status === 401) {
        throw new Error(mapXstsError(data.XErr));
    }

    const xstsToken = asString(data.Token);
    if (response.status !== 200 || !xstsToken) {
        throw new Error('Xbox security token request failed. Please try signing in again.');
    }

    return xstsToken;
};

/** Step 6: log in to Minecraft services with the XSTS token. */
export const loginToMinecraft = async (
    http: MinecraftAuthHttp,
    userHash: string,
    xstsToken: string
): Promise<{ accessToken: string; expiresInSec: number }> => {
    const response = await http.post(
        MC_LOGIN_URL,
        { identityToken: `XBL3.0 x=${userHash};${xstsToken}` },
        JSON_HEADERS
    );

    const data = response.data ?? {};
    const accessToken = asString(data.access_token);
    if (response.status !== 200 || !accessToken) {
        throw new Error('Minecraft authentication failed. Please try signing in again.');
    }

    return { accessToken, expiresInSec: Number(data.expires_in) || 86400 };
};

/** Step 7: fetch the Minecraft profile; a 404 means the account owns no copy. */
export const fetchMinecraftProfile = async (
    http: MinecraftAuthHttp,
    minecraftAccessToken: string
): Promise<MinecraftProfile> => {
    const response = await http.get(MC_PROFILE_URL, {
        Authorization: `Bearer ${minecraftAccessToken}`,
        Accept: 'application/json',
    });

    if (response.status === 404) {
        throw new Error('This Microsoft account does not own Minecraft: Java Edition.');
    }

    const data = response.data ?? {};
    const id = asString(data.id);
    const name = asString(data.name);
    if (response.status !== 200 || !id || !name) {
        throw new Error('Could not load the Minecraft profile for this account.');
    }

    return { id, name };
};

/** Runs MSA access token → XBL → XSTS → Minecraft login → profile. */
export const completeMinecraftAuthChain = async (
    http: MinecraftAuthHttp,
    msaTokens: MsaTokens,
    now: NowFn = Date.now
): Promise<MinecraftAuthData> => {
    const { xblToken, userHash } = await authenticateWithXboxLive(http, msaTokens.accessToken);
    const xstsToken = await authorizeWithXsts(http, xblToken);
    const minecraftLogin = await loginToMinecraft(http, userHash, xstsToken);
    const profile = await fetchMinecraftProfile(http, minecraftLogin.accessToken);

    return {
        msaRefreshToken: msaTokens.refreshToken,
        minecraftAccessToken: minecraftLogin.accessToken,
        minecraftTokenExpiresAt: now() + minecraftLogin.expiresInSec * 1000,
        profile,
    };
};

// ── Session management ──────────────────────────────────────────────────────

/**
 * Returns the stored Minecraft session, transparently refreshing it through
 * the full auth chain when the Minecraft token is expired (60s leeway).
 * A failed refresh clears the stored session and returns null.
 */
export const getMinecraftSession = async (deps: MinecraftAuthDeps = {}): Promise<MinecraftSession | null> => {
    const storage = deps.storage ?? defaultStorage;
    const http = deps.http ?? defaultHttp;
    const now = deps.now ?? Date.now;

    const data = storage.load();
    if (!data) {
        return null;
    }

    if (data.minecraftTokenExpiresAt - TOKEN_EXPIRY_LEEWAY_MS > now()) {
        return { accessToken: data.minecraftAccessToken, profile: data.profile };
    }

    const clientId = deps.clientId ?? resolveMicrosoftClientId();
    if (!clientId || !data.msaRefreshToken) {
        storage.clear();
        return null;
    }

    try {
        const msaTokens = await refreshMsaTokens(http, clientId, data.msaRefreshToken);
        const refreshed = await completeMinecraftAuthChain(http, msaTokens, now);
        storage.save(refreshed);
        return { accessToken: refreshed.minecraftAccessToken, profile: refreshed.profile };
    } catch {
        storage.clear();
        return null;
    }
};

/** Stored-profile-only status check; never touches the network. */
export const getMinecraftAccountStatus = (
    storage: MinecraftAuthStorage = defaultStorage
): { signedIn: boolean; profileName?: string } => {
    const data = storage.load();
    if (!data) {
        return { signedIn: false };
    }
    return { signedIn: true, profileName: data.profile.name };
};

export const signOutMinecraftAccount = (storage: MinecraftAuthStorage = defaultStorage): void => {
    storage.clear();
};

// ── Device-flow sign-in (two-step: start → wait) ────────────────────────────

let pendingSignIn: Promise<MinecraftSignInResult> | null = null;
let signInGeneration = 0;

/**
 * Starts the Microsoft device-code sign-in. Resolves immediately with the
 * user code + verification URI while the poll → auth chain continues in the
 * background; await {@link waitMinecraftSignIn} for the final outcome.
 */
export const startMinecraftSignIn = async (deps: MinecraftAuthDeps = {}): Promise<MinecraftSignInStart> => {
    const clientId = deps.clientId ?? resolveMicrosoftClientId();
    if (!clientId) {
        return { success: false, error: MICROSOFT_NOT_CONFIGURED_ERROR };
    }

    const http = deps.http ?? defaultHttp;
    const storage = deps.storage ?? defaultStorage;

    try {
        const device = await requestDeviceCode(http, clientId);
        // A restarted sign-in supersedes any still-polling previous attempt:
        // the stale attempt may finish, but it must not overwrite the session.
        const generation = ++signInGeneration;

        pendingSignIn = (async (): Promise<MinecraftSignInResult> => {
            try {
                const msaTokens = await pollForMsaTokens(http, clientId, device.deviceCode, {
                    intervalSec: device.intervalSec,
                    expiresInSec: device.expiresInSec,
                    sleep: deps.sleep,
                    now: deps.now,
                });
                const session = await completeMinecraftAuthChain(http, msaTokens, deps.now);
                if (generation !== signInGeneration) {
                    return { success: false, error: 'This Microsoft sign-in was replaced by a newer attempt.' };
                }
                storage.save(session);
                return { success: true, profileName: session.profile.name };
            } catch (error) {
                return { success: false, error: toErrorMessage(error, 'Microsoft sign-in failed.') };
            }
        })();

        return { success: true, userCode: device.userCode, verificationUri: device.verificationUri };
    } catch (error) {
        return { success: false, error: toErrorMessage(error, 'Failed to start Microsoft sign-in.') };
    }
};

/** Resolves once the background sign-in started by startMinecraftSignIn finishes. */
export const waitMinecraftSignIn = async (): Promise<MinecraftSignInResult> => {
    if (!pendingSignIn) {
        return { success: false, error: 'No Microsoft sign-in is in progress.' };
    }

    try {
        return await pendingSignIn;
    } finally {
        pendingSignIn = null;
    }
};
