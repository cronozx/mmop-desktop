import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import Layout from '../components/Layout';
import Logo from '../components/Logo';
import { FiLogIn } from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';
import { getErrorMessage } from '../utils/errors';

const Login: React.FC = () => {
    const [rememberMe, setRememberMe] = useState<boolean>(true);
    const [invalid, setInvalid] = useState<string | null>(null);
    const [auth0Enabled, setAuth0Enabled] = useState<boolean | null>(null);
    const [auth0Busy, setAuth0Busy] = useState<boolean>(false);
    const canceledRef = useRef<boolean>(false);
    const navigate = useNavigate();
    const { refresh } = useAuth();

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const ensureAuthenticatedSession = async (): Promise<string | null> => {
        for (let attempt = 0; attempt < 12; attempt += 1) {
            const token = await window.db.getAuthToken();
            if (token && await window.db.validateAuthToken(token)) {
                return token;
            }
            await sleep(150);
        }
        return null;
    };

    useEffect(() => {
        void window.db.isAuth0Enabled().then(setAuth0Enabled).catch(() => setAuth0Enabled(false));
        // Leaving the screen mid-flow aborts the pending sign-in (no-op otherwise).
        return () => {
            void window.db.cancelAuth0Login();
        };
    }, []);

    const handleSignIn = async (promptLogin = false) => {
        setInvalid(null);
        canceledRef.current = false;
        setAuth0Busy(true);
        try {
            const result = await window.db.loginWithAuth0(rememberMe, promptLogin);
            if (!result.success) {
                // Don't show an error for a sign-in the user deliberately canceled.
                if (!canceledRef.current) {
                    setInvalid(result.error || 'Sign-in failed.');
                }
                return;
            }

            const token = await ensureAuthenticatedSession();
            if (!token) {
                // Prefer the backend's reason (e.g. a GitHub login that didn't
                // share an email) over the generic retry message.
                const diagnostic = await window.db.getSignInDiagnostic().catch(() => null);
                setInvalid(diagnostic || 'Sign-in succeeded, but the session was not ready. Please try once more.');
                return;
            }

            await refresh();
            navigate('/');
        } catch (error) {
            if (!canceledRef.current) {
                setInvalid(getErrorMessage(error) || 'Sign-in failed.');
            }
        } finally {
            setAuth0Busy(false);
        }
    };

    const handleCancelSignIn = () => {
        canceledRef.current = true;
        void window.db.cancelAuth0Login();
    };

    return (
        <Layout showNavbar={false} showSidebar={false}>
            <div className='relative min-h-screen overflow-hidden'>
                <div className='pointer-events-none absolute -top-28 -left-20 h-80 w-80 rounded-full bg-emerald-400/20 blur-3xl' />
                <div className='pointer-events-none absolute -bottom-20 right-0 h-72 w-72 rounded-full bg-cyan-300/15 blur-3xl' />

                <div className='relative z-10 flex min-h-screen items-center justify-center p-4 sm:p-8'>
                    <div className='w-full max-w-5xl overflow-hidden rounded-3xl border border-[#1a2029]/70 bg-[#161b22]/80 shadow-2xl backdrop-blur-sm'>
                        <div className='grid md:grid-cols-[1.1fr_1fr]'>
                            <section className='hidden border-r border-[#1a2029]/80 p-10 md:flex md:flex-col md:justify-between'>
                                <div>
                                    <div className='flex items-center gap-3'>
                                        <Logo className='h-16 w-16' />
                                        <p className='inline-block rounded-full border border-slate-400/30 bg-slate-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-slate-300'>MMOP</p>
                                    </div>
                                    <h1 className='mt-6 text-4xl font-bold leading-tight text-white'>Welcome back.</h1>
                                    <p className='mt-4 text-slate-300'>Manage your modpacks, contributors, and game instances in one place without friction.</p>
                                </div>

                                <div className='space-y-3 text-sm text-slate-300'>
                                    <p>Build and manage modpacks without the busywork.</p>
                                    <p>Browse, download, and update mods in a click.</p>
                                    <p>Collaborate on modpacks with your friends.</p>
                                </div>
                            </section>

                            <section className='flex flex-col justify-center p-6 sm:p-10'>
                                <h2 className='text-3xl font-semibold text-white'>Sign in</h2>
                                <p className='mt-2 text-sm text-slate-400'>Continue with your MMOP account. Sign-in opens securely in your browser.</p>

                                <div className='mt-8 space-y-5'>
                                    <label className='flex cursor-pointer items-center gap-3 text-sm text-slate-300'>
                                        <input
                                            type='checkbox'
                                            className='h-4 w-4 rounded border-slate-600 bg-[#161b22] accent-emerald-500'
                                            checked={rememberMe}
                                            onChange={(e) => setRememberMe(e.target.checked)}
                                            disabled={auth0Busy}
                                        />
                                        Keep me signed in on this device
                                    </label>

                                    <button
                                        type='button'
                                        onClick={() => handleSignIn()}
                                        disabled={auth0Busy || auth0Enabled === false}
                                        className='clean-button clean-button-primary w-full px-5 py-3.5 text-base font-semibold disabled:cursor-not-allowed disabled:opacity-60'
                                    >
                                        <FiLogIn size={18} />
                                        {auth0Busy ? 'Opening sign-in…' : 'Sign in'}
                                    </button>

                                    {auth0Busy ? (
                                        <button
                                            type='button'
                                            onClick={handleCancelSignIn}
                                            className='clean-button clean-button-ghost w-full px-5 py-2.5 text-sm'
                                        >
                                            Cancel
                                        </button>
                                    ) : (
                                        <button
                                            type='button'
                                            onClick={() => handleSignIn(true)}
                                            disabled={auth0Enabled === false}
                                            className='w-full text-center text-sm text-slate-400 transition-colors hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-60'
                                        >
                                            Use a different account
                                        </button>
                                    )}

                                    {invalid && (
                                        <div className='rounded-lg border border-red-500/40 bg-red-900/20 px-3 py-2 text-sm text-red-300' role='alert'>
                                            {invalid}
                                        </div>
                                    )}

                                    {auth0Enabled === false && (
                                        <div className='rounded-lg border border-amber-500/40 bg-amber-900/20 px-3 py-2 text-sm text-amber-200' role='status'>
                                            Sign-in is not configured. Set <span className='font-mono'>AUTH0_DOMAIN</span> and <span className='font-mono'>AUTH0_CLIENT_ID</span> in your environment.
                                        </div>
                                    )}

                                    <p className='text-xs text-slate-500'>
                                        New here? Choose “Sign up” on the page that opens — your account is created automatically on first sign-in.
                                    </p>
                                </div>
                            </section>
                        </div>
                    </div>
                </div>
            </div>
        </Layout>
    );
};

export default Login;
