export const OFFLINE_INSTALL_IDLE_DELAY_MS = 10_000;
export const OFFLINE_STORAGE_HEADROOM_MULTIPLIER = 2;

/**
 * Keep a default offline voice convenient without starting its heavy download
 * while another document task needs the browser's CPU, memory, and storage.
 *
 * @param {{
 *   attempted: boolean,
 *   engine: string,
 *   importing: boolean,
 *   packState: string,
 *   settingsRestored: boolean,
 * }} state
 */
export function shouldScheduleOfflinePreparation(state) {
  return Boolean(
    state.settingsRestored &&
      state.engine === "offline" &&
      state.packState === "missing" &&
      !state.importing &&
      !state.attempted,
  );
}

/**
 * Cache Storage may temporarily hold the downloaded body and its committed
 * response. Require two pack sizes when the browser exposes a usable estimate.
 *
 * @param {number} packBytes
 * @param {{ quota?: number, usage?: number } | undefined} estimate
 */
export function evaluateOfflineStorageHeadroom(packBytes, estimate) {
  const requiredBytes = Math.ceil(
    Math.max(0, Number(packBytes)) * OFFLINE_STORAGE_HEADROOM_MULTIPLIER,
  );
  const quota = Number(estimate?.quota);
  const usage = Number(estimate?.usage);
  const availableBytes =
    Number.isFinite(quota) &&
    Number.isFinite(usage) &&
    quota >= 0 &&
    usage >= 0
      ? Math.max(0, quota - usage)
      : null;
  return {
    availableBytes,
    requiredBytes,
    sufficient:
      availableBytes === null ? null : availableBytes >= requiredBytes,
  };
}
