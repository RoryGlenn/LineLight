export const SERVICE_WORKER_URL = "/sw-v9.js";
export const RUNTIME_ASSET_MANIFEST_URL = "/runtime-assets.json";

const RETAIN_RUNTIME_ASSETS = "linelight:retain-runtime-assets";
const RELEASE_RUNTIME_ASSETS = "linelight:release-runtime-assets";
const GET_RUNTIME_ASSET_DIAGNOSTICS =
  "linelight:get-runtime-asset-diagnostics";
const RUNTIME_ASSET_DIAGNOSTICS = "linelight:runtime-asset-diagnostics";
const MAX_DEPLOYMENT_ASSETS = 512;
const RUNTIME_LEASE_HEARTBEAT_MS = 60_000;

const unavailableDiagnostics = () => ({
  available: false,
  retainedAssets: 0,
  retainedBytes: 0,
  legacyCaches: 0,
});

function runtimeAssetUrl(value, origin) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value, origin);
    url.hash = "";
    if (url.origin !== origin || !url.pathname.startsWith("/assets/")) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function runtimeAssets(values, origin) {
  if (!Array.isArray(values) || values.length > MAX_DEPLOYMENT_ASSETS) {
    return null;
  }
  const assets = Array.from(
    new Set(values.map((value) => runtimeAssetUrl(value, origin)).filter(Boolean)),
  ).sort();
  return assets.length ? assets : null;
}

function deploymentManifest(value, origin) {
  if (
    !value ||
    value.version !== 1 ||
    typeof value.deploymentId !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(value.deploymentId)
  ) {
    return null;
  }
  const assets = runtimeAssets(value.assets, origin);
  return assets
    ? {
        version: 1,
        deploymentId: value.deploymentId,
        assets,
      }
    : null;
}

function observedRuntimeAssets(environment, origin) {
  const entries = environment.performance?.getEntriesByType?.("resource") ?? [];
  const linkedAssets = Array.from(
    environment.document?.querySelectorAll?.("script[src], link[href]") ?? [],
    (element) => element.src ?? element.href,
  );
  return Array.from(
    new Set(
      [
        // This module is bundled into the deployment's page chunk, providing a
        // durable identity even when Resource Timing has been cleared.
        import.meta.url,
        ...linkedAssets,
        ...entries.map((entry) => entry?.name),
      ]
        .map((value) => runtimeAssetUrl(value, origin))
        .filter(Boolean),
    ),
  ).sort();
}

async function resolveActiveWorker(serviceWorker, registration) {
  if (serviceWorker.controller) return serviceWorker.controller;
  if (registration?.active) return registration.active;
  if (!serviceWorker.ready) return null;
  try {
    return (await serviceWorker.ready)?.active ?? null;
  } catch {
    return null;
  }
}

/**
 * Keep production offline support without letting a previously installed
 * worker intercept Vite's development server. Production pages register an
 * idle asset lease using the exact build manifest emitted beside the app.
 *
 * @param {ServiceWorkerContainer} serviceWorker Browser service worker API.
 * @param {{
 *   development: boolean,
 *   environment?: typeof globalThis,
 * }} options Runtime registration policy.
 * @returns {Promise<() => void>}
 */
export async function configureServiceWorker(
  serviceWorker,
  { development, environment = globalThis },
) {
  if (development) {
    const registrations = await serviceWorker.getRegistrations();
    await Promise.all(
      registrations.map((registration) => registration.unregister()),
    );
    return () => {};
  }

  const registration = await serviceWorker.register(SERVICE_WORKER_URL);
  const origin = environment.location?.origin;
  if (!origin || typeof environment.fetch !== "function") {
    return () => {};
  }

  const pageLoadedAt = Number(environment.performance?.timeOrigin) || Date.now();
  let retainedManifest = null;
  let manifestRequest = null;
  let scheduledReport = null;
  let heartbeatId;
  let disposed = false;

  const loadManifest = async () => {
    if (retainedManifest) return retainedManifest;
    if (manifestRequest) return manifestRequest;
    manifestRequest = (async () => {
      try {
        const response = await environment.fetch(RUNTIME_ASSET_MANIFEST_URL, {
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) return null;
        const candidate = deploymentManifest(await response.json(), origin);
        if (!candidate) return null;
        const knownAssets = new Set(candidate.assets);
        if (
          observedRuntimeAssets(environment, origin).some(
            (assetUrl) => !knownAssets.has(assetUrl),
          )
        ) {
          // The page came from a different deployment than the unversioned
          // manifest. Remaining unleased makes cleanup conservative.
          return null;
        }
        retainedManifest = candidate;
        return candidate;
      } catch {
        return null;
      } finally {
        manifestRequest = null;
      }
    })();
    return manifestRequest;
  };

  const reportLease = async () => {
    if (disposed) return;
    const manifest = await loadManifest();
    if (!manifest || disposed) return;
    const observedAssets = observedRuntimeAssets(environment, origin);
    const knownAssets = new Set(manifest.assets);
    if (observedAssets.some((assetUrl) => !knownAssets.has(assetUrl))) return;
    const target = await resolveActiveWorker(serviceWorker, registration);
    if (disposed) return;
    target?.postMessage({
      type: RETAIN_RUNTIME_ASSETS,
      loadedAt: pageLoadedAt,
      manifest,
      observedAssets,
    });
  };

  const cancelScheduledReport = () => {
    if (!scheduledReport) return;
    if (scheduledReport.kind === "idle") {
      environment.cancelIdleCallback?.(scheduledReport.id);
    } else {
      environment.clearTimeout?.(scheduledReport.id);
    }
    scheduledReport = null;
  };

  const scheduleLease = () => {
    if (disposed || scheduledReport) return;
    const run = () => {
      scheduledReport = null;
      void reportLease();
    };
    if (typeof environment.requestIdleCallback === "function") {
      scheduledReport = {
        kind: "idle",
        id: environment.requestIdleCallback(run, { timeout: 5_000 }),
      };
    } else {
      scheduledReport = {
        kind: "timeout",
        id: environment.setTimeout?.(run, 0),
      };
    }
  };

  const handleVisibility = () => {
    if (environment.document?.visibilityState === "visible") scheduleLease();
  };
  const releaseLease = (event) => {
    if (event?.persisted) return;
    const target = serviceWorker.controller ?? registration?.active;
    target?.postMessage({ type: RELEASE_RUNTIME_ASSETS });
  };

  serviceWorker.addEventListener?.("controllerchange", scheduleLease);
  environment.addEventListener?.("focus", scheduleLease);
  environment.addEventListener?.("pageshow", scheduleLease);
  environment.addEventListener?.("pagehide", releaseLease);
  environment.document?.addEventListener?.(
    "visibilitychange",
    handleVisibility,
  );
  scheduleLease();
  heartbeatId = environment.setInterval?.(
    scheduleLease,
    RUNTIME_LEASE_HEARTBEAT_MS,
  );

  return () => {
    if (disposed) return;
    disposed = true;
    cancelScheduledReport();
    if (heartbeatId !== undefined) {
      environment.clearInterval?.(heartbeatId);
    }
    serviceWorker.removeEventListener?.("controllerchange", scheduleLease);
    environment.removeEventListener?.("focus", scheduleLease);
    environment.removeEventListener?.("pageshow", scheduleLease);
    environment.removeEventListener?.("pagehide", releaseLease);
    environment.document?.removeEventListener?.(
      "visibilitychange",
      handleVisibility,
    );
    releaseLease();
  };
}

/**
 * Ask the active service worker for the bytes retained in the stable runtime
 * cache and finite pre-v9 caches. The scan runs only when diagnostics are
 * requested, never during page or narration startup.
 *
 * @param {ServiceWorkerContainer} serviceWorker Browser service worker API.
 * @param {{
 *   MessageChannel?: typeof globalThis.MessageChannel,
 *   timeoutMs?: number,
 * }} [options]
 */
export async function getRuntimeAssetStorageDiagnostics(
  serviceWorker,
  {
    MessageChannel: MessageChannelConstructor = globalThis.MessageChannel,
    timeoutMs = 2_000,
  } = {},
) {
  if (typeof MessageChannelConstructor !== "function") {
    return unavailableDiagnostics();
  }
  const target = serviceWorker.controller;
  if (!target) return unavailableDiagnostics();

  return new Promise((resolve) => {
    const channel = new MessageChannelConstructor();
    let settled = false;
    const finish = (diagnostics) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      channel.port1.close?.();
      channel.port2.close?.();
      resolve(diagnostics);
    };
    const timeoutId = setTimeout(
      () => finish(unavailableDiagnostics()),
      timeoutMs,
    );
    channel.port1.onmessage = (event) => {
      const value = event.data;
      if (value?.type !== RUNTIME_ASSET_DIAGNOSTICS) return;
      finish({
        available: value.available === true,
        retainedAssets: Math.max(0, Number(value.retainedAssets) || 0),
        retainedBytes: Math.max(0, Number(value.retainedBytes) || 0),
        legacyCaches: Math.max(0, Number(value.legacyCaches) || 0),
      });
    };
    channel.port1.start?.();
    try {
      target.postMessage(
        { type: GET_RUNTIME_ASSET_DIAGNOSTICS },
        [channel.port2],
      );
    } catch {
      finish(unavailableDiagnostics());
    }
  });
}
