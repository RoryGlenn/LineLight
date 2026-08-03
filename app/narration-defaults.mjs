export const DEFAULT_NARRATION_ENGINE = "offline";
export const NARRATION_PREFERENCE_VERSION = 1;

const NARRATION_ENGINES = new Set(["device", "offline", "azure"]);

/**
 * Restores a saved narration choice while migrating the former browser-voice
 * default to Offline natural exactly once. Online natural was never a default,
 * so an unversioned Azure choice is treated as intentional.
 */
export function restoreNarrationPreference(storedSettings = {}) {
  const storedEngine = NARRATION_ENGINES.has(storedSettings.narrationEngine)
    ? storedSettings.narrationEngine
    : DEFAULT_NARRATION_ENGINE;
  const preferenceIsCurrent =
    Number(storedSettings.narrationPreferenceVersion) >=
    NARRATION_PREFERENCE_VERSION;
  const narrationEngine =
    preferenceIsCurrent || storedEngine === "azure"
      ? storedEngine
      : DEFAULT_NARRATION_ENGINE;

  return {
    narrationEngine,
    narrationPreferenceVersion: NARRATION_PREFERENCE_VERSION,
  };
}

/**
 * Natural offline narration must never silently become browser speech.
 */
export function allowsDeviceFallback(narrationEngine) {
  return narrationEngine === "azure";
}
