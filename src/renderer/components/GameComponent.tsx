import React from "react";
import { useNavigate } from "react-router";

interface GameComponentProps {
    id: number;
    image: string;
    title: string;
    modpackCount: number;
}

const GameComponent: React.FC<GameComponentProps> = ({ id, image, title, modpackCount }) => {
    const navigate = useNavigate();

    const handleClick = () => {
        navigate('/game', { state: { game: { id, title, image, modpackCount } } });
    };

    return (
        <div
            onClick={handleClick}
            role="button"
            tabIndex={0}
            aria-label={`${title}, ${modpackCount.toLocaleString()} ${modpackCount === 1 ? 'modpack' : 'modpacks'}`}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleClick();
                }
            }}
            className="clean-card-hover group relative aspect-square cursor-pointer overflow-hidden rounded-2xl border border-[#232a34]/40 bg-[#161b22]/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60"
        >
            <img 
                src={image} 
                alt={title}
                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.08]"
            />
            <div className="absolute inset-0 bg-linear-to-t from-[#10141a]/95 via-[#161b22]/70 to-transparent opacity-100 transition-opacity duration-300 group-hover:opacity-90">
                <div className="absolute bottom-0 left-0 right-0 p-5">
                    <h3 className="mb-1.5 line-clamp-1 text-lg font-bold text-white">
                        {title}
                    </h3>
                    <p className="text-sm font-medium text-slate-200">
                        {modpackCount.toLocaleString()} {modpackCount === 1 ? 'modpack' : 'modpacks'}
                    </p>
                </div>
            </div>
            <div className="absolute right-3 top-3 rounded-full border border-slate-500/55 bg-[#10141a]/78 px-3 py-1.5 translate-y-1 opacity-0 backdrop-blur-sm transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100">
                <span className="text-xs font-semibold tracking-wide text-slate-100">View Modpacks</span>
            </div>
        </div>
    );
};

export default GameComponent;
