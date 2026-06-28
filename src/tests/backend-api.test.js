import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { spawn } from 'child_process';
import jwt from 'jsonwebtoken';

dotenv.config();

// This suite spawns the real backend (tsx) and waits on a 30s health poll while
// Mongo connects, so the default 5s timeout is far too short. Each hook/test
// below passes an explicit timeout (the `jest` global isn't available at module
// scope under jest's ESM mode, so jest.setTimeout can't be used here).
const HOOK_TIMEOUT_MS = 45000;
const TEST_TIMEOUT_MS = 30000;

const hasRequiredEnv = Boolean(process.env.MONGO_URI && (process.env.BACKEND_JWT_SECRET || process.env.JWT_SECRET_KEY));
const describeIfEnv = hasRequiredEnv ? describe : describe.skip;

describeIfEnv('Backend API - Integration Tests', () => {
  const port = 8790 + Math.floor(Math.random() * 100);
  const baseUrl = `http://127.0.0.1:${port}`;
  const usernamePrefix = `bt${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 1000)}`;

  let backendProcess;
  let mongoClient;

  // Sessions are issued by Auth0 now, so tests provision a user directly and
  // mint a backend-accepted HS256 token (requireAuth still verifies these).
  const jwtSecret = process.env.BACKEND_JWT_SECRET || process.env.JWT_SECRET_KEY;
  const createSession = async (username, email) => {
    const db = mongoClient.db('modmngr');
    const { insertedId } = await db.collection('logins').insertOne({ username, email, notifications: [] });
    const userId = insertedId.toString();
    const token = jwt.sign({ userId, username }, jwtSecret, { expiresIn: '15m' });
    return { userId, token };
  };

  const api = async (path, { method = 'GET', token, body } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    return { status: response.status, data };
  };

  const waitForHealth = async () => {
    const timeoutMs = 30000;
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (response.status === 200) {
          return;
        }
      } catch {
        // Continue polling while backend boots.
      }

      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    throw new Error('Backend health check timed out');
  };

  beforeAll(async () => {
    backendProcess = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BACKEND_PORT: String(port),
        BACKEND_API_URL: baseUrl,
        BACKEND_JWT_SECRET: process.env.BACKEND_JWT_SECRET || process.env.JWT_SECRET_KEY,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const backendSpawnError = new Promise((_, reject) => {
      backendProcess.once('error', (error) => {
        reject(new Error(`Failed to start backend process: ${error.message}`));
      });
    });

    // Keep process pipes drained to avoid backpressure deadlocks in long runs.
    backendProcess.stdout?.on('data', () => {});
    backendProcess.stderr?.on('data', () => {});

    await Promise.race([waitForHealth(), backendSpawnError]);

    mongoClient = new MongoClient(process.env.MONGO_URI);
    await mongoClient.connect();
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    if (mongoClient) {
      const db = mongoClient.db('modmngr');
      await db.collection('logins').deleteMany({ username: { $regex: `^${usernamePrefix}` } });
      await db.collection('modpacks').deleteMany({ author: { $regex: `^${usernamePrefix}` } });
      await mongoClient.close();
    }

    if (backendProcess && backendProcess.exitCode === null) {
      const waitForExit = new Promise((resolve) => {
        backendProcess.once('exit', resolve);
      });

      backendProcess.kill('SIGTERM');

      const gracefulShutdown = await Promise.race([
        waitForExit.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
      ]);

      if (!gracefulShutdown && backendProcess.exitCode === null) {
        backendProcess.kill('SIGKILL');
        await waitForExit;
      }
    }
  }, HOOK_TIMEOUT_MS);

  it('handles auth + phase-2 data routes end-to-end', async () => {
    const userA = `${usernamePrefix}_a`;
    const userB = `${usernamePrefix}_b`;
    const emailA = `${userA}@example.com`;
    const emailB = `${userB}@example.com`;

    const sessionA = await createSession(userA, emailA);
    const sessionB = await createSession(userB, emailB);
    const tokenA = sessionA.token;
    const tokenB = sessionB.token;

    // Reject a malformed/unsigned token to confirm auth is still enforced.
    const unauthorized = await api('/users', { token: 'not-a-real-token' });
    expect(unauthorized.status).toBe(401);

    const usersResponse = await api('/users', { token: tokenA });
    expect(usersResponse.status).toBe(200);
    expect(Array.isArray(usersResponse.data?.users)).toBe(true);

    const gamesResponse = await api('/games', { token: tokenA });
    expect(gamesResponse.status).toBe(200);
    expect(Array.isArray(gamesResponse.data?.games)).toBe(true);

    const createModpackResponse = await api('/modpacks', {
      method: 'POST',
      token: tokenA,
      body: {
        modpack: {
          name: 'API Test Pack',
          description: 'Created by integration test',
          gameID: 1,
          author: userA,
          contributers: {},
          mods: [],
        },
      },
    });

    expect(createModpackResponse.status).toBe(201);
    const createdModpack = createModpackResponse.data?.modpack;
    expect(createdModpack?._id).toBeTruthy();

    const listModpacksResponse = await api('/modpacks', { token: tokenA });
    expect(listModpacksResponse.status).toBe(200);
    expect(Array.isArray(listModpacksResponse.data?.modpacks)).toBe(true);
    expect(listModpacksResponse.data.modpacks.some((pack) => pack._id === createdModpack._id)).toBe(true);

    const updateModpackResponse = await api(`/modpacks/${encodeURIComponent(createdModpack._id)}`, {
      method: 'PUT',
      token: tokenA,
      body: {
        updatedModpack: {
          ...createdModpack,
          contributers: {
            ...(createdModpack.contributers || {}),
            [sessionB.userId]: false,
          },
        },
      },
    });
    expect(updateModpackResponse.status).toBe(200);
    expect(updateModpackResponse.data?.success).toBe(true);

    const acceptContributorResponse = await api(`/modpacks/${encodeURIComponent(createdModpack._id)}/contributor-action`, {
      method: 'POST',
      token: tokenB,
      body: { accepted: true },
    });
    expect(acceptContributorResponse.status).toBe(200);
    expect(acceptContributorResponse.data?.success).toBe(true);

    const sendNotificationResponse = await api('/notifications/send', {
      method: 'POST',
      token: tokenA,
      body: {
        targetUserId: sessionB.userId,
        notification: {
          id: `notif_${Date.now()}`,
          type: 'alert',
          title: 'Integration Test',
          message: 'Backend notifications route works',
          unread: true,
        },
      },
    });
    expect(sendNotificationResponse.status).toBe(200);
    expect(sendNotificationResponse.data?.success).toBe(true);

    const notificationsResponse = await api(`/notifications/${encodeURIComponent(sessionB.userId)}`, {
      token: tokenB,
    });
    expect(notificationsResponse.status).toBe(200);
    expect(Array.isArray(notificationsResponse.data?.notifications)).toBe(true);
    const notificationId = notificationsResponse.data.notifications?.[0]?.id;
    expect(notificationId).toBeTruthy();

    const markReadResponse = await api('/notifications/mark-read', {
      method: 'POST',
      token: tokenB,
      body: {},
    });
    expect(markReadResponse.status).toBe(200);
    expect(markReadResponse.data?.success).toBe(true);

    const removeNotificationResponse = await api(`/notifications/${encodeURIComponent(notificationId)}`, {
      method: 'DELETE',
      token: tokenB,
    });
    expect(removeNotificationResponse.status).toBe(200);
    expect(removeNotificationResponse.data?.success).toBe(true);

    const deleteModpackResponse = await api(`/modpacks/${encodeURIComponent(createdModpack._id)}`, {
      method: 'DELETE',
      token: tokenA,
    });
    expect(deleteModpackResponse.status).toBe(200);
    expect(deleteModpackResponse.data?.success).toBe(true);
  }, TEST_TIMEOUT_MS);

  // Minecraft mod search uses Modrinth (no API key required), so this always runs.
  const testModEndpoints = it;

  testModEndpoints('supports mod search routes', async () => {
    const user = `${usernamePrefix}_mods`;
    const email = `${user}@example.com`;

    const { token } = await createSession(user, email);

    const searchResponse = await api('/mods/search?gameId=1&pageIndex=0', { token });
    expect(searchResponse.status).toBe(200);
    expect(Array.isArray(searchResponse.data?.mods)).toBe(true);

    if (searchResponse.data.mods.length > 0) {
      const firstModId = searchResponse.data.mods[0]._id;
      const byIdsResponse = await api('/mods/by-ids', {
        method: 'POST',
        token,
        body: { modIds: [firstModId] },
      });
      expect(byIdsResponse.status).toBe(200);
      expect(Array.isArray(byIdsResponse.data?.mods)).toBe(true);
    }
  }, TEST_TIMEOUT_MS);
});
