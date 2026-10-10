const fs = require("fs");
const os = require("os");
const path = require("path");

const college = require("./bulk/college");
const log = require("./logger");

const {
  getSessions,
  getExamTypes,
  getCourses,
  checkResult,
  buildKnownPdfUrl,
  verifyPdfDirect,
} = require("./result-checker");

const { extractResultDetails } = require("./result-details");

const store = require("./profile-store");

const TYPES = ["UG REG", "UG VOC", "PG REG", "PG VOC"];

const STREAMS = ["arts", "science", "commerce"];

/*
=========================================================
HELPERS
=========================================================
*/

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeName(value) {
  return (
    String(value || "")
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "file"
  );
}

async function pool(limit, items, worker) {
  let next = 0;

  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const index = next++;

        if (index >= items.length) {
          return;
        }

        await worker(items[index], index);
      }
    }
  );

  await Promise.all(runners);
}

const { courseSeq } = require("./portal-map");

/*
=========================================================
ROLL NUMBER
Format: YY + COLLEGE(3) + SUBJECT(4) + SERIAL(4) = 13 digits
=========================================================
*/

function parseRoll(roll) {
  const value = String(roll || "").trim();

  if (!/^\d{13}$/.test(value)) {
    return null;
  }

  return {
    roll: value,
    regYY: value.slice(0, 2),
    collegeCode: value.slice(2, 5),
    subjectCode: value.slice(5, 9),
    serial: value.slice(9),
  };
}

/*
=========================================================
CSV TYPE (UG REG / UG VOC / PG REG / PG VOC)
Optional override: bulk/csv-types.json
  { "myfile.csv": "UG REG" }
=========================================================
*/

function loadTypeOverrides() {
  try {
    const file = path.join(__dirname, "bulk", "csv-types.json");

    if (!fs.existsSync(file)) {
      return {};
    }

    const raw = JSON.parse(fs.readFileSync(file, "utf8"));

    const result = {};

    for (const [name, type] of Object.entries(raw)) {
      result[String(name).toLowerCase()] = String(type).toUpperCase().trim();
    }

    return result;
  } catch (_) {
    return {};
  }
}

function classifyCsv(fileName, section) {
  const overrides = loadTypeOverrides();

  const key = String(fileName || "").toLowerCase();

  if (TYPES.includes(overrides[key])) {
    return overrides[key];
  }

  const sec = String(section || "").toUpperCase().trim();

  if (TYPES.includes(sec)) {
    return sec;
  }

  const name = path.basename(key, ".csv");

  const vocational =
    /voc/.test(name) || /(?:^|[^a-z])(?:pg|ug)\s*v(?![a-z])/.test(name);

  let level = null;

  if (/pg|post/.test(name)) {
    level = "PG";
  } else if (/ug|under/.test(name)) {
    level = "UG";
  }

  if (!level) {
    console.warn(
      `⚠️ CSV type unknown for "${fileName}" - treating as UG REG (use bulk/csv-types.json to fix)`
    );

    level = "UG";
  }

  return `${level} ${vocational ? "VOC" : "REG"}`;
}

/*
=========================================================
CSV MATCH (college code + subject code)
=========================================================
*/

const csvRowsCache = new Map();

function getCsvRows(file) {
  const cached = csvRowsCache.get(file.path);

  if (cached && cached.modified === file.modified) {
    return cached.rows;
  }

  let rows = [];

  try {
    rows = college.loadCsvFile(file.path);
  } catch (error) {
    console.error(`⚠️ CSV skipped (${file.name}):`, error.message);
  }

  csvRowsCache.set(file.path, {
    modified: file.modified,
    rows,
  });

  return rows;
}

function findCsvMatches(parsed) {
  const wantedCollege = parsed.collegeCode.padStart(3, "0");

  const wantedSubject = parsed.subjectCode.padStart(4, "0");

  const matches = [];

  const seenTypes = new Set();

  // Profile setup uses ONLY the Master CSV.
  for (const file of masterCsvFiles()) {

    for (const row of getCsvRows(file)) {
      if (
        String(row.collegeCode).trim().padStart(3, "0") !== wantedCollege ||
        String(row.subjectCode).trim().padStart(4, "0") !== wantedSubject
      ) {
        continue;
      }

      const type = classifyCsv(file.name, row.section);

      if (seenTypes.has(type)) {
        break;
      }

      seenTypes.add(type);

      matches.push({
        type,
        file: file.name,
        collegeCode: wantedCollege,
        collegeName: row.collegeName,
        subject: row.subject,
        subjectCode: wantedSubject,
        section: row.section,
        duration: durationFromRow(row),
      });

      break;
    }
  }

  return matches;
}

function isMasterCsv(fileName) {
  return /master/i.test(String(fileName || ""));
}

/*
Profile setup ke liye SIRF Master CSV. Baaki 4 CSV (UGT/UGV/PGT/PGV) yahan
scan hi nahi hote (bulk/fullcollege flows unhe alag se use karte rahenge).
*/
let masterCsvRef = null;

function masterCsvFiles() {
  if (masterCsvRef) {
    try {
      return [{ ...masterCsvRef, modified: fs.statSync(masterCsvRef.path).mtimeMs }];
    } catch (_) {
      masterCsvRef = null;
    }
  }

  const dirs = [
    path.join(__dirname, "bulk"),
    path.join(__dirname, "bulk", "csv"),
    path.join(__dirname, "csv"),
    __dirname,
  ];

  for (const dir of dirs) {
    try {
      const name = fs
        .readdirSync(dir)
        .find((entry) => /master/i.test(entry) && /\.csv$/i.test(entry));

      if (name) {
        const full = path.join(dir, name);

        masterCsvRef = { name, path: full };

        return [{ ...masterCsvRef, modified: fs.statSync(full).mtimeMs }];
      }
    } catch (_) {}
  }

  // Aakhri raasta: purana scanner (sirf Master filter karke).
  try {
    return college.scanCsvFiles(false).filter((file) => isMasterCsv(file.name));
  } catch (_) {
    return [];
  }
}

// "1 Year", "2 Years", "1", "24 months", "Two Year" -> number of years
function parseDurationYears(value) {
  if (value === undefined || value === null) return 0;

  const text = String(value).trim().toLowerCase();

  if (!text) return 0;

  const words = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  const m = text.match(/(\d+(?:\.\d+)?)|\b(one|two|three|four|five)\b/);

  if (!m) return 0;

  let n = m[1] ? Number(m[1]) : words[m[2]];

  if (/month|mnth|\bmo\b/.test(text)) n = n / 12;

  n = Math.round(n);

  return n >= 1 && n <= 6 ? n : 0;
}

function durationFromRow(row) {
  if (!row || typeof row !== "object") return 0;

  const keys = Object.keys(row);

  const pick = (re) => keys.find((k) => re.test(k));

  const key =
    pick(/duration/i) || pick(/\b(years?|yrs?)\b/i) || pick(/period|tenure/i);

  if (key) {
    const d = parseDurationYears(row[key]);
    if (d) return d;
  }

  if (!durationWarned) {
    durationWarned = true;
    console.warn(
      "⚠️ Master CSV row me duration column nahi mila. Keys:",
      keys.join(", ")
    );
  }

  return 0;
}

let durationWarned = false;

// Current CSV duration for an existing profile (0 if unknown)
function masterDuration(profile) {
  try {
    const wantedCollege = String(profile.collegeCode).padStart(3, "0");
    const wantedSubject = String(profile.subjectCode).padStart(4, "0");

    for (const file of masterCsvFiles()) {

      for (const row of getCsvRows(file)) {
        if (
          String(row.collegeCode).trim().padStart(3, "0") === wantedCollege &&
          String(row.subjectCode).trim().padStart(4, "0") === wantedSubject
        ) {
          return durationFromRow(row);
        }
      }
    }
  } catch (_) {}

  return 0;
}

function programOf(profile) {
  const d = masterDuration(profile) || Number(profile.duration) || 0;
  return computeProgram(profile.type, profile.regYY, d);
}

/*
=========================================================
PROGRAM / SESSION LOGIC
UG REG : 4 years (reg yr 24+), else 3
UG VOC : 3 years
PG     : 2 years
Session start (and portal session year) = reg year - 1
=========================================================
*/

function computeProgram(type, regYY, durationOverride) {
  const yy = Number(regYY);

  // Session start = registration year - 1 (reg 26 => 2025)
  // Duration still depends on the registration year (UG regular 24+ = 4 yrs).
  const startYear = 2000 + yy - 1;

  const [level, kind] = String(type).split(" ");

  let duration = 2;

  if (level === "UG") {
    duration = kind === "VOC" ? 3 : yy >= 24 ? 4 : 3;
  }

  // Course duration from the Master CSV wins.
  // Exception: UG REG before the 4-year scheme (reg yr < 24) stays 3 years,
  // because the CSV lists the current 4-year duration only.
  if (Number(durationOverride) >= 1) {
    const oldUgReg = level === "UG" && kind !== "VOC" && yy < 24;

    if (!oldUgReg) duration = Number(durationOverride);
  }

  return {
    type,
    level,
    kind,
    startYear,
    duration,
    portalYear: startYear,
    sessionLabel: `${startYear}-${String(startYear + duration).slice(-2)}`,
  };
}

/*
=========================================================
PORTAL OPTION PICKERS
=========================================================
*/

// Session / exam / course selection ab portal-map.js ke rules + scoring se hota hai.
const portalMap = require("./portal-map");

const fullScan = require("./full-scan");

const { pickSessions, pickExam, filterCourses, pickFirstCourse } = portalMap;

/*
=========================================================
PDF DOWNLOAD + NAME EXTRACTION
=========================================================
*/

async function downloadPdfBuffer(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length < 100 || buffer.subarray(0, 5).toString() !== "%PDF-") {
    throw new Error("Not a valid PDF");
  }

  return buffer;
}

function normKey(key) {
  return String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// extractResultDetails ke field naam alag ho sakte hain - fuzzy match.
function fuzzyField(details, kind) {
  if (!details || typeof details !== "object") {
    return "";
  }

  const entries = Object.entries(details).filter(
    ([, value]) => typeof value === "string" || typeof value === "number"
  );

  const exactNames =
    kind === "name"
      ? ["name", "studentname", "candidatename", "nameofstudent", "nameofcandidate"]
      : [
          "regno",
          "registrationno",
          "registrationnumber",
          "regnumber",
          "registration",
          "reg",
          "enrollmentno",
          "enrollmentnumber",
          "enrolmentno",
          "enrollment",
        ];

  for (const wanted of exactNames) {
    const hit = entries.find(([key]) => normKey(key) === wanted);

    if (hit && clean(hit[1])) {
      return clean(hit[1]);
    }
  }

  for (const [key, value] of entries) {
    const k = normKey(key);

    if (!clean(value)) {
      continue;
    }

    if (
      kind === "name" &&
      k.includes("name") &&
      !/(father|mother|guardian|college|course|subject|exam|paper|school|board|file|univ)/.test(k)
    ) {
      return clean(value);
    }

    if (kind === "reg" && k.includes("reg") && !k.includes("roll")) {
      return clean(value);
    }
  }

  return "";
}

// pdfjs-dist ke alag versions ke liye alag import path try karte hain.
async function loadPdfjs() {
  const paths = [
    "pdfjs-dist/legacy/build/pdf.mjs",
    "pdfjs-dist/legacy/build/pdf.js",
    "pdfjs-dist/build/pdf.mjs",
    "pdfjs-dist/build/pdf.js",
    "pdfjs-dist",
  ];

  let lastError = null;

  for (const modulePath of paths) {
    try {
      const mod = await import(modulePath);

      const getDocument = mod.getDocument || mod.default?.getDocument;

      if (typeof getDocument === "function") {
        return getDocument;
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`pdfjs-dist load failed: ${lastError?.message || "unknown"}`);
}

async function extractTextFromPdfFile(filePath, maxPages = 2) {
  const getDocument = await loadPdfjs();

  const data = new Uint8Array(await fs.promises.readFile(filePath));

  const doc = await getDocument({ data, useSystemFonts: true }).promise;

  let text = "";

  for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
    const page = await doc.getPage(i);

    const content = await page.getTextContent();

    text += " " + content.items.map((item) => item.str).join(" ");
  }

  return text.replace(/\s+/g, " ").trim();
}

async function extractIdentityFromText(filePath, roll) {
  try {
    const text = await extractTextFromPdfFile(filePath);

    const identity = parseIdentityText(text, roll);

    if (!identity.regNo) {
      const spots = [];

      const finder = /reg/gi;

      let hit;

      while ((hit = finder.exec(text)) && spots.length < 3) {
        spots.push(text.slice(Math.max(0, hit.index - 20), hit.index + 80));
      }

      log.debug(`Reg no not found in PDF text. Contexts: ${JSON.stringify(spots)}`);
    }

    return identity;
  } catch (error) {
    console.error("⚠️ PDF text fallback failed:", error.message);

    return { name: "", regNo: "" };
  }
}

function parseIdentityText(text, roll = "") {
  const stop =
    "(?=\\s+(?:father|mother|guardian|roll|reg|registration|course|college|session|semester|sem|exam|class|dob|date|sex|gender|category|centre|center)\\b|$)";

  const nameMatch = text.match(
    new RegExp(
      "(?:name\\s*of\\s*(?:the\\s*)?(?:student|candidate)|(?:student|candidate)['’]?s?\\s*name|\\bname)\\s*[:\\-]\\s*([A-Za-z][A-Za-z .']{2,60}?)" + stop,
      "i"
    )
  );

  // "Reg No", "Reg. No.", "Regn No", "Registration Number", "Registration No :" ...
  // value me kam se kam ek digit hona chahiye (taaki "Registered" jaise words na pakde jayein).
  const regPattern =
    /\breg(?:n|istration)?\.?\s*(?:no|number|num|#)?\.?\s*[:\-–]?\s*((?=[A-Z0-9\/\-]*\d)[A-Z0-9][A-Z0-9\/\-]{4,24})/gi;

  let regNo = "";

  let match;

  while ((match = regPattern.exec(text))) {
    const value = clean(match[1]);

    if (roll && value.includes(String(roll))) {
      continue;
    }

    regNo = value;

    break;
  }

  if (!regNo) {
    const enroll = text.match(
      /\benrol+ment\s*(?:no|number|num)?\.?\s*[:\-–]?\s*((?=[A-Z0-9\/\-]*\d)[A-Z0-9][A-Z0-9\/\-]{4,24})/i
    );

    if (enroll && !(roll && enroll[1].includes(String(roll)))) {
      regNo = clean(enroll[1]);
    }
  }

  return {
    name: nameMatch ? clean(nameMatch[1]) : "",
    regNo,
  };
}

async function readDetailsFromBuffer(buffer, roll) {
  const tmp = path.join(os.tmpdir(), `ppu-profile-${Date.now()}-${roll}.pdf`);

  await fs.promises.writeFile(tmp, buffer);

  try {
    let details = {};

    try {
      details = (await extractResultDetails(tmp)) || {};
    } catch (error) {
      console.error("⚠️ extractResultDetails failed:", error.message);
    }

    let name = fuzzyField(details, "name");

    let regNo = fuzzyField(details, "reg");

    if (!name || !regNo) {
      log.debug(`Profile: name="${name}" reg="${regNo}" - trying PDF text fallback`);

      const fallback = await extractIdentityFromText(tmp, roll);

      name = name || fallback.name;

      regNo = regNo || fallback.regNo;
    }

    return { name, regNo };
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

async function readDetailsFromPdf(url, roll) {
  return readDetailsFromBuffer(await downloadPdfBuffer(url), roll);
}

/*
=========================================================
FIND THE FIRST-SEMESTER RESULT ON PORTAL
=========================================================
*/

async function findFirstResult(program, stream, roll) {
  const sessions = await getSessions();

  const streams =
    program.level === "UG" && program.kind === "REG"
      ? [stream, ...STREAMS.filter((s) => s !== stream)]
      : [null];

async function findFirstResult(program, stream, roll) {
  const sessions = await getSessions();

  const streams =
    program.level === "UG" && program.kind === "REG"
      ? [stream, ...STREAMS.filter((s) => s !== stream)]
      : [null];

  let firstGuess = null;

  for (const session of pickSessions(sessions, program)) {
    let exam = null;

    let courses = [];

    try {
      exam = pickExam(await getExamTypes(session.value), program, session);

      if (!exam) {
        continue;
      }

      courses = await getCourses(session.value, exam.value);
    } catch (_) {
      continue;
    }

    for (const st of streams) {
      const course = pickFirstCourse(courses, program, st);

      if (!course) {
        continue;
      }

      const url = buildKnownPdfUrl({
        session: session.value,
        examType: exam.value,
        course: course.value,
        roll,
      });

      if (!firstGuess) {
        firstGuess = { session, exam, course, stream: st };
      }

      if (await verifyPdfDirect(url)) {
        portalMap.recordHit({ program, session, exam, course });

        return { session, exam, course, stream: st, url };
      }
    }
  }

  // Last resort: full portal check for the best guess.
  if (firstGuess) {
    try {
      const result = await checkResult({
        session: firstGuess.session.value,
        examType: firstGuess.exam.value,
        course: firstGuess.course.value,
        roll,
      });

      if (result && result.success && result.type === "pdf" && result.pdfUrl) {
        return { ...firstGuess, url: result.pdfUrl };
      }
    } catch (_) {}
  }

  // Aakhri raasta: saare session/exam/course combinations ka full scan.
  try {
    const scan = await fullScan.scanAll(roll, { firstOnly: true });

    const hit = scan.entries[0];

    if (hit) {
      return {
        session: hit.session,
        exam: hit.exam,
        course: hit.course,
        stream: null,
        url: hit.url,
      };
    }
  } catch (error) {
    console.error("⚠️ Full scan fallback failed:", error.message);
  }

  return null;
}

async function buildFromMatch(parsed, match) {
  const program = computeProgram(match.type, parsed.regYY, match.duration);

  const stream = college.getSubjectCategory({
    subject: match.subject,
    section: match.section,
  });

  const found = await findFirstResult(program, stream, parsed.roll);

  let details = { name: "", regNo: "" };

  if (found) {
    try {
      details = await readDetailsFromPdf(found.url, parsed.roll);
    } catch (error) {
      console.error("⚠️ Profile PDF read failed:", error.message);
    }
  }

  return { program, stream, found, details };
}

/*
=========================================================
CREATE PROFILE
=========================================================
*/

const MAX_ROLL_CHANGES = 5;
const BUILD_TIMEOUT_MS = 20000;

function rollChangesLeft(profile) {
  return Math.max(0, MAX_ROLL_CHANGES - Number((profile && profile.rollChanges) || 0));
}

async function createProfile({ telegramId, username, roll, unlimited = false }) {
  const parsed = parseRoll(roll);

  if (!parsed) {
    return { ok: false, message: "Roll number exactly 13 digits ka hona chahiye." };
  }

  const taken = store.getByRoll(parsed.roll);

  if (taken && String(taken.telegramId) !== String(telegramId)) {
    return {
      ok: false,
      message:
        "Ye roll number pehle se kisi aur account se linked hai. Galti lage to owner se sampark karein.",
    };
  }

  const prev = store.getByTelegramId(telegramId);

  // /delprofile ke baad naya profile: purana roll-change count aage chalta hai.
  const ledger = prev ? null : store.getLedger(telegramId);

  const isChange = Boolean(
    prev ? prev.roll !== parsed.roll : ledger && ledger.rollHash !== store.hashRoll(parsed.roll)
  );

  const usedChanges = Number((prev ? prev.rollChanges : ledger && ledger.rollChanges) || 0);

  if (isChange && !unlimited && MAX_ROLL_CHANGES - usedChanges <= 0) {
    return {
      ok: false,
      limitReached: true,
      message: `Roll number badalne ki limit (${MAX_ROLL_CHANGES} baar) khatam ho gayi hai. Ab roll number nahi badla ja sakta.`,
    };
  }

  const matches = findCsvMatches(parsed);

  if (!matches.length) {
    return {
      ok: false,
      message:
        "Is roll number ka college code / subject code hamare records (CSV) mein nahi mila. Roll number dobara check karein.",
    };
  }

  const resolveChosen = async () => {
    let best = null;

    for (const m of matches) {
      const b = await buildFromMatch(parsed, m);

      if (b.found) {
        return { match: m, built: b };
      }

      if (!best) {
        best = { match: m, built: b };
      }
    }

    return best;
  };

  // Portal lookup can be slow: wait only BUILD_TIMEOUT_MS, then create the
  // profile from the Master CSV (name pending) and finish the lookup in background.
  const lookup = resolveChosen();

  lookup.catch(() => {});

  const TIMED_OUT = Symbol("timeout");

  let timer;

  const raced = await Promise.race([
    lookup,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), BUILD_TIMEOUT_MS);
    }),
  ]).catch(() => TIMED_OUT);

  clearTimeout(timer);

  let chosen = raced;

  const timedOut = raced === TIMED_OUT;

  if (timedOut) {
    const m = matches[0];

    chosen = {
      match: m,
      built: {
        program: computeProgram(m.type, parsed.regYY, m.duration),
        stream: college.getSubjectCategory({
          subject: m.subject,
          section: m.section,
        }),
        found: null,
        details: { name: "", regNo: "" },
      },
    };
  }

  const { match, built } = chosen;

  const portal = built.found
    ? {
        session: built.found.session.value,
        sessionText: built.found.session.text,
        examType: built.found.exam.value,
        examTypeText: built.found.exam.text,
        course: built.found.course.value,
        courseText: built.found.course.text,
      }
    : null;

  const profile = {
    telegramId: String(telegramId),
    username: username || "",
    roll: parsed.roll,
    regYY: parsed.regYY,
    regNo: built.details.regNo || "",
    name: built.details.name || "",
    namePending: !built.details.name,
    collegeCode: match.collegeCode,
    collegeName: match.collegeName,
    subject: match.subject,
    subjectCode: match.subjectCode,
    csvFile: match.file,
    type: match.type,
    stream: built.found ? built.found.stream || built.stream : built.stream,
    duration: built.program.duration,
    sessionLabel: built.program.sessionLabel,
    portal,
    locker: isChange || !prev ? {} : prev.locker || {},
    rollChanges: usedChanges + (isChange ? 1 : 0),
    createdAt: (prev && prev.createdAt) || new Date().toISOString(),
  };

  await store.save(profile);

  if (ledger) await store.clearLedger(telegramId);

  if (timedOut) {
    lookup
      .then(async (res) => {
        if (!res) return;

        const current = store.getByTelegramId(telegramId);

        if (!current || current.roll !== parsed.roll) return;

        const { built: b } = res;

        if (b.found) {
          current.portal = {
            session: b.found.session.value,
            sessionText: b.found.session.text,
            examType: b.found.exam.value,
            examTypeText: b.found.exam.text,
            course: b.found.course.value,
            courseText: b.found.course.text,
          };

          current.stream = b.found.stream || b.stream || current.stream;
        }

        if (b.details && b.details.name) {
          current.name = b.details.name;
          current.regNo = current.regNo || b.details.regNo || "";
          current.namePending = false;
        }

        await store.save(current);
      })
      .catch(() => {});
  }

  return { ok: true, profile };
}

// Retry name extraction for profiles whose result was not available earlier.
async function refreshPendingName(profile) {
  if (!profile || !profile.namePending) {
    return profile;
  }

  try {
    const parsed = parseRoll(profile.roll);

    const built = await buildFromMatch(parsed, {
      type: profile.type,
      subject: profile.subject,
      section: profile.type,
      duration: masterDuration(profile) || Number(profile.duration) || 0,
    });

    if (built.details.name) {
      profile.name = built.details.name;

      profile.regNo = profile.regNo || built.details.regNo;

      profile.namePending = false;

      await store.save(profile);
    }
  } catch (_) {}

  return profile;
}

/*
=========================================================
PROFILE TEXT (user-facing: name, roll, reg no, college, session)
=========================================================
*/

function sessionLabelOf(profile) {
  if (profile.sessionManual && profile.sessionLabel) {
    return profile.sessionLabel;
  }

  try {
    return programOf(profile).sessionLabel;
  } catch (_) {
    return profile.sessionLabel || "—";
  }
}

function formatProfile(profile) {
  return (
    `👤 <b>My Profile</b>\n\n` +
    `👨‍🎓 Name: <b>${escapeHtml(profile.name || "Not available yet")}</b>\n` +
    `🧾 Roll No: <code>${escapeHtml(profile.roll)}</code>\n` +
    `🪪 Registration No: <b>${escapeHtml(profile.regNo || "—")}</b>\n` +
    `🏫 College: <b>${escapeHtml(profile.collegeCode)} ${escapeHtml(
      profile.collegeName
    )}</b>\n` +
    `📚 Subject: <b>${escapeHtml(profile.subject || "—")}</b>\n` +
    `📅 Session: <b>${escapeHtml(sessionLabelOf(profile))}</b>`
  );
}

function formatProfileForOwner(profile) {
  return (
    `${formatProfile(profile)}\n\n` +
    `<b>Owner details</b>\n` +
    `🆔 Telegram ID: <code>${escapeHtml(profile.telegramId)}</code>\n` +
    `📂 CSV: ${escapeHtml(profile.csvFile)} (${escapeHtml(profile.type)})\n` +
    `🔢 Subject Code: ${escapeHtml(profile.subjectCode)}\n` +
    `🎓 Stream: ${escapeHtml(profile.stream || "-")}\n` +
    `🌐 Portal: ${escapeHtml(profile.portal?.sessionText || "-")} / ${escapeHtml(
      profile.portal?.examTypeText || "-"
    )} / ${escapeHtml(profile.portal?.courseText || "-")}`
  );
}

/*
=========================================================
LOCKER
=========================================================
*/

async function scanLockerTargeted(profile) {
  const base = programOf(profile);

  const sessions = await getSessions();

  const lastYear = new Date().getFullYear() + 1;

  const years = [];

  if (base.level === "PG") {
    years.push(base.portalYear);
  } else {
    for (let i = 0; i < base.duration; i++) {
      if (base.portalYear + i <= lastYear) {
        years.push(base.portalYear + i);
      }
    }
  }

  /*
=========================================================
LEGACY LOCKER (session 2023 se pehle, UG REG / UG VOC = 3 saal)
YEAR-XXXX -> Regular / Vocational -> Part-I, II, III
Catalog (combo-catalog.json) se chalta hai, portal dropdown dobara nahi kholta.
=========================================================
*/

function isLegacyUg(profile) {
  try {
    const base = programOf(profile);
    return base.level === "UG" && base.startYear < 2023;
  } catch (_) {
    return false;
  }
}

// "B.A.Hons.(Part-I)" / "PART-1" / "Part-III" -> 1, 2, 3 (Part na ho to 0)
function partNo(text) {
  const m = clean(text).match(/part[\s._-]*(iii|ii|i|3|2|1)(?![a-z0-9])/i);

  return m ? { i: 1, ii: 2, iii: 3, 1: 1, 2: 2, 3: 3 }[m[1].toLowerCase()] : 0;
}

async function scanLegacyCore(program, stream, roll) {
  await fullScan.ensureCatalog();

  const lastYear = new Date().getFullYear() + 1;

  const wantExam = program.kind === "VOC" ? "vocational" : "regular";

  const combos = fullScan.listCombos().filter((c) => {
    const m = /^YEAR-(\d{4})$/i.exec(clean(c.session.value));

    if (!m) return false;

    const year = Number(m[1]);

    if (year < program.startYear || year > Math.min(program.startYear + 4, lastYear)) {
      return false;
    }

    if (clean(c.exam.value).toLowerCase() !== wantExam) return false;

    return partNo(c.course.text) > 0;
  });

  const groups =
    program.kind === "VOC"
      ? [null]
      : [stream, ...STREAMS.filter((s) => s !== stream)].filter(Boolean);

  for (const group of groups) {
    const entries = [];

    const seen = new Set();

    const candidates = combos
      .filter((c) => group === null || portalMap.classifyCourse(c.course).stream === group)
      .map((c) => ({
        ...c,
        part: partNo(c.course.text),
        url: buildKnownPdfUrl({
          session: c.session.value,
          examType: c.exam.value,
          course: c.course.value,
          roll,
        }),
      }));

    await pool(6, candidates, async (c) => {
      if (!c.url || seen.has(c.url)) return;

      if (await verifyPdfDirect(c.url)) {
        seen.add(c.url);

        entries.push({
          url: c.url,
          label: `${clean(c.course.text)} • ${clean(c.session.text)}`,
          yearIndex: c.part - 1,
          seq: c.part,
          session: c.session,
          exam: c.exam,
          course: c.course,
          stream: group,
        });
      }
    });

    if (entries.length) {
      return entries.sort((a, b) => a.seq - b.seq || a.label.localeCompare(b.label));
    }
  }

  return [];
}

// Locker: 2023 se pehle ke UG ke liye legacy sequence, baaki sab pehle jaisa.
async function scanLocker(profile) {
  if (isLegacyUg(profile)) {
    try {
      const legacy = await scanLegacyCore(programOf(profile), profile.stream, profile.roll);

      if (legacy.length) return legacy;
    } catch (error) {
      console.error("⚠️ Legacy locker scan failed, normal scan use ho raha hai:", error.message);
    }
  }

  if (String(process.env.LOCKER_FULL_SCAN || "1") !== "0") {
    try {
      const scan = await fullScan.scanAll(profile.roll);

      if (scan.entries.length) {
        return scan.entries.map((entry) => ({
          url: entry.url,
          label: entry.label,
          yearIndex: entry.startYear,
          seq: entry.seq,
        }));
      }
    } catch (error) {
      console.error("⚠️ Full locker scan failed, targeted scan use ho raha hai:", error.message);
    }
  }

  return scanLockerTargeted(profile);
}

  const entries = [];

  const seen = new Set();

  for (let yearIndex = 0; yearIndex < years.length; yearIndex++) {
    const program = { ...base, portalYear: years[yearIndex] };

    for (const session of pickSessions(sessions, program)) {
      let exam = null;

      let courses = [];

      try {
        exam = pickExam(await getExamTypes(session.value), program, session);

        if (!exam) {
          continue;
        }

        courses = await getCourses(session.value, exam.value);
      } catch (_) {
        continue;
      }

      const candidates = filterCourses(courses, program, profile.stream).map(
        (course) => ({
          course,
          url: buildKnownPdfUrl({
            session: session.value,
            examType: exam.value,
            course: course.value,
            roll: profile.roll,
          }),
        })
      );

      await pool(6, candidates, async (candidate) => {
        if (!candidate.url || seen.has(candidate.url)) {
          return;
        }

        if (await verifyPdfDirect(candidate.url)) {
          seen.add(candidate.url);

          portalMap.recordHit({ program, session, exam, course: candidate.course });

          entries.push({
            url: candidate.url,
            label: `${clean(candidate.course.text)} • ${clean(session.text)}`,
            yearIndex,
            seq: courseSeq(candidate.course.text) || 0,
          });
        }
      });
    }
  }

  return entries.sort(
    (a, b) => a.yearIndex - b.yearIndex || a.seq - b.seq || a.label.localeCompare(b.label)
  );
}

// Locker: har baar saare combinations scan (LOCKER_FULL_SCAN=0 se purana targeted scan).
async function scanLocker(profile) {
  if (String(process.env.LOCKER_FULL_SCAN || "1") !== "0") {
    try {
      const scan = await fullScan.scanAll(profile.roll);

      if (scan.entries.length) {
        return scan.entries.map((entry) => ({
          url: entry.url,
          label: entry.label,
          yearIndex: entry.startYear,
          seq: entry.seq,
        }));
      }
    } catch (error) {
      console.error("⚠️ Full locker scan failed, targeted scan use ho raha hai:", error.message);
    }
  }

  return scanLockerTargeted(profile);
}

async function sendLocker(bot, chatId, profile, options = {}) {
  const channelId = options.channelId || "";

  const entries = await scanLocker(profile);

  if (!profile.locker || typeof profile.locker !== "object") {
    profile.locker = {};
  }

  let sent = 0;

  // Har locker result ki ek copy channel par bhi (ek file sirf ek baar).
  const copyToChannel = async (entry, message) => {
    if (!channelId || !message?.message_id) {
      return;
    }

    const record = profile.locker[entry.url];

    if (!record || record.channelSent) {
      return;
    }

    try {
      await bot.copyMessage(channelId, chatId, message.message_id, {
        caption:
          `📄 ${escapeHtml(entry.label)}\n` +
          `👨‍🎓 <b>${escapeHtml(profile.name || "-")}</b>\n` +
          `🧾 <code>${escapeHtml(profile.roll)}</code>`,
        parse_mode: "HTML",
      });

      record.channelSent = true;
    } catch (error) {
      console.error(`⚠️ Channel copy failed (${entry.label}):`, error.message);
    }
  };

  const needsIdentity = () => !profile.name || !profile.regNo;

  const learnIdentity = async (buffer) => {
    if (!needsIdentity()) {
      return;
    }

    try {
      const found = await readDetailsFromBuffer(buffer, profile.roll);

      if (found.name && !profile.name) {
        profile.name = found.name;

        profile.namePending = false;
      }

      if (found.regNo && !profile.regNo) {
        profile.regNo = found.regNo;
      }
    } catch (error) {
      console.error("⚠️ Locker identity read failed:", error.message);
    }
  };

  // Jin PDFs ka file_id nahi hai unhe pehle se parallel download karo (send order same rahega).
  const prefetched = new Map();

  const toFetch = entries.filter((e) => !(profile.locker[e.url] && profile.locker[e.url].fileId));

  const startPrefetch = async () => {
    await pool(4, toFetch, async (entry) => {
      const task = downloadPdfBuffer(entry.url);

      task.catch(() => {});

      prefetched.set(entry.url, task);

      await task.catch(() => {});
    });
  };

  const prefetchAll = startPrefetch();

  prefetchAll.catch(() => {});

  for (const entry of entries) {
    const caption = `📄 ${escapeHtml(entry.label)}`;

    const saved = profile.locker[entry.url];

    try {
      if (saved && saved.fileId) {
        try {
          const resent = await bot.sendDocument(chatId, saved.fileId, {
            caption,
            parse_mode: "HTML",
          });

          sent++;

          await copyToChannel(entry, resent);

          continue;
        } catch (_) {
          // file_id stale - download again below
        }
      }

      let buffer;

      // prefetch pool entry bane tak thoda ruko, warna seedha download.
      for (let i = 0; i < 50 && !prefetched.has(entry.url) && toFetch.includes(entry); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }

      buffer = prefetched.has(entry.url)
        ? await prefetched.get(entry.url).catch(() => downloadPdfBuffer(entry.url))
        : await downloadPdfBuffer(entry.url);

      prefetched.delete(entry.url);

      await learnIdentity(buffer);

      const message = await bot.sendDocument(
        chatId,
        buffer,
        { caption, parse_mode: "HTML" },
        {
          filename: `${profile.roll}_${safeName(entry.label)}.pdf`,
          contentType: "application/pdf",
        }
      );

      profile.locker[entry.url] = {
        label: entry.label,
        fileId: message?.document?.file_id || null,
        channelSent: false,
      };

      sent++;

      await copyToChannel(entry, message);
    } catch (error) {
      console.error(`⚠️ Locker send failed (${entry.label}):`, error.message);
    }
  }

  // Saare PDFs file_id se gaye ho to bhi naam / reg no seekh lo.
  if (needsIdentity() && entries.length) {
    try {
      await learnIdentity(await downloadPdfBuffer(entries[0].url));
    } catch (_) {}
  }

  await store.save(profile);

  return { sent, total: entries.length };
}

/*
=========================================================
OWNER DEBUG: locker scan ka step-by-step trace
=========================================================
*/

async function traceLocker(profile) {
  const lines = [];

  const base = programOf(profile);

  lines.push(
    `roll=${profile.roll} type=${profile.type} regYY=${profile.regYY} stream=${profile.stream || "-"}`
  );

  lines.push(
    `portalYear=${base.portalYear} duration=${base.duration} sessionLabel=${base.sessionLabel}`
  );

  const sessions = await getSessions();

  lines.push(`portal sessions: ${sessions.length}`);

  const years = [];

  if (base.level === "PG") {
    years.push(base.portalYear);
  } else {
    for (let i = 0; i < base.duration; i++) {
      years.push(base.portalYear + i);
    }
  }

  for (const year of years) {
    const program = { ...base, portalYear: year };

    const picked = pickSessions(sessions, program);

    lines.push(
      `\nyear ${year}: matched sessions = ${
        picked.length
          ? picked.map((o) => `"${clean(o.text)}"`).join(", ")
          : "NONE"
      }`
    );

    if (!picked.length) {
      lines.push(
        `all sessions: ${sessions.map((o) => clean(o.text)).join(" | ").slice(0, 500)}`
      );

      continue;
    }

    for (const session of picked) {
      let exams = [];

      try {
        exams = await getExamTypes(session.value);
      } catch (error) {
        lines.push(`  exam types failed: ${error.message}`);

        continue;
      }

      const exam = pickExam(exams, program, session);

      lines.push(
        `  exam options: ${exams.map((o) => `"${clean(o.text)}"`).join(", ")}`
      );

      lines.push(`  picked exam: ${exam ? `"${clean(exam.text)}"` : "NONE"}`);

      if (!exam) {
        continue;
      }

      let courses = [];

      try {
        courses = await getCourses(session.value, exam.value);
      } catch (error) {
        lines.push(`  courses failed: ${error.message}`);

        continue;
      }

      const usable = filterCourses(courses, program, profile.stream);

      lines.push(
        `  courses: ${courses.length}, usable after filter: ${usable.length} -> ${usable
          .slice(0, 8)
          .map((o) => `"${clean(o.text)}"`)
          .join(", ")}`
      );

      for (const course of usable.slice(0, 2)) {
        const url = buildKnownPdfUrl({
          session: session.value,
          examType: exam.value,
          course: course.value,
          roll: profile.roll,
        });

        const ok = await verifyPdfDirect(url);

        lines.push(`  ${ok ? "FOUND" : "miss "} ${url}`);
      }
    }
  }

  return lines.join("\n");
}

/*
=========================================================
OWNER DEBUG: PDF ka raw text + extractor output
=========================================================
*/

async function debugProfilePdf(profile) {
  const urls = Object.keys(profile.locker || {});

  let url = urls[0];

  if (!url) {
    const entries = await scanLocker(profile);

    url = entries[0]?.url;
  }

  if (!url) {
    return "Is profile ke liye abhi koi result PDF nahi mila.";
  }

  const buffer = await downloadPdfBuffer(url);

  const tmp = path.join(os.tmpdir(), `ppu-debug-${Date.now()}.pdf`);

  await fs.promises.writeFile(tmp, buffer);

  try {
    let details = {};

    try {
      details = (await extractResultDetails(tmp)) || {};
    } catch (error) {
      details = { error: error.message };
    }

    let text = "";

    try {
      text = await extractTextFromPdfFile(tmp);
    } catch (error) {
      text = `(text read failed: ${error.message})`;
    }

    return (
      `URL: ${url}\n\n` +
      `extractResultDetails keys: ${Object.keys(details).join(", ")}\n` +
      `fuzzy name: "${fuzzyField(details, "name")}" | fuzzy reg: "${fuzzyField(details, "reg")}"\n` +
      `text parse: ${JSON.stringify(parseIdentityText(text, profile.roll))}\n\n` +
      `TEXT (first 1800 chars):\n${text.slice(0, 1800)}`
    );
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

module.exports = {
  traceLocker,
  debugProfilePdf,
  parseRoll,
  classifyCsv,
  findCsvMatches,
  computeProgram,
  rollChangesLeft,
  MAX_ROLL_CHANGES,
  programOf,
  isMasterCsv,
  parseDurationYears,
  pickSessions,
  pickExam,
  pickFirstCourse,
  courseSeq,
  createProfile,
  fuzzyField,
  parseIdentityText,
  refreshPendingName,
  formatProfile,
  formatProfileForOwner,
  sendLocker,
  fullScanReportChunks: (roll) => fullScan.scanReportChunks(roll),
};