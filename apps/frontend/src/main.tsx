import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { ThemeProvider } from './features/theme/ThemeProvider';
import { registerServiceWorker } from './pwa/registerServiceWorker';
import './styles.css';

const rootElement = document.querySelector<HTMLDivElement>('#root');

if (!rootElement) {
  throw new Error('Root element was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);

registerServiceWorker();
