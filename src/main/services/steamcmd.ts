import os from 'os';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import axios from 'axios';
import JSZip from 'jszip';

/**
 * SteamCMD integration: fetch Steam Workshop items (tModLoader mods for Terraria)
 * that the Web API can't serve directly. SteamCMD is located on PATH or in a
 * managed copy under the user's home; if absent, its small bootstrap is
 * downloaded from Valve's CDN and self-updates on first run.
 *
 * Downloads are anonymous (`+login anonymous`), which works for tModLoader's app
 * (1281930). Main-process only — never imported by the backend.
 */

const MANAGED_ROOT = path.join(os.homedir(), '.mmop', 'steamcmd');

const BOOTSTRAP_URL: Partial<Record<NodeJS.Platform, string>> = {
    win32: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip',
    linux: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz',
    darwin: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_osx.tar.gz',
};

const STEAMCMD_RUN_TIMEOUT_MS = 10 * 60 * 1000; // self-update + large mods can be slow

const executableName = (): string => (process.platform === 'win32' ? 'steamcmd.exe' : 'steamcmd.sh');

// GUI / packaged Electron processes can inherit a stripped PATH (missing /bin,
// /usr/bin), so bare-command spawns like `bash`/`tar` fail with `spawn … ENOENT`.
// Augment PATH for every child we spawn, and resolve bash to an absolute path.
const SYSTEM_BIN_DIRS = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/usr/sbin', '/sbin'];

function spawnEnv(): NodeJS.ProcessEnv {
    if (process.platform === 'win32') return process.env;
    const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    for (const dir of SYSTEM_BIN_DIRS) {
        if (!dirs.includes(dir)) dirs.push(dir);
    }
    return { ...process.env, PATH: dirs.join(path.delimiter) };
}

/** Absolute path to bash, so spawning never depends on bash being on PATH. */
function resolveBash(): string {
    for (const candidate of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash']) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return 'bash';
}

/** A SteamCMD already on PATH, if any (preferred over the managed copy). */
function steamCmdOnPath(): string | null {
    const candidates = process.platform === 'win32' ? ['steamcmd.exe', 'steamcmd'] : ['steamcmd'];
    const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
        for (const name of candidates) {
            const full = path.join(dir, name);
            if (fs.existsSync(full)) return full;
        }
    }
    return null;
}

async function downloadTo(url: string, destFile: string): Promise<void> {
    const response = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 120000 });
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.writeFileSync(destFile, Buffer.from(response.data));
}

/** Extract the platform bootstrap archive into MANAGED_ROOT. */
async function extractBootstrap(archivePath: string): Promise<void> {
    fs.mkdirSync(MANAGED_ROOT, { recursive: true });

    if (process.platform === 'win32') {
        const zip = await JSZip.loadAsync(fs.readFileSync(archivePath));
        for (const [name, entry] of Object.entries(zip.files)) {
            if (entry.dir) continue;
            const outPath = path.resolve(MANAGED_ROOT, name);
            if (!outPath.startsWith(path.resolve(MANAGED_ROOT) + path.sep)) continue; // zip-slip guard
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, await entry.async('nodebuffer'));
        }
        return;
    }

    // macOS / Linux ship a .tar.gz; use the system tar (always present there).
    await new Promise<void>((resolve, reject) => {
        const child = spawn('tar', ['-xzf', archivePath, '-C', MANAGED_ROOT], { stdio: 'ignore', env: spawnEnv() });
        child.once('error', reject);
        child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}`))));
    });
}

/**
 * Returns a runnable SteamCMD path, bootstrapping the managed copy if needed.
 * Returns null when SteamCMD can't be located or installed.
 */
export async function ensureSteamCmd(): Promise<string | null> {
    const onPath = steamCmdOnPath();
    if (onPath) return onPath;

    const managed = path.join(MANAGED_ROOT, executableName());
    if (fs.existsSync(managed)) return managed;

    const url = BOOTSTRAP_URL[process.platform];
    if (!url) {
        console.error(`SteamCMD is not available for platform ${process.platform}.`);
        return null;
    }

    try {
        const archivePath = path.join(MANAGED_ROOT, path.basename(url));
        await downloadTo(url, archivePath);
        await extractBootstrap(archivePath);
        try { fs.rmSync(archivePath, { force: true }); } catch { /* ignore */ }

        if (!fs.existsSync(managed)) {
            console.error('SteamCMD bootstrap extracted but the launcher script was not found.');
            return null;
        }
        if (process.platform !== 'win32') {
            try { fs.chmodSync(managed, 0o755); } catch { /* best effort */ }
        }
        return managed;
    } catch (error) {
        console.error('Failed to install SteamCMD:', error);
        return null;
    }
}

function runSteamCmd(steamCmdPath: string, args: string[]): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve) => {
        // On non-Windows the launcher is a shell script; invoke bash by absolute
        // path so it works even when the process PATH is stripped.
        const command = process.platform === 'win32' ? steamCmdPath : resolveBash();
        const fullArgs = process.platform === 'win32' ? args : [steamCmdPath, ...args];

        // cwd is the launcher's own directory — it always exists and is where
        // SteamCMD writes steamapps/ (MANAGED_ROOT may not exist when SteamCMD
        // was found on PATH instead of bootstrapped).
        const child = spawn(command, fullArgs, { cwd: path.dirname(steamCmdPath), stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv() });
        let output = '';
        const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, STEAMCMD_RUN_TIMEOUT_MS);

        child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
        child.stderr?.on('data', (chunk) => { output += chunk.toString(); });
        child.once('error', (error) => { clearTimeout(timer); resolve({ code: null, output: `${output}\n${error.message}` }); });
        child.once('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
    });
}

/** Where SteamCMD writes a downloaded workshop item. */
export function workshopContentDir(appId: number, pubFileId: string): string {
    const root = steamCmdOnPath() ? path.dirname(steamCmdOnPath() as string) : MANAGED_ROOT;
    return path.join(root, 'steamapps', 'workshop', 'content', String(appId), pubFileId);
}

/**
 * Downloads a single Workshop item via SteamCMD and returns the directory it was
 * written to (which holds the `.tmod` file for tModLoader items). Returns an
 * error string on any failure.
 */
export async function downloadWorkshopItem(appId: number, pubFileId: string): Promise<{ dir: string } | { error: string }> {
    const steamCmdPath = await ensureSteamCmd();
    if (!steamCmdPath) {
        return { error: 'SteamCMD is not installed and could not be downloaded automatically.' };
    }

    const { code, output } = await runSteamCmd(steamCmdPath, [
        '+login', 'anonymous',
        '+workshop_download_item', String(appId), pubFileId,
        '+quit',
    ]);

    const contentDir = workshopContentDir(appId, pubFileId);
    // SteamCMD can exit non-zero on transient self-update churn even when the
    // item downloaded, so trust the on-disk result as the real success signal.
    if (fs.existsSync(contentDir) && fs.readdirSync(contentDir).length > 0) {
        return { dir: contentDir };
    }

    const success = /Success\. Downloaded item/i.test(output);
    if (success && fs.existsSync(contentDir)) {
        return { dir: contentDir };
    }

    console.error(`SteamCMD download failed for ${appId}/${pubFileId} (exit ${code}):`, output.slice(-2000));
    return { error: 'SteamCMD could not download this Workshop item. See the logs for details.' };
}

/** Finds the first `.tmod` file in a downloaded workshop item directory (recursive). */
export function findTmodFile(dir: string): string | null {
    let found: string | null = null;
    const walk = (current: string): void => {
        if (found) return;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (found) return;
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile() && entry.name.toLowerCase().endsWith('.tmod')) found = full;
        }
    };
    walk(dir);
    return found;
}
