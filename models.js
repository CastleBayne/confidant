// Models that fit in iPhone Safari's memory budget. Each id is a WebLLM
// prebuilt model; "q4f16_1" ids are swapped for their "q4f32_1" twin on
// devices whose GPU lacks 16-bit float support. `ctx` is the context window
// in tokens: smaller windows use less memory, so the 3B models get less.
export const MODELS = [
  {
    id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    name: "Llama 3.2 (1B)",
    size: "≈0.7 GB download",
    note: "Recommended for iPhone. Fast and light.",
    ctx: 4096,
  },
  {
    id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    name: "Qwen 2.5 (1.5B)",
    size: "≈1 GB download",
    note: "A bit smarter, still light enough for iPhone.",
    ctx: 4096,
  },
  {
    id: "Hermes-3-Llama-3.2-3B-q4f16_1-MLC",
    name: "Hermes 3 (3B)",
    size: "≈1.8 GB download",
    note: "Smartest and most open-minded, but may be too big for Safari on iPhone and crash.",
    ctx: 2048,
  },
  {
    id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    name: "Llama 3.2 (3B)",
    size: "≈1.8 GB download",
    note: "Good all-rounder. May be too big for Safari on iPhone.",
    ctx: 2048,
  },
  {
    id: "Qwen2.5-3B-Instruct-q4f16_1-MLC",
    name: "Qwen 2.5 (3B)",
    size: "≈2 GB download",
    note: "Strong at reasoning. May be too big for Safari on iPhone.",
    ctx: 2048,
  },
];

export const DEFAULT_MODEL = MODELS[0].id;
export const CUSTOM_CTX = 2048;

export function resolveModelId(id, hasF16) {
  return hasF16 ? id : id.replace("q4f16_1", "q4f32_1");
}
