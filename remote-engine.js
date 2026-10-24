// Uses a model running in Ollama on the user's own computer. Same small
// interface as the on-device engines, so chat and the book writer don't care
// where the model runs.

const trimSlash = (url) => url.replace(/\/+$/, "");

// Checks Ollama is reachable and has the model. Returns { ok, message, models }.
export async function checkComputer(base, model) {
  let res;
  try {
    res = await fetch(`${trimSlash(base)}/api/tags`, { signal: AbortSignal.timeout(5000) });
  } catch {
    return {
      ok: false,
      message: "Can't reach Ollama. Make sure it's running on the computer (its llama icon is in the taskbar tray) and that OLLAMA_ORIGINS is set as described in the setup steps, then restart Ollama.",
    };
  }
  if (!res.ok) return { ok: false, message: `Ollama answered with an error (${res.status}).` };
  const models = ((await res.json()).models ?? []).map((m) => m.name);
  const has = models.some((name) => name === model || name === `${model}:latest`);
  if (!has) {
    return {
      ok: false,
      models,
      message: models.length
        ? `Connected, but "${model}" isn't downloaded on the computer. Downloaded models: ${models.join(", ")}.`
        : `Connected, but no models are downloaded on the computer yet. Run: ollama pull ${model}`,
    };
  }
  return { ok: true, models, message: `Connected. ${model} is ready.` };
}

export async function createRemoteEngine({ base, model, ctx }) {
  const status = await checkComputer(base, model);
  if (!status.ok) throw new Error(status.message);

  let abort = null;
  return {
    chat: {
      completions: {
        // OpenAI-style options in, Ollama's /api/chat out (it lets us set the context size).
        async create({ messages, max_tokens, temperature, top_p, frequency_penalty, presence_penalty }) {
          const ac = new AbortController();
          abort = ac;
          const res = await fetch(`${trimSlash(base)}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: ac.signal,
            body: JSON.stringify({
              model,
              messages,
              stream: true,
              options: {
                num_ctx: ctx,
                num_predict: max_tokens,
                temperature,
                top_p,
                frequency_penalty,
                presence_penalty,
              },
            }),
          });
          if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          return (async function* () {
            let buffered = "";
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffered += decoder.decode(value, { stream: true });
                const lines = buffered.split("\n");
                buffered = lines.pop();
                for (const line of lines) {
                  if (!line.trim()) continue;
                  const msg = JSON.parse(line);
                  if (msg.error) throw new Error(msg.error);
                  if (msg.message?.content) yield { choices: [{ delta: { content: msg.message.content } }] };
                }
              }
            } catch (e) {
              // Stop button: end the reply quietly.
              if (!ac.signal.aborted) throw e;
            }
          })();
        },
      },
    },
    interruptGenerate() {
      abort?.abort();
    },
    async unload() {
      abort?.abort();
    },
  };
}
