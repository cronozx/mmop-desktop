import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { FiChevronDown, FiPlay } from "react-icons/fi";
import GameComponent from "../components/GameComponent";
import RecentModpackCard from "../components/RecentModpackCard";
import Layout from "../components/Layout";
import { GameType, ModpackType } from "../../types/sharedTypes";
import { filterGamesForPlatform, filterVerifiedGames, GAME_DEFINITIONS } from "../../config/games";
import { useAuth } from "../context/AuthContext";
import { useLiveRefresh } from "../hooks/useLiveRefresh";
import { readRecentModpackIds } from "../helpers/recentlyPlayed";

const IPC_TIMEOUT_MS = 7000;
/** How many items each shelf shows before "See more" reveals the rest. */
const RECENTS_PREVIEW = 4;
const GAMES_PREVIEW = 8;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
            setTimeout(() => reject(new Error('Timed out while loading games.')), timeoutMs);
        }),
    ]);
}

function getStaticFallbackGames(): GameType[] {
    const runtimePlatform = (() => {
        const platform = typeof navigator !== 'undefined'
            ? `${navigator.platform ?? ''} ${(navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? ''} ${navigator.userAgent ?? ''}`
            : '';
        return platform;
    })();

    // Only verified games are surfaced; unverified definitions stay hidden
    // until each one is tested end-to-end (mods search, download, launch).
    return filterGamesForPlatform(filterVerifiedGames(GAME_DEFINITIONS), runtimePlatform).map((game) => ({
        id: game.id,
        name: game.name,
        modCount: game.modCount,
        imagePath: game.imagePath,
        acceptedTypes: game.acceptedTypes,
        extensions: game.extensions,
        description: game.description,
        ...(game.features !== undefined && { features: game.features }),
    }));
}

const Home: React.FC = () => {
    const { token, user } = useAuth();
    const navigate = useNavigate();
    // Start empty (not the full static catalog) so uninstalled games never flash
    // in before the installed-games filter resolves.
    const [games, setGames] = useState<GameType[]>([])
    const [gamesLoaded, setGamesLoaded] = useState<boolean>(false)
    const [modpacks, setModpacks] = useState<ModpackType[]>([])
    const [showAllRecents, setShowAllRecents] = useState<boolean>(false)
    const [showAllGames, setShowAllGames] = useState<boolean>(false)

    const modpackCountByGame = useMemo(() => {
        const counts: Record<number, number> = {};
        modpacks.forEach((modpack) => {
            counts[modpack.gameID] = (counts[modpack.gameID] || 0) + 1;
        });
        return counts;
    }, [modpacks]);

    const gamesById = useMemo(() => {
        const map = new Map<number, GameType>();
        games.forEach((game) => map.set(game.id, game));
        return map;
    }, [games]);

    // Recently played, most-recent-first: stored launch history mapped back to the
    // modpacks the user still has. Ids for deleted packs fall away naturally.
    const recentModpacks = useMemo(() => {
        const byId = new Map(modpacks.map((modpack) => [modpack._id, modpack]));
        return readRecentModpackIds(user?._id)
            .map((id) => byId.get(id))
            .filter((modpack): modpack is ModpackType => !!modpack);
    }, [modpacks, user?._id]);

    useEffect(() => {
        const loadGames = async () => {
            let resolvedGames: GameType[] = [];
            try {
                const fetchedGames = await withTimeout(window.db.getAllGames(token ?? ''), IPC_TIMEOUT_MS);
                if (Array.isArray(fetchedGames) && fetchedGames.length > 0) {
                    resolvedGames = fetchedGames;
                }
            } catch {
                // Try the explicit public fallback endpoint below.
            }

            if (resolvedGames.length === 0) {
                try {
                    const publicGames = await withTimeout(window.db.getPublicGames(), IPC_TIMEOUT_MS);
                    resolvedGames = Array.isArray(publicGames) ? publicGames : [];
                } catch {
                    resolvedGames = [];
                }
            }

            if (resolvedGames.length === 0) {
                resolvedGames = getStaticFallbackGames();
            }

            // Defensive: never render unverified games, no matter the source.
            const verifiedGames = filterVerifiedGames(resolvedGames);

            // Only show games that are actually downloaded/installed on this
            // machine (Minecraft is always available — the app manages it). Fail
            // open if the local check is unavailable, so a detection hiccup never
            // empties the library.
            let installedGames = verifiedGames;
            try {
                const installedIds = await withTimeout(window.db.getInstalledGameIds(), IPC_TIMEOUT_MS);
                if (Array.isArray(installedIds)) {
                    const installedSet = new Set(installedIds);
                    installedGames = verifiedGames.filter((game) => installedSet.has(game.id));
                }
            } catch {
                // Keep the verified set rather than hiding everything.
            }
            setGames(installedGames);
            setGamesLoaded(true);
        };

        // Modpacks load independently: a failure here must never reset the
        // (already filtered) games list back to the full, unfiltered catalog.
        const loadModpacks = async () => {
            if (!token) {
                setModpacks([]);
                return;
            }
            try {
                const fetchedModpacks = await withTimeout(window.db.getAllModpacks(token), IPC_TIMEOUT_MS);
                setModpacks(Array.isArray(fetchedModpacks) ? fetchedModpacks : []);
            } catch {
                setModpacks([]);
            }
        };

        loadGames();
        loadModpacks();
    }, [token])

    // Keep the modpack list (recents + per-game counts) fresh without the user
    // navigating away and back — e.g. after accepting an invite elsewhere.
    const refreshModpacks = useCallback(async () => {
        if (!token) return;
        try {
            const fetched = await window.db.getAllModpacks(token);
            setModpacks(Array.isArray(fetched) ? fetched : []);
        } catch {
            // Non-fatal; keep the current list.
        }
    }, [token])

    useLiveRefresh(refreshModpacks, { enabled: !!token })

    const featured = recentModpacks[0] ?? null;
    const featuredGame = featured ? gamesById.get(featured.gameID) : undefined;
    const restRecents = recentModpacks.slice(1);
    const visibleRecents = showAllRecents ? restRecents : restRecents.slice(0, RECENTS_PREVIEW);
    const visibleGames = showAllGames ? games : games.slice(0, GAMES_PREVIEW);

    const openModpack = (modpack: ModpackType) => {
        const game = gamesById.get(modpack.gameID);
        navigate('/modpack', {
            state: {
                modpack,
                game: game ? { id: game.id, title: game.name, image: game.imagePath } : { id: modpack.gameID },
            },
        });
    };

    return (
        <Layout>
            <div className="app-container py-8 sm:py-10">
                <div className="mb-8">
                    <h2 className="text-2xl font-bold text-white sm:text-3xl">
                        Welcome back{user?.username ? `, ${user.username}` : ''}
                    </h2>
                    <p className="mt-1 text-sm text-slate-400">Jump back into a pack or browse games with mod support.</p>
                </div>

                {/* Featured: the most recently played pack, as a "continue" hero. */}
                {featured && (
                    <button
                        type="button"
                        onClick={() => openModpack(featured)}
                        aria-label={`Open ${featured.name}`}
                        className="clean-card-hover group relative mb-10 block w-full overflow-hidden rounded-2xl border border-[#232a34]/40 text-left"
                    >
                        {featuredGame?.imagePath && (
                            <img
                                src={featuredGame.imagePath}
                                alt=""
                                className="absolute inset-0 h-full w-full object-cover opacity-40 transition-all duration-500 group-hover:scale-105 group-hover:opacity-50"
                            />
                        )}
                        <div className="absolute inset-0 bg-gradient-to-r from-[#10141a] via-[#10141a]/85 to-[#10141a]/40" />
                        <div className="relative z-10 flex min-h-[208px] flex-col justify-end gap-3 p-6 sm:p-8">
                            <span className="text-xs font-semibold uppercase tracking-wider text-emerald-300">Jump back in</span>
                            <h3 className="text-2xl font-bold text-white sm:text-3xl">{featured.name}</h3>
                            <p className="text-sm text-slate-300">
                                {featuredGame?.name ?? 'Game'} · {featured.mods?.length ?? 0} {(featured.mods?.length ?? 0) === 1 ? 'mod' : 'mods'}
                                {featured.minecraftVersion ? ` · MC ${featured.minecraftVersion}` : ''}
                            </p>
                            <span className="clean-button clean-button-primary mt-2 w-fit px-5 py-2.5 text-sm font-semibold">
                                <FiPlay size={16} />
                                Open pack
                            </span>
                        </div>
                    </button>
                )}

                {/* Recently played: the rest of the launch history. */}
                {restRecents.length > 0 && (
                    <section className="mb-10">
                        <div className="mb-4 flex items-end justify-between gap-3">
                            <div>
                                <h3 className="text-lg font-semibold text-slate-100">Recently Played</h3>
                                <p className="mt-0.5 text-sm text-slate-400">Pick up where you left off.</p>
                            </div>
                            {restRecents.length > RECENTS_PREVIEW && (
                                <button
                                    onClick={() => setShowAllRecents((value) => !value)}
                                    className="clean-button clean-button-ghost shrink-0 px-3 py-1.5 text-sm"
                                    aria-expanded={showAllRecents}
                                >
                                    <span>{showAllRecents ? 'Show less' : `See more (${restRecents.length - RECENTS_PREVIEW})`}</span>
                                    <FiChevronDown className={`transition-transform duration-200 ${showAllRecents ? 'rotate-180' : ''}`} />
                                </button>
                            )}
                        </div>

                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                            {visibleRecents.map((modpack) => (
                                <RecentModpackCard
                                    key={modpack._id}
                                    modpack={modpack}
                                    game={gamesById.get(modpack.gameID)}
                                />
                            ))}
                        </div>
                    </section>
                )}

                {/* Games library */}
                <section>
                    <div className="mb-4 flex items-end justify-between gap-3">
                        <div>
                            <h3 className="text-lg font-semibold text-slate-100">Your Games</h3>
                            <p className="mt-0.5 text-sm text-slate-400">{games.length} {games.length === 1 ? 'title' : 'titles'} with mod support.</p>
                        </div>
                        {games.length > GAMES_PREVIEW && (
                            <button
                                onClick={() => setShowAllGames((value) => !value)}
                                className="clean-button clean-button-ghost shrink-0 px-3 py-1.5 text-sm"
                                aria-expanded={showAllGames}
                            >
                                <span>{showAllGames ? 'Show less' : `See more (${games.length - GAMES_PREVIEW})`}</span>
                                <FiChevronDown className={`transition-transform duration-200 ${showAllGames ? 'rotate-180' : ''}`} />
                            </button>
                        )}
                    </div>

                    {gamesLoaded && games.length === 0 ? (
                        <div className="clean-panel py-16 text-center">
                            <p className="text-lg text-slate-300">No installed games found. Install a supported game to get started.</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                            {visibleGames.map((game) => (
                                <GameComponent
                                    key={game.id}
                                    id={game.id}
                                    image={game.imagePath}
                                    title={game.name}
                                    modpackCount={modpackCountByGame[game.id] || 0}
                                />
                            ))}
                        </div>
                    )}
                </section>
            </div>
        </Layout>
    );
};

export default Home;