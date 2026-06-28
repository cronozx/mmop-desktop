import React from "react";
import { FiPackage, FiUser, FiX } from "react-icons/fi";
import { ModType } from "../../../types/sharedTypes";

interface ModListProps {
    mods: ModType[];
    isModPendingApproval: (modId: string) => boolean;
    /** Mod ids the last update check flagged as having a newer/missing file. */
    updatableModIds?: Set<string>;
    onRemoveMod: (modId: string) => void;
}

const ModList: React.FC<ModListProps> = ({ mods, isModPendingApproval, updatableModIds, onRemoveMod }) => {
    if (mods.length === 0) {
        return (
            <div className="clean-panel mb-8 p-12 text-center">
                <FiPackage className="mx-auto mb-4 text-5xl text-slate-600" />
                <p className="mb-2 text-lg text-slate-300">No mods in this modpack yet</p>
                <p className="text-sm text-slate-500">Click Add Mods to start building your collection</p>
            </div>
        );
    }

    return (
        <div className="clean-panel mb-8 divide-y divide-[#1a2029]/60 overflow-hidden">
            {mods.map((mod) => {
                const isPending = mod._id ? isModPendingApproval(mod._id) : false;
                const hasUpdate = mod._id ? (updatableModIds?.has(mod._id) ?? false) : false;
                return (
                    <div
                        key={mod._id}
                        className={`group flex items-center justify-between gap-3 p-3 transition-colors duration-200 hover:bg-[#1a2029]/30 ${isPending ? 'opacity-45 grayscale brightness-75' : ''}`}
                    >
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                            {mod.logo ? (
                                <img
                                    src={mod.logo}
                                    alt=""
                                    className="h-11 w-11 shrink-0 rounded-lg object-cover"
                                />
                            ) : (
                                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[#1a2029]/70 text-slate-500">
                                    <FiPackage size={18} />
                                </div>
                            )}
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <h3 className="truncate font-semibold text-white">{mod.name}</h3>
                                    {isPending && (
                                        <span className="whitespace-nowrap rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-400">
                                            Pending
                                        </span>
                                    )}
                                    {hasUpdate && (
                                        <span className="whitespace-nowrap rounded-full bg-sky-500/20 px-2 py-0.5 text-xs text-sky-300">
                                            Update available
                                        </span>
                                    )}
                                </div>
                                <div className="mt-0.5 flex items-center gap-1.5 text-sm text-slate-400">
                                    <FiUser className="text-xs" />
                                    <span className="truncate">{mod.author}</span>
                                </div>
                            </div>
                        </div>
                        <button
                            onClick={() => mod._id && onRemoveMod(mod._id)}
                            className="shrink-0 rounded-lg p-2 text-slate-500 opacity-0 transition-colors hover:bg-rose-900/30 hover:text-rose-300 focus-visible:opacity-100 group-hover:opacity-100"
                            title="Remove mod"
                            aria-label={`Remove ${mod.name}`}
                        >
                            <FiX size={18} />
                        </button>
                    </div>
                );
            })}
        </div>
    );
};

export default ModList;
