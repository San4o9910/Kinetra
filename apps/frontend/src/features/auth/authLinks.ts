export const authLinkPaths = Object.freeze({
  reset: '/auth/reset-password',
  verify: '/auth/verify-email',
});

export interface AuthLink {
  readonly kind: 'reset' | 'verify';
  readonly token: string | null;
}

// Email links keep credentials in the fragment, which is never sent in the HTTP URL.
// Read once before rendering or session restoration; do not persist tokens in storage.
export const consumeAuthLink = (
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
  history: Pick<History, 'replaceState'>,
): AuthLink | null => {
  const kind =
    location.pathname === authLinkPaths.reset
      ? 'reset'
      : location.pathname === authLinkPaths.verify
        ? 'verify'
        : null;
  if (kind === null) return null;

  const parameters = new URLSearchParams(location.hash.replace(/^#/u, ''));
  const tokens = parameters.getAll('token');
  const token = tokens.length === 1 ? tokens[0] : undefined;
  const valid =
    location.search === '' &&
    [...parameters.keys()].every((key) => key === 'token') &&
    token !== undefined &&
    /^[A-Za-z0-9_-]{32,256}$/u.test(token);
  try {
    history.replaceState(null, '', location.pathname);
  } catch {
    // Never use a token if it cannot first be removed from the address/history entry.
    return { kind, token: null };
  }
  return { kind, token: valid ? token : null };
};

export const resetPasswordIssue = (password: string, confirmation: string): string | null => {
  if (password.length < 10) return 'Используйте не меньше 10 символов.';
  if (new TextEncoder().encode(password).length > 72) {
    return 'Пароль слишком длинный. Используйте до 72 латинских или 36 русских букв.';
  }
  return password === confirmation ? null : 'Пароли не совпадают.';
};
