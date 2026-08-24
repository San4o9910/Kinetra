interface ChatErrorShape {
  readonly code?: unknown;
  readonly kind?: unknown;
}

export const isTerminalChatAuthError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const { code, kind } = error as ChatErrorShape;
  return (
    code === 'AUTHENTICATION_REQUIRED' ||
    code === 'NO_SESSION' ||
    (code === 'AUTH_SESSION_CHANGED' && kind === 'auth')
  );
};
