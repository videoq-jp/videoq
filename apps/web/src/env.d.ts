// Vite exposes configured values as strings; do not let its fallback any hide errors.
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_USE_S3_STORAGE?: string;
  readonly VITE_DEPLOYMENT_EDITION?: string;
}
