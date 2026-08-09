export const SERVICE_WORKER_URL = "/sw-v9.js";

/**
 * Keep production offline support without letting a previously installed
 * worker intercept Vite's development server.
 *
 * @param {ServiceWorkerContainer} serviceWorker Browser service worker API.
 * @param {{ development: boolean }} options Runtime registration policy.
 * @returns {Promise<void>}
 */
export async function configureServiceWorker(
  serviceWorker,
  { development },
) {
  if (development) {
    const registrations = await serviceWorker.getRegistrations();
    await Promise.all(
      registrations.map((registration) => registration.unregister()),
    );
    return;
  }

  await serviceWorker.register(SERVICE_WORKER_URL);
}
