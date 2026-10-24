// Reads text aloud with the phone's built-in voices (on-device on iPhone).

const FEMALE = ["samantha", "ava", "allison", "susan", "victoria", "karen", "moira", "tessa", "fiona", "serena",
  "zoe", "nicky", "kate", "veena", "joelle", "noelle", "kathy", "martha", "catherine", "isha", "sandy", "shelley",
  "flo", "grandma", "female", "aria", "jenny", "emma", "libby", "sonia", "natasha", "nora",
  "zira", "hazel", "linda", "heather", "eva"]; // last line: Windows built-in voices

const synth = window.speechSynthesis;
let queue = [];
let onDone = null;

export const supported = () => Boolean(synth);

// Voices load asynchronously; resolve once the list is available.
export function voices() {
  if (!synth) return Promise.resolve([]);
  const list = synth.getVoices();
  if (list.length) return Promise.resolve(list);
  return new Promise((resolve) => {
    const done = () => resolve(synth.getVoices());
    synth.addEventListener("voiceschanged", done, { once: true });
    setTimeout(done, 1500);
  });
}

function quality(v) {
  return /premium/i.test(v.name) ? 3 : /enhanced/i.test(v.name) ? 2 : 0;
}

export function isFemale(v) {
  const n = v.name.toLowerCase();
  return FEMALE.some((f) => n.includes(f));
}

// Some browsers (Chrome, Edge) offer "online" voices that send the text to
// Google or Microsoft to be spoken. Only on-device voices are allowed.
const onDevice = (v) => v.localService !== false && !/online|google/i.test(v.name);

// English on-device voices, best female voices first.
export async function rankedVoices() {
  const list = (await voices()).filter((v) => /^en/i.test(v.lang) && onDevice(v));
  const score = (v) => (isFemale(v) ? 10 : 0) + quality(v) * 2 + (/en-US/i.test(v.lang) ? 1 : 0) + (v.localService ? 1 : 0);
  return list.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
}

export function label(v) {
  const region = v.lang.replace(/^en[-_]?/i, "") || "EN";
  return `${v.name} · ${region}${isFemale(v) ? " · female" : ""}`;
}

// Plain text without the markup the chat uses for bold, italics and code.
function clean(text) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>]/g, "")
    .replace(/\s*(—|–|--)\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

// iOS stops long utterances partway through, so speak in sentence-sized pieces.
function chunks(text, max = 220) {
  const out = [];
  let cur = "";
  for (const s of text.match(/[^.!?…]+[.!?…]*["”’)]?\s*/g) ?? [text]) {
    if ((cur + s).length > max && cur) {
      out.push(cur.trim());
      cur = "";
    }
    if (s.length > max) {
      for (const piece of s.match(new RegExp(`.{1,${max}}(\\s|$)`, "g")) ?? [s]) out.push(piece.trim());
    } else {
      cur += s;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

export async function speak(text, { voiceURI, rate = 1, onEnd } = {}) {
  if (!synth) return;
  stop();
  const list = await voices();
  const voice = list.find((v) => v.voiceURI === voiceURI && onDevice(v)) ?? (await rankedVoices())[0];
  if (!voice) return onEnd?.(); // never fall back to a voice that leaves the device
  queue = chunks(clean(text));
  onDone = onEnd ?? null;
  const next = () => {
    const piece = queue.shift();
    if (!piece) {
      const cb = onDone;
      onDone = null;
      cb?.();
      return;
    }
    const u = new SpeechSynthesisUtterance(piece);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    u.rate = rate;
    u.onend = next;
    u.onerror = next;
    synth.speak(u);
  };
  next();
}

export function stop() {
  queue = [];
  const cb = onDone;
  onDone = null;
  synth?.cancel();
  cb?.();
}

export const speaking = () => Boolean(synth?.speaking || queue.length);

// iOS only allows speech that starts from a tap. Speaking a silent utterance
// during a tap unlocks it, so replies can be read automatically later.
export function unlock() {
  if (!synth || unlock.done) return;
  const u = new SpeechSynthesisUtterance(" ");
  u.volume = 0;
  synth.speak(u);
  unlock.done = true;
}
