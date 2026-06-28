import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

/**
 * Populates process.env with the client's runtime config for BOTH dev and
 * packaged builds. Import this first in the Electron main entry, before any
 * module that reads these vars.
 *
 * - Dev: `dotenv.config()` loads the repo `.env` (cwd is the repo).
 * - Packaged: the installed app's cwd is `/`, so `.env` isn't found. Instead we
 *   read the build-time `dist/client-env.json` (shipped in the asar; written by
 *   scripts/generate-client-env.mjs) which holds only client-safe values.
 *
 * Existing process.env values always win — we only fill what's missing, and we
 * never carry server secrets (those stay on the backend).
 */

// Dev convenience; a no-op in a packaged build where no .env is on disk.
dotenv.config();

const CLIENT_ENV_KEYS = [
    'CURSEFORGE_API_KEY',
    'MICROSOFT_OAUTH_CLIENT_ID',
    'AUTH0_DOMAIN',
    'AUTH0_CLIENT_ID',
    'AUTH0_AUDIENCE',
] as const;

try {
    // Compiled to dist/src/main/utils/loadClientEnv.js, so the bundled config is
    // three levels up at dist/client-env.json. (Absent when running from source
    // via tsx — that path falls back to the dotenv values above.)
    const here = path.dirname(fileURLToPath(import.meta.url));
    const configPath = path.join(here, '..', '..', '..', 'client-env.json');
    if (fs.existsSync(configPath)) {
        const data = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, string>;
        for (const key of CLIENT_ENV_KEYS) {
            if (!process.env[key] && typeof data[key] === 'string' && data[key]) {
                process.env[key] = data[key];
            }
        }
    }
} catch {
    // Non-fatal: fall back to whatever process.env already provides.
}
