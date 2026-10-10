const { chromium, request } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");
const log = require("./logger");

const URL = "https://lu.indiaexaminfo.co.in/result_patliputra.aspx";

const BASE_URL = "https://lu.indiaexaminfo.co.in";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/153.0.0.0 Safari/537.36";

/*
=========================================================
CONFIG
=========================================================
*/

// Dropdown data (session / exam / course) bahut kam badalta hai.
// Naye sessions 6 ghante, purane 7 din tak fresh maane jaate hain.
// Expire hone par bhi purana data turant milta hai, refresh background mein hota hai.
const CACHE_TTL_RECENT = Number(process.env.DROPDOWN_TTL_RECENT_HOURS || 6) * 3600 * 1000;
const CACHE_TTL_OLD = Number(process.env.DROPDOWN_TTL_OLD_HOURS || 168) * 3600 * 1000;

// Jis combo par portal ne koi option hi nahi diya, use itni der dobara Chromium se mat poocho.
const NEGATIVE_TTL = Number(process.env.DROPDOWN_EMPTY_TTL_HOURS || 6) * 3600 * 1000;

const CACHE_FILE = path.join(__dirname, "dropdown-cache.json");

const PRELOAD_ON_START = true;

const IGNORE_HTTPS_ERRORS = process.env.IGNORE_HTTPS_ERRORS !== "0";

const PDF_TIMEOUT = 5000;

const PAGE_TIMEOUT = 10000;

const NAVIGATION_TIMEOUT = 15000;

const FALLBACK_CONCURRENCY = 4;

const DIRECT_FIRST = true;

// Result RAM cache.
const RESULT_CACHE_TTL = 5 * 60 * 1000;

const RESULT_CACHE_MAX = 5000;

// MEGA cache.
/*
=========================================================
BROWSER
=========================================================
*/

let browserPromise = null;
let browserContextPromise = null;
let requestContextPromise = null;

async function createBrowser() {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-background-networking",
          "--disable-background-timer-throttling",
          "--disable-renderer-backgrounding",
          "--disable-features=Translate",
          "--disable-features=BackForwardCache",
          "--disable-extensions",
          "--disable-sync",
          "--no-first-run",
          "--no-default-browser-check",
        ],
      })
      .then((browser) => {
        browser.on("disconnected", () => {
          console.error("âš  Browser disconnected - will relaunch on next use");

          browserPromise = null;
          browserContextPromise = null;
        });

        return browser;
      })
      .catch((error) => {
        browserPromise = null;
        throw error;
      });
  }

  return browserPromise;
}

async function closeBrowser() {
  if (!browserPromise) {
    return;
  }

  try {
    const browser = await browserPromise;
    await browser.close();
  } catch (_) {}

  browserPromise = null;
}

/*
=========================================================
HTTP REQUEST CONTEXT
=========================================================
*/

async function getRequestContext() {
  if (!requestContextPromise) {
    requestContextPromise = request.newContext({
      userAgent: USER_AGENT,

      extraHTTPHeaders: {
        Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8",

        Referer: URL,
      },

      ignoreHTTPSErrors: IGNORE_HTTPS_ERRORS,

      timeout: PDF_TIMEOUT,
    });
  }

  return requestContextPromise;
}

async function closeRequestContext() {
  if (!requestContextPromise) {
    return;
  }

  try {
    const context = await requestContextPromise;
    await context.dispose();
  } catch (_) {}

  requestContextPromise = null;
}

/*
=========================================================
PLAYWRIGHT CONTEXT
=========================================================
*/

async function getBrowserContext() {
  if (!browserContextPromise) {
    const browser = await createBrowser();

    browserContextPromise = browser.newContext({
      viewport: {
        width: 1280,
        height: 720,
      },

      userAgent: USER_AGENT,

      ignoreHTTPSErrors: IGNORE_HTTPS_ERRORS,
    });
  }

  return browserContextPromise;
}

async function closeBrowserContext() {
  if (!browserContextPromise) {
    return;
  }

  try {
    const context = await browserContextPromise;

    await context.close();
  } catch (_) {}

  browserContextPromise = null;
}

/*
=========================================================
PAGE
=========================================================
*/

async function createPageOnce() {
  const context = await getBrowserContext();

  const page = await context.newPage();

  page.setDefaultTimeout(PAGE_TIMEOUT);

  await page.route("**/*", async (route) => {
    const type = route.request().resourceType();

    if (
      type === "image" ||
      type === "font" ||
      type === "media" ||
      type === "stylesheet"
    ) {
      return route.abort();
    }

    return route.continue();
  });

  await page.goto(URL, {
    waitUntil: "commit",
    timeout: NAVIGATION_TIMEOUT,
  });

  try {
    await page.waitForLoadState("domcontentloaded", {
      timeout: 3000,
    });
  } catch (_) {}

  return page;
}

async function createPage() {
  try {
    return await createPageOnce();
  } catch (error) {
    if (/closed|disconnected|crashed/i.test(String(error.message))) {
      console.warn("âš  Browser was dead - relaunching and retrying once");

      browserPromise = null;
      browserContextPromise = null;

      return createPageOnce();
    }

    throw error;
  }
}

/*
=========================================================
TEXT / OPTIONS
=========================================================
*/

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isValidOption(option) {
  const text = cleanText(option.text);

  if (!text) {
    return false;
  }

  const invalid = [
    "select",
    "select session",
    "select exam",
    "select exam type",
    "select course",
    "please select",
    "choose",
    "--select--",
    "-- select --",
  ];

  return !invalid.includes(text.toLowerCase());
}

async function getOptions(page, selector) {
  const locator = page.locator(selector);

  if (!(await locator.count())) {
    throw new Error(`Dropdown not found: ${selector}`);
  }

  return locator.locator("option").evaluateAll((elements) => {
    return elements.map((option) => ({
      value: option.value,

      text: (option.textContent || "").replace(/\s+/g, " ").trim(),

      disabled: option.disabled,
    }));
  });
}

function findOptionInArray(options, wanted) {
  const target = cleanText(wanted).toLowerCase();

  let found = options.find(
    (option) => cleanText(option.value).toLowerCase() === target
  );

  if (!found) {
    found = options.find(
      (option) => cleanText(option.text).toLowerCase() === target
    );
  }

  return found || null;
}

async function waitForOptions(page, selector, timeout = 3000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const options = (await getOptions(page, selector)).filter(isValidOption);

      if (options.length) {
        return options;
      }
    } catch (_) {}

    await page.waitForTimeout(50);
  }

  return [];
}

/*
=========================================================
MEMORY CACHE
=========================================================
*/

let sessionsCache = null;

let sessionsCacheTime = 0;

const examCache = new Map();

const courseCache = new Map();

function labelYear(label) {
  const m = String(label || "").match(/(?<!\d)((?:19|20)?\d{2})\s*(?:-|â€“|to)\s*(?:19|20)?\d{2}(?!\d)|(?<!\d)(20\d{2})(?!\d)/);

  if (!m) return 0;

  const n = Number(m[1] || m[2]);

  return n < 100 ? 2000 + n : n;
}

function ttlFor(label) {
  const year = labelYear(label);

  return year && year < new Date().getFullYear() - 4 ? CACHE_TTL_OLD : CACHE_TTL_RECENT;
}

function cacheValid(time, label) {
  return !!time && Date.now() - time < ttlFor(label);
}

// Negative cache: key -> time (portal ne is combo par koi option nahi diya)
const emptyCache = new Map();

function isKnownEmpty(kind, key) {
  const t = emptyCache.get(`${kind}::${key}`);

  return !!t && Date.now() - t < NEGATIVE_TTL;
}

function markEmpty(kind, key) {
  emptyCache.set(`${kind}::${key}`, Date.now());

  saveDiskCache();
}

// Same key ke parallel requests ek hi Chromium page share karein.
const inflight = new Map();

function dedupe(key, fn) {
  if (inflight.has(key)) return inflight.get(key);

  const promise = Promise.resolve()
    .then(fn)
    .finally(() => inflight.delete(key));

  inflight.set(key, promise);

  return promise;
}

/*
=========================================================
RESULT CACHE
=========================================================
*/

const resultCache = new Map();

function getResultCacheKey({ session, examType, course, roll }) {
  return [
    String(session || "").trim(),
    String(examType || "").trim(),
    String(course || "").trim(),
    String(roll || "").trim(),
  ].join("|||");
}

function getCachedResult(key) {
  const item = resultCache.get(key);

  if (!item) {
    return null;
  }

  if (Date.now() - item.time > RESULT_CACHE_TTL) {
    resultCache.delete(key);
    return null;
  }

  return item.data;
}

// /delprofile: is roll ka cached result memory se hata do.
function forgetRoll(roll) {
  const suffix = `|||${String(roll || "").trim()}`;

  for (const key of resultCache.keys()) {
    if (key.endsWith(suffix)) resultCache.delete(key);
  }
}

function setCachedResult(key, data) {
  if (resultCache.size >= RESULT_CACHE_MAX) {
    const firstKey = resultCache.keys().next().value;

    if (firstKey) {
      resultCache.delete(firstKey);
    }
  }

  resultCache.set(key, {
    time: Date.now(),
    data,
  });
}

/*
=========================================================
DISK CACHE
=========================================================
*/

function loadDiskCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) {
      return;
    }

    const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));

    if (Array.isArray(data.sessions) && data.sessions.length) {
      sessionsCache = data.sessions;

      sessionsCacheTime = Number(data.sessionsTime) || 0;
    }

    for (const [list, target] of [
      [data.exams, examCache],
      [data.courses, courseCache],
    ]) {
      if (!Array.isArray(list)) {
        continue;
      }

      for (const item of list) {
        if (item && item.key && Array.isArray(item.data)) {
          target.set(item.key, {
            data: item.data,
            time: Number(item.time) || 0,
          });
        }
      }
    }

    if (Array.isArray(data.empty)) {
      for (const item of data.empty) {
        if (item && item.key && Number(item.time)) {
          emptyCache.set(item.key, Number(item.time));
        }
      }
    }

    log.debug(
      `Dropdown cache: sessions=${sessionsCache?.length || 0} exams=${examCache.size} courses=${courseCache.size}`
    );
  } catch (error) {
    log.error("âš  Could not load dropdown cache:", error.message);
  }
}

let cacheSaveTimer = null;

function saveDiskCache() {
  if (cacheSaveTimer) {
    clearTimeout(cacheSaveTimer);
  }

  cacheSaveTimer = setTimeout(() => {
    try {
      const toList = (map) =>
        Array.from(map.entries()).map(([key, value]) => ({
          key,
          data: value.data,
          time: value.time,
        }));

      const data = {
        sessions: sessionsCache || [],

        sessionsTime: sessionsCacheTime,

        exams: toList(examCache),

        courses: toList(courseCache),

        empty: Array.from(emptyCache.entries()).map(([key, time]) => ({ key, time })),
      };

      const tmp = CACHE_FILE + ".tmp";

      fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
      fs.renameSync(tmp, CACHE_FILE);
    } catch (error) {
      log.error("âš  Could not save dropdown cache:", error.message);
    }

    cacheSaveTimer = null;
  }, 1000);
}

/*
=========================================================
SESSIONS
=========================================================
*/

async function loadSessionsFromWebsite() {
  await createBrowser();

  const page = await createPage();

  try {
    const options = await getOptions(page, "#lstYr");

    const sessions = options.filter(isValidOption);

    if (!sessions.length) {
      throw new Error("No sessions found");
    }

    sessionsCache = sessions;

    sessionsCacheTime = Date.now();

    saveDiskCache();

    log.debug(`âš¡ Sessions refreshed: ${sessions.length}`);

    return sessions;
  } finally {
    await page.close().catch(() => {});
  }
}

let sessionRefreshRunning = false;

function refreshSessionsInBackground() {
  if (sessionRefreshRunning) {
    return;
  }

  sessionRefreshRunning = true;

  loadSessionsFromWebsite()
    .catch((error) => {
      log.debug("âš  Background session refresh failed:", error.message);
    })
    .finally(() => {
      sessionRefreshRunning = false;
    });
}

async function getSessions() {
  if (sessionsCache && sessionsCache.length) {
    if (!cacheValid(sessionsCacheTime)) {
      refreshSessionsInBackground();
    }

    return sessionsCache;
  }

  return dedupe("sessions", loadSessionsFromWebsite);
}

/*
=========================================================
EXAM TYPES
=========================================================
*/

async function selectSession(page, session) {
  const sessionOptions = await getOptions(page, "#lstYr");

  const sessionOption = findOptionInArray(sessionOptions, session);

  if (!sessionOption) {
    throw new Error(`Session not found: ${session}`);
  }

  await page.locator("#lstYr").selectOption({
    value: sessionOption.value,
  });
}

async function loadExamTypesFromWebsite(session) {
  const page = await createPage();

  try {
    await selectSession(page, session);

    let exams = await waitForOptions(page, "#lstCrs");

    if (!exams.length) {
      exams = await waitForOptions(page, "#lstCrs", 6000);
    }

    if (!exams.length) {
      throw new Error(`No exam types found for ${session}`);
    }

    log.debug(`âš¡ Exam refreshed: ${session} (${exams.length})`);

    return exams;
  } finally {
    await page.close().catch(() => {});
  }
}

const examRefreshRunning = new Set();

function refreshExamInBackground(session) {
  const key = String(session);

  if (examRefreshRunning.has(key)) {
    return;
  }

  examRefreshRunning.add(key);

  loadExamTypesFromWebsite(session)
    .then((data) => {
      examCache.set(key, {
        data,
        time: Date.now(),
      });

      saveDiskCache();
    })
    .catch((error) => {
      log.debug(
        `âš  Background exam refresh failed for ${session}:`,
        error.message
      );
    })
    .finally(() => {
      examRefreshRunning.delete(key);
    });
}

async function getExamTypes(session) {
  const key = String(session);

  const cached = examCache.get(key);

  if (cached && Array.isArray(cached.data) && cached.data.length) {
    if (!cacheValid(cached.time, key)) {
      refreshExamInBackground(session);
    }

    return cached.data;
  }

  if (isKnownEmpty("exam", key)) {
    return [];
  }

  return dedupe(`exam::${key}`, async () => {
    try {
      const data = await loadExamTypesFromWebsite(session);

      examCache.set(key, { data, time: Date.now() });

      saveDiskCache();

      return data;
    } catch (error) {
      if (/^No exam types found/.test(error.message)) {
        markEmpty("exam", key);

        return [];
      }

      throw error;
    }
  });
}

/*
=========================================================
COURSES
=========================================================
*/

async function selectExamType(page, examType) {
  const examOptions = await waitForOptions(page, "#lstCrs");

  const examOption = findOptionInArray(examOptions, examType);

  if (!examOption) {
    throw new Error(`Exam Type not found: ${examType}`);
  }

  await page.locator("#lstCrs").selectOption({
    value: examOption.value,
  });
}

async function loadCoursesFromWebsite(session, examType) {
  const page = await createPage();

  try {
    await selectSession(page, session);

    await selectExamType(page, examType);

    let courses = await waitForOptions(page, "#lstSem");

    if (!courses.length) {
      courses = await waitForOptions(page, "#lstSem", 6000);
    }

    if (!courses.length) {
      throw new Error(`No courses found for ${session} / ${examType}`);
    }

    log.debug(
      `âš¡ Course refreshed: ${session} / ${examType} (${courses.length})`
    );

    return courses;
  } finally {
    await page.close().catch(() => {});
  }
}

const courseRefreshRunning = new Set();

function refreshCourseInBackground(session, examType) {
  const key = `${session}|||${examType}`;

  if (courseRefreshRunning.has(key)) {
    return;
  }

  courseRefreshRunning.add(key);

  loadCoursesFromWebsite(session, examType)
    .then((data) => {
      courseCache.set(key, {
        data,
        time: Date.now(),
      });

      saveDiskCache();
    })
    .catch((error) => {
      log.debug(
        `âš  Background course refresh failed: ${session} / ${examType}:`,
        error.message
      );
    })
    .finally(() => {
      courseRefreshRunning.delete(key);
    });
}

async function getCourses(session, examType) {
  const key = `${session}|||${examType}`;

  const cached = courseCache.get(key);

  if (cached && Array.isArray(cached.data) && cached.data.length) {
    if (!cacheValid(cached.time, key)) {
      refreshCourseInBackground(session, examType);
    }

    return cached.data;
  }

  if (isKnownEmpty("course", key)) {
    return [];
  }

  return dedupe(`course::${key}`, async () => {
    try {
      const data = await loadCoursesFromWebsite(session, examType);

      courseCache.set(key, { data, time: Date.now() });

      saveDiskCache();

      return data;
    } catch (error) {
      if (/^No courses found/.test(error.message)) {
        markEmpty("course", key);

        return [];
      }

      throw error;
    }
  });
}

/*
=========================================================
BACKGROUND PRELOAD
=========================================================
*/

let preloadStarted = false;

async function preloadDropdownData() {
  if (preloadStarted) {
    return;
  }

  preloadStarted = true;

  log.debug("======================================");
  log.debug("âš¡ BACKGROUND DROPDOWN REFRESH");
  log.debug("======================================");

  try {
    if (
      !sessionsCache ||
      !sessionsCache.length ||
      !cacheValid(sessionsCacheTime)
    ) {
      await loadSessionsFromWebsite();
    }

    log.debug("âœ… Background dropdown refresh ready");
    log.debug(`ðŸ“š Sessions: ${sessionsCache?.length || 0}`);
    log.debug(`ðŸŽ“ Exam cache: ${examCache.size}`);
    log.debug(`ðŸ“– Course cache: ${courseCache.size}`);
    log.debug("======================================");
  } catch (error) {
    log.debug("âš  Background dropdown refresh failed:", error.message);
  }
}

/*
=========================================================
FIND ROLL INPUT / SUBMIT BUTTON
=========================================================
*/

async function findFirstLocator(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector);

    if (await locator.count()) {
      return locator.first();
    }
  }

  return null;
}

function findRollInput(page) {
  return findFirstLocator(page, [
    "#txtRoll",
    "#txtRollNo",
    "#txtRollNumber",
    'input[name="txtRoll"]',
    'input[name="txtRollNo"]',
    'input[id*="Roll"]',
    'input[id*="roll"]',
    'input[placeholder*="Roll"]',
    'input[placeholder*="roll"]',
  ]);
}

function findSubmitButton(page) {
  return findFirstLocator(page, [
    "#cmdOK",
    "#btnSubmit",
    "#btnSearch",
    "#btnResult",
    "#btnShowResult",
    'input[type="submit"]',
    'input[value*="Show Marksheet"]',
    'input[value*="Show Result"]',
    'input[value*="Result"]',
    'button[type="submit"]',
  ]);
}

/*
=========================================================
KNOWN PDF URL
=========================================================
*/

function buildKnownPdfUrl({ session, examType, course, roll }) {
  const cleanSession = String(session || "").trim();
  const cleanExam = String(examType || "").trim();
  const cleanCourse = String(course || "").trim();
  const cleanRoll = String(roll || "").trim();

  if (!cleanSession || !cleanExam || !cleanCourse || !cleanRoll) {
    return null;
  }

  return (
    BASE_URL +
    "/PATLIPUTRA/" +
    encodeURIComponent(cleanSession) +
    "/" +
    encodeURIComponent(cleanExam) +
    "/" +
    encodeURIComponent(cleanCourse) +
    "/" +
    encodeURIComponent(cleanRoll) +
    ".pdf"
  );
}

/*
=========================================================
VERIFY PDF
=========================================================
*/

async function verifyPdfWith(requester, url) {
  if (!url) {
    return false;
  }

  try {
    const response = await requester.get(url, {
      timeout: PDF_TIMEOUT,

      failOnStatusCode: false,

      maxRedirects: 3,
    });

    const status = response.status();

    const headers = response.headers();

    const contentType = String(headers["content-type"] || "").toLowerCase();

    const contentLength = Number(headers["content-length"] || 0);

    await response.dispose().catch(() => {});

    if (status < 200 || status >= 300) {
      return false;
    }

    const isPdf =
      contentType.includes("application/pdf") || /\.pdf(?:\?|#|$)/i.test(url);

    if (!isPdf) {
      return false;
    }

    if (contentLength > 0 && contentLength < 100) {
      return false;
    }

    return true;
  } catch (_) {
    return false;
  }
}

async function verifyPdfDirect(url) {
  if (!url) {
    return false;
  }

  try {
    return await verifyPdfWith(await getRequestContext(), url);
  } catch (_) {
    return false;
  }
}

function verifyPdf(page, url) {
  return verifyPdfWith(page.request, url);
}

/*
=========================================================
EXTRACT PDF LINKS
=========================================================
*/

async function extractPdfLinks(page) {
  const result = [];

  const anchors = await page.locator("a").evaluateAll((links) => {
    return links.map((a) => ({
      text: (a.textContent || "").replace(/\s+/g, " ").trim(),

      href: a.href || a.getAttribute("href") || "",

      onclick: a.getAttribute("onclick") || "",
    }));
  });

  for (const link of anchors) {
    const text = String(link.text || "").toLowerCase();

    const href = String(link.href || "");

    const onclick = String(link.onclick || "");

    if (/\.pdf(\?|#|$)/i.test(href)) {
      result.push({
        source: "anchor-pdf",
        text: link.text,
        href,
      });
    }

    if (
      text.includes("download") ||
      text.includes("here") ||
      text.includes("marksheet")
    ) {
      if (href) {
        result.push({
          source: "download-anchor",
          text: link.text,
          href,
        });
      }

      if (/pdf/i.test(onclick)) {
        result.push({
          source: "onclick-pdf",
          text: link.text,
          href: onclick,
        });
      }
    }
  }

  const html = await page.content();

  const absolutePdfRegex =
    /https?:\/\/[^"'<> \t\r\n]+\.pdf(?:\?[^"'<> \t\r\n]*)?/gi;

  const relativePdfRegex = /(?:href|src)\s*=\s*["']([^"']+\.pdf[^"']*)["']/gi;

  let match;

  while ((match = absolutePdfRegex.exec(html))) {
    result.push({
      source: "html-absolute",
      text: "",
      href: match[0],
    });
  }

  while ((match = relativePdfRegex.exec(html))) {
    result.push({
      source: "html-relative",
      text: "",
      href: match[1],
    });
  }

  const pdfStrings = html.match(/["']([^"']*\.pdf[^"']*)["']/gi) || [];

  for (const item of pdfStrings) {
    result.push({
      source: "html-string",
      text: "",
      href: item.replace(/^["']/, "").replace(/["']$/, ""),
    });
  }

  const unique = [];

  const seen = new Set();

  for (const item of result) {
    if (!item.href) {
      continue;
    }

    let href = String(item.href).trim();

    if (href.startsWith("/")) {
      href = BASE_URL + href;
    } else if (!/^https?:\/\//i.test(href)) {
      try {
        href = new URL(href, BASE_URL).href;
      } catch (_) {
        continue;
      }
    }

    if (!seen.has(href)) {
      seen.add(href);

      unique.push({
        ...item,
        href,
      });
    }
  }

  return unique;
}

/*
=========================================================
RESULT NOT FOUND CHECK
=========================================================
*/

function isResultNotFoundText(bodyText) {
  const lower = String(bodyText || "").toLowerCase();

  const notFoundWords = [
    "record not found",
    "no record",
    "result not found",
    "invalid roll",
    "not available",
    "no data found",
  ];

  return notFoundWords.some((word) => lower.includes(word));
}

const RESULT_NOT_FOUND = {
  success: false,

  reason: "RESULT_NOT_FOUND",

  message: "Result not found for this Roll Number.",
};

/*
=========================================================
DIRECT RESULT CHECK
=========================================================
*/

async function checkDirectResult({ session, examType, course, roll }) {
  const knownPdfUrl = buildKnownPdfUrl({
    session,
    examType,
    course,
    roll,
  });

  if (!knownPdfUrl) {
    return null;
  }

  const valid = await verifyPdfDirect(knownPdfUrl);

  if (!valid) {
    return null;
  }

  return {
    success: true,

    type: "pdf",

    pdfUrl: knownPdfUrl,

    cached: false,

    cacheSource: "direct",

    session,
    examType,
    course,
    roll,
  };
}

/*
=========================================================
FALLBACK RESULT CHECK
=========================================================
*/

async function checkResultFallback({ session, examType, course, roll }) {
  const startedAt = Date.now();

  const page = await createPage();

  try {
    // SESSION â†’ EXAM â†’ COURSE
    await selectSession(page, session);

    await selectExamType(page, examType);

    const courseOptions = await waitForOptions(page, "#lstSem");

    const courseOption = findOptionInArray(courseOptions, course);

    if (!courseOption) {
      throw new Error(`Course not found: ${course}`);
    }

    await page.locator("#lstSem").selectOption({
      value: courseOption.value,
    });

    // DIRECT PDF RETRY
    const knownPdfUrl = buildKnownPdfUrl({
      session,
      examType,
      course,
      roll,
    });

    if (knownPdfUrl) {
      const valid = await verifyPdf(page, knownPdfUrl);

      if (valid) {
        return {
          success: true,

          type: "pdf",

          pdfUrl: knownPdfUrl,

          cached: false,

          cacheSource: "fallback-direct",

          session,
          examType,
          course,
          roll,
        };
      }
    }

    // ROLL INPUT FALLBACK
    const rollInput = await findRollInput(page);

    if (!rollInput) {
      return { ...RESULT_NOT_FOUND };
    }

    await rollInput.fill(String(roll).trim());

    // SUBMIT
    const submitButton = await findSubmitButton(page);

    if (!submitButton) {
      return { ...RESULT_NOT_FOUND };
    }

    const navigationPromise = page
      .waitForNavigation({
        waitUntil: "commit",

        timeout: NAVIGATION_TIMEOUT,
      })
      .catch(() => null);

    await submitButton.click();

    await navigationPromise;

    await page.waitForTimeout(100);

    // PDF FROM RESULT PAGE
    const pdfLinks = await extractPdfLinks(page);

    const score = (item) => {
      let value = 0;

      if (item.source === "anchor-pdf") {
        value += 100;
      }

      if (item.source === "download-anchor") {
        value += 50;
      }

      if (/marksheet|result/i.test(item.text || "")) {
        value += 25;
      }

      return value;
    };

    const sortedPdfLinks = pdfLinks.sort((a, b) => score(b) - score(a));

    for (const item of sortedPdfLinks) {
      const valid = await verifyPdf(page, item.href);

      if (valid) {
        return {
          success: true,

          type: "pdf",

          pdfUrl: item.href,

          cached: false,

          cacheSource: "page",

          session,
          examType,
          course,
          roll,
        };
      }
    }

    // KNOWN PDF FINAL CHECK
    if (knownPdfUrl) {
      const valid = await verifyPdf(page, knownPdfUrl);

      if (valid) {
        return {
          success: true,

          type: "pdf",

          pdfUrl: knownPdfUrl,

          cached: false,

          cacheSource: "fallback-direct-final",

          session,
          examType,
          course,
          roll,
        };
      }
    }

    // PAGE TEXT
    const bodyText = await page
      .locator("body")
      .innerText()
      .catch(() => "");

    if (isResultNotFoundText(bodyText)) {
      return { ...RESULT_NOT_FOUND };
    }

    // HTML RESULT
    return {
      success: true,

      type: "html",

      html: await page.content(),

      text: bodyText,

      session,
      examType,
      course,
      roll,
    };
  } finally {
    await page.close().catch(() => {});

    const elapsed = Date.now() - startedAt;

    if (elapsed > 5000) {
      log.debug(` Slow fallback: ${roll} (${elapsed}ms)`);
    }
  }
}

/*
=========================================================
FALLBACK CONCURRENCY LIMITER
=========================================================
*/

let fallbackActive = 0;

const fallbackQueue = [];

async function runFallbackLimited(task) {
  if (fallbackActive >= FALLBACK_CONCURRENCY) {
    await new Promise((resolve) => {
      fallbackQueue.push(resolve);
    });
  }

  fallbackActive++;

  try {
    return await task();
  } finally {
    fallbackActive--;

    const next = fallbackQueue.shift();

    if (next) {
      next();
    }
  }
}

/*
=========================================================
CHECK RESULT
=========================================================
*/

async function checkResult({ session, examType, course, roll }) {
  const cleanSession = String(session || "").trim();
  const cleanExamType = String(examType || "").trim();
  const cleanCourse = String(course || "").trim();
  const cleanRoll = String(roll || "").trim();

  if (!cleanSession || !cleanExamType || !cleanCourse || !cleanRoll) {
    return {
      success: false,

      reason: "RESULT_NOT_FOUND",

      message: "Invalid result search parameters.",
    };
  }

  const params = {
    session: cleanSession,
    examType: cleanExamType,
    course: cleanCourse,
    roll: cleanRoll,
  };

  // RESULT CACHE
  const cacheKey = getResultCacheKey(params);

  const cached = getCachedResult(cacheKey);

  if (cached) {
    return cached;
  }

  const startedAt = Date.now();
// FAST DIRECT PDF PATH
  if (DIRECT_FIRST) {
    const directResult = await checkDirectResult(params);

    if (directResult) {
      setCachedResult(cacheKey, directResult);

      return directResult;
    }
  }

  // FALLBACK
  let result;

  try {
    result = await runFallbackLimited(() => checkResultFallback(params));
  } catch (error) {
    console.error(`âš  SEARCH ERROR â†’ ${cleanRoll}: ${error.message}`);

    result = {
      success: false,

      reason: "SEARCH_ERROR",

      message: error.message,

      ...params,
    };
  }

  setCachedResult(cacheKey, result);

  const elapsed = Date.now() - startedAt;

  if (elapsed > 5000) {
    if (process.env.DEBUG_LOGS === "1") {
      log.debug(` Slow result check: ${cleanRoll} (${elapsed}ms)`);
    }
  }

  return result;
}

/*
=========================================================
STARTUP
=========================================================
*/

loadDiskCache();

if (PRELOAD_ON_START) {
  setTimeout(() => {
    preloadDropdownData();
  }, 1000);
}
/*
=========================================================
CLOSE ALL
=========================================================
*/

async function closeAll() {
  if (cacheSaveTimer) {
    clearTimeout(cacheSaveTimer);

    cacheSaveTimer = null;
  }

  await closeBrowserContext();

  await closeBrowser();

  await closeRequestContext();
}

/*
=========================================================
EXPORT
=========================================================
*/

module.exports = {
  closeAll,

  forgetRoll,

  getSessions,

  getExamTypes,

  getCourses,

  checkResult,

  preloadDropdownData,

  buildKnownPdfUrl,

  verifyPdfDirect,
};
