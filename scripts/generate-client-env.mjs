// Build step: bake the client-safe runtime config into the packaged app.
//
// The installed desktop app can't read the developer .env (its cwd is `/`, not
// the repo), so we write the handful of values the *client* legitimately needs
// into dist/client-env.json, which ships inside the asar and is loaded by
// src/main/utils/loadClientEnv.ts. Server-only secrets (MONGO_URI, JWT, Stripe,
// Auth0 Management) are intentionally NOT included — they live on the backend.
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// Only client-safe values: Auth0/Microsoft client ids are public identifiers,
// and the CurseForge key powers mod search (rotatable).
const CLIENT_ENV_KEYS = [
    'CURSEFORGE_API_KEY',
    'MICROSOFT_OAUTH_CLIENT_ID',
    'AUTH0_DOMAIN',
    'AUTH0_CLIENT_ID',
    'AUTH0_AUDIENCE',
];

const out = {};
for (const key of CLIENT_ENV_KEYS) {
    if (process.env[key]) out[key] = process.env[key];
}

const distDir = path.resolve('dist');
fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(path.join(distDir, 'client-env.json'), `${JSON.stringify(out, null, 2)}\n`);

const present = Object.keys(out);
console.log(`Wrote dist/client-env.json (${present.length ? present.join(', ') : 'no client vars found'}).`);

const missing = CLIENT_ENV_KEYS.filter((k) => !out[k]);
if (missing.length) {
    console.warn(`[client-env] missing values (the packaged app will lack these): ${missing.join(', ')}`);
}

// Without these the packaged app can't sign in or download mods, which is a
// broken release. Fail the build in CI so we never publish such an artifact;
// local dev (CI unset) only warns, so partial setups can still build.
const REQUIRED_IN_CI = ['AUTH0_DOMAIN', 'AUTH0_CLIENT_ID', 'AUTH0_AUDIENCE'];
const missingRequired = REQUIRED_IN_CI.filter((k) => !out[k]);
if (process.env.CI === 'true' && missingRequired.length) {
    console.error(`[client-env] FATAL: required client config missing in CI: ${missingRequired.join(', ')}. Add them as GitHub Actions secrets so the release isn't shipped broken.`);
    process.exit(1);
}
