import React, { useState } from 'react';
import { useNavigate } from 'react-router';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';
import { validatePassword } from '../../config/password';
import PasswordRequirements from '../components/PasswordRequirements';

/**
 * Shown once after a social (OAuth) signup so the user can choose a password
 * and also sign in with email + password later. Mandatory: the app routes here
 * until the account has a password.
 */
const SetPassword: React.FC = () => {
    const { user, refresh } = useAuth();
    const navigate = useNavigate();
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);

        const check = validatePassword(password);
        if (!check.valid) {
            setError(`Password must include: ${check.errors.join(', ')}.`);
            return;
        }
        if (password !== confirm) {
            setError('Passwords do not match.');
            return;
        }

        setBusy(true);
        try {
            const result = await window.db.setAuth0Password(password);
            if (!result.success) {
                setError(result.error || 'Could not set a password. Please try again.');
                return;
            }
            await refresh();
            navigate('/');
        } catch {
            setError('Could not set a password. Please try again.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Layout showNavbar={false} showSidebar={false}>
            <div className="flex min-h-screen items-center justify-center p-4">
                <div className="w-full max-w-md rounded-2xl border border-[#1a2029]/70 bg-[#161b22]/80 p-8 shadow-2xl backdrop-blur-sm">
                    <h1 className="text-2xl font-bold text-white">Set a password</h1>
                    <p className="mt-2 text-sm text-slate-400">
                        You signed up with a connected account{user?.username ? `, ${user.username}` : ''}. Choose a password so you can also sign in with your email and password.
                    </p>

                    <form onSubmit={handleSubmit} className="mt-6 space-y-4">
                        <div>
                            <label className="mb-1 block text-xs text-slate-400">New password</label>
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                autoFocus
                                className="clean-input text-sm"
                                placeholder="Choose a strong password"
                            />
                            {password.length > 0 && <PasswordRequirements password={password} className="mt-2" />}
                        </div>
                        <div>
                            <label className="mb-1 block text-xs text-slate-400">Confirm password</label>
                            <input
                                type="password"
                                value={confirm}
                                onChange={(e) => setConfirm(e.target.value)}
                                className="clean-input text-sm"
                                placeholder="Re-enter password"
                            />
                        </div>

                        {error && <p className="text-sm font-medium text-red-400">✗ {error}</p>}

                        <button
                            type="submit"
                            disabled={busy || !validatePassword(password).valid || password !== confirm}
                            className="clean-button clean-button-primary w-full px-4 py-2.5 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-55"
                        >
                            {busy ? 'Saving…' : 'Set password and continue'}
                        </button>
                    </form>
                </div>
            </div>
        </Layout>
    );
};

export default SetPassword;
