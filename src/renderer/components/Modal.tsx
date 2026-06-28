import React, { useCallback, useEffect, useRef } from "react";
import { FiX } from "react-icons/fi";

interface ModalProps {
    /** Called when the user dismisses via Escape, overlay click, or the close button. */
    onClose: () => void;
    /** Rendered as the dialog heading and wired to aria-labelledby. */
    title?: React.ReactNode;
    /** Used for aria-label when no visible `title` is provided. */
    label?: string;
    /** Optional supporting line under the title. */
    description?: React.ReactNode;
    /** Sizing/treatment classes for the panel (must include a max-w-*). Defaults to `max-w-md`. */
    panelClassName?: string;
    /** When false, clicking the backdrop does nothing (e.g. while a destructive op is in flight). */
    dismissOnOverlayClick?: boolean;
    /** When false, Escape is ignored (rare; keep true for accessibility). */
    closeOnEscape?: boolean;
    /** Disables the header close button and overlay/Escape dismissal while a blocking op runs. */
    busy?: boolean;
    /** Hides the built-in header so callers can render their own (still focus-trapped). */
    hideHeader?: boolean;
    /** Element to focus on open; falls back to the close button, then the first focusable. */
    initialFocusRef?: React.RefObject<HTMLElement | null>;
    children: React.ReactNode;
}

const FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'textarea:not([disabled])',
    'input:not([disabled])', 'select:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

let openModalCount = 0;

/**
 * The single accessible dialog shell for the app: backdrop, focus trap, Escape
 * and overlay dismissal, initial focus, and focus restoration to the trigger on
 * close. Entrance/exit motion is CSS-driven and disabled under reduced-motion.
 * Every modal routes through this so the behavior never drifts between screens.
 */
const Modal: React.FC<ModalProps> = ({
    onClose, title, label, description, panelClassName,
    dismissOnOverlayClick = true, closeOnEscape = true, busy = false,
    hideHeader = false, initialFocusRef, children,
}) => {
    const panelRef = useRef<HTMLDivElement>(null);
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const previouslyFocused = useRef<HTMLElement | null>(null);
    const titleId = useRef(`modal-title-${Math.random().toString(36).slice(2, 9)}`).current;

    const requestClose = useCallback(() => {
        if (busy) return;
        onClose();
    }, [busy, onClose]);

    // Remember the trigger, move focus in, and restore focus on unmount.
    useEffect(() => {
        previouslyFocused.current = document.activeElement as HTMLElement | null;
        openModalCount += 1;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';

        const focusTarget = initialFocusRef?.current
            ?? closeButtonRef.current
            ?? panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)
            ?? panelRef.current;
        // Defer so the entrance transform doesn't fight the focus scroll.
        const id = window.requestAnimationFrame(() => focusTarget?.focus());

        return () => {
            window.cancelAnimationFrame(id);
            openModalCount = Math.max(0, openModalCount - 1);
            if (openModalCount === 0) document.body.style.overflow = previousOverflow;
            previouslyFocused.current?.focus?.();
        };
        // Mount/unmount only — focus is captured once on open.
    }, []);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Escape' && closeOnEscape) {
            e.stopPropagation();
            requestClose();
            return;
        }
        if (e.key !== 'Tab') return;

        const focusable = Array.from(
            panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
        ).filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (focusable.length === 0) {
            e.preventDefault();
            return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement as HTMLElement | null;

        if (e.shiftKey && active === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
        }
    };

    return (
        <div
            className="modal-overlay fixed inset-0 z-[60] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget && dismissOnOverlayClick) requestClose();
            }}
        >
            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={title ? titleId : undefined}
                aria-label={title ? undefined : label}
                onKeyDown={handleKeyDown}
                className={`modal-panel clean-panel w-full ${panelClassName ?? 'max-w-md'}`}
            >
                {!hideHeader && (
                    <div className="flex items-start justify-between gap-3 p-6 pb-0">
                        <div className="min-w-0">
                            {title && (
                                <h3 id={titleId} className="text-lg font-bold text-white">{title}</h3>
                            )}
                            {description && (
                                <p className="mt-1 text-sm text-slate-400">{description}</p>
                            )}
                        </div>
                        <button
                            ref={closeButtonRef}
                            type="button"
                            onClick={requestClose}
                            disabled={busy}
                            className="clean-button clean-button-ghost p-2 text-slate-400 hover:text-white disabled:opacity-50"
                            aria-label="Close dialog"
                        >
                            <FiX size={20} />
                        </button>
                    </div>
                )}
                {children}
            </div>
        </div>
    );
};

export default Modal;
