import React, { useEffect, useState } from "react";
import { FiExternalLink, FiHeart, FiX } from "react-icons/fi";
import { ModDescription } from "../../../types/sharedTypes";
import Modal from "../Modal";
import MarkdownContent from "../MarkdownContent";

interface ModDescriptionModalProps {
    modId: string;
    modName: string;
    author?: string;
    logo?: string;
    /** The author's donation link (Ko-fi, Patreon, …), surfaced as "Support me". */
    donationUrl?: string;
    onClose: () => void;
}

/**
 * Shows a mod's full long-form description, fetched on open. Descriptions arrive
 * as markdown/bbcode/plain text from the provider; they are rendered as plain
 * text (never injected as HTML) so a hostile description can't run markup.
 */
const ModDescriptionModal: React.FC<ModDescriptionModalProps> = ({ modId, modName, author, logo, donationUrl, onClose }) => {
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string>("");
    const [data, setData] = useState<ModDescription | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError("");
        window.db.getModDescription(modId)
            .then((result) => {
                if (cancelled) return;
                setData(result);
            })
            .catch(() => {
                if (!cancelled) setError("Could not load this mod's description.");
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => { cancelled = true; };
    }, [modId]);

    return (
        <Modal
            onClose={onClose}
            label={`${modName} description`}
            hideHeader
            panelClassName="flex max-h-[80vh] max-w-2xl flex-col overflow-hidden border-[#232a34]/45 bg-[#161b22]/92"
        >
            <div className="flex items-start justify-between gap-3 border-b border-[#232a34]/45 p-6">
                <div className="flex min-w-0 items-start gap-3">
                    {logo && <img src={logo} alt="" className="h-12 w-12 shrink-0 rounded object-cover" />}
                    <div className="min-w-0">
                        <h3 className="truncate text-xl font-bold text-white">{modName}</h3>
                        {author && <p className="truncate text-sm text-slate-400">by {author}</p>}
                    </div>
                </div>
                <button
                    onClick={onClose}
                    className="clean-button clean-button-ghost shrink-0 p-2 text-slate-400 hover:text-white"
                    aria-label="Close dialog"
                >
                    <FiX size={22} />
                </button>
            </div>

            <div className="clean-scroll flex-1 overflow-y-auto p-6">
                {loading ? (
                    <div className="py-12 text-center">
                        <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-b-2 border-slate-400" />
                        <p className="text-slate-400">Loading description…</p>
                    </div>
                ) : error ? (
                    <p className="py-12 text-center text-red-400">{error}</p>
                ) : data && data.description.trim() ? (
                    data.format === "markdown" ? (
                        <MarkdownContent>{data.description}</MarkdownContent>
                    ) : (
                        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-300">
                            {data.description}
                        </p>
                    )
                ) : (
                    <p className="py-12 text-center text-slate-400">No description provided for this mod.</p>
                )}
            </div>

            {(data?.url || donationUrl) && (
                <div className="flex flex-wrap items-center gap-3 border-t border-[#232a34]/45 p-4">
                    {data?.url && (
                        <a
                            href={data.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="clean-button clean-button-ghost inline-flex items-center gap-2 px-4 py-2 text-sm"
                        >
                            <FiExternalLink size={15} />
                            <span>Open mod page</span>
                        </a>
                    )}
                    {donationUrl && (
                        <a
                            href={donationUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="clean-button clean-button-ghost inline-flex items-center gap-2 px-4 py-2 text-sm text-emerald-300 hover:text-emerald-200"
                        >
                            <FiHeart size={15} />
                            <span>Support me</span>
                        </a>
                    )}
                </div>
            )}
        </Modal>
    );
};

export default ModDescriptionModal;
