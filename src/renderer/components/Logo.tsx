import React from 'react';

/**
 * MMOP logo — an isometric cube with a green top and dark faces, rendered as
 * inline SVG with a transparent background so it scales and tints cleanly
 * anywhere in the UI. Size it via `className` (width/height) or `size`.
 */
const Logo: React.FC<{ className?: string; size?: number; title?: string }> = ({ className, size, title = 'MMOP' }) => (
    <svg
        viewBox="28 28 184 184"
        className={className}
        {...(size ? { width: size, height: size } : {})}
        role="img"
        aria-label={title}
        xmlns="http://www.w3.org/2000/svg"
    >
        <title>{title}</title>
        {/* Left (charcoal) face */}
        <polygon points="28,84 120,138 120,210 28,156" fill="#1d1d1d" />
        {/* Right (near-black) face */}
        <polygon points="212,84 120,138 120,210 212,156" fill="#0d0d0d" />
        {/* Top face — split into two greens by the center seam */}
        <polygon points="120,30 28,84 120,138" fill="#36b34a" />
        <polygon points="120,30 212,84 120,138" fill="#2fa544" />
        {/* Recessed (darker) center seam */}
        <line x1="120" y1="30" x2="120" y2="138" stroke="#1f8636" strokeWidth="3" strokeLinecap="round" />
    </svg>
);

export default Logo;
