export const OFFLINE_SPEECH_WORKER_ROUTE =
  "/assets/offline-speech.worker-*";

const OFFLINE_SPEECH_WORKER_ASSET =
  /^\/assets\/offline-speech\.worker-[^/]+\.js$/u;

/**
 * Identify the content-hashed browser worker emitted by Vite.
 *
 * @param {string} pathname
 */
export function isOfflineSpeechWorkerAsset(pathname) {
  return OFFLINE_SPEECH_WORKER_ASSET.test(pathname);
}
