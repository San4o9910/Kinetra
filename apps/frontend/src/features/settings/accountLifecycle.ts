export interface AccountDeletionLifecycle {
  readonly prepareAccountDeletion: (confirmation: string) => () => Promise<void>;
  readonly captureBrowserSubscription: () => Promise<PushSubscription | null>;
  readonly unsubscribeBrowserSubscription: (subscription: PushSubscription | null) => Promise<void>;
  readonly onSignedOut: () => void;
}

export const runAccountDeletionLifecycle = async (
  confirmation: string,
  lifecycle: AccountDeletionLifecycle,
): Promise<void> => {
  const deleteAccount = lifecycle.prepareAccountDeletion(confirmation);
  const subscription = await lifecycle.captureBrowserSubscription();

  await lifecycle.unsubscribeBrowserSubscription(subscription);
  await deleteAccount();
  lifecycle.onSignedOut();
};
