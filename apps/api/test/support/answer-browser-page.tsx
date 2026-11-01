import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { useChatMessages } from '@/hooks/useChatMessages';
import { MessageBody } from '@/components/chat/MessageBody';

await i18n.use(initReactI18next).init({ lng: 'en', resources: {}, initImmediate: false });
function Benchmark() {
  const courseId = Number(new URLSearchParams(location.search).get('course')) || undefined;
  const chat = useChatMessages({ courseId });
  const started = useRef(false);
  const last = chat.messages.at(-1);
  useEffect(() => { chat.setMessages([]); }, []);
  useLayoutEffect(() => {
    if (!started.current || last?.role !== 'assistant') return;
    const result = (window as any).benchmark;
    // Two animation frames bracket a browser paint; search progress is outside #answer.
    if (!result.firstVisibleTextMs && document.querySelector('#answer')?.textContent?.trim()) {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        result.firstVisibleTextMs ??= performance.now() - result.start;
      }));
    }
    if (!chat.isLoading) requestAnimationFrame(() => requestAnimationFrame(() => {
      result.renderedCompletionMs = performance.now() - result.start;
      result.completed = true;
    }));
  }, [chat.messages, chat.isLoading]);
  return <><input value={chat.input} onChange={e => chat.setInput(e.target.value)} />
    <button onClick={() => {
      (window as any).benchmark = { start: performance.now() };
      started.current = true;
      void chat.handleSend();
    }}>Send</button>
    <div id="answer">{last?.role === 'assistant' && <MessageBody answer={last.answer} onVideoNavigate={() => {}} />}</div>
  </>;
}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><Benchmark /></QueryClientProvider>);
