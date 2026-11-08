import { isHostCompatibleProvider } from "./pi-host-compatible-id.js";
import { isLocalProvider } from "./pi-local-provider-id.js";

/**
 * When set to `1`, the signed-in model menus only offer the operator's local and
 * host-compatible models. Unconfigured deployments leave this unset and keep the
 * full catalog plus Connect flows.
 */
export const OPERATOR_MODELS_ONLY_ENV = "RAKAZO_OPERATOR_MODELS_ONLY";

export function operatorModelsOnlyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[OPERATOR_MODELS_ONLY_ENV]?.trim() === "1";
}

/** Catalog rows the operator-models menu may show. */
export function isOperatorMenuProvider(provider: string | null | undefined): boolean {
  return isLocalProvider(provider) || isHostCompatibleProvider(provider);
}

export function filterOperatorModelsMenu<T extends { provider: string }>(
  catalog: readonly T[],
  env: NodeJS.ProcessEnv = process.env,
): T[] {
  if (!operatorModelsOnlyEnabled(env)) return [...catalog];
  return catalog.filter((entry) => isOperatorMenuProvider(entry.provider));
}
