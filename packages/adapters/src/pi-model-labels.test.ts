import { describe, expect, it } from "vitest";
import { parseModelLabelPairs } from "./pi-model-labels.js";

describe("parseModelLabelPairs", () => {
  it("keeps Menu alone and puts Detail after |", () => {
    const known = new Set(["Qwen3.8-Flash-Next", "openai/gpt-6.1-terra"]);
    expect(
      parseModelLabelPairs(
        "Qwen3.8-Flash-Next=千问|A100_千问3.8,openai/gpt-6.1-terra=GPT,skip=no,=bad",
        known,
      ),
    ).toEqual(
      new Map([
        ["Qwen3.8-Flash-Next", { label: "千问", detail: "A100_千问3.8" }],
        ["openai/gpt-6.1-terra", { label: "GPT" }],
      ]),
    );
  });
});
