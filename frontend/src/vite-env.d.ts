/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the School Finance System API, e.g. `http://localhost:4000`. */
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_APP_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
