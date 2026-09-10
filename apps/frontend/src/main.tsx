import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { AuthLinkGate } from './features/auth/AuthLinkGate';
import { consumeAuthLink } from './features/auth/authLinks';
import { ThemeProvider } from './features/theme/ThemeProvider';
import { registerServiceWorker } from './pwa/registerServiceWorker';
import './styles.css';

const rootElement = document.querySelector<HTMLDivElement>('#root');

if (!rootElement) {
  throw new Error('Root element was not found.');
}

const authLink = consumeAuthLink(window.location, window.history);

createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider>
      <AuthLinkGate link={authLink}>
        <App />
      </AuthLinkGate>
    </ThemeProvider>
  </StrictMode>,
);

registerServiceWorker();
