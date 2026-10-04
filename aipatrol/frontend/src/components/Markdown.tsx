import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Assistant text arrives as markdown. Rendered with GFM so tables, strikethrough
 * and task lists work. Links open in a new tab and carry noreferrer, since the
 * text comes from a model reading arbitrary files.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
          // Long tables and code blocks scroll inside their own box rather
          // than widening the column.
          table: ({ ...props }) => (
            <div className="md__scroll">
              <table {...props} />
            </div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
