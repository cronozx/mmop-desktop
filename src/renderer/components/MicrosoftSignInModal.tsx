import React, { useRef, useState } from 'react';
import Modal from './Modal';

interface MicrosoftSignInModalProps {
    onClose: () => void;
    onSignedIn: (profileName?: string) => void;
}

/**
 * Prompts the user to link their Microsoft account (device-code flow) so
 * Minecraft launches with an authenticated session instead of offline mode.
 * Shown when entering the Minecraft section while signed out; the parent
 * decides when to show it and remembers dismissals.
 */
const MicrosoftSignInModal: React.FC<MicrosoftSignInModalProps> = ({ onClose, onSignedIn }) => {
    const [signingIn, setSigningIn] = useState(false);
    const [signInCode, setSignInCode] = useState<{ userCode: string; verificationUri: string } | null>(null);
    const [error, setError] = useState<string>('');
    const primaryRef = useRef<HTMLButtonElement>(null);

    const handleSignIn = async () => {
        setSigningIn(true);
        setError('');
        setSignInCode(null);
        try {
            const started = await window.db.signInMinecraftAccount('start');
            if (!started.success || !started.userCode || !started.verificationUri) {
                setError(started.error || 'Failed to start Microsoft sign-in.');
                return;
            }

            setSignInCode({ userCode: started.userCode, verificationUri: started.verificationUri });

            const result = await window.db.signInMinecraftAccount('wait');
            if (!result.success) {
                setError(result.error || 'Microsoft sign-in failed.');
                return;
            }

            onSignedIn(result.profileName);
        } finally {
            setSigningIn(false);
            setSignInCode(null);
        }
    };

    return (
        <Modal
            onClose={onClose}
            initialFocusRef={primaryRef}
            title="Sign in to Minecraft"
            description="Link your Microsoft account to launch Minecraft with your real profile — online servers, your skin, your username. Without it, modpacks launch in offline mode."
        >
            <div className="p-6 pt-4">
                {signInCode && (
                    <div className="clean-panel-muted mb-4 p-4 text-center">
                        <p className="text-xs uppercase tracking-wide text-slate-400">Enter this code in the sign-in window</p>
                        <p className="my-2 text-2xl font-bold tracking-widest text-slate-100">{signInCode.userCode}</p>
                        <button
                            type="button"
                            onClick={() => void window.db.openVerificationWindow(signInCode.verificationUri)}
                            className="text-sm text-emerald-300 underline hover:text-emerald-200"
                        >
                            Reopen sign-in window
                        </button>
                        <p className="mt-3 text-xs text-slate-500">Waiting for you to finish signing in…</p>
                    </div>
                )}

                {error && (
                    <p className="mb-4 text-sm text-red-400">{error}</p>
                )}

                <div className="flex justify-end gap-3">
                    <button
                        onClick={onClose}
                        className="clean-button clean-button-ghost px-4 py-2 text-sm"
                        disabled={signingIn && !!signInCode}
                    >
                        Not now
                    </button>
                    <button
                        ref={primaryRef}
                        onClick={handleSignIn}
                        disabled={signingIn}
                        className="clean-button clean-button-primary px-4 py-2 text-sm"
                    >
                        {signingIn ? 'Waiting…' : 'Sign in with Microsoft'}
                    </button>
                </div>
            </div>
        </Modal>
    );
};

export default MicrosoftSignInModal;
