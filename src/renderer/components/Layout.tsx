import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { BsX } from 'react-icons/bs';
import { FiBell, FiMinus, FiHome, FiSettings, FiLogOut, FiArrowLeft, FiStar } from 'react-icons/fi';
import { ModpackType, NotifiactionType } from '../../types/sharedTypes';
import { LOADER_LABELS, resolveModpackLoader } from '../helpers/minecraft';
import { useProPricing, formatPriceLine } from '../helpers/proPricing';
import { useAuth } from '../context/AuthContext';
import { useLiveRefresh } from '../hooks/useLiveRefresh';
import Logo from './Logo';

interface LayoutProps {
    children: React.ReactNode;
    showNavbar?: boolean;
    showSidebar?: boolean;
}

const Layout: React.FC<LayoutProps> = ({ children, showNavbar = true, showSidebar = true }) => {
    const [notificationsToggled, setNotificationsToggled] = useState<boolean>(false);
    const [notifications, setNotifications] = useState<NotifiactionType[]>([]);
    // Non-blocking status toast for the post-invite-accept mod download.
    const [inviteDownloadStatus, setInviteDownloadStatus] = useState<string>('');
    const inviteStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const navigate = useNavigate();
    const location = useLocation();
    const { token, user, logout, refresh } = useAuth();
    const username = user?.username || 'U';
    const isPro = user?.isPro === true;
    const isWindowsHost = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');

    // Whether the backend actually has Stripe configured; hides the upgrade CTA
    // when subscriptions aren't available.
    const [checkoutConfigured, setCheckoutConfigured] = useState<boolean>(false);
    // Whether this account can still use its one free trial.
    const [trialEligible, setTrialEligible] = useState<boolean>(false);
    const [upgrading, setUpgrading] = useState<boolean>(false);

    // Live pricing for the sidebar upgrade button (fetched only when it shows).
    const pricing = useProPricing(!isPro && checkoutConfigured);
    const priceLine = pricing ? formatPriceLine(pricing) : null;
    const showTrial = !!pricing?.trialDays && trialEligible;

    const handleUpgrade = async (): Promise<void> => {
        if (upgrading) return;
        setUpgrading(true);
        try {
            const result = await window.db.startProCheckout();
            if (!result.success && result.error) {
                setInviteDownloadStatus(result.error);
            }
            // Re-check entitlement shortly after; the webhook flips it server-side.
            setTimeout(() => { void refresh(); }, 4000);
        } finally {
            setUpgrading(false);
        }
    };

    // Persistent sidebar navigation — only the routes the app actually has.
    const navLinks = [
        { name: 'Home', path: '/', icon: <FiHome /> },
        { name: 'Settings', path: '/settings', icon: <FiSettings /> },
    ];

    const pageTitle = location.pathname === '/' ? 'Home'
        : location.pathname === '/settings' ? 'Settings'
        : location.pathname === '/game' ? 'Games'
        : location.pathname === '/modpack' ? 'Modpack'
        : 'MMOP';

    // Sub-screens show a contextual back link in the (fixed) topbar so it never
    // takes a content row. Goes back through history to the actual prior screen.
    const backLabel = location.pathname === '/modpack' ? 'Back to game'
        : location.pathname === '/game' ? 'Back to games'
        : null;

    const handleLogout = () => {
        void logout();
        navigate('/login');
    };

    useEffect(() => {
        if (isPro) {
            setCheckoutConfigured(false);
            return;
        }
        let cancelled = false;
        void window.db.getProStatus().then((status) => {
            if (cancelled) return;
            setCheckoutConfigured(status.configured);
            setTrialEligible(status.trialEligible);
        }).catch(() => { /* leave CTA hidden on error */ });
        return () => { cancelled = true; };
    }, [isPro]);

    const refreshNotifications = useCallback(async () => {
        if (!token) {
            return;
        }

        const _id = user?._id;
        if (!_id) {
            return;
        }

        try {
            setNotifications(await window.db.getNotifications(token, _id));
        } catch {
            // Non-fatal; keep the current list until the next refresh.
        }
    }, [token, user?._id])

    // Initial fetch on mount / sign-in / navigation.
    useEffect(() => {
        void refreshNotifications();
    }, [navigate, refreshNotifications])

    // Keep notifications current without navigating: poll + refresh on focus.
    useLiveRefresh(refreshNotifications, { enabled: !!token && !!user?._id })

    // Clear any pending toast auto-dismiss timer on unmount.
    useEffect(() => () => {
        if (inviteStatusTimerRef.current) {
            clearTimeout(inviteStatusTimerRef.current);
        }
    }, [])

    const showInviteStatus = (message: string, autoClearMs?: number) => {
        if (inviteStatusTimerRef.current) {
            clearTimeout(inviteStatusTimerRef.current);
            inviteStatusTimerRef.current = null;
        }
        setInviteDownloadStatus(message);
        if (autoClearMs) {
            inviteStatusTimerRef.current = setTimeout(() => setInviteDownloadStatus(''), autoClearMs);
        }
    };

    /**
     * After accepting a contributor invite, download the modpack's mods so the
     * new contributor has them locally. Best-effort and non-blocking: if the
     * accept did not stick, the pack won't be in the user's list and we skip
     * silently. Downloads are instance-based and game-agnostic (non-Minecraft
     * packs additionally get deployed to the game's mod directory).
     */
    const downloadAcceptedModpackMods = async (modpackId: string) => {
        if (!token) {
            return;
        }

        try {
            const modpacks = await window.db.getAllModpacks(token);
            const pack = (Array.isArray(modpacks) ? (modpacks as ModpackType[]) : []).find((p) => p._id === modpackId);
            if (!pack || !Array.isArray(pack.mods) || pack.mods.length === 0) {
                return;
            }

            showInviteStatus(`Downloading mods for "${pack.name}"...`);
            const { loader } = resolveModpackLoader(pack);
            const results = await window.db.downloadMods(
                token,
                pack.mods,
                pack.name,
                pack.minecraftVersion,
                loader ? LOADER_LABELS[loader] : undefined,
                pack.gameID,
            );

            const downloaded = results.successful.length + results.dependencies.length;
            if (results.failed.length > 0) {
                showInviteStatus(`"${pack.name}": ${downloaded} mods downloaded, ${results.failed.length} failed.`, 8000);
            } else if (downloaded > 0) {
                showInviteStatus(`"${pack.name}" is ready — ${downloaded} mods downloaded.`, 8000);
            } else {
                showInviteStatus(`"${pack.name}" mods are already up to date.`, 8000);
            }
        } catch (error) {
            console.error('Auto-download after accepting invite failed:', error);
            showInviteStatus('Mod download failed — you can retry from the modpack screen.', 8000);
        }
    };

    const handleRequest = async (notification: NotifiactionType, action: boolean) => {
        if (!token || !notification.modpack_Id) {
            return;
        }

        await window.db.handleAddContributerRequestAction(token, notification.modpack_Id, action);
        await window.db.removeNotification(token, notification.id);
        setNotifications((current) => current.filter((item) => item.id !== notification.id));

        if (action) {
            void downloadAcceptedModpackMods(notification.modpack_Id);
        }
    };

    const handleRead = async () => {
        if (!token) {
            return;
        }

        window.db.markNotificationsAsRead(token);

        const _id = user?._id;
        if (_id) {
            setNotifications(await window.db.getNotifications(token, _id));
        }
    }

    const unreadCount = notifications.filter(n => n.unread).length;

    return (
        <div className="app-shell">
            {/* Persistent sidebar: branding, navigation, account */}
            {showSidebar && (
                <aside className="app-sidebar fixed left-0 top-0 z-40 hidden h-screen w-[260px] flex-col border-r border-[#1a2029]/70 bg-[#10141a]/80 backdrop-blur-xl md:flex">
                    <div className="flex items-center gap-3 px-5 py-5">
                        <Logo className="h-12 w-12 shrink-0" />
                        <div className="min-w-0">
                            <p className="text-lg font-bold leading-tight tracking-tight text-white">MMOP</p>
                            <p className="text-xs text-slate-500">Modpack Manager</p>
                        </div>
                    </div>

                    <nav className="clean-scroll flex-1 space-y-1 overflow-y-auto px-3 py-2">
                        {navLinks.map((link) => {
                            const active = location.pathname === link.path;
                            return (
                                <button
                                    key={link.path}
                                    onClick={() => navigate(link.path)}
                                    aria-current={active ? 'page' : undefined}
                                    className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm font-semibold transition-colors ${
                                        active
                                            ? 'border-emerald-500/40 bg-emerald-900/15 text-white'
                                            : 'border-transparent text-slate-300 hover:bg-[#1a2029]/50 hover:text-white'
                                    }`}
                                >
                                    <span className={`text-lg ${active ? 'text-emerald-300' : 'text-slate-400'}`}>{link.icon}</span>
                                    <span>{link.name}</span>
                                </button>
                            );
                        })}
                    </nav>

                    <div className="border-t border-[#1a2029]/70 p-3">
                        <div className="flex items-center gap-3 rounded-xl px-2 py-2">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#232a34] text-sm font-bold text-white">
                                {username.charAt(0).toUpperCase()}
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                    <p className="truncate text-sm font-medium text-white">{username}</p>
                                    {isPro && (
                                        <span
                                            title="Pro supporter"
                                            className="shrink-0 rounded-full border border-emerald-400/50 bg-emerald-400/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-300"
                                        >
                                            Pro
                                        </span>
                                    )}
                                </div>
                                <p className="text-xs text-slate-500">Signed in</p>
                            </div>
                            <button
                                onClick={handleLogout}
                                title="Sign out"
                                aria-label="Sign out"
                                className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-[#1a2029]/70 hover:text-rose-300"
                            >
                                <FiLogOut size={18} />
                            </button>
                        </div>

                        {!isPro && checkoutConfigured && (
                            <button
                                onClick={() => void handleUpgrade()}
                                disabled={upgrading}
                                className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-emerald-400/40 bg-gradient-to-r from-emerald-500/15 to-cyan-500/15 px-3 py-2 text-sm font-semibold text-emerald-200 transition-colors hover:from-emerald-500/25 hover:to-cyan-500/25 disabled:opacity-60"
                            >
                                <FiStar size={14} />
                                {upgrading
                                    ? 'Opening checkout…'
                                    : showTrial ? `Start ${pricing?.trialDays}-day free trial`
                                    : priceLine ? `Upgrade to Pro — ${priceLine}`
                                    : 'Upgrade to Pro'}
                            </button>
                        )}
                        {/* Attribution for where mod data comes from. */}
                        <p className="px-2 pt-1 text-[11px] text-slate-600">Mod data powered by Modrinth, CurseForge &amp; Thunderstore</p>
                    </div>
                </aside>
            )}

            {/* Content column, offset by the sidebar */}
            <div className={showSidebar ? 'md:pl-[260px]' : ''}>
                {showNavbar && (
                    <header className="app-navbar sticky top-0 z-30 flex h-14 items-center justify-between border-b border-[#1a2029]/70 bg-[#10141a]/70 px-5 backdrop-blur-xl">
                        {backLabel ? (
                            <button
                                onClick={() => navigate(-1)}
                                className="window-control-button group -ml-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm font-medium text-slate-300 transition-colors hover:text-white"
                                data-no-drag="true"
                            >
                                <FiArrowLeft size={16} className="transition-transform group-hover:-translate-x-0.5" />
                                <span>{backLabel}</span>
                            </button>
                        ) : (
                            <h1 className="text-sm font-semibold tracking-wide text-slate-200">{pageTitle}</h1>
                        )}

                        <div className="flex items-center gap-2">
                            <div className="relative window-control-button" data-no-drag="true">
                                <button
                                    className="window-control-button relative rounded-lg p-2 text-slate-400 transition-colors duration-200 hover:bg-[#1a2029]/70 hover:text-white"
                                    onClick={() => setNotificationsToggled(!notificationsToggled)}
                                    aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
                                    aria-expanded={notificationsToggled}
                                >
                                    <FiBell size={19} />
                                    {unreadCount > 0 && (
                                        <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-rose-500"></span>
                                    )}
                                </button>

                                {notificationsToggled && (
                                    <div className="clean-panel absolute right-0 mt-2 w-80 overflow-hidden border-[#232a34]/55 bg-[#161b22]/95 shadow-2xl shadow-[#10141a]/70">
                                        <div className="flex items-center justify-between border-b border-[#232a34]/45 px-4 py-3">
                                            <h3 className="text-sm font-semibold text-white">Notifications</h3>
                                            {unreadCount > 0 && (
                                                <span className="text-xs font-medium text-slate-300">{unreadCount} new</span>
                                            )}
                                        </div>
                                        <div className="clean-scroll max-h-96 overflow-y-auto">
                                            {notifications.length === 0 ? (
                                                <div className="px-4 py-8 text-center text-sm text-slate-400">No notifications</div>
                                            ) : (
                                                notifications.map((notification) => (
                                                    <div
                                                        key={notification.id}
                                                        className={`border-b border-[#232a34]/40 px-4 py-3 transition-colors duration-200 hover:bg-[#1a2029]/75 ${
                                                            notification.unread ? 'bg-[#161b22]/10' : ''
                                                        }`}
                                                    >
                                                        <div className="mb-1 flex items-start justify-between">
                                                            <h4 className="flex items-center text-sm font-medium text-white">
                                                                {notification.title}
                                                                {notification.unread && (
                                                                    <span className="ml-2 h-2 w-2 rounded-full bg-slate-400"></span>
                                                                )}
                                                            </h4>
                                                        </div>
                                                        <p className="mb-3 text-sm text-slate-400">{notification.message}</p>

                                                        {notification.type === 'request' && (
                                                            <div className="flex items-center space-x-2">
                                                                <button
                                                                    onClick={() => handleRequest(notification, true)}
                                                                    className="clean-button clean-button-soft flex-1 border-emerald-500/40 bg-emerald-900/35 px-3 py-1.5 text-xs text-emerald-200"
                                                                >
                                                                    Accept
                                                                </button>
                                                                <button
                                                                    onClick={() => handleRequest(notification, false)}
                                                                    className="clean-button clean-button-danger flex-1 px-3 py-1.5 text-xs"
                                                                >
                                                                    Deny
                                                                </button>
                                                            </div>
                                                        )}
                                                    </div>
                                                ))
                                            )}
                                        </div>
                                        <div className="border-t border-[#232a34]/45 bg-[#161b22]/65 px-4 py-2">
                                            <button className="w-full text-center text-sm text-slate-300 transition-colors duration-200 hover:text-slate-200" onClick={handleRead}>
                                                Mark all as read
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>

                            {isWindowsHost && (
                                <div className="window-control-button ml-1 flex items-center gap-1" data-no-drag="true">
                                    <button
                                        className="window-control-button rounded-md p-1.5 text-slate-400 transition-colors duration-200 hover:bg-[#1a2029]/80 hover:text-white"
                                        title="Minimize"
                                        aria-label="Minimize window"
                                        onClick={() => {
                                            void window.db.minimizeWindow();
                                        }}
                                    >
                                        <FiMinus size={15} />
                                    </button>
                                    <button
                                        className="window-control-button rounded-md p-1.5 text-slate-400 transition-colors duration-200 hover:bg-rose-700/35 hover:text-rose-200"
                                        title="Close"
                                        aria-label="Close window"
                                        onClick={() => {
                                            void window.db.closeWindow();
                                        }}
                                    >
                                        <BsX size={17} />
                                    </button>
                                </div>
                            )}
                        </div>
                    </header>
                )}

                <main className="min-h-screen">{children}</main>
            </div>

            {/* Invite-accept mod download status toast */}
            {inviteDownloadStatus && (
                <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-xl border border-[#232a34]/55 bg-[#161b22]/95 px-4 py-3 text-sm text-slate-200 shadow-2xl shadow-[#10141a]/70">
                    <span>{inviteDownloadStatus}</span>
                    <button
                        onClick={() => showInviteStatus('')}
                        className="text-slate-400 transition-colors duration-200 hover:text-white"
                        title="Dismiss"
                    >
                        <BsX size={18} />
                    </button>
                </div>
            )}
        </div>
    );
};

export default Layout;
