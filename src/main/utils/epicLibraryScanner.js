import fs from 'fs';
import path from 'path';

/**
 * Returns an array of Epic Games install folders by parsing Epic's manifest files
 */
export function getEpicGameInstallFolders() {
    const manifestsDir = process.env['ProgramData']
        ? path.join(process.env['ProgramData'], 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')
        : null;
    if (!manifestsDir || !fs.existsSync(manifestsDir)) return [];
    const files = fs.readdirSync(manifestsDir).filter(f => f.endsWith('.item')); // .item files are JSON
    const folders = [];
    for (const file of files) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(manifestsDir, file), 'utf-8'));
            if (data && data.InstallLocation) {
                folders.push(data.InstallLocation);
            }
        } catch {}
    }
    return folders;
}
