import {
  MICROSOFT_NOT_CONFIGURED_ERROR,
  authorizeWithXsts,
  completeMinecraftAuthChain,
  fetchMinecraftProfile,
  getMinecraftAccountStatus,
  getMinecraftSession,
  mapXstsError,
  pollForMsaTokens,
  signOutMinecraftAccount,
  startMinecraftSignIn,
  waitMinecraftSignIn,
} from '../main/services/minecraftAuth.js';

// Offline tests only — every Microsoft/Xbox/Minecraft endpoint is stubbed via
// the injectable http client, polling waits via an injectable sleep, and
// persistence uses an in-memory storage object (no electron, no network).

const URLS = {
  device: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode',
  token: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
  xbl: 'https://user.auth.xboxlive.com/user/authenticate',
  xsts: 'https://xsts.auth.xboxlive.com/xsts/authorize',
  mcLogin: 'https://api.minecraftservices.com/authentication/login_with_xbox',
  profile: 'https://api.minecraftservices.com/minecraft/profile',
};

const ok = (data) => ({ status: 200, data });

// http stub: per-URL queues of responses; the last response of a queue is
// sticky. Records every request so payloads can be asserted.
const makeHttp = (routes) => {
  const queues = new Map(
    Object.entries(routes).map(([url, responses]) => [url, Array.isArray(responses) ? [...responses] : [responses]])
  );

  const respond = (url) => {
    const queue = queues.get(url);
    if (!queue || queue.length === 0) {
      throw new Error(`Unexpected request to ${url}`);
    }
    return queue.length > 1 ? queue.shift() : queue[0];
  };

  const requests = [];
  return {
    requests,
    async post(url, body) {
      requests.push({ method: 'POST', url, body });
      return respond(url);
    },
    async get(url, headers) {
      requests.push({ method: 'GET', url, headers });
      return respond(url);
    },
  };
};

const makeStorage = (initial = null) => {
  let data = initial;
  return {
    load: () => data,
    save: (next) => { data = next; },
    clear: () => { data = null; },
    peek: () => data,
  };
};

const makeSleep = () => {
  const calls = [];
  const sleep = async (ms) => { calls.push(ms); };
  return { sleep, calls };
};

const deviceCodeResponse = ok({
  device_code: 'device-code-1',
  user_code: 'ABCD-1234',
  verification_uri: 'https://www.microsoft.com/link',
  interval: 5,
  expires_in: 900,
});

const msaTokenSuccess = ok({
  access_token: 'msa-access',
  refresh_token: 'msa-refresh',
  expires_in: 3600,
});

const xblSuccess = ok({ Token: 'xbl-token', DisplayClaims: { xui: [{ uhs: 'user-hash' }] } });
const xstsSuccess = ok({ Token: 'xsts-token' });
const mcLoginSuccess = ok({ access_token: 'mc-token', expires_in: 86400 });
const profileSuccess = ok({ id: 'profile-uuid', name: 'Steve' });

const happyChainRoutes = {
  [URLS.xbl]: xblSuccess,
  [URLS.xsts]: xstsSuccess,
  [URLS.mcLogin]: mcLoginSuccess,
  [URLS.profile]: profileSuccess,
};

const NOW = 1_750_000_000_000;

describe('device-code sign-in (start + wait)', () => {
  it('returns the user code fast, then completes the full chain and persists the session', async () => {
    const http = makeHttp({
      [URLS.device]: deviceCodeResponse,
      [URLS.token]: [
        { status: 400, data: { error: 'authorization_pending' } },
        msaTokenSuccess,
      ],
      ...happyChainRoutes,
    });
    const storage = makeStorage();
    const { sleep } = makeSleep();

    const started = await startMinecraftSignIn({ http, storage, clientId: 'client-1', sleep, now: () => NOW });
    expect(started).toEqual({
      success: true,
      userCode: 'ABCD-1234',
      verificationUri: 'https://www.microsoft.com/link',
    });

    const result = await waitMinecraftSignIn();
    expect(result).toEqual({ success: true, profileName: 'Steve' });

    expect(storage.peek()).toEqual({
      msaRefreshToken: 'msa-refresh',
      minecraftAccessToken: 'mc-token',
      minecraftTokenExpiresAt: NOW + 86400 * 1000,
      profile: { id: 'profile-uuid', name: 'Steve' },
    });

    // The Minecraft login must carry the XBL3.0 identity token built from
    // the XSTS token and the Xbox user hash.
    const mcLoginRequest = http.requests.find((request) => request.url === URLS.mcLogin);
    expect(mcLoginRequest.body).toEqual({ identityToken: 'XBL3.0 x=user-hash;xsts-token' });
  });

  it('fails fast when no Microsoft client id is configured', async () => {
    const previousPrimary = process.env.MICROSOFT_OAUTH_CLIENT_ID;
    const previousFallback = process.env.MSA_CLIENT_ID;
    delete process.env.MICROSOFT_OAUTH_CLIENT_ID;
    delete process.env.MSA_CLIENT_ID;

    try {
      const result = await startMinecraftSignIn({ http: makeHttp({}), storage: makeStorage() });
      expect(result).toEqual({ success: false, error: MICROSOFT_NOT_CONFIGURED_ERROR });
    } finally {
      if (previousPrimary !== undefined) process.env.MICROSOFT_OAUTH_CLIENT_ID = previousPrimary;
      if (previousFallback !== undefined) process.env.MSA_CLIENT_ID = previousFallback;
    }
  });

  it('reports when no sign-in is in progress', async () => {
    const result = await waitMinecraftSignIn();
    expect(result).toEqual({ success: false, error: 'No Microsoft sign-in is in progress.' });
  });
});

describe('pollForMsaTokens', () => {
  it('keeps polling through authorization_pending and slows down on slow_down', async () => {
    const http = makeHttp({
      [URLS.token]: [
        { status: 400, data: { error: 'slow_down' } },
        { status: 400, data: { error: 'authorization_pending' } },
        msaTokenSuccess,
      ],
    });
    const { sleep, calls } = makeSleep();

    const tokens = await pollForMsaTokens(http, 'client-1', 'device-code-1', { intervalSec: 5, sleep });
    expect(tokens).toEqual({ accessToken: 'msa-access', refreshToken: 'msa-refresh', expiresInSec: 3600 });
    // 5s before the first poll, then +5s after slow_down for the rest.
    expect(calls).toEqual([5000, 10000, 10000]);
  });

  it('throws a restart-friendly error on expired_token', async () => {
    const http = makeHttp({ [URLS.token]: { status: 400, data: { error: 'expired_token' } } });
    const { sleep } = makeSleep();

    await expect(pollForMsaTokens(http, 'client-1', 'device-code-1', { sleep }))
      .rejects.toThrow(/expired before it was approved/);
  });

  it('throws a cancellation error on access_denied', async () => {
    const http = makeHttp({ [URLS.token]: { status: 400, data: { error: 'access_denied' } } });
    const { sleep } = makeSleep();

    await expect(pollForMsaTokens(http, 'client-1', 'device-code-1', { sleep }))
      .rejects.toThrow('Microsoft sign-in was canceled.');
  });
});

describe('XSTS error mapping', () => {
  it('maps the known XErr codes to actionable messages', () => {
    expect(mapXstsError(2148916233)).toMatch(/no Xbox profile/);
    expect(mapXstsError(2148916238)).toMatch(/child/);
    expect(mapXstsError(999)).toMatch(/denied/);
  });

  it('surfaces the mapped message when XSTS rejects the sign-in', async () => {
    const http = makeHttp({ [URLS.xsts]: { status: 401, data: { XErr: 2148916233 } } });

    await expect(authorizeWithXsts(http, 'xbl-token')).rejects.toThrow(/no Xbox profile/);
  });
});

describe('Minecraft profile', () => {
  it('maps a 404 to a friendly "does not own Minecraft" error', async () => {
    const http = makeHttp({ [URLS.profile]: { status: 404, data: {} } });

    await expect(fetchMinecraftProfile(http, 'mc-token'))
      .rejects.toThrow('This Microsoft account does not own Minecraft: Java Edition.');
  });

  it('the full chain propagates the no-ownership error', async () => {
    const http = makeHttp({ ...happyChainRoutes, [URLS.profile]: { status: 404, data: {} } });
    const msaTokens = { accessToken: 'msa-access', refreshToken: 'msa-refresh', expiresInSec: 3600 };

    await expect(completeMinecraftAuthChain(http, msaTokens)).rejects.toThrow(/does not own Minecraft/);
  });
});

describe('getMinecraftSession', () => {
  const storedSession = (expiresAt) => ({
    msaRefreshToken: 'msa-refresh',
    minecraftAccessToken: 'mc-token-old',
    minecraftTokenExpiresAt: expiresAt,
    profile: { id: 'profile-uuid', name: 'Steve' },
  });

  it('returns the stored session without network when the token is still valid', async () => {
    const storage = makeStorage(storedSession(NOW + 10 * 60 * 1000));
    const http = makeHttp({}); // any request would throw

    const session = await getMinecraftSession({ http, storage, clientId: 'client-1', now: () => NOW });
    expect(session).toEqual({ accessToken: 'mc-token-old', profile: { id: 'profile-uuid', name: 'Steve' } });
  });

  it('refreshes through the full chain when the token expires within the 60s leeway', async () => {
    const storage = makeStorage(storedSession(NOW + 30 * 1000));
    const http = makeHttp({
      [URLS.token]: ok({ access_token: 'msa-access-2', refresh_token: 'msa-refresh-2', expires_in: 3600 }),
      ...happyChainRoutes,
    });

    const session = await getMinecraftSession({ http, storage, clientId: 'client-1', now: () => NOW });
    expect(session).toEqual({ accessToken: 'mc-token', profile: { id: 'profile-uuid', name: 'Steve' } });
    expect(storage.peek()).toMatchObject({
      msaRefreshToken: 'msa-refresh-2',
      minecraftAccessToken: 'mc-token',
      minecraftTokenExpiresAt: NOW + 86400 * 1000,
    });

    const refreshRequest = http.requests.find((request) => request.url === URLS.token);
    expect(String(refreshRequest.body)).toContain('grant_type=refresh_token');
    expect(String(refreshRequest.body)).toContain('refresh_token=msa-refresh');
  });

  it('clears the stored session and returns null when the refresh fails', async () => {
    const storage = makeStorage(storedSession(NOW - 1000));
    const http = makeHttp({
      [URLS.token]: { status: 400, data: { error: 'invalid_grant', error_description: 'Refresh token revoked' } },
    });

    const session = await getMinecraftSession({ http, storage, clientId: 'client-1', now: () => NOW });
    expect(session).toBeNull();
    expect(storage.peek()).toBeNull();
  });

  it('returns null for an empty store', async () => {
    const session = await getMinecraftSession({ http: makeHttp({}), storage: makeStorage(), clientId: 'client-1' });
    expect(session).toBeNull();
  });
});

describe('account status + sign out', () => {
  it('reports the stored profile name without touching the network', () => {
    const storage = makeStorage({
      msaRefreshToken: 'msa-refresh',
      minecraftAccessToken: 'mc-token',
      minecraftTokenExpiresAt: NOW,
      profile: { id: 'profile-uuid', name: 'Steve' },
    });

    expect(getMinecraftAccountStatus(storage)).toEqual({ signedIn: true, profileName: 'Steve' });

    signOutMinecraftAccount(storage);
    expect(getMinecraftAccountStatus(storage)).toEqual({ signedIn: false });
    expect(storage.peek()).toBeNull();
  });
});
