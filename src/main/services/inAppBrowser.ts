import { BrowserWindow } from 'electron';

/**
 * Opens device-code / sign-in verification pages *inside* the app rather than
 * the system browser. A single reused window, isolated in its own session so
 * the main window's strict CSP (set on the default session) doesn't break the
 * external page, with a desktop Chrome user agent so Microsoft doesn't reject it
 * as an embedded/disallowed user agent.
 */

const DESKTOP_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let verificationWindow: BrowserWindow | null = null;

export function openInAppVerification(url: string): void {
    if (!/^https?:\/\//i.test(url)) {
        return;
    }

    if (verificationWindow && !verificationWindow.isDestroyed()) {
        verificationWindow.focus();
        void verificationWindow.loadURL(url, { userAgent: DESKTOP_UA });
        return;
    }

    const parent = BrowserWindow.getAllWindows()[0] ?? undefined;
    verificationWindow = new BrowserWindow({
        width: 520,
        height: 720,
        parent,
        title: 'Sign in',
        autoHideMenuBar: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            // Its own session: avoids the default session's CSP/header rewrites
            // that would otherwise block the external sign-in page.
            partition: 'persist:verification',
        },
    });

    verificationWindow.on('closed', () => {
        verificationWindow = null;
    });

    void verificationWindow.loadURL(url, { userAgent: DESKTOP_UA });
}

export function closeInAppVerification(): void {
    if (verificationWindow && !verificationWindow.isDestroyed()) {
        verificationWindow.close();
    }
    verificationWindow = null;
}
