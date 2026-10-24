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

const per1k = (n, total) => (total ? Math.round((n / total) * 10000) / 10 : 0);

export function analyze(text) {
  const w = words(text);
  const total = w.length;
  const sents = sentences(text);
  const paras = paragraphs(text);

  const wordCounts = new Map();
  const phraseCounts = new Map();
  const openerCounts = new Map();
  for (const x of w) if (!STOPWORDS.has(x) && x.length > 2) count(wordCounts, x);

  for (const s of sents) {
    const sw = words(s);
    count(openerCounts, sw.slice(0, sw[0]?.length <= 3 ? 2 : 1).join(" "));
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= sw.length; i++) {
        const gram = sw.slice(i, i + n);
        // Skip phrases made only of filler words, like "of the" or "it was"
        if (gram.every((g) => STOPWORDS.has(g))) continue;
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
    aiTellsUsed: AI_TELLS.filter((t) => lower.includes(` ${t} `)),
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
  const out = [];
  let used = 0;
  for (const { p } of scored) {
    if (used + p.length > maxChars) continue;
    out.push(p);
    used += p.length;
    if (out.length === 3) break;
  }
  return out;
}

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
  const openers = stats.openers.map(([o]) => `"${o[0].toUpperCase()}${o.slice(1)}…"`).slice(0, 8);
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

  return { score, ai, unfamiliar, stats: s };
}
