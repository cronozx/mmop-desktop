import React from "react";
import { useNavigate } from "react-router";
import { FiPlay } from "react-icons/fi";
import { GameType, ModpackType } from "../../types/sharedTypes";

interface RecentModpackCardProps {
    modpack: ModpackType;
    game?: GameType;
}

/**
 * "Jump back in" card for the Home recents shelf: game art as a thumbnail with
 * the modpack name and a line of quick stats. Opens the modpack screen with the
 * same navigation contract GameDetail uses, so Back and Launch behave normally.
 */
const RecentModpackCard: React.FC<RecentModpackCardProps> = ({ modpack, game }) => {
    const navigate = useNavigate();
    const modCount = modpack.mods?.length ?? 0;
    // Pro users can set a custom icon; fall back to the game's art.
    const thumbnail = modpack.icon || game?.imagePath;

    const open = () => {
        navigate('/modpack', {
            state: {
                modpack,
                game: game
                    ? { id: game.id, title: game.name, image: game.imagePath }
                    : { id: modpack.gameID },
            },
        });
    };

    return (
        <button
            type="button"
            onClick={open}
            aria-label={`Open ${modpack.name}`}
            className="clean-panel clean-card-hover group flex w-full items-center gap-4 p-3 text-left"
        >
            <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-[#232a34]/45 bg-[#161b22]/60">
                {thumbnail ? (
                    <img
                        src={thumbnail}
                        alt={game?.name ?? modpack.name}
                        className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.08]"
                    />
                ) : (
                    <div className="flex h-full w-full items-center justify-center text-slate-500">
                        <FiPlay size={20} />
                    </div>
                )}
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#10141a]/55 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                    <FiPlay size={20} className="text-emerald-300" />
                </span>
            </div>

            <div className="min-w-0 flex-1">
                <h4 className="truncate font-semibold text-white">{modpack.name}</h4>
                <p className="mt-0.5 truncate text-sm text-slate-400">
                    {game?.name ?? 'Game'} · {modCount} {modCount === 1 ? 'mod' : 'mods'}
                </p>
                {modpack.minecraftVersion && (
                    <span className="clean-pill mt-2 border-emerald-500/35 bg-emerald-900/25 text-emerald-200">
                        MC {modpack.minecraftVersion}
                    </span>
                )}
            </div>
        </button>
    );
};

export default RecentModpackCard;
