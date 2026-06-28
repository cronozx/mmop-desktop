import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";

interface MarkdownContentProps {
    /** Raw Markdown source (e.g. an untrusted mod description from a provider). */
    children: string;
    className?: string;
}

/**
 * Renders untrusted Markdown as a sanitized React element tree — never via
 * dangerouslySetInnerHTML. `rehype-raw` parses any embedded raw HTML (mod pages
 * often use bare <img> banners) and `rehype-sanitize` then strips anything
 * unsafe (scripts, event handlers, javascript: URLs) before it reaches the DOM.
 * Combined with the app's CSP this keeps a hostile description from running
 * markup. Links open in the user's browser via the main-process window handler.
 */
const MarkdownContent: React.FC<MarkdownContentProps> = ({ children, className }) => (
    <div className={`mmop-markdown${className ? ` ${className}` : ""}`}>
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw, rehypeSanitize]}
            components={{
                a: ({ children: linkChildren, ...props }) => (
                    <a {...props} target="_blank" rel="noreferrer noopener">
                        {linkChildren}
                    </a>
                ),
                img: ({ alt, ...props }) => (
                    <img {...props} alt={alt ?? ""} loading="lazy" />
                ),
            }}
        >
            {children}
        </ReactMarkdown>
    </div>
);

export default MarkdownContent;
