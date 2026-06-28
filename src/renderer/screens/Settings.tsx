import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { FiUser, FiDownloadCloud, FiPlus, FiBox, FiStar } from 'react-icons/fi';
import Layout from '../components/Layout';
import AccountManager from '../components/AccountManager';
import type { GameType, UpdateCheckResult, ProStatus } from '../../types/sharedTypes';
import { useAuth } from '../context/AuthContext';
import { supportsVersionAndLoaderSelection } from '../../config/games';
import { useProPricing, formatMoney, formatPriceLine } from '../helpers/proPricing';

type GeneralSectionId = 'account' | 'subscription' | 'updates';

const GENERAL_SECTIONS: Array<{ id: GeneralSectionId; label: string; icon: React.ReactNode }> = [
    { id: 'account', label: 'Account', icon: <FiUser /> },
    { id: 'subscription', label: 'Subscription', icon: <FiStar /> },
    { id: 'updates', label: 'App Updates', icon: <FiDownloadCloud /> },
];

// `trialIncluded: false` features are NOT granted during the free trial (only a
// paid subscription unlocks them) — shown with a "Paid only" tag for trial users.
const PRO_FEATURES: Array<{ label: string; trialIncluded: boolean }> = [
    { label: 'Unlimited modpacks', trialIncluded: false },
    { label: 'Custom modpack icons', trialIncluded: true },
    { label: 'Pro supporter badge', trialIncluded: true },
];

/** A game launched through Minecraft's managed flow rather than an executable. */
const isManagedGame = (game: GameType): boolean => supportsVersionAndLoaderSelection(game.id);

interface AccountSettings {
    _id: string;
    username: string;
    email: string;
}

const Settings: React.FC = () => {
    const navigate = useNavigate();
    const { token, user, refresh } = useAuth();
    const isPro = user?.isPro === true;

    const [proStatus, setProStatus] = useState<ProStatus | null>(null);
    const proConfigured = proStatus?.configured ?? false;
    // Offer the trial only to accounts that haven't used one (server-enforced too).
    const trialAvailable = (proStatus?.trialEligible ?? false);
    const isTrialing = proStatus?.subscriptionStatus === 'trialing';
    const [upgrading, setUpgrading] = useState<boolean>(false);
    const [billingMessage, setBillingMessage] = useState<string>('');

    const handleUpgrade = async (): Promise<void> => {
        if (upgrading) return;
        setUpgrading(true);
        setBillingMessage('');
        try {
            const result = await window.db.startProCheckout();
            if (result.success) {
                setBillingMessage('Continue in your browser to complete checkout. Your Pro status updates automatically once payment is confirmed.');
                // The webhook flips entitlement server-side; re-check shortly after.
                setTimeout(() => { void refresh(); }, 4000);
            } else {
                setBillingMessage(result.error ?? 'Could not start checkout.');
            }
        } finally {
            setUpgrading(false);
        }
    };

    const [account, setAccount] = useState<AccountSettings | null>(null);
    const [games, setGames] = useState<GameType[]>([]);
    const [gameExecutables, setGameExecutables] = useState<Record<number, string>>({});
    // Games shown under "Game Specific". Seeded with managed games (Minecraft)
    // and any game with a configured executable; the + menu adds more catalog
    // games. Only games defined in the codebase are ever suggested.
    const [addedGameIds, setAddedGameIds] = useState<Set<number>>(new Set());
    const [addMenuOpen, setAddMenuOpen] = useState<boolean>(false);
    const [defaultMemoryMb, setDefaultMemoryMb] = useState<number>(4096);
    const [minecraftAccount, setMinecraftAccount] = useState<{ signedIn: boolean; profileName?: string }>({ signedIn: false });
    const [minecraftSignInCode, setMinecraftSignInCode] = useState<{ userCode: string; verificationUri: string } | null>(null);
    const [minecraftSigningIn, setMinecraftSigningIn] = useState<boolean>(false);
    const [statusMessage, setStatusMessage] = useState<string>('');
    const [isLoading, setIsLoading] = useState<boolean>(true);
    const [updateStatus, setUpdateStatus] = useState<string>('');
    const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
    // Selected nav entry: a general section id, or `game:<id>` for a game panel.
    const [activeKey, setActiveKey] = useState<string>('account');

    // Live Stripe pricing for the upgrade UI; only fetched when a non-Pro user
    // is actually looking at the Subscription panel.
    const pricing = useProPricing(activeKey === 'subscription' && !isPro);
    const priceLine = pricing ? formatPriceLine(pricing) : null;

    // Managed games first (Minecraft), then the rest in catalog order.
    const gameSpecificGames = games
        .filter((game) => addedGameIds.has(game.id))
        .sort((a, b) => Number(isManagedGame(b)) - Number(isManagedGame(a)));
    const addableGames = games.filter((game) => !addedGameIds.has(game.id));

    const selectedGameId = activeKey.startsWith('game:') ? Number(activeKey.slice(5)) : null;
    const selectedGame = selectedGameId !== null
        ? games.find((game) => game.id === selectedGameId) ?? null
        : null;

    const refreshAccount = async (activeToken: string): Promise<void> => {
        const accountData = await window.db.getAccountSettings(activeToken);
        setAccount(accountData);
    };

    const handleCheckForUpdate = async () => {
        setUpdateStatus('Checking for updates...');
        const result = await window.db.checkForCustomUpdate();
        if (result.updateAvailable) {
            setUpdateInfo(result);
            setUpdateStatus(`Update available: v${result.latestVersion}`);
        } else if (result.error) {
            setUpdateInfo(null);
            setUpdateStatus(`Update check failed: ${result.error}`);
        } else if (result.latestVersion) {
            setUpdateInfo(null);
            setUpdateStatus(`You are up to date (current: v${result.currentVersion}, latest: v${result.latestVersion})`);
        } else {
            setUpdateInfo(null);
            setUpdateStatus('No update available or failed to check.');
        }
    };

    useEffect(() => {
        const loadSettings = async () => {
            const activeToken = token || '';
            if (!activeToken) {
                navigate('/login');
                return;
            }

            await refreshAccount(activeToken);

            const fetchedGames = await window.db.getAllGames(activeToken);
            setGames(fetchedGames);

            const executableEntries = await Promise.all(
                fetchedGames.map(async (game) => {
                    const executable = await window.db.getGameExecutable(game.id);
                    return [game.id, executable ?? ''] as const;
                })
            );
            const executableMap = Object.fromEntries(executableEntries);
            setGameExecutables(executableMap);
            // Managed games (Minecraft) and any game with an executable already set
            // show under Game Specific by default; the rest wait behind the + menu.
            setAddedGameIds(new Set(
                fetchedGames
                    .filter((game) => isManagedGame(game) || !!executableMap[game.id])
                    .map((game) => game.id),
            ));

            const defaultMemory = await window.db.getDefaultMinecraftMemoryMb();
            if (typeof defaultMemory === 'number' && Number.isFinite(defaultMemory)) {
                setDefaultMemoryMb(defaultMemory);
            }

            try {
                setMinecraftAccount(await window.db.getMinecraftAccountStatus());
            } catch {
                // Non-fatal; Minecraft simply launches in offline mode.
            }

            setIsLoading(false);
        };

        void loadSettings();
    }, [navigate]);

    useEffect(() => {
        let cancelled = false;
        void window.db.getProStatus().then((status) => {
            if (!cancelled) setProStatus(status);
        }).catch(() => { /* leave upgrade CTA hidden when status can't be read */ });
        return () => { cancelled = true; };
    }, [isPro]);

    const handleAddGame = (gameId: number) => {
        if (!Number.isFinite(gameId)) return;
        setAddedGameIds((previous) => new Set(previous).add(gameId));
        setActiveKey(`game:${gameId}`);
        setAddMenuOpen(false);
    };

    const handleSelectGameExecutable = async (gameId: number, gameName: string) => {
        const selected = await window.db.selectAndSaveGameExecutable(gameId);
        if (!selected) {
            return;
        }

        setGameExecutables((previous) => ({
            ...previous,
            [gameId]: selected,
        }));
        setStatusMessage(`${gameName} executable updated.`);
    };

    const handleAutoDetectGameExecutable = async (gameId: number, gameName: string) => {
        const detected = await window.db.getGameExecutable(gameId);

        setGameExecutables((previous) => ({
            ...previous,
            [gameId]: detected ?? '',
        }));

        if (detected) {
            setStatusMessage(`${gameName} launcher auto-detected.`);
            return;
        }

        setStatusMessage(`Could not auto-detect ${gameName}. Use Select Executable.`);
    };

    const handleMinecraftSignIn = async () => {
        setMinecraftSigningIn(true);
        setMinecraftSignInCode(null);
        try {
            const started = await window.db.signInMinecraftAccount('start');
            if (!started.success || !started.userCode || !started.verificationUri) {
                setStatusMessage(started.error || 'Failed to start Microsoft sign-in.');
                return;
            }

            setMinecraftSignInCode({ userCode: started.userCode, verificationUri: started.verificationUri });

            const result = await window.db.signInMinecraftAccount('wait');
            if (!result.success) {
                setStatusMessage(result.error || 'Microsoft sign-in failed.');
                return;
            }

            setMinecraftAccount(await window.db.getMinecraftAccountStatus());
            setStatusMessage(`Signed in to Minecraft as ${result.profileName ?? 'your Microsoft account'}.`);
        } finally {
            setMinecraftSigningIn(false);
            setMinecraftSignInCode(null);
        }
    };

    const handleMinecraftSignOut = async () => {
        await window.db.signOutMinecraftAccount();
        setMinecraftAccount({ signedIn: false });
        setStatusMessage('Minecraft account signed out. Modpacks will launch in offline mode.');
    };

    const handleSaveDefaultMemory = async () => {
        const result = await window.db.setDefaultMinecraftMemoryMb(defaultMemoryMb);
        if (!result.success) {
            setStatusMessage(result.error || 'Could not save default memory value.');
            return;
        }

        setDefaultMemoryMb(result.value ?? defaultMemoryMb);
        setStatusMessage(`Default Minecraft memory set to ${result.value ?? defaultMemoryMb} MB.`);
    };

    if (isLoading) {
        return (
            <Layout>
                <div className="app-container py-10">
                    <div className="clean-panel p-6 text-slate-300">Loading settings...</div>
                </div>
            </Layout>
        );
    }

    return (
        <Layout>
            <div className="app-container py-8 sm:py-10">
                <div className="mb-8">
                    <h2 className="text-2xl font-bold text-white sm:text-3xl">Settings</h2>
                    <p className="mt-1 text-sm text-slate-400">Manage your account and per-game launch settings.</p>
                </div>

                {statusMessage && (
                    <div className="mb-6 rounded-xl border border-slate-500/35 bg-[#161b22]/25 px-4 py-3 text-sm font-medium text-slate-100" role="status">
                        {statusMessage}
                    </div>
                )}

                <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
                    {/* Section navigation: General sections, then a Game Specific
                        group whose entries are the games the user has added. */}
                    <nav aria-label="Settings sections" className="lg:sticky lg:top-20 lg:self-start">
                        <div className="space-y-1">
                            <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">General</p>
                            {GENERAL_SECTIONS.map((section) => {
                                const isActive = activeKey === section.id;
                                return (
                                    <button
                                        key={section.id}
                                        onClick={() => setActiveKey(section.id)}
                                        aria-current={isActive ? 'page' : undefined}
                                        className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm font-semibold transition-colors ${
                                            isActive
                                                ? 'border-emerald-500/40 bg-emerald-900/15 text-white'
                                                : 'border-[#232a34]/45 bg-[#161b22]/40 text-slate-300 hover:border-slate-500/55 hover:text-white'
                                        }`}
                                    >
                                        <span className={`text-lg ${isActive ? 'text-emerald-300' : 'text-slate-400'}`}>{section.icon}</span>
                                        <span>{section.label}</span>
                                    </button>
                                );
                            })}

                            <div className="flex items-center justify-between gap-2 px-3 pt-5 pb-1">
                                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Game Specific</p>
                                {addableGames.length > 0 && (
                                    <button
                                        onClick={() => setAddMenuOpen((open) => !open)}
                                        aria-label="Add a game"
                                        aria-expanded={addMenuOpen}
                                        className="rounded-md border border-[#232a34]/55 bg-[#161b22]/60 p-1 text-slate-300 transition-colors hover:border-slate-500/60 hover:text-white"
                                    >
                                        <FiPlus size={14} />
                                    </button>
                                )}
                            </div>

                            {/* Add-a-game menu: only games defined in the catalog are offered. */}
                            {addMenuOpen && addableGames.length > 0 && (
                                <div className="mb-1 overflow-hidden rounded-lg border border-[#232a34]/55 bg-[#161b22]/85">
                                    <p className="border-b border-[#232a34]/45 px-3 py-2 text-[11px] uppercase tracking-wide text-slate-500">Supported games</p>
                                    <div className="clean-scroll max-h-64 overflow-y-auto">
                                        {addableGames.map((game) => (
                                            <button
                                                key={game.id}
                                                onClick={() => handleAddGame(game.id)}
                                                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-[#1a2029]/70"
                                            >
                                                {game.imagePath ? (
                                                    <img src={game.imagePath} alt="" className="h-5 w-5 shrink-0 rounded object-cover" />
                                                ) : (
                                                    <FiBox className="shrink-0 text-slate-400" />
                                                )}
                                                <span className="truncate">{game.name}</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {gameSpecificGames.map((game) => {
                                const key = `game:${game.id}`;
                                const isActive = activeKey === key;
                                return (
                                    <button
                                        key={key}
                                        onClick={() => setActiveKey(key)}
                                        aria-current={isActive ? 'page' : undefined}
                                        className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm font-semibold transition-colors ${
                                            isActive
                                                ? 'border-emerald-500/40 bg-emerald-900/15 text-white'
                                                : 'border-[#232a34]/45 bg-[#161b22]/40 text-slate-300 hover:border-slate-500/55 hover:text-white'
                                        }`}
                                    >
                                        {game.imagePath ? (
                                            <img src={game.imagePath} alt="" className="h-5 w-5 shrink-0 rounded object-cover" />
                                        ) : (
                                            <FiBox className="shrink-0 text-slate-400" />
                                        )}
                                        <span className="truncate">{game.name}</span>
                                    </button>
                                );
                            })}

                            {gameSpecificGames.length === 0 && (
                                <p className="px-3 py-2 text-xs text-slate-500">No games yet. Use + to add one.</p>
                            )}
                        </div>
                    </nav>

                    <div className="min-w-0">
                    {activeKey === 'account' && (
                    <section className="clean-panel p-5 sm:p-6">
                        <h3 className="mb-4 text-lg font-semibold text-slate-100">Account</h3>
                        <AccountManager
                            username={account?.username ?? ''}
                            email={account?.email ?? ''}
                            onAccountChange={(next) => setAccount((prev) => prev ? { ...prev, ...next } : prev)}
                        />
                    </section>
                    )}

                    {activeKey === 'subscription' && (
                    <section className="clean-panel p-5 sm:p-6">
                        <div className="mb-4 flex items-center justify-between gap-3">
                            <h3 className="text-lg font-semibold text-slate-100">Subscription</h3>
                            <span className={`shrink-0 rounded-md border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${isPro ? 'border-emerald-500/50 bg-emerald-900/20 text-emerald-200' : 'border-slate-500/50 bg-[#1a2029]/40 text-slate-300'}`}>
                                {isPro ? 'Pro' : 'Free'}
                            </span>
                        </div>

                        <p className="mb-4 text-sm text-slate-400">
                            {isPro && isTrialing && proStatus?.trialEndsAt
                                ? `You're on a free Pro trial — it ends ${new Date(proStatus.trialEndsAt).toLocaleDateString()}. You'll be charged when it ends unless you cancel. Note: the trial doesn't include extra modpacks — those need a paid subscription.`
                                : isPro
                                ? 'Thanks for supporting MMOP! You have access to all Pro features.'
                                : 'Upgrade to Pro to unlock more of MMOP and support development.'}
                        </p>

                        <ul className="mb-5 space-y-2">
                            {PRO_FEATURES.map((feature) => (
                                <li key={feature.label} className="flex items-center gap-2.5 text-sm text-slate-200">
                                    <FiStar size={14} className={isPro ? 'text-emerald-300' : 'text-slate-500'} />
                                    <span>{feature.label}</span>
                                    {!feature.trialIncluded && (trialAvailable || isTrialing) && (
                                        <span className="rounded border border-amber-500/40 bg-amber-900/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300" title="Requires a paid subscription — not included in the free trial">
                                            Paid only
                                        </span>
                                    )}
                                </li>
                            ))}
                        </ul>

                        {!isPro && proConfigured && priceLine && (
                            <div className="mb-5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                                {pricing?.compareAtAmount && pricing.currency && (
                                    <span className="text-base text-slate-500 line-through">{formatMoney(pricing.compareAtAmount, pricing.currency)}</span>
                                )}
                                <span className="text-2xl font-bold text-slate-100">{priceLine}</span>
                                {pricing?.trialDays && trialAvailable ? (
                                    <span className="rounded-md border border-emerald-500/40 bg-emerald-900/20 px-2 py-0.5 text-xs font-semibold text-emerald-200">
                                        {pricing.trialDays}-day free trial
                                    </span>
                                ) : pricing?.compareAtAmount ? (
                                    <span className="rounded-md border border-amber-500/40 bg-amber-900/20 px-2 py-0.5 text-xs font-semibold text-amber-200">
                                        Sale
                                    </span>
                                ) : null}
                            </div>
                        )}

                        {!isPro && proConfigured && pricing?.trialDays && trialAvailable && (
                            <p className="mb-4 -mt-2 text-xs text-amber-300/80">
                                Heads up: the free trial includes Pro features except unlimited modpacks — those need a paid subscription.
                            </p>
                        )}

                        {!isPro && proConfigured && (
                            <button
                                onClick={() => void handleUpgrade()}
                                disabled={upgrading}
                                className="flex items-center gap-2 rounded-lg border border-emerald-400/40 bg-gradient-to-r from-emerald-500/15 to-cyan-500/15 px-5 py-2.5 text-sm font-semibold text-emerald-200 transition-colors hover:from-emerald-500/25 hover:to-cyan-500/25 disabled:opacity-60"
                            >
                                <FiStar size={15} />
                                {upgrading
                                    ? 'Opening checkout…'
                                    : pricing?.trialDays && trialAvailable ? `Start ${pricing.trialDays}-day free trial` : 'Upgrade to Pro'}
                            </button>
                        )}

                        {!isPro && !proConfigured && (
                            <p className="text-xs text-slate-500">Subscriptions aren’t available right now. Check back soon.</p>
                        )}

                        {billingMessage && (
                            <p className="mt-4 rounded-lg border border-[#232a34]/50 bg-[#161b22]/35 px-3 py-2 text-sm text-slate-300">{billingMessage}</p>
                        )}
                    </section>
                    )}

                    {selectedGame && !isManagedGame(selectedGame) && (() => {
                        const executable = gameExecutables[selectedGame.id];
                        const configured = !!executable;
                        return (
                        <section className="clean-panel p-5 sm:p-6">
                            <div className="mb-5 flex items-start justify-between gap-3">
                                <div className="flex min-w-0 items-center gap-3">
                                    {selectedGame.imagePath ? (
                                        <img src={selectedGame.imagePath} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" />
                                    ) : (
                                        <FiBox className="text-2xl text-slate-400" />
                                    )}
                                    <div className="min-w-0">
                                        <h3 className="truncate text-lg font-semibold text-slate-100">{selectedGame.name}</h3>
                                        <p className="text-xs text-slate-400">Launcher executable</p>
                                    </div>
                                </div>
                                <span className={`shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium ${configured ? 'border-emerald-500/50 bg-emerald-900/20 text-emerald-200' : 'border-amber-500/50 bg-amber-900/20 text-amber-200'}`}>
                                    {configured ? 'Configured' : 'Needs Setup'}
                                </span>
                            </div>

                            <label className="mb-1 block text-xs uppercase tracking-wide text-slate-400">Executable Path</label>
                            <input
                                value={executable ?? ''}
                                readOnly
                                placeholder={`No ${selectedGame.name} executable configured`}
                                className="clean-input text-xs text-slate-300"
                            />

                            <div className="mt-3 flex flex-wrap gap-2">
                                <button
                                    onClick={() => handleAutoDetectGameExecutable(selectedGame.id, selectedGame.name)}
                                    className="clean-button clean-button-ghost px-3 py-1.5 text-xs"
                                >
                                    Auto Detect
                                </button>
                                <button
                                    onClick={() => handleSelectGameExecutable(selectedGame.id, selectedGame.name)}
                                    className="clean-button clean-button-soft px-3 py-1.5 text-xs"
                                >
                                    {configured ? 'Change Executable' : 'Select Executable'}
                                </button>
                            </div>
                            <p className="mt-3 text-xs text-slate-400">
                                MMOP launches {selectedGame.name} from this executable when you start one of its modpacks.
                            </p>
                        </section>
                        );
                    })()}

                    {selectedGame && isManagedGame(selectedGame) && (
                    <section className="clean-panel p-5 sm:p-6">
                        <div className="mb-4 flex items-center gap-3">
                            {selectedGame.imagePath ? (
                                <img src={selectedGame.imagePath} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" />
                            ) : (
                                <FiBox className="text-2xl text-slate-400" />
                            )}
                            <h3 className="text-lg font-semibold text-slate-100">{selectedGame.name}</h3>
                        </div>

                        <div>
                            <h4 className="mb-2 text-sm font-semibold text-slate-200">Minecraft Account</h4>
                            <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-[#232a34]/50 bg-[#161b22]/35 px-3 py-2">
                                <div className="min-w-0">
                                    <p className="text-sm font-medium text-slate-100">Microsoft Account</p>
                                    <p className="truncate text-xs text-slate-400">
                                        {minecraftAccount.signedIn
                                            ? `Signed in as ${minecraftAccount.profileName ?? 'Minecraft player'}`
                                            : 'Not signed in. Modpacks launch in offline mode.'}
                                    </p>
                                </div>
                                <span className={`shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium ${minecraftAccount.signedIn ? 'border-emerald-500/50 bg-emerald-900/20 text-emerald-200' : 'border-slate-500/50 bg-[#1a2029]/40 text-slate-300'}`}>
                                    {minecraftAccount.signedIn ? 'Signed In' : 'Offline'}
                                </span>
                            </div>

                            {minecraftAccount.signedIn ? (
                                <button
                                    onClick={handleMinecraftSignOut}
                                    className="clean-button clean-button-ghost px-4 py-2 text-sm"
                                >
                                    Sign out
                                </button>
                            ) : (
                                <>
                                    <button
                                        onClick={handleMinecraftSignIn}
                                        disabled={minecraftSigningIn}
                                        className="clean-button clean-button-soft px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                                    >
                                        {minecraftSigningIn ? 'Waiting for Microsoft...' : 'Sign in with Microsoft'}
                                    </button>
                                    {minecraftSignInCode && (
                                        <div className="mt-3 rounded-lg border border-[#232a34]/50 bg-[#161b22]/35 p-3">
                                            <p className="text-xs text-slate-400">Enter this code in the sign-in window to finish signing in:</p>
                                            <p className="my-2 text-lg font-bold tracking-widest text-slate-100">{minecraftSignInCode.userCode}</p>
                                            <button
                                                type="button"
                                                onClick={() => void window.db.openVerificationWindow(minecraftSignInCode.verificationUri)}
                                                className="text-xs font-medium text-emerald-300 underline hover:text-emerald-200"
                                            >
                                                Reopen sign-in window
                                            </button>
                                            <p className="mt-2 text-xs text-slate-400">Waiting for you to approve the sign-in...</p>
                                        </div>
                                    )}
                                </>
                            )}
                            <p className="mt-2 text-xs text-slate-400">
                                Sign in with your Microsoft account to launch Minecraft with your real profile for online play.
                                Without it, modpacks launch in offline mode.
                            </p>
                        </div>

                        <div className="mt-5 border-t border-[#232a34]/50 pt-4">
                            <h4 className="mb-2 text-sm font-semibold text-slate-200">Minecraft Memory Default</h4>
                            <label className="mb-1 block text-xs uppercase tracking-wide text-slate-400">Default Memory (MB)</label>
                            <input
                                type="number"
                                min={1024}
                                max={65536}
                                step={256}
                                value={defaultMemoryMb}
                                onChange={(event) => setDefaultMemoryMb(Number(event.target.value))}
                                className="clean-input"
                            />
                            <p className="mt-2 text-xs text-slate-400">
                                Used when launching Minecraft modpacks that do not specify a memory allocation.
                            </p>
                            <button
                                onClick={handleSaveDefaultMemory}
                                className="clean-button clean-button-soft mt-3 px-4 py-2 text-sm"
                            >
                                Save Default Memory
                            </button>
                        </div>
                    </section>
                    )}

                    {activeKey === 'updates' && (
                    <section className="clean-panel p-5 sm:p-6">
                        <h3 className="mb-1 text-lg font-semibold text-slate-100">App Updates</h3>
                        <p className="mb-4 text-xs text-slate-400">Check whether a newer version of MMOP is available to download.</p>

                        <div className="flex flex-wrap items-center gap-3">
                            <button
                                onClick={handleCheckForUpdate}
                                className="clean-button clean-button-soft px-4 py-2 text-sm"
                            >
                                Check for Updates
                            </button>
                            {updateInfo?.updateAvailable && updateInfo.downloadUrl && (
                                <a
                                    href={updateInfo.downloadUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="clean-button clean-button-primary px-4 py-2 text-sm"
                                >
                                    Download v{updateInfo.latestVersion}
                                </a>
                            )}
                        </div>
                        {updateStatus && <p className="mt-3 text-sm text-slate-300">{updateStatus}</p>}
                    </section>
                    )}
                    </div>
                </div>
            </div>
        </Layout>
    );
};

export default Settings;
