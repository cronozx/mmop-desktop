import React, { useRef, useEffect, useState } from "react";
import { FiCheck, FiExternalLink, FiHeart, FiInfo, FiPlus, FiUser, FiX } from "react-icons/fi";
import { ModType, ModProviderId, ModProviderOption } from "../../../types/sharedTypes";
import Modal from "../Modal";
import ModDescriptionModal from "./ModDescriptionModal";

interface AddModsModalProps {
    searchQuery: string;
    onSearchChange: (value: string) => void;
    /** Mod sources for this game; a picker shows when there's more than one. */
    modProviders: ModProviderOption[];
    /** The currently selected mod source. */
    modProvider: ModProviderId | null;
    onSelectProvider: (provider: ModProviderId) => void;
    availableMods: ModType[];
    currentMods: string[];
    totalModsCount: number;
    loadingMods: boolean;
    loadingMoreMods: boolean;
    modsError: string;
    hasMoreMods: boolean;
    debouncedSearch: string;
    hasChanges: boolean;
    saving: boolean;
    /** True after a contributor's request has been submitted (disables re-submit). */
    submitted: boolean;
    /** Error from the last save attempt; the modal stays open so it is visible. */
    saveError: string;
    isAuthor: boolean;
    /** modId → inline message for mods that failed the compatibility check. */
    incompatibleMods: Record<string, string>;
    /** Ids whose compatibility check is currently in flight. */
    checkingModIds: string[];
    onAddMod: (modId: string) => void | Promise<void>;
    onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
    onSave: () => void;
    onClose: () => void;
}

const AddModsModal: React.FC<AddModsModalProps> = ({
    searchQuery, onSearchChange, modProviders, modProvider, onSelectProvider,
    availableMods, currentMods, totalModsCount,
    loadingMods, loadingMoreMods, modsError, hasMoreMods, debouncedSearch,
    hasChanges, saving, submitted, saveError, isAuthor,
    incompatibleMods, checkingModIds, onAddMod, onScroll, onSave, onClose,
}) => {
    const filteredMods = availableMods.filter(mod => !currentMods.includes(mod._id!));
    const scrollRef = useRef<HTMLDivElement>(null);
    const [descriptionMod, setDescriptionMod] = useState<ModType | null>(null);

    // Auto-load more if content doesn't fill the scrollable area
    useEffect(() => {
        const el = scrollRef.current;
        if (!el || loadingMods || loadingMoreMods || !hasMoreMods) return;
        if (el.scrollHeight <= el.clientHeight && filteredMods.length > 0) {
            onScroll({ currentTarget: el } as React.UIEvent<HTMLDivElement>);
        }
    }, [filteredMods.length, loadingMods, loadingMoreMods, hasMoreMods]);

    return (
        <Modal
            onClose={onClose}
            label="Add mods"
            hideHeader
            panelClassName="flex max-h-[80vh] max-w-2xl flex-col overflow-hidden border-[#232a34]/45 bg-[#161b22]/92"
        >
                    <div className="flex items-center justify-between border-b border-[#232a34]/45 p-6">
                        <h3 className="text-2xl font-bold text-white">Add Mods to Pack</h3>
                        <button
                            onClick={onClose}
                            className="clean-button clean-button-ghost p-2 text-slate-400 hover:text-white"
                            aria-label="Close dialog"
                        >
                            <FiX size={24} />
                        </button>
                    </div>

                    <div className="border-b border-[#232a34]/45 p-6">
                        {modProviders.length > 1 && (
                            <div className="mb-3 flex gap-1 rounded-lg bg-[#0e1117]/60 p-1" role="tablist" aria-label="Mod source">
                                {modProviders.map((p) => (
                                    <button
                                        key={p.id}
                                        type="button"
                                        role="tab"
                                        aria-selected={modProvider === p.id}
                                        onClick={() => onSelectProvider(p.id)}
                                        className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                                            modProvider === p.id ? 'bg-[#232a34] text-white' : 'text-slate-400 hover:text-white'
                                        }`}
                                    >
                                        {p.label}
                                    </button>
                                ))}
                            </div>
                        )}
                        <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => onSearchChange(e.target.value)}
                            placeholder="Search mods..."
                            className="clean-input"
                        />
                        {totalModsCount > 0 && (
                            <p className="text-slate-500 text-xs mt-2">
                                Showing {filteredMods.length} of {totalModsCount} mods
                            </p>
                        )}
                    </div>

                    <div ref={scrollRef} className="clean-scroll flex-1 overflow-y-auto p-6" onScroll={onScroll}>
                        {loadingMods ? (
                            <div className="text-center py-12">
                                <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-b-2 border-slate-400"></div>
                                <p className="text-slate-400">Loading mods...</p>
                                <p className="text-slate-500 text-sm mt-2">This may take a moment</p>
                            </div>
                        ) : modsError ? (
                            <div className="text-center py-12">
                                <div className="w-16 h-16 mx-auto mb-4 bg-red-900/50 rounded-full flex items-center justify-center">
                                    <FiX className="text-red-400 text-3xl" />
                                </div>
                                <p className="text-red-400 font-semibold mb-2">Error Loading Mods</p>
                                <p className="text-slate-400 text-sm">{modsError}</p>
                            </div>
                        ) : filteredMods.length === 0 ? (
                            <div className="text-center py-12">
                                <p className="text-slate-400">
                                    {availableMods.length === 0 ? (debouncedSearch ? 'No mods match your search' : 'Start typing to search for mods') : 'All available mods are already in this pack'}
                                </p>
                            </div>
                        ) : (
                            <>
                                <div className="space-y-3">
                                    {filteredMods.map((mod) => {
                                        const incompatibleMessage = mod._id ? incompatibleMods[mod._id] : undefined;
                                        const checkingCompatibility = mod._id ? checkingModIds.includes(mod._id) : false;
                                        return (
                                            <div
                                                key={mod._id}
                                                className="clean-panel-muted group rounded-lg p-4 transition-all duration-200 hover:border-slate-400/40"
                                            >
                                                <div className="flex items-start justify-between">
                                                    <div className="flex-1 flex items-start space-x-3">
                                                        {mod.logo && (
                                                            <img
                                                                src={mod.logo}
                                                                alt={mod.name}
                                                                className="w-12 h-12 rounded object-cover"
                                                            />
                                                        )}
                                                        <div className="flex-1">
                                                            <button
                                                                type="button"
                                                                onClick={() => setDescriptionMod(mod)}
                                                                className="mb-1 text-left font-semibold text-white hover:text-emerald-300 hover:underline"
                                                                title="View description"
                                                            >
                                                                {mod.name}
                                                            </button>
                                                            <div className="flex items-center space-x-2 text-slate-400 text-sm mb-1">
                                                                <FiUser className="text-xs" />
                                                                <span>{mod.author}</span>
                                                                {mod.donationUrl && (
                                                                    <a
                                                                        href={mod.donationUrl}
                                                                        target="_blank"
                                                                        rel="noreferrer"
                                                                        onClick={(e) => e.stopPropagation()}
                                                                        className="inline-flex items-center gap-1 text-emerald-400 transition-colors hover:text-emerald-300"
                                                                    >
                                                                        <FiHeart className="text-xs" />
                                                                        Support me
                                                                    </a>
                                                                )}
                                                            </div>
                                                            {mod.summary && (
                                                                <p className="text-slate-500 text-xs line-clamp-2">{mod.summary}</p>
                                                            )}
                                                            {mod.sourceUrl && (
                                                                <div className="mt-1.5 flex items-center gap-3 text-xs">
                                                                    <a
                                                                        href={mod.sourceUrl}
                                                                        target="_blank"
                                                                        rel="noreferrer"
                                                                        onClick={(e) => e.stopPropagation()}
                                                                        className="inline-flex items-center gap-1 text-zinc-400 transition-colors hover:text-zinc-200"
                                                                    >
                                                                        <FiExternalLink className="text-xs" />
                                                                        View on source
                                                                    </a>
                                                                </div>
                                                            )}
                                                            {incompatibleMessage && (
                                                                <p className="text-amber-400 text-xs mt-1">{incompatibleMessage}</p>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <div className="flex shrink-0 items-center gap-2">
                                                        <button
                                                            onClick={() => setDescriptionMod(mod)}
                                                            className="clean-button clean-button-ghost p-2 text-slate-400 hover:text-white"
                                                            title="View description"
                                                            aria-label={`View description for ${mod.name}`}
                                                        >
                                                            <FiInfo size={16} />
                                                        </button>
                                                        <button
                                                            onClick={() => mod._id && onAddMod(mod._id)}
                                                            disabled={checkingCompatibility || !!incompatibleMessage}
                                                            className="clean-button clean-button-soft px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                                                        >
                                                            <FiPlus size={16} />
                                                            <span>{checkingCompatibility ? 'Checking...' : 'Add'}</span>
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                                {loadingMoreMods && (
                                    <div className="text-center py-6">
                                        <div className="mx-auto mb-2 h-8 w-8 animate-spin rounded-full border-b-2 border-slate-400"></div>
                                        <p className="text-slate-500 text-sm">Loading more...</p>
                                    </div>
                                )}
                                {!hasMoreMods && availableMods.length > 0 && (
                                    <div className="text-center py-6">
                                        <p className="text-slate-500 text-sm">No more mods to load</p>
                                    </div>
                                )}
                            </>
                        )}
                    </div>

                    {hasChanges && (
                        <div className="border-t border-[#232a34]/45 bg-[#161b22]/65 p-6">
                            {saveError && (
                                <p className="mb-3 text-sm font-medium text-red-400">✗ {saveError}</p>
                            )}
                            <button
                                onClick={() => onSave()}
                                disabled={saving || submitted}
                                className={`clean-button w-full px-4 py-3 font-medium text-white disabled:cursor-not-allowed disabled:opacity-60 ${
                                    isAuthor ? 'clean-button-soft border-emerald-500/45 bg-emerald-900/30 text-emerald-200' : 'clean-button-primary'
                                }`}
                            >
                                <FiCheck />
                                <span>{saving ? (isAuthor ? 'Saving...' : 'Requesting...') : submitted ? (isAuthor ? 'Saved' : 'Request Submitted') : (isAuthor ? 'Save All Changes' : 'Request Save')}</span>
                            </button>
                        </div>
                    )}
            {descriptionMod?._id && (
                <ModDescriptionModal
                    modId={descriptionMod._id}
                    modName={descriptionMod.name}
                    author={descriptionMod.author}
                    logo={descriptionMod.logo}
                    donationUrl={descriptionMod.donationUrl}
                    onClose={() => setDescriptionMod(null)}
                />
            )}
        </Modal>
    );
};

export default AddModsModal;
