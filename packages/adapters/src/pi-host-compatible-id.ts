import { parseModelLabelPairs } from "./pi-model-labels.js";

/**
 * A second operator-configured OpenAI-compatible endpoint, beside the local model server.
 * The id file stays free of the provider so runtime limits can name it without loading Pi.
 */
export const HOST_COMPATIBLE_PROVIDER_ID = "host-compatible";

export const HOST_COMPATIBLE_CONNECTION_ERROR = "That model is provided by the server.";

/** Optional catalog names: `api-id=Menu` or `api-id=Menu|Detail`, comma-separated. */
export const HOST_COMPAT_MODEL_LABELS_ENV = "RAKAZO_HOST_COMPAT_MODEL_LABELS";

export function isHostCompatibleProvider(provider: string | null | undefined): boolean {
  return provider === HOST_COMPATIBLE_PROVIDER_ID;
}

export function hostCompatibleModelIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.RAKAZO_HOST_COMPAT_MODELS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

export function hostCompatibleModelLabelEntries(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyMap<string, { label: string; detail?: string }> {
  return parseModelLabelPairs(env[HOST_COMPAT_MODEL_LABELS_ENV], new Set(hostCompatibleModelIds(env)));
}
