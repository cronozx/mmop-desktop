import React, { useEffect, useState } from "react";
import { FiClock, FiPackage, FiPlus, FiX } from "react-icons/fi";
import { ContributionRequest, ModType } from "../../../types/sharedTypes";

interface PendingRequestBannerProps {
    request: ContributionRequest;
}

const MiniModCard: React.FC<{ mod: ModType; variant: 'added' | 'removed' }> = ({ mod, variant }) => {
    const color = variant === 'added'
        ? 'border-green-600/40 bg-green-900/10'
        : 'border-red-600/40 bg-red-900/10';
    const icon = variant === 'added'
        ? <FiPlus className="text-green-400 text-xs shrink-0" />
        : <FiX className="text-red-400 text-xs shrink-0" />;

    return (
        <div className={`flex items-center space-x-2.5 border ${color} rounded-lg px-3 py-2`}>
            {icon}
            {mod.logo ? (
                <img src={mod.logo} alt={mod.name} className="w-8 h-8 rounded object-cover shrink-0" />
            ) : (
                <div className="w-8 h-8 rounded bg-[#232a34] flex items-center justify-center shrink-0">
                    <FiPackage className="text-slate-500 text-sm" />
                </div>
            )}
            <div className="min-w-0">
                <p className="text-white text-sm font-medium truncate">{mod.name}</p>
                <p className="text-slate-400 text-xs truncate">{mod.author}</p>
            </div>
        </div>
    );
};

const PendingRequestBanner: React.FC<PendingRequestBannerProps> = ({ request }) => {
    const [modDetails, setModDetails] = useState<Record<string, ModType>>({});

    const allModIds = [...request.addedMods, ...request.removedMods];

    useEffect(() => {
        const fetchMods = async () => {
            if (allModIds.length === 0) return;
            const token = await window.db.getAuthToken();
            if (!token) return;
            const mods: ModType[] = await window.db.getModsByIds(token, allModIds);
            const details: Record<string, ModType> = {};
            for (const mod of mods) {
                if (mod._id) details[mod._id] = mod;
            }
            setModDetails(details);
        };
        fetchMods();
    }, [request]);

    const statusColor = request.status === 'pending'
        ? 'border-amber-600/50 bg-amber-900/10'
        : request.status === 'approved'
            ? 'border-green-600/50 bg-green-900/10'
            : 'border-red-600/50 bg-red-900/10';

    const statusBadge = request.status === 'pending'
        ? 'bg-amber-500/20 text-amber-400'
        : request.status === 'approved'
            ? 'bg-green-500/20 text-green-400'
            : 'bg-red-500/20 text-red-400';

    const statusLabel = request.status.charAt(0).toUpperCase() + request.status.slice(1);

    return (
        <div className={`clean-panel mb-8 p-6 ${statusColor}`}>
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center space-x-3">
                    <FiClock className="text-amber-400 text-lg" />
                    <h3 className="text-white font-bold text-lg">Your Contribution Request</h3>
                </div>
                <div className="flex items-center space-x-3">
                    <span className="text-slate-400 text-xs">
                        {new Date(request.timestamp).toLocaleString()}
                    </span>
                    <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${statusBadge}`}>
                        {statusLabel}
                    </span>
                </div>
            </div>

            {request.addedMods.length === 0 && request.removedMods.length === 0 ? (
                <p className="text-slate-400 text-sm">No changes in this request.</p>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {request.addedMods.length > 0 && (
                        <div>
                            <h4 className="text-green-400 text-sm font-semibold mb-2 flex items-center">
                                <FiPlus className="mr-1.5" />
                                Added ({request.addedMods.length})
                            </h4>
                            <div className="space-y-2">
                                {request.addedMods.map(id => {
                                    const mod = modDetails[id];
                                    return mod ? (
                                        <MiniModCard key={id} mod={mod} variant="added" />
                                    ) : (
                                        <div key={id} className="h-12 bg-[#1a2029]/30 rounded-lg animate-pulse" />
                                    );
                                })}
                            </div>
                        </div>
                    )}
                    {request.removedMods.length > 0 && (
                        <div>
                            <h4 className="text-red-400 text-sm font-semibold mb-2 flex items-center">
                                <FiX className="mr-1.5" />
                                Removed ({request.removedMods.length})
                            </h4>
                            <div className="space-y-2">
                                {request.removedMods.map(id => {
                                    const mod = modDetails[id];
                                    return mod ? (
                                        <MiniModCard key={id} mod={mod} variant="removed" />
                                    ) : (
                                        <div key={id} className="h-12 bg-[#1a2029]/30 rounded-lg animate-pulse" />
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default PendingRequestBanner;
