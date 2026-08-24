import type { ChatConversationSummaryDto, ChatMessageSummaryDto } from '../chat/types';

export interface TrainerConversationSummaryPatch {
  readonly unreadCount: number;
  readonly lastMessage?: ChatMessageSummaryDto | null;
}

export class TrainerSelectedConversationStore {
  private readonly summaries = new Map<string, ChatConversationSummaryDto>();

  public remember(items: readonly ChatConversationSummaryDto[]): void {
    for (const item of items) {
      this.summaries.set(item.id, item);
    }
  }

  public get(conversationId: string): ChatConversationSummaryDto | null {
    return this.summaries.get(conversationId) ?? null;
  }

  public applyPatch(
    conversationId: string,
    patch: TrainerConversationSummaryPatch,
  ): ChatConversationSummaryDto | null {
    const current = this.summaries.get(conversationId);
    if (current === undefined) {
      return null;
    }

    const next: ChatConversationSummaryDto = {
      ...current,
      unread_count: patch.unreadCount,
      ...(patch.lastMessage === undefined
        ? {}
        : {
            last_message: patch.lastMessage,
            ...(patch.lastMessage === null ? {} : { activity_at: patch.lastMessage.created_at }),
          }),
    };
    this.summaries.set(conversationId, next);
    return next;
  }
}

export const recoverAuthorizedTrainerConversationSummary = async (
  getConversationSummary: (
    conversationId: string,
    signal?: AbortSignal,
  ) => Promise<ChatConversationSummaryDto | null>,
  conversationId: string,
  signal: AbortSignal,
): Promise<ChatConversationSummaryDto | null> => {
  signal.throwIfAborted();
  const summary = await getConversationSummary(conversationId, signal);
  signal.throwIfAborted();
  return summary;
};
