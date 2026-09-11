import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const markdownProtocols = new Set(["http:", "https:", "mailto:"]);

export function safeMarkdownUrl(url: string) {
  const value = url.trim();
  if (
    value.startsWith("#") ||
    /^\/(?!\/)/.test(value) ||
    /^\.\.?\/(?!\/)/.test(value)
  ) {
    return value;
  }
  try {
    const parsed = new URL(value);
    return markdownProtocols.has(parsed.protocol) ? value : "";
  } catch {
    return "";
  }
}

/** Render nonblank GFM text with safe URLs and without raw HTML. */
export function Markdown({
  children,
  inline = false,
}: {
  children: string;
  inline?: boolean;
}) {
  if (!children.trim()) return null;
  return (
    <div className={`markdown ${inline ? "markdown-inline" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={safeMarkdownUrl}
        components={{
          a({ href, children }) {
            if (!href) return <span>{children}</span>;
            const external = /^https?:/i.test(href);
            return (
              <a
                href={href}
                {...(external
                  ? { target: "_blank", rel: "noreferrer noopener" }
                  : {})}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
