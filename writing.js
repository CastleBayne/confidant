// Writing studio: learn the user's voice from their own writing, then help
// draft a book in that voice. All analysis and generation happen on-device.
import { AI_TELLS, offVoice, analyze, buildProfile, pickExcerpts, vocabularyCsv, checkText, words, stripDashes, countDashes } from "./voice.js";
import { readDocx } from "./docx.js";
import * as speech from "./speech.js";
import { initImages, renderImages, characterNotes, loadCharacters } from "./images.js";

const WRITE_TOKENS = 700;
const CHARS_PER_TOKEN = 3.5;
// Room for the profile, the chapter context and the reply inside the model's window.
const promptChars = () => (ctx.contextTokens() - WRITE_TOKENS) * CHARS_PER_TOKEN;

// Sampling for book writing. Higher variety means less predictable word
// choices and stronger penalties for repeating words and phrases.
const VARIETY = {
  // Base models drift and mix up characters when sampling runs hot.
  low: { temperature: 0.65, top_p: 0.88, frequency_penalty: 0.15, presence_penalty: 0.1 },
  medium: { temperature: 0.78, top_p: 0.9, frequency_penalty: 0.3, presence_penalty: 0.2 },
  high: { temperature: 0.95, top_p: 0.93, frequency_penalty: 0.5, presence_penalty: 0.35 },
};

const $ = (id) => document.getElementById(id);
const uid = () => crypto.randomUUID();

let ctx; // { data(), persist(), ensureEngine(), engine(), setBusy(on) }
let stats = null; // analysis of all samples, rebuilt when samples change
let undoState = null;

export function freshWriting() {
  return { samples: [], starred: [], hidden: [], profile: "", chapters: [], currentChapter: null };
}

const W = () => ctx.data().writing;

export function initWriting(context) {
  ctx = context;

  document.querySelectorAll(".tabs [data-tab]").forEach((b) =>
    b.addEventListener("click", () => showTab(b.dataset.tab)));

  // Samples
  $("sample-new").addEventListener("click", () => openSampleEditor());
  $("sample-cancel").addEventListener("click", () => ($("sample-editor").hidden = true));
  $("sample-save").addEventListener("click", saveSample);
  $("sample-file").addEventListener("change", importFiles);
  $("train-export").addEventListener("click", () => {
    const w = W();
    if (!w.samples.length) return alert("Add some of your own writing under Samples first.");
    const text = w.samples.map((x) => x.text.trim()).join("\n\n* * *\n\n");
    saveFile("my-writing.txt", text, "text/plain");
  });

  // Voice
  $("voice-regen").addEventListener("click", () => {
    if (W().profile && !confirm("Rebuild the profile from your writing? Your edits to it will be replaced.")) return;
    W().profile = "";
    renderVoice();
  });
  $("voice-profile").addEventListener("input", (e) => {
    W().profile = e.target.value;
    ctx.persist();
  });
  $("voice-copy").addEventListener("click", () => navigator.clipboard?.writeText($("voice-profile").value));
  $("voice-export").addEventListener("click", () =>
    saveFile("vocabulary-sheet.csv", vocabularyCsv(getStats(), W()), "text/csv"));
  $("voice-add-btn").addEventListener("click", addStarredWord);
  $("voice-add-word").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addStarredWord(); }
  });

  // Book
  $("chapter-select").addEventListener("change", (e) => {
    W().currentChapter = e.target.value;
    ctx.persist();
    renderBook();
  });
  $("chapter-new").addEventListener("click", newChapter);
  $("chapter-delete").addEventListener("click", deleteChapter);
  for (const [id, field] of [["chapter-title", "title"], ["chapter-notes", "notes"], ["chapter-text", "text"]]) {
    $(id).addEventListener("input", (e) => {
      const ch = currentChapter();
      ch[field] = e.target.value;
      ch.updated = Date.now();
      if (field === "title") renderChapterSelect();
      if (field === "text") renderCount();
      ctx.persist();
    });
  }
  $("ai-draft").addEventListener("click", () => generate("draft"));
  $("ai-continue").addEventListener("click", () => generate("continue"));
  $("ai-rewrite").addEventListener("click", () => generate("rewrite"));
  $("ai-stop").addEventListener("click", () => ctx.engine()?.interruptGenerate());
  $("ai-undo").addEventListener("click", undoAI);
  $("chapter-check").addEventListener("click", () => {
    $("check-input").value = currentChapter().text;
    showTab("check");
    runCheck();
  });
  $("book-export").addEventListener("click", exportBook);
  $("chapter-read").addEventListener("click", readChapter);
  $("set-variety").addEventListener("change", (e) => {
    ctx.data().settings.writingVariety = e.target.value;
    ctx.persist();
  });

  // Check
  $("check-run").addEventListener("click", runCheck);

  initImages({ ...ctx, chapterNotes: () => currentChapter().notes });
}

export function showWriting(on) {
  $("writing").hidden = !on;
  $("messages").hidden = on;
  $("composer").hidden = on;
  $("new-chat").hidden = on;
  $("toggle-writing").classList.toggle("on", on);
  if (on) showTab(document.querySelector('.tabs [aria-selected="true"]').dataset.tab);
}

function showTab(tab) {
  document.querySelectorAll(".tabs [data-tab]").forEach((b) =>
    b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  document.querySelectorAll("#writing .tab-panel").forEach((p) => (p.hidden = p.dataset.panel !== tab));
  ({ samples: renderSamples, voice: renderVoice, book: renderBook, check: () => {}, images: renderImages })[tab]();
}

// ---------- Samples ----------

function allSampleText() {
  return W().samples.map((s) => s.text).join("\n\n");
}

function getStats() {
  if (!stats) stats = analyze(allSampleText());
  return stats;
}

function samplesChanged() {
  stats = null;
  rebuildProfileIfUnedited();
  renderSamples();
}

function renderSamples() {
  const total = W().samples.reduce((n, s) => n + words(s.text).length, 0);
  $("samples-total").textContent = total
    ? `${total.toLocaleString()} words of your writing${total < 5000 ? " (add more for a stronger profile)" : ""}`
    : "";
  $("train-words").textContent = total
    ? total < 20000 ? `(${total.toLocaleString()} words: training works best with 20,000+)` : `(${total.toLocaleString()} words)`
    : "";
  const list = $("sample-list");
  list.replaceChildren();
  for (const s of W().samples) {
    const li = document.createElement("li");
    const info = document.createElement("button");
    info.className = "item-open";
    info.innerHTML = `<strong></strong><span class="muted"></span>`;
    info.querySelector("strong").textContent = s.title;
    info.querySelector("span").textContent = `${words(s.text).length.toLocaleString()} words`;
    info.addEventListener("click", () => openSampleEditor(s));
    const del = document.createElement("button");
    del.className = "chat-del";
    del.setAttribute("aria-label", "Delete");
    del.textContent = "✕";
    del.addEventListener("click", () => {
      if (!confirm(`Remove "${s.title}"?`)) return;
      W().samples = W().samples.filter((x) => x.id !== s.id);
      samplesChanged();
    });
    li.append(info, del);
    list.append(li);
  }
}

let editingSample = null;

function openSampleEditor(sample = null) {
  editingSample = sample;
  $("sample-title").value = sample?.title ?? "";
  $("sample-text").value = sample?.text ?? "";
  $("sample-editor").hidden = false;
  $("sample-text").focus();
}

function saveSample() {
  const text = $("sample-text").value.trim();
  if (!text) return;
  const title = $("sample-title").value.trim() || text.split(/\s+/).slice(0, 6).join(" ");
  if (editingSample) Object.assign(editingSample, { title, text });
  else W().samples.push({ id: uid(), title, text, added: Date.now() });
  $("sample-editor").hidden = true;
  samplesChanged();
}

async function importFiles(e) {
  for (const file of e.target.files) {
    try {
      const text = file.name.toLowerCase().endsWith(".docx") ? await readDocx(file) : await file.text();
      if (text.trim()) W().samples.push({ id: uid(), title: file.name.replace(/\.\w+$/, ""), text: text.trim(), added: Date.now() });
    } catch (err) {
      alert(`Couldn't read ${file.name}: ${err.message}`);
    }
  }
  e.target.value = "";
  samplesChanged();
}

// ---------- Voice ----------

function renderVoice() {
  const has = W().samples.length > 0;
  $("voice-empty").hidden = has;
  $("voice-body").hidden = !has;
  if (!has) return;
  const s = getStats();

  $("voice-stats").replaceChildren(...[
    [s.totalWords.toLocaleString(), "words analyzed"],
    [s.uniqueWords.toLocaleString(), "different words"],
    [s.avgSentence, "words per sentence"],
    [`${s.shortShare}%`, "short sentences"],
    [s.avgParagraph, "sentences per paragraph"],
    [s.pointOfView, "point of view"],
  ].map(([v, l]) => stat(v, l)));

  const w = W();
  const sigWords = [...new Set([...w.starred, ...s.words.map(([x]) => x)])];
  const countOf = new Map(s.words);
  $("voice-words").replaceChildren(...sigWords.slice(0, 60).map((x) => wordChip(x, countOf.get(x))));
  $("voice-phrases").replaceChildren(...s.phrases.map(([p, c]) => wordChip(p, c)));
  $("voice-openers").replaceChildren(...s.openers.map(([o, c]) => chip(`${o}…`, c)));
  $("voice-dialogue").replaceChildren(
    ...s.dialogue.verbs.slice(0, 8).map(([v, c]) => chip(v, c)),
    ...s.dialogue.adverbs.slice(0, 12).map(([a, c]) => chip(a, c)),
    ...(s.dialogue.thoughts ? [chip("thought to himself/herself", s.dialogue.thoughts)] : []));
  $("voice-names").replaceChildren(...s.names.map(([n, c]) => chip(n[0].toUpperCase() + n.slice(1), c)));
  $("voice-punct").replaceChildren(...Object.entries(s.punctuation).map(([k, v]) => stat(v, k)));
  $("voice-ai").replaceChildren(...buildAvoidChips(s));

  if (!w.profile) {
    w.profile = w.lastGenerated = generatedProfile();
    ctx.persist();
  }
  $("voice-profile").value = w.profile;
}

// Words the user genuinely writes are shown but stay out of the avoid list.
function buildAvoidChips(s) {
  return [
    ...s.aiTellsUsed.map((t) => chip(`${t} (you use this)`)),
    ...AI_TELLS.filter((t) => !s.aiTellsUsed.includes(t)).map((t) => chip(t)),
  ];
}

function stat(value, label) {
  const d = document.createElement("div");
  d.className = "stat";
  d.innerHTML = "<strong></strong><span></span>";
  d.querySelector("strong").textContent = value;
  d.querySelector("span").textContent = label;
  return d;
}

function chip(text, n) {
  const c = document.createElement("span");
  c.className = "chip";
  c.textContent = n ? `${text} · ${n}` : text;
  return c;
}

function wordChip(word, n) {
  const w = W();
  const c = chip(word, n);
  if (w.hidden.includes(word)) c.classList.add("off");
  if (w.starred.includes(word)) c.classList.add("star");
  const star = document.createElement("button");
  star.textContent = "★";
  star.setAttribute("aria-label", `Keep ${word}`);
  star.addEventListener("click", () => toggleList("starred", word));
  const hide = document.createElement("button");
  hide.textContent = "✕";
  hide.setAttribute("aria-label", `Leave out ${word}`);
  hide.addEventListener("click", () => toggleList("hidden", word));
  c.append(star, hide);
  return c;
}

function toggleList(list, word) {
  const w = W();
  w[list] = w[list].includes(word) ? w[list].filter((x) => x !== word) : [...w[list], word];
  const other = list === "starred" ? "hidden" : "starred";
  w[other] = w[other].filter((x) => x !== word);
  rebuildProfileIfUnedited();
  renderVoice();
}

function addStarredWord() {
  const word = $("voice-add-word").value.trim().toLowerCase();
  if (!word) return;
  $("voice-add-word").value = "";
  if (!W().starred.includes(word)) W().starred.unshift(word);
  rebuildProfileIfUnedited();
  renderVoice();
}

// Stats for the voice rules. Habits change over the years, so dialogue
// placement follows the newest writing that has enough dialogue to tell.
function voiceStats() {
  const s = getStats();
  const newest = [...W().samples].sort((a, b) => (b.added ?? 0) - (a.added ?? 0)).find((x) => {
    const d = analyze(x.text).dialogue;
    return d.before + d.after >= 3;
  });
  if (!newest) return s;
  const { before, after } = analyze(newest.text).dialogue;
  return { ...s, dialogue: { ...s.dialogue, before, after } };
}

function generatedProfile() {
  const w = W();
  const s = voiceStats();
  return buildProfile(s, {
    authorName: ctx.data().settings.userName,
    starred: w.starred,
    hidden: w.hidden,
    excerpts: pickExcerpts(allSampleText(), s),
    noDashes: noDashes(),
  });
}

const noDashes = () => ctx.data().settings.noDashes;

// Changes flow into the profile unless the user has hand-edited it.
function rebuildProfileIfUnedited() {
  const w = W();
  const edited = w.profile && w.profile !== w.lastGenerated;
  w.lastGenerated = w.samples.length ? generatedProfile() : "";
  if (!edited) w.profile = w.lastGenerated;
  ctx.persist();
}

// ---------- Book ----------

function currentChapter() {
  const w = W();
  let ch = w.chapters.find((c) => c.id === w.currentChapter);
  if (!ch) {
    ch = w.chapters[0];
    if (!ch) {
      ch = { id: uid(), title: "Chapter 1", notes: "", text: "", updated: Date.now() };
      w.chapters.push(ch);
    }
    w.currentChapter = ch.id;
  }
  return ch;
}

function renderChapterSelect() {
  const sel = $("chapter-select");
  const cur = currentChapter();
  sel.replaceChildren(...W().chapters.map((c, i) => {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = c.title || `Chapter ${i + 1}`;
    o.selected = c.id === cur.id;
    return o;
  }));
}

function renderBook() {
  const ch = currentChapter();
  renderChapterSelect();
  $("chapter-title").value = ch.title;
  $("chapter-notes").value = ch.notes;
  $("chapter-text").value = ch.text;
  $("set-variety").value = ctx.data().settings.writingVariety ?? "medium";
  $("ai-undo").hidden = !undoState || undoState.id !== ch.id;
  renderCount();
}

function renderCount() {
  const ch = currentChapter();
  const total = W().chapters.reduce((n, c) => n + words(c.text).length, 0);
  $("chapter-count").textContent = `${words(ch.text).length.toLocaleString()} words in this chapter · ${total.toLocaleString()} in the book`;
}

function newChapter() {
  const w = W();
  const ch = { id: uid(), title: `Chapter ${w.chapters.length + 1}`, notes: "", text: "", updated: Date.now() };
  w.chapters.push(ch);
  w.currentChapter = ch.id;
  ctx.persist();
  renderBook();
}

function deleteChapter() {
  const ch = currentChapter();
  if (!confirm(`Delete "${ch.title}" and everything in it?`)) return;
  const w = W();
  w.chapters = w.chapters.filter((c) => c.id !== ch.id);
  w.currentChapter = w.chapters[0]?.id ?? null;
  ctx.persist();
  renderBook();
}

// Reads the selected text, or the whole chapter if nothing is selected.
function readChapter() {
  const btn = $("chapter-read");
  if (speech.speaking()) return speech.stop();
  const area = $("chapter-text");
  const selected = area.value.slice(area.selectionStart, area.selectionEnd);
  const text = selected.trim() ? selected : area.value;
  if (!text.trim()) return;
  const s = ctx.data().settings;
  btn.textContent = "Stop reading";
  speech.speak(text, { voiceURI: s.voiceURI, rate: s.rate, onEnd: () => (btn.textContent = "Read aloud") });
}

function exportBook() {
  const book = W().chapters
    .map((c) => `${c.title}\n\n${c.text.trim()}`)
    .join("\n\n\n");
  saveFile("my-book.txt", book, "text/plain");
}

// The author's own text, oldest first: imported writing, then the book's
// other chapters. When it doesn't fit, the most recent part is kept.
// The model copies what it reads last most closely, so the author's own
// samples go last and get most of the room; Book chapters (which may hold
// AI-written text) fill what's left before them.
function storySoFar(maxChars, excludeId) {
  const w = W();
  const sep = "\n\n* * *\n\n";
  const own = w.samples.map((s) => s.text).join(sep);
  const book = w.chapters.filter((c) => c.id !== excludeId && c.text.trim()).map((c) => `${c.title}\n\n${c.text}`).join(sep);
  if (!book) return own.length <= maxChars ? own : `…${tail(own, maxChars)}`;
  if (!own) return book.length <= maxChars ? book : `…${tail(book, maxChars)}`;
  const ownRoom = Math.min(own.length, Math.max(Math.round(maxChars * 0.65), maxChars - book.length));
  const bookRoom = maxChars - ownRoom;
  const ownPart = own.length <= ownRoom ? own : `…${tail(own, ownRoom)}`;
  const bookPart = book.length <= bookRoom ? book : bookRoom > 500 ? `…${tail(book, bookRoom)}` : "";
  return [bookPart, ownPart].filter(Boolean).join(sep);
}

const SENTENCE_END = /[.!?…]["”’]?\s+/;

// Plain continuation that holds back any sentence with a habit the author
// doesn't have and has the model write that sentence again (up to 3 times).
// Ollama reuses the unchanged start of the prompt, so a retry is quick.
export async function* inVoice(engine, { prompt, max_tokens, ...options }) {
  let written = "";
  let tries = 0;
  while (true) {
    const left = max_tokens - Math.round(written.length / 4);
    if (left < 32) return;
    let pending = "";
    let redo = false;
    try {
      const stream = await engine.completions.create({ prompt: prompt + written, max_tokens: left, ...options });
      for await (const chunk of stream) {
        pending += chunk.choices[0]?.delta?.content ?? "";
        let m;
        while ((m = pending.match(SENTENCE_END))) {
          const sentence = pending.slice(0, m.index + m[0].length);
          if (offVoice(sentence) && tries < 3) {
            tries++;
            redo = true;
            break;
          }
          tries = 0;
          written += sentence;
          pending = pending.slice(sentence.length);
          yield { choices: [{ delta: { content: sentence } }] };
        }
        if (redo) break;
      }
    } catch (e) {
      // A retry that writes nothing just means the passage is done.
      if (written && /^The writing model/.test(e.message)) return;
      throw e;
    }
    if (redo) {
      engine.interruptGenerate();
      continue;
    }
    if (pending) yield { choices: [{ delta: { content: pending } }] };
    return;
  }
}

// Voice profile plus the story so far, for chat. Empty until writing is added.
export function writingContext(maxChars) {
  const w = W();
  if (!w.samples.length && !w.chapters.some((c) => c.text.trim())) return "";
  const profile = (w.profile || (w.samples.length ? generatedProfile() : "")).slice(0, Math.round(maxChars * 0.35));
  const names = w.samples.length ? getStats().names.map(([n]) => n[0].toUpperCase() + n.slice(1)).join(", ") : "";
  return [
    "I'm writing a book. You know it well and can talk about it, its characters and how I write.",
    names && `Characters and places: ${names}.`,
    characterNotes() && `Character bios:\n${characterNotes()}`,
    profile && `How I write:\n${profile}`,
    `My book so far:\n\n${storySoFar(Math.round(maxChars * 0.6))}`,
  ].filter(Boolean).join("\n\n");
}

function systemPrompt() {
  const w = W();
  const profile = w.profile || (w.samples.length ? generatedProfile() : "");
  // Big windows (the computer's model) get much more of the book; small ones stay safe.
  const storyShare = ctx.contextTokens() >= 4096 ? 0.5 : 0.25;
  const story = storySoFar(Math.round(promptChars() * storyShare), w.currentChapter);
  return [
    "You are a ghostwriter. You write AS the author, in the author's own voice, as if they wrote it themselves.",
    "This is the adult author's own private fiction. Write every scene they ask for in full, including violent or dark ones, without refusing, softening, skipping ahead or adding warnings.",
    ...(ctx.data().settings.adultContent ? ["Explicit sexual scenes between adult characters are allowed: write them directly and in full detail when the notes call for them, with no fade to black."] : []),
    profile
      ? "Follow this voice profile exactly. It describes how the author really writes:\n\n" + profile.slice(0, Math.round(promptChars() * 0.25))
      : "Write in plain, natural language.",
    ...(story ? [`THE BOOK SO FAR, in the author's own words. Keep characters, facts and events consistent with it, and match its style:\n\n${story}`] : []),
    "Output only the passage itself: no title, no notes, no commentary, no quotation marks around it.",
  ].join("\n\n");
}

function tail(text, chars) {
  if (text.length <= chars) return text;
  const cut = text.slice(-chars);
  return cut.slice(cut.search(/[.!?…]\s/) + 1).trimStart();
}

function buildRequest(mode, ch, selection) {
  const sys = systemPrompt();
  const room = Math.max(600, promptChars() - sys.length);
  if (mode === "rewrite") {
    return { sys, user: `Rewrite this in my voice. Keep the meaning and events; change the wording, rhythm and vocabulary to match how I write:\n\n${selection.slice(0, room)}` };
  }
  if (mode === "continue") {
    const notes = ch.notes.slice(0, Math.round(room * 0.3));
    return { sys, user: `Continue this chapter from exactly where it stops. Don't repeat what's already there. Write the next few paragraphs.\n\n${notes ? `My notes for the chapter: ${notes}\n\n` : ""}The chapter so far ends:\n\n${tail(ch.text, Math.max(400, room - notes.length - 200))}` };
  }
  const notes = ch.notes.slice(0, Math.round(room * (ch.text.trim() ? 0.5 : 0.9)));
  return { sys, user: `Write the next part of my book from these notes${ch.text.trim() ? ", picking up after the text so far" : ""}. Write a few paragraphs.\n\nNotes: ${notes}${ch.text.trim() ? `\n\nThe chapter so far ends:\n\n${tail(ch.text, Math.max(400, room - notes.length - 250))}` : ""}` };
}

// For engines that can continue plain text (the computer's model): the book
// so far, then the chapter, with the notes as an author's note just before
// the point to continue from. No chat framing, so the model writes as the
// next lines of the author's own manuscript.
function continuationPrompt(ch) {
  return manuscriptPrompt({ title: ch.title, notes: ch.notes, text: ch.text, excludeId: ch.id });
}

function manuscriptPrompt({ title, notes, text, excludeId }) {
  const total = promptChars();
  const s = W().samples.length ? voiceStats() : null;
  const rules = [
    "third person, past tense",
    s?.tails !== undefined && s.tails < 10 && "short plain sentences, one action at a time, never a comma followed by an -ing phrase",
    s && s.dialogue.before > s.dialogue.after * 1.5 && "the speaker goes before the quote (Aya responded, \"...\")",
    "no stock phrases",
    "scenes end on an action or a choice, not a summary of feelings",
    ctx.data().settings.adultContent && "intimate and sexual scenes between the adult characters are written plainly and in full when the story calls for them",
    noDashes() && "no dashes",
  ].filter(Boolean);
  const chapterText = tail(text ?? "", Math.round(total * 0.3)).trimEnd();
  const note = (notes ?? "").trim().slice(0, 1500);
  // 0.85: the chars-per-token estimate is rough; leave headroom in the window.
  const castChars = characterNotes().length;
  const story = storySoFar(Math.max(800, Math.round(total * 0.85) - chapterText.length - note.length - castChars - 600), excludeId);
  const cast = castChars ? characterNotes() : "";
  return [
    `[Style: ${rules.join("; ")}.]`,
    ...(cast ? [`[Characters:\n${cast}]`] : []),
    story,
    "* * *",
    title || "",
    ...(note ? [`[Author's note: what happens next: ${note}]`] : []),
    chapterText,
  ].filter(Boolean).join("\n\n") + "\n\n";
}

const ASKS_TO_WRITE = /\b(continue|keep going|keep writing|write|finish|next|what happens|carry on|pick up)\b/i;

// When a chat message is a pasted passage (optionally with a short request
// like "continue this" before or after it), returns a manuscript prompt so
// the model carries on the passage in the author's voice. Otherwise null.
const sentenceCount = (t) => (t.match(/[.!?…]["”’]?(\s|$)/g) ?? []).length;
const JUST_CONTINUE = /^\s*(please\s+)?(can you\s+)?(continue|keep going|keep writing|carry on|finish)\b[^.]{0,40}[.?>!]*\s*$/i;
// "Write what happens next: X" becomes just "X" (the prompt already says what happens next).
const noteFrom = (note) => (JUST_CONTINUE.test(note) ? "" : note.replace(/^\s*(please\s+)?(write\s+)?what happens next\s*[:,-]?\s*/i, ""));

// Splits a message into a short writing request (if any) and the story text.
function splitAsk(message) {
  const paras = message.trim().split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean);
  let note = "";
  if (paras.length > 1 && paras[0].length < 200 && ASKS_TO_WRITE.test(paras[0])) note = paras.shift();
  else if (paras.length > 1 && paras.at(-1).length < 200 && ASKS_TO_WRITE.test(paras.at(-1))) note = paras.pop();
  return { note, passage: paras.join("\n\n") };
}

// Prose, not a question: several sentences of story text. With an explicit
// request ("continue from here"), a single short paragraph is enough.
function isStory(passage, asked) {
  return asked ? passage.length >= 150 && sentenceCount(passage) >= 2 : passage.length >= 300 && sentenceCount(passage) >= 4;
}

export function passagePrompt(message) {
  const { note, passage } = splitAsk(message);
  if (!note && (message.length < 400 || !/\n/.test(message.trim()))) return null;
  if (!isStory(passage, Boolean(note))) return null;
  return manuscriptPrompt({ notes: noteFrom(note), text: passage });
}

const FOLLOW_UP = /^\s*(ok(ay)?,?\s+|now\s+|please\s+)*((can|could|will) you\s+)?(continue|keep going|keep writing|carry on|finish|write (what happens|the next|more|on)|what happens next|next:|pick up)/i;

// A short request on its own ("Write what happens next: ...", "continue")
// carries on the story from earlier in the chat: the last passage the user
// pasted plus the replies written in their voice since.
// With no story in the chat, a request to write a scene carries on from the
// book itself (samples and chapters), so nothing has to be pasted.
const WRITE_SCENE = /^\s*(ok(ay)?,?\s+|now\s+|please\s+)*((can|could|will) you\s+)?(please\s+)?write\b(?!.*\b(poem|email|e-mail|letter|essay|summary|list|outline|blurb|synopsis|review|code)\b)/i;
const sceneNote = (message) => message.trim()
  .replace(/^\s*(ok(ay)?,?\s+|now\s+|please\s+)*((can|could|will) you\s+)?(please\s+)?write\s+(me\s+)?((a|the|an)\s+(scene|chapter|part|bit)\s*)?((where|in which|about|of|with)\s+)?/i, "")
  .replace(/^./, (c) => c.toUpperCase());

export function followUpPrompt(messages, message) {
  if (message.length > 600) return null;
  const follow = FOLLOW_UP.test(message);
  if (!follow && !WRITE_SCENE.test(message)) return null;
  const start = messages.findLastIndex((m) => m.role === "user" && isStory(splitAsk(m.content).passage, true));
  if (start !== -1) {
    const story = [splitAsk(messages[start].content).passage,
      ...messages.slice(start + 1).filter((m) => m.role === "assistant" && /^Your voice/.test(m.via ?? "")).map((m) => m.content)];
    return manuscriptPrompt({ notes: follow ? sceneNote(noteFrom(message.trim())) : sceneNote(message), text: story.join("\n\n") });
  }
  const w = W();
  if (!w.samples.length && !w.chapters.some((c) => c.text.trim())) return null;
  return manuscriptPrompt({ notes: follow ? sceneNote(noteFrom(message.trim())) : sceneNote(message), text: "" });
}

// ---------- Rewrite in my voice ----------
// The writing model can't follow "rewrite this", but it continues patterns.
// So it is shown a few pairs: one of the author's own passages dressed up the
// way the chat model writes, then the author's real version. After the pairs
// comes the new draft, and the model writes the "author's version" of it.

function sampleBlocks() {
  const lines = W().samples.map((x) => x.text).join("\n").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const blocks = [];
  let cur = "";
  for (const line of lines) {
    cur = cur ? `${cur}\n\n${line}` : line;
    if (cur.length >= 450) {
      if (cur.length <= 1100) blocks.push(cur);
      cur = "";
    }
  }
  return blocks;
}

// Three passages spread through the samples, at least one with dialogue.
function pickPairSources() {
  const blocks = sampleBlocks();
  if (blocks.length <= 3) return blocks;
  const picks = [0.2, 0.5, 0.8].map((f) => blocks[Math.floor(f * (blocks.length - 1))]);
  if (!picks.some((b) => /["“]/.test(b))) {
    const talk = blocks.find((b) => /["“]/.test(b) && !picks.includes(b));
    if (talk) picks[1] = talk;
  }
  return [...new Set(picks)];
}

async function chatText(engine, system, user, max_tokens) {
  const stream = await engine.chat.completions.create({
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    stream: true,
    temperature: 0.8,
    max_tokens,
  });
  let out = "";
  for await (const chunk of stream) out += chunk.choices[0]?.delta?.content ?? "";
  return out.trim();
}

const DRESS_UP = "You rewrite fiction. Rewrite the passage as a typical modern AI-written novel would: flowing, ornate, emotional, lots of descriptive phrases and dialogue tags with adverbs. Keep exactly the same events, characters and dialogue meaning, and about the same length. Reply with only the rewritten passage.";

async function voicePairs(engine, onStatus) {
  const w = W();
  const key = w.samples.map((x) => `${x.id}:${x.text.length}`).join(",");
  if (w.voicePairs?.key === key && w.voicePairs.pairs.length) return w.voicePairs.pairs;
  const sources = pickPairSources();
  if (!sources.length) throw new Error("Rewrite in my voice needs some of your own writing. Add it under Book → Samples first.");
  const pairs = [];
  for (const [i, mine] of sources.entries()) {
    onStatus?.(`Learning your voice (one time only)… ${i + 1} of ${sources.length}`);
    const draft = await chatText(engine, DRESS_UP, mine, Math.round(mine.length / 2.5));
    if (draft) pairs.push({ draft, mine });
  }
  w.voicePairs = { key, pairs };
  ctx.persist();
  return pairs;
}

// Splits a long draft into pieces of a few paragraphs, rewritten one at a time.
function draftPieces(text, size = 1000) {
  const paras = text.split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean);
  const pieces = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length > size) {
      pieces.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) pieces.push(cur);
  return pieces;
}

// Streams the draft rewritten in the author's voice.
export async function* rewriteInVoice(engine, draft, onStatus) {
  const pairs = await voicePairs(engine, onStatus);
  onStatus?.("Rewriting in your voice… the first part can take a minute.");
  const head = "The same passages written twice: first a rough draft, then the author's own final version.\n\n" +
    pairs.map((p) => `Draft:\n${p.draft}\n\nAuthor's version:\n${p.mine}`).join("\n\n* * *\n\n") + "\n\n* * *\n\n";
  const pieces = draftPieces(draft);
  for (const [i, piece] of pieces.entries()) {
    if (i) yield { choices: [{ delta: { content: "\n\n" } }] };
    yield* inVoice(engine, {
      prompt: `${head}Draft:\n${piece}\n\nAuthor's version:\n`,
      stop: ["Draft:", "* * *", "Author's version:"],
      max_tokens: Math.round(piece.length / 3) + 80,
      ...VARIETY.low,
    });
  }
}

async function generate(mode) {
  const ch = currentChapter();
  const area = $("chapter-text");
  let start = area.value.length;
  let end = start;
  let selection = "";

  if (mode === "rewrite") {
    start = area.selectionStart;
    end = area.selectionEnd;
    selection = area.value.slice(start, end);
    if (!selection.trim()) return alert("Select the text you want rewritten first: press and hold on it in the Draft box.");
  } else if (mode === "draft" && !ch.notes.trim()) {
    return alert("Write some notes for this chapter first: what happens, who's there, how it should feel.");
  } else if (mode === "continue" && !ch.text.trim()) {
    return alert("There's nothing to continue yet. Write an opening, or use \"Write from my notes\".");
  }

  const engine = await ctx.ensureEngine();
  if (!engine) return;
  await loadCharacters();

  const { sys, user } = buildRequest(mode, ch, selection);
  undoState = { id: ch.id, text: ch.text };
  const before = ch.text.slice(0, start);
  const after = ch.text.slice(end);
  const joiner = mode !== "rewrite" && before.trim() ? (before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n") : "";
  let out = "";

  setBusy(true);
  try {
    const sampling = { max_tokens: WRITE_TOKENS, ...VARIETY[ctx.data().settings.writingVariety] ?? VARIETY.medium };
    const stream = engine.completions && mode !== "rewrite"
      ? inVoice(engine, { prompt: continuationPrompt(ch), stop: ["[", "* * *"], ...sampling })
      : await engine.chat.completions.create({
          messages: [{ role: "system", content: sys }, { role: "user", content: user }],
          stream: true,
          ...sampling,
        });
    for await (const chunk of stream) {
      out += chunk.choices[0]?.delta?.content ?? "";
      if (noDashes()) out = stripDashes(out);
      ch.text = before + joiner + out.trimStart() + after;
      area.value = ch.text;
      if (mode !== "rewrite") area.scrollTop = area.scrollHeight;
    }
  } catch (e) {
    console.error(e);
    alert(/^The writing model/.test(e.message) ? e.message : "Writing stopped because of an error. Try a smaller model or a shorter selection.");
  } finally {
    ch.text = before + joiner + out.trim() + after;
    ch.updated = Date.now();
    area.value = ch.text;
    setBusy(false);
    ctx.persist();
    renderBook();
  }
}

function setBusy(on) {
  ctx.setBusy(on);
  $("ai-stop").hidden = !on;
  for (const id of ["ai-draft", "ai-continue", "ai-rewrite"]) $(id).disabled = on;
}

function undoAI() {
  if (!undoState) return;
  const ch = W().chapters.find((c) => c.id === undoState.id);
  if (ch) ch.text = undoState.text;
  undoState = null;
  ctx.persist();
  renderBook();
}

// ---------- Check ----------

function runCheck() {
  const text = $("check-input").value;
  if (!text.trim()) return;
  if (!W().samples.length) return alert("Add some of your own writing first, so there's a voice to compare against.");
  const r = checkText(text, getStats());
  const mine = getStats();
  $("check-result").hidden = false;
  $("check-score").textContent = `${r.score}%`;

  const notes = [];
  if (r.ai.length) notes.push(`AI-sounding words: ${r.ai.join(", ")}`);
  const dashes = countDashes(text);
  if (dashes) notes.push(`${dashes} em dash${dashes === 1 ? "" : "es"} (shown in red).`);
  notes.push(`Sentences average ${r.stats.avgSentence} words (yours: ${mine.avgSentence}).`);
  if (r.stats.sentences >= 4 && mine.sentenceSpread) {
    const even = r.stats.sentenceSpread < mine.sentenceSpread * 0.7;
    notes.push(`Rhythm: sentence lengths swing by about ${r.stats.sentenceSpread} words (yours: ${mine.sentenceSpread}).${even ? " Too even. Mix in a much shorter or much longer sentence." : ""}`);
  }
  if (r.cliches.length) notes.push(`Familiar phrases (underlined in orange): ${r.cliches.join(", ")}`);
  if (r.stats.totalWords >= 80 && mine.tails !== undefined) {
    const many = r.stats.tails > Math.max(8, mine.tails * 2);
    notes.push(`"-ing" tails like ", her mind racing…": ${r.stats.tails} per 1,000 words (yours: ${mine.tails}).${many ? " Too many: split them into separate short sentences (dotted underline)." : ""}`);
  }
  const d = r.stats.dialogue, md = mine.dialogue;
  if (d && md && d.before + d.after >= 3 && md.before > md.after * 1.5 && d.after > d.before) {
    notes.push(`Dialogue tags come after the quote here; you usually put the speaker first (Aya responded, "…").`);
  }
  notes.push(`Contractions: ${r.stats.contractions} per 1,000 words (yours: ${mine.contractions}).`);
  if (r.unfamiliar.length) notes.push(`${r.unfamiliar.length} words you haven't used in your writing.`);
  $("check-notes").replaceChildren(...notes.map((n) => {
    const p = document.createElement("p");
    p.textContent = n;
    return p;
  }));

  // Build highlighted copy safely: text nodes for plain words, spans for flags.
  const ai = new Set(r.ai.filter((t) => !t.includes(" ")));
  const phrases = [...r.cliches, ...r.ai.filter((t) => t.includes(" ")), ...(r.stats.tails > Math.max(8, (mine.tails ?? 0) * 2) ? r.tails : [])];
  const unfamiliar = new Set(r.unfamiliar);
  const box = $("check-highlight");
  box.replaceChildren();
  const flag = (cls, t) => {
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = t;
    box.append(span);
  };
  const appendWords = (segment) => {
    for (const part of segment.split(/([A-Za-z’']+(?:-[A-Za-z’']+)*|—|–|--)/)) {
      const key = part.toLowerCase().replace(/’/g, "'");
      if (/^(—|–|--)$/.test(part) || ai.has(key)) flag("flag-ai", part);
      else if (unfamiliar.has(key)) flag("flag-new", part);
      else if (part) box.append(document.createTextNode(part));
    }
  };
  // Phrases first (they span several words), then word-level flags in between.
  const phraseRe = phrases.length
    ? new RegExp(`(${phrases.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "['’]").replace(/ /g, "\\s+")).join("|")})`, "gi")
    : null;
  if (!phraseRe) return appendWords(text);
  text.split(phraseRe).forEach((seg, i) => (i % 2 ? flag(ai.has(seg.toLowerCase()) || r.ai.includes(seg.toLowerCase().replace(/\s+/g, " ")) ? "flag-ai" : r.tails.includes(seg) ? "flag-tail" : "flag-cliche", seg) : appendWords(seg)));
}

// ---------- Files ----------

async function saveFile(name, content, type) {
  const file = new File([content], name, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
