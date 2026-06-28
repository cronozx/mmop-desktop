import React, { useEffect, useRef, useState } from "react";
import { FiDownloadCloud, FiCheckCircle, FiAlertTriangle } from "react-icons/fi";
import type { SmapiInstallProgress } from "../../types/sharedTypes";
import Modal from "./Modal";

interface SmapiInstallModalProps {
    gameId: number;
    gameName: string;
    onClose: () => void;
    /** Called once SMAPI is successfully installed. */
    onInstalled?: () => void;
}

type Phase = 'confirm' | 'installing' | 'done' | 'error';

const STAGE_LABEL: Record<SmapiInstallProgress['stage'], string> = {
    downloading: 'Downloading SMAPI…',
    extracting: 'Extracting…',
    installing: 'Installing into your game folder…',
    done: 'Finishing up…',
};

/**
 * Install SMAPI (the Stardew Valley mod loader) with a live progress bar.
 * Replaces the old native confirm dialog so the download/install has visible
 * feedback. Progress arrives over the `smapiInstallProgress` IPC event.
 */
const SmapiInstallModal: React.FC<SmapiInstallModalProps> = ({ gameId, gameName, onClose, onInstalled }) => {
    const [phase, setPhase] = useState<Phase>('confirm');
    const [progress, setProgress] = useState<SmapiInstallProgress | null>(null);
    const [error, setError] = useState<string>('');
    const installButtonRef = useRef<HTMLButtonElement>(null);

    // Subscribe to install progress for the lifetime of the modal.
    useEffect(() => {
        const unsubscribe = window.db.onSmapiInstallProgress((p) => setProgress(p));
        return unsubscribe;
    }, []);

    const runInstall = async (): Promise<void> => {
        setPhase('installing');
        setError('');
        setProgress({ stage: 'downloading', percent: 0 });
        const result = await window.db.installSmapi(gameId);
        if (result.success) {
            setProgress({ stage: 'done' });
            setPhase('done');
            onInstalled?.();
        } else {
            setError(result.error ?? 'SMAPI installation failed.');
            setPhase('error');
        }
    };

    const stage = progress?.stage ?? 'downloading';
    const isDeterminate = stage === 'downloading' && typeof progress?.percent === 'number';
    const percent = isDeterminate ? Math.min(100, Math.max(0, progress!.percent!)) : null;
    const busy = phase === 'installing';

    return (
        <Modal
            onClose={onClose}
            title="Install SMAPI"
            panelClassName="max-w-md border-[#232a34]/45 bg-[#161b22]/92"
            busy={busy}
            initialFocusRef={installButtonRef}
        >
            <div className="p-5 pt-3">
                {phase === 'confirm' && (
                    <>
                        <div className="mb-4 flex items-start gap-3">
                            <FiDownloadCloud className="mt-0.5 shrink-0 text-2xl text-emerald-300" />
                            <p className="text-sm text-slate-300">
                                {gameName} needs <span className="font-semibold text-slate-100">SMAPI</span> to load mods.
                                MMOP can download and install it into your game folder now.
                            </p>
                        </div>
                        <div className="flex justify-end gap-2">
                            <button onClick={onClose} className="clean-button clean-button-ghost px-4 py-2 text-sm">
                                Not now
                            </button>
                            <button
                                ref={installButtonRef}
                                onClick={() => void runInstall()}
                                className="clean-button clean-button-primary px-4 py-2 text-sm"
                            >
                                Install SMAPI
                            </button>
                        </div>
                    </>
                )}

                {phase === 'installing' && (
                    <div>
                        <p className="mb-3 text-sm text-slate-300">{STAGE_LABEL[stage]}</p>
                        <div className="h-2.5 w-full overflow-hidden rounded-full bg-[#1a2029]">
                            <div
                                className={`h-full rounded-full bg-gradient-to-r from-emerald-400 to-cyan-400 transition-[width] duration-300 ${isDeterminate ? '' : 'smapi-progress-indeterminate w-1/3'}`}
                                style={isDeterminate ? { width: `${percent}%` } : undefined}
                                role="progressbar"
                                aria-valuemin={0}
                                aria-valuemax={100}
                                {...(isDeterminate ? { 'aria-valuenow': percent ?? 0 } : {})}
                            />
                        </div>
                        {isDeterminate && <p className="mt-2 text-right text-xs text-slate-400">{percent}%</p>}
                        <p className="mt-3 text-xs text-slate-500">This can take a minute. Please keep MMOP open.</p>
                    </div>
                )}

                {phase === 'done' && (
                    <div className="text-center">
                        <FiCheckCircle className="mx-auto mb-3 text-4xl text-emerald-400" />
                        <p className="mb-4 text-sm text-slate-200">SMAPI installed. Your mods will load when you launch {gameName}.</p>
                        <button onClick={onClose} className="clean-button clean-button-primary px-5 py-2 text-sm">Done</button>
                    </div>
                )}

                {phase === 'error' && (
                    <div>
                        <div className="mb-3 flex items-start gap-3">
                            <FiAlertTriangle className="mt-0.5 shrink-0 text-2xl text-rose-400" />
                            <p className="text-sm text-slate-300">{error}</p>
                        </div>
                        <div className="flex justify-end gap-2">
                            <button onClick={onClose} className="clean-button clean-button-ghost px-4 py-2 text-sm">Close</button>
                            <button onClick={() => void runInstall()} className="clean-button clean-button-soft px-4 py-2 text-sm">Try Again</button>
                        </div>
                    </div>
                )}
            </div>
        </Modal>
    );
};

export default SmapiInstallModal;
