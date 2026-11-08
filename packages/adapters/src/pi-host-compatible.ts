import { lookup } from "node:dns/promises";
import type { Model, MutableModels, Provider } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  assertHeaderSafeApiKey,
  ipVersion,
  isCloudMetadataAddress,
  isLinkLocalAddress,
  isNonPublicAddress,
  normalizeHost,
} from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import { inputModalities } from "./model-modalities.js";
import {
  assertAllowedOpenAiCompatibleUrl,
  assertHttpsForKeyedOpenAiCompatibleUrl,
  isPrivateOpenAiCompatibleHostname,
} from "./openai-compatible-url.js";
import { HOST_COMPATIBLE_PROVIDER_ID, isHostCompatibleProvider } from "./pi-host-compatible-id.js";

export {
  HOST_COMPATIBLE_CONNECTION_ERROR,
  HOST_COMPATIBLE_PROVIDER_ID,
  isHostCompatibleProvider,
} from "./pi-host-compatible-id.js";

/** Shown on the catalog row. The endpoint URL and key are not part of it. */
export const HOST_COMPATIBLE_BILLING =
  "Runs on infrastructure configured by the server operator. No model charges from Rakazo.";

const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_MAX_TOKENS = 4_096;
const MIN_API_KEY_LENGTH = 8;
const MAX_MODEL_ID_LENGTH = 256;

export const HOST_COMPAT_MODELS_ENV = "RAKAZO_HOST_COMPAT_MODELS";
export const HOST_COMPAT_URL_ENV = "RAKAZO_HOST_COMPAT_URL";
export const HOST_COMPAT_API_KEY_ENV = "RAKAZO_HOST_COMPAT_API_KEY";
const HOST_COMPAT_CONTEXT_WINDOW_ENV = "RAKAZO_HOST_COMPAT_CONTEXT_WINDOW";
const HOST_COMPAT_MAX_TOKENS_ENV = "RAKAZO_HOST_COMPAT_MAX_TOKENS";
const HOST_COMPAT_VISION_MODELS_ENV = "RAKAZO_HOST_COMPAT_VISION_MODELS";
const HOST_COMPAT_REASONING_MODELS_ENV = "RAKAZO_HOST_COMPAT_REASONING_MODELS";

const MISDIRECTED_KEY = "The server model key cannot be sent to a different address.";
const UNRESOLVED_HOST = "The server model address could not be verified.";

export type HostCompatibleConfig = {
  modelIds: readonly string[];
  baseUrl: string;
  apiKey: string;
  contextWindow: number;
  maxTokens: number;
  visionModelIds: ReadonlySet<string>;
  reasoningModelIds: ReadonlySet<string>;
};

type HostCompatibleRead =
  | { ok: true; config: HostCompatibleConfig }
  | { ok: false; reason: "unset" | "invalid"; message?: string };

let warned = false;

function blank(value: string | undefined): boolean {
  return !value?.trim();
}

function listIds(value: string | undefined): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const part of (value ?? "").split(",")) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function modelIdError(id: string): string | undefined {
  if (id.length > MAX_MODEL_ID_LENGTH || !/^[\x21-\x7e]+$/.test(id)) {
    return `${HOST_COMPAT_MODELS_ENV} has a model id that cannot be sent.`;
  }
  return undefined;
}

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function sameEndpoint(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    const path = (value: URL) => value.pathname.replace(/\/+$/, "") || "/";
    return a.origin === b.origin && path(a) === path(b);
  } catch {
    return false;
  }
}

function endpointUrl(raw: string, env: NodeJS.ProcessEnv): string {
  let submitted: URL;
  try {
    submitted = new URL(raw);
  } catch {
    throw new Error(`${HOST_COMPAT_URL_ENV} must be an absolute HTTP(S) URL`);
  }
  // Normalization drops a query and a hash, so reject them on the value as written.
  if (submitted.username || submitted.password || submitted.search || submitted.hash) {
    throw new Error(`${HOST_COMPAT_URL_ENV} must not contain credentials or a query.`);
  }
  const url = assertAllowedOpenAiCompatibleUrl(raw, {
    allowPublic: env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC !== "0",
    allowPrivate: false,
  });
  assertHttpsForKeyedOpenAiCompatibleUrl(url, "present");
  const base = url.href.replace(/\/+$/, "");
  if (
    env.RAKAZO_LOCAL_MODELS_URL?.trim() &&
    sameEndpoint(base, env.RAKAZO_LOCAL_MODELS_URL.trim())
  ) {
    throw new Error(`${HOST_COMPAT_URL_ENV} must be a different server from the local model.`);
  }
  return base;
}

/**
 * All three required settings together enable the provider. Anything missing or rejected
 * leaves it off so the local default keeps running. The message never includes the key or URL.
 */
export function readHostCompatibleConfig(env: NodeJS.ProcessEnv = process.env): HostCompatibleRead {
  const modelsRaw = env[HOST_COMPAT_MODELS_ENV];
  const urlRaw = env[HOST_COMPAT_URL_ENV];
  const keyRaw = env[HOST_COMPAT_API_KEY_ENV];
  if (blank(modelsRaw) && blank(urlRaw) && blank(keyRaw)) return { ok: false, reason: "unset" };
  try {
    if (blank(modelsRaw) || blank(urlRaw) || blank(keyRaw)) {
      throw new Error(
        `Set ${HOST_COMPAT_MODELS_ENV}, ${HOST_COMPAT_URL_ENV}, and ${HOST_COMPAT_API_KEY_ENV} together.`,
      );
    }
    const modelIds = listIds(modelsRaw);
    if (!modelIds.length)
      throw new Error(`${HOST_COMPAT_MODELS_ENV} must name at least one model.`);
    for (const id of modelIds) {
      const error = modelIdError(id);
      if (error) throw new Error(error);
    }
    const apiKey = keyRaw!.trim();
    if (apiKey.length < MIN_API_KEY_LENGTH) {
      throw new Error(`${HOST_COMPAT_API_KEY_ENV} is too short to use as a bearer token.`);
    }
    assertHeaderSafeApiKey(apiKey);
    const baseUrl = endpointUrl(urlRaw!.trim(), env);
    const known = new Set(modelIds);
    const config: HostCompatibleConfig = {
      modelIds,
      baseUrl,
      apiKey,
      contextWindow: positiveInt(
        HOST_COMPAT_CONTEXT_WINDOW_ENV,
        env[HOST_COMPAT_CONTEXT_WINDOW_ENV],
        DEFAULT_CONTEXT_WINDOW,
      ),
      maxTokens: positiveInt(
        HOST_COMPAT_MAX_TOKENS_ENV,
        env[HOST_COMPAT_MAX_TOKENS_ENV],
        DEFAULT_MAX_TOKENS,
      ),
      visionModelIds: new Set(
        listIds(env[HOST_COMPAT_VISION_MODELS_ENV]).filter((id) => known.has(id)),
      ),
      reasoningModelIds: new Set(
        listIds(env[HOST_COMPAT_REASONING_MODELS_ENV]).filter((id) => known.has(id)),
      ),
    };
    return { ok: true, config };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The server model configuration was rejected.";
    if (!warned) {
      warned = true;
      getLogger().warn("server model configuration was ignored", { reason: message });
    }
    return { ok: false, reason: "invalid", message };
  }
}

export function configuredHostCompatibleModel(
  provider: string | null | undefined,
  modelId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isHostCompatibleProvider(provider) || !modelId) return false;
  const read = readHostCompatibleConfig(env);
  return read.ok && read.config.modelIds.includes(modelId);
}

export function hostCompatibleRunMaterial(
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): { apiKey: string; baseUrl: string; redact: string[] } | undefined {
  const read = readHostCompatibleConfig(env);
  if (!read.ok || !read.config.modelIds.includes(modelId)) return undefined;
  return { apiKey: read.config.apiKey, baseUrl: read.config.baseUrl, redact: [read.config.apiKey] };
}

function hostModel(config: HostCompatibleConfig, id: string): Model<"openai-completions"> {
  const reasoning = config.reasoningModelIds.has(id);
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: HOST_COMPATIBLE_PROVIDER_ID,
    baseUrl: config.baseUrl,
    reasoning,
    compat: reasoning
      ? { supportsDeveloperRole: false, supportsReasoningEffort: true, thinkingFormat: "openai" }
      : { supportsDeveloperRole: false, supportsReasoningEffort: false },
    ...(reasoning ? { thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" } } : {}),
    input: inputModalities(config.visionModelIds.has(id)),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
  };
}

export function hostCompatibleProvider(env: NodeJS.ProcessEnv = process.env): Provider | undefined {
  const read = readHostCompatibleConfig(env);
  if (!read.ok) return undefined;
  const { config } = read;
  return createProvider({
    id: HOST_COMPATIBLE_PROVIDER_ID,
    name: "Host",
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        name: "Server model",
        resolve: async () => ({
          auth: { apiKey: config.apiKey, baseUrl: config.baseUrl },
          source: "server model",
        }),
      },
    },
    models: config.modelIds.map((id) => hostModel(config, id)),
    api: openAICompletionsApi(),
  });
}

export function registerHostCompatibleProvider(
  models: MutableModels,
  env: NodeJS.ProcessEnv = process.env,
): MutableModels {
  const provider = hostCompatibleProvider(env);
  if (provider) models.setProvider(provider);
  return models;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function headerEntries(headers: HeadersInit): Array<[string, string]> {
  if (headers instanceof Headers) return [...headers.entries()];
  if (Array.isArray(headers)) return headers.map(([name, value]) => [name, value]);
  return Object.entries(headers);
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): Array<[string, string]> {
  if (init?.headers !== undefined) return headerEntries(init.headers);
  return input instanceof Request ? headerEntries(input.headers) : [];
}

function bodyText(body: BodyInit | null | undefined): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  return "";
}

function carriesKey(value: string, key: string): boolean {
  return key.length > 0 && value.includes(key);
}

function underBase(target: string, base: string): boolean {
  let targetUrl: URL;
  let baseUrl: URL;
  try {
    targetUrl = new URL(target);
    baseUrl = new URL(base);
  } catch {
    return false;
  }
  if (targetUrl.origin !== baseUrl.origin || targetUrl.search || targetUrl.hash) return false;
  const basePath = baseUrl.pathname.replace(/\/+$/, "") || "/";
  const targetPath = targetUrl.pathname.replace(/\/+$/, "") || "/";
  return targetPath === basePath || targetPath.startsWith(`${basePath}/`);
}

async function assertPublicResolution(hostname: string): Promise<void> {
  const host = normalizeHost(hostname);
  if (isPrivateOpenAiCompatibleHostname(host)) throw new Error(UNRESOLVED_HOST);
  if (ipVersion(host) !== 0) {
    if (isNonPublicAddress(host) || isCloudMetadataAddress(host) || isLinkLocalAddress(host)) {
      throw new Error(UNRESOLVED_HOST);
    }
    return;
  }
  let answers: Array<{ address: string }>;
  try {
    answers = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(UNRESOLVED_HOST);
  }
  if (
    answers.length === 0 ||
    answers.some(
      (entry) =>
        isNonPublicAddress(entry.address) ||
        isCloudMetadataAddress(entry.address) ||
        isLinkLocalAddress(entry.address),
    )
  ) {
    throw new Error(UNRESOLVED_HOST);
  }
}

/**
 * Sends the server key only to its configured public https endpoint. Other requests pass
 * through unchanged, including the local model. An unset provider returns the inner fetch.
 */
export function guardHostCompatibleFetch(
  inner: typeof fetch | undefined,
  env: NodeJS.ProcessEnv = process.env,
): typeof fetch | undefined {
  const read = readHostCompatibleConfig(env);
  if (!read.ok) return inner;
  const { config } = read;
  const base = inner ?? globalThis.fetch;
  return async (input, init) => {
    const url = requestUrl(input);
    const headers = requestHeaders(input, init);
    const authorization = headers
      .filter(([name]) => name.toLowerCase() === "authorization")
      .map(([, value]) => value)
      .join(" ");
    const body = bodyText(init?.body);
    const directed = underBase(url, config.baseUrl);
    if (
      !directed &&
      (carriesKey(url, config.apiKey) ||
        carriesKey(authorization, config.apiKey) ||
        carriesKey(body, config.apiKey))
    ) {
      throw new Error(MISDIRECTED_KEY);
    }
    if (!directed) return base(input, init);
    const parsed = new URL(url);
    assertHttpsForKeyedOpenAiCompatibleUrl(parsed, config.apiKey);
    await assertPublicResolution(parsed.hostname);
    return base(input, { ...init, redirect: "error" });
  };
}
