// Images tab: sends descriptions to Stable Diffusion WebUI Forge running on
// the user's computer and keeps the results in the app's private storage.

import { loadExtra, saveExtra } from "./store.js";

const $ = (id) => document.getElementById(id);
const uid = () => crypto.randomUUID();
const MAX_SAVED = 60;

// Hard limit: no sexual or other imagery of anyone under 18. Requests that
// mention minors are refused outright, and every image asks the model to
// steer away from young-looking people.
const MINOR_TERMS = /\b(child|children|kid|kids|minor|minors|underage|under-age|teen|teens|teenage|teenager|preteen|pre-teen|loli|lolita|shota|schoolgirl|schoolboy|school girl|school boy|toddler|baby|infant|jailbait|little girl|little boy|young girl|young boy|girl child|boy child)\b|\b([0-9]|1[0-7])\s*(yo|y\/o|years?[- ]old)\b/i;
const ALWAYS_NEGATIVE = "child, teen, underage, young-looking, childlike, loli";
const DEFAULT_NEGATIVE = "lowres, blurry, bad anatomy, bad hands, extra fingers, deformed, watermark, text, signature";

let ctx; // { data(), persist(), engine(), ensureEngine() }
let busy = false;

const S = () => ctx.data().settings;
let saved = null; // loaded on first use; cleared when the app locks
const store = () => saved ?? [];
const persistImages = () => saveExtra("images", saved).catch((e) => console.error("Saving images failed", e));

export function forgetImages() {
  saved = null;
}

// PNGs from the image program are large; JPEG keeps storage small.
async function toJpeg(pngBase64) {
  const img = new Image();
  img.src = `data:image/png;base64,${pngBase64}`;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext("2d").drawImage(img, 0, 0);
  return c.toDataURL("image/jpeg", 0.9);
}
const base = () => S().imagesUrl.replace(/\/+$/, "");

export function freshImageSettings() {
  return { imagesUrl: "http://127.0.0.1:7860", imageSize: "512x768", imageSteps: 25, imageNegative: DEFAULT_NEGATIVE };
}

export function initImages(context) {
  ctx = context;
  $("img-generate").addEventListener("click", generate);
  $("img-stop").addEventListener("click", () => fetch(`${base()}/sdapi/v1/interrupt`, { method: "POST" }).catch(() => {}));
  $("img-from-notes").addEventListener("click", promptFromNotes);
  $("img-test").addEventListener("click", async () => {
    $("img-status").textContent = "Checking…";
    const r = await checkImages(base());
    $("img-status").textContent = r.message;
    $("img-status").className = r.ok ? "ok" : "error";
  });
  for (const [id, key, num] of [["img-size", "imageSize"], ["img-steps", "imageSteps", true], ["img-negative", "imageNegative"], ["img-url", "imagesUrl"]]) {
    $(id).addEventListener("change", (e) => {
      S()[key] = num ? Number(e.target.value) : e.target.value.trim();
      ctx.persist();
    });
  }
}

export async function renderImages() {
  saved ??= (await loadExtra("images")) ?? [];
  const s = S();
  $("img-url").value = s.imagesUrl;
  $("img-size").value = s.imageSize;
  $("img-steps").value = String(s.imageSteps);
  $("img-negative").value = s.imageNegative;
  renderGallery();
}

export async function checkImages(url) {
  try {
    const res = await fetch(`${url}/sdapi/v1/sd-models`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, message: `The image program answered with an error (${res.status}). Make sure it was started with --api.` };
    const models = await res.json();
    if (!models.length) return { ok: false, message: "Connected, but no image model is installed yet. Put a model file in Forge's models\\Stable-diffusion folder and restart Forge." };
    return { ok: true, message: `Connected. ${models.length} image model${models.length === 1 ? "" : "s"} installed.` };
  } catch {
    let answers = false;
    try {
      await fetch(url, { mode: "no-cors", signal: AbortSignal.timeout(5000) });
      answers = true;
    } catch {}
    return {
      ok: false,
      message: answers
        ? "Forge is running, but isn't letting Confidant connect. Check the COMMANDLINE_ARGS line in webui-user.bat from the setup steps, then close and restart Forge."
        : "Can't reach the image program. Start Forge (run.bat) and wait until it says \"Running on local URL\", then try again.",
    };
  }
}

async function generate() {
  if (busy) return;
  const prompt = $("img-prompt").value.trim();
  if (!prompt) return;
  if (MINOR_TERMS.test(prompt)) {
    $("img-status").textContent = "Confidant won't make images involving anyone under 18. Describe adult characters only.";
    $("img-status").className = "error";
    return;
  }
  const s = S();
  const [width, height] = s.imageSize.split("x").map(Number);
  setBusy(true);
  $("img-status").className = "muted";
  $("img-status").textContent = "Creating… the first image after starting Forge takes longer.";
  const poll = setInterval(async () => {
    try {
      const p = await (await fetch(`${base()}/sdapi/v1/progress?skip_current_image=true`)).json();
      if (p.progress > 0) $("img-status").textContent = `Creating… ${Math.round(p.progress * 100)}%`;
    } catch {}
  }, 1500);
  try {
    const res = await fetch(`${base()}/sdapi/v1/txt2img`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        negative_prompt: [s.imageNegative, ALWAYS_NEGATIVE].filter(Boolean).join(", "),
        width,
        height,
        steps: s.imageSteps,
        cfg_scale: 6,
        sampler_name: "DPM++ 2M",
        scheduler: "Karras",
      }),
    });
    if (!res.ok) throw new Error(`error ${res.status}`);
    const image = (await res.json()).images?.[0];
    if (!image) throw new Error("no image returned");
    saved ??= (await loadExtra("images")) ?? [];
    saved.unshift({ id: uid(), prompt, src: await toJpeg(image), created: Date.now() });
    saved.splice(MAX_SAVED);
    persistImages();
    $("img-status").textContent = "";
    renderGallery();
  } catch (e) {
    const r = await checkImages(base());
    $("img-status").className = "error";
    $("img-status").textContent = r.ok ? `The image couldn't be made (${e.message}). Try a smaller size or fewer steps.` : r.message;
  } finally {
    clearInterval(poll);
    setBusy(false);
  }
}

// Has the writing model turn the current chapter's notes into an image description.
async function promptFromNotes() {
  const notes = ctx.chapterNotes().trim();
  if (!notes) return alert("Write some notes in the Book tab first, then come back.");
  const engine = await ctx.ensureEngine();
  if (!engine) return;
  setBusy(true);
  $("img-prompt").value = "";
  try {
    const stream = await engine.chat.completions.create({
      messages: [
        { role: "system", content: "You write prompts for an image generator. Reply with one comma-separated list of visual details only: the adult characters' appearance, clothing or lack of it, pose, setting, lighting, camera angle, style. No sentences, no names, under 60 words. All characters are adults." },
        { role: "user", content: `Scene notes:\n${notes.slice(0, 1500)}` },
      ],
      stream: true,
      max_tokens: 120,
      temperature: 0.7,
    });
    for await (const chunk of stream) $("img-prompt").value += chunk.choices[0]?.delta?.content ?? "";
    $("img-prompt").value = $("img-prompt").value.trim();
  } finally {
    setBusy(false);
  }
}

function setBusy(on) {
  busy = on;
  $("img-generate").disabled = on;
  $("img-from-notes").disabled = on;
  $("img-stop").hidden = !on;
}

function renderGallery() {
  const grid = $("img-gallery");
  grid.replaceChildren();
  $("img-empty").hidden = store().length > 0;
  for (const img of store()) {
    const fig = document.createElement("figure");
    const pic = document.createElement("img");
    pic.src = img.src;
    pic.alt = img.prompt;
    pic.loading = "lazy";
    pic.addEventListener("click", () => openViewer(img));
    fig.append(pic);
    grid.append(fig);
  }
}

function openViewer(img) {
  const dlg = $("img-viewer");
  $("img-viewer-pic").src = img.src;
  $("img-viewer-prompt").textContent = img.prompt;
  $("img-viewer-reuse").onclick = () => {
    $("img-prompt").value = img.prompt;
    dlg.close();
  };
  $("img-viewer-save").onclick = async () => {
    const blob = await (await fetch(img.src)).blob();
    const file = new File([blob], `confidant-${new Date(img.created).toISOString().slice(0, 10)}.jpg`, { type: "image/jpeg" });
    if (navigator.canShare?.({ files: [file] })) {
      try { return await navigator.share({ files: [file] }); } catch (e) { if (e.name === "AbortError") return; }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
  };
  $("img-viewer-delete").onclick = () => {
    if (!confirm("Delete this image?")) return;
    saved = store().filter((x) => x.id !== img.id);
    persistImages();
    dlg.close();
    renderGallery();
  };
  dlg.showModal();
}
