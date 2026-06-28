import React, { useEffect, useMemo, useState } from "react";
import { FiFile, FiRefreshCw, FiSave, FiX } from "react-icons/fi";
import { ConfigFileEntry, ConfigRoot } from "../../../types/sharedTypes";
import Modal from "../Modal";

interface ConfigEditorModalProps {
    modpackName: string;
    gameId: number;
    onClose: () => void;
}

const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Browse and edit a modpack's config files in place. The left rail lists the
 * editable text files the main process discovered under the pack's config roots;
 * selecting one loads its contents into the editor, where it can be saved back.
 */
const ConfigEditorModal: React.FC<ConfigEditorModalProps> = ({ modpackName, gameId, onClose }) => {
    const [roots, setRoots] = useState<ConfigRoot[]>([]);
    const [files, setFiles] = useState<ConfigFileEntry[]>([]);
    const [listing, setListing] = useState<boolean>(true);
    const [selected, setSelected] = useState<ConfigFileEntry | null>(null);
    const [contents, setContents] = useState<string>("");
    const [originalContents, setOriginalContents] = useState<string>("");
    const [loadingFile, setLoadingFile] = useState<boolean>(false);
    const [saving, setSaving] = useState<boolean>(false);
    const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

    const dirty = selected !== null && contents !== originalContents;

    const refresh = async (): Promise<void> => {
        setListing(true);
        try {
            const result = await window.db.listConfigFiles(modpackName, gameId);
            setRoots(result.roots);
            setFiles(result.files);
        } catch {
            setRoots([]);
            setFiles([]);
        } finally {
            setListing(false);
        }
    };

    useEffect(() => { void refresh(); }, []);

    const openFile = async (file: ConfigFileEntry): Promise<void> => {
        if (dirty && !window.confirm('Discard unsaved changes to the current file?')) {
            return;
        }
        setSelected(file);
        setMessage(null);
        setLoadingFile(true);
        try {
            const result = await window.db.readConfigFile(modpackName, gameId, file.rootIndex, file.relPath);
            if ('error' in result) {
                setMessage({ kind: 'err', text: result.error });
                setContents("");
                setOriginalContents("");
            } else {
                setContents(result.contents);
                setOriginalContents(result.contents);
            }
        } finally {
            setLoadingFile(false);
        }
    };

    const save = async (): Promise<void> => {
        if (!selected || !dirty) return;
        setSaving(true);
        setMessage(null);
        try {
            const result = await window.db.writeConfigFile(modpackName, gameId, selected.rootIndex, selected.relPath, contents);
            if (result.success) {
                setOriginalContents(contents);
                setMessage({ kind: 'ok', text: 'Saved.' });
            } else {
                setMessage({ kind: 'err', text: result.error ?? 'Could not save the file.' });
            }
        } finally {
            setSaving(false);
        }
    };

    // Files grouped by their root, for labelled sections in the file list.
    const filesByRoot = useMemo(() => {
        const groups = new Map<number, ConfigFileEntry[]>();
        for (const file of files) {
            const list = groups.get(file.rootIndex) ?? [];
            list.push(file);
            groups.set(file.rootIndex, list);
        }
        return groups;
    }, [files]);

    return (
        <Modal
            onClose={onClose}
            label="Edit config files"
            hideHeader
            panelClassName="flex h-[80vh] max-w-5xl flex-col overflow-hidden border-zinc-700/45 bg-zinc-900/92"
        >
            <div className="flex items-center justify-between border-b border-zinc-700/45 p-5">
                <div>
                    <h3 className="text-xl font-bold text-white">Edit Config</h3>
                    <p className="text-sm text-zinc-400">{modpackName}</p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => void refresh()}
                        className="clean-button clean-button-ghost p-2 text-zinc-400 hover:text-white"
                        title="Rescan config files"
                        aria-label="Rescan config files"
                    >
                        <FiRefreshCw size={18} />
                    </button>
                    <button
                        onClick={onClose}
                        className="clean-button clean-button-ghost p-2 text-zinc-400 hover:text-white"
                        aria-label="Close dialog"
                    >
                        <FiX size={22} />
                    </button>
                </div>
            </div>

            <div className="flex min-h-0 flex-1">
                {/* File list */}
                <div className="clean-scroll w-64 shrink-0 overflow-y-auto border-r border-zinc-700/45 p-3">
                    {listing ? (
                        <p className="px-2 py-4 text-sm text-zinc-400">Scanning files…</p>
                    ) : files.length === 0 ? (
                        <p className="px-2 py-4 text-sm text-zinc-400">
                            No editable config files found. Download and run the pack once to generate its configs.
                        </p>
                    ) : (
                        Array.from(filesByRoot.entries()).map(([rootIndex, rootFiles]) => (
                            <div key={rootIndex} className="mb-3">
                                {roots.length > 1 && (
                                    <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                                        {roots[rootIndex]?.label ?? 'Files'}
                                    </p>
                                )}
                                {rootFiles.map((file) => {
                                    const isActive = selected?.rootIndex === file.rootIndex && selected?.relPath === file.relPath;
                                    return (
                                        <button
                                            key={`${file.rootIndex}:${file.relPath}`}
                                            onClick={() => void openFile(file)}
                                            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${isActive ? 'bg-zinc-800 text-white' : 'text-zinc-300 hover:bg-zinc-800/60'}`}
                                            title={file.relPath}
                                        >
                                            <FiFile className="shrink-0 text-zinc-500" size={14} />
                                            <span className="truncate">{file.relPath}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        ))
                    )}
                </div>

                {/* Editor */}
                <div className="flex min-w-0 flex-1 flex-col">
                    {selected ? (
                        <>
                            <div className="flex items-center justify-between gap-3 border-b border-zinc-700/45 px-4 py-2.5">
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-medium text-zinc-200">{selected.relPath}</p>
                                    <p className="text-xs text-zinc-500">{formatSize(selected.size)}{dirty ? ' · unsaved changes' : ''}</p>
                                </div>
                                <div className="flex items-center gap-2">
                                    {message && (
                                        <span className={`text-sm ${message.kind === 'ok' ? 'text-emerald-300' : 'text-rose-300'}`}>{message.text}</span>
                                    )}
                                    <button
                                        onClick={() => void save()}
                                        disabled={!dirty || saving}
                                        className="clean-button clean-button-primary px-3.5 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-55"
                                    >
                                        <FiSave size={15} />
                                        <span>{saving ? 'Saving…' : 'Save'}</span>
                                    </button>
                                </div>
                            </div>
                            {loadingFile ? (
                                <div className="flex flex-1 items-center justify-center">
                                    <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-zinc-400" />
                                </div>
                            ) : (
                                <textarea
                                    value={contents}
                                    onChange={(e) => setContents(e.target.value)}
                                    spellCheck={false}
                                    className="clean-scroll flex-1 resize-none bg-transparent p-4 font-mono text-sm text-zinc-200 outline-none"
                                    placeholder="(empty file)"
                                />
                            )}
                        </>
                    ) : (
                        <div className="flex flex-1 items-center justify-center p-8 text-center">
                            <p className="text-sm text-zinc-400">Select a file to edit.</p>
                        </div>
                    )}
                </div>
            </div>
        </Modal>
    );
};

export default ConfigEditorModal;
