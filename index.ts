// Must be first: populates process.env (dev .env or the packaged
// dist/client-env.json) before any module reads AUTH0_* etc.
import './src/main/utils/loadClientEnv.js';
import { app, BrowserWindow, session, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { connectDB, disconnectDB } from './src/main/database/database.js';
import { assertBackendConfiguredForRuntime } from './src/main/utils/runtimeMode.js';
import { registerSystemHandlers } from './src/main/ipc/system.js';
import { registerAuthHandlers } from './src/main/ipc/auth.js';
import { registerGamesHandlers } from './src/main/ipc/games.js';
import { registerModpackHandlers } from './src/main/ipc/modpacks.js';
import { registerNotificationHandlers } from './src/main/ipc/notifications.js';
import { registerMinecraftHandlers } from './src/main/ipc/minecraft.js';
import { registerGameExecutableHandlers } from './src/main/ipc/gameExecutables.js';
import { registerModManagementHandlers } from './src/main/ipc/modManagement.js';
import { registerGameLaunchHandlers } from './src/main/ipc/gameLaunch.js';
import { cancelPendingAuth0Login } from './src/main/services/auth0.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const squirrelStartup = require('electron-squirrel-startup');

if (squirrelStartup) {
    app.quit();
    process.exit(0);
}

// Packaged builds talk to the hosted backend. Pin BACKEND_API_URL here (when not
// already set) so EVERY code path that reads it directly — e.g. the mod-download
// token check in database.ts — resolves the same backend that getBackendApiBaseUrl
// uses. Without this, those direct readers fall back to local JWT validation,
// which always fails for Auth0 tokens and makes mod downloads fail.
if (app.isPackaged && !process.env.BACKEND_API_URL) {
    process.env.BACKEND_API_URL = 'https://www.mmop.app/api';
}

assertBackendConfiguredForRuntime({
    nodeEnv: process.env.NODE_ENV,
    backendApiUrl: process.env.BACKEND_API_URL,
    isPackaged: app.isPackaged,
    requireBackendApiInProduction: process.env.REQUIRE_BACKEND_API_IN_PRODUCTION === 'true',
});

if (!app.isPackaged) {
    require('electron-reload')(__dirname, {
        electron: path.join(__dirname, 'node_modules', '.bin', 'electron'),
        hardResetMethod: 'exit'
    });
}

const createIPCHandlers = (): void => {
    registerSystemHandlers();
    registerAuthHandlers();
    registerGamesHandlers();
    registerModpackHandlers();
    registerNotificationHandlers();
    registerMinecraftHandlers();
    registerGameExecutableHandlers();
    registerModManagementHandlers();
    registerGameLaunchHandlers();
};

const createWindow = (): void => {
    const isWindows = process.platform === 'win32';
    const preloadPath = app.isPackaged
        ? path.join(__dirname, 'preload.cjs')
        : path.join(__dirname, 'dist', 'preload.cjs');
    const rendererHtmlPath = app.isPackaged
        ? path.join(__dirname, 'index.html')
        : path.join(__dirname, 'dist', 'index.html');
    const iconPath = app.isPackaged
        ? path.join(__dirname, '..', 'public', 'icon.png')
        : path.join(__dirname, 'public', 'icon.png');

    const window = new BrowserWindow({
        height: 800,
        width: 1200,
        minWidth: 900,
        frame: !isWindows,
        autoHideMenuBar: isWindows,
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            devTools: !app.isPackaged,
        },
        icon: iconPath
    });

    if (isWindows) {
        window.setMenuBarVisibility(false);
        window.removeMenu();
    }

    // Only ever hand http(s) URLs to the OS — other schemes (file:, smb:,
    // custom protocol handlers) can execute code or leak credentials.
    const openExternalIfHttp = (url: string): void => {
        if (/^https?:\/\//i.test(url)) {
            void shell.openExternal(url);
        }
    };

    window.webContents.setWindowOpenHandler(({ url }) => {
        openExternalIfHttp(url);
        return { action: 'deny' };
    });

    window.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith('file://')) {
            event.preventDefault();
            openExternalIfHttp(url);
        }
    });

    // Closing the window ends any in-flight Auth0 sign-in instead of leaving the
    // loopback server waiting on a browser tab that's never coming back.
    window.on('closed', () => {
        cancelPendingAuth0Login();
    });

    void window.loadFile(rendererHtmlPath);
};

app.whenReady().then(async () => {
    // Set Content Security Policy
    const scriptSrc = app.isPackaged ? "script-src 'self'" : "script-src 'self' 'unsafe-eval'";
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': [`default-src 'self'; ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self' https:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-src 'none'; form-action 'self'; frame-ancestors 'none'`]
            }
        });
    });

    await connectDB().catch(() => console.error('Could not start DB connection'))
    createIPCHandlers()
    createWindow()
})

app.on('quit', async () => {
    await disconnectDB()
})
