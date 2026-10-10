/*
=========================================================
PORTAL MAP  (session / exam type / course ka "root")

Idea: portal ke har dropdown label ko ek *structured meaning* mein
badlo, phir student ke program (level + kind + start year) se
SCORE karke best combination chuno. Koi bhi naya label aaye to:

  1. Agar kisi rule se pehchana ja sake  -> automatic kaam karega.
  2. Agar na pehchana jaye              -> "unknown" list mein jayega
     (owner ko dikhega) aur code crash nahi hoga.
  3. Jo combo asli PDF dila de (recordHit) -> yaad rakha jata hai
     aur next time uska score badh jata hai (self-learning).

NAYA FAMILY / EXAM / STREAM JODNE KE LIYE sirf neeche ke
tables (SESSION_FAMILIES, EXAM_RULES, STREAM_RULES) mein ek line add karo.

CLI:  node portal-map.js      -> dropdown-cache.json ka poora report
=========================================================
*/

const fs = require("fs");
const path = require("path");

const DB_FILE = process.env.PORTAL_MAP_DB
  ? path.resolve(process.env.PORTAL_MAP_DB)
  : path.join(__dirname, "portal-map.json");

/*
---------------------------------------------------------
TABLE 1: SESSION FAMILIES  (label -> family)
Upar wali rule pehle match hoti hai.
---------------------------------------------------------
*/
const SESSION_FAMILIES = [
  { id: "paramedical", test: /paramedical/ },
  { id: "provisional", test: /provisional/ },
  { id: "semester", test: /semester|\bsem\b/ },
  { id: "yearly", test: /^\s*year|yearly|annual/ },
];

/*
---------------------------------------------------------
TABLE 2: EXAM TYPE RULES  (label -> level / kind)
Ek label par kai rules lag sakte hain.
---------------------------------------------------------
*/
const EXAM_RULES = [
  { test: /\bpg\b|post\s*grad/, set: { level: "PG" } },
  { test: /\bug\b|under\s*grad/, set: { level: "UG" } },
  { test: /voc/, set: { kind: "VOC" } },
  { test: /regular|general|annual|yearly|semester/, set: { regularHint: true } },
];

/*
---------------------------------------------------------
TABLE 3: STREAM RULES  (course label -> stream)
---------------------------------------------------------
*/
const STREAM_RULES = [
  { stream: "arts", test: /^b\.?\s*a\b|\barts\b/i },
  { stream: "science", test: /^b\.?\s*sc|\bscience\b/i },
  { stream: "commerce", test: /^b\.?\s*com|\bcommerce\b/i },
];

/*
---------------------------------------------------------
PARSERS
---------------------------------------------------------
*/

const ROMAN = { i: 1, v: 5, x: 10 };

function romanToNumber(text) {
  const s = String(text).toLowerCase();
  let total = 0;

  for (let i = 0; i < s.length; i++) {
    const cur = ROMAN[s[i]];
    const nxt = ROMAN[s[i + 1]] || 0;
    total += cur < nxt ? -cur : cur;
  }

  return total;
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function fullYear(token) {
  const n = Number(token);
  return n < 100 ? 2000 + n : n;
}

// "SEMESTER(2018-20&2018-21)" -> ranges [{2018,2020},{2018,2021}]
// "...2018-2021&22"           -> ranges [{2018,2021},{2018,2022}]
// "YEAR-2026"                 -> years [2026]
function parseSession(option) {
  const text = clean(`${option.text || ""} ${option.value || ""}`);
  const low = text.toLowerCase();

  const family = (SESSION_FAMILIES.find((f) => f.test.test(low)) || {}).id || "unknown";

  const ranges = [];
  const parts = text.split("&");

  for (const part of parts) {
    const range = part.match(/(?<!\d)((?:19|20)?\d{2})\s*(?:-|–|to)\s*((?:19|20)?\d{2})(?!\d)/i);

    if (range) {
      ranges.push({ start: fullYear(range[1]), end: fullYear(range[2]) });
      continue;
    }

    const extra = part.trim().match(/^((?:19|20)?\d{2})$/);

    if (extra && ranges.length) {
      ranges.push({ start: ranges[ranges.length - 1].start, end: fullYear(extra[1]) });
    }
  }

  const years = ranges.length
    ? []
    : [...text.matchAll(/(?<!\d)(20\d{2})(?!\d)/g)].map((m) => Number(m[1]));

  return { family, ranges, years, isVoc: /voc/.test(low), text };
}

function classifyExam(option) {
  const low = clean(`${option.text || ""} ${option.value || ""}`).toLowerCase();

  const info = { level: null, kind: null, regularHint: false };

  for (const rule of EXAM_RULES) {
    if (rule.test.test(low)) {
      Object.assign(info, rule.set);
    }
  }

  return info;
}

// "BA(SEM-I)"->1  "SEM-2"->2  "Part-III"->3  "BED-II"->2  "BALLB3"->3  "PART-3"->3
function courseSeq(text) {
  const value = clean(text);

  let m = value.match(/(?:sem(?:ester)?|part|year)[\s\-_(]*([ivx]+|\d+)(?![a-z0-9])/i);

  if (!m) m = value.match(/[\s\-_]([ivx]+|\d+)\)?$/i);

  if (!m) m = value.match(/[a-z]{2,}(\d+)$/i);

  if (!m) return null;

  return /^\d+$/.test(m[1]) ? Number(m[1]) : romanToNumber(m[1]);
}

function classifyCourse(option) {
  const text = clean(option.text || option.value);
  const low = text.toLowerCase();

  const stream = (STREAM_RULES.find((r) => r.test.test(text)) || {}).stream || null;

  let unit = null;

  if (/sem/.test(low)) unit = "sem";
  else if (/part/.test(low)) unit = "part";
  else if (/year/.test(low)) unit = "year";

  return { text, seq: courseSeq(text), unit, stream };
}

/*
---------------------------------------------------------
LEARNED COMBOS + UNKNOWN LABELS (portal-map.json)
---------------------------------------------------------
*/

let db = { combos: {}, unknown: { sessions: [], exams: [], courses: [] } };

try {
  if (fs.existsSync(DB_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));

    if (parsed && typeof parsed === "object") {
      db = {
        combos: parsed.combos || {},
        unknown: { sessions: [], exams: [], courses: [], ...(parsed.unknown || {}) },
      };
    }
  }
} catch (error) {
  console.error("⚠️ portal-map load failed:", error.message);
}

let writeChain = Promise.resolve();

function persist() {
  writeChain = writeChain
    .then(async () => {
      const tmp = DB_FILE + ".tmp";
      await fs.promises.writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
      await fs.promises.rename(tmp, DB_FILE);
    })
    .catch((error) => console.error("⚠️ portal-map save failed:", error.message));

  return writeChain;
}

function noteUnknown(bucket, label) {
  const list = db.unknown[bucket];

  if (label && !list.includes(label) && list.length < 200) {
    list.push(label);
    console.warn(`⚠️ portal-map: unrecognised ${bucket.slice(0, -1)} label "${label}"`);
    persist();
  }
}

function comboKey(program, sessionFamily, examText) {
  return `${program.level} ${program.kind}|${sessionFamily}|${clean(examText).toLowerCase()}`;
}

function learnedBoost(key) {
  const hits = db.combos[key]?.hits || 0;

  return Math.min(3, hits);
}

// Jab koi combo se asli PDF mil jaye to ise call karo.
function recordHit({ program, session, exam, course }) {
  try {
    const family = parseSession(session).family;
    const key = comboKey(program, family, exam.text);

    const entry = db.combos[key] || { hits: 0 };

    entry.hits += 1;
    entry.lastCourse = clean(course?.text);
    entry.last = new Date().toISOString();

    db.combos[key] = entry;

    persist();
  } catch (_) {}
}

/*
---------------------------------------------------------
PICKERS  (student-profile.js ke purane functions ki jagah)
program = { level:"UG"|"PG", kind:"REG"|"VOC", portalYear, duration }
---------------------------------------------------------
*/

function scoreSession(option, program) {
  const info = parseSession(option);
  const y = Number(program.portalYear);

  let score = 0;

  // Exact old portal session:
  // YEAR-2019, YEAR-2020, YEAR-2021, YEAR-2022, etc.
  if (info.years.includes(y)) {
    score = 30;
  }

  // Session range such as 2019-2022
  if (info.ranges.length) {
    const exactRangeEnd = y + Number(program.duration || 2);

    if (
      info.ranges.some(
        (r) => r.start === y && r.end === exactRangeEnd
      )
    ) {
      score = Math.max(score, 30);
    } else if (info.ranges.some((r) => r.start === y)) {
      score = Math.max(score, 20);
    }
  }

  if (!score) {
    if (
      info.family === "unknown" &&
      !info.ranges.length &&
      !info.years.length
    ) {
      noteUnknown("sessions", clean(option.text));
    }

    return 0;
  }

  if (program.level === "PG" && info.family === "semester") {
    score += 5;
  }

  if (program.level === "UG" && info.family === "yearly") {
    score += 5;
  }

  if (info.family === "paramedical") {
    score -= 3;
  }

  if (program.kind === "VOC" && info.isVoc) {
    score += 3;
  }

  if (program.kind === "REG" && !info.isVoc) {
    score += 3;
  }

  return score;
}

function pickSessions(sessions, program) {
  return sessions
    .map((option) => ({ option, score: scoreSession(option, program) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.option);
}

function scoreExam(option, program, session) {
  const info = classifyExam(option);

  if (!info.level && !info.kind && !info.regularHint) {
    noteUnknown("exams", clean(option.text));
  }

  let score = 0;

  if (program.level === "PG") score += info.level === "PG" ? 5 : -10;
  else score += info.level === "UG" ? 5 : info.level === "PG" ? -10 : 0;

  if (program.kind === "VOC") {
    score += info.kind === "VOC" ? 5 : -10;
  } else {
    score += info.kind === "VOC" ? -10 : 0;
    score += info.regularHint ? 2 : 0;
  }

  if (session) {
    score += learnedBoost(comboKey(program, parseSession(session).family, option.text));
  }

  return score;
}

// Saare chalne layak exams, best pehle (negative wale hat jaate hain).
function rankExams(exams, program, session) {
  return exams
    .map((option) => ({ option, score: scoreExam(option, program, session) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.option);
}

// Purana behaviour: sirf strong match (>=5) ya null.
function pickExam(exams, program, session) {
  let best = null;
  let bestScore = -Infinity;

  for (const option of exams) {
    const info = classifyExam(option);
    const low = clean(`${option.text || ""} ${option.value || ""}`).toLowerCase();

    let score = scoreExam(option, program, session);

    // Old portal: exam dropdown may simply be "Regular" / "Vocational"
    // without UG/PG in the label.
    if (program.kind === "REG" && /\bregular\b/.test(low) && !/\bvoc/.test(low)) {
      score += 6;
    }

    if (program.kind === "VOC" && /\bvoc/.test(low)) {
      score += 6;
    }

    // Never allow the opposite exam type.
    if (program.kind === "REG" && /\bvoc/.test(low)) {
      score = -Infinity;
    }

    if (program.kind === "VOC" && !/\bvoc/.test(low)) {
      score = -Infinity;
    }

    if (score > bestScore) {
      best = option;
      bestScore = score;
    }
  }

  return best && bestScore >= 5 ? best : null;
}

// Course list -> is program ke layak courses.
function filterCourses(courses, program, stream) {
  const classified = courses.map((option) => ({ option, info: classifyCourse(option) }));

  let pool = classified;

  if (program.level === "UG" && program.kind === "REG") {
    const hasStreams = classified.some((c) => c.info.stream);

    if (hasStreams && stream) {
      pool = classified.filter((c) => c.info.stream === stream);
    }
  } else {
    const wantUnit = program.level === "UG" ? "part" : "sem";
    const units = classified.filter((c) => c.info.unit === wantUnit);

    if (units.length) pool = units;
  }

  return pool.map((c) => c.option);
}

function pickFirstCourse(courses, program, stream) {
  return (
    filterCourses(courses, program, stream).find((c) => courseSeq(c.text) === 1) || null
  );
}

/*
---------------------------------------------------------
REPORT: dropdown-cache.json ka poora tree + unclassified labels
---------------------------------------------------------
*/

function describeCache(cache) {
  const lines = [];
  const unknown = { sessions: [], exams: [], courses: [] };

  for (const option of cache.sessions || []) {
    const info = parseSession(option);

    const when = info.ranges.length
      ? info.ranges.map((r) => `${r.start}-${r.end}`).join(" & ")
      : info.years.join(",") || "?";

    lines.push(`SESSION  ${info.family.padEnd(11)} ${when.padEnd(20)} ${clean(option.text)}`);

    if (info.family === "unknown" || when === "?") unknown.sessions.push(clean(option.text));
  }

  const seenExam = new Set();

  for (const group of cache.exams || []) {
    for (const option of group.data || []) {
      const label = clean(option.text);

      if (seenExam.has(label)) continue;

      seenExam.add(label);

      const info = classifyExam(option);

      lines.push(
        `EXAM     level=${info.level || "-"} kind=${info.kind || "-"} reg=${info.regularHint ? "y" : "-"}  ${label}`
      );

      if (!info.level && !info.kind && !info.regularHint) unknown.exams.push(label);
    }
  }

  const seenCourse = new Set();

  for (const group of cache.courses || []) {
    for (const option of group.data || []) {
      const label = clean(option.text);

      if (seenCourse.has(label)) continue;

      seenCourse.add(label);

      const info = classifyCourse(option);

      lines.push(
        `COURSE   seq=${info.seq ?? "-"} unit=${info.unit || "-"} stream=${info.stream || "-"}  ${label}`
      );

      if (info.seq === null && !info.stream && !info.unit) unknown.courses.push(label);
    }
  }

  lines.push("", "UNCLASSIFIED (rule add karne layak):");
  lines.push(JSON.stringify(unknown, null, 2));

  return lines.join("\n");
}

function ownerReport() {
  const combos = Object.entries(db.combos)
    .sort((a, b) => b[1].hits - a[1].hits)
    .slice(0, 25)
    .map(([key, v]) => `${v.hits}x  ${key}  (e.g. ${v.lastCourse || "-"})`);

  return (
    `Learned combos: ${Object.keys(db.combos).length}\n${combos.join("\n") || "-"}\n\n` +
    `Unknown labels:\n${JSON.stringify(db.unknown, null, 2)}`
  );
}

module.exports = {
  parseSession,
  classifyExam,
  classifyCourse,
  courseSeq,
  pickSessions,
  pickExam,
  rankExams,
  filterCourses,
  pickFirstCourse,
  recordHit,
  describeCache,
  ownerReport,
};

if (require.main === module) {
  const file = process.argv[2] || path.join(__dirname, "dropdown-cache.json");

  console.log(describeCache(JSON.parse(fs.readFileSync(file, "utf8"))));
}