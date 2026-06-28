import React, { useEffect, useState } from "react";
import { FiPackage, FiPlus, FiUser, FiX, FiGitPullRequest } from "react-icons/fi";
import { ContributionRequest, ModType, PublicUser } from "../../../types/sharedTypes";

interface ContributionRequestsProps {
    requests: ContributionRequest[];
    contributersInModpack: PublicUser[];
    onAction: (action: 'accept' | 'deny', request: ContributionRequest) => void;
}

const ModCard: React.FC<{ mod: ModType; variant: 'added' | 'removed' }> = ({ mod, variant }) => {
    const border = variant === 'added' ? 'border-emerald-600/40' : 'border-rose-600/40';
    return (
        <div className={`flex items-center gap-2.5 rounded-lg border ${border} bg-[#161b22]/55 p-2.5`}>
            {mod.logo ? (
                <img src={mod.logo} alt="" className="h-9 w-9 shrink-0 rounded-lg object-cover" />
            ) : (
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#232a34] text-slate-500">
                    <FiPackage size={16} />
                </div>
            )}
            <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">{mod.name}</p>
                <div className="flex items-center gap-1 text-xs text-slate-400">
                    <FiUser className="text-[10px]" />
                    <span className="truncate">{mod.author}</span>
                </div>
            </div>
        </div>
    );
};

const STATUS_STYLES: Record<ContributionRequest['status'], { badge: string; ring: string; icon: string }> = {
    pending: { badge: 'bg-amber-900/30 text-amber-300 border border-amber-500/40', ring: 'border-amber-500/30 bg-amber-900/20', icon: 'text-amber-300' },
    approved: { badge: 'bg-emerald-900/30 text-emerald-300 border border-emerald-500/40', ring: 'border-emerald-500/30 bg-emerald-900/20', icon: 'text-emerald-300' },
    rejected: { badge: 'bg-rose-900/30 text-rose-300 border border-rose-500/40', ring: 'border-rose-500/30 bg-rose-900/20', icon: 'text-rose-300' },
};

const ContributionRequests: React.FC<ContributionRequestsProps> = ({
    requests, contributersInModpack, onAction,
}) => {
    const [modDetails, setModDetails] = useState<Record<string, ModType>>({});

    useEffect(() => {
        const fetchModDetails = async () => {
            const allIds = new Set<string>();
            for (const req of requests) {
                req.addedMods.forEach(id => allIds.add(id));
                req.removedMods.forEach(id => allIds.add(id));
            }
            const idsToFetch = [...allIds].filter(id => !modDetails[id]);
            if (idsToFetch.length === 0) return;
            const token = await window.db.getAuthToken();
            if (!token) return;
            const mods: ModType[] = await window.db.getModsByIds(token, idsToFetch);
            const newDetails: Record<string, ModType> = { ...modDetails };
            for (const mod of mods) {
                if (mod._id) newDetails[mod._id] = mod;
            }
            setModDetails(newDetails);
        };
        fetchModDetails();
    }, [requests]);

    const pendingCount = requests.filter((req) => req.status === 'pending').length;

    return (
        <div className="clean-panel mb-8 overflow-hidden">
            <div className="flex items-center justify-between border-b border-[#1a2029]/60 p-5">
                <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-100">
                    <FiGitPullRequest className="text-emerald-300" />
                    Collaboration Log
                </h2>
                {pendingCount > 0 && (
                    <span className="clean-pill border-amber-500/40 bg-amber-900/25 text-amber-200">{pendingCount} pending</span>
                )}
            </div>

            {requests.length === 0 ? (
                <div className="p-10 text-center text-sm text-slate-400">No contribution requests yet.</div>
            ) : (
                <div className="divide-y divide-[#1a2029]/60">
                    {requests.map((req, idx) => {
                        const styles = STATUS_STYLES[req.status];
                        const username = contributersInModpack.find(u => u._id === req.contributerId)?.username || req.contributerId;
                        const added = req.addedMods.length;
                        const removed = req.removedMods.length;
                        return (
                            <div key={idx} className="flex gap-4 p-5">
                                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border ${styles.ring}`}>
                                    <FiGitPullRequest size={16} className={styles.icon} />
                                </div>

                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <p className="text-sm text-slate-200">
                                                <span className="font-semibold text-white">{username}</span> proposed changes
                                            </p>
                                            <p className="mt-0.5 text-xs text-slate-500">
                                                {added > 0 && <span className="text-emerald-400">+{added} added</span>}
                                                {added > 0 && removed > 0 && ' · '}
                                                {removed > 0 && <span className="text-rose-400">−{removed} removed</span>}
                                                {(added > 0 || removed > 0) && ' • '}
                                                {new Date(req.timestamp).toLocaleString()}
                                            </p>
                                        </div>

                                        <div className="flex shrink-0 items-center gap-2">
                                            <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium capitalize ${styles.badge}`}>{req.status}</span>
                                            {req.status === 'pending' && (
                                                <>
                                                    <button
                                                        className="clean-button clean-button-soft border-emerald-500/45 bg-emerald-900/30 px-2.5 py-1.5 text-xs text-emerald-200"
                                                        onClick={() => onAction('accept', req)}
                                                    >
                                                        Accept
                                                    </button>
                                                    <button
                                                        className="clean-button clean-button-danger px-2.5 py-1.5 text-xs"
                                                        onClick={() => onAction('deny', req)}
                                                    >
                                                        Deny
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    </div>

                                    {(added > 0 || removed > 0) && (
                                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                                            {req.addedMods.length > 0 && (
                                                <div className="space-y-2">
                                                    <p className="flex items-center gap-1 text-xs font-medium text-emerald-400"><FiPlus className="text-[11px]" /> Added</p>
                                                    {req.addedMods.map((modId) => {
                                                        const mod = modDetails[modId];
                                                        return mod
                                                            ? <ModCard key={modId} mod={mod} variant="added" />
                                                            : <div key={modId} className="rounded-lg bg-[#1a2029]/30 p-2.5 text-sm text-slate-500">Loading…</div>;
                                                    })}
                                                </div>
                                            )}
                                            {req.removedMods.length > 0 && (
                                                <div className="space-y-2">
                                                    <p className="flex items-center gap-1 text-xs font-medium text-rose-400"><FiX className="text-[11px]" /> Removed</p>
                                                    {req.removedMods.map((modId) => {
                                                        const mod = modDetails[modId];
                                                        return mod
                                                            ? <ModCard key={modId} mod={mod} variant="removed" />
                                                            : <div key={modId} className="rounded-lg bg-[#1a2029]/30 p-2.5 text-sm text-slate-500">Loading…</div>;
                                                    })}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default ContributionRequests;
