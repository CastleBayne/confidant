// Analyzes the user's own writing to describe their voice: vocabulary,
// repeated phrases, sentence rhythm and punctuation habits. Pure functions,
// no model involved, so results are instant and identical every time.

const STOPWORDS = new Set(`a about above after again against all am an and any are aren't as at be because been
before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't
down during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here
here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's
me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own
same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them
themselves then there there's these they they'd they'll they're they've this those through to too under until
up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who
who's whom why why's with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves
just like get got go going went one also back even still really well now said say says know think thing things
way much many could would will can us yeah oh ok okay im dont`.split(/\s+/));

// Words and phrases that AI models overuse and people rarely write.
export const AI_TELLS = [
  "delve", "delves", "delving", "tapestry", "testament", "vibrant", "intricate", "intricacies", "multifaceted",
  "realm", "embark", "embarking", "unwavering", "resonate", "resonates", "underscore", "underscores", "pivotal",
  "seamless", "seamlessly", "leverage", "foster", "fostering", "bustling", "meticulous", "meticulously",
  "elevate", "showcase", "showcasing", "endeavor", "paramount", "beacon", "symphony", "kaleidoscope",
  "ever-evolving", "palpable", "nestled", "enigmatic", "labyrinth", "myriad", "plethora", "profound",
  "navigate", "navigating", "landscape", "interplay", "furthermore", "moreover", "additionally", "notably",
  "crucial", "vital", "harness", "unleash", "unlock", "transformative", "boundless", "captivating",
  "a testament to", "it's important to note", "in conclusion", "in today's", "the weight of",
  "a sense of", "couldn't help but", "little did", "sent shivers", "let out a breath", "a mix of",
];

// Stock fiction phrases. Common in published books, so models lean on them
// and detectors read them as predictable.
export const CLICHES = [
  "took a deep breath", "let out a breath", "let out a sigh", "breath he didn't know", "breath she didn't know",
  "stopped in his tracks", "stopped in her tracks", "a chill ran down", "shivers down", "sent a chill",
  "heart pounded", "heart raced", "heart skipped", "time stood still", "deafening silence", "the silence was deafening",
  "eyes widened", "couldn't help but", "a wave of", "only mean one thing", "little did", "in the blink of an eye",
  "all hell broke loose", "piercing gaze", "jaw dropped", "knuckles white", "a smile tugged", "corner of her mouth",
  "corner of his mouth", "barely above a whisper", "for what felt like an eternity", "the air was thick",
  "eyes sparkled", "steeled himself", "steeled herself", "squared his shoulders", "swallowed hard", "dead of night",
  "calm before the storm", "every fiber of", "against all odds", "a force to be reckoned with", "as if on cue",
  "without a second thought", "bit her lip", "raised an eyebrow", "ran a hand through", "exchanged a glance",
  "a knowing look", "something shifted", "hung in the air", "a flicker of", "a hint of a smile", "mind raced",
  "the world seemed to", "a testament to", "sent shivers", "a sense of", "the weight of",
  "mind racing", "mind raced", "lost in her own thoughts", "lost in his own thoughts", "lost in thought",
  "tinged with", "a hint of something", "something more intense", "a flush of", "a surge of", "eyes roaming",
  "twig snapped", "spun around", "barely noticed", "a pang of", "a wave of emotion",
  "heart pounding", "breath caught", "with every fiber", "something shift", "warmth blossomed",
  "a flicker of", "maybe, just maybe", "charged silence", "stark contrast", "searching hers",
  "searching his", "cradling her face", "mingling with",
];

const CONTRACTION = /\b\w+'(s|t|re|ve|ll|d|m)\b/gi;
const DASH = /\s*(?:—|–|--)\s*/g;

// Swap em/en dashes for commas, since the user never wants them.
export function stripDashes(text) {
  return text
    .replace(DASH, ", ")
    .replace(/,\s*([.!?,;:])/g, "$1")
    .replace(/^,\s*/gm, "");
}

export function countDashes(text) {
  return (text.match(/—|–|--/g) ?? []).length;
}

export function words(text) {
  return text.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z]+(?:['-][a-z]+)*/g) ?? [];
}

export function sentences(text) {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?…]["”’)]?)\s+(?=["“‘(]?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => words(s).length > 0);
}

function paragraphs(text) {
  return text.split(/\n\s*\n|\n(?=\s{2,}|\t)/).map((p) => p.trim()).filter(Boolean);
}

function top(counts, n, min = 2) {
  return [...counts.entries()]
    .filter(([, c]) => c >= min)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n);
}

function count(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function spread(a) {
  if (a.length < 2) return 0;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.round(Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length) * 10) / 10;
}

function percentile(a, p) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

const per1k = (n, total) => (total ? Math.round((n / total) * 10000) / 10 : 0);

const NOT_NAMES = new Set(["i", "i'm", "i'd", "i'll", "i've", "ok", "okay", "mr", "mrs", "ms", "dr", "sir"]);

// Names of people and places: words the author capitalizes even mid-sentence.
function findNames(text) {
  const cap = new Map();
  const low = new Map();
  const re = /([.!?…"“”]\s*|^\s*)?\b([A-Za-z][a-z]+(?:-[A-Za-z][a-z]+)*)\b/gm;
  for (const m of text.replace(/[’‘]/g, "'").matchAll(re)) {
    const word = m[2];
    const key = word.toLowerCase();
    if (/^[A-Z]/.test(word)) {
      if (!m[1]) count(cap, key); // ignore sentence-initial capitals
    } else {
      count(low, key);
    }
  }
  return new Map([...cap].filter(([k, c]) =>
    c >= 2 && (low.get(k) ?? 0) <= c * 0.2 && !STOPWORDS.has(k) && !NOT_NAMES.has(k)));
}

const SPEECH_VERBS = "said|says|asked|asks|replied|yelled|shouted|whispered|muttered|mumbled|answered|continued|interjected|ordered|called|cried|added|snapped|laughed|sighed|explained|insisted|admitted|began|demanded|pleaded|told|responded|exclaimed";

// How dialogue gets tagged: which verbs, and whether adverbs ride along ("said plainly").
function dialogueTags(text) {
  const verbs = new Map();
  const adverbs = new Map();
  const tagRe = new RegExp(`\\b(${SPEECH_VERBS})\\b(?:\\s+(\\w+ly)\\b)?`, "gi");
  for (const m of text.matchAll(tagRe)) {
    count(verbs, m[1].toLowerCase());
    if (m[2] && !["only", "early", "family", "really"].includes(m[2].toLowerCase())) count(adverbs, `${m[1].toLowerCase()} ${m[2].toLowerCase()}`);
  }
  // Where the speaker goes: before the quote (Aya responded, "…") or after ("…," Aya said).
  // Same line only, so a new paragraph after a quote isn't mistaken for a tag.
  const q = text.replace(/[“”]/g, '"');
  const before = (q.match(new RegExp(`\\b\\w+[ \\t]+(?:${SPEECH_VERBS})\\b[^"\\n]{0,25},[ \\t]*"`, "gi")) ?? []).length;
  const after = (q.match(new RegExp(`[,?!.]"[ \\t]+(?:[A-Z]\\w*|he|she|they|I)[ \\t]+(?:${SPEECH_VERBS})\\b`, "g")) ?? []).length;
  const thoughts = (text.match(/\bthought to (?:himself|herself|themselves|myself)\b|\bsaid to (?:himself|herself|themselves|myself)\b/gi) ?? []).length;
  return { verbs: top(verbs, 10, 1), adverbs: top(adverbs, 15, 1), thoughts, before, after };
}

// Phrases tacked onto the end of a sentence with a comma: ", her mind racing
// with…", ", his voice tinged with…", ", lost in thought". AI prose is full of
// them; many authors barely use them.
const TAIL = /,\s+(?:(?:his|her|their|its|my|our)\s+\w+\s+)?(?:\w+ing|\w+ed|lost|now)\b[^.,!?;"“”]*/g;

export function participleTails(text) {
  return [...text.matchAll(TAIL)].map((m) => m[0].replace(/^,\s+/, ""));
}

export function analyze(text) {
  const w = words(text);
  const total = w.length;
  const sents = sentences(text);
  const paras = paragraphs(text);

  const names = findNames(text);
  const wordCounts = new Map();
  const phraseCounts = new Map();
  const openerCounts = new Map();
  for (const x of w) if (!STOPWORDS.has(x) && !names.has(x) && x.length > 2) count(wordCounts, x);

  for (const s of sents) {
    // Character names become [name] so "Torin said" and "Quinn said" count as one habit.
    const sw = words(s).map((x) => (names.has(x) ? "[name]" : x));
    count(openerCounts, sw.slice(0, sw[0]?.length <= 3 ? 2 : 1).join(" "));
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= sw.length; i++) {
        const gram = sw.slice(i, i + n);
        // Skip phrases made only of filler words, like "of the" or "it was"
        if (gram.every((g) => STOPWORDS.has(g) || g === "[name]")) continue;
        // Keep name phrases only when they show a habit, like "[name] asked"
        if (gram.includes("[name]") && !(gram[0] === "[name]" && /ed$|^(knew|said|thought|took|felt|saw|was|had|ran|made)$/.test(gram[1]))) continue;
        count(phraseCounts, gram.join(" "));
      }
    }
  }

  const lengths = sents.map((s) => words(s).length);
  const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : 0);
  const share = (f) => (lengths.length ? Math.round((lengths.filter(f).length / lengths.length) * 100) : 0);
  const n = (re) => (text.match(re) ?? []).length;
  const lower = ` ${w.join(" ")} `;

  const firstPerson = w.filter((x) => ["i", "me", "my", "mine", "myself", "i'm", "i've", "i'd", "i'll"].includes(x)).length;
  const thirdPerson = w.filter((x) => ["he", "she", "him", "her", "his", "hers", "they", "them", "their"].includes(x)).length;

  return {
    totalWords: total,
    uniqueWords: new Set(w).size,
    sentences: sents.length,
    avgSentence: avg(lengths),
    // How much sentence length swings. People vary a lot; models stay even.
    sentenceSpread: spread(lengths),
    sentenceRange: [percentile(lengths, 0.1), percentile(lengths, 0.9)],
    shortShare: share((l) => l <= 8),
    longShare: share((l) => l >= 25),
    avgParagraph: avg(paras.map((p) => sentences(p).length)),
    pointOfView: firstPerson > thirdPerson ? "first person" : "third person",
    contractions: per1k(n(CONTRACTION), total),
    punctuation: {
      "em dashes (—)": per1k(n(/—|--| - /g), total),
      "semicolons": per1k(n(/;/g), total),
      "colons": per1k(n(/:/g), total),
      "ellipses (…)": per1k(n(/…|\.\.\./g), total),
      "exclamation marks": per1k(n(/!/g), total),
      "questions": per1k(n(/\?/g), total),
      "parentheses": per1k(n(/\(/g), total),
      "dialogue quotes": per1k(n(/["“]/g) / 2, total),
    },
    words: top(wordCounts, 80),
    phrases: top(phraseCounts, 60, 3).filter(([p], i, all) =>
      // Drop a short phrase when a longer one containing it is just as common
      !all.some(([q, c]) => q !== p && q.includes(p) && c >= all[i][1])).slice(0, 25),
    openers: top(openerCounts, 12, 2),
    names: top(new Map([...names.keys()].map((k) => [k, w.filter((x) => x === k).length])), 40, 2),
    dialogue: dialogueTags(text),
    tails: per1k(participleTails(text).length, total),
    aiTellsUsed: AI_TELLS.filter((t) => lower.includes(` ${t} `)),
    clichesUsed: CLICHES.filter((t) => lower.includes(` ${t} `)),
    vocabulary: new Set(w),
  };
}

// Pick a couple of typical paragraphs to show the model what the voice sounds like.
export function pickExcerpts(text, stats, maxChars = 1400) {
  const paras = paragraphs(text).filter((p) => {
    const l = words(p).length;
    return l >= 40 && l <= 160;
  });
  const scored = paras.map((p) => ({
    p,
    score: Math.abs(avgSentenceOf(p) - stats.avgSentence) + (AI_TELLS.some((t) => p.toLowerCase().includes(t)) ? 50 : 0),
  }));
  scored.sort((a, b) => a.score - b.score);
  // Show range: the best narration paragraph and the best dialogue paragraph first.
  const firstOf = (f) => scored.find((x) => f(x.p));
  const ordered = [...new Set([firstOf((p) => !hasDialogue(p)), firstOf(hasDialogue), ...scored].filter(Boolean))];
  const out = [];
  let used = 0;
  for (const { p } of ordered) {
    if (used + p.length > maxChars) continue;
    out.push(p);
    used += p.length;
    if (out.length === 3) break;
  }
  return out;
}

const hasDialogue = (p) => /["“]/.test(p);

function avgSentenceOf(p) {
  const l = sentences(p).map((s) => words(s).length);
  return l.length ? l.reduce((a, b) => a + b, 0) / l.length : 0;
}

function describeRate(rate, { often, some }) {
  if (rate >= often) return "often";
  if (rate >= some) return "sometimes";
  if (rate > 0) return "rarely";
  return "never";
}

// A plain-text profile the user can read, edit, and paste into any AI.
export function buildProfile(stats, { authorName, starred = [], hidden = [], excerpts = [], noDashes = true } = {}) {
  const keep = (w) => !hidden.includes(w);
  const sigWords = [...new Set([...starred, ...stats.words.map(([w]) => w)])].filter(keep).slice(0, 40);
  const phrases = stats.phrases.map(([p]) => p).filter(keep).slice(0, 15);
  const openers = stats.openers.map(([o]) => `"${o.replace(/^\[name\]/, "[Name]").replace(/^[a-z]/, (c) => c.toUpperCase())}…"`).slice(0, 8);
  const d = stats.dialogue ?? { verbs: [], adverbs: [], thoughts: 0 };
  const names = (stats.names ?? []).map(([n]) => n[0].toUpperCase() + n.slice(1));
  const p = stats.punctuation;
  const habits = [
    noDashes ? "em dashes never" : `em dashes ${describeRate(p["em dashes (—)"], { often: 4, some: 1 })}`,
    `semicolons ${describeRate(p.semicolons, { often: 3, some: 0.8 })}`,
    `ellipses ${describeRate(p["ellipses (…)"], { often: 3, some: 0.8 })}`,
    `exclamation marks ${describeRate(p["exclamation marks"], { often: 4, some: 1 })}`,
    `questions ${describeRate(p.questions, { often: 8, some: 2 })}`,
    `parentheses ${describeRate(p.parentheses, { often: 3, some: 0.8 })}`,
  ];
  const avoid = AI_TELLS.filter((t) => !stats.aiTellsUsed.includes(t) && !t.includes(" "));
  const avoidPhrases = AI_TELLS.filter((t) => !stats.aiTellsUsed.includes(t) && t.includes(" "));

  return [
    `VOICE PROFILE${authorName ? `: ${authorName}` : ""}`,
    `Based on ${stats.totalWords.toLocaleString()} words of my own writing.`,
    "",
    "RHYTHM",
    `- Sentences average ${stats.avgSentence} words. ${stats.shortShare}% are short (8 words or fewer), ${stats.longShare}% are long (25+).`,
    ...(stats.sentenceRange ? [`- My sentence lengths swing a lot, usually anywhere from ${stats.sentenceRange[0]} to ${stats.sentenceRange[1]} words. Mix very short sentences and fragments with long ones. Never write several sentences of the same length or shape in a row.`] : []),
    `- Paragraphs average ${stats.avgParagraph} sentences.`,
    `- I write in the ${stats.pointOfView}.`,
    `- Contractions: ${describeRate(stats.contractions, { often: 15, some: 5 })} (${stats.contractions} per 1,000 words).`,
    "",
    "PUNCTUATION",
    `- ${habits.join("; ")}.`,
    "",
    "WORDS I USE A LOT",
    sigWords.join(", ") || "(add more writing to fill this in)",
    "",
    "PHRASES I REPEAT",
    phrases.join("; ") || "(add more writing to fill this in)",
    "",
    "HOW I OFTEN START SENTENCES",
    openers.join(", ") || "(add more writing to fill this in)",
    ...(d.verbs.length ? [
      "",
      "DIALOGUE",
      `- I tag dialogue with: ${d.verbs.slice(0, 6).map(([v]) => v).join(", ")}.`,
      ...(d.adverbs.length ? [`- I often add an adverb to the tag, like: ${d.adverbs.slice(0, 8).map(([a]) => a).join(", ")}.`] : []),
      ...(d.thoughts ? [`- Characters think to themselves in quotes ("he thought to himself").`] : []),
      ...(d.before > d.after * 1.5 ? [`- I put the speaker BEFORE the quote, with a comma: Aya responded, "You will do better in time." Do this for most lines of dialogue.`] : []),
      ...(d.after > d.before * 1.5 ? [`- I put the speaker after the quote: "You will do better in time," Aya said.`] : []),
    ] : []),
    ...(names.length ? ["", "CHARACTERS AND PLACES", names.slice(0, 25).join(", ")] : []),
    "",
    "NEVER USE THESE WORDS",
    avoid.join(", "),
    "",
    "NEVER USE THESE PHRASES",
    avoidPhrases.join("; "),
    "",
    "RULES",
    "- Write the way I write: my words, my rhythm, my punctuation. Plain words over fancy ones.",
    "- Don't tidy my style up, summarize, moralize, or end on a neat lesson.",
    "- Match my sentence lengths; don't make every sentence the same shape.",
    ...(stats.tails !== undefined && stats.tails < 10 ? [`- I almost never tack -ing phrases onto the end of a sentence (", her mind racing with…", ", his voice tinged with…", ", his eyes roaming over…"). Write a new short sentence instead: "Her mind raced." Plain subject-verb sentences in the past tense, one action at a time.`] : []),
    "- Pick the specific, surprising word over the safe, expected one. Avoid stock phrases like: took a deep breath, heart pounded, eyes widened, couldn't help but, a wave of, raised an eyebrow, barely above a whisper.",
    ...(noDashes ? ["- NEVER use em dashes (—) or en dashes (–). Use a comma, a period or parentheses instead."] : []),
    ...(excerpts.length ? ["", "SAMPLES OF MY WRITING", ...excerpts.map((e) => `"""\n${noDashes ? stripDashes(e) : e}\n"""`)] : []),
  ].join("\n");
}

// A spreadsheet-friendly vocabulary sheet.
export function vocabularyCsv(stats, { starred = [], hidden = [] } = {}) {
  const rows = [["type", "text", "count", "per 1,000 words", "starred"]];
  const add = (type, list) => {
    for (const [t, c] of list) {
      if (hidden.includes(t)) continue;
      rows.push([type, t, c, per1k(c, stats.totalWords), starred.includes(t) ? "yes" : ""]);
    }
  };
  add("word", stats.words);
  add("phrase", stats.phrases);
  add("sentence opener", stats.openers);
  add("character or place", stats.names ?? []);
  add("dialogue tag", stats.dialogue?.verbs ?? []);
  add("dialogue tag + adverb", stats.dialogue?.adverbs ?? []);
  for (const [k, v] of Object.entries(stats.punctuation)) rows.push(["punctuation", k, "", v, ""]);
  for (const t of AI_TELLS) if (!stats.aiTellsUsed.includes(t)) rows.push(["avoid (AI word)", t, 0, 0, ""]);
  return rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
}

// Compares any text against the user's voice. Returns flagged words and a rough match score.
export function checkText(text, stats) {
  const s = analyze(text);
  const ai = AI_TELLS.filter((t) => ` ${words(text).join(" ")} `.includes(` ${t} `));
  const unfamiliar = [...new Set(words(text))].filter((w) =>
    !stats.vocabulary.has(w) && !STOPWORDS.has(w) && w.length > 3 && !AI_TELLS.includes(w));

  const closeness = (a, b, scale) => Math.max(0, 1 - Math.abs(a - b) / scale);
  const known = s.totalWords ? words(text).filter((w) => stats.vocabulary.has(w)).length / s.totalWords : 0;
  const punctKeys = Object.keys(stats.punctuation);
  const punct = punctKeys.reduce((acc, k) => acc + closeness(s.punctuation[k], stats.punctuation[k], 6), 0) / punctKeys.length;
  const score = Math.round(100 * (
    0.35 * known +
    0.2 * closeness(s.avgSentence, stats.avgSentence, 10) +
    0.15 * closeness(s.contractions, stats.contractions, 20) +
    0.15 * punct +
    0.15 * Math.max(0, 1 - ai.length / 3)));

  const cliches = CLICHES.filter((t) => ` ${words(text).join(" ")} `.includes(` ${t} `));
  return { score, ai, cliches, unfamiliar, tails: participleTails(text), stats: s };
}
