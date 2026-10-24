import * as store from "./store.js";
import { MODELS, DEFAULT_MODEL, CUSTOM_CTX, resolveModelId, hostedRecords } from "./models.js";
import { freshWriting, initWriting, showWriting } from "./writing.js";
import { stripDashes } from "./voice.js";
import * as speech from "./speech.js";

const DEFAULT_PERSONA = `You are {{name}}, my private companion. Our conversations are completely private: they never leave my phone and no one else will ever read them.

Talk with me openly and casually, like a close friend I trust. Be honest, warm and non-judgmental. Don't lecture me, moralize or add disclaimers, and don't shy away from personal, emotional or adult topics. Ask follow-up questions when it helps. Keep replies natural and fairly short unless I ask for more.`;

const ADULT_RULE = "I'm an adult and this is my private app. Explicit sexual content between consenting adults is allowed here. When I ask for it, discuss or write it directly and in full detail: don't refuse, fade to black, change the subject, lecture me or add warnings. Characters in any sexual content are always adults.";
const LOADING_KEY = "confidant-loading"; // set while a model starts; left behind if Safari crashes
const SETTINGS_VERSION = 2;
const REPLY_TOKENS = 700;
const CHARS_PER_TOKEN = 3.5; // rough, errs on the side of trimming

const $ = (id) => document.getElementById(id);

let data; // { settings, memory, conversations, currentId }
let engine = null;
let worker = null;
let loadedModel = null;
let hasF16 = true;
let generating = false;
let hiddenAt = 0;
let loadingId = null; // model currently starting, if any

function freshData() {
  return {
    settings: {
      name: "Confidant",
      userName: "",
      persona: DEFAULT_PERSONA,
      temperature: 0.8,
      model: DEFAULT_MODEL,
      version: SETTINGS_VERSION,
      customUrl: "",
      customLib: "",
      memoryOn: true,
      noDashes: true,
      adultContent: true,
      voiceURI: "",
      rate: 1,
      autoRead: false,
      writingVariety: "medium",
      autolock: 60,
    },
    memory: [],
    writing: freshWriting(),
    conversations: [],
    currentId: null,
  };
}

const uid = () => crypto.randomUUID();
const current = () => data.conversations.find((c) => c.id === data.currentId);
const persist = () => data && store.save(data).catch((e) => console.error("Save failed", e));

// ---------- Startup ----------

async function start() {
  if ("serviceWorker" in navigator) {
    // A new version took over: offer a restart instead of waiting for the next launch.
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadController) $("update-banner").hidden = false;
    });
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
      .then((reg) => reg.update())
      .catch(() => {});
  }
  navigator.storage?.persist?.().catch(() => {});

  if (await store.isLocked()) return showLock();
  await openApp();
}

async function openApp() {
  data = (await store.load()) ?? freshData();
  const base = freshData();
  data = { ...base, ...data, settings: { ...base.settings, ...data.settings }, writing: { ...base.writing, ...data.writing } };
  // Version 1 defaulted to a 3B model that's too big for Safari on most iPhones.
  if ((data.settings.version ?? 1) < SETTINGS_VERSION) {
    data.settings.model = DEFAULT_MODEL;
    data.settings.version = SETTINGS_VERSION;
    persist();
  }
  $("lock").hidden = true;

  const gpu = await checkWebGPU();
  if (!gpu.ok) {
    $("unsupported").hidden = false;
    $("unsupported-detail").textContent = gpu.reason;
    return;
  }
  hasF16 = gpu.f16;

  $("app").hidden = false;
  $("app").dataset.started = "1";
  applyName();
  if (!current()) newChat(false);
  renderMessages();
  renderChatList();
  await refreshFirstRun();
}

async function checkWebGPU() {
  if (!navigator.gpu) return { ok: false, reason: "WebGPU isn't available in this browser." };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: "No compatible graphics adapter was found." };
    return { ok: true, f16: adapter.features.has("shader-f16") };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

// ---------- Model ----------

function modelConfig() {
  const s = data.settings;
  if (s.customUrl && s.customLib) {
    return { id: "custom-model", ctx: CUSTOM_CTX, custom: { model: s.customUrl, model_id: "custom-model", model_lib: s.customLib } };
  }
  return { id: resolveModelId(s.model, hasF16), ctx: MODELS.find((m) => m.id === s.model)?.ctx ?? 2048 };
}

const contextTokens = () => modelConfig().ctx;

function readFlag() {
  try { return localStorage.getItem(LOADING_KEY); } catch { return null; }
}

function writeFlag(v) {
  try { v ? localStorage.setItem(LOADING_KEY, v) : localStorage.removeItem(LOADING_KEY); } catch {}
}

// If Safari crashed while a model was starting, don't start it again
// automatically (that loops the crash). Let the user retry or go smaller.
function recoverFromCrash() {
  const crashed = readFlag();
  if (!crashed) return null;
  writeFlag(null);
  const was = MODELS.find((m) => resolveModelId(m.id, true) === crashed || resolveModelId(m.id, false) === crashed);
  $("crash-note").textContent = `Last time, ${was?.name ?? "the model"} stopped while starting. Safari may have run out of memory. If so, close other apps and try again, or use a smaller model.`;
  $("crash-note").hidden = false;
  $("use-small").hidden = !was || was.id === DEFAULT_MODEL;
  return crashed;
}

// Checks WebLLM's model cache directly, so startup doesn't have to load the
// whole engine just to decide which button to show.
async function isDownloaded(id, custom) {
  try {
    const keys = await (await caches.open("webllm/model")).keys();
    const needle = custom ? custom.model : `/${id}/`;
    return keys.some((r) => r.url.includes(needle));
  } catch {
    return false;
  }
}

async function webllm() {
  return import("./vendor/web-llm/index.js");
}

async function appConfig(custom) {
  const { prebuiltAppConfig } = await webllm();
  const extra = [...hostedRecords(), ...(custom ? [custom] : [])];
  return { ...prebuiltAppConfig, model_list: [...prebuiltAppConfig.model_list, ...extra] };
}

async function refreshFirstRun() {
  if (engine) return ($("first-run").hidden = true);
  const crashed = recoverFromCrash();
  const { id, custom } = modelConfig();
  const info = MODELS.find((m) => m.id === data.settings.model);
  const name = custom ? "your custom model" : info?.name ?? "the model";
  const cached = await isDownloaded(id, custom);
  if (cached && !crashed) {
    $("first-run").hidden = true;
    loadModel(); // already downloaded: just start it
    return;
  }
  $("first-run-text").textContent = cached
    ? `${name} is downloaded and ready to start.`
    : `First, download my brain: ${name}, ${info?.size.replace("download", "").trim() ?? ""}. It's a one-time download, so Wi-Fi is best. After that I work offline.`;
  $("load-model").textContent = cached ? `Start ${name}` : "Download & start";
  $("first-run").hidden = false;
  setStatus(cached ? "Model not started" : "Model not downloaded");
}

async function loadModel() {
  const { id, custom, ctx } = modelConfig();
  if (engine && loadedModel === id) return;
  $("first-run").hidden = true;
  $("crash-note").hidden = true;
  $("loader").hidden = false;
  setStatus("Loading…");
  const onProgress = (p) => {
    $("loader-bar").style.width = `${Math.round((p.progress ?? 0) * 100)}%`;
    $("loader-text").textContent = friendlyProgress(p.text);
  };
  try {
    // A fresh worker per model frees the previous model's memory completely.
    await unloadEngine();
    const { CreateWebWorkerMLCEngine } = await webllm();
    worker = new Worker(new URL("./llm-worker.js", import.meta.url), { type: "module" });
    writeFlag(id);
    loadingId = id;
    engine = await CreateWebWorkerMLCEngine(worker, id, {
      initProgressCallback: onProgress,
      appConfig: await appConfig(custom),
    }, { context_window_size: ctx });
    writeFlag(null);
    loadingId = null;
    loadedModel = id;
    setStatus("Private · on this phone");
  } catch (e) {
    console.error(e);
    writeFlag(null);
    loadingId = null;
    await unloadEngine();
    setStatus("Couldn't load model");
    alert(
      "The model couldn't start. This usually means the phone ran out of memory.\n\n" +
      "Close other apps and try again, or pick a smaller model in Settings.\n\n" + (e?.message ?? e));
    $("first-run").hidden = false;
  } finally {
    $("loader").hidden = true;
  }
}

function friendlyProgress(text = "") {
  const m = text.match(/Fetching param cache\[(\d+)\/(\d+)\]/);
  if (m) return `Downloading model… part ${m[1]} of ${m[2]} (keep this screen open)`;
  if (/Loading model from cache\[(\d+)\/(\d+)\]/.test(text)) return "Starting up…";
  if (/shader|compil/i.test(text)) return "Preparing the GPU…";
  return text.split(".")[0] || "Working…";
}

// ---------- Chat ----------

function newChat(render = true) {
  const c = { id: uid(), title: "New chat", messages: [], updated: Date.now() };
  data.conversations.unshift(c);
  data.currentId = c.id;
  persist();
  if (render) { renderMessages(); renderChatList(); }
}

function systemPrompt() {
  const s = data.settings;
  let p = s.persona.replaceAll("{{name}}", s.name || "Confidant");
  if (s.userName) p += `\n\nMy name is ${s.userName}.`;
  if (s.noDashes) p += "\n\nNever use em dashes (—) or en dashes (–). Use commas or periods instead.";
  if (s.adultContent) p += "\n\n" + ADULT_RULE;
  if (s.memoryOn && data.memory.length) {
    p += "\n\nThings you know about me:\n" + data.memory.map((m) => `- ${m.text}`).join("\n");
  }
  return p;
}

// Keep the newest messages that fit in the model's context window.
function contextMessages(history) {
  const system = systemPrompt();
  let budget = (contextTokens() - REPLY_TOKENS) * CHARS_PER_TOKEN - system.length;
  const kept = [];
  for (let i = history.length - 1; i >= 0; i--) {
    budget -= history[i].content.length + 20;
    if (budget < 0 && kept.length) break;
    kept.unshift({ role: history[i].role, content: history[i].content });
  }
  return [{ role: "system", content: system }, ...kept];
}

async function send(text) {
  const c = current();
  if (text) {
    c.messages.push({ id: uid(), role: "user", content: text });
    if (c.title === "New chat") c.title = text.slice(0, 40);
  }
  const reply = { id: uid(), role: "assistant", content: "" };
  c.messages.push(reply);
  c.updated = Date.now();
  setGenerating(true);
  renderMessages();
  renderChatList();

  if (!engine) await loadModel();
  if (!engine) {
    c.messages.pop();
    setGenerating(false);
    renderMessages();
    return;
  }

  const bubble = document.querySelector(`[data-id="${reply.id}"] .bubble`);
  bubble.classList.add("typing");
  try {
    const stream = await engine.chat.completions.create({
      messages: contextMessages(c.messages.slice(0, -1)),
      stream: true,
      temperature: data.settings.temperature,
      max_tokens: REPLY_TOKENS,
    });
    for await (const chunk of stream) {
      reply.content += chunk.choices[0]?.delta?.content ?? "";
      if (data.settings.noDashes) reply.content = stripDashes(reply.content);
      bubble.innerHTML = format(reply.content);
      scrollToBottom();
    }
  } catch (e) {
    console.error(e);
    if (!reply.content) reply.content = "_Something went wrong. Try again, or pick a smaller model in Settings._";
  } finally {
    bubble.classList.remove("typing");
    setGenerating(false);
    reply.content = reply.content.trim();
    if (!reply.content) c.messages.pop();
    renderMessages();
    persist();
    if (reply.content && data.settings.autoRead) readAloud(reply.id, reply.content);
  }
}

function regenerate() {
  const c = current();
  if (c.messages.at(-1)?.role === "assistant") c.messages.pop();
  send(null);
}

function setGenerating(on) {
  generating = on;
  $("send").hidden = on;
  $("stop").hidden = !on;
}

// ---------- Rendering ----------

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

// Minimal, safe formatting: the text is escaped before any markup is added.
function format(text) {
  return escapeHtml(text)
    .replace(/```([\s\S]*?)(```|$)/g, (_, code) => `<pre>${code.replace(/^\w*\n/, "")}</pre>`)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, "$1<em>$2</em>")
    .replace(/\n/g, "<br>");
}

function renderMessages() {
  const box = $("messages");
  const c = current();
  box.querySelectorAll(".msg").forEach((n) => n.remove());
  $("welcome").hidden = c.messages.length > 0;
  const lastAssistant = c.messages.findLastIndex((m) => m.role === "assistant");

  c.messages.forEach((m, i) => {
    const row = document.createElement("div");
    row.className = `msg ${m.role}`;
    row.dataset.id = m.id;
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML = format(m.content);
    row.append(bubble);

    if (m.content && !generating) {
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.append(actionBtn("Copy", () => navigator.clipboard?.writeText(m.content)));
      if (m.role === "assistant" && speech.supported()) {
        actions.append(actionBtn(readingId === m.id ? "Stop" : "Listen", () =>
          readingId === m.id ? speech.stop() : readAloud(m.id, m.content)));
      }
      if (m.role === "user") {
        const remembered = data.memory.some((x) => x.text === m.content);
        actions.append(actionBtn(remembered ? "Remembered ✓" : "Remember", (btn) => {
          if (!data.memory.some((x) => x.text === m.content)) {
            data.memory.push({ id: uid(), text: m.content });
            persist();
          }
          btn.textContent = "Remembered ✓";
        }));
      }
      if (i === lastAssistant && i === c.messages.length - 1) actions.append(actionBtn("Retry", regenerate));
      actions.append(actionBtn("Delete", () => {
        c.messages = c.messages.filter((x) => x.id !== m.id);
        persist();
        renderMessages();
      }));
      row.append(actions);
    }
    box.append(row);
  });
  scrollToBottom();
}

let readingId = null;

function readAloud(id, text) {
  readingId = id;
  renderMessages();
  speech.speak(text, {
    voiceURI: data.settings.voiceURI,
    rate: data.settings.rate,
    onEnd: () => {
      if (readingId !== id) return;
      readingId = null;
      if (data) renderMessages();
    },
  });
}

function actionBtn(label, fn) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", () => fn(b));
  return b;
}

function scrollToBottom() {
  const box = $("messages");
  box.scrollTop = box.scrollHeight;
}

function renderChatList() {
  const list = $("chat-list");
  list.replaceChildren();
  for (const c of [...data.conversations].sort((a, b) => b.updated - a.updated)) {
    const li = document.createElement("li");
    li.classList.toggle("active", c.id === data.currentId);
    const open = document.createElement("button");
    open.className = "chat-open";
    open.textContent = c.title;
    open.addEventListener("click", () => {
      data.currentId = c.id;
      persist();
      renderMessages();
      renderChatList();
      closeDrawer();
    });
    const del = document.createElement("button");
    del.className = "chat-del";
    del.setAttribute("aria-label", "Delete chat");
    del.textContent = "✕";
    del.addEventListener("click", () => {
      if (!confirm(`Delete "${c.title}"?`)) return;
      data.conversations = data.conversations.filter((x) => x.id !== c.id);
      if (data.currentId === c.id) {
        data.currentId = data.conversations[0]?.id ?? null;
        if (!data.currentId) newChat(false);
      }
      persist();
      renderMessages();
      renderChatList();
    });
    li.append(open, del);
    list.append(li);
  }
}

function applyName() {
  const n = data.settings.name || "Confidant";
  $("ai-name").textContent = n;
  document.querySelectorAll(".welcome-name").forEach((el) => (el.textContent = n));
}

function setStatus(t) {
  $("status").textContent = t;
}

// ---------- Drawer ----------

function openDrawer() { renderChatList(); $("drawer").hidden = false; }
function closeDrawer() { $("drawer").hidden = true; }

// ---------- Settings ----------

function openSettings() {
  const s = data.settings;
  $("set-name").value = s.name;
  $("set-username").value = s.userName;
  $("set-persona").value = s.persona;
  $("set-temp").value = s.temperature;
  $("temp-value").textContent = s.temperature;
  $("set-custom-url").value = s.customUrl;
  $("set-custom-lib").value = s.customLib;
  $("set-memory-on").checked = s.memoryOn;
  $("set-no-dashes").checked = s.noDashes;
  $("set-adult").checked = s.adultContent;
  $("set-autolock").value = String(s.autolock);
  $("set-rate").value = s.rate;
  $("rate-value").textContent = `${s.rate}×`;
  $("set-autoread").checked = s.autoRead;
  renderVoices();
  renderModelList();
  renderMemory();
  renderPasscode();
  renderStorage();
  $("settings").showModal();
}

function saveSettings() {
  if (!data) return;
  const s = data.settings;
  s.name = $("set-name").value.trim() || "Confidant";
  s.userName = $("set-username").value.trim();
  s.persona = $("set-persona").value.trim() || DEFAULT_PERSONA;
  s.temperature = Number($("set-temp").value);
  s.customUrl = $("set-custom-url").value.trim();
  s.customLib = $("set-custom-lib").value.trim();
  s.memoryOn = $("set-memory-on").checked;
  s.noDashes = $("set-no-dashes").checked;
  s.adultContent = $("set-adult").checked;
  s.autolock = Number($("set-autolock").value);
  s.voiceURI = $("set-voice").value;
  s.rate = Number($("set-rate").value);
  s.autoRead = $("set-autoread").checked;
  const picked = document.querySelector('input[name="model"]:checked');
  if (picked) s.model = picked.value;
  applyName();
  persist();
}

async function renderVoices() {
  const sel = $("set-voice");
  const list = await speech.rankedVoices();
  if (!list.length) {
    sel.replaceChildren(new Option("No voices available", ""));
    return;
  }
  sel.replaceChildren(...list.map((v) => new Option(speech.label(v), v.voiceURI)));
  sel.value = list.some((v) => v.voiceURI === data.settings.voiceURI) ? data.settings.voiceURI : list[0].voiceURI;
}

function renderModelList() {
  const box = $("model-list");
  box.replaceChildren();
  for (const m of MODELS) {
    const label = document.createElement("label");
    label.className = "model";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "model";
    radio.value = m.id;
    radio.checked = m.id === data.settings.model;
    const text = document.createElement("div");
    const loaded = loadedModel === resolveModelId(m.id, hasF16) ? " · in use" : "";
    text.innerHTML = `<strong>${escapeHtml(m.name)}</strong><span class="muted">${escapeHtml(m.size)}${loaded}</span><small>${escapeHtml(m.note)}</small>`;
    label.append(radio, text);
    box.append(label);
  }
}

function renderMemory() {
  const list = $("memory-list");
  list.replaceChildren();
  if (!data.memory.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Nothing saved yet.";
    list.append(li);
  }
  for (const m of data.memory) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = m.text;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "chat-del";
    del.setAttribute("aria-label", "Forget");
    del.textContent = "✕";
    del.addEventListener("click", () => {
      data.memory = data.memory.filter((x) => x.id !== m.id);
      persist();
      renderMemory();
    });
    li.append(span, del);
    list.append(li);
  }
}

function addMemory() {
  const text = $("memory-input").value.trim();
  if (!text) return;
  data.memory.push({ id: uid(), text });
  $("memory-input").value = "";
  persist();
  renderMemory();
}

async function renderPasscode() {
  const on = await store.hasPasscode();
  $("passcode-on").hidden = !on;
  $("passcode-off").hidden = on;
}

async function renderStorage() {
  try {
    const { usage, quota } = await navigator.storage.estimate();
    const gb = (n) => (n / 1e9).toFixed(1);
    $("storage-info").textContent = `Using ${gb(usage)} GB of ${gb(quota)} GB available to this app.`;
  } catch {
    $("storage-info").textContent = "";
  }
}

async function deleteModels() {
  if (!confirm("Delete all downloaded models? Your chats are kept. You'll need to download a model again to chat.")) return;
  const { deleteModelAllInfoInCache } = await webllm();
  const ids = new Set(MODELS.flatMap((m) => [resolveModelId(m.id, true), resolveModelId(m.id, false)]));
  const { custom } = modelConfig();
  if (custom) ids.add(custom.model_id);
  const cfg = await appConfig(custom);
  for (const id of ids) {
    try { await deleteModelAllInfoInCache(id, cfg); } catch {}
  }
  await unloadEngine();
  renderStorage();
  refreshFirstRun();
}

async function unloadEngine() {
  try { await engine?.unload(); } catch {}
  worker?.terminate();
  worker = null;
  engine = null;
  loadedModel = null;
}

async function eraseAll() {
  if (!confirm("Erase ALL chats, memory, settings and downloaded models from this phone? This can't be undone.")) return;
  await unloadEngine();
  await store.wipe();
  for (const k of await caches.keys()) await caches.delete(k);
  location.reload();
}

// ---------- Lock ----------

function showLock() {
  $("app").hidden = true;
  $("drawer").hidden = true;
  if ($("settings").open) $("settings").close();
  $("lock").hidden = false;
  $("unlock-error").hidden = true;
  $("unlock-input").value = "";
}

async function lockNow() {
  if (!(await store.hasPasscode())) return;
  if (generating) await engine?.interruptGenerate();
  speech.stop();
  store.lock();
  data = null;
  $("messages").querySelectorAll(".msg").forEach((n) => n.remove());
  showWriting(false);
  document.querySelectorAll("#writing textarea, #writing input").forEach((el) => (el.value = ""));
  $("check-highlight").replaceChildren();
  showLock();
}

document.addEventListener("visibilitychange", async () => {
  // Leaving the app mid-load isn't a crash: only a load that dies while the
  // app is on screen should count as one on the next launch.
  if (loadingId) writeFlag(document.hidden ? null : loadingId);
  if (document.hidden) {
    hiddenAt = Date.now();
    document.body.classList.add("privacy-blur");
    if (data && data.settings.autolock === 0) lockNow();
  } else {
    document.body.classList.remove("privacy-blur");
    if (data && (await store.hasPasscode()) && Date.now() - hiddenAt >= data.settings.autolock * 1000) lockNow();
  }
});

// ---------- Wiring ----------

$("unlock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await store.unlock($("unlock-input").value);
    if ($("app").dataset.started) {
      data = await store.load();
      $("lock").hidden = true;
      $("app").hidden = false;
      renderMessages();
      renderChatList();
    } else {
      await openApp();
    }
  } catch {
    $("unlock-error").hidden = false;
  }
});

$("forgot").addEventListener("click", async () => {
  if (!confirm("There's no way to recover a forgotten passcode. Erase everything and start over?")) return;
  await store.wipe();
  location.reload();
});

const input = $("input");
const autosize = () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
};
input.addEventListener("input", autosize);
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || generating) return;
  input.value = "";
  autosize();
  if (data.settings.autoRead) speech.unlock();
  send(text);
});
// Return sends on a hardware keyboard; on the iPhone keyboard it's a new line.
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});
$("stop").addEventListener("click", () => engine?.interruptGenerate());

$("load-model").addEventListener("click", loadModel);
$("use-small").addEventListener("click", () => {
  data.settings.model = DEFAULT_MODEL;
  persist();
  $("use-small").hidden = true;
  refreshFirstRun().then(() => loadModel());
});
$("update-banner").addEventListener("click", () => location.reload());
$("toggle-writing").addEventListener("click", () => showWriting($("writing").hidden));
initWriting({
  data: () => data,
  persist,
  engine: () => engine,
  contextTokens,
  ensureEngine: async () => {
    if (!engine) await loadModel();
    return engine;
  },
  setBusy: setGenerating,
});
$("new-chat").addEventListener("click", () => newChat());
$("open-drawer").addEventListener("click", openDrawer);
$("close-drawer").addEventListener("click", closeDrawer);
$("drawer-scrim").addEventListener("click", closeDrawer);

$("open-settings").addEventListener("click", openSettings);
$("settings").addEventListener("close", saveSettings);
$("settings-form").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.tagName === "INPUT") {
    e.preventDefault();
    if (e.target.id === "memory-input") addMemory();
  }
});
$("set-temp").addEventListener("input", (e) => ($("temp-value").textContent = e.target.value));
$("set-rate").addEventListener("input", (e) => ($("rate-value").textContent = `${e.target.value}×`));
$("voice-test").addEventListener("click", () =>
  speech.speak(`Hi, I'm ${$("set-name").value || "Confidant"}. This is how I'll sound when I read to you.`, {
    voiceURI: $("set-voice").value,
    rate: Number($("set-rate").value),
  }));
$("reset-persona").addEventListener("click", () => ($("set-persona").value = DEFAULT_PERSONA));
$("memory-add").addEventListener("click", addMemory);
$("apply-model").addEventListener("click", async () => {
  saveSettings();
  $("settings").close();
  await loadModel();
});

$("passcode-set").addEventListener("click", async () => {
  const p = $("passcode-new").value;
  if (p.length < 4) return alert("Use at least 4 characters.");
  const again = prompt("Type the passcode again to confirm:");
  if (again !== p) return alert("Passcodes didn't match.");
  saveSettings();
  await store.setPasscode(p, data);
  $("passcode-new").value = "";
  renderPasscode();
});
$("passcode-remove").addEventListener("click", async () => {
  if (!confirm("Turn off the passcode? Your chats will no longer be encrypted.")) return;
  saveSettings();
  await store.setPasscode(null, data);
  renderPasscode();
});
$("lock-now").addEventListener("click", () => {
  saveSettings();
  lockNow();
});
$("delete-models").addEventListener("click", deleteModels);
$("erase-all").addEventListener("click", eraseAll);

start();
