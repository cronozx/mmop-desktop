import fs from 'fs';
import os from 'os';
import path from 'path';

function getPrimarySteamPath() {
    const home = os.homedir();
    const candidates = [
        process.env.STEAM_PATH,
        // Windows
        process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Steam') : null,
        process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Steam') : null,
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Steam') : null,
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Steam') : null,
        process.env.SystemDrive ? path.join(process.env.SystemDrive, 'Steam') : null,
        // macOS
        home ? path.join(home, 'Library', 'Application Support', 'Steam') : null,
        // Linux
        home ? path.join(home, '.steam', 'steam') : null,
        home ? path.join(home, '.local', 'share', 'Steam') : null,
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
}

/**
 * Returns an array of Steam library folders by parsing libraryfolders.vdf
 */
export function getSteamLibraryFolders() {
    const steamPath = getPrimarySteamPath();
    if (!steamPath) return [];

    const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
    if (!fs.existsSync(vdfPath)) return [steamPath];

    const content = fs.readFileSync(vdfPath, 'utf-8');
    const folders = [path.join(steamPath)];
    let match;

    // New VDF format (modern Steam): "path"    "D:\\SteamLibrary"
    const newFormatRegex = /"path"\s+"([^"]+)"/g;
    let newFormatFound = false;
    while ((match = newFormatRegex.exec(content))) {
        newFormatFound = true;
        folders.push(path.normalize(match[1]));
    }

    // Old VDF format (legacy Steam): "1"    "D:\\SteamLibrary"
    if (!newFormatFound) {
        const oldFormatRegex = /"\d+"\s+"([^"]+)"/g;
        while ((match = oldFormatRegex.exec(content))) {
            folders.push(path.normalize(match[1]));
        }
    }

    return folders;
}

/**
 * Returns all installed game folders found under each Steam library's steamapps/common directory.
 */
export function getAllSteamCommonGameFolders() {
    const libraries = getSteamLibraryFolders();
    const allFolders = [];

    for (const lib of libraries) {
        const commonDir = path.join(lib, 'steamapps', 'common');
        if (!fs.existsSync(commonDir)) {
            continue;
        }

        try {
            const entries = fs.readdirSync(commonDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    allFolders.push(path.join(commonDir, entry.name));
                }
            }
        } catch {
            // Ignore unreadable library directories and continue scanning others.
        }
    }

    return allFolders;
}

/**
 * Returns an array of candidate game install folders for a given Steam game folder name
 */
export function findSteamGameFolders(gameFolderName) {
    const libraries = getSteamLibraryFolders();
    const candidates = [];
    for (const lib of libraries) {
        const candidate = path.join(lib, 'steamapps', 'common', gameFolderName);
        if (fs.existsSync(candidate)) {
            candidates.push(candidate);
        }
    }
    return candidates;
}
