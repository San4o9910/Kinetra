const prefix = 'kinetra.training.private.v1:';
export const draftKey = (account: string, kind: string, id: string) =>
  `${prefix}${account}:${kind}:${id}`;
export const readDraft = <T>(key: string): T | null => {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : null;
  } catch {
    return null;
  }
};
export const writeDraft = (key: string, value: unknown): boolean => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};
export const removeDraft = (key: string) => {
  try {
    localStorage.removeItem(key);
  } catch {
    /* Private mode may disable storage. */
  }
};
export const clearTrainingDrafts = (account: string) => {
  try {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(prefix + account + ':'));
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* Best-effort device cleanup. */
  }
};
