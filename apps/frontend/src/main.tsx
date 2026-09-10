import { StrictMode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { AuthLinkGate } from './features/auth/AuthLinkGate';
import {
  consumeAuthLink,
  listenForAuthLinkNavigation,
  type AuthLink,
} from './features/auth/authLinks';
import { invalidateInMemorySession } from './lib/api';
import { ThemeProvider } from './features/theme/ThemeProvider';
import { registerServiceWorker } from './pwa/registerServiceWorker';
import './styles.css';

const rootElement = document.querySelector<HTMLDivElement>('#root');

if (!rootElement) {
  throw new Error('Root element was not found.');
}

const root = createRoot(rootElement);
let authLinkVersion = 0;

const renderApp = (link: AuthLink | null): void => {
  root.render(
    <StrictMode>
      <ThemeProvider>
        <AuthLinkGate key={authLinkVersion} link={link} onFinished={finishAuthLink}>
          <App />
        </AuthLinkGate>
      </ThemeProvider>
    </StrictMode>,
  );
};
const finishAuthLink = (): void => renderApp(null);

listenForAuthLinkNavigation(window, (link) => {
  // Clear stale account responses before replacing an already-open token form.
  invalidateInMemorySession();
  authLinkVersion += 1;
  flushSync(() => renderApp(link));
});
renderApp(consumeAuthLink(window.location, window.history));

registerServiceWorker();
