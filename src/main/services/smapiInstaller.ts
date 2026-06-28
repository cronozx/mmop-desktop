import axios from 'axios';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';

/**
 * Installs SMAPI (the Stardew Valley mod loader) into a game folder.
 *
 * SMAPI is distributed as a release zip containing per-platform installers
 * under `internal/<platform>/SMAPI.Installer[.exe]`. The installer supports an
 * unattended mode (`--install --game-path <dir> --no-prompt`), so we download
 * the latest release, unzip it, and run the platform installer against the
 * detected Stardew folder. Mods only load when the game is launched through the
 * `StardewModdingAPI` executable this produces.
 */

const SMAPI_LATEST_RELEASE_API = 'https://api.github.com/repos/Pathoschild/SMAPI/releases/latest';
const SMAPI_MANUAL_DOWNLOAD = 'https://smapi.io';
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

export interface SmapiInstallResult {
    success: boolean;
    error?: string;
}

/** Progress updates emitted during an install so the UI can show a modal bar. */
export interface SmapiInstallProgress {
    stage: 'downloading' | 'extracting' | 'installing' | 'done';
    /** 0–100 for the download stage; omitted for indeterminate stages. */
    percent?: number;
}

type ProgressCallback = (progress: SmapiInstallProgress) => void;

/** The SMAPI loader executable name for the current platform. */
export function smapiExecutableName(): string {
    return process.platform === 'win32' ? 'StardewModdingAPI.exe' : 'StardewModdingAPI';
}

/** True when SMAPI is already installed in the given game folder. */
export function isSmapiInstalledInDir(gameDir: string): boolean {
    return fs.existsSync(path.join(gameDir, smapiExecutableName()));
}

/**
 * Polls for a file to appear, up to `timeoutMs` (0 = a single immediate check).
 * Used both to wait for the installer's exit-code sentinel and for the SMAPI
 * loader itself, whose final write can land a moment after the (elevated)
 * installer process exits, so an immediate check alone can race.
 */
async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!fs.existsSync(filePath)) {
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return true;
}

/** Resolves the GitHub release asset URL for the SMAPI installer zip. */
async function resolveInstallerZipUrl(): Promise<string> {
    const response = await axios.get(SMAPI_LATEST_RELEASE_API, {
        timeout: 20000,
        headers: { 'User-Agent': 'MMOP/1.0', Accept: 'application/vnd.github+json' },
    });
    const assets: Array<{ name?: string; browser_download_url?: string }> = response.data?.assets ?? [];
    const installer = assets.find((asset) => /installer\.zip$/i.test(asset.name ?? ''));
    if (!installer?.browser_download_url) {
        throw new Error('Could not find a SMAPI installer download in the latest release.');
    }
    return installer.browser_download_url;
}

/** Extracts every file in the zip under destDir, returning the extraction root. */
async function extractZip(zipData: Buffer, destDir: string): Promise<void> {
    const zip = await JSZip.loadAsync(zipData);
    const resolvedDest = path.resolve(destDir);
    for (const [entryName, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        const outPath = path.resolve(destDir, entryName);
        // Guard against zip-slip path traversal.
        if (outPath !== resolvedDest && !outPath.startsWith(resolvedDest + path.sep)) continue;
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, await entry.async('nodebuffer'));
    }
}

/** Finds the directory that contains the `internal/` folder within an extracted SMAPI zip. */
function findInstallerRoot(startDir: string): string | null {
    if (fs.existsSync(path.join(startDir, 'internal'))) {
        return startDir;
    }
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(startDir, { withFileTypes: true });
    } catch {
        return null;
    }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            const found = findInstallerRoot(path.join(startDir, entry.name));
            if (found) return found;
        }
    }
    return null;
}

/**
 * Pull SMAPI's own error message out of the installer output. On failure the
 * installer prints its real error and then calls Console.ReadKey() to pause,
 * which throws (we run it without an interactive console) — that .NET
 * "Unhandled exception" + stack trace would otherwise bury the actual cause.
 */
function extractInstallerError(output: string): string {
    const lines = output.split(/\r?\n/).map((line) => line.replace(/\s+$/, ''));
    const crashIndex = lines.findIndex((line) => /Unhandled exception|Cannot read keys|Console\.ReadKey|ConsolePal\.ReadKey/i.test(line));
    const meaningful = (crashIndex >= 0 ? lines.slice(0, crashIndex) : lines)
        .filter((line) => line.trim() && !/^\s*at\s/.test(line));
    return meaningful.slice(-4).join(' ').slice(0, 400);
}

/** Runs the SMAPI installer binary unattended and resolves on exit. */
function runInstaller(installerBin: string, gameDir: string): Promise<{ code: number | null; output: string; canceled: boolean }> {
    return new Promise((resolve, reject) => {
        // Run from the installer's own folder so its bundled assemblies resolve,
        // and ask SMAPI to install unattended. On Windows the installer is a
        // console app — `windowsHide` stops a console window from flashing, and
        // stdin is ignored so its interactive pauses see EOF instead of hanging.
        const child = spawn(installerBin, ['--install', '--game-path', gameDir, '--no-prompt'], {
            cwd: path.dirname(installerBin),
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });

        let output = '';
        child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
        child.stderr?.on('data', (chunk) => { output += chunk.toString(); });

        const timer = setTimeout(() => {
            child.kill();
            reject(new Error('The SMAPI installer timed out.'));
        }, INSTALL_TIMEOUT_MS);

        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('close', (code) => { clearTimeout(timer); resolve({ code, output, canceled: false }); });
    });
}

/**
 * Runs the SMAPI installer on Windows through a batch file launched by
 * Start-Process, optionally elevated.
 *
 * Critically, the installer's stdout is NOT redirected: it calls Console.Clear()
 * early (InteractiveInstaller.Run), which throws "The handle is invalid" when
 * stdout is a pipe or file instead of a real console. Start-Process gives the
 * batch a fresh (hidden) console so Clear() works; we capture only the exit code
 * via a sentinel file the batch writes, which also signals completion. stdin is
 * redirected from NUL so the installer's error-path Console.ReadKey() ("press
 * any key") gets EOF instead of blocking on the hidden console.
 *
 * `elevate` adds `-Verb RunAs`, showing the Windows UAC prompt so the installer
 * can write into protected locations (Steam under "Program Files"). A declined
 * UAC prompt surfaces as PowerShell exit 1223 (Start-Process throwing).
 */
function runSmapiInstallerWindows(installerBin: string, gameDir: string, workDir: string, elevate: boolean): Promise<{ code: number | null; output: string; canceled: boolean }> {
    return new Promise((resolve, reject) => {
        const codeFile = path.join(workDir, 'smapi-install-exitcode.txt');
        const batPath = path.join(workDir, 'mmop-smapi-install.bat');
        try { fs.rmSync(codeFile, { force: true }); } catch { /* ignore */ }

        // The (possibly elevated) process writes the exit code into our temp dir.
        // No stdout redirect — that would break the installer's Console.Clear().
        const batContent =
            '@echo off\r\n'
            + `"${installerBin}" --install --game-path "${gameDir}" --no-prompt < NUL\r\n`
            // Parenthesized so a single-digit exit code isn't parsed as a stream
            // redirect (cmd reads "echo 0> file" as "redirect handle 0").
            + `(echo %ERRORLEVEL%)> "${codeFile}"\r\n`;
        fs.writeFileSync(batPath, batContent);

        // No -Wait: it can hang for elevated processes. PowerShell only launches
        // the bat (UAC prompt when elevated) and exits; completion is detected
        // below by waiting for the exit-code file the bat writes on exit.
        const escape = (value: string): string => value.replace(/'/g, "''");
        const verb = elevate ? '-Verb RunAs ' : '';
        const psCommand =
            `try { ` +
            `Start-Process -FilePath '${escape(batPath)}' -WorkingDirectory '${escape(path.dirname(installerBin))}' ` +
            `${verb}-WindowStyle Hidden -ErrorAction Stop; ` +
            `exit 0 ` +
            `} catch { Write-Error $_.Exception.Message; exit 1223 }`;

        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });

        let psOutput = '';
        child.stdout?.on('data', (chunk) => { psOutput += chunk.toString(); });
        child.stderr?.on('data', (chunk) => { psOutput += chunk.toString(); });

        const timer = setTimeout(() => {
            child.kill();
            reject(new Error('The SMAPI installer timed out.'));
        }, INSTALL_TIMEOUT_MS);

        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('close', (psCode) => {
            clearTimeout(timer);
            void (async () => {
                if (psCode === 1223 || /cancell?ed by the user|operation was cancell?ed/i.test(psOutput)) {
                    console.error('[smapi] install cancelled at UAC prompt:', psOutput.trim());
                    resolve({ code: 1223, output: psOutput, canceled: true });
                    return;
                }

                // Start-Process returns once the process is launched, so wait for the
                // exit-code sentinel the batch writes when the installer exits.
                await waitForFile(codeFile, INSTALL_TIMEOUT_MS);
                let code: number | null = null;
                try {
                    const parsed = Number.parseInt(fs.readFileSync(codeFile, 'utf8').trim(), 10);
                    if (!Number.isNaN(parsed)) code = parsed;
                } catch { /* no sentinel → unknown exit code */ }

                console.log(`[smapi] install finished (elevated=${elevate}) installerExit=${code}`);
                resolve({ code, output: psOutput, canceled: false });
            })();
        });
    });
}

/**
 * Downloads and runs the SMAPI installer against `gameDir`. Returns success
 * once the `StardewModdingAPI` loader exists in the folder.
 */
export async function installSmapi(gameDir: string, onProgress?: ProgressCallback): Promise<SmapiInstallResult> {
    const report = (progress: SmapiInstallProgress): void => {
        try { onProgress?.(progress); } catch { /* progress is best-effort */ }
    };

    if (!gameDir || !fs.existsSync(gameDir)) {
        return { success: false, error: 'Could not locate the Stardew Valley folder to install SMAPI into.' };
    }

    if (isSmapiInstalledInDir(gameDir)) {
        return { success: true };
    }

    // The installer writes StardewModdingAPI(.exe) and a `Mods` folder into the
    // game directory. When Stardew lives under a protected location (default
    // Steam is `C:\Program Files (x86)\...` on Windows), an unelevated write
    // fails. On Windows we re-run the installer elevated (a UAC prompt) for those
    // folders; elsewhere there is no UAC equivalent, so it stays a hard error.
    const isWindows = process.platform === 'win32';
    const underProgramFiles = /[\\/]Program Files( \(x86\))?[\\/]/i.test(gameDir);
    let runElevated = false;
    try {
        fs.accessSync(gameDir, fs.constants.W_OK);
        // accessSync can't account for Windows UAC virtualization of Program
        // Files, so elevate there even when the write check appears to pass.
        runElevated = isWindows && underProgramFiles;
    } catch {
        if (isWindows) {
            runElevated = true;
        } else {
            return {
                success: false,
                error: `Cannot install SMAPI into "${gameDir}". MMOP does not have permission to write to your Stardew Valley folder. You can also install it manually from ${SMAPI_MANUAL_DOWNLOAD}.`,
            };
        }
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmop-smapi-'));
    try {
        const zipUrl = await resolveInstallerZipUrl();
        report({ stage: 'downloading', percent: 0 });
        const download = await axios.get(zipUrl, {
            responseType: 'arraybuffer',
            timeout: 120000,
            headers: { 'User-Agent': 'MMOP/1.0' },
            onDownloadProgress: (event) => {
                if (event.total) {
                    report({ stage: 'downloading', percent: Math.round((event.loaded / event.total) * 100) });
                }
            },
        });

        report({ stage: 'extracting' });
        const extractDir = path.join(workDir, 'extracted');
        fs.mkdirSync(extractDir, { recursive: true });
        await extractZip(Buffer.from(download.data), extractDir);

        const root = findInstallerRoot(extractDir);
        if (!root) {
            return { success: false, error: 'The downloaded SMAPI installer was malformed.' };
        }

        const platformDir = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macOS' : 'linux';
        const installerBin = path.join(root, 'internal', platformDir, process.platform === 'win32' ? 'SMAPI.Installer.exe' : 'SMAPI.Installer');
        if (!fs.existsSync(installerBin)) {
            return { success: false, error: `SMAPI installer for ${platformDir} was not found in the download.` };
        }

        if (process.platform !== 'win32') {
            // Clear macOS quarantine on the internal payload and make the binary
            // executable, mirroring SMAPI's own launcher scripts.
            if (process.platform === 'darwin') {
                await new Promise<void>((resolve) => {
                    const xattr = spawn('xattr', ['-r', '-d', 'com.apple.quarantine', path.join(root, 'internal')], { stdio: 'ignore' });
                    xattr.once('error', () => resolve());
                    xattr.once('close', () => resolve());
                });
            }
            try { fs.chmodSync(installerBin, 0o755); } catch { /* best effort */ }
        }

        report({ stage: 'installing' });
        // Windows always runs through Start-Process so the installer gets a real
        // console (its Console.Clear() throws otherwise); `runElevated` adds the
        // admin (UAC) prompt for protected folders. Other platforms spawn directly.
        const { output, canceled, code } = isWindows
            ? await runSmapiInstallerWindows(installerBin, gameDir, workDir, runElevated)
            : await runInstaller(installerBin, gameDir);

        // The installer process exits slightly before its final writes settle, so
        // give the loader a moment to appear before deciding the install failed.
        const loaderPath = path.join(gameDir, smapiExecutableName());
        if (await waitForFile(loaderPath, isWindows ? 8000 : 0)) {
            report({ stage: 'done' });
            return { success: true };
        }

        // The user dismissed the Windows admin (UAC) prompt, so nothing ran.
        if (canceled) {
            return {
                success: false,
                error: `SMAPI needs administrator permission to install into "${gameDir}". When Windows asks, choose "Yes" to allow it, then try again. You can also install it manually from ${SMAPI_MANUAL_DOWNLOAD}.`,
            };
        }

        // Surface SMAPI's own error (with the .NET ReadKey crash noise stripped)
        // when we have it (non-Windows). On Windows the installer keeps its own
        // console, so we report its exit code instead of capturing its output.
        const detail = extractInstallerError(output);
        const elevationHint = isWindows && underProgramFiles
            ? ' Your game is under "Program Files", which needs administrator rights — approve the Windows prompt and try again, or install SMAPI manually.'
            : '';
        return {
            success: false,
            error: (detail
                ? `SMAPI couldn't finish installing: ${detail}.`
                : `SMAPI installation did not complete${typeof code === 'number' ? ` (installer exit code ${code})` : ''}.`)
                + elevationHint
                + ` You can also install it manually from ${SMAPI_MANUAL_DOWNLOAD}.`,
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to install SMAPI: ${(error as Error).message}. You can install it manually from ${SMAPI_MANUAL_DOWNLOAD}.`,
        };
    } finally {
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
    }
}
