let readyRegistrationPromise: Promise<ServiceWorkerRegistration> | null = null;

const serviceWorkerAvailable = (): boolean =>
  typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

const startServiceWorkerRegistration = (): Promise<ServiceWorkerRegistration> => {
  if (!serviceWorkerAvailable()) {
    return Promise.reject(new Error('Service workers are not supported by this browser.'));
  }

  if (readyRegistrationPromise !== null) {
    return readyRegistrationPromise;
  }

  const { serviceWorker } = navigator;
  const pending = serviceWorker.register('/service-worker.js').then(() => serviceWorker.ready);
  readyRegistrationPromise = pending.catch((error: unknown) => {
    readyRegistrationPromise = null;
    throw error;
  });
  return readyRegistrationPromise;
};

export const getExistingServiceWorkerRegistration =
  async (): Promise<ServiceWorkerRegistration | null> => {
    if (!serviceWorkerAvailable()) {
      return null;
    }

    if (readyRegistrationPromise !== null) {
      return readyRegistrationPromise;
    }

    return (await navigator.serviceWorker.getRegistration('/')) ?? null;
  };

export const getReadyServiceWorkerRegistration = (): Promise<ServiceWorkerRegistration> =>
  startServiceWorkerRegistration();

export const registerServiceWorker = (): void => {
  if (!import.meta.env.PROD || !serviceWorkerAvailable()) {
    return;
  }

  const register = (): void => {
    void startServiceWorkerRegistration().catch((error: unknown) => {
      console.error('Kinetra service worker registration failed.', error);
    });
  };

  if (document.readyState === 'complete') {
    register();
    return;
  }

  window.addEventListener('load', register, { once: true });
};
