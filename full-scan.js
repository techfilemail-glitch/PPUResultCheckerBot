/*
=========================================================
FULL SCAN  (notification-bot jaisa: har baar SAARE combinations)

Kaam:
  1. Portal ke saare Session -> Exam Type -> Course ka catalog banata hai
     (combo-catalog.json mein cache; dropdown-cache.json se bhi seed leta hai).
  2. Ek roll number ke liye har combination ka PDF link banata hai.
  3. Sab links ko parallel verify karta hai (verifyPdfDirect).
  4. Jo links asli PDF dete hain unki poori list wapas karta hai.

Koi "guess" / program filter nahi - isliye UG/PG/VOC/naya format,
sab apne aap mil jaata hai.

ENV (optional)
  FULLSCAN_CONCURRENCY          default 8   (PDF verify parallel)
  FULLSCAN_CATALOG_CONCURRENCY  default 2   (portal dropdown fetch parallel)
  FULLSCAN_RECENT_TTL_MIN       default 360 (naye sessions ka course list kitni der taaza)
  FULLSCAN_OLD_TTL_HOURS        default 168 (purane sessions ka)
  PORTAL_CATALOG                catalog file ka path
=========================================================
*/

const fs = require("fs");
const path = require("path");
const log = require("./logger");

const CATALOG_FILE = process.env.PORTAL_CATALOG
  ? path.resolve(process.env.PORTAL_CATALOG)
  : path.join(__dirname, "combo-catalog.json");

const DROPDOWN_CACHE_FILE = path.join(__dirname, "dropdown-cache.json");

const SCAN_CONCURRENCY = Math.max(1, Number(process.env.FULLSCAN_CONCURRENCY) || 24);
const CATALOG_CONCURRENCY = Math.max(1, Number(process.env.FULLSCAN_CATALOG_CONCURRENCY) || 2);
const RECENT_TTL = (Number(process.env.FULLSCAN_RECENT_TTL_MIN) || 360) * 60 * 1000;
const OLD_TTL = (Number(process.env.FULLSCAN_OLD_TTL_HOURS) || 168) * 3600 * 1000;

let apiOverride = null; // tests

function api() {
  return apiOverride || require("./result-checker");
}

function _setApi(mock) {
  apiOverride = mock;
}

/*
---------------------------------------------------------
HELPERS
---------------------------------------------------------
*/

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function opt(item) {
  if (!item) return null;

  if (typeof item === "string") {
    const v = clean(item);
    return v ? { value: v, text: v } : null;
  }

  const value = clean(item.value ?? item.text);
  const text = clean(item.text ?? item.value);

  if (!value || item.disabled) return null;

  return { value, text: text || value };
}

function normList(list) {
  const seen = new Set();
  const out = [];

  for (const item of Array.isArray(list) ? list : []) {
    const o = opt(item);

    if (o && !seen.has(o.value)) {
      seen.add(o.value);
      out.push(o);
    }
  }

  return out;
}

async function pool(limit, items, worker) {
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;

      if (index >= items.length) return;

      await worker(items[index], index);
    }
  });

  await Promise.all(runners);
}

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

function courseSeq(text) {
  const value = clean(text);

  let m = value.match(/(?:sem(?:ester)?|part|year)[\s\-_(]*([ivx]+|\d+)(?![a-z0-9])/i);

  if (!m) m = value.match(/[\s\-_]([ivx]+|\d+)\)?$/i);

  if (!m) m = value.match(/[a-z]{2,}(\d+)$/i);

  if (!m) return 0;

  return /^\d+$/.test(m[1]) ? Number(m[1]) : romanToNumber(m[1]);
}

// Session label se start year: "SEMESTER(2025-27)" -> 2025, "YEAR-2024" -> 2024
function sessionStartYear(text) {
  const m =
    String(text).match(/(?<!\d)((?:19|20)?\d{2})\s*(?:-|–|to)\s*(?:19|20)?\d{2}(?!\d)/i) ||
    String(text).match(/(?<!\d)(20\d{2})(?!\d)/);

  if (!m) return 0;

  const n = Number(m[1]);

  return n < 100 ? 2000 + n : n;
}

/*
---------------------------------------------------------
CATALOG  (sessions / exams / courses)
---------------------------------------------------------
*/

let catalog = { sessions: [], sessionsT: 0, exams: {}, courses: {}, failed: [] };

function loadCatalogFile() {
  try {
    if (fs.existsSync(CATALOG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));

      if (parsed && typeof parsed === "object") {
        catalog = {
          sessions: normList(parsed.sessions),
          sessionsT: Number(parsed.sessionsT) || 0,
          exams: parsed.exams && typeof parsed.exams === "object" ? parsed.exams : {},
          courses: parsed.courses && typeof parsed.courses === "object" ? parsed.courses : {},
          failed: [],
        };
      }
    }
  } catch (error) {
    console.error("⚠️ combo-catalog load failed:", error.message);
  }
}

// index.js ka dropdown-cache.json ek baar seed ke liye (t=0 => jaldi refresh hoga).
function seedFromDropdownCache() {
  try {
    if (!fs.existsSync(DROPDOWN_CACHE_FILE)) return;

    const raw = JSON.parse(fs.readFileSync(DROPDOWN_CACHE_FILE, "utf8"));

    if (!catalog.sessions.length) {
      catalog.sessions = normList(raw.sessions);
    }

    const eachEntry = (node, fn) => {
      if (Array.isArray(node)) {
        for (const item of node) fn(item.key, item.data);
      } else if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) fn(key, Array.isArray(value) ? value : value?.data);
      }
    };

    eachEntry(raw.exams, (key, data) => {
      if (key && !catalog.exams[key]) catalog.exams[key] = { t: 0, list: normList(data) };
    });

    eachEntry(raw.courses, (key, data) => {
      if (key && !catalog.courses[key]) catalog.courses[key] = { t: 0, list: normList(data) };
    });
  } catch (_) {}
}

let saveChain = Promise.resolve();

function saveCatalog() {
  saveChain = saveChain
    .then(async () => {
      const tmp = CATALOG_FILE + ".tmp";

      await fs.promises.writeFile(
        tmp,
        JSON.stringify(
          {
            sessions: catalog.sessions,
            sessionsT: catalog.sessionsT,
            exams: catalog.exams,
            courses: catalog.courses,
          },
          null,
          1
        ),
        "utf8"
      );

      await fs.promises.rename(tmp, CATALOG_FILE);
    })
    .catch((error) => console.error("⚠️ combo-catalog save failed:", error.message));

  return saveChain;
}

loadCatalogFile();
seedFromDropdownCache();

function ttlFor(sessionText) {
  const year = sessionStartYear(sessionText);
  const recent = year >= new Date().getFullYear() - 4;

  return recent ? RECENT_TTL : OLD_TTL;
}

// Khaali list (portal ne kuch diya hi nahi) bhi "fresh" maani jaati hai, warna har scan par dobara fetch hota hai.
function fresh(entry, sessionText) {
  return !!entry && Date.now() - entry.t < ttlFor(sessionText);
}

let catalogDirty = false;
let lastEnsureAt = 0;
const ENSURE_THROTTLE = 5 * 60 * 1000;

let catalogBuild = null;

// Sab missing / purane dropdowns portal se laata hai. Ek time par ek hi build chalta hai.
async function ensureCatalog({ refresh = false } = {}) {
  if (catalogBuild) return catalogBuild;

  // Har scan par poora catalog loop dobara chalane ki zaroorat nahi.
  if (!refresh && lastEnsureAt && Date.now() - lastEnsureAt < ENSURE_THROTTLE) {
    return catalog;
  }

  catalogBuild = (async () => {
    const failed = [];
    const checker = api();

    // 1. sessions
    try {
      const live = normList(await checker.getSessions());

      if (live.length) {
        const changed =
          live.map((x) => x.value).join("|") !== catalog.sessions.map((x) => x.value).join("|");

        catalog.sessions = live;
        catalog.sessionsT = Date.now();

        if (changed) catalogDirty = true;
      }
    } catch (error) {
      failed.push(`sessions: ${error.message}`);
    }

    // 2. exam types per session
    await pool(CATALOG_CONCURRENCY, catalog.sessions, async (session) => {
      const key = session.value;

      if (!refresh && fresh(catalog.exams[key], session.text)) return;

      try {
        const list = normList(await checker.getExamTypes(key));

        if (list.length) {
          catalog.exams[key] = { t: Date.now(), list };
          catalogDirty = true;
        } else if (!catalog.exams[key] || !catalog.exams[key].list.length) {
          catalog.exams[key] = { t: Date.now(), list: [], empty: true };
          catalogDirty = true;
        }
      } catch (error) {
        failed.push(`exams[${key}]: ${error.message}`);
      }
    });

    // 3. courses per session+exam
    const jobs = [];

    for (const session of catalog.sessions) {
      for (const exam of catalog.exams[session.value]?.list || []) {
        jobs.push({ session, exam, key: `${session.value}|||${exam.value}` });
      }
    }

    await pool(CATALOG_CONCURRENCY, jobs, async ({ session, exam, key }) => {
      if (!refresh && fresh(catalog.courses[key], session.text)) return;

      try {
        const list = normList(await checker.getCourses(session.value, exam.value));

        if (list.length) {
          catalog.courses[key] = { t: Date.now(), list };
          catalogDirty = true;
        } else if (!catalog.courses[key] || !catalog.courses[key].list.length) {
          catalog.courses[key] = { t: Date.now(), list: [], empty: true };
          catalogDirty = true;
        }
      } catch (error) {
        failed.push(`courses[${key}]: ${error.message}`);
      }
    });

    catalog.failed = failed;

    lastEnsureAt = Date.now();

    if (catalogDirty) {
      catalogDirty = false;
      await saveCatalog();
    }

    if (failed.length) {
      log.debug(`full-scan catalog: ${failed.length} dropdown fetch(es) failed`);
    }

    return catalog;
  })().finally(() => {
    catalogBuild = null;
  });

  return catalogBuild;
}

// Catalog se saare combos (url nahi, sirf structure).
function listCombos() {
  const combos = [];

  for (const session of catalog.sessions) {
    const startYear = sessionStartYear(session.text);

    for (const exam of catalog.exams[session.value]?.list || []) {
      const courses = catalog.courses[`${session.value}|||${exam.value}`]?.list || [];

      for (const course of courses) {
        combos.push({
          session,
          exam,
          course,
          startYear,
          seq: courseSeq(course.text),
        });
      }
    }
  }

  return combos;
}

/*
---------------------------------------------------------
SCAN
---------------------------------------------------------
roll  : 13 digit roll number
opts  : { firstOnly, onFound(entry), refreshCatalog, concurrency }
return: { entries:[{url,label,session,exam,course,startYear,seq}], total, checked, failed }
---------------------------------------------------------
*/

async function scanAllUncached(roll, opts = {}) {
  const cleanRoll = String(roll || "").trim();

  if (!/^\d{6,20}$/.test(cleanRoll)) {
    throw new Error("Invalid roll number");
  }

  await ensureCatalog({ refresh: !!opts.refreshCatalog });

  const checker = api();

  // Roll ke registration year (pehle 2 digit) ke aas-paas ke sessions pehle - sirf order, filter nahi.
  const regYear = 2000 + Number(cleanRoll.slice(0, 2));

  // Pruning: jis session ka start year roll ke registration year se 2+ saal pehle ka ho,
  // us roll ka result usme ho hi nahi sakta. Year na pehchane to session rakho.
  const combos = listCombos()
    .filter((c) => opts.noPrune || true)
    .map((c) => ({
      ...c,
      url: checker.buildKnownPdfUrl({
        session: c.session.value,
        examType: c.exam.value,
        course: c.course.value,
        roll: cleanRoll,
      }),
    }))
    .filter((c) => c.url);

  // duplicate URL hata do
  const seenUrl = new Set();

  const unique = combos.filter((c) => (seenUrl.has(c.url) ? false : (seenUrl.add(c.url), true)));

  unique.sort(
    (a, b) =>
      Math.abs(a.startYear - (regYear - 1)) - Math.abs(b.startYear - (regYear - 1)) ||
      a.seq - b.seq
  );

  const entries = [];

  let checked = 0;

  let stop = false;

  await pool(opts.concurrency || SCAN_CONCURRENCY, unique, async (combo) => {
    if (stop) return;

    let ok = false;

    try {
      ok = await checker.verifyPdfDirect(combo.url);
    } catch (_) {}

    checked++;

    if (!ok) return;

    const entry = {
      url: combo.url,
      label: `${combo.course.text} • ${combo.session.text}`,
      session: combo.session,
      exam: combo.exam,
      course: combo.course,
      startYear: combo.startYear,
      seq: combo.seq,
    };

    entries.push(entry);

    if (typeof opts.onFound === "function") {
      try {
        opts.onFound(entry);
      } catch (_) {}
    }

    if (opts.firstOnly) stop = true;
  });

  entries.sort(
    (a, b) => a.startYear - b.startYear || a.seq - b.seq || a.label.localeCompare(b.label)
  );

  return {
    entries,
    total: unique.length,
    checked,
    failed: catalog.failed.slice(),
  };
}

const SCAN_CACHE_MS = (Number(process.env.FULLSCAN_CACHE_MIN) || 10) * 60 * 1000;

const scanCache = new Map(); // roll -> { at, result }

const scanInflight = new Map(); // roll -> Promise

// Same roll ka scan 10 min tak reuse + parallel duplicate requests ek hi scan share karte hain.
async function scanAll(roll, opts = {}) {
  const key = String(roll || "").trim();

  const cacheable = !opts.firstOnly && !opts.onFound && !opts.refreshCatalog && !opts.noPrune;

  if (!cacheable) return scanAllUncached(roll, opts);

  const hit = scanCache.get(key);

  if (hit && Date.now() - hit.at < SCAN_CACHE_MS) return hit.result;

  if (scanInflight.has(key)) return scanInflight.get(key);

  const promise = scanAllUncached(roll, opts)
    .then((result) => {
      scanCache.set(key, { at: Date.now(), result });

      return result;
    })
    .finally(() => scanInflight.delete(key));

  scanInflight.set(key, promise);

  return promise;
}

/*
---------------------------------------------------------
REPORT (owner command ke liye)
---------------------------------------------------------
*/

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Telegram message limit ke hisaab se chunks (HTML).
async function scanReportChunks(roll, opts = {}) {
  const result = await scanAll(roll, opts);

  const head =
    `🔎 <b>Full scan</b> — <code>${escapeHtml(roll)}</code>\n` +
    `Combinations checked: <b>${result.checked}/${result.total}</b>\n` +
    `PDF mile: <b>${result.entries.length}</b>` +
    (result.failed.length ? `\n⚠️ Dropdown fetch fail: ${result.failed.length}` : "");

  if (!result.entries.length) {
    const failedLines = result.failed.slice(0, 8).map((f) => `• ${escapeHtml(f).slice(0, 160)}`);

    return [head + (failedLines.length ? `\n\n${failedLines.join("\n")}` : "")];
  }

  const lines = result.entries.map(
    (e, i) =>
      `${i + 1}. <a href="${escapeHtml(e.url)}">${escapeHtml(e.label)}</a>\n<code>${escapeHtml(e.url)}</code>`
  );

  const chunks = [];

  let current = head;

  for (const line of lines) {
    if ((current + "\n\n" + line).length > 3800) {
      chunks.push(current);
      current = line;
    } else {
      current += "\n\n" + line;
    }
  }

  chunks.push(current);

  return chunks;
}

// /delprofile: is roll ka cached scan hata do.
function forgetRoll(roll) {
  scanCache.delete(String(roll || "").trim());
}

module.exports = {
  forgetRoll,
  scanAll,
  ensureCatalog,
  listCombos,
  scanReportChunks,
  courseSeq,
  sessionStartYear,
  _setApi,
};

// CLI: node full-scan.js <roll>
if (require.main === module) {
  const roll = process.argv[2];

  if (!roll) {
    console.log("Usage: node full-scan.js <roll>");
    process.exit(1);
  }

  require("dotenv").config();

  scanAll(roll, { onFound: (e) => console.log("FOUND", e.label, "\n      ", e.url) })
    .then((r) => {
      console.log(`\nchecked ${r.checked}/${r.total}, found ${r.entries.length}`);

      if (r.failed.length) console.log("dropdown failures:\n" + r.failed.join("\n"));

      process.exit(0);
    })
    .catch((error) => {
      console.error("❌", error.message);
      process.exit(1);
    });
}


