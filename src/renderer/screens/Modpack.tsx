import React, { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import Layout from "../components/Layout";
import Modal from "../components/Modal";
import { FiCheck, FiUserPlus, FiDownload, FiPlus, FiRefreshCw, FiSearch, FiSliders } from "react-icons/fi";
import { ModLoaderType, ModpackType } from "../../types/sharedTypes";
import ModpackHeader from "../components/modpack/ModpackHeader";
import ModList from "../components/modpack/ModList";
import ContributionRequestsTab from "../components/modpack/ContributionRequests";
import AddModsModal from "../components/modpack/AddModsModal";
import AddContributorsModal from "../components/modpack/AddContributorsModal";
import SettingsModal from "../components/modpack/SettingsModal";
import ConfigEditorModal from "../components/modpack/ConfigEditorModal";
import ResultBanner, { joinCapped } from "../components/modpack/ResultBanner";
import DeleteConfirmModal from "../components/modpack/DeleteConfirmModal";
import PendingRequestBanner from "../components/modpack/PendingRequestBanner";
import SmapiInstallModal from "../components/SmapiInstallModal";
import { LOADER_LABELS, resolveModpackLoader, useMinecraftVersions, useLoaderVersions, useLoaderInstaller } from "../helpers/minecraft";
import { supportsVersionAndLoaderSelection } from "../../config/games";
import { useAuth } from "../context/AuthContext";
import { useModpackData } from "../hooks/useModpackData";
import { useModManagement } from "../hooks/useModManagement";
import { useContributions } from "../hooks/useContributions";
import { useLiveRefresh } from "../hooks/useLiveRefresh";
import { recordModpackPlayed } from "../helpers/recentlyPlayed";

const Modpack: React.FC = () => {
    const location = useLocation();
    const navigate = useNavigate();
    const { token, user } = useAuth();

    const game = location.state?.game;

    // Modpack record + editable mod list + provider details for those mods
    const {
        modpack,
        setModpack,
        loading,
        setLoading,
        currentMods,
        setCurrentMods,
        currentModDetails,
        refreshModpack,
    } = useModpackData(location.state?.modpack as ModpackType, token);

    const supportsLoaderSettings = supportsVersionAndLoaderSelection(modpack?.gameID);

    // Mod update checking applies to Minecraft packs with a pinned version+loader.
    const packLoader = modpack ? resolveModpackLoader(modpack).loader : undefined;
    const canCheckUpdates = supportsLoaderSettings && !!modpack?.minecraftVersion && !!packLoader;

    // Add/remove/download mods + the "Add Mods" modal state
    const {
        availableMods,
        loadingMods,
        loadingMoreMods,
        modsError,
        hasMoreMods,
        totalModsCount,
        showAddModsModal,
        setShowAddModsModal,
        modProviders,
        modProvider,
        setModProvider,
        searchQuery,
        setSearchQuery,
        debouncedSearch,
        downloading,
        downloadProgress,
        downloadResults,
        setDownloadResults,
        modsPresent,
        allModsDownloaded,
        checkingUpdates,
        updateCheck,
        setUpdateCheck,
        updatingMods,
        checkForUpdates,
        applyModUpdates,
        incompatibleMods,
        checkingCompatibilityIds,
        handleAddMod,
        handleRemoveMod,
        handleScroll,
        handleCloseModsModal,
        downloadModList,
    } = useModManagement({ modpack, token, navigate, currentMods, setCurrentMods, setLoading });

    // Contributors, contribution requests, save flows + their notifications
    const {
        registeredUsers,
        contributersInModpack,
        pendingContributers,
        saving,
        saveError,
        clearSaveError,
        submitted,
        saveSuccess,
        clearSaveSuccess,
        addingContributorId,
        isAuthor,
        contributionRequests,
        hasChanges,
        myPendingRequest,
        isModPendingApproval,
        handleAddUser,
        handleRemoveUser,
        handleContributionAction,
        handleSave,
        handleDownloadMods,
    } = useContributions({
        modpack,
        setModpack,
        token,
        user,
        navigate,
        currentMods,
        setCurrentMods,
        setLoading,
        downloadModList,
        closeModsModal: handleCloseModsModal,
    });

    // Keep the pack (mod list + contribution requests/approvals) current while
    // it's open, without the user navigating away and back.
    useLiveRefresh(refreshModpack, { enabled: !!token });

    // Screen-local UI state (tabs, modals, launch + delete + version-edit flows)
    const [showAddContributorsModal, setShowAddContributorsModal] = useState<boolean>(false);
    const [activeTab, setActiveTab] = useState<'main' | 'diffs'>('main');
    const [launching, setLaunching] = useState<boolean>(false);
    const [launchPulse, setLaunchPulse] = useState<number>(0);
    const [launchError, setLaunchError] = useState<string>('');
    const [gameExecutable, setGameExecutable] = useState<string | null>(null);
    const [showExeModal, setShowExeModal] = useState<boolean>(false);
    const [showSmapiModal, setShowSmapiModal] = useState<boolean>(false);
    const [showDeleteModal, setShowDeleteModal] = useState<boolean>(false);
    const [showConfigEditor, setShowConfigEditor] = useState<boolean>(false);
    const [deleting, setDeleting] = useState<boolean>(false);
    const [editMcVersion, setEditMcVersion] = useState<string>('');
    const [incompatibleOnSave, setIncompatibleOnSave] = useState<string[] | null>(null);
    const [launchStatus, setLaunchStatus] = useState<string>('');
    const modName = (id: string) => currentModDetails.find((m) => String(m._id) === id)?.name ?? id;
    const [editModLoader, setEditModLoader] = useState<ModLoaderType | ''>('');
    const [editLoaderVersion, setEditLoaderVersion] = useState<string>('');
    const [editMemoryAllocationMb, setEditMemoryAllocationMb] = useState<string>('4096');
    const [editCustomJvmArgs, setEditCustomJvmArgs] = useState<string>('');
    const [savingVersions, setSavingVersions] = useState<boolean>(false);

    // Game-specific hooks
    const { installingLoader, loaderInstalled, loaderResult, clearLoaderResult, ensureLoaderInstalled } = useLoaderInstaller(modpack);
    const { mcVersions } = useMinecraftVersions(isAuthor && supportsLoaderSettings);
    const { loaderVersions, loadingLoaderVersions } = useLoaderVersions(editModLoader, editMcVersion);

    // Load stored game executable on mount
    useEffect(() => {
        if (!modpack) return;
        if (!supportsLoaderSettings) {
            window.db.getGameExecutable(modpack.gameID).then(exe => {
                if (exe) setGameExecutable(exe);
            });
        }
    }, [modpack?.gameID, supportsLoaderSettings]);

    // Init edit fields when modpack/author state is ready
    useEffect(() => {
        if (!modpack || !supportsLoaderSettings || !isAuthor) return;
        setEditMcVersion(modpack.minecraftVersion ?? '');
        setEditModLoader(modpack.modLoader ?? (modpack.forgeVersion ? 'forge' : ''));
        setEditLoaderVersion(modpack.loaderVersion ?? modpack.forgeVersion ?? '');
        setEditMemoryAllocationMb(String(modpack.memoryAllocationMb ?? 4096));
        setEditCustomJvmArgs(modpack.customJvmArgs ?? '');
    }, [modpack?.gameID, supportsLoaderSettings, isAuthor]);

    // Auto-select first loader version when list changes
    useEffect(() => {
        if (loaderVersions.length > 0 && !loaderVersions.includes(editLoaderVersion)) {
            setEditLoaderVersion(loaderVersions[0]);
        }
    }, [loaderVersions]);

    const performVersionSave = async (mods: string[]) => {
        if (!modpack || !token) return;
        const parsedMemoryMb = Number.parseInt(editMemoryAllocationMb, 10);
        const normalizedMemoryMb = Number.isFinite(parsedMemoryMb)
            ? Math.max(1024, Math.min(65536, parsedMemoryMb))
            : undefined;

        const trimmedJvmArgs = editCustomJvmArgs.trim();
        const updated = {
            ...modpack,
            minecraftVersion: editMcVersion || undefined,
            modLoader: (editModLoader || undefined) as ModLoaderType | undefined,
            loaderVersion: editLoaderVersion || undefined,
            memoryAllocationMb: normalizedMemoryMb,
            customJvmArgs: trimmedJvmArgs || undefined,
            mods,
        };
        const ok = await window.db.updateModpack(token, updated);
        if (ok) {
            setModpack(updated);
            setCurrentMods(mods);
        }
    };

    // Save (or clear with '') a custom modpack icon. Pro-gated server-side.
    const handleSaveIcon = async (icon: string): Promise<{ success: boolean; error?: string }> => {
        if (!modpack || !token) return { success: false, error: 'You must be signed in.' };
        const updated = { ...modpack, icon };
        const ok = await window.db.updateModpack(token, updated);
        if (!ok) return { success: false, error: 'Could not save the icon — custom icons require Pro.' };
        setModpack(updated);
        return { success: true };
    };

    const handleSaveVersions = async () => {
        if (!modpack || !supportsLoaderSettings) return;
        setSavingVersions(true);
        try {
            if (!token) return;

            // Changing the MC version can leave mods without a compatible file.
            // Check each mod individually and never remove anything silently —
            // the user confirms the removal list first.
            if (editMcVersion && editMcVersion !== modpack.minecraftVersion && currentMods.length > 0) {
                const loaderForCheck = editModLoader || modpack.modLoader || '';
                const results = await Promise.all(currentMods.map(async (id) => {
                    try {
                        const res = await window.db.checkModCompatibility(id, editMcVersion, loaderForCheck);
                        return { id, compatible: res.compatible !== false };
                    } catch {
                        // Fail open: a provider hiccup must not delete mods.
                        return { id, compatible: true };
                    }
                }));
                const incompatible = results.filter((r) => !r.compatible).map((r) => r.id);
                if (incompatible.length > 0) {
                    setIncompatibleOnSave(incompatible);
                    return;
                }
            }

            await performVersionSave(currentMods);
        } finally {
            setSavingVersions(false);
        }
    };

    const confirmVersionSaveRemoving = async (removeIds: string[]) => {
        setSavingVersions(true);
        try {
            setIncompatibleOnSave(null);
            await performVersionSave(currentMods.filter((id) => !removeIds.includes(id)));
        } finally {
            setSavingVersions(false);
        }
    };

    const handleLaunchGame = async () => {
        setLaunchError('');
        setLaunchStatus('');
        if (!supportsLoaderSettings) {
            const exe = gameExecutable ?? await window.db.getGameExecutable(modpack.gameID);
            if (!exe) {
                setShowExeModal(true);
                return;
            }
        } else {
            // Install Minecraft + the mod loader first so the UI can show install progress.
            const installResult = await ensureLoaderInstalled();
            if (!installResult.success) {
                setLaunchError(installResult.error ?? 'Failed to prepare Minecraft for launch.');
                return;
            }
        }

        setLaunching(true);
        try {
            const result = await window.db.launchGame(modpack.gameID, modpack.name, modpack.memoryAllocationMb, {
                minecraftVersion: modpack.minecraftVersion,
                modLoader: modpack.modLoader,
                loaderVersion: modpack.loaderVersion ?? modpack.forgeVersion,
                customJvmArgs: modpack.customJvmArgs,
            });
            if (result.needsSmapi) {
                // Stardew without SMAPI: install it via the styled modal, then
                // launch again automatically.
                setShowSmapiModal(true);
                return;
            }
            if (!result.success) {
                let message = result.error ?? 'Failed to launch game.';
                if (supportsLoaderSettings) {
                    try {
                        const accountStatus = await window.db.getMinecraftAccountStatus();
                        if (!accountStatus.signedIn) {
                            message += ' Tip: sign in with your Microsoft account in Settings for online play.';
                        }
                    } catch {
                        // Status check is best-effort; keep the original error.
                    }
                }
                setLaunchError(message);
            } else {
                setLaunchStatus(
                    supportsLoaderSettings
                        ? (result.authMode === 'microsoft'
                            ? 'Minecraft is starting with your Microsoft account — have fun!'
                            : 'Minecraft is starting in offline mode — have fun!')
                        : 'Game is starting — have fun!'
                );
                setLaunchPulse((p) => p + 1);
                recordModpackPlayed(user?._id, modpack._id);
            }
        } finally {
            setLaunching(false);
        }
    };

    const handleDeleteModpack = async () => {
        if (!modpack) return;
        setDeleting(true);
        try {
            if (!token) {
                navigate('/login');
                return;
            }
            const success = await window.db.deleteModpack(token, modpack._id);
            if (success) {
                // Replace the (now-deleted) modpack entry in history so the back
                // button can't navigate back into a pack that no longer exists.
                navigate('/game', { replace: true, state: { game: game ?? { id: modpack.gameID } } });
            }
        } catch (error) {
            console.error('Error deleting modpack:', error);
        } finally {
            setDeleting(false);
            setShowDeleteModal(false);
        }
    };

    if (!modpack) {
        return null;
    }

    const currentModObjects = currentModDetails;

    // Filter users for contributors modal (local search)
    const filteredUsers = showAddContributorsModal
        ? registeredUsers.filter(user => user.username.toLowerCase().includes(searchQuery.toLowerCase()))
        : [];

    if (loading) {
        return (
            <Layout>
                <div className="app-container py-10">
                    <div className="clean-panel py-16 text-center">
                        <p className="text-lg text-zinc-300">Loading modpack...</p>
                    </div>
                </div>
            </Layout>
        );
    }

    // What "Download Mods" actually fetches: an author downloads their working
    // set, a contributor only the approved pack contents (never unsaved adds).
    const downloadableModsCount = isAuthor ? currentMods.length : (modpack.mods?.length ?? 0);

    // Pack-level action buttons, rendered inline with Launch in the hero.
    const headerActions = (
        <>
            {!showAddModsModal && (
                isAuthor ? (
                    <button
                        onClick={() => handleSave()}
                        disabled={saving || !hasChanges}
                        className="clean-button clean-button-soft border-emerald-500/45 bg-emerald-900/35 px-3.5 py-2 text-sm text-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
                        title={hasChanges ? 'Save your changes to this modpack' : 'No unsaved changes'}
                    >
                        <FiCheck />
                        <span>{saving ? 'Saving...' : 'Save Changes'}</span>
                    </button>
                ) : (
                    <button
                        onClick={() => handleSave()}
                        disabled={saving || submitted || !hasChanges}
                        className="clean-button clean-button-soft px-3.5 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                        title={submitted ? 'Your request has been submitted for approval' : hasChanges ? 'Send your proposed changes to the pack author for approval' : 'No changes to propose'}
                    >
                        <FiCheck />
                        <span>{saving ? 'Requesting...' : submitted ? 'Request Submitted' : 'Request Save'}</span>
                    </button>
                )
            )}
            {isAuthor && (
                <button
                    onClick={() => setShowAddContributorsModal(true)}
                    className="clean-button clean-button-ghost px-3.5 py-2 text-sm"
                >
                    <FiUserPlus />
                    <span>Add Contributors</span>
                </button>
            )}
            <button
                onClick={() => setShowConfigEditor(true)}
                className="clean-button clean-button-ghost px-3.5 py-2 text-sm"
                title="View and edit this pack's config files"
            >
                <FiSliders />
                <span>Edit Config</span>
            </button>
            {/* Hidden once everything is on disk; it reappears when the mod list
                changes (allModsDownloaded resets on any add/remove). */}
            {!allModsDownloaded && (
                <button
                    onClick={() => handleDownloadMods()}
                    disabled={downloading || downloadableModsCount === 0}
                    className="clean-button clean-button-ghost border-zinc-500/40 px-3.5 py-2 text-sm text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
                    title="Download missing mods and update any that have a newer version"
                >
                    <FiDownload />
                    <span>
                        {downloading
                            ? (downloadResults && downloadResults.skipped.length === downloadableModsCount ? 'Checking...' : 'Downloading...')
                            : (modsPresent && !canCheckUpdates ? 'Check for Updates' : 'Download Mods')}
                    </span>
                </button>
            )}
            {canCheckUpdates && (
                <button
                    onClick={() => checkForUpdates()}
                    disabled={checkingUpdates || updatingMods || downloading || currentMods.length === 0}
                    className="clean-button clean-button-ghost border-zinc-500/40 px-3.5 py-2 text-sm text-zinc-200 disabled:cursor-not-allowed disabled:opacity-60"
                    title="Compare installed mod files against the newest compatible versions"
                >
                    <FiRefreshCw className={checkingUpdates ? 'animate-spin' : ''} />
                    <span>{checkingUpdates ? 'Checking...' : 'Check for Updates'}</span>
                </button>
            )}
        </>
    );

    return (
        <Layout>
            <div className="app-container py-8 sm:py-10">
                <div>
                    <ModpackHeader
                        modpack={modpack}
                        currentModsCount={currentMods.length}
                        isAuthor={isAuthor}
                        installingLoader={installingLoader}
                        loaderInstalled={loaderInstalled}
                        launching={launching}
                        gameExecutable={gameExecutable}
                        launchPulse={launchPulse}
                        gameImage={game?.image ?? game?.imagePath}
                        contributersInModpack={contributersInModpack}
                        pendingContributers={pendingContributers}
                        onLaunch={handleLaunchGame}
                        onOpenSettings={() => setShowExeModal(true)}
                        onRemoveUser={handleRemoveUser}
                    />

                    {/* Control bar (where the tabs used to be): pack actions on the
                        left, the author-only view switcher on the right. */}
                    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-2">
                            {(!isAuthor || activeTab === 'main') && headerActions}
                        </div>

                        {isAuthor && (
                            <div className="inline-flex rounded-lg border border-zinc-700/50 bg-zinc-900/40 p-1">
                                <button
                                    className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${activeTab === 'main' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-white'}`}
                                    onClick={() => setActiveTab('main')}
                                >
                                    Modpack
                                </button>
                                <button
                                    className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${activeTab === 'diffs' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-white'}`}
                                    onClick={() => setActiveTab('diffs')}
                                >
                                    Collaboration Log
                                </button>
                            </div>
                        )}
                    </div>

                    {/* Main Tab Content */}
                    {(!isAuthor || activeTab === 'main') && (
                        <>
                            {/* Contributor's pending request banner */}
                            {myPendingRequest && (
                                <PendingRequestBanner request={myPendingRequest} />
                            )}

                            {/* Live per-mod progress while a download or update runs */}
                            {(downloading || updatingMods) && downloadProgress && downloadProgress.total > 0 && (
                                <div className="mb-6 rounded-xl border border-zinc-700/45 bg-zinc-900/55 p-4" role="status" aria-live="polite">
                                    <div className="mb-2 flex items-center justify-between text-sm">
                                        <span className="truncate text-zinc-300">Downloading {downloadProgress.currentMod}</span>
                                        <span className="ml-4 shrink-0 text-zinc-400">{downloadProgress.completed} / {downloadProgress.total}</span>
                                    </div>
                                    <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                                        <div
                                            className="h-full rounded-full bg-emerald-500 transition-[width] duration-200"
                                            style={{ width: `${Math.min(100, (downloadProgress.completed / downloadProgress.total) * 100)}%` }}
                                        />
                                    </div>
                                </div>
                            )}

                            {/* Operation results. Bounded + scrollable so several at once
                                never push the mod list off-screen. */}
                            <div className="clean-scroll max-h-[55vh] overflow-y-auto">
                            {/* Save / request-submitted confirmation */}
                            {saveSuccess && (
                                <ResultBanner kind="success" onDismiss={clearSaveSuccess}>
                                    <p className="font-medium text-green-400">{saveSuccess}</p>
                                </ResultBanner>
                            )}
                            {/* Update Check Banner */}
                            {updateCheck && (
                                <ResultBanner
                                    kind={updateCheck.updates.length > 0 ? 'info' : updateCheck.failures.length > 0 ? 'warning' : 'success'}
                                    onDismiss={() => setUpdateCheck(null)}
                                >
                                    {updateCheck.updates.length > 0 ? (
                                        <>
                                            <p className="mb-1 font-medium text-sky-300">
                                                {updateCheck.updates.length} {updateCheck.updates.length === 1 ? 'update' : 'updates'} available
                                            </p>
                                            <ul className="clean-scroll mb-3 max-h-48 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs text-sky-200/80">
                                                {updateCheck.updates.map((update) => (
                                                    <li key={update.id}>
                                                        {update.name} — {update.installedFileName
                                                            ? <span className="font-mono">{update.installedFileName} → {update.latestFileName}</span>
                                                            : <>not installed (latest: <span className="font-mono">{update.latestFileName}</span>)</>}
                                                    </li>
                                                ))}
                                            </ul>
                                            <button
                                                onClick={() => applyModUpdates(updateCheck.updates.map((update) => update.id))}
                                                disabled={updatingMods || downloading}
                                                className="clean-button clean-button-soft px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                                            >
                                                <FiDownload />
                                                <span>
                                                    {updatingMods
                                                        ? 'Updating...'
                                                        : `Update ${updateCheck.updates.length} ${updateCheck.updates.length === 1 ? 'mod' : 'mods'}`}
                                                </span>
                                            </button>
                                        </>
                                    ) : (
                                        <p className="font-medium text-green-400">
                                            All mods are up to date ({updateCheck.checked} checked)
                                        </p>
                                    )}
                                    {updateCheck.failures.length > 0 && (
                                        <div className="mt-2">
                                            <p className="mb-1 text-xs font-medium text-amber-400">
                                                {updateCheck.failures.length} {updateCheck.failures.length === 1 ? 'mod' : 'mods'} could not be checked:
                                            </p>
                                            <ul className="clean-scroll max-h-32 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs text-amber-300/90">
                                                {updateCheck.failures.map((failure, index) => (
                                                    <li key={`${failure.id}-${index}`}>{modName(failure.id)} — {failure.reason}</li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                </ResultBanner>
                            )}

                            {/* Download Results Banner */}
                            {downloadResults && (
                                <ResultBanner
                                    kind={downloadResults.failed.length === 0
                                        ? 'success'
                                        : downloadResults.successful.length === 0 && downloadResults.dependencies.length === 0
                                        ? 'error'
                                        : 'warning'}
                                    onDismiss={() => setDownloadResults(null)}
                                    details={(
                                        <>
                                            <p>Saved to: <span className="font-mono text-zinc-300">{downloadResults.downloadPath}</span></p>
                                            {downloadResults.deployedTo && (
                                                <p>Installed into game: <span className="font-mono text-zinc-300">{downloadResults.deployedTo}</span></p>
                                            )}
                                        </>
                                    )}
                                >
                                    {downloadResults.successful.length > 0 && (
                                        <p className="mb-1 text-sm font-medium text-green-400">
                                            Downloaded: {joinCapped(downloadResults.successful)}
                                        </p>
                                    )}
                                    {downloadResults.dependencies.length > 0 && (
                                        <p className="mb-1 text-sm font-medium text-zinc-400">
                                            Auto-installed dependencies: {joinCapped(downloadResults.dependencies)}
                                        </p>
                                    )}
                                    {downloadResults.skipped.length > 0 && downloadResults.successful.length === 0 && downloadResults.failed.length === 0 && downloadResults.dependencies.length === 0 && (
                                        <p className="mb-1 text-sm font-medium text-zinc-300">
                                            All mods are up to date
                                        </p>
                                    )}
                                    {downloadResults.skipped.length > 0 && (downloadResults.successful.length > 0 || downloadResults.failed.length > 0) && (
                                        <p className="mb-1 text-xs text-zinc-500">
                                            {downloadResults.skipped.length} already up to date
                                        </p>
                                    )}
                                    {downloadResults.failed.length > 0 && (
                                        <p className="text-sm font-medium text-red-400">
                                            Failed: {joinCapped(downloadResults.failed)}
                                        </p>
                                    )}
                                </ResultBanner>
                            )}

                            {/* Loader Install Result Banner */}
                            {loaderResult && (
                                <ResultBanner
                                    kind={loaderResult.success ? 'success' : 'error'}
                                    onDismiss={() => clearLoaderResult()}
                                    details={loaderResult.success ? (
                                        <>
                                            <p>Profile ID: <span className="font-mono text-zinc-300">{loaderResult.profileId}</span></p>
                                            <p>Version: <span className="font-mono text-zinc-300">{loaderResult.loaderVersionId}</span></p>
                                            <p>Instance path: <span className="font-mono text-zinc-300">{loaderResult.profilesPath}</span></p>
                                        </>
                                    ) : undefined}
                                >
                                    {loaderResult.success ? (
                                        <p className="font-medium text-green-400">{LOADER_LABELS[modpack.modLoader ?? 'forge']} installed — ready to launch from MMOP.</p>
                                    ) : (
                                        <>
                                            <p className="mb-1 font-medium text-red-400">Install failed{loaderResult.step ? ` at step: ${loaderResult.step}` : ''}</p>
                                            <p className="whitespace-pre-wrap font-mono text-xs text-red-300">{loaderResult.error}</p>
                                        </>
                                    )}
                                </ResultBanner>
                            )}

                            {/* Launch result */}
                            {launchStatus && (
                                <ResultBanner kind="success" onDismiss={() => setLaunchStatus('')}>
                                    <p className="font-medium text-green-400">{launchStatus}</p>
                                </ResultBanner>
                            )}
                            {launchError && (
                                <ResultBanner kind="error" onDismiss={() => setLaunchError('')}>
                                    <p className="font-medium text-red-400">{launchError}</p>
                                </ResultBanner>
                            )}
                            </div>

                            <div className="grid gap-6 lg:grid-cols-12">
                                <div className="lg:col-span-8">
                                    <ModList
                                        mods={currentModObjects}
                                        isModPendingApproval={isModPendingApproval}
                                        updatableModIds={new Set(updateCheck?.updates.map((update) => update.id) ?? [])}
                                        onRemoveMod={handleRemoveMod}
                                    />
                                </div>

                                {/* Add-from-database side panel (concept's right rail). */}
                                <aside className="lg:col-span-4 lg:self-start">
                                    <section className="clean-panel p-5 lg:sticky lg:top-20">
                                        <h3 className="flex items-center gap-2 text-base font-semibold text-zinc-100">
                                            <FiSearch className="text-emerald-300" />
                                            Add Mods
                                        </h3>
                                        <p className="mt-2 text-sm text-zinc-400">
                                            Search the mod database and add new mods to this pack.
                                        </p>
                                        <button
                                            onClick={() => setShowAddModsModal(true)}
                                            className="clean-button clean-button-primary mt-4 w-full px-4 py-2.5 text-sm font-semibold"
                                        >
                                            <FiPlus />
                                            <span>Browse mods</span>
                                        </button>
                                    </section>
                                </aside>
                            </div>
                        </>
                    )}

                    {/* Author-only: Contribution Requests Tab Content */}
                    {isAuthor && activeTab === 'diffs' && (
                        <ContributionRequestsTab
                            requests={contributionRequests}
                            contributersInModpack={contributersInModpack}
                            onAction={handleContributionAction}
                        />
                    )}

                    {/* Add Mods Modal */}
                    {showAddModsModal && (
                        <AddModsModal
                            searchQuery={searchQuery}
                            onSearchChange={setSearchQuery}
                            modProviders={modProviders}
                            modProvider={modProvider}
                            onSelectProvider={setModProvider}
                            availableMods={availableMods}
                            currentMods={currentMods}
                            totalModsCount={totalModsCount}
                            loadingMods={loadingMods}
                            loadingMoreMods={loadingMoreMods}
                            modsError={modsError}
                            hasMoreMods={hasMoreMods}
                            debouncedSearch={debouncedSearch}
                            hasChanges={hasChanges}
                            saving={saving}
                            submitted={submitted}
                            saveError={saveError}
                            isAuthor={isAuthor}
                            incompatibleMods={incompatibleMods}
                            checkingModIds={checkingCompatibilityIds}
                            onAddMod={handleAddMod}
                            onScroll={handleScroll}
                            onSave={() => handleSave()}
                            onClose={() => {
                                clearSaveError();
                                handleCloseModsModal();
                            }}
                        />
                    )}

                    {/* Add Contributors Modal */}
                    {showAddContributorsModal && (
                        <AddContributorsModal
                            searchQuery={searchQuery}
                            onSearchChange={setSearchQuery}
                            filteredUsers={filteredUsers}
                            onAddUser={handleAddUser}
                            addingContributorId={addingContributorId}
                            onClose={() => setShowAddContributorsModal(false)}
                        />
                    )}
                </div>
            </div>

            {/* Confirm removal of mods incompatible with the new MC version */}
            {incompatibleOnSave && (
                <Modal
                    onClose={() => setIncompatibleOnSave(null)}
                    busy={savingVersions}
                    title={`${incompatibleOnSave.length} ${incompatibleOnSave.length === 1 ? 'mod has' : 'mods have'} no file for ${editMcVersion}`}
                    description={`Saving will remove ${incompatibleOnSave.length === 1 ? 'it' : 'them'} from the modpack:`}
                >
                    <div className="p-6 pt-4">
                        <ul className="clean-scroll max-h-48 space-y-1 overflow-y-auto text-sm text-zinc-200">
                            {incompatibleOnSave.map((id) => {
                                const detail = currentModDetails.find((m) => String(m._id) === id);
                                return <li key={id} className="truncate">{detail?.name ?? id}</li>;
                            })}
                        </ul>
                        <div className="mt-5 flex justify-end gap-3">
                            <button
                                onClick={() => setIncompatibleOnSave(null)}
                                disabled={savingVersions}
                                className="clean-button clean-button-ghost px-4 py-2 text-sm disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={() => void confirmVersionSaveRemoving(incompatibleOnSave)}
                                disabled={savingVersions}
                                className="clean-button clean-button-danger px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-55"
                            >
                                {savingVersions ? 'Removing…' : 'Remove and save'}
                            </button>
                        </div>
                    </div>
                </Modal>
            )}

            {/* Config Editor Modal */}
            {showConfigEditor && (
                <ConfigEditorModal
                    modpackName={modpack.name}
                    gameId={modpack.gameID}
                    onClose={() => setShowConfigEditor(false)}
                />
            )}

            {/* Settings Modal */}
            {showExeModal && (
                <SettingsModal
                    modpack={modpack}
                    isAuthor={isAuthor}
                    mcVersions={mcVersions}
                    loaderVersions={loaderVersions}
                    loadingLoaderVersions={loadingLoaderVersions}
                    editMcVersion={editMcVersion}
                    editModLoader={editModLoader}
                    editLoaderVersion={editLoaderVersion}
                    editMemoryAllocationMb={editMemoryAllocationMb}
                    editCustomJvmArgs={editCustomJvmArgs}
                    savingVersions={savingVersions}
                    onEditMcVersion={setEditMcVersion}
                    onEditModLoader={(v) => setEditModLoader(v)}
                    onEditLoaderVersion={setEditLoaderVersion}
                    onEditMemoryAllocationMb={setEditMemoryAllocationMb}
                    onEditCustomJvmArgs={setEditCustomJvmArgs}
                    onSaveVersions={handleSaveVersions}
                    onSaveIcon={handleSaveIcon}
                    onDelete={isAuthor ? () => { setShowExeModal(false); setShowDeleteModal(true); } : undefined}
                    onClose={() => setShowExeModal(false)}
                />
            )}

            {/* Delete Modpack Confirm Modal */}
            {showDeleteModal && (
                <DeleteConfirmModal
                    modpackName={modpack.name}
                    deleting={deleting}
                    onConfirm={handleDeleteModpack}
                    onClose={() => setShowDeleteModal(false)}
                />
            )}

            {showSmapiModal && (
                <SmapiInstallModal
                    gameId={modpack.gameID}
                    gameName={game?.title ?? game?.name ?? 'Stardew Valley'}
                    onClose={() => setShowSmapiModal(false)}
                    onInstalled={() => {
                        // SMAPI is in place now — close and launch again.
                        setShowSmapiModal(false);
                        void handleLaunchGame();
                    }}
                />
            )}
        </Layout>
    );
};

export default Modpack;
