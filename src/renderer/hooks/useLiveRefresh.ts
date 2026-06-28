import { useEffect, useRef } from "react";

interface LiveRefreshOptions {
    /** Poll only while true (e.g. signed in / a pack is open). Defaults to true. */
    enabled?: boolean;
    /** Poll cadence in ms. Defaults to 20s. */
    intervalMs?: number;
}

/**
 * Keeps a screen current without the user navigating away and back: it invokes
 * `onRefresh` on a fixed interval and whenever the window regains focus or the
 * document becomes visible again. The latest callback is always used, so an
 * inline function is fine; background ticks are skipped (we refresh on focus
 * instead) to avoid needless work while the app is hidden.
 */
export function useLiveRefresh(onRefresh: () => void | Promise<void>, options: LiveRefreshOptions = {}): void {
    const { enabled = true, intervalMs = 20000 } = options;

    // Always call the freshest callback without re-subscribing every render.
    const savedCallback = useRef(onRefresh);
    savedCallback.current = onRefresh;

    useEffect(() => {
        if (!enabled) return;

        const run = () => { void savedCallback.current(); };

        const interval = setInterval(() => {
            if (typeof document === 'undefined' || document.visibilityState === 'visible') {
                run();
            }
        }, intervalMs);

        const onFocus = () => run();
        const onVisible = () => {
            if (document.visibilityState === 'visible') run();
        };

        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onVisible);

        return () => {
            clearInterval(interval);
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [enabled, intervalMs]);
}
