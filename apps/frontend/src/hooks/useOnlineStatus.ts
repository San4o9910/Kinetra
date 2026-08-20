import { useEffect, useState } from 'react';

export const useOnlineStatus = (): boolean => {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const markOnline = () => setIsOnline(true);
    const markOffline = () => setIsOnline(false);

    window.addEventListener('online', markOnline);
    window.addEventListener('offline', markOffline);

    return () => {
      window.removeEventListener('online', markOnline);
      window.removeEventListener('offline', markOffline);
    };
  }, []);

  return isOnline;
};
