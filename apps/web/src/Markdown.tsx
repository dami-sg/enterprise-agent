import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

/**
 * Render assistant Markdown (GFM tables/lists + fenced code with syntax
 * highlighting via rehype-highlight → `.hljs-*` classes styled in styles.css).
 * Links open in a new tab; the agent's output is GFM (web-app §4 / W4).
 */
export function Markdown({ children }: { children: string }): React.ReactElement {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
