// Models that fit in iPhone Safari's memory budget. Each id is a WebLLM
// prebuilt model; "q4f16_1" ids are swapped for their "q4f32_1" twin on
// devices whose GPU lacks 16-bit float support.
export const MODELS = [
  {
    id: "Hermes-3-Llama-3.2-3B-q4f16_1-MLC",
    name: "Hermes 3 (3B)",
    size: "≈1.8 GB download",
    note: "Recommended. Follows your persona closely and is the most open-minded.",
  },
  {
    id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    name: "Llama 3.2 (3B)",
    size: "≈1.8 GB download",
    note: "Good all-rounder, a bit more cautious.",
  },
  {
    id: "Qwen2.5-3B-Instruct-q4f16_1-MLC",
    name: "Qwen 2.5 (3B)",
    size: "≈2 GB download",
    note: "Strong at reasoning and advice.",
  },
  {
    id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    name: "Llama 3.2 (1B)",
    size: "≈0.7 GB download",
    note: "Fast and light. Use this if the bigger ones crash.",
  },
  {
    id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    name: "Qwen 2.5 (1.5B)",
    size: "≈1 GB download",
    note: "Fast and light alternative.",
  },
];

export const DEFAULT_MODEL = MODELS[0].id;

export function resolveModelId(id, hasF16) {
  return hasF16 ? id : id.replace("q4f16_1", "q4f32_1");
}
