import React, { useEffect, useState } from "react";
import { FiPlay, FiSettings, FiX } from "react-icons/fi";
import { ModpackType, PublicUser } from "../../../types/sharedTypes";
import { LOADER_LABELS, LOADER_COLORS } from "../../helpers/minecraft";
import { supportsVersionAndLoaderSelection } from "../../../config/games";

interface ModpackHeaderProps {
    modpack: ModpackType;
    currentModsCount: number;
    isAuthor: boolean;
    installingLoader: boolean;
    loaderInstalled: boolean;
    launching: boolean;
    gameExecutable: string | null;
    /** Bumped each time a launch succeeds; fires the one-shot celebration. */
    launchPulse: number;
    /** Game art used as a faint hero backdrop. */
    gameImage?: string;
    contributersInModpack: PublicUser[];
    pendingContributers: PublicUser[];
    onLaunch: () => void;
    onOpenSettings: () => void;
    onRemoveUser: (user: PublicUser) => void;
}

const ModpackHeader: React.FC<ModpackHeaderProps> = ({
    modpack, currentModsCount, isAuthor, installingLoader, loaderInstalled,
    launching, gameExecutable, launchPulse, gameImage, contributersInModpack, pendingContributers,
    onLaunch, onOpenSettings, onRemoveUser,
}) => {
    const requiresExecutable = !supportsVersionAndLoaderSelection(modpack.gameID);

    // One-shot launch celebration: bump a key when a launch lands so the button
    // re-runs its glow and the aurora ring mounts, then clears itself.
    const [celebrateKey, setCelebrateKey] = useState(0);
    useEffect(() => {
        if (launchPulse === 0) return;
        setCelebrateKey((k) => k + 1);
        const id = window.setTimeout(() => setCelebrateKey(0), 900);
        return () => window.clearTimeout(id);
    }, [launchPulse]);

    return (
        <>
            <div className="clean-panel relative mb-8 overflow-hidden border-slate-500/25">
                {(modpack.icon || gameImage) && (
                    <img src={modpack.icon || gameImage} alt="" className="absolute inset-0 h-full w-full object-cover opacity-[0.12]" />
                )}
                <div className="absolute inset-0 bg-gradient-to-br from-emerald-900/15 via-[#10141a]/40 to-transparent" />
                <div className="relative z-10 p-6">
                <div className="flex items-center justify-between">
                    <div className="min-w-0">
                        <h1 className="text-2xl font-bold text-white truncate">{modpack.name}</h1>
                        <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1">
                            <span className="text-sm text-slate-400">by {modpack.author}</span>
                            <span className="text-slate-600">·</span>
                            <span className="text-sm text-slate-400">{currentModsCount} {currentModsCount === 1 ? 'mod' : 'mods'}</span>
                            {modpack.minecraftVersion && (
                                <span className="clean-pill border-emerald-500/35 bg-emerald-900/30 text-emerald-200">MC {modpack.minecraftVersion}</span>
                            )}
                            {(modpack.modLoader || modpack.forgeVersion) && (() => {
                                const loader = modpack.modLoader ?? 'forge';
                                const version = modpack.loaderVersion ?? modpack.forgeVersion;
                                const colors = LOADER_COLORS[loader];
                                return (
                                    <span className={`text-xs px-2 py-0.5 ${colors.bg} ${colors.text} rounded-full`}>
                                        {LOADER_LABELS[loader]} {version}
                                    </span>
                                );
                            })()}
                        </div>
                    </div>
                    <div className="ml-4 flex flex-wrap items-center justify-end gap-2">
                        {installingLoader && (
                            <span className="text-xs text-orange-400 animate-pulse">Installing {LOADER_LABELS[modpack.modLoader ?? 'forge']}…</span>
                        )}
                        <button
                            onClick={onOpenSettings}
                            className="clean-button clean-button-ghost p-2 text-slate-400 hover:text-white"
                            title={requiresExecutable
                                ? (gameExecutable ? 'Change game executable' : 'Set game executable')
                                : 'Open modpack settings'}
                        >
                            <FiSettings size={16} />
                        </button>
                        <div className="relative">
                            <button
                                onClick={onLaunch}
                                disabled={launching || installingLoader}
                                className={`clean-button clean-button-primary gap-2 px-6 py-2.5 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-55 ${celebrateKey ? 'launch-celebrate' : ''}`}
                                title={installingLoader
                                    ? 'Waiting for loader installation…'
                                    : requiresExecutable
                                    ? (gameExecutable ? `Launch: ${gameExecutable}` : 'Set game executable to launch')
                                    : (loaderInstalled ? 'Launch Minecraft from MMOP' : 'Loader will be prepared before launch')}
                            >
                                <FiPlay size={16} />
                                <span>{launching ? 'Launching…' : 'Launch'}</span>
                            </button>
                            {celebrateKey > 0 && <span key={celebrateKey} className="launch-ring" aria-hidden="true" />}
                        </div>
                    </div>
                </div>
                {modpack.description && (
                    <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-slate-400">{modpack.description}</p>
                )}
                {(contributersInModpack.length > 0 || pendingContributers.length > 0) && (
                    <div className="mt-3 border-t border-[#232a34]/45 pt-3">
                        <span className="mb-2 block text-xs font-medium uppercase tracking-wide text-slate-500">Contributors</span>
                        <div className="flex flex-wrap gap-2">
                            {contributersInModpack.map(user => (
                                <div key={user._id} className="flex items-center rounded-lg border border-[#232a34]/45 bg-[#161b22]/55 px-3 py-1 text-sm text-white">
                                    <span>{user.username}</span>
                                    {isAuthor && (
                                        <button
                                            className="ml-2 text-slate-400 hover:text-red-400"
                                            title="Remove contributor"
                                            onClick={() => onRemoveUser(user)}
                                        >
                                            <FiX size={16} />
                                        </button>
                                    )}
                                </div>
                            ))}
                            {pendingContributers.map(user => (
                                <div
                                    key={user._id}
                                    className="flex items-center rounded-lg border border-amber-500/35 bg-amber-900/20 px-3 py-1 text-sm text-amber-200"
                                    title={`${user.username} was invited and hasn't accepted yet. They can edit the pack once they accept.`}
                                >
                                    <span>{user.username} <span className="italic text-amber-400">(pending)</span></span>
                                    {isAuthor && (
                                        <button
                                            className="ml-2 text-slate-400 hover:text-red-400"
                                            title="Remove pending contributor"
                                            onClick={() => onRemoveUser(user)}
                                        >
                                            <FiX size={16} />
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}
                </div>
            </div>
        </>
    );
};

export default ModpackHeader;
