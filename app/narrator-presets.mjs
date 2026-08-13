export const PODCAST_HOST_PRESET = Object.freeze({
  id: "podcast-host",
  label: "Podcast host",
  description: "Warm Studio F2 voice · native 44.1 kHz · fully offline",
  narrationEngine: "offline",
  offlineVoice: "F2",
  rate: 0.9,
});

/**
 * Apply a narrator preset without disturbing reading-layout preferences.
 *
 * @template {Record<string, unknown>} T
 * @param {T} settings
 * @param {typeof PODCAST_HOST_PRESET} [preset]
 * @returns {T & {
 *   narrationEngine: string,
 *   offlineVoice: string,
 *   rate: number,
 * }}
 */
export function applyNarratorPreset(
  settings,
  preset = PODCAST_HOST_PRESET,
) {
  return {
    ...settings,
    narrationEngine: preset.narrationEngine,
    offlineVoice: preset.offlineVoice,
    rate: preset.rate,
  };
}

/**
 * A preset stops being selected as soon as the reader customizes one of its
 * voice settings.
 *
 * @param {Record<string, unknown>} settings
 * @param {typeof PODCAST_HOST_PRESET} [preset]
 */
export function isNarratorPresetActive(
  settings,
  preset = PODCAST_HOST_PRESET,
) {
  return (
    settings.narrationEngine === preset.narrationEngine &&
    settings.offlineVoice === preset.offlineVoice &&
    settings.rate === preset.rate
  );
}
