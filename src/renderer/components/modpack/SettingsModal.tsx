import React, { useRef, useState } from "react";
import { FiImage, FiTrash2 } from "react-icons/fi";
import { ModLoaderType, ModpackType } from "../../../types/sharedTypes";
import { LOADER_LABELS } from "../../helpers/minecraft";
import { supportsVersionAndLoaderSelection } from "../../../config/games";
import { useAuth } from "../../context/AuthContext";
import { resizeImageToDataUrl } from "../../helpers/image";
import Modal from "../Modal";

interface SettingsModalProps {
    modpack: ModpackType;
    isAuthor: boolean;
    mcVersions: string[];
    loaderVersions: string[];
    loadingLoaderVersions: boolean;
    editMcVersion: string;
    editModLoader: ModLoaderType | '';
    editLoaderVersion: string;
    editMemoryAllocationMb: string;
    editCustomJvmArgs: string;
    savingVersions: boolean;
    /** Save (or clear with '') a custom icon. Resolves with success/error. */
    onSaveIcon: (icon: string) => Promise<{ success: boolean; error?: string }>;
    onEditMcVersion: (value: string) => void;
    onEditModLoader: (value: ModLoaderType | '') => void;
    onEditLoaderVersion: (value: string) => void;
    onEditMemoryAllocationMb: (value: string) => void;
    onEditCustomJvmArgs: (value: string) => void;
    onSaveVersions: () => void;
    /** Author-only: opens the delete-confirmation flow. */
    onDelete?: () => void;
    onClose: () => void;
}

const SettingsModal: React.FC<SettingsModalProps> = ({
    modpack, isAuthor, mcVersions, loaderVersions, loadingLoaderVersions,
    editMcVersion, editModLoader, editLoaderVersion, editMemoryAllocationMb, editCustomJvmArgs, savingVersions,
    onSaveIcon,
    onEditMcVersion, onEditModLoader, onEditLoaderVersion, onEditMemoryAllocationMb, onEditCustomJvmArgs, onSaveVersions, onDelete, onClose,
}) => {
    const { user } = useAuth();
    const isPro = user?.isPro === true;
    const isMinecraftPack = supportsVersionAndLoaderSelection(modpack.gameID);
    const showLoaderSettings = isAuthor && isMinecraftPack;
    // Custom icons are an author-only Pro feature (included in the trial).
    const canEditIcon = isAuthor && isPro;

    const iconInputRef = useRef<HTMLInputElement>(null);
    const [iconBusy, setIconBusy] = useState(false);
    const [iconMsg, setIconMsg] = useState('');

    const handleIconFile = async (file: File): Promise<void> => {
        setIconMsg('');
        setIconBusy(true);
        try {
            const dataUrl = await resizeImageToDataUrl(file, 256);
            const result = await onSaveIcon(dataUrl);
            if (!result.success) setIconMsg(result.error ?? 'Could not save the icon.');
        } catch {
            setIconMsg('Could not read that image. Try a PNG, JPEG, or WebP.');
        } finally {
            setIconBusy(false);
        }
    };

    const handleRemoveIcon = async (): Promise<void> => {
        setIconMsg('');
        setIconBusy(true);
        try {
            const result = await onSaveIcon('');
            if (!result.success) setIconMsg(result.error ?? 'Could not remove the icon.');
        } finally {
            setIconBusy(false);
        }
    };

    return (
        <Modal onClose={onClose} title="Settings" panelClassName="max-w-md border-[#232a34]/45 bg-[#161b22]/92">
            <div className="max-h-[70vh] overflow-y-auto p-5 pt-3">
                    {/* Nothing to configure: no version controls, no icon upload,
                        and no delete (i.e. not the author). */}
                    {!showLoaderSettings && !canEditIcon && !onDelete && (
                        <p className="text-sm text-slate-400">
                            There are no settings to configure for this pack.
                            {!isAuthor && ' Only the pack author can change its Minecraft version and loader.'}
                        </p>
                    )}

                    {/* Version selectors (Minecraft only, author only) */}
                    {showLoaderSettings && (
                        <>
                            <h4 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">Minecraft Versions</h4>
                            <div className="grid grid-cols-2 gap-3 mb-2">
                                <div>
                                    <label className="block text-xs text-slate-400 mb-1">Minecraft</label>
                                    <select
                                        value={editMcVersion}
                                        onChange={e => onEditMcVersion(e.target.value)}
                                        className="clean-select text-sm"
                                    >
                                        <option value="">Select…</option>
                                        {mcVersions.map(v => <option key={v} value={v}>{v}</option>)}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs text-slate-400 mb-1">Mod Loader</label>
                                    <select
                                        value={editModLoader}
                                        onChange={e => onEditModLoader(e.target.value as ModLoaderType)}
                                        className="clean-select text-sm"
                                    >
                                        <option value="">Select…</option>
                                        {Object.entries(LOADER_LABELS).map(([k, label]) => (
                                            <option key={k} value={k}>{label}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>
                            {editModLoader && (
                                <div className="mb-2">
                                    <label className="block text-xs text-slate-400 mb-1">{LOADER_LABELS[editModLoader as ModLoaderType]} Version</label>
                                    <select
                                        value={editLoaderVersion}
                                        onChange={e => onEditLoaderVersion(e.target.value)}
                                        disabled={loadingLoaderVersions || loaderVersions.length === 0}
                                        className="clean-select text-sm disabled:opacity-50"
                                    >
                                        <option value="">{loadingLoaderVersions ? 'Loading…' : 'Select…'}</option>
                                        {loaderVersions.map(v => <option key={v} value={v}>{v}</option>)}
                                    </select>
                                    {!loadingLoaderVersions && loaderVersions.length === 0 && editMcVersion && (
                                        <p className="mt-1 text-xs text-amber-400">
                                            No {LOADER_LABELS[editModLoader as ModLoaderType]} version works with Minecraft {editMcVersion}. Pick another loader or Minecraft version.
                                        </p>
                                    )}
                                </div>
                            )}
                            {editMcVersion && editMcVersion !== modpack.minecraftVersion && (
                                <p className="text-amber-400 text-xs mb-3">Warning: Mods incompatible with {editMcVersion} will be removed.</p>
                            )}
                            <div className="grid grid-cols-2 gap-3 mb-3">
                                <div>
                                    <label className="block text-xs text-slate-400 mb-1">Memory (MB)</label>
                                    <input
                                        type="number"
                                        min={1024}
                                        max={65536}
                                        step={512}
                                        value={editMemoryAllocationMb}
                                        onChange={e => onEditMemoryAllocationMb(e.target.value)}
                                        className="clean-input text-sm"
                                        placeholder="4096"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs text-slate-400 mb-1">Custom JVM Args</label>
                                    <input
                                        type="text"
                                        value={editCustomJvmArgs}
                                        onChange={e => onEditCustomJvmArgs(e.target.value)}
                                        spellCheck={false}
                                        className="clean-input font-mono text-xs"
                                        placeholder="-XX:+UseZGC"
                                    />
                                </div>
                            </div>
                            <button
                                onClick={onSaveVersions}
                                disabled={savingVersions || (!editMcVersion && !editModLoader && !editLoaderVersion && !editMemoryAllocationMb && !editCustomJvmArgs)}
                                className="clean-button clean-button-soft w-full px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-55"
                            >
                                {savingVersions ? 'Saving…' : 'Save versions'}
                            </button>
                        </>
                    )}

                    {/* Custom icon (author + Pro; included in the trial). */}
                    {canEditIcon && (
                        <div className={showLoaderSettings ? "mt-6 border-t border-[#232a34]/45 pt-5" : ""}>
                            <h4 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Modpack Icon</h4>
                            <div className="flex items-center gap-4">
                                <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-[#232a34]/50 bg-[#1a2029]/40">
                                    {modpack.icon
                                        ? <img src={modpack.icon} alt="" className="h-full w-full object-cover" />
                                        : <div className="flex h-full w-full items-center justify-center text-slate-600"><FiImage size={20} /></div>}
                                </div>
                                <div className="flex flex-col gap-2">
                                    <input
                                        ref={iconInputRef}
                                        type="file"
                                        accept="image/png,image/jpeg,image/webp"
                                        className="hidden"
                                        onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleIconFile(f); e.target.value = ''; }}
                                    />
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => iconInputRef.current?.click()}
                                            disabled={iconBusy}
                                            className="clean-button clean-button-soft px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-55"
                                        >
                                            {iconBusy ? 'Saving…' : modpack.icon ? 'Change image' : 'Upload image'}
                                        </button>
                                        {modpack.icon && (
                                            <button
                                                onClick={() => void handleRemoveIcon()}
                                                disabled={iconBusy}
                                                className="clean-button clean-button-ghost px-3 py-1.5 text-sm disabled:opacity-55"
                                            >
                                                Remove
                                            </button>
                                        )}
                                    </div>
                                    <p className="text-xs text-slate-500">PNG, JPEG, or WebP — shown on your modpack cards.</p>
                                </div>
                            </div>
                            {iconMsg && <p className="mt-2 text-sm text-rose-300">{iconMsg}</p>}
                        </div>
                    )}

                    {/* Author-only: delete the modpack. */}
                    {isAuthor && onDelete && (
                        <div className="mt-6 border-t border-[#232a34]/45 pt-5">
                            <div className="flex flex-col gap-3 rounded-lg border border-rose-500/25 bg-rose-900/10 p-4 sm:flex-row sm:items-center sm:justify-between">
                                <div>
                                    <p className="text-sm font-medium text-slate-200">Delete this modpack</p>
                                    <p className="text-xs text-slate-400">This permanently removes the pack. This cannot be undone.</p>
                                </div>
                                <button
                                    onClick={onDelete}
                                    className="clean-button clean-button-danger shrink-0 px-4 py-2 text-sm"
                                >
                                    <FiTrash2 size={14} />
                                    <span>Delete Modpack</span>
                                </button>
                            </div>
                        </div>
                    )}
            </div>
        </Modal>
    );
};

export default SettingsModal;
