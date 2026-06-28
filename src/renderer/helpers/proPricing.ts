import { useEffect, useState } from 'react';
import type { ProPricing, ProStatus } from '../../types/sharedTypes';

/** Fetches current Pro pricing once `enabled` is true (e.g. the panel is shown). */
export function useProPricing(enabled: boolean): ProPricing | null {
    const [pricing, setPricing] = useState<ProPricing | null>(null);

    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        window.db.getProPricing()
            .then((value) => { if (!cancelled) setPricing(value); })
            .catch(() => { /* leave null; the UI falls back to a plain upgrade prompt */ });
        return () => { cancelled = true; };
    }, [enabled]);

    return pricing;
}

/** Fetches the signed-in user's Pro/subscription status once `enabled` is true. */
export function useProStatus(enabled: boolean): ProStatus | null {
    const [status, setStatus] = useState<ProStatus | null>(null);

    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        window.db.getProStatus()
            .then((value) => { if (!cancelled) setStatus(value); })
            .catch(() => { /* leave null; trial CTA falls back to a plain upgrade prompt */ });
        return () => { cancelled = true; };
    }, [enabled]);

    return status;
}

/**
 * Formats a Stripe amount (in the currency's smallest unit) as currency, e.g.
 * "$5" or "$4.99". Uses the currency's own decimal count so it's correct for
 * 2-decimal (USD) and 0-decimal (JPY) currencies alike. Whole amounts drop the
 * trailing ".00".
 */
export function formatMoney(amount: number, currency: string): string {
    const code = currency.toUpperCase();
    try {
        const currencyFormat = new Intl.NumberFormat(undefined, { style: 'currency', currency: code });
        const decimals = currencyFormat.resolvedOptions().maximumFractionDigits ?? 2;
        const major = amount / 10 ** decimals;
        return new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency: code,
            minimumFractionDigits: Number.isInteger(major) ? 0 : decimals,
        }).format(major);
    } catch {
        return `${(amount / 100).toFixed(2)} ${code}`;
    }
}

const INTERVAL_ABBREV: Record<string, string> = { day: 'day', week: 'wk', month: 'mo', year: 'yr' };

/** Price line for the upgrade UI, e.g. "$5/mo" or "$12 every 3 months". */
export function formatPriceLine(pricing: ProPricing): string | null {
    if (pricing.amount === null || !pricing.currency || !pricing.interval) {
        return null;
    }
    const money = formatMoney(pricing.amount, pricing.currency);
    const count = pricing.intervalCount ?? 1;
    return count === 1
        ? `${money}/${INTERVAL_ABBREV[pricing.interval] ?? pricing.interval}`
        : `${money} every ${count} ${pricing.interval}s`;
}
