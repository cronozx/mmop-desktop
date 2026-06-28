import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export interface AuthUser {
    username: string;
    _id: string;
    /** False when a social signup still needs to choose a password. */
    passwordSet?: boolean;
    /** True while the user has an active Pro subscription. */
    isPro?: boolean;
}

interface AuthContextValue {
    /** The raw auth token for IPC calls, or null when signed out. */
    token: string | null;
    /** Decoded user info from the token, or null when signed out. */
    user: AuthUser | null;
    /** null while the initial check is in flight, then true/false. */
    isAuthenticated: boolean | null;
    /** True while the initial auth check has not completed. */
    loading: boolean;
    /** Re-validates the stored token and refreshes token/user state. */
    refresh: () => Promise<void>;
    /** Clears the stored login and resets auth state. */
    logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [token, setToken] = useState<string | null>(null);
    const [user, setUser] = useState<AuthUser | null>(null);
    const [isAuthenticated, setAuthenticated] = useState<boolean | null>(null);

    const refresh = useCallback(async () => {
        try {
            const storedToken = await window.db.getAuthToken();
            const isValid = await window.db.validateAuthToken(storedToken || '');

            if (!isValid) {
                setToken(null);
                setUser(null);
                setAuthenticated(false);
                return;
            }

            const userData = await window.db.getUserDataFromToken();
            setToken(storedToken ?? null);
            // Keep the previous object identity when nothing changed so consumers
            // depending on `user` are not re-triggered by the periodic revalidation.
            setUser(prev => (
                prev && userData && prev._id === userData._id && prev.username === userData.username && prev.passwordSet === userData.passwordSet && prev.isPro === userData.isPro
                    ? prev
                    : userData
            ));
            setAuthenticated(true);
        } catch (_error) {
            setToken(null);
            setUser(null);
            setAuthenticated(false);
        }
    }, []);

    const logout = useCallback(async () => {
        await window.db.clearLogin();
        setToken(null);
        setUser(null);
        setAuthenticated(false);
    }, []);

    // Initial check + 30s interval + focus revalidation (centralized here,
    // previously implemented inside PrivateRoute).
    useEffect(() => {
        void refresh();

        const intervalId = window.setInterval(() => {
            void refresh();
        }, 30000);
        const focusHandler = () => {
            void refresh();
        };

        window.addEventListener('focus', focusHandler);

        return () => {
            window.clearInterval(intervalId);
            window.removeEventListener('focus', focusHandler);
        };
    }, [refresh]);

    const value = useMemo<AuthContextValue>(() => ({
        token,
        user,
        isAuthenticated,
        loading: isAuthenticated === null,
        refresh,
        logout,
    }), [token, user, isAuthenticated, refresh, logout]);

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthContextValue {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
}
