import { useState, useRef, useEffect } from 'react';
import { useFleetGraphChat, useFleetGraphInsights } from '@/hooks/useFleetGraph';
import { FleetGraphInsightCard } from './FleetGraphInsightCard';

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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const chatMutation = useFleetGraphChat(entityType, entityId);
  const { data: insightsData } = useFleetGraphInsights(entityId);
  const insights = insightsData?.insights || [];

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
        <button
          onClick={() => setIsOpen(false)}
          className="rounded p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3" style={{ maxHeight: '50vh' }}>
        {/* Insight cards (if any, shown before chat) */}
        {insights.length > 0 && messages.length === 0 && (
          <div className="space-y-2">
            <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Active Findings</span>
            {insights.slice(0, 3).map(insight => (
              <FleetGraphInsightCard key={insight.id} insight={insight} />
            ))}
          </div>
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
              <p className="whitespace-pre-wrap">{msg.content}</p>
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
