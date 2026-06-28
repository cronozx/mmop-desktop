import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import Login from './screens/Login';
import { HashRouter, Navigate, Route, Routes, Outlet, useLocation } from 'react-router';
import Home from './screens/Home';
import GameDetail from './screens/GameDetail';
import Modpack from './screens/Modpack';
import Settings from './screens/Settings';
import SetPassword from './screens/SetPassword';
import { AuthProvider, useAuth } from './context/AuthContext';
import ErrorBoundary from './components/ErrorBoundary';
import UpdatePrompt from './components/UpdatePrompt';

// A quiet hello for anyone who cracks open DevTools — the curious and the
// would-be contributors. Aurora green to match the launcher.
console.log(
    '%cMMOP%c — built by people who play.\nPoke around. If you ship a fix, pull requests are welcome.',
    'font-weight:700;font-size:13px;color:#34d399;',
    'color:#a1a1aa;font-size:12px;',
);

const root = createRoot(document.getElementById('root')!);

/**
 * Reset scroll to the top on every route change. The app shell grows with its
 * content so the document is what scrolls; React Router doesn't restore scroll,
 * so without this a screen you scrolled down on stays scrolled when you
 * navigate elsewhere.
 */
const ScrollToTop: React.FC = () => {
    const { pathname } = useLocation();
    useEffect(() => {
        window.scrollTo(0, 0);
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
    }, [pathname]);
    return null;
};

const PrivateRoute: React.FC = () => {
    const { isAuthenticated, user, refresh } = useAuth();
    const location = useLocation();

    // Re-validate on route changes; the 30s interval + focus revalidation
    // live in AuthProvider.
    useEffect(() => {
        void refresh();
    }, [location.pathname, refresh]);

    if (isAuthenticated === null) {
        return <div className="flex items-center justify-center h-screen bg-[#161b22]">
            <p className="text-white">Loading...</p>
        </div>;
    }

    if (!isAuthenticated) {
        return <Navigate to='/login' />;
    }

    // Social signups must choose a password before using the rest of the app.
    if (user?.passwordSet === false && location.pathname !== '/set-password') {
        return <Navigate to='/set-password' />;
    }

    return <Outlet />;
}

root.render(
    <HashRouter>
        <AuthProvider>
            <ErrorBoundary>
                <ScrollToTop />
                <UpdatePrompt />
                <Routes>
                    <Route element={ <PrivateRoute/>}>
                        <Route path='/' element={<Home/>} />
                        <Route path='/game' element={<GameDetail/>} />
                        <Route path='/modpack' element={<Modpack/>} />
                        <Route path='/settings' element={<Settings/>} />
                        <Route path='/set-password' element={<SetPassword/>} />
                    </Route>
                    <Route path='/login' element={<Login />} />
                </Routes>
            </ErrorBoundary>
        </AuthProvider>
    </HashRouter>
)
