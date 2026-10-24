// Finds the clothes in a picture, so "Remove clothes" and "Change outfit"
// work without painting. Runs a small clothes-segmentation model (about
// 30 MB, downloaded once) in the browser with transformers.js.

const abs = (path) => new URL(path, import.meta.url).href;
const MODEL = "Xenova/segformer_b2_clothes";
const CLOTHES = new Set(["Upper-clothes", "Skirt", "Pants", "Dress", "Belt", "Scarf"]);

let segmenter = null;
let RawImage = null;

async function load(onStatus) {
  if (segmenter) return segmenter;
  const lib = await import("./vendor/transformers-3.7.6/transformers.min.js");
  const { pipeline, env } = lib;
  RawImage = lib.RawImage;
  env.allowLocalModels = false;
  env.backends.onnx.wasm.wasmPaths = abs("vendor/transformers-3.7.6/");
  env.backends.onnx.wasm.proxy = false;
  onStatus?.("Getting the clothes finder ready (about 30 MB, first time only)…");
  segmenter = await pipeline("image-segmentation", MODEL, { device: "wasm", dtype: "q8" });
  return segmenter;
}

// Returns a black-and-white PNG data URL (white = clothes) the size of the
// picture, grown a little past the edges so seams don't show. Null if no
// clothes were found.
export async function clothesMask(src, onStatus) {
  const seg = await load(onStatus);
  onStatus?.("Finding the clothes…");
  // Hand over the pixels directly: the app's security rules block the
  // library from fetching data: URLs itself.
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d").drawImage(img, 0, 0);
  const parts = (await seg(RawImage.fromCanvas(canvas))).filter((p) => CLOTHES.has(p.label));
  if (!parts.length) return null;
  const { width, height } = parts[0].mask;
  const raw = new ImageData(width, height);
  for (const { mask } of parts) {
    const channels = mask.channels ?? 1;
    for (let i = 0; i < width * height; i++) {
      if (mask.data[i * channels] > 127) raw.data[i * 4] = raw.data[i * 4 + 1] = raw.data[i * 4 + 2] = 255;
      raw.data[i * 4 + 3] = 255;
    }
  }
  for (let i = 3; i < raw.data.length; i += 4) raw.data[i] = 255;
  const hard = document.createElement("canvas");
  hard.width = width;
  hard.height = height;
  hard.getContext("2d").putImageData(raw, 0, 0);
  // Grow the area: blur, then treat anything not fully black as clothes.
  const grown = document.createElement("canvas");
  grown.width = width;
  grown.height = height;
  const g = grown.getContext("2d");
  g.filter = `blur(${Math.max(4, Math.round(Math.min(width, height) / 80))}px)`;
  g.drawImage(hard, 0, 0);
  const px = g.getImageData(0, 0, width, height);
  for (let i = 0; i < px.data.length; i += 4) {
    const on = px.data[i] > 8 ? 255 : 0;
    px.data[i] = px.data[i + 1] = px.data[i + 2] = on;
    px.data[i + 3] = 255;
  }
  g.filter = "none";
  g.putImageData(px, 0, 0);
  return grown.toDataURL("image/png");
}
