import { useState, useRef, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFleetGraphChat, useFleetGraphInsights, useRunProactiveScan } from '@/hooks/useFleetGraph';

/** Lightweight inline markdown → React elements (bold, lists, line breaks, italic) */
function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      elements.push(<hr key={i} className="my-2 border-zinc-700" />);
      continue;
    }

    // Headings
    if (line.startsWith('**') && line.endsWith('**') && !line.includes('**', 2)) {
      // Standalone bold line = heading-like
    }

    // List items (- or •)
    const listMatch = line.match(/^(\s*)([-•])\s+(.*)$/);
    if (listMatch) {
      elements.push(
        <div key={i} className="flex gap-1.5 ml-1">
          <span className="text-zinc-500 shrink-0">•</span>
          <span>{inlineFormat(listMatch[3]!)}</span>
        </div>
      );
      continue;
    }

    // Numbered list
    const numMatch = line.match(/^(\d+)\.\s+(.*)$/);
    if (numMatch) {
      elements.push(
        <div key={i} className="flex gap-1.5 ml-1">
          <span className="text-zinc-500 shrink-0">{numMatch[1]}.</span>
          <span>{inlineFormat(numMatch[2]!)}</span>
        </div>
      );
      continue;
    }

    // Italic note line
    if (line.startsWith('*') && line.endsWith('*') && !line.startsWith('**')) {
      elements.push(<p key={i} className="text-zinc-500 text-xs italic mt-1">{line.slice(1, -1)}</p>);
      continue;
    }

    // Empty line = spacing
    if (line.trim() === '') {
      elements.push(<div key={i} className="h-1" />);
      continue;
    }

    // Regular line with inline formatting
    elements.push(<p key={i}>{inlineFormat(line)}</p>);
  }

  return elements;
}

/** Format inline markdown: **bold**, *italic*, `code` */
function inlineFormat(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Bold
    const boldMatch = remaining.match(/^(.*?)\*\*(.+?)\*\*(.*)/s);
    if (boldMatch) {
      if (boldMatch[1]) parts.push(boldMatch[1]);
      parts.push(<strong key={key++} className="font-semibold text-zinc-100">{boldMatch[2]}</strong>);
      remaining = boldMatch[3]!;
      continue;
    }

    // Code
    const codeMatch = remaining.match(/^(.*?)`(.+?)`(.*)/s);
    if (codeMatch) {
      if (codeMatch[1]) parts.push(codeMatch[1]);
      parts.push(<code key={key++} className="px-1 py-0.5 rounded bg-zinc-700 text-zinc-200 text-xs">{codeMatch[2]}</code>);
      remaining = codeMatch[3]!;
      continue;
    }

    // No more matches
    parts.push(remaining);
    break;
  }

  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

interface FleetGraphChatProps {
  entityType: string;
  entityId: string;
  entityTitle?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export function FleetGraphChat({ entityType, entityId, entityTitle }: FleetGraphChatProps) {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const chatMutation = useFleetGraphChat(entityType, entityId);
  const { data: insightsData } = useFleetGraphInsights(entityId);
  const insights = insightsData?.insights || [];
  const scanMutation = useRunProactiveScan();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || chatMutation.isPending) return;

    const userMessage: ChatMessage = { role: 'user', content: trimmed };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput('');

    try {
      const response = await chatMutation.mutateAsync({
        message: trimmed,
        chat_history: messages,
      });
      setMessages(prev => [...prev, { role: 'assistant', content: response.message }]);
    } catch {
      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: 'Sorry, I encountered an error. Please try again.' },
      ]);
    }
  };

  const handleScan = async () => {
    try {
      await scanMutation.mutateAsync();
      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content: '**Proactive scan started.** Results will appear on the Health Dashboard as they come in.',
        },
      ]);
    } catch {
      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: 'Proactive scan failed. Please try again.' },
      ]);
    }
  };

  const baseSuggestions = [
    'What\'s the biggest risk right now?',
    'Who is overloaded?',
    'Are there any blockers?',
    'How is this sprint tracking?',
  ];

  // Add context-specific suggestions
  const suggestedQuestions = entityType === 'sprint'
    ? ['Help me plan this sprint', 'Draft my standup', ...baseSuggestions]
    : entityType === 'project'
      ? ['What is the health of this project?', ...baseSuggestions]
      : baseSuggestions;

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-full bg-blue-600 px-4 py-3 text-sm font-medium text-white shadow-lg hover:bg-blue-500 transition-colors"
      >
        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        FleetGraph
        {insights.length > 0 && (
          <span className="ml-1 inline-flex items-center justify-center h-5 w-5 rounded-full bg-red-500 text-xs">
            {insights.length}
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 flex w-96 flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl" style={{ maxHeight: '70vh' }}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-700 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">FleetGraph</h3>
          <p className="text-xs text-zinc-500">
            Analyzing {entityTitle || entityType}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleScan}
            disabled={scanMutation.isPending}
            title="Run proactive scan"
            className="rounded p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50 disabled:opacity-50"
          >
            {scanMutation.isPending ? (
              <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            )}
          </button>
          {messages.length > 0 && (
            <button
              onClick={() => setMessages([])}
              title="New chat"
              className="rounded p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          )}
          <button
            onClick={() => setIsOpen(false)}
            className="rounded p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3" style={{ maxHeight: '50vh' }}>
        {/* Link to health dashboard if insights exist */}
        {insights.length > 0 && messages.length === 0 && (
          <button
            onClick={() => { setIsOpen(false); navigate('/health'); }}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800/50 p-3 text-left hover:border-zinc-600 transition-colors"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-400">
                {insights.length} active finding{insights.length !== 1 ? 's' : ''}
              </span>
              <span className="text-xs text-blue-400">View Health Dashboard →</span>
            </div>
          </button>
        )}

        {/* Chat messages */}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                msg.role === 'user'
                  ? 'bg-blue-600 text-white'
                  : 'bg-zinc-800 text-zinc-300'
              }`}
            >
              <div className="space-y-0.5">{renderMarkdown(msg.content)}</div>
            </div>
          </div>
        ))}

        {/* Loading indicator */}
        {chatMutation.isPending && (
          <div className="flex justify-start">
            <div className="rounded-lg bg-zinc-800 px-3 py-2">
              <div className="flex gap-1">
                <div className="h-2 w-2 rounded-full bg-zinc-600 animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="h-2 w-2 rounded-full bg-zinc-600 animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="h-2 w-2 rounded-full bg-zinc-600 animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}

        {/* Suggested questions (shown when chat is empty) */}
        {messages.length === 0 && (
          <div className="space-y-2">
            <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Ask FleetGraph</span>
            <div className="flex flex-wrap gap-2">
              {suggestedQuestions.map(q => (
                <button
                  key={q}
                  onClick={() => { setInput(q); inputRef.current?.focus(); }}
                  className="rounded-full border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-zinc-700 p-3">
        <form
          onSubmit={e => { e.preventDefault(); handleSend(); }}
          className="flex gap-2"
        >
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Ask about this project..."
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
            disabled={chatMutation.isPending}
          />
          <button
            type="submit"
            disabled={!input.trim() || chatMutation.isPending}
            className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 hover:bg-blue-500 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
}
