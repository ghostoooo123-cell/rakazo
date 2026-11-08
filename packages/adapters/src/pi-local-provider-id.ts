import { parseModelLabelPairs } from "./pi-model-labels.js";

/**
 * Local OpenAI-compatible model server (Ollama, LM Studio, llama.cpp, MLX).
 * Kept apart from pi-local-provider.ts so the runtime limits can name it without loading the provider.
 */
export const LOCAL_PROVIDER_ID = "local";

/** Optional catalog names: `api-id=Menu` or `api-id=Menu|Detail`, comma-separated. */
export const LOCAL_MODEL_LABELS_ENV = "RAKAZO_LOCAL_MODEL_LABELS";

export function isLocalProvider(provider: string | null | undefined): boolean {
  return provider === LOCAL_PROVIDER_ID;
}

/** Comma-separated model ids exactly as the local server names them. */
export function localModelIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.RAKAZO_LOCAL_MODELS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/**
 * True when this provider/model is the operator's local catalog entry. Every signed-in account
 * may pin it without a personal URL or key; the server keeps the endpoint.
 */
export function configuredLocalModel(
  provider: string | null | undefined,
  modelId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isLocalProvider(provider) || !modelId) return false;
  return localModelIds(env).includes(modelId);
}

/** Menu label (+ optional detail) for local ids. The API id stays the request id. */
export function localModelLabelEntries(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyMap<string, { label: string; detail?: string }> {
  return parseModelLabelPairs(env[LOCAL_MODEL_LABELS_ENV], new Set(localModelIds(env)));
}

/** Menu labels for local ids. Unknown or blank pairs are ignored; the API id stays the request id. */
export function localModelLabels(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const [id, entry] of localModelLabelEntries(env)) labels.set(id, entry.label);
  return labels;
}
