import React, { type ReactNode } from 'react';

import { chatFabAccessibleName, chatUnreadBadge } from './model';

export interface ChatFloatingButtonProps {
  readonly unreadCount: number;
  readonly hidden?: boolean;
  readonly disabled?: boolean;
  readonly onOpen: () => void;
}

export const ChatFloatingButton = ({
  unreadCount,
  hidden = false,
  disabled = false,
  onOpen,
}: ChatFloatingButtonProps): ReactNode => {
  if (hidden) {
    return null;
  }

  const badge = chatUnreadBadge(unreadCount);

  return (
    <React.Fragment>
      <button
        className="chat-fab"
        data-testid="chat-fab"
        type="button"
        aria-label={chatFabAccessibleName(unreadCount)}
        disabled={disabled}
        onClick={onOpen}
      >
        <svg className="chat-fab-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 4.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7.8L6 21v-3.5H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z" />
          <path d="M7.5 9h9M7.5 13h6" />
        </svg>
        {badge === null ? null : (
          <span className="chat-fab-badge" data-testid="chat-fab-badge" aria-hidden="true">
            {badge}
          </span>
        )}
      </button>
    </React.Fragment>
  );
};
