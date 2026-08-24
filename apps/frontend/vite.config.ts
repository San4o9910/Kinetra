import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const envRoot = fileURLToPath(new URL('../../', import.meta.url));

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

interface ExactOriginMessages {
  readonly absolute: string;
  readonly exact: string;
  readonly secure: string;
}

const apiOriginMessages: ExactOriginMessages = {
  absolute: 'VITE_API_URL must be an absolute HTTP(S) origin.',
  exact: 'VITE_API_URL must contain only an HTTP(S) origin.',
  secure: 'VITE_API_URL must use HTTPS except for an explicit local loopback build.',
};

const privateMediaOriginMessages: ExactOriginMessages = {
  absolute: 'VITE_PRIVATE_MEDIA_ORIGIN must be an absolute HTTP(S) origin.',
  exact: 'VITE_PRIVATE_MEDIA_ORIGIN must contain only an HTTP(S) origin.',
  secure: 'VITE_PRIVATE_MEDIA_ORIGIN must use HTTPS except for an explicit local loopback build.',
};

export const normalizeExactHttpOrigin = (
  value: string | undefined,
  messages: ExactOriginMessages,
  allowInsecureLoopback = false,
): string | null => {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(messages.absolute);
  }

  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== '/' ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(messages.exact);
  }

  if (url.protocol === 'http:' && (!allowInsecureLoopback || !LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error(messages.secure);
  }

  return url.origin;
};

export const normalizeApiOrigin = (
  value: string | undefined,
  allowInsecureLoopback = false,
): string | null => normalizeExactHttpOrigin(value, apiOriginMessages, allowInsecureLoopback);

export const normalizePrivateMediaOrigin = (
  value: string | undefined,
  allowInsecureLoopback = false,
): string | null =>
  normalizeExactHttpOrigin(value, privateMediaOriginMessages, allowInsecureLoopback);

export const buildNormalizedFrontendEnv = (
  apiOrigin: string | null,
  privateMediaOrigin: string | null,
): Record<string, string> => ({
  'import.meta.env.VITE_API_URL': JSON.stringify(apiOrigin ?? ''),
  'import.meta.env.VITE_PRIVATE_MEDIA_ORIGIN': JSON.stringify(privateMediaOrigin ?? ''),
});

export const buildImageContentSecurityPolicy = (privateMediaOrigin: string | null): string =>
  `img-src 'self' blob:${privateMediaOrigin === null ? '' : ` ${privateMediaOrigin}`};`;

const contentSecurityPolicyPlugin = (policy: string): Plugin => ({
  name: 'kinetra-private-media-content-security-policy',
  transformIndexHtml: {
    order: 'pre',
    handler: () => [
      {
        tag: 'meta',
        attrs: {
          'http-equiv': 'Content-Security-Policy',
          content: policy,
        },
        injectTo: 'head-prepend',
      },
      {
        tag: 'meta',
        attrs: {
          name: 'referrer',
          content: 'no-referrer',
        },
        injectTo: 'head-prepend',
      },
    ],
  },
});

export default defineConfig(({ command, mode }) => {
  const runtimeEnv = loadEnv(mode, envRoot, '');
  const allowInsecureLoopback =
    (command === 'serve' && mode === 'development') || mode === 'browser-test';
  const apiOrigin = normalizeApiOrigin(runtimeEnv.VITE_API_URL, allowInsecureLoopback);
  const privateMediaOrigin = normalizePrivateMediaOrigin(
    runtimeEnv.VITE_PRIVATE_MEDIA_ORIGIN,
    allowInsecureLoopback,
  );
  const contentSecurityPolicy = buildImageContentSecurityPolicy(privateMediaOrigin);
  const securityHeaders = {
    'Content-Security-Policy': contentSecurityPolicy,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };

  return {
    envDir: envRoot,
    define: buildNormalizedFrontendEnv(apiOrigin, privateMediaOrigin),
    plugins: [contentSecurityPolicyPlugin(contentSecurityPolicy), react()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      headers: securityHeaders,
    },
    preview: {
      host: '0.0.0.0',
      port: 4173,
      headers: securityHeaders,
    },
    build: {
      sourcemap: true,
    },
  };
});
