// Models that fit in iPhone Safari's memory budget. Each id is a WebLLM
// prebuilt model; "q4f16_1" ids are swapped for their "q4f32_1" twin on
// devices whose GPU lacks 16-bit float support. `ctx` is the context window
// in tokens: smaller windows use less memory, so the 3B models get less.
// Models with a `url` are hosted on this site rather than WebLLM's list.
// Models with `engine: "gguf"` run through wllama (llama.cpp) instead of
// WebLLM, which opens up GGUF files, the format uncensored models ship in.
export const MODELS = [
  {
    id: "gguf:llama-3.2-1b-abliterated",
    engine: "gguf",
    // Verified public on Hugging Face; the app searches if all of these vanish.
    repos: [
      "mradermacher/Llama-3.2-1B-Instruct-abliterated-GGUF",
      "RichardErkhov/huihui-ai_-_Llama-3.2-1B-Instruct-abliterated-gguf",
      "ElectricLMA/Abliterated-Llama-3.2-1B-Instruct-Q4_K_M-GGUF",
    ],
    search: "Llama-3.2-1B-Instruct-abliterated",
    name: "Uncensored Llama 3.2 (1B)",
    size: "≈0.8 GB download",
    note: "No refusals: handles explicit scenes. Light and safe for iPhone, but writing is simpler.",
    ctx: 4096,
  },
  {
    id: "gguf:hermes-3-3b-abliterated",
    engine: "gguf",
    repos: ["mradermacher/Hermes-3-Llama-3.2-3B-abliterated-GGUF"],
    search: "Hermes-3-Llama-3.2-3B-abliterated",
    name: "Uncensored Hermes 3 (3B)",
    size: "≈2 GB download",
    note: "Hermes 3 with refusals removed: the best writer here. Slower, and may be too big for Safari. Try after the 1B works.",
    ctx: 2048,
  },
  {
    id: "gguf:llama-3.2-3b-abliterated",
    engine: "gguf",
    repos: [
      "QuantFactory/Llama-3.2-3B-Instruct-abliterated-GGUF",
      "mradermacher/Llama-3.2-3B-Instruct-abliterated-GGUF",
      "MaziyarPanahi/Llama-3.2-3B-Instruct-abliterated-GGUF",
    ],
    search: "Llama-3.2-3B-Instruct-abliterated",
    name: "Uncensored Llama 3.2 (3B)",
    size: "≈2 GB download",
    note: "No refusals, better writing than the 1B. Slower, and may be too big for Safari.",
    ctx: 2048,
  },
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

export const DEFAULT_MODEL = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
export const CUSTOM_CTX = 2048;

export function resolveModelId(id, hasF16) {
  const m = MODELS.find((x) => x.id === id);
  return hasF16 || m?.url || m?.engine === "gguf" ? id : id.replace("q4f16_1", "q4f32_1");
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
