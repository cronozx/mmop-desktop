import React from "react";
import { FiX } from "react-icons/fi";

export type ResultBannerKind = 'success' | 'error' | 'warning' | 'info';

const KIND_STYLES: Record<ResultBannerKind, string> = {
    success: 'border-green-500/40 bg-green-900/20',
    error: 'border-red-500/40 bg-red-900/20',
    warning: 'border-amber-500/40 bg-amber-900/20',
    info: 'border-sky-500/40 bg-sky-900/20',
};

interface ResultBannerProps {
    kind: ResultBannerKind;
    onDismiss: () => void;
    children: React.ReactNode;
    /** Technical detail (paths, ids) collapsed behind a disclosure. */
    details?: React.ReactNode;
}

/**
 * The one banner used for every operation result on the Modpack screen.
 * Keeps severity styling, dismissal, and technical-detail disclosure
 * consistent instead of five hand-rolled variants.
 */
const ResultBanner: React.FC<ResultBannerProps> = ({ kind, onDismiss, children, details }) => {
    // Failures interrupt; success/info wait their turn so a screen reader isn't talked over.
    const assertive = kind === 'error' || kind === 'warning';
    return (
    <div
        className={`mb-6 flex items-start justify-between rounded-xl border p-4 ${KIND_STYLES[kind]}`}
        role={assertive ? 'alert' : 'status'}
        aria-live={assertive ? 'assertive' : 'polite'}
    >
        <div className="flex min-w-0 flex-1 gap-2.5 text-sm">
            {kind === 'success' && (
                <svg
                    className="mt-0.5 h-4 w-4 shrink-0 text-green-400"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                >
                    <path
                        className="check-draw"
                        d="M5 13l4 4L19 7"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </svg>
            )}
            <div className="min-w-0 flex-1">
                {children}
                {details && (
                    <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-slate-400 hover:text-slate-200">Details</summary>
                        <div className="mt-1 space-y-0.5 text-xs text-slate-400">{details}</div>
                    </details>
                )}
            </div>
        </div>
        <button
            onClick={onDismiss}
            className="ml-4 shrink-0 text-slate-400 transition-colors hover:text-white"
            aria-label="Dismiss"
        >
            <FiX size={16} />
        </button>
    </div>
    );
};

/** Join up to `cap` names; summarize the rest so 500 mods never become a wall of text. */
export function joinCapped(names: string[], cap = 8): string {
    if (names.length <= cap) return names.join(', ');
    return `${names.slice(0, cap).join(', ')} and ${names.length - cap} more`;
}

export default ResultBanner;
