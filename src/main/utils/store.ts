import Store from 'electron-store';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

interface StoreType {
  authToken?: string;
  authRefreshToken?: string;
  // Which auth flow issued the current session, so refresh hits the right
  // endpoint: 'auth0' refreshes via Auth0, anything else via the MMOP backend.
  authProvider?: 'auth0' | 'local';
  gameExecutables?: Record<number, string>;
  gameExecutableFirstOpenHandled?: Record<number, boolean>;
  defaultMinecraftMemoryMb?: number;
  // Serialized Microsoft/Minecraft session (see src/main/services/minecraftAuth.ts).
  minecraftAuth?: string;
}

export type AuthProvider = 'auth0' | 'local';

type SecureStoreKey = 'authToken' | 'authRefreshToken' | 'minecraftAuth';

const SECURE_VALUE_PREFIX = 'safeStorage:';
const STORE_NAME = 'config';

let safeStorage:
  | {
      isEncryptionAvailable: () => boolean;
      encryptString: (value: string) => Buffer;
      decryptString: (value: Buffer) => string;
    }
  | undefined;

try {
  const require = createRequire(import.meta.url);
  ({ safeStorage } = require('electron'));
} catch {
  // safeStorage not available outside Electron main process
}

function createMemoryStore(): Store<StoreType> {
  const map = new Map<string, unknown>();

  return {
    get(key: string): unknown {
      return map.get(key);
    },
    set(key: string, value: unknown): void {
      map.set(key, value);
    },
    has(key: string): boolean {
      return map.has(key);
    },
    delete(key: string): void {
      map.delete(key);
    },
  } as unknown as Store<StoreType>;
}

function tryDeleteStoreFiles(): void {
  try {
    const require = createRequire(import.meta.url);
    const { app } = require('electron') as { app?: { getPath?: (name: string) => string } };
    const userData = app?.getPath?.('userData');
    if (!userData) {
      return;
    }

    const filesToDelete = [
      `${STORE_NAME}.json`,
      `${STORE_NAME}.json.bak`,
      `${STORE_NAME}.json.old`,
    ];

    for (const fileName of filesToDelete) {
      const filePath = path.join(userData, fileName);
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true });
      }
    }
  } catch {
    // Best-effort cleanup only.
  }
}

function createStoreSafely(): Store<StoreType> {
  const options = {
    name: STORE_NAME,
    // Recover automatically if an older incompatible/corrupted store file exists.
    clearInvalidConfig: true,
  };

  try {
    return new Store<StoreType>(options);
  } catch {
    // Constructor can still throw for malformed legacy files in some environments.
    tryDeleteStoreFiles();

    try {
      return new Store<StoreType>(options);
    } catch {
      // Never crash app startup because persisted config is unreadable.
      return createMemoryStore();
    }
  }
}

const store = createStoreSafely();

function encodeSecureValue(value: string): string {
  if (!safeStorage?.isEncryptionAvailable()) {
    return value;
  }

  const encrypted = safeStorage.encryptString(value).toString('base64');
  return `${SECURE_VALUE_PREFIX}${encrypted}`;
}

function decodeSecureValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  if (!value.startsWith(SECURE_VALUE_PREFIX)) {
    return value;
  }

  if (!safeStorage?.isEncryptionAvailable()) {
    return undefined;
  }

  try {
    const encrypted = Buffer.from(value.slice(SECURE_VALUE_PREFIX.length), 'base64');
    return safeStorage.decryptString(encrypted);
  } catch {
    return undefined;
  }
}

export function setSecureValue(key: SecureStoreKey, value: string): void {
  store.set(key, encodeSecureValue(value));
}

export function getSecureValue(key: SecureStoreKey): string | undefined {
  const storedValue = store.get(key);
  return typeof storedValue === 'string' ? decodeSecureValue(storedValue) : undefined;
}

export function hasSecureValue(key: SecureStoreKey): boolean {
  return store.has(key);
}

export function deleteSecureValue(key: SecureStoreKey): void {
  store.delete(key);
}

export function setAuthProvider(provider: AuthProvider): void {
  store.set('authProvider', provider);
}

export function getAuthProvider(): AuthProvider | undefined {
  const value = store.get('authProvider');
  return value === 'auth0' || value === 'local' ? value : undefined;
}

export function clearAuthProvider(): void {
  store.delete('authProvider');
}

export default store;