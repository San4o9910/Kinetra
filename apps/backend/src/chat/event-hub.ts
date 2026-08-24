import type { ChatConversationSnapshot, ChatMessageSnapshot, ChatRole } from './repository.js';

export type ChatDomainEvent =
  | {
      readonly kind: 'conversation_updated';
      readonly conversation: ChatConversationSnapshot;
    }
  | {
      readonly kind: 'message_created';
      readonly conversation: ChatConversationSnapshot;
      readonly message: ChatMessageSnapshot;
    }
  | {
      readonly kind: 'read_updated';
      readonly conversation: ChatConversationSnapshot;
      readonly readerRole: ChatRole;
      readonly throughSequence: number;
      readonly readAt: Date;
    }
  | {
      readonly kind: 'session_invalidated';
      readonly userId: string;
    };

export type ChatEventListener = (event: ChatDomainEvent) => void | Promise<void>;

export interface ChatEventPublisher {
  publish(event: ChatDomainEvent): Promise<void>;
}

export class ChatEventHub implements ChatEventPublisher {
  private readonly listeners = new Set<ChatEventListener>();

  public subscribe(listener: ChatEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async publish(event: ChatDomainEvent): Promise<void> {
    const settled = await Promise.allSettled(
      [...this.listeners].map(async (listener) => listener(event)),
    );

    for (const result of settled) {
      if (result.status === 'rejected') {
        console.error('Chat event listener failed after a durable commit.');
      }
    }
  }
}

export class NoopChatEventPublisher implements ChatEventPublisher {
  public async publish(_event: ChatDomainEvent): Promise<void> {}
}
