import React, { useEffect, useState } from 'react';
import { FiDownloadCloud } from 'react-icons/fi';
import type { UpdateCheckResult } from '../../types/sharedTypes';

// Re-check periodically so a session that's left open also gets blocked once a
// new release lands.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Forced-update gate. Mounted once at the root so it checks on launch (and every
 * few hours) regardless of the current screen. When a newer version is
 * available it shows a blocking, non-dismissible overlay: the user must
 * download the update (opens the release in the system browser) and relaunch —
 * there's no way to continue on the outdated version. If the check can't run
 * (offline / no endpoint) nothing is blocked.
 */
const UpdatePrompt: React.FC = () => {
    const [update, setUpdate] = useState<UpdateCheckResult | null>(null);

    useEffect(() => {
        let cancelled = false;

        const check = async (): Promise<void> => {
            try {
                const result = await window.db.checkForCustomUpdate();
                if (cancelled || !result.updateAvailable || !result.downloadUrl) return;
                setUpdate(result);
            } catch {
                // Offline or no update endpoint — don't lock the user out.
            }
        };

        void check();
        const timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
        return () => { cancelled = true; clearInterval(timer); };
    }, []);

    if (!update?.downloadUrl) return null;

    return (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-[#10141a]/85 p-6 backdrop-blur-sm">
            <div className="clean-panel w-full max-w-md border-emerald-500/30 p-6 text-center shadow-2xl">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300">
                    <FiDownloadCloud size={24} />
                </div>
                <h2 className="text-lg font-semibold text-slate-100">Update required</h2>
                <p className="mt-2 text-sm text-slate-400">
                    MMOP v{update.latestVersion} is available{update.currentVersion ? ` (you have v${update.currentVersion})` : ''}.
                    Update to keep using MMOP.
                </p>
                <div className="mt-6 flex flex-col items-center gap-2">
                    <a
                        href={update.downloadUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="clean-button clean-button-primary w-full justify-center px-4 py-2.5 text-sm"
                    >
                        Download v{update.latestVersion}
                    </a>
                    <button
                        onClick={() => { void window.db.closeWindow(); }}
                        className="clean-button clean-button-ghost w-full justify-center px-4 py-2 text-sm"
                    >
                        Quit
                    </button>
                </div>
                <p className="mt-4 text-xs text-slate-500">
                    Install the download, then reopen MMOP to continue.
                </p>
            </div>
        </div>
    );
};

export default UpdatePrompt;
