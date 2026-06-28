import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { FiAlertTriangle, FiCheck, FiLink, FiLock, FiUser, FiX } from "react-icons/fi";
import { useAuth } from "../context/AuthContext";
import { validatePassword } from "../../config/password";
import { BLOCKED_USERNAME_MESSAGE, isUsernameClean } from "../../config/usernameFilter";
import PasswordRequirements from "./PasswordRequirements";

interface Identity {
    provider: string;
    connection: string | null;
    userId: string;
    isSocial: boolean;
}

interface AccountManagerProps {
    username: string;
    email: string;
    onAccountChange: (next: { username: string; email: string }) => void;
}

/** Friendly label for an Auth0 identity provider. */
function providerLabel(identity: Identity): string {
    switch (identity.provider) {
        case 'github': return 'GitHub';
        case 'google-oauth2': return 'Google';
        case 'windowslive': return 'Microsoft';
        case 'auth0': return 'Email & Password';
        default: return identity.connection ?? identity.provider;
    }
}

const inputClass = "clean-input text-zinc-100";

// Specific guidance for why connected-login management is unavailable, so the
// fix (env vars vs. an out-of-date backend) is obvious.
const IDENTITY_UNAVAILABLE_MESSAGE: Record<string, string> = {
    no_backend: 'Connected-login management requires the MMOP backend to be configured.',
    unreachable: 'Couldn’t reach the server to load your connected logins. Check your connection and try again.',
    route_missing: 'The server needs to be updated to manage connected logins (restart/redeploy the backend).',
    not_configured: 'Connected-login management isn’t enabled on the server (missing Auth0 Management credentials).',
    management_error: 'The server couldn’t reach Auth0 to load your connected logins. Confirm the Management API credentials and read:users scope.',
    default: 'Connected-login management isn’t available right now.',
};

/**
 * Self-contained account manager: edit username/email, change password, and
 * view/unlink connected logins. Each action proxies through the backend to the
 * Auth0 Management API; failures surface inline.
 */
const AccountManager: React.FC<AccountManagerProps> = ({ username, email, onAccountChange }) => {
    const { user, refresh, logout } = useAuth();
    const navigate = useNavigate();
    const passwordSet = user?.passwordSet !== false;

    const [editUsername, setEditUsername] = useState(username);
    const [editEmail, setEditEmail] = useState(email);
    const [savingProfile, setSavingProfile] = useState(false);
    const [profileMsg, setProfileMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [savingPassword, setSavingPassword] = useState(false);
    const [passwordMsg, setPasswordMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

    const [identities, setIdentities] = useState<Identity[]>([]);
    const [identitiesConfigured, setIdentitiesConfigured] = useState(false);
    const [identitiesReason, setIdentitiesReason] = useState<string | undefined>(undefined);
    const [unlinking, setUnlinking] = useState<string>('');
    const [identityMsg, setIdentityMsg] = useState<string>('');

    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const [deleteConfirmText, setDeleteConfirmText] = useState('');
    const [deletingAccount, setDeletingAccount] = useState(false);
    const [deleteMsg, setDeleteMsg] = useState('');

    useEffect(() => { setEditUsername(username); }, [username]);
    useEffect(() => { setEditEmail(email); }, [email]);

    const loadIdentities = async (): Promise<void> => {
        const result = await window.db.getAccountIdentities();
        setIdentitiesConfigured(result.configured);
        setIdentities(result.identities);
        setIdentitiesReason(result.reason);
    };

    useEffect(() => { void loadIdentities(); }, []);

    const profileDirty = editUsername.trim() !== username || editEmail.trim() !== email;
    const usernameChanged = editUsername.trim() !== username;
    const usernameBlocked = usernameChanged && editUsername.trim().length > 0 && !isUsernameClean(editUsername.trim());

    const handleSaveProfile = async (): Promise<void> => {
        setProfileMsg(null);
        const fields: { username?: string; email?: string } = {};
        if (editUsername.trim() !== username) fields.username = editUsername.trim();
        if (editEmail.trim() !== email) fields.email = editEmail.trim();
        if (!fields.username && !fields.email) return;

        // Reject blocked words up front so the user gets immediate feedback; the
        // backend enforces the same rule as the source of truth.
        if (fields.username && !isUsernameClean(fields.username)) {
            setProfileMsg({ kind: 'err', text: BLOCKED_USERNAME_MESSAGE });
            return;
        }

        setSavingProfile(true);
        try {
            const result = await window.db.updateAccountProfile(fields);
            if (result.success) {
                onAccountChange({ username: fields.username ?? username, email: fields.email ?? email });
                await refresh();
                setProfileMsg({ kind: 'ok', text: 'Account updated.' });
            } else {
                setProfileMsg({ kind: 'err', text: result.error ?? 'Could not update your account.' });
            }
        } finally {
            setSavingProfile(false);
        }
    };

    const handleChangePassword = async (): Promise<void> => {
        setPasswordMsg(null);
        const check = validatePassword(newPassword);
        if (!check.valid) {
            setPasswordMsg({ kind: 'err', text: `Password must include: ${check.errors.join(', ')}.` });
            return;
        }
        if (newPassword !== confirmPassword) {
            setPasswordMsg({ kind: 'err', text: 'Passwords do not match.' });
            return;
        }
        setSavingPassword(true);
        try {
            // Social signups without a password yet use the set-password flow.
            const result = passwordSet
                ? await window.db.changeAccountPassword(newPassword)
                : await window.db.setAuth0Password(newPassword);
            if (result.success) {
                setNewPassword('');
                setConfirmPassword('');
                await refresh();
                setPasswordMsg({ kind: 'ok', text: passwordSet ? 'Password changed.' : 'Password set. You can now sign in with email and password.' });
            } else {
                setPasswordMsg({ kind: 'err', text: result.error ?? 'Could not change your password.' });
            }
        } finally {
            setSavingPassword(false);
        }
    };

    const handleUnlink = async (identity: Identity): Promise<void> => {
        setIdentityMsg('');
        setUnlinking(`${identity.provider}|${identity.userId}`);
        try {
            const result = await window.db.unlinkAccountIdentity(identity.provider, identity.userId);
            if (result.success) {
                await loadIdentities();
            } else {
                setIdentityMsg(result.error ?? 'Could not unlink that login.');
            }
        } finally {
            setUnlinking('');
        }
    };

    const handleDeleteAccount = async (): Promise<void> => {
        setDeleteMsg('');
        setDeletingAccount(true);
        try {
            const result = await window.db.deleteAccount();
            if (result.success) {
                // Account is gone — clear the local session and return to login.
                await logout();
                navigate('/login');
                return;
            }
            setDeleteMsg(result.error ?? 'Could not delete your account.');
        } catch {
            setDeleteMsg('Could not delete your account.');
        }
        setDeletingAccount(false);
    };

    const msgClass = (kind: 'ok' | 'err'): string =>
        kind === 'ok' ? 'text-emerald-300' : 'text-rose-300';

    return (
        <div className="space-y-6">
            {/* Profile: username + email */}
            <div>
                <h4 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200"><FiUser /> Profile</h4>
                <div className="space-y-3">
                    <div>
                        <label className="mb-1 block text-xs uppercase tracking-wide text-zinc-400">Username</label>
                        <input value={editUsername} onChange={(e) => setEditUsername(e.target.value)} className={inputClass} spellCheck={false} aria-invalid={usernameBlocked} />
                        {usernameBlocked && <p className="mt-1 text-xs text-rose-300">{BLOCKED_USERNAME_MESSAGE}</p>}
                    </div>
                    <div>
                        <label className="mb-1 block text-xs uppercase tracking-wide text-zinc-400">Email</label>
                        <input type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} className={inputClass} spellCheck={false} />
                        <p className="mt-1 text-xs text-zinc-500">Changing your email sends a verification message to the new address.</p>
                    </div>
                    <div className="flex items-center gap-3">
                        <button
                            onClick={() => void handleSaveProfile()}
                            disabled={!profileDirty || savingProfile || usernameBlocked}
                            className="clean-button clean-button-soft px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-55"
                        >
                            {savingProfile ? 'Saving…' : 'Save changes'}
                        </button>
                        {profileMsg && <p className={`text-sm ${msgClass(profileMsg.kind)}`}>{profileMsg.text}</p>}
                    </div>
                </div>
            </div>

            {/* Password */}
            <div className="border-t border-zinc-700/50 pt-5">
                <h4 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200"><FiLock /> {passwordSet ? 'Change Password' : 'Set a Password'}</h4>
                {!passwordSet && (
                    <p className="mb-3 text-xs text-zinc-400">You signed up with a social login. Set a password to also sign in with your email.</p>
                )}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="New password" autoComplete="new-password" className={inputClass} />
                    <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Confirm password" autoComplete="new-password" className={inputClass} />
                </div>
                {newPassword.length > 0 && <PasswordRequirements password={newPassword} className="mt-3" />}
                <div className="mt-3 flex items-center gap-3">
                    <button
                        onClick={() => void handleChangePassword()}
                        disabled={savingPassword || !validatePassword(newPassword).valid || newPassword !== confirmPassword}
                        className="clean-button clean-button-soft px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-55"
                    >
                        {savingPassword ? 'Saving…' : passwordSet ? 'Update password' : 'Set password'}
                    </button>
                    {passwordMsg && <p className={`text-sm ${msgClass(passwordMsg.kind)}`}>{passwordMsg.text}</p>}
                </div>
            </div>

            {/* Connected logins */}
            <div className="border-t border-zinc-700/50 pt-5">
                <h4 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200"><FiLink /> Connected Logins</h4>
                {!identitiesConfigured ? (
                    <p className="text-xs text-zinc-500">{IDENTITY_UNAVAILABLE_MESSAGE[identitiesReason ?? 'default'] ?? IDENTITY_UNAVAILABLE_MESSAGE.default}</p>
                ) : identities.length === 0 ? (
                    <p className="text-xs text-zinc-500">{identitiesReason === 'management_error' ? IDENTITY_UNAVAILABLE_MESSAGE.management_error : 'No connected logins found.'}</p>
                ) : (
                    <ul className="space-y-2">
                        {identities.map((identity, index) => {
                            const key = `${identity.provider}|${identity.userId}`;
                            const isPrimary = index === 0;
                            return (
                                <li key={key} className="flex items-center justify-between gap-3 rounded-lg border border-zinc-700/50 bg-zinc-900/35 px-3 py-2">
                                    <div className="flex items-center gap-2.5">
                                        <FiCheck className="text-emerald-300" />
                                        <span className="text-sm text-zinc-200">{providerLabel(identity)}</span>
                                        {isPrimary && <span className="rounded border border-zinc-600/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">Primary</span>}
                                    </div>
                                    {!isPrimary && (
                                        <button
                                            onClick={() => void handleUnlink(identity)}
                                            disabled={unlinking === key}
                                            className="clean-button clean-button-ghost gap-1.5 px-2.5 py-1 text-xs disabled:opacity-55"
                                            title="Disconnect this login"
                                        >
                                            <FiX size={13} />
                                            {unlinking === key ? 'Removing…' : 'Disconnect'}
                                        </button>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
                {identityMsg && <p className="mt-2 text-sm text-rose-300">{identityMsg}</p>}
            </div>

            {/* Danger zone: permanently delete the account */}
            <div className="border-t border-rose-500/20 pt-5">
                <h4 className="mb-3 flex items-center gap-2 text-sm font-semibold text-rose-300"><FiAlertTriangle /> Delete Account</h4>
                <p className="mb-3 text-xs text-zinc-400">
                    Permanently deletes your account and every modpack you own. This cannot be undone.
                </p>
                {!confirmingDelete ? (
                    <button
                        onClick={() => { setConfirmingDelete(true); setDeleteMsg(''); }}
                        className="clean-button clean-button-danger px-4 py-2 text-sm"
                    >
                        Delete account
                    </button>
                ) : (
                    <div className="rounded-lg border border-rose-500/25 bg-rose-900/10 p-4">
                        <p className="mb-2 text-sm text-zinc-200">
                            Type <span className="font-mono text-rose-300">{username}</span> to confirm.
                        </p>
                        <input
                            value={deleteConfirmText}
                            onChange={(e) => setDeleteConfirmText(e.target.value)}
                            className={inputClass}
                            spellCheck={false}
                            placeholder="Your username"
                            autoComplete="off"
                        />
                        <div className="mt-3 flex items-center gap-3">
                            <button
                                onClick={() => void handleDeleteAccount()}
                                disabled={deletingAccount || deleteConfirmText !== username}
                                className="clean-button clean-button-danger px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-55"
                            >
                                {deletingAccount ? 'Deleting…' : 'Permanently delete'}
                            </button>
                            <button
                                onClick={() => { setConfirmingDelete(false); setDeleteConfirmText(''); setDeleteMsg(''); }}
                                disabled={deletingAccount}
                                className="clean-button clean-button-ghost px-4 py-2 text-sm disabled:opacity-55"
                            >
                                Cancel
                            </button>
                            {deleteMsg && <p className="text-sm text-rose-300">{deleteMsg}</p>}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default AccountManager;
