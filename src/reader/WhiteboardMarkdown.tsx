import { isValidElement, useId, useMemo, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { OutlineDiagram } from './OutlineDiagram';
import { JapaneseLink } from './japaneseSpeech';
import './whiteboardMarkdown.css';

function MermaidBlock({ source }: { source: string }) {
  const id = `whiteboard-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const node = useMemo(() => {
    let hash = 2166136261;
    for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
    return { id, hash: `${id}-${source.length}-${hash >>> 0}`, type: 'mechanism' as const, text: 'Mermaid diagram', diagram: { lang: 'mermaid' as const, src: source } };
  }, [id, source]);
  return <div className="whiteboard-mermaid"><OutlineDiagram node={node} /><details><summary>Diagram source / text alternative</summary><pre>{source}</pre></details></div>;
}

function MarkdownPre({ children }: ComponentPropsWithoutRef<'pre'>) {
  if (isValidElement<{ className?: string; children?: ReactNode }>(children) && /(?:^|\s)language-mermaid(?:\s|$)/.test(children.props.className ?? '') && typeof children.props.children === 'string') {
    return <MermaidBlock source={children.props.children.replace(/\n$/, '')} />;
  }
  return <pre>{children}</pre>;
}

export function WhiteboardMarkdown({ source }: { source: string }) {
  return <div className="whiteboard-markdown"><Markdown remarkPlugins={[remarkGfm]} components={{ pre: MarkdownPre, a: JapaneseLink }}>{source}</Markdown></div>;
}
