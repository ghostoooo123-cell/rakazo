/**
 * Local OpenAI-compatible model server (Ollama, LM Studio, llama.cpp, MLX).
 * Kept apart from pi-local-provider.ts so the runtime limits can name it without loading the provider.
 */
export const LOCAL_PROVIDER_ID = "local";

/** Optional catalog display names: `api-id=Menu label`, comma-separated. API ids stay unchanged. */
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

/** Menu labels for local ids. Unknown or blank pairs are ignored; the API id stays the request id. */
export function localModelLabels(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyMap<string, string> {
  const known = new Set(localModelIds(env));
  const labels = new Map<string, string>();
  for (const part of (env[LOCAL_MODEL_LABELS_ENV] ?? "").split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const id = trimmed.slice(0, eq).trim();
    const label = trimmed.slice(eq + 1).trim();
    if (!id || !label || !known.has(id)) continue;
    labels.set(id, label);
  }
  return labels;
}
