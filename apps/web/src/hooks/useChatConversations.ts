import { useCallback, useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { appTrpcClient, trpc } from '@/lib/trpc';
import { useConfirm } from '@/components/common/feedback';
import type { Message } from './useChatMessages';
import {
  restoreConversationSelection, rememberConversation, forgetConversation,
  type StoredConversations as Stored,
} from '@/application/conversation-selection';

function readSelection(key: string): Stored {
  let data: unknown;
  try {
    data = JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch { /* Storage may be unavailable; chat still works in memory. */ }
  return restoreConversationSelection(data, () => crypto.randomUUID());
}
function store(key: string, value: Stored) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* No message content is stored here. */ }
}

export function useChatConversations({ courseId, shareToken, storageKey, showList }: {
  courseId?: number; shareToken?: string; storageKey: string; showList: boolean;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [initial] = useState(() => readSelection(storageKey));
  const [selected, setSelected] = useState(initial.selected);
  const [knownIds, setKnownIds] = useState(initial.knownIds);
  const access = { courseId, ...(shareToken ? { shareSlug: shareToken } : {}) };
  const listInput = { ...access, ...(shareToken ? { conversationIds: knownIds } : {}), limit: 20 };
  const list = useInfiniteQuery({
    queryKey: [...trpc.chat.conversations.queryKey({ ...listInput, offset: 0 }), 'pages', storageKey],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => appTrpcClient.chat.conversations.query({ ...listInput, offset: pageParam }, { signal }),
    getNextPageParam: (last, pages) => last.hasMore ? pages.length * 20 : undefined,
    enabled: showList,
  });
  const detailInput = { ...access, conversationId: selected.id, limit: 50 };
  const detail = useInfiniteQuery({
    queryKey: [...trpc.chat.conversation.queryKey(detailInput), 'pages', storageKey],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => appTrpcClient.chat.conversation.query({ ...detailInput, beforeTurnId: pageParam }, { signal }),
    getNextPageParam: last => last.hasMore ? last.turns[0]?.id : undefined,
    enabled: selected.restore,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: query => query.state.data?.pages[0]?.isGenerating ? 1500 : false,
  });
  const messages = useMemo<Message[]>(() => detail.data?.pages.slice().reverse().flatMap(page => page.turns.flatMap(turn => [
    { role: 'user' as const, content: turn.question },
    { role: 'assistant' as const, answer: turn.answer, chatLogId: turn.chatLogId ?? undefined,
      feedback: turn.feedback, feedbackToken: turn.feedbackToken },
  ])) ?? [], [detail.data]);

  const select = (id: string) => {
    const selection = { id, restore: true };
    setSelected(selection); store(storageKey, { selected: selection, knownIds });
  };
  const startNew = () => {
    const selection = { id: crypto.randomUUID(), restore: false };
    setSelected(selection); store(storageKey, { selected: selection, knownIds });
  };
  const remember = useCallback(() => {
    const remembered = rememberConversation(selected.id, knownIds);
    setKnownIds(remembered.knownIds);
    // Persist before starting the stream so reload can recover an in-flight answer.
    // Keep the current draft mounted; only the next mount needs to load its transcript.
    store(storageKey, remembered);
  }, [knownIds, selected.id, storageKey]);
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries(trpc.chat.conversations.pathFilter());
    void queryClient.invalidateQueries(trpc.chat.conversation.pathFilter());
  }, [queryClient]);
  const deletion = useMutation(trpc.chat.deleteConversation.mutationOptions());
  const remove = async (id: string) => {
    if (!await confirm({ title: t('chat.deleteConversation'), description: t('chat.deleteConversationConfirm'),
      confirmLabel: t('chat.deleteConversation'), variant: 'danger' })) return;
    await deletion.mutateAsync({ ...access, conversationId: id });
    const remaining = forgetConversation({ selected, knownIds }, id, () => crypto.randomUUID());
    setKnownIds(remaining.knownIds);
    setSelected(remaining.selected); store(storageKey, remaining);
    queryClient.removeQueries(trpc.chat.conversation.queryFilter({ ...access, conversationId: id }));
    refresh();
  };
  return { selected, select, startNew, remember, refresh, remove, deleting: deletion.isPending,
    deleteError: deletion.error, list, detail, messages,
    restoring: selected.restore && detail.isPending,
    restoreError: selected.restore && !detail.data ? detail.error : null,
    remoteBusy: selected.restore && (detail.data?.pages[0]?.isGenerating ?? false) };
}
