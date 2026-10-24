// Models that fit in iPhone Safari's memory budget. Each id is a WebLLM
// prebuilt model; "q4f16_1" ids are swapped for their "q4f32_1" twin on
// devices whose GPU lacks 16-bit float support. `ctx` is the context window
// in tokens: smaller windows use less memory, so the 3B models get less.
// Models with a `url` are hosted on this site rather than WebLLM's list.
export const MODELS = [
  {
    id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    name: "Llama 3.2 (1B)",
    size: "≈0.7 GB download",
    note: "Fast and light, but refuses most adult topics.",
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
    note: "Best for adult writing: the most open-minded. Needs a recent iPhone (works on iPhone 16).",
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
  const hosted = MODELS.find((m) => m.id === id)?.url;
  return hasF16 || hosted ? id : id.replace("q4f16_1", "q4f32_1");
}

// WebLLM model records for the models this site hosts itself.
export function hostedRecords() {
  return MODELS.filter((m) => m.url).map((m) => ({
    model: new URL(m.url, location.href).href,
    model_id: m.id,
    model_lib: m.lib,
    low_resource_required: true,
    overrides: { context_window_size: m.ctx },
  }));
}
