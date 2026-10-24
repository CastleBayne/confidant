// Runs GGUF models (the format most uncensored models are published in)
// through wllama, llama.cpp compiled to WebAssembly, on the phone's GPU.
// Exposes the same small interface the app uses for WebLLM engines.

const abs = (path) => new URL(path, import.meta.url).href;
const FILE_KEY = "confidant-gguf-file:"; // repo -> resolved .gguf URL, for offline starts
const DONE_KEY = "confidant-gguf-ready:"; // model id -> downloaded

const quiet = { debug() {}, log() {}, warn() {}, error: (...a) => console.error(...a) };

// Loaded on demand so app startup doesn't pay for the engine.
async function newWllama() {
  const { Wllama } = await import("./vendor/wllama/index.js");
  const w = new Wllama({ default: abs("vendor/wllama/wllama.wasm") }, { logger: quiet, allowOffline: true });
  // Safari lacks JSPI/Memory64, so wllama uses its compat build there; serve it locally.
  w.setCompat({ worker: abs("vendor/wllama/compat/wllama.js"), wasm: abs("vendor/wllama/compat/wllama.wasm") });
  return w;
}

function remember(key, value) {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch {}
}

function recall(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

export const isGgufDownloaded = (model) => recall(DONE_KEY + model.id) === "1";

async function hfJson(path) {
  const res = await fetch(`https://huggingface.co/api/${path}`);
  return res.ok ? res.json() : null;
}

// The Q4_K_M .gguf in a public repo, or null if the repo is missing or gated.
async function q4File(repo) {
  const info = await hfJson(`models/${repo}`);
  if (!info || info.gated || info.private) return null;
  const files = (info.siblings ?? []).map((s) => s.rfilename).filter((f) => f.endsWith(".gguf"));
  return files.find((f) => /q4_k_m/i.test(f)) ?? null;
}

// Uploads on Hugging Face get renamed, gated or removed, so try the known
// repos first, then fall back to searching for the most-downloaded match.
async function resolveFile(model) {
  const known = recall(FILE_KEY + model.id);
  if (known) return known;
  const tried = new Set();
  const tryRepo = async (repo) => {
    if (tried.has(repo)) return null;
    tried.add(repo);
    const file = await q4File(repo);
    return file ? `https://huggingface.co/${repo}/resolve/main/${file}` : null;
  };
  let url = null;
  for (const repo of model.repos) if ((url = await tryRepo(repo))) break;
  if (!url) {
    const found = await hfJson(`models?search=${encodeURIComponent(model.search)}&filter=gguf&sort=downloads&direction=-1&limit=15`);
    for (const m of found ?? []) if ((url = await tryRepo(m.id))) break;
  }
  if (!url) throw new Error(`Couldn't find a downloadable copy of ${model.name} on Hugging Face. Check your internet connection and try again.`);
  remember(FILE_KEY + model.id, url);
  return url;
}

export async function createGgufEngine(model, { ctx, onProgress }) {
  const w = await newWllama();
  const url = await resolveFile(model);
  await w.loadModelFromUrl(url, {
    n_ctx: ctx,
    useCache: true,
    progressCallback: ({ loaded, total }) => onProgress?.(total ? loaded / total : 0, loaded, total),
  });
  remember(DONE_KEY + model.id, "1");

  let abort = null;
  return {
    chat: {
      completions: {
        // Accepts OpenAI-style options (as WebLLM does) and maps them to llama.cpp's.
        async create({ messages, max_tokens, temperature, top_p, frequency_penalty, presence_penalty }) {
          const ac = new AbortController();
          abort = ac;
          const stream = await w.createChatCompletion({
            messages,
            stream: true,
            max_tokens,
            temperature,
            top_p,
            penalty_freq: frequency_penalty,
            penalty_present: presence_penalty,
            abortSignal: ac.signal,
          });
          return (async function* () {
            try {
              for await (const chunk of stream) yield chunk;
            } catch (e) {
              // Stop button: end the reply quietly instead of reporting an error.
              if (e?.name !== "AbortError" && !ac.signal.aborted) throw e;
            }
          })();
        },
      },
    },
    interruptGenerate() {
      abort?.abort();
    },
    async unload() {
      await w.exit();
    },
  };
}

export async function deleteGgufModels(models) {
  for (const m of models) remember(DONE_KEY + m.id, null);
  await (await newWllama()).cacheManager.clear();
}
