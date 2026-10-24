// Writing studio: learn the user's voice from their own writing, then help
// draft a book in that voice. All analysis and generation happen on-device.
import { AI_TELLS, analyze, buildProfile, pickExcerpts, vocabularyCsv, checkText, words, stripDashes, countDashes } from "./voice.js";
import { readDocx } from "./docx.js";

const WRITE_TOKENS = 700;
const CHARS_PER_TOKEN = 3.5;
// Room for the profile, the chapter context and the reply inside the model's window.
const promptChars = () => (ctx.contextTokens() - WRITE_TOKENS) * CHARS_PER_TOKEN;

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

  // Check
  $("check-run").addEventListener("click", runCheck);
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
  ({ samples: renderSamples, voice: renderVoice, book: renderBook, check: () => {} })[tab]();
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

function generatedProfile() {
  const w = W();
  const s = getStats();
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

function exportBook() {
  const book = W().chapters
    .map((c) => `${c.title}\n\n${c.text.trim()}`)
    .join("\n\n\n");
  saveFile("my-book.txt", book, "text/plain");
}

function systemPrompt() {
  const w = W();
  const profile = w.profile || (w.samples.length ? generatedProfile() : "");
  return [
    "You are a ghostwriter. You write AS the author, in the author's own voice, as if they wrote it themselves.",
    profile
      ? "Follow this voice profile exactly. It describes how the author really writes:\n\n" + profile.slice(0, Math.round(promptChars() * 0.55))
      : "Write in plain, natural language.",
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
  const room = Math.max(1200, promptChars() - sys.length);
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

  const { sys, user } = buildRequest(mode, ch, selection);
  undoState = { id: ch.id, text: ch.text };
  const before = ch.text.slice(0, start);
  const after = ch.text.slice(end);
  const joiner = mode !== "rewrite" && before.trim() ? (before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n") : "";
  let out = "";

  setBusy(true);
  try {
    const stream = await engine.chat.completions.create({
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      stream: true,
      temperature: ctx.data().settings.temperature,
      max_tokens: WRITE_TOKENS,
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
    alert("Writing stopped because of an error. Try a smaller model or a shorter selection.");
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
  notes.push(`Contractions: ${r.stats.contractions} per 1,000 words (yours: ${mine.contractions}).`);
  if (r.unfamiliar.length) notes.push(`${r.unfamiliar.length} words you haven't used in your writing.`);
  $("check-notes").replaceChildren(...notes.map((n) => {
    const p = document.createElement("p");
    p.textContent = n;
    return p;
  }));

  // Build highlighted copy safely: text nodes for plain words, spans for flags.
  const ai = new Set(r.ai.filter((t) => !t.includes(" ")));
  const unfamiliar = new Set(r.unfamiliar);
  const box = $("check-highlight");
  box.replaceChildren();
  for (const part of text.split(/([A-Za-z’']+(?:-[A-Za-z’']+)*|—|–|--)/)) {
    const key = part.toLowerCase().replace(/’/g, "'");
    if (/^(—|–|--)$/.test(part)) {
      const span = document.createElement("span");
      span.className = "flag-ai";
      span.textContent = part;
      box.append(span);
    } else if (ai.has(key) || unfamiliar.has(key)) {
      const span = document.createElement("span");
      span.className = ai.has(key) ? "flag-ai" : "flag-new";
      span.textContent = part;
      box.append(span);
    } else {
      box.append(document.createTextNode(part));
    }
  }
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
