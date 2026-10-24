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
const OLD_NEGATIVE = "lowres, blurry, bad anatomy, bad hands, extra fingers, deformed, watermark, text, signature";
const DEFAULT_NEGATIVE = "lowres, blurry, bad anatomy, deformed face, disfigured, poorly drawn face, asymmetrical eyes, cross-eyed, bad hands, extra fingers, mutated hands, extra limbs, watermark, text, signature";
// Always added: SD 1.5 often adds or fuses limbs and fingers.
const ANATOMY_NEGATIVE = "bad anatomy, bad proportions, extra limbs, extra arms, extra legs, missing limbs, fused fingers, extra fingers, missing fingers, mutated hands, malformed hands, long neck, deformed body";
const CFG = 6;

// ADetailer (a free Forge extension) finds faces and hands after the picture
// is made and redraws each one up close, which fixes most warped hands.
async function hasAdetailer() {
  try {
    const { txt2img = [] } = await (await fetch(`${base()}/sdapi/v1/scripts`)).json();
    return txt2img.some((n) => /adetailer/i.test(n));
  } catch {
    return false;
  }
}
const ADETAILER = {
  ADetailer: {
    args: [true, false,
      { ad_model: "face_yolov8n.pt", ad_denoising_strength: 0.4, ad_confidence: 0.3 },
      { ad_model: "hand_yolov8n.pt", ad_denoising_strength: 0.45, ad_confidence: 0.3 }],
  },
};

// SD 1.5 draws faces from very few pixels at 512 px, so they warp. "sharp"
// redraws the picture 1.5x larger (hires fix); "repair" also runs Forge's
// face restoration afterwards. Large SDXL sizes don't need the extra pass.
function qualityParams(quality, width, height) {
  const small = width <= 768 && height <= 768;
  const hires = quality !== "fast" && small
    ? {
        enable_hr: true,
        hr_scale: 1.5,
        hr_upscaler: "Latent",
        denoising_strength: 0.5,
        hr_second_pass_steps: 15,
        hr_cfg: CFG, // Forge's API default is 1.0, which washes the second pass out
        hr_additional_modules: ["Use same choices"],
      }
    : {};
  return { ...hires, restore_faces: quality === "repair" };
}

let ctx; // { data(), persist(), engine(), ensureEngine() }
let busy = false;

const S = () => ctx.data().settings;
let saved = null; // loaded on first use; cleared when the app locks
let characters = null; // [{ id, name, description, ref }], same lifecycle
let editingChar = null;
let refs = null; // reference library: [{ id, kind: "pose"|"outfit"|"scene", name, src }]
const persistRefs = () => saveExtra("refs", refs).catch((e) => console.error("Saving references failed", e));
const REF_KINDS = { pose: "Pose", outfit: "Outfit", scene: "Scene" };
const persistCharacters = () => saveExtra("characters", characters).catch((e) => console.error("Saving characters failed", e));
const store = () => saved ?? [];
const persistImages = () => saveExtra("images", saved).catch((e) => console.error("Saving images failed", e));

// Loads the characters (they're stored encrypted alongside the images).
export async function loadCharacters() {
  characters ??= (await loadExtra("characters")) ?? [];
  return characters;
}

// Who's who, for the writing model, so it keeps characters straight.
export function characterNotes(maxChars = 1500) {
  const lines = (characters ?? []).filter((c) => c.description || c.bio)
    .map((c) => `${c.name}: ${[c.description, c.bio].filter(Boolean).join(". ").replace(/\s+/g, " ")}`);
  let out = "";
  for (const l of lines) if (out.length + l.length < maxChars) out += (out ? "\n" : "") + l;
  return out;
}

export function forgetImages() {
  saved = null;
  characters = null;
  refs = null;
}

// Character references: scaled down so storage stays small and Forge gets a
// sensible size. Returns a JPEG data URL.
async function shrink(src, max = 768) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.9);
}

// Face matching uses Forge's built-in IP-Adapter. Returns the ControlNet
// model name to use for this image size, or null if it isn't installed.
async function faceAdapterModel(large) {
  try {
    const { model_list: models = [] } = await (await fetch(`${base()}/controlnet/model_list`)).json();
    const adapters = models.filter((m) => /ip-adapter/i.test(m));
    const fit = adapters.filter((m) => (large ? /sdxl/i.test(m) : !/sdxl/i.test(m)));
    return fit.find((m) => /face/i.test(m)) ?? fit[0] ?? null;
  } catch {
    return null;
  }
}

// ControlNet models and preprocessors installed in Forge, for references.
async function controlnetLists() {
  try {
    const [models, modules] = await Promise.all([
      fetch(`${base()}/controlnet/model_list`).then((r) => r.json()),
      fetch(`${base()}/controlnet/module_list`).then((r) => r.json()),
    ]);
    return { models: models.model_list ?? [], modules: modules.module_list ?? [] };
  } catch {
    return { models: [], modules: [] };
  }
}
const styleAdapter = (models) => models.find((m) => /ip-adapter/i.test(m) && !/face|sdxl/i.test(m) && /plus/i.test(m))
  ?? models.find((m) => /ip-adapter/i.test(m) && !/face|sdxl/i.test(m)) ?? null;
const poseModel = (models) => models.find((m) => /openpose/i.test(m) && !/sdxl/i.test(m)) ?? null;
const posePreprocessor = (modules) => modules.find((m) => /^dw_openpose_full$/i.test(m))
  ?? modules.find((m) => /^openpose_full$/i.test(m)) ?? modules.find((m) => /openpose/i.test(m)) ?? "openpose_full";

// ---------- Importing AI pictures ----------
// Only pictures that carry an AI generator's data can be imported (and so
// edited). Camera photos don't have it, which keeps real people out.

function pngTextChunks(bytes) {
  const out = {};
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((b, i) => bytes[i] === b)) return out;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const latin = new TextDecoder("latin1");
  const utf8 = new TextDecoder();
  for (let i = 8; i + 8 <= bytes.length;) {
    const len = view.getUint32(i);
    const type = latin.decode(bytes.subarray(i + 4, i + 8));
    const data = bytes.subarray(i + 8, i + 8 + len);
    if (type === "tEXt" || type === "iTXt") {
      const nul = data.indexOf(0);
      const key = latin.decode(data.subarray(0, nul));
      let text = data.subarray(nul + 1);
      if (type === "iTXt") {
        // compression flag, method, then language and translated keyword, each NUL-terminated
        if (text[0] !== 0) { i += 12 + len; continue; }
        let rest = text.subarray(2);
        for (let n = 0; n < 2; n++) rest = rest.subarray(rest.indexOf(0) + 1);
        text = rest;
      }
      out[key] = (type === "iTXt" ? utf8 : latin).decode(text);
    }
    if (type === "IEND") break;
    i += 12 + len;
  }
  return out;
}

// Returns { ok, prompt } for a picture file's bytes.
export function aiOrigin(bytes) {
  const chunks = pngTextChunks(bytes);
  const params = chunks.parameters ?? chunks.Comment ?? chunks.Description ?? "";
  const fromParams = (t) => t.split(/\nNegative prompt:|\nSteps:/)[0].trim();
  // Forge, Automatic1111, Fooocus, SD.Next
  if (/\bSteps: \d+/.test(params) || chunks.parameters) return { ok: true, prompt: fromParams(params) };
  // ComfyUI, InvokeAI, NovelAI
  if (chunks.workflow || chunks.prompt || chunks.invokeai_metadata || chunks["sd-metadata"] || /novelai/i.test(chunks.Software ?? "")) {
    return { ok: true, prompt: (chunks.Description ?? "").trim() };
  }
  // Any format: content credentials or IPTC "made by AI" tags (Midjourney,
  // DALL-E, Firefly and others), or Automatic1111 data in JPEG/WebP EXIF.
  const latin = new TextDecoder("latin1").decode(bytes);
  if (/trainedalgorithmicmedia/i.test(latin)) return { ok: true, prompt: "" };
  const wide = new TextDecoder("utf-16le").decode(bytes.subarray(0, Math.min(bytes.length, 400000)));
  for (const t of [latin, wide]) {
    const m = t.match(/([^\0]{0,2000}?)\n?Steps: \d+, Sampler: /);
    if (m) return { ok: true, prompt: fromParams(m[1].replace(/^[\s\S]*?(UNICODE|ASCII)\0*/, "")) };
  }
  return { ok: false, prompt: "" };
}

async function importPictures(files) {
  const refused = [];
  let added = 0;
  saved ??= (await loadExtra("images")) ?? [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const origin = aiOrigin(bytes);
    if (!origin.ok || MINOR_TERMS.test(origin.prompt)) {
      refused.push(file.name);
      continue;
    }
    const url = URL.createObjectURL(file);
    try {
      saved.unshift({ id: uid(), prompt: origin.prompt || `Imported: ${file.name}`, src: await shrink(url, 1536), created: Date.now(), imported: true });
      added++;
    } catch {
      refused.push(file.name);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  saved.splice(MAX_SAVED);
  persistImages();
  renderGallery();
  const status = $("img-status");
  status.className = refused.length ? "error" : "muted";
  status.textContent = [
    added && `Imported ${added} picture${added > 1 ? "s" : ""}. Tap one, then "Edit part of it".`,
    refused.length && `Not imported: ${refused.join(", ")}. ${refused.length > 1 ? "They don't" : "It doesn't"} carry AI-generator data. Use the original file straight from Forge, ComfyUI, NovelAI, Midjourney, DALL-E or Firefly: screenshots and re-saved copies lose that data.`,
  ].filter(Boolean).join(" ");
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
  return { imagesUrl: "http://127.0.0.1:7860", imageSize: "512x768", imageSteps: 25, imageNegative: DEFAULT_NEGATIVE, imageFaceWeight: 0.7, imageQuality: "repair" };
}

export function initImages(context) {
  ctx = context;
  $("img-generate").addEventListener("click", generate);
  setupEditor();
  $("img-import").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (files.length) await importPictures(files);
  });
  $("img-stop").addEventListener("click", () => fetch(`${base()}/sdapi/v1/interrupt`, { method: "POST" }).catch(() => {}));
  $("img-from-notes").addEventListener("click", promptFromNotes);
  $("char-add").addEventListener("click", () => openCharEditor());
  $("char-cancel").addEventListener("click", () => ($("char-editor").hidden = true));
  $("char-save").addEventListener("click", saveCharacter);
  $("char-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const url = URL.createObjectURL(file);
    try {
      $("char-preview").src = await shrink(url);
      $("char-preview").hidden = false;
    } catch {
      alert("That file couldn't be read as a picture.");
    } finally {
      URL.revokeObjectURL(url);
    }
  });
  for (const kind of Object.keys(REF_KINDS)) {
    $(`ref-file-${kind}`).addEventListener("change", async (e) => {
      const files = [...e.target.files];
      e.target.value = "";
      if (files.length) await addRefs(kind, files);
    });
  }
  $("img-test").addEventListener("click", async () => {
    $("img-status").textContent = "Checking…";
    const r = await checkImages(base());
    $("img-status").textContent = r.message;
    $("img-status").className = r.ok ? "ok" : "error";
  });
  for (const [id, key, num] of [["img-size", "imageSize"], ["img-steps", "imageSteps", true], ["img-negative", "imageNegative"], ["img-url", "imagesUrl"], ["img-face-weight", "imageFaceWeight", true], ["img-quality", "imageQuality"]]) {
    $(id).addEventListener("change", (e) => {
      S()[key] = num ? Number(e.target.value) : e.target.value.trim();
      ctx.persist();
    });
  }
}

export async function renderImages() {
  saved ??= (await loadExtra("images")) ?? [];
  characters ??= (await loadExtra("characters")) ?? [];
  refs ??= (await loadExtra("refs")) ?? [];
  renderCharacters();
  renderRefs();
  const s = S();
  $("img-face-weight").value = String(s.imageFaceWeight ?? 0.7);
  s.imageQuality ??= "repair";
  if (s.imageNegative === OLD_NEGATIVE) s.imageNegative = DEFAULT_NEGATIVE; // upgrade the old default
  $("img-quality").value = s.imageQuality;
  $("img-url").value = s.imagesUrl;
  $("img-size").value = s.imageSize;
  $("img-steps").value = String(s.imageSteps);
  $("img-negative").value = s.imageNegative;
  renderGallery();
}

export async function checkImages(url) {
  try {
    // Forge answers slowly while it's still loading a model, so allow a minute.
    const res = await fetch(`${url}/sdapi/v1/sd-models`, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) return { ok: false, message: `The image program answered with an error (${res.status}). Make sure it was started with --api.` };
    const models = await res.json();
    if (!models.length) return { ok: false, message: "Connected, but no image model is installed yet. Put a model file in Forge's models\\Stable-diffusion folder and restart Forge." };
    return { ok: true, message: `Connected. ${models.length} image model${models.length === 1 ? "" : "s"} installed.` };
  } catch (e) {
    if (e?.name === "TimeoutError") {
      return { ok: false, message: "Forge is running but didn't answer within a minute. It's probably still loading the image model: wait until its black window goes quiet, then try again." };
    }
    let answers = false;
    try {
      await fetch(url, { mode: "no-cors", signal: AbortSignal.timeout(5000) });
      answers = true;
    } catch {}
    return {
      ok: false,
      message: answers
        ? "Forge is running, but isn't letting Confidant connect. Check the COMMANDLINE_ARGS line in webui-user.bat and run the Forge fix command from the setup steps, then close and restart Forge."
        : "Can't reach the image program. Start Forge (run.bat) and wait until it says \"Running on local URL\", then try again.",
    };
  }
}

async function generate() {
  if (busy) return;
  const typed = $("img-prompt").value.trim();
  const cast = (characters ?? []).filter((c) => $(`char-pick-${c.id}`)?.checked);
  if (!typed && !cast.length) return;
  // Each chosen character's description leads the prompt, so the image model
  // sees who is in the picture before the scene.
  const prompt = [...cast.map((c) => c.description), typed].filter(Boolean).join(", ");
  if (MINOR_TERMS.test(prompt)) {
    $("img-status").textContent = "Confidant won't make images involving anyone under 18. Describe adult characters only.";
    $("img-status").className = "error";
    return;
  }
  const s = S();
  const [width, height] = s.imageSize.split("x").map(Number);
  setBusy(true);
  const adapter = cast.length ? await faceAdapterModel(width > 768 || height > 768) : null;
  const chosen = Object.fromEntries(Object.keys(REF_KINDS).map((k) => [k, (refs ?? []).find((r) => r.id === $(`ref-pick-${k}`)?.value)]));
  const lists = Object.values(chosen).some(Boolean) ? await controlnetLists() : { models: [], modules: [] };
  const missing = [];
  const unit = (module, model, weight, image) => ({ enabled: true, module, model, weight, image,
    resize_mode: "Crop and Resize", control_mode: "Balanced", guidance_start: 0, guidance_end: 1 });
  // Order of importance when Forge's 3 slots run out: the pose (it fixes the
  // body), then faces, then the outfit, then the scene.
  const ordered = [];
  if (chosen.pose) {
    const model = poseModel(lists.models);
    if (model) ordered.push({ what: "pose", unit: { ...unit(posePreprocessor(lists.modules), model, 1, chosen.pose.src), processor_res: 512 } });
    else missing.push("pose");
  }
  const faced = adapter ? cast.filter((c) => c.ref) : [];
  for (const c of faced) {
    ordered.push({ what: `${c.name}'s face`, unit: unit("CLIP-ViT-H (IPAdapter)", adapter, (s.imageFaceWeight ?? 0.7) / Math.max(1, Math.min(faced.length, 3) * 0.75), c.ref) });
  }
  const style = styleAdapter(lists.models);
  for (const [kind, weight] of [["outfit", 0.55], ["scene", 0.4]]) {
    if (!chosen[kind]) continue;
    if (style) ordered.push({ what: kind, unit: unit("CLIP-ViT-H (IPAdapter)", style, weight, chosen[kind].src) });
    else missing.push(kind);
  }
  const units = ordered.slice(0, 3).map((o) => o.unit);
  const skipped = ordered.slice(3).map((o) => o.what);
  const fixer = (s.imageQuality ?? "repair") !== "fast" && await hasAdetailer();
  $("img-status").className = "muted";
  $("img-status").textContent = "Creating… the first image after starting Forge takes longer (and face repair downloads a small helper the first time).";
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
        negative_prompt: [s.imageNegative, ANATOMY_NEGATIVE, ALWAYS_NEGATIVE].filter(Boolean).join(", "),
        width,
        height,
        steps: s.imageSteps,
        cfg_scale: CFG,
        ...qualityParams(s.imageQuality ?? "repair", width, height),
        sampler_name: "DPM++ 2M",
        scheduler: "Karras",
        alwayson_scripts: {
          ...(units.length ? { ControlNet: { args: units } } : {}),
          ...(fixer ? ADETAILER : {}),
        },
      }),
    });
    if (!res.ok) throw new Error(`error ${res.status}`);
    const image = (await res.json()).images?.[0];
    if (!image) throw new Error("no image returned");
    saved ??= (await loadExtra("images")) ?? [];
    saved.unshift({ id: uid(), prompt, src: await toJpeg(image), created: Date.now() });
    saved.splice(MAX_SAVED);
    persistImages();
    $("img-status").textContent = missing.length
      ? `Made without your ${missing.length > 1 ? `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}` : missing[0]} reference${missing.length > 1 ? "s" : ""}. To use ${missing.length > 1 ? "them" : "it"}, download the models in setup step 10.`
      : skipped.length
        ? `Forge can use 3 references at once, so ${skipped.join(" and ")} ${skipped.length > 1 ? "were" : "was"} left out. Pick fewer.`
        : cast.some((c) => c.ref) && !adapter
      ? "Made from the characters' descriptions only. To match their faces too, install the face-reference model (see setup step 8)."
      : !fixer && (s.imageQuality ?? "repair") !== "fast"
        ? "Tip: install ADetailer in Forge (setup step 9) to fix hands and faces automatically."
        : "";
    $("img-status").className = "muted";
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
  $("img-viewer-character").onclick = () => {
    dlg.close();
    openCharEditor(null, img.src);
  };
  $("img-viewer-edit").onclick = () => {
    dlg.close();
    openEditor(img);
  };
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

// ---------- Edit part of a picture (inpainting) ----------
// Only pictures made here can be edited, never uploaded photos, so this can't
// be used on a real person. The painted area is redrawn; the rest is kept.

let editing = null; // the gallery image being edited
let erasing = false;

function openEditor(img) {
  editing = img;
  const pic = $("edit-pic");
  const mask = $("edit-mask");
  pic.onload = () => {
    mask.width = pic.naturalWidth;
    mask.height = pic.naturalHeight;
  };
  pic.src = img.src;
  $("edit-status").textContent = "";
  $("edit-status").className = "";
  $("img-editor").showModal();
}

function setupEditor() {
  const mask = $("edit-mask");
  const g = mask.getContext("2d");
  let drawing = false;
  let last = null;
  const point = (e) => {
    const r = mask.getBoundingClientRect();
    return [(e.clientX - r.left) * (mask.width / r.width), (e.clientY - r.top) * (mask.height / r.height)];
  };
  const stroke = (from, to) => {
    const r = mask.getBoundingClientRect();
    g.globalCompositeOperation = erasing ? "destination-out" : "source-over";
    g.strokeStyle = "rgb(255, 40, 120)";
    g.lineCap = g.lineJoin = "round";
    g.lineWidth = Number($("edit-brush").value) * (mask.width / r.width) * 0.5;
    g.beginPath();
    g.moveTo(...from);
    g.lineTo(...to);
    g.stroke();
  };
  mask.addEventListener("pointerdown", (e) => {
    drawing = true;
    mask.setPointerCapture(e.pointerId);
    last = point(e);
    stroke(last, last);
  });
  mask.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const p = point(e);
    stroke(last, p);
    last = p;
  });
  for (const ev of ["pointerup", "pointercancel"]) mask.addEventListener(ev, () => (drawing = false));
  $("edit-erase").addEventListener("click", () => {
    erasing = !erasing;
    $("edit-erase").setAttribute("aria-pressed", String(erasing));
  });
  $("edit-clear").addEventListener("click", () => g.clearRect(0, 0, mask.width, mask.height));
  $("edit-close").addEventListener("click", () => $("img-editor").close());
  $("edit-apply").addEventListener("click", applyEdit);
}

// White where painted, black elsewhere: the mask format Forge expects.
function maskImage() {
  const mask = $("edit-mask");
  const out = document.createElement("canvas");
  out.width = mask.width;
  out.height = mask.height;
  const data = mask.getContext("2d").getImageData(0, 0, mask.width, mask.height);
  let painted = 0;
  for (let i = 0; i < data.data.length; i += 4) {
    const on = data.data[i + 3] > 0;
    if (on) painted++;
    data.data[i] = data.data[i + 1] = data.data[i + 2] = on ? 255 : 0;
    data.data[i + 3] = 255;
  }
  out.getContext("2d").putImageData(data, 0, 0);
  return painted ? out.toDataURL("image/png") : null;
}

async function applyEdit() {
  if (busy || !editing) return;
  const status = $("edit-status");
  const change = $("edit-prompt").value.trim();
  const mask = maskImage();
  if (!mask) return (status.textContent = "Paint over the part you want to change first.");
  if (!change) return (status.textContent = "Describe what the painted part should become.");
  if (MINOR_TERMS.test(`${change} ${editing.prompt}`)) {
    status.className = "error";
    return (status.textContent = "Confidant won't make images involving anyone under 18.");
  }
  const s = S();
  const pic = $("edit-pic");
  busy = true;
  $("edit-apply").disabled = true;
  status.className = "muted";
  status.textContent = "Editing…";
  const poll = setInterval(async () => {
    try {
      const p = await (await fetch(`${base()}/sdapi/v1/progress?skip_current_image=true`)).json();
      if (p.progress > 0) status.textContent = `Editing… ${Math.round(p.progress * 100)}%`;
    } catch {}
  }, 1500);
  try {
    const res = await fetch(`${base()}/sdapi/v1/img2img`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        init_images: [editing.src],
        mask,
        prompt: `${change}, same person, same lighting, photo`,
        negative_prompt: [s.imageNegative, ANATOMY_NEGATIVE, ALWAYS_NEGATIVE,
          /\b(nude|naked|bare|topless|undressed|no clothes)\b/i.test(change) && "clothes, fabric, underwear"].filter(Boolean).join(", "),
        denoising_strength: Number($("edit-strength").value),
        inpainting_fill: 1, // start from the original pixels, so shapes and skin tone carry over
        inpaint_full_res: true, // redraw the painted area up close for detail
        inpaint_full_res_padding: 48,
        mask_blur: 8,
        width: pic.naturalWidth,
        height: pic.naturalHeight,
        steps: s.imageSteps,
        cfg_scale: CFG,
        sampler_name: "DPM++ 2M",
        scheduler: "Karras",
      }),
    });
    if (!res.ok) throw new Error(`error ${res.status}`);
    const image = (await res.json()).images?.[0];
    if (!image) throw new Error("no image returned");
    const edited = { id: uid(), prompt: `${editing.prompt} (edited: ${change})`, src: await toJpeg(image), created: Date.now() };
    saved ??= (await loadExtra("images")) ?? [];
    saved.unshift(edited);
    saved.splice(MAX_SAVED);
    persistImages();
    renderGallery();
    // Keep going from the result: paint again to change something else.
    editing = edited;
    pic.src = edited.src;
    $("edit-mask").getContext("2d").clearRect(0, 0, pic.naturalWidth, pic.naturalHeight);
    status.textContent = "Done. It's saved in your pictures. Paint again to change something else.";
  } catch (e) {
    const r = await checkImages(base());
    status.className = "error";
    status.textContent = r.ok ? `The edit couldn't be made (${e.message}).` : r.message;
  } finally {
    clearInterval(poll);
    busy = false;
    $("edit-apply").disabled = false;
  }
}

// ---------- Reference library ----------

function renderRefs() {
  for (const kind of Object.keys(REF_KINDS)) {
    const mine = (refs ?? []).filter((r) => r.kind === kind);
    const pick = $(`ref-pick-${kind}`);
    const keep = pick.value;
    pick.replaceChildren(new Option("None", ""), ...mine.map((r) => new Option(r.name, r.id)));
    pick.value = mine.some((r) => r.id === keep) ? keep : "";
    pick.closest("label").hidden = !mine.length;
    const list = $(`ref-list-${kind}`);
    list.replaceChildren(...mine.map((r) => {
      const card = document.createElement("div");
      card.className = "ref-card";
      const img = document.createElement("img");
      img.src = r.src;
      img.alt = "";
      const name = document.createElement("input");
      name.value = r.name;
      name.setAttribute("aria-label", "Name");
      name.addEventListener("change", () => {
        r.name = name.value.trim() || r.name;
        persistRefs();
        renderRefs();
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "link";
      del.textContent = "Delete";
      del.addEventListener("click", () => {
        refs = refs.filter((x) => x !== r);
        persistRefs();
        renderRefs();
      });
      card.append(img, name, del);
      return card;
    }));
  }
  $("ref-pickers").hidden = !(refs ?? []).length;
}

async function addRefs(kind, files) {
  refs ??= (await loadExtra("refs")) ?? [];
  let added = 0;
  for (const file of files) {
    const url = URL.createObjectURL(file);
    try {
      const name = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 40) || `${REF_KINDS[kind]} ${refs.length + 1}`;
      if (MINOR_TERMS.test(name)) continue;
      refs.push({ id: uid(), kind, name, src: await shrink(url) });
      added++;
    } catch {
      // not a picture; skip it
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  persistRefs();
  renderRefs();
  if (added < files.length) alert(`${files.length - added} of those files couldn't be added.`);
}

// ---------- Characters ----------

function renderCharacters() {
  const list = $("char-list");
  list.replaceChildren();
  for (const c of characters ?? []) {
    const card = document.createElement("div");
    card.className = "char-card";
    const pick = document.createElement("input");
    pick.type = "checkbox";
    pick.id = `char-pick-${c.id}`;
    const label = document.createElement("label");
    label.htmlFor = pick.id;
    const img = document.createElement("img");
    img.alt = "";
    if (c.ref) img.src = c.ref;
    else img.className = "no-ref";
    const name = document.createElement("span");
    name.textContent = c.name;
    label.append(img, name);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "link";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openCharEditor(c));
    card.append(pick, label, edit);
    list.append(card);
  }
  $("char-hint").hidden = !(characters ?? []).length;
}

function openCharEditor(c = null, src = null) {
  editingChar = c;
  $("char-name").value = c?.name ?? "";
  $("char-desc").value = c?.description ?? "";
  $("char-bio").value = c?.bio ?? "";
  $("char-preview").src = c?.ref ?? src ?? "";
  $("char-preview").hidden = !(c?.ref ?? src);
  $("char-delete").hidden = !c;
  $("char-delete").onclick = () => {
    if (!confirm(`Delete ${c.name}?`)) return;
    characters = characters.filter((x) => x.id !== c.id);
    persistCharacters();
    $("char-editor").hidden = true;
    renderCharacters();
  };
  $("char-editor").hidden = false;
  $("char-name").focus();
}

async function saveCharacter() {
  const name = $("char-name").value.trim();
  const description = $("char-desc").value.trim();
  const bio = $("char-bio").value.trim();
  const ref = $("char-preview").hidden ? "" : $("char-preview").src;
  if (!name) return alert("Give the character a name.");
  if (MINOR_TERMS.test(`${name} ${description} ${bio}`)) return alert("Characters must be adults.");
  characters ??= (await loadExtra("characters")) ?? [];
  const small = ref ? await shrink(ref) : "";
  if (editingChar) Object.assign(editingChar, { name, description, bio, ref: small });
  else characters.push({ id: uid(), name, description, bio, ref: small });
  persistCharacters();
  $("char-editor").hidden = true;
  renderCharacters();
}
