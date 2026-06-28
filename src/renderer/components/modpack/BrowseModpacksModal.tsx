import React, { useEffect, useRef, useState } from "react";
import { FiDownload, FiPackage, FiSearch, FiX } from "react-icons/fi";
import { ProviderModpackSummary, ModpackProviderId, ModpackProviderOption } from "../../../types/sharedTypes";
import Modal from "../Modal";

interface BrowseModpacksModalProps {
    gameId: number;
    /** When set, results are narrowed to this Minecraft version. */
    gameVersion?: string;
    /** Imports the chosen provider modpack; resolves with the outcome to show inline. */
    onImport: (provider: ModpackProviderId, modpackId: string) => Promise<{ success: boolean; error?: string }>;
    onClose: () => void;
}

const formatDownloads = (downloads?: number): string | null => {
    if (typeof downloads !== 'number') return null;
    if (downloads >= 1_000_000) return `${(downloads / 1_000_000).toFixed(1)}M downloads`;
    if (downloads >= 1_000) return `${(downloads / 1_000).toFixed(1)}K downloads`;
    return `${downloads} downloads`;
};

/**
 * Browse existing modpacks published on a provider (Modrinth/CurseForge) and import one as a
 * new local pack. Search is debounced; results paginate with the scroll position.
 */
const BrowseModpacksModal: React.FC<BrowseModpacksModalProps> = ({ gameId, gameVersion, onImport, onClose }) => {
    const [query, setQuery] = useState<string>("");
    const [debounced, setDebounced] = useState<string>("");
    const [providers, setProviders] = useState<ModpackProviderOption[]>([]);
    const [provider, setProvider] = useState<ModpackProviderId | null>(null);
    const [results, setResults] = useState<ProviderModpackSummary[]>([]);
    const [page, setPage] = useState<number>(0);
    const [hasMore, setHasMore] = useState<boolean>(false);
    const [loading, setLoading] = useState<boolean>(true);
    const [loadingMore, setLoadingMore] = useState<boolean>(false);
    const [error, setError] = useState<string>("");
    const [importingId, setImportingId] = useState<string | null>(null);
    const [rowMessage, setRowMessage] = useState<{ id: string; kind: 'ok' | 'err'; text: string } | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handle = setTimeout(() => setDebounced(query.trim()), 350);
        return () => clearTimeout(handle);
    }, [query]);

    // Resolve the game's modpack sources (e.g. Minecraft → Modrinth + CurseForge),
    // defaulting to the first. Searching waits until a source is chosen.
    useEffect(() => {
        let cancelled = false;
        window.db.getModpackProviders(gameId)
            .then((list) => {
                if (cancelled) return;
                setProviders(list);
                setProvider(list[0]?.id ?? null);
                if (list.length === 0) setLoading(false);
            })
            .catch(() => { if (!cancelled) { setLoading(false); setError("Could not load modpack sources."); } });
        return () => { cancelled = true; };
    }, [gameId]);

    // Fresh search whenever the source, debounced query, or version changes.
    useEffect(() => {
        if (!provider) return;
        let cancelled = false;
        setLoading(true);
        setError("");
        setPage(0);
        window.db.searchProviderModpacks(gameId, provider, debounced, 0, gameVersion)
            .then((res) => {
                if (cancelled) return;
                setResults(res.modpacks);
                setHasMore(res.hasMore);
            })
            .catch(() => { if (!cancelled) setError("Could not load modpacks."); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [debounced, gameId, gameVersion, provider]);

    const loadMore = async (): Promise<void> => {
        if (loadingMore || !hasMore || loading || !provider) return;
        setLoadingMore(true);
        try {
            const next = page + 1;
            const res = await window.db.searchProviderModpacks(gameId, provider, debounced, next, gameVersion);
            setResults((prev) => [...prev, ...res.modpacks]);
            setHasMore(res.hasMore);
            setPage(next);
        } catch {
            // Keep what we have; the user can scroll again to retry.
        } finally {
            setLoadingMore(false);
        }
    };

    const handleScroll = (e: React.UIEvent<HTMLDivElement>): void => {
        const el = e.currentTarget;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
            void loadMore();
        }
    };

    const handleImport = async (modpack: ProviderModpackSummary): Promise<void> => {
        setImportingId(modpack.id);
        setRowMessage(null);
        try {
            const result = await onImport(modpack.provider, modpack.id);
            setRowMessage({
                id: modpack.id,
                kind: result.success ? 'ok' : 'err',
                text: result.success ? 'Imported!' : (result.error ?? 'Import failed.'),
            });
        } finally {
            setImportingId(null);
        }
    };

    return (
        <Modal
            onClose={onClose}
            label="Browse modpacks"
            hideHeader
            panelClassName="flex max-h-[80vh] max-w-2xl flex-col overflow-hidden border-zinc-700/45 bg-zinc-900/92"
        >
            <div className="flex items-center justify-between border-b border-zinc-700/45 p-6">
                <div>
                    <h3 className="text-2xl font-bold text-white">Browse Modpacks</h3>
                    <p className="text-sm text-zinc-400">Find and import an existing modpack{gameVersion ? ` for MC ${gameVersion}` : ''}.</p>
                </div>
                <button onClick={onClose} className="clean-button clean-button-ghost p-2 text-zinc-400 hover:text-white" aria-label="Close dialog">
                    <FiX size={24} />
                </button>
            </div>

            <div className="border-b border-zinc-700/45 p-6">
                {providers.length > 1 && (
                    <div className="mb-3 flex gap-1 rounded-lg bg-zinc-800/60 p-1" role="tablist" aria-label="Modpack source">
                        {providers.map((p) => (
                            <button
                                key={p.id}
                                type="button"
                                role="tab"
                                aria-selected={provider === p.id}
                                onClick={() => setProvider(p.id)}
                                className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                                    provider === p.id ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-white'
                                }`}
                            >
                                {p.label}
                            </button>
                        ))}
                    </div>
                )}
                <div className="relative">
                    <FiSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" size={16} />
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search modpacks…"
                        className="clean-input pl-9"
                    />
                </div>
            </div>

            <div ref={scrollRef} className="clean-scroll flex-1 overflow-y-auto p-6" onScroll={handleScroll}>
                {loading ? (
                    <div className="py-12 text-center">
                        <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-b-2 border-zinc-400" />
                        <p className="text-zinc-400">Loading modpacks…</p>
                    </div>
                ) : error ? (
                    <p className="py-12 text-center text-red-400">{error}</p>
                ) : results.length === 0 ? (
                    <p className="py-12 text-center text-zinc-400">{debounced ? 'No modpacks match your search.' : 'No modpacks found.'}</p>
                ) : (
                    <div className="space-y-3">
                        {results.map((modpack) => {
                            const message = rowMessage?.id === modpack.id ? rowMessage : null;
                            const downloads = formatDownloads(modpack.downloads);
                            return (
                                <div key={modpack.id} className="clean-panel-muted rounded-lg p-4">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="flex min-w-0 flex-1 items-start gap-3">
                                            {modpack.logo ? (
                                                <img src={modpack.logo} alt="" className="h-12 w-12 shrink-0 rounded object-cover" />
                                            ) : (
                                                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-zinc-800 text-zinc-500"><FiPackage /></div>
                                            )}
                                            <div className="min-w-0 flex-1">
                                                <h4 className="font-semibold text-white">{modpack.name}</h4>
                                                <p className="text-sm text-zinc-400">by {modpack.author}{downloads ? ` · ${downloads}` : ''}</p>
                                                {modpack.summary && <p className="mt-1 line-clamp-2 text-xs text-zinc-500">{modpack.summary}</p>}
                                                {message && <p className={`mt-1 text-xs ${message.kind === 'ok' ? 'text-emerald-300' : 'text-rose-300'}`}>{message.text}</p>}
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => void handleImport(modpack)}
                                            disabled={importingId !== null}
                                            className="clean-button clean-button-soft shrink-0 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                                        >
                                            <FiDownload size={15} />
                                            <span>{importingId === modpack.id ? 'Importing…' : 'Import'}</span>
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                        {loadingMore && (
                            <div className="py-6 text-center">
                                <div className="mx-auto mb-2 h-8 w-8 animate-spin rounded-full border-b-2 border-zinc-400" />
                                <p className="text-sm text-zinc-500">Loading more…</p>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </Modal>
    );
};

export default BrowseModpacksModal;
