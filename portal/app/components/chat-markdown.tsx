import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function ChatMarkdown({ content }: { content: string }) {
  return <div className="chat-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ hr: () => null }}>{content}</ReactMarkdown></div>;
}
