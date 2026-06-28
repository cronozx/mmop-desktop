import React, { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import Layout from "../components/Layout";
import { FiPackage, FiUpload, FiUsers, FiPlus } from "react-icons/fi";
import { GameType, ModLoaderType, ModpackImportDraft, ModpackProviderId, ModpackType } from "../../types/sharedTypes";
import BrowseModpacksModal from "../components/modpack/BrowseModpacksModal";
import { MOD_LOADERS, useMinecraftVersions, useLoaderVersions, useAvailableLoaders } from "../helpers/minecraft";
import { supportsVersionAndLoaderSelection } from "../../config/games";
import { useAuth } from "../context/AuthContext";
import MicrosoftSignInModal from "../components/MicrosoftSignInModal";
import SmapiInstallModal from "../components/SmapiInstallModal";
import Modal from "../components/Modal";

const GameDetail: React.FC = () => {
    const location = useLocation();
    const navigate = useNavigate();
    const { token, user } = useAuth();
    const game = location.state?.game;

    const [modpackName, setModpackName] = useState<string>("");
    const [modpackDescription, setModpackDescription] = useState<string>("");
    const [gameConfig, setGameConfig] = useState<GameType | null>(null);
    const [loading, setLoading] = useState<boolean>(true);
    const [modpacks, setModpacks] = useState<ModpackType[]>([]);
    const [showCreateForm, setShowCreateForm] = useState<boolean>(false);
    const [minecraftVersion, setMinecraftVersion] = useState<string>("");
    const [modLoader, setModLoader] = useState<ModLoaderType>('forge');
    const [loaderVersion, setLoaderVersion] = useState<string>("");
    const [createSuccess, setCreateSuccess] = useState<boolean>(false);
    const [createError, setCreateError] = useState<string>('');
    const [launcherNotice, setLauncherNotice] = useState<string>('');
    const [importing, setImporting] = useState<boolean>(false);
    const [showBrowseModpacks, setShowBrowseModpacks] = useState<boolean>(false);
    const [showExecutableSetupModal, setShowExecutableSetupModal] = useState<boolean>(false);
    const [showSmapiModal, setShowSmapiModal] = useState<boolean>(false);
    const [showMicrosoftSignInModal, setShowMicrosoftSignInModal] = useState<boolean>(false);
    const [isSelectingExecutable, setIsSelectingExecutable] = useState<boolean>(false);
    const supportsLoaderSettings = supportsVersionAndLoaderSelection(gameConfig?.id);
    const hasLoaderRequirements = !supportsLoaderSettings || (!!minecraftVersion && !!modLoader && !!loaderVersion);

    // Game-specific version hooks
    const { mcVersions, loadingMcVersions } = useMinecraftVersions(showCreateForm && supportsLoaderSettings);
    const { loaderVersions, loadingLoaderVersions } = useLoaderVersions(
        supportsLoaderSettings ? modLoader : '',
        supportsLoaderSettings ? minecraftVersion : ''
    );
    // Hide loaders that have no build for the chosen Minecraft version.
    const { availableLoaders } = useAvailableLoaders(minecraftVersion, showCreateForm && supportsLoaderSettings);
    const selectableLoaders = availableLoaders
        ? MOD_LOADERS.filter((loader) => availableLoaders.includes(loader.value))
        : MOD_LOADERS;

    useEffect(() => {
        const fetchGameConfig = async () => {
            if (!game) {
                navigate('/');
                return;
            }
    
            try {
                if (!token) {
                    navigate('/login');
                    return;
                }

                const games = await window.db.getAllGames(token);
                const foundGame = games.find((g: GameType) => Number(g.id) === Number(game.id));
                
                if (foundGame) {
                    setGameConfig({
                        id: Number(foundGame.id),
                        name: foundGame.name,
                        acceptedTypes: foundGame.acceptedTypes || {},
                        extensions: foundGame.extensions,
                        description: foundGame.description,
                        modCount: foundGame.modCount || 0,
                        imagePath: foundGame.imagePath || ''
                    });
                }

                // Minecraft section: prompt to link a Microsoft account once per
                // session so launches are authenticated instead of offline.
                if (supportsVersionAndLoaderSelection(Number(game.id))
                    && sessionStorage.getItem('msSignInPromptDismissed') !== '1') {
                    try {
                        const account = await window.db.getMinecraftAccountStatus();
                        if (!account.signedIn) {
                            setShowMicrosoftSignInModal(true);
                        }
                    } catch {
                        // Non-fatal: users can still sign in from Settings.
                    }
                }

                // Only games that launch external executables should prompt for setup.
                if (!supportsVersionAndLoaderSelection(Number(game.id))) {
                    try {
                        const firstOpenSetup = await window.db.ensureGameExecutableOnFirstOpen(game.id);
                        if (firstOpenSetup.shouldPrompt) {
                            setShowExecutableSetupModal(true);
                        } else {
                            // Executable is known: offer to install SMAPI now (in a
                            // progress modal) for Stardew Valley so mods work.
                            const smapi = await window.db.getSmapiStatus(game.id);
                            if (smapi.needed) setShowSmapiModal(true);
                        }
                    } catch {
                        // Non-fatal: users can still configure executables in Settings.
                    }
                }

                // Fetch modpacks for this game
                const allModpacks = await window.db.getAllModpacks(token);
                const targetGameId = Number(game.id);
                const gameModpacks = allModpacks.filter((mp: ModpackType) => Number(mp.gameID) === targetGameId);
                setModpacks(gameModpacks);
            } catch (error) {
                console.error('Error fetching game config:', error);
            } finally {
                setLoading(false);
            }
        };
    
        fetchGameConfig();
    }, [game, navigate]);

    // Auto-select first MC version when versions load
    useEffect(() => {
        if (mcVersions.length > 0 && !minecraftVersion) setMinecraftVersion(mcVersions[0]);
    }, [mcVersions]);

    // Auto-select first loader version when versions load
    useEffect(() => {
        setLoaderVersion(loaderVersions.length > 0 ? loaderVersions[0] : '');
    }, [loaderVersions]);

    // If the selected loader isn't available for the chosen Minecraft version,
    // switch to one that is (so the form never sits on an incompatible loader).
    useEffect(() => {
        if (availableLoaders && availableLoaders.length > 0 && !availableLoaders.includes(modLoader)) {
            setModLoader(availableLoaders[0] as ModLoaderType);
        }
    }, [availableLoaders]);

    if (!game) {
        return null;
    }

    if (loading) {
        return (
            <Layout>
                <div className="app-container py-10 text-center">
                    <div className="clean-panel p-12">
                        <p className="text-lg text-slate-300">Loading game configuration...</p>
                    </div>
                </div>
            </Layout>
        );
    }

    if (!gameConfig) {
        return (
            <Layout>
                <div className="app-container py-10">
                    <div>
                        <div className="clean-panel text-center py-16">
                            <p className="text-lg text-slate-300">Game configuration not found.</p>
                        </div>
                    </div>
                </div>
            </Layout>
        );
    }

    const handleCreateModpack = async (): Promise<void> => {
        if (!modpackName.trim()) {
            return;
        }

        if (supportsLoaderSettings && !hasLoaderRequirements) {
            setCreateError('Select a valid Minecraft version and loader version before creating this modpack.');
            return;
        }

        if (!token) {
            console.error('No authentication token found');
            return;
        }

        let username = user?.username;
        if (!username && token) {
            const accountSettings = await window.db.getAccountSettings(token);
            username = accountSettings?.username;
        }
        if (!username) {
            setCreateError('Could not determine your account username. Please sign out and sign back in.');
            return;
        }

        try {
            // _id is assigned by the database on insert.
            const modpackData = {
                name: modpackName,
                description: modpackDescription,
                mods: [],
                gameID: Number(game.id),
                author: username,
                contributers: {}
            } as Omit<ModpackType, '_id'> as ModpackType;
            if (supportsLoaderSettings && minecraftVersion) modpackData.minecraftVersion = minecraftVersion;
            if (supportsLoaderSettings && modLoader) modpackData.modLoader = modLoader;
            if (supportsLoaderSettings && loaderVersion) modpackData.loaderVersion = loaderVersion;
            const created = await window.db.createModpack(token, modpackData);

            if (created && 'error' in created) {
                setCreateError(created.error);
            } else if (created) {
                navigate('/modpack', { state: { modpack: created, game } });
            } else {
                setCreateError('Failed to create modpack. Please try again.');
            }
        } catch (e) {
            setCreateError(`Error creating modpack: ${e}`);
        }
    };

    // Shared draft→create step for both file import and provider-browse import.
    const createModpackFromDraft = async (draft: ModpackImportDraft): Promise<{ success: boolean; error?: string }> => {
        if (!token) {
            navigate('/login');
            return { success: false, error: 'Not signed in.' };
        }

        let username = user?.username;
        if (!username) {
            const accountSettings = await window.db.getAccountSettings(token);
            username = accountSettings?.username;
        }
        if (!username) {
            return { success: false, error: 'Could not determine your account username. Please sign out and sign back in.' };
        }

        const modpackData = {
            name: draft.name,
            description: draft.description ?? '',
            mods: draft.mods,
            gameID: game.id,
            author: username,
            contributers: {},
            ...(draft.minecraftVersion ? { minecraftVersion: draft.minecraftVersion } : {}),
            ...(draft.modLoader ? { modLoader: draft.modLoader } : {}),
            ...(draft.loaderVersion ? { loaderVersion: draft.loaderVersion } : {}),
        } as ModpackType;

        const created = await window.db.createModpack(token, modpackData);
        if (created && 'error' in created) {
            return { success: false, error: created.error };
        }
        if (!created) {
            return { success: false, error: 'Failed to create the imported modpack. Please try again.' };
        }

        setModpacks(prev => [...prev, created]);
        const unresolvedSuffix = draft.unresolved.length > 0
            ? ` ${draft.unresolved.length} ${draft.unresolved.length === 1 ? 'entry' : 'entries'} could not be resolved and ${draft.unresolved.length === 1 ? 'was' : 'were'} left out.`
            : '';
        setLauncherNotice(`Imported "${draft.name}" with ${draft.mods.length} ${draft.mods.length === 1 ? 'mod' : 'mods'}.${unresolvedSuffix}`);
        return { success: true };
    };

    // Import a .mrpack file: the main process parses the archive into a draft.
    const handleImportModpack = async (): Promise<void> => {
        if (importing) return;
        if (!token) {
            navigate('/login');
            return;
        }

        setImporting(true);
        setCreateError('');
        try {
            const picked = await window.db.importModpackFile();
            if (picked.canceled) return;
            if (!picked.success || !picked.draft) {
                setCreateError(picked.error ?? 'Failed to import the modpack file.');
                return;
            }
            const result = await createModpackFromDraft(picked.draft);
            if (!result.success) {
                setCreateError(result.error ?? 'Failed to create the imported modpack.');
            }
        } catch (e) {
            setCreateError(`Error importing modpack: ${e}`);
        } finally {
            setImporting(false);
        }
    };

    // Import an existing modpack browsed from a provider (Modrinth or CurseForge).
    const handleImportProviderModpack = async (provider: ModpackProviderId, modpackId: string): Promise<{ success: boolean; error?: string }> => {
        if (!token) {
            navigate('/login');
            return { success: false, error: 'Not signed in.' };
        }
        const picked = await window.db.importProviderModpack(Number(game.id), provider, modpackId);
        if (!picked.success || !picked.draft) {
            return { success: false, error: picked.error ?? 'Failed to import that modpack.' };
        }
        return await createModpackFromDraft(picked.draft);
    };

    const resetForm = (): void => {
        setShowCreateForm(false);
        setModpackName("");
        setModpackDescription("");
        setMinecraftVersion(mcVersions.length > 0 ? mcVersions[0] : "");
        setModLoader('forge');
        setLoaderVersion("");
    };

    const handleSelectExecutableFromModal = async (): Promise<void> => {
        if (!game) {
            return;
        }

        setIsSelectingExecutable(true);
        const selectedExecutable = await window.db.selectAndSaveGameExecutable(game.id);
        setIsSelectingExecutable(false);

        if (!selectedExecutable) {
            setLauncherNotice(`${game.title} executable setup was skipped.`);
            return;
        }

        setShowExecutableSetupModal(false);
        setLauncherNotice(`${game.title} executable configured successfully.`);

        // Now that the game folder is known, offer to install SMAPI for Stardew
        // Valley via the progress modal. Previously this only fired when the
        // executable was auto-detected, so on machines where detection failed
        // (common on Windows) the SMAPI prompt never appeared.
        const smapi = await window.db.getSmapiStatus(game.id);
        if (smapi.needed) setShowSmapiModal(true);
    };

    return (
        <Layout>
            <div className="app-container py-8 sm:py-10">
                <div>
                    {/* Game hero */}
                    <div className="clean-panel relative mb-8 overflow-hidden border-slate-500/25">
                        {(game?.image ?? game?.imagePath ?? gameConfig.imagePath) && (
                            <img
                                src={game?.image ?? game?.imagePath ?? gameConfig.imagePath}
                                alt=""
                                className="absolute inset-0 h-full w-full object-cover opacity-[0.12]"
                            />
                        )}
                        <div className="absolute inset-0 bg-gradient-to-br from-emerald-900/15 via-[#10141a]/40 to-transparent" />
                        <div className="relative z-10 p-6">
                            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                                <div className="flex min-w-0 items-center gap-4">
                                    {(game?.image ?? game?.imagePath ?? gameConfig.imagePath) && (
                                        <img
                                            src={game?.image ?? game?.imagePath ?? gameConfig.imagePath}
                                            alt=""
                                            className="h-16 w-16 shrink-0 rounded-xl border border-[#232a34]/45 object-cover"
                                        />
                                    )}
                                    <div className="min-w-0">
                                        <h1 className="truncate text-2xl font-bold text-white sm:text-3xl">{game.title}</h1>
                                        <p className="mt-1 text-sm text-slate-400">
                                            {modpacks.length} {modpacks.length === 1 ? 'modpack' : 'modpacks'}
                                        </p>
                                    </div>
                                </div>

                                <div className="flex shrink-0 flex-wrap items-center gap-2">
                                    {supportsLoaderSettings && (
                                        <button
                                            onClick={() => setShowBrowseModpacks(true)}
                                            className="clean-button clean-button-ghost gap-2 px-3 py-2 text-xs sm:text-sm"
                                            title="Browse and import existing modpacks from the mod provider"
                                        >
                                            <FiPackage />
                                            <span>Browse Modpacks</span>
                                        </button>
                                    )}
                                    {supportsLoaderSettings && (
                                        <button
                                            onClick={handleImportModpack}
                                            disabled={importing}
                                            className="clean-button clean-button-ghost gap-2 px-3 py-2 text-xs sm:text-sm disabled:cursor-not-allowed disabled:opacity-55"
                                            title="Import a Modrinth .mrpack"
                                        >
                                            <FiUpload />
                                            <span>{importing ? 'Importing…' : 'Import'}</span>
                                        </button>
                                    )}
                                    <button
                                        onClick={() => setShowCreateForm(true)}
                                        className="clean-button clean-button-primary gap-2 px-4 py-2 text-xs sm:text-sm"
                                    >
                                        <FiPlus />
                                        <span>New Modpack</span>
                                    </button>
                                </div>
                            </div>

                            {gameConfig.description && (
                                <p className="mt-4 line-clamp-2 max-w-3xl text-sm leading-relaxed text-slate-400">
                                    {gameConfig.description}
                                </p>
                            )}
                        </div>
                    </div>

                    {/* Success / error banners */}
                    {createSuccess && (
                        <div className="mb-6 flex items-center gap-3 rounded-xl border border-green-500/50 bg-green-900/35 px-4 py-3 text-green-300">
                            <span className="text-green-400 text-lg">✓</span>
                            <span className="font-medium">Modpack created successfully!</span>
                            <button onClick={() => setCreateSuccess(false)} className="ml-auto text-green-500 hover:text-green-300 text-lg leading-none">&times;</button>
                        </div>
                    )}
                    {createError && (
                        <div className="mb-6 flex items-center gap-3 rounded-xl border border-red-500/50 bg-red-900/35 px-4 py-3 text-red-300">
                            <span className="font-medium">{createError}</span>
                            <button onClick={() => setCreateError('')} className="ml-auto text-red-500 hover:text-red-300 text-lg leading-none">&times;</button>
                        </div>
                    )}
                    {launcherNotice && (
                        <div className="mb-6 flex items-center gap-3 rounded-xl border border-slate-500/45 bg-[#161b22]/30 px-4 py-3 text-slate-100">
                            <span className="font-medium">{launcherNotice}</span>
                            <button onClick={() => setLauncherNotice('')} className="ml-auto text-slate-300 hover:text-slate-100 text-lg leading-none">&times;</button>
                        </div>
                    )}

                    {/* Modpacks Section */}
                    <div className="mt-8">
                        <h2 className="mb-4 text-lg font-semibold text-slate-100">Modpacks</h2>

                    {showCreateForm && (
                        <Modal
                            onClose={resetForm}
                            title={`Create ${game.title} Modpack`}
                            panelClassName="clean-scroll max-h-[88vh] max-w-lg overflow-y-auto"
                        >
                            <div className="space-y-4 p-6 pt-3">
                                <div>
                                    <label className="mb-1.5 block text-sm font-medium text-slate-300">Modpack Name *</label>
                                    <input
                                        type="text"
                                        value={modpackName}
                                        onChange={(e) => setModpackName(e.target.value)}
                                        placeholder="My Awesome Modpack"
                                        className="clean-input"
                                    />
                                </div>

                                <div>
                                    <label className="mb-1.5 block text-sm font-medium text-slate-300">Description</label>
                                    <textarea
                                        value={modpackDescription}
                                        onChange={(e) => setModpackDescription(e.target.value)}
                                        placeholder="Describe your modpack..."
                                        rows={2}
                                        className="clean-textarea resize-none"
                                    />
                                </div>

                                {supportsLoaderSettings && (
                                    <div className="space-y-3">
                                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                            <div>
                                                <label className="mb-1.5 block text-sm font-medium text-slate-300">Mod Loader</label>
                                                <select
                                                    value={modLoader}
                                                    onChange={(e) => setModLoader(e.target.value as ModLoaderType)}
                                                    className="clean-select text-sm"
                                                >
                                                    {selectableLoaders.map((l) => (
                                                        <option key={l.value} value={l.value}>{l.label}</option>
                                                    ))}
                                                </select>
                                            </div>
                                            <div>
                                                <label className="mb-1.5 block text-sm font-medium text-slate-300">Minecraft Version</label>
                                                {loadingMcVersions ? (
                                                    <p className="py-2 text-xs text-slate-500">Loading versions...</p>
                                                ) : (
                                                    <select
                                                        value={minecraftVersion}
                                                        onChange={(e) => setMinecraftVersion(e.target.value)}
                                                        className="clean-select text-sm"
                                                    >
                                                        {mcVersions.length === 0 && <option value="">No versions found</option>}
                                                        {mcVersions.map((v) => (
                                                            <option key={v} value={v}>{v}</option>
                                                        ))}
                                                    </select>
                                                )}
                                            </div>
                                        </div>
                                        <div>
                                            <label className="mb-1.5 block text-sm font-medium text-slate-300">
                                                {MOD_LOADERS.find(l => l.value === modLoader)?.label} Version
                                            </label>
                                            {loadingLoaderVersions ? (
                                                <p className="py-2 text-xs text-slate-500">Loading {MOD_LOADERS.find(l => l.value === modLoader)?.label} versions...</p>
                                            ) : (
                                                <select
                                                    value={loaderVersion}
                                                    onChange={(e) => setLoaderVersion(e.target.value)}
                                                    className="clean-select text-sm"
                                                >
                                                    {loaderVersions.length === 0 && <option value="">No versions found</option>}
                                                    {loaderVersions.map((v) => (
                                                        <option key={v} value={v}>{v}</option>
                                                    ))}
                                                </select>
                                            )}
                                            {!loadingLoaderVersions && loaderVersions.length === 0 && minecraftVersion && (
                                                <p className="mt-1.5 text-xs text-amber-400">
                                                    No {MOD_LOADERS.find(l => l.value === modLoader)?.label} version found for Minecraft {minecraftVersion}. Select another loader or Minecraft version.
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                )}

                                <div className="flex justify-end gap-3 pt-1">
                                    <button
                                        onClick={resetForm}
                                        className="clean-button clean-button-ghost px-4 py-2 text-sm"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={handleCreateModpack}
                                        disabled={!modpackName.trim() || !hasLoaderRequirements || loadingMcVersions || loadingLoaderVersions}
                                        className="clean-button clean-button-primary px-5 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-55"
                                    >
                                        Create Modpack
                                    </button>
                                </div>
                            </div>
                        </Modal>
                    )}

                        {modpacks.length === 0 ? (
                            <div className="clean-panel p-12 text-center">
                                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[#1a2029]/70">
                                    <FiPackage className="text-3xl text-slate-500" />
                                </div>
                                <p className="mb-2 text-lg text-slate-300">No modpacks yet</p>
                                <p className="mb-5 text-sm text-slate-500">Create the first modpack for {game.title}.</p>
                                <button
                                    onClick={() => setShowCreateForm(true)}
                                    className="clean-button clean-button-primary mx-auto gap-2 px-5 py-2 text-sm"
                                >
                                    <FiPlus />
                                    <span>New Modpack</span>
                                </button>
                            </div>
                        ) : (
                        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
                            {modpacks.map((modpack, index) => {
                                const contributersCount = Object.values(modpack.contributers).filter(v => v === true).length;
                                const modsCount = modpack.mods?.length ?? 0;

                                return (
                                    <div
                                        key={index}
                                        onClick={() => navigate('/modpack', { state: { modpack, game } })}
                                        className="clean-panel clean-card-hover group flex cursor-pointer flex-col p-5"
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <h3 className="truncate text-lg font-bold text-white transition-colors group-hover:text-slate-200">
                                                    {modpack.name}
                                                </h3>
                                                <p className="mt-0.5 truncate text-xs text-slate-500">by {modpack.author}</p>
                                            </div>
                                            <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[#1a2029]/60 text-slate-400 transition-colors group-hover:text-slate-200">
                                                {modpack.icon
                                                    ? <img src={modpack.icon} alt="" className="h-full w-full object-cover" />
                                                    : <FiPackage size={18} />}
                                            </div>
                                        </div>

                                        {modpack.description && (
                                            <p className="mt-2 line-clamp-2 text-sm text-slate-400">{modpack.description}</p>
                                        )}

                                        <div className="mt-auto flex items-center justify-between gap-3 border-t border-[#1a2029]/60 pt-4">
                                            <div>
                                                <p className="text-[11px] uppercase tracking-wider text-slate-500">Mods</p>
                                                <p className="text-lg font-bold text-emerald-300">{modsCount}</p>
                                            </div>
                                            <div className="text-right">
                                                <p className="text-[11px] uppercase tracking-wider text-slate-500">Collaborators</p>
                                                {contributersCount > 0 ? (
                                                    <p className="flex items-center justify-end gap-1.5 text-sm font-semibold text-slate-200">
                                                        <FiUsers className="text-slate-400" /> {contributersCount}
                                                    </p>
                                                ) : (
                                                    <p className="text-sm text-slate-500">Personal</p>
                                                )}
                                            </div>
                                        </div>

                                        {modpack.minecraftVersion && (
                                            <div className="mt-3">
                                                <span className="clean-pill border-emerald-500/30 bg-emerald-900/25 text-emerald-200">MC {modpack.minecraftVersion}</span>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                        )}
                    </div>                
                </div>
            </div>

            {showBrowseModpacks && (
                <BrowseModpacksModal
                    gameId={Number(game.id)}
                    onImport={handleImportProviderModpack}
                    onClose={() => setShowBrowseModpacks(false)}
                />
            )}

            {showMicrosoftSignInModal && (
                <MicrosoftSignInModal
                    onClose={() => {
                        sessionStorage.setItem('msSignInPromptDismissed', '1');
                        setShowMicrosoftSignInModal(false);
                    }}
                    onSignedIn={(profileName) => {
                        setShowMicrosoftSignInModal(false);
                        setLauncherNotice(`Signed in to Minecraft as ${profileName ?? 'your Microsoft account'}.`);
                    }}
                />
            )}

            {showExecutableSetupModal && (
                <Modal
                    onClose={() => {
                        setShowExecutableSetupModal(false);
                        setLauncherNotice(`You can configure the ${game.title} executable later in Settings.`);
                    }}
                    title={`Set ${game.title} Executable`}
                    description={`MMOP could not auto-detect a ${game.title} executable on first open. Select one now so launches work correctly.`}
                >
                    <div className="flex items-center justify-end gap-3 p-6 pt-4">
                        <button
                            onClick={() => {
                                setShowExecutableSetupModal(false);
                                setLauncherNotice(`You can configure the ${game.title} executable later in Settings.`);
                            }}
                            className="clean-button clean-button-ghost px-4 py-2 text-sm"
                        >
                            Later
                        </button>
                        <button
                            onClick={handleSelectExecutableFromModal}
                            disabled={isSelectingExecutable}
                            className="clean-button clean-button-soft px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {isSelectingExecutable ? 'Opening...' : 'Select Executable'}
                        </button>
                    </div>
                </Modal>
            )}

            {showSmapiModal && game && (
                <SmapiInstallModal
                    gameId={Number(game.id)}
                    gameName={game.title}
                    onClose={() => setShowSmapiModal(false)}
                    onInstalled={() => setLauncherNotice(`SMAPI installed for ${game.title}.`)}
                />
            )}
        </Layout>
    );
};

export default GameDetail;
