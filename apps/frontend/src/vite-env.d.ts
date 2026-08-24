/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_PRIVACY_URL?: string;
  readonly VITE_SUPPORT_EMAIL?: string;
  readonly VITE_PRIVATE_MEDIA_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
