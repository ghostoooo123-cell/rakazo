import { lookup } from "node:dns/promises";
import { once } from "node:events";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { connectedModelChoices } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectConfiguredModel } from "./model-roles.js";
import {
  PINNED_PROVIDER_NOT_CONNECTED,
  pinnedModelCredentialError,
  validateBotModelChange,
  validateConnectedModelChoice,
} from "./model-selection.js";
import {
  guardHostCompatibleFetch,
  hostCompatibleRunMaterial,
  readHostCompatibleConfig,
} from "./pi-host-compatible.js";
import {
  HOST_COMPAT_MODEL_LABELS_ENV,
  HOST_COMPATIBLE_PROVIDER_ID,
} from "./pi-host-compatible-id.js";
import {
  catalogProviderProbeBaseUrl,
  isCatalogProviderBaseUrl,
  listPiCatalog,
} from "./pi-models.js";
import { filterOperatorModelsMenu, OPERATOR_MODELS_ONLY_ENV } from "./pi-operator-models.js";
import { operatorMaxTokens } from "./pi-runtime-limits.js";
import { resolveModelKey } from "./run-model.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]),
}));

const MODEL = "openai/gpt-6.1-terra";
const KEY = "server-key-fixture-9182";
const BASE = "https://models.example.test/v1";
const QWEN = "Qwen3.8-Flash-Next";

const validEnv = {
  RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC: "1",
  RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS: "",
  RAKAZO_LOCAL_MODELS_URL: "http://192.168.0.186:8083/v1",
  RAKAZO_HOST_COMPAT_MODELS: MODEL,
  RAKAZO_HOST_COMPAT_URL: BASE,
  RAKAZO_HOST_COMPAT_API_KEY: KEY,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.mocked(lookup).mockReset();
  vi.mocked(lookup).mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
});

function stub(env: Record<string, string>) {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
}

describe("optional server model configuration", () => {
  it("stays off when unset and ignores a partial or unsafe setting without logging the secret", () => {
    const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
    expect(readHostCompatibleConfig({}).ok).toBe(false);
    expect(warn).not.toHaveBeenCalled();

    const cases: Record<string, string>[] = [
      { RAKAZO_HOST_COMPAT_MODELS: MODEL },
      { ...validEnv, RAKAZO_HOST_COMPAT_API_KEY: "short" },
      { ...validEnv, RAKAZO_HOST_COMPAT_API_KEY: "bad\nkey-value" },
      { ...validEnv, RAKAZO_HOST_COMPAT_URL: "http://models.example.test/v1" },
      { ...validEnv, RAKAZO_HOST_COMPAT_URL: "https://user:pass@models.example.test/v1" },
      { ...validEnv, RAKAZO_HOST_COMPAT_URL: "https://models.example.test/v1?token=1" },
      { ...validEnv, RAKAZO_HOST_COMPAT_URL: "https://169.254.169.254/v1" },
      { ...validEnv, RAKAZO_HOST_COMPAT_URL: "https://10.0.0.8/v1" },
      {
        ...validEnv,
        RAKAZO_HOST_COMPAT_URL: validEnv.RAKAZO_LOCAL_MODELS_URL.replace("http:", "https:"),
      },
      {
        ...validEnv,
        RAKAZO_HOST_COMPAT_URL: "https://models.example.test/v1",
        RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC: "0",
      },
      { ...validEnv, RAKAZO_HOST_COMPAT_MODELS: "has space" },
      { ...validEnv, RAKAZO_HOST_COMPAT_CONTEXT_WINDOW: "0" },
    ];
    // The local collision case needs the same scheme. The https rewrite above uses a private
    // address, which is already rejected. Use one public address for both settings here.
    cases.push({
      ...validEnv,
      RAKAZO_LOCAL_MODELS_URL: BASE,
      RAKAZO_HOST_COMPAT_URL: BASE,
    });

    for (const env of cases) {
      const read = readHostCompatibleConfig(env);
      expect(read.ok).toBe(false);
      if (read.ok) continue;
      expect(read.reason).toBe("invalid");
      expect(read.message ?? "").not.toContain(KEY);
      expect(read.message ?? "").not.toContain("models.example.test");
      expect(read.message ?? "").not.toContain("169.254.169.254");
    }
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("server model configuration was ignored");
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain("models.example.test");
    expect(logged).not.toContain("169.254.169.254");
    warn.mockRestore();
  });

  it("accepts the exact model id and keeps the address off the catalog", () => {
    stub(validEnv);
    const read = readHostCompatibleConfig();
    expect(read).toMatchObject({
      ok: true,
      config: { modelIds: [MODEL], baseUrl: BASE, apiKey: KEY },
    });
    const entries = listPiCatalog().filter(
      (entry) => entry.provider === HOST_COMPATIBLE_PROVIDER_ID,
    );
    expect(entries).toEqual([
      expect.objectContaining({
        provider: HOST_COMPATIBLE_PROVIDER_ID,
        providerName: "",
        id: MODEL,
        label: MODEL,
        images: false,
        reasoning: false,
      }),
    ]);
    expect(entries[0]).not.toHaveProperty("placeholder");
    expect(entries[0]).not.toHaveProperty("catalogProbe");
    const text = JSON.stringify(entries);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("models.example.test");
    expect(catalogProviderProbeBaseUrl(HOST_COMPATIBLE_PROVIDER_ID)).toBeNull();
    expect(isCatalogProviderBaseUrl(HOST_COMPATIBLE_PROVIDER_ID, BASE)).toBe(false);
    expect(
      connectedModelChoices(
        [],
        entries.map((entry) => ({ ...entry, managed: true })),
      ).map((choice) => choice.modelId),
    ).toEqual([MODEL]);
    expect(connectedModelChoices([], entries)).toEqual([]);
  });

  it("shows a short menu label without a Host subtitle and keeps the wire id", () => {
    stub({ ...validEnv, [HOST_COMPAT_MODEL_LABELS_ENV]: `${MODEL}=GPT` });
    const entries = listPiCatalog().filter(
      (entry) => entry.provider === HOST_COMPATIBLE_PROVIDER_ID,
    );
    expect(entries).toEqual([
      expect.objectContaining({
        provider: HOST_COMPATIBLE_PROVIDER_ID,
        providerName: "",
        id: MODEL,
        label: "GPT",
      }),
    ]);
    const choices = connectedModelChoices(
      [],
      entries.map((entry) => ({ ...entry, managed: true })),
    );
    expect(choices).toEqual([
      expect.objectContaining({
        provider: HOST_COMPATIBLE_PROVIDER_ID,
        modelId: MODEL,
        label: "GPT",
        modelLabel: "GPT",
      }),
    ]);
    expect(choices[0]).not.toHaveProperty("providerLabel");
    expect(JSON.stringify(choices)).not.toContain("Host");
    expect(choices[0]?.label).toBe("GPT");
    expect(choices[0]?.modelId).toBe(MODEL);
  });

  it("limits the signed-in menu to local and host-compatible when gated", () => {
    stub({
      ...validEnv,
      RAKAZO_LOCAL_MODELS: QWEN,
      [OPERATOR_MODELS_ONLY_ENV]: "1",
    });
    const catalog = [
      { provider: "openrouter", id: "other" },
      { provider: HOST_COMPATIBLE_PROVIDER_ID, id: MODEL },
      { provider: "local", id: QWEN },
    ];
    expect(filterOperatorModelsMenu(catalog).map((entry) => entry.provider)).toEqual([
      HOST_COMPATIBLE_PROVIDER_ID,
      "local",
    ]);
    expect(filterOperatorModelsMenu(catalog, {})).toEqual(catalog);
  });
});

describe("optional server model selection", () => {
  const qwenDefaults = {
    override: null,
    overrideCredential: null,
    main: null,
    defaults: { deployment: { provider: "local", model: QWEN } },
  };

  it("keeps an empty bot on local Qwen and lets a bot choose the server model without a personal key", () => {
    stub(validEnv);
    expect(selectConfiguredModel(qwenDefaults)).toMatchObject({
      provider: "local",
      id: QWEN,
      credential: null,
    });
    expect(
      selectConfiguredModel({
        ...qwenDefaults,
        override: {
          modelProvider: HOST_COMPATIBLE_PROVIDER_ID,
          modelId: MODEL,
          thinkingLevel: null,
        },
      }),
    ).toMatchObject({ provider: HOST_COMPATIBLE_PROVIDER_ID, id: MODEL, credential: null });
    const own = {
      id: "own",
      userId: "user-1",
      provider: "openrouter",
      label: "own",
      secretId: "secret-own",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      defaultModel: "own-model",
      thinkingLevel: null,
    };
    expect(
      selectConfiguredModel({
        ...qwenDefaults,
        override: { modelProvider: "openrouter", modelId: "own-model", thinkingLevel: null },
        overrideCredential: own,
      }),
    ).toMatchObject({ provider: "openrouter", id: "own-model", credential: own });
    expect(
      pinnedModelCredentialError(
        { modelProvider: HOST_COMPATIBLE_PROVIDER_ID, modelId: MODEL, thinkingLevel: null },
        null,
      ),
    ).toBeUndefined();
    expect(
      pinnedModelCredentialError(
        { modelProvider: "openrouter", modelId: "own-model", thinkingLevel: null },
        null,
      ),
    ).toBe(PINNED_PROVIDER_NOT_CONNECTED);
  });

  it("saves the server model without a credential and still rejects an unconnected provider", async () => {
    stub(validEnv);
    const prisma = {
      userModelCredential: { findFirst: async () => null, findMany: async () => [] },
      userModelPreference: { findFirst: async () => null, findMany: async () => [] },
      secret: { findFirst: async () => null },
    } as unknown as PrismaClient;
    const secretStore = { load: vi.fn(async () => "personal-secret") };
    const deps = {
      prisma,
      secretStore,
      refreshExpiredCredential: vi.fn(),
      defaultModel: async () => ({ provider: "local", model: QWEN }),
    };
    await expect(
      validateBotModelChange(deps, {
        userId: "user-1",
        spaceId: "space-1",
        provider: HOST_COMPATIBLE_PROVIDER_ID,
        model: MODEL,
        current: { provider: "local", model: QWEN },
      }),
    ).resolves.toMatchObject({ ok: true, provider: HOST_COMPATIBLE_PROVIDER_ID, model: MODEL });
    await expect(
      validateBotModelChange(deps, {
        userId: "user-1",
        spaceId: "space-1",
        provider: "openrouter",
        model: "own-model",
        current: { provider: "local", model: QWEN },
      }),
    ).resolves.toMatchObject({ ok: false, error: PINNED_PROVIDER_NOT_CONNECTED });
    await expect(
      validateConnectedModelChoice(
        prisma,
        secretStore,
        { userId: "user-1", spaceId: "space-1" },
        HOST_COMPATIBLE_PROVIDER_ID,
        MODEL,
      ),
    ).resolves.toBeUndefined();
    expect(secretStore.load).not.toHaveBeenCalled();
  });

  it("resolves the server key without reading a personal secret", async () => {
    stub(validEnv);
    const load = vi.fn(async () => {
      throw new Error("personal secret loaded");
    });
    const resolved = await resolveModelKey(
      { billingEnabled: false, prisma: {} as never, secretStore: { load } } as never,
      "user-1",
      "space-1",
      { id: "cred", secretId: "secret", provider: HOST_COMPATIBLE_PROVIDER_ID },
      HOST_COMPATIBLE_PROVIDER_ID,
      MODEL,
    );
    expect(load).not.toHaveBeenCalled();
    expect(resolved).toMatchObject({
      apiKey: KEY,
      baseUrl: BASE,
      redact: [KEY],
      callObserver: undefined,
    });
    expect(hostCompatibleRunMaterial("missing-model")).toBeUndefined();
    await expect(
      resolveModelKey(
        { billingEnabled: false, prisma: {} as never, secretStore: { load } } as never,
        "user-1",
        "space-1",
        null,
        HOST_COMPATIBLE_PROVIDER_ID,
        "missing-model",
      ),
    ).rejects.toThrow("Unknown model for that provider");
    expect(load).not.toHaveBeenCalled();
  });

  it("uses the operator output cap only when it is set", () => {
    vi.stubEnv("RAKAZO_LOCAL_MAX_TOKENS", "");
    vi.stubEnv("RAKAZO_HOST_COMPAT_MAX_TOKENS", "");
    expect(
      operatorMaxTokens({ provider: HOST_COMPATIBLE_PROVIDER_ID, maxTokens: 2048 }),
    ).toBeUndefined();
    vi.stubEnv("RAKAZO_HOST_COMPAT_MAX_TOKENS", "2048");
    expect(operatorMaxTokens({ provider: HOST_COMPATIBLE_PROVIDER_ID, maxTokens: 2048 })).toBe(
      2048,
    );
    expect(operatorMaxTokens({ provider: "local", maxTokens: 1024 })).toBeUndefined();
  });
});

describe("optional server model requests", () => {
  it("refuses to send the key anywhere else, including a private address", async () => {
    stub(validEnv);
    const inner = vi.fn<typeof fetch>(async () => new Response("no"));
    const guarded = guardHostCompatibleFetch(inner);
    if (!guarded) throw new Error("guard missing");
    await expect(
      guarded("https://other.example/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: MODEL }),
      }),
    ).rejects.toThrow("The server model key cannot be sent to a different address.");
    expect(inner).not.toHaveBeenCalled();

    vi.mocked(lookup).mockResolvedValueOnce([{ address: "10.1.2.3", family: 4 }] as never);
    await expect(
      guarded(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}` },
      }),
    ).rejects.toThrow("The server model address could not be verified.");
    expect(inner).not.toHaveBeenCalled();

    const passed = await guarded("http://192.168.0.186:8083/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer local" },
      body: JSON.stringify({ model: QWEN }),
    }).catch((error: unknown) => error);
    expect(passed).toBeInstanceOf(Response);
    expect(inner).toHaveBeenCalledTimes(1);
    const forwarded = inner.mock.calls[0]?.[1];
    expect(JSON.stringify(forwarded)).not.toContain(KEY);
  });

  it("calls the configured model and accepts a different response model id", async () => {
    stub(validEnv);
    vi.resetModules();
    const { PiAgentRuntime } = await import("./pi-runtime.js");
    let captured:
      | { url: string; authorization: string; body: { model?: string; reasoning_effort?: string } }
      | undefined;
    const runtime = new PiAgentRuntime({
      modelFetch: async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const headers = new Headers(init?.headers);
        captured = {
          url,
          authorization: headers.get("authorization") ?? "",
          body: JSON.parse(String(init?.body)) as { model?: string; reasoning_effort?: string },
        };
        expect(init?.redirect).toBe("error");
        return new Response(
          `data: ${JSON.stringify({
            id: "fixture",
            model: "upstream-alias",
            choices: [
              { index: 0, delta: { role: "assistant", content: "Ready" }, finish_reason: "stop" },
            ],
          })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const events = [];
    for await (const event of runtime.run(
      {
        botId: "bot-fixture",
        threadId: "thread-fixture",
        runId: "run-host-compat",
        prompt: "Continue",
        instructions: "Answer briefly.",
        history: [],
        tools: [],
        model: { provider: HOST_COMPATIBLE_PROVIDER_ID, id: MODEL, apiKey: KEY },
      },
      { signal: AbortSignal.timeout(15_000) },
    )) {
      events.push(event);
    }
    expect(events).toContainEqual(expect.objectContaining({ type: "done", text: "Ready" }));
    expect(captured?.url.startsWith(`${BASE}/`)).toBe(true);
    expect(captured?.authorization).toBe(`Bearer ${KEY}`);
    expect(captured?.body.model).toBe(MODEL);
    expect(captured?.body.reasoning_effort).toBeUndefined();
    expect(captured?.url).not.toContain(KEY);
  }, 20_000);

  it("keeps the local Qwen request free of the server key", async () => {
    stub({
      ...validEnv,
      RAKAZO_LOCAL_MODELS: QWEN,
      RAKAZO_LOCAL_CONTEXT_WINDOW: "32768",
      RAKAZO_LOCAL_MAX_TOKENS: "1024",
    });
    vi.resetModules();
    const { PiAgentRuntime } = await import("./pi-runtime.js");
    const requests: Array<{ authorization: string; body: string }> = [];
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push({
          authorization: request.headers.authorization ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Ready" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        );
      })().catch(() => response.destroy());
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
    vi.stubEnv("RAKAZO_LOCAL_MODELS_URL", `http://127.0.0.1:${address.port}/v1`);
    try {
      const events = [];
      for await (const event of new PiAgentRuntime().run(
        {
          botId: "bot-fixture",
          threadId: "thread-fixture",
          runId: "run-local-beside-host",
          prompt: "Continue",
          instructions: "Answer briefly.",
          history: [],
          tools: [],
          model: { provider: "local", id: QWEN },
        },
        { signal: AbortSignal.timeout(15_000) },
      )) {
        events.push(event);
      }
      expect(events).toContainEqual(expect.objectContaining({ type: "done", text: "Ready" }));
      expect(requests).toHaveLength(1);
      expect(requests[0]?.authorization).not.toContain(KEY);
      expect(requests[0]?.body).not.toContain(KEY);
      expect(requests[0]?.body).toContain(QWEN);
    } finally {
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    }
  }, 20_000);
});

describe("optional server model exposure", () => {
  it("keeps the key out of the web source and does not read another provider's key", () => {
    const root = path.resolve(import.meta.dirname, "../../..");
    const web = path.join(root, "apps/web/src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        if (statSync(file).isDirectory()) walk(file);
        else files.push(file);
      }
    };
    walk(web);
    const webText = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(webText).not.toContain("RAKAZO_HOST_COMPAT_API_KEY");
    const provider = readFileSync(path.join(import.meta.dirname, "pi-host-compatible.ts"), "utf8");
    expect(provider).not.toContain("XAI_API_KEY");
    expect(provider).not.toContain("OPENROUTER_API_KEY");
  });
});
