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
    // A no-cors request succeeds whenever the server answers, even if it
    // refuses this site, which tells "not running" apart from "not allowed".
    let answers = false;
    try {
      await fetch(trimSlash(base), { mode: "no-cors", signal: AbortSignal.timeout(5000) });
      answers = true;
    } catch {}
    return {
      ok: false,
      message: answers
        ? "Ollama is running, but it isn't letting Confidant connect yet. Run the setx OLLAMA_ORIGINS command from the setup steps, then fully quit Ollama (right-click its llama icon → Quit) and open it again. If that doesn't do it, restart the computer."
        : `Can't reach Ollama. Open Ollama from the Start menu, then check that ${trimSlash(base)} shows "Ollama is running" in a browser tab. If it does, the browser may have blocked access: click the icon left of the address bar and allow access to devices on your network.`,
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
    // Plain text continuation (no chat framing): the model just keeps writing
    // the text it's given, which copies the author's style far more closely.
    completions: {
      async create({ prompt, max_tokens, temperature, top_p, frequency_penalty, presence_penalty, stop }) {
        const ac = new AbortController();
        abort = ac;
        const res = await fetch(`${trimSlash(base)}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ac.signal,
          body: JSON.stringify({
            model,
            prompt,
            raw: true,
            stream: true,
            options: { num_ctx: ctx, num_predict: max_tokens, temperature, top_p, frequency_penalty, presence_penalty, stop },
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
                if (msg.response) yield { choices: [{ delta: { content: msg.response } }] };
              }
            }
          } catch (e) {
            if (!ac.signal.aborted) throw e;
          }
        })();
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
