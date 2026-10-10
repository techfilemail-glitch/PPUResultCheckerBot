const {
  getSessions,
  getExamTypes,
  getCourses,
  checkResult,
} = require("../result-checker");

const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  PDFDocument,
  ParseSpeeds,
} = require("pdf-lib");

const FAST_PARSE =
  ParseSpeeds && ParseSpeeds.Fastest
    ? { parseSpeed: ParseSpeeds.Fastest }
    : {};

const {
  extractResultDetails,
} = require("../result-details");

const {
  saveResult,
} = require("../supabase");

const {
  initializeArchive,
  findIndividualPdf,
  getIndividualPdf,
  archiveIndividualPdf,
  makeArchiveFilename,
} = require("../pdf-archive");

const CACHE_TTL =
  60 * 1000;

const SEARCH_CONCURRENCY = 15;

const MAX_ROLLS = 5000;

const REQUEST_TIMEOUT =
  20000;

let sessionsCache = null;

let sessionsCacheTime = 0;

const examCache =
  new Map();

const courseCache =
  new Map();

function encodeValue(value) {
  return Buffer.from(
    String(value),
    "utf8"
  ).toString("base64url");
}

function decodeValue(value) {
  return Buffer.from(
    String(value),
    "base64url"
  ).toString("utf8");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function sanitizeFilename(value) {
  return String(value || "")
    .replace(
      /[<>:"/\\|?*\x00-\x1F]/g,
      "_"
    )
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(
      /^_+|_+$/g,
      ""
    )
    .slice(0, 100);
}

function getState(
  userState,
  chatId
) {
  return userState.get(chatId);
}

async function deleteMessage(
  bot,
  chatId,
  messageId
) {
  if (!messageId) {
    return;
  }

  try {
    await bot.deleteMessage(
      chatId,
      messageId
    );
  } catch (_) {}
}

async function replaceMessage(
  bot,
  userState,
  chatId,
  text,
  options
) {
  const state =
    getState(
      userState,
      chatId
    );

  if (
    state &&
    state.bulkMessageId
  ) {
    await deleteMessage(
      bot,
      chatId,
      state.bulkMessageId
    );

    state.bulkMessageId =
      null;
  }

  const sent =
    await bot.sendMessage(
      chatId,
      text,
      options
    );

  if (state) {
    state.bulkMessageId =
      sent.message_id;

    userState.set(
      chatId,
      state
    );
  }

  return sent;
}

async function getSessionsCached() {
  const now =
    Date.now();

  if (
    sessionsCache &&
    now - sessionsCacheTime <
      CACHE_TTL
  ) {
    return sessionsCache;
  }

  const sessions =
    await getSessions();

  sessionsCache =
    Array.isArray(sessions)
      ? sessions
      : [];

  sessionsCacheTime =
    now;

  return sessionsCache;
}

async function getExamTypesCached(
  session
) {
  const key =
    String(session);

  const now =
    Date.now();

  const cached =
    examCache.get(key);

  if (
    cached &&
    now - cached.time <
      CACHE_TTL
  ) {
    return cached.data;
  }

  const exams =
    await getExamTypes(
      session
    );

  const data =
    Array.isArray(exams)
      ? exams
      : [];

  examCache.set(
    key,
    {
      data,
      time: now,
    }
  );

  return data;
}

async function getCoursesCached(
  session,
  examType
) {
  const key =
    `${session}|||${examType}`;

  const now =
    Date.now();

  const cached =
    courseCache.get(key);

  if (
    cached &&
    now - cached.time <
      CACHE_TTL
  ) {
    return cached.data;
  }

  const courses =
    await getCourses(
      session,
      examType
    );

  const data =
    Array.isArray(courses)
      ? courses
      : [];

  courseCache.set(
    key,
    {
      data,
      time: now,
    }
  );

  return data;
}

function subjectMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "📚 Subject",
            callback_data:
              "BULK_SUBJECT",
          },
        ],
        [
          {
            text: "🏫 College",
            callback_data:
              "BULK_COLLEGE",
          },
        ],
        [
          {
            text: "⬅️ Main Menu",
            callback_data:
              "MAIN_MENU",
          },
        ],
      ],
    },
  };
}

function navigation(
  backCallback
) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "⬅️ Back",
            callback_data:
              backCallback,
          },
          {
            text: "❌ Cancel",
            callback_data:
              "BULK_CANCEL",
          },
        ],
      ],
    },
  };
}

async function start(
  bot,
  userState,
  chatId
) {
  userState.set(
    chatId,
    {
      mode: "bulk",
      bulkType: null,
      bulkStep: "type",
      session: null,
      examType: null,
      course: null,
      rollFrom: null,
      rollTo: null,
      bulkMessageId: null,
      bulkRunning: false,
      bulkCancelled: false,
    }
  );

  return replaceMessage(
    bot,
    userState,
    chatId,
    "📦 <b>Bulk Result</b>\n\nChoose how you want to generate bulk results.",
    {
      parse_mode: "HTML",
      ...subjectMenu(),
    }
  );
}

async function startSubject(
  bot,
  userState,
  chatId
) {
  const state =
    getState(
      userState,
      chatId
    );

  if (!state) {
    return start(
      bot,
      userState,
      chatId
    );
  }

  state.bulkType =
    "subject";

  state.bulkStep =
    "session";

  state.session =
    null;

  state.examType =
    null;

  state.course =
    null;

  state.rollFrom =
    null;

  state.rollTo =
    null;

  state.bulkRunning =
    false;

  state.bulkCancelled =
    false;

  userState.set(
    chatId,
    state
  );

  return showSessions(
    bot,
    userState,
    chatId
  );
}

async function showSessions(
  bot,
  userState,
  chatId
) {
  const state =
    getState(
      userState,
      chatId
    );

  if (!state) {
    return start(
      bot,
      userState,
      chatId
    );
  }

  try {
    const sessions =
      await getSessionsCached();

    if (!sessions.length) {
      throw new Error(
        "No sessions available."
      );
    }

    state.bulkStep =
      "session";

    userState.set(
      chatId,
      state
    );

    const buttons = [];

    for (
      let i = 0;
      i < sessions.length;
      i += 2
    ) {
      const row = [];

      for (
        let j = i;
        j <
          Math.min(
            i + 2,
            sessions.length
          );
        j++
      ) {
        const session =
          sessions[j];

        row.push({
          text:
            state.session ===
            session.value
              ? `✅ ${session.text}`
              : session.text,

          callback_data:
            "BULKS_" +
            encodeValue(
              session.value
            ),
        });
      }

      buttons.push(row);
    }

    buttons.push([
      {
        text: "⬅️ Back",
        callback_data:
          "BULK_MENU",
      },
      {
        text: "❌ Cancel",
        callback_data:
          "BULK_CANCEL",
      },
    ]);

    return replaceMessage(
      bot,
      userState,
      chatId,
      `📚 <b>Bulk Result — Subject</b>

<b>Step 1 of 5</b>

📅 <b>Select Session</b>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard:
            buttons,
        },
      }
    );
  } catch (error) {
    console.error(
      "Bulk session error:",
      error.message
    );

    return bot.sendMessage(
      chatId,
      "❌ Unable to load sessions."
    );
  }
}

async function showExamTypes(
  bot,
  userState,
  chatId,
  session
) {
  const state =
    getState(
      userState,
      chatId
    );

  if (!state) {
    return start(
      bot,
      userState,
      chatId
    );
  }

  try {
    const exams =
      await getExamTypesCached(
        session
      );

    if (!exams.length) {
      throw new Error(
        "No exam types available."
      );
    }

    state.bulkStep =
      "exam";

    state.session =
      session;

    userState.set(
      chatId,
      state
    );

    const buttons = [];

    for (
      let i = 0;
      i < exams.length;
      i += 2
    ) {
      const row = [];

      for (
        let j = i;
        j <
          Math.min(
            i + 2,
            exams.length
          );
        j++
      ) {
        const exam =
          exams[j];

        row.push({
          text:
            state.examType ===
            exam.value
              ? `✅ ${exam.text}`
              : exam.text,

          callback_data:
            "BULKE_" +
            encodeValue(
              exam.value
            ),
        });
      }

      buttons.push(row);
    }

    buttons.push([
      {
        text: "⬅️ Back",
        callback_data:
          "BULK_SUBJECT_SESSION",
      },
      {
        text: "❌ Cancel",
        callback_data:
          "BULK_CANCEL",
      },
    ]);

    return replaceMessage(
      bot,
      userState,
      chatId,
      `📚 <b>Bulk Result — Subject</b>

<b>Step 2 of 5</b>

📅 Session: <b>${escapeHtml(
        session
      )}</b>

🎓 <b>Select Exam Type</b>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard:
            buttons,
        },
      }
    );
  } catch (error) {
    console.error(
      "Bulk exam error:",
      error.message
    );

    return bot.sendMessage(
      chatId,
      "❌ Unable to load examination types."
    );
  }
}

async function showCourses(
  bot,
  userState,
  chatId,
  session,
  examType
) {
  const state =
    getState(
      userState,
      chatId
    );

  if (!state) {
    return start(
      bot,
      userState,
      chatId
    );
  }

  try {
    const courses =
      await getCoursesCached(
        session,
        examType
      );

    if (!courses.length) {
      throw new Error(
        "No courses available."
      );
    }

    state.bulkStep =
      "course";

    state.session =
      session;

    state.examType =
      examType;

    userState.set(
      chatId,
      state
    );

    const buttons = [];

    for (
      let i = 0;
      i < courses.length;
      i += 2
    ) {
      const row = [];

      for (
        let j = i;
        j <
          Math.min(
            i + 2,
            courses.length
          );
        j++
      ) {
        const course =
          courses[j];

        row.push({
          text:
            state.course ===
            course.value
              ? `✅ ${course.text}`
              : course.text,

          callback_data:
            "BULKC_" +
            encodeValue(
              course.value
            ),
        });
      }

      buttons.push(row);
    }

    buttons.push([
      {
        text: "⬅️ Back",
        callback_data:
          "BULK_SUBJECT_EXAM",
      },
      {
        text: "❌ Cancel",
        callback_data:
          "BULK_CANCEL",
      },
    ]);

    return replaceMessage(
      bot,
      userState,
      chatId,
      `📚 <b>Bulk Result — Subject</b>

<b>Step 3 of 5</b>

📅 Session: <b>${escapeHtml(
        session
      )}</b>

🎓 Exam Type: <b>${escapeHtml(
        examType
      )}</b>

📚 <b>Select Course / Semester</b>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard:
            buttons,
        },
      }
    );
  } catch (error) {
    console.error(
      "Bulk course error:",
      error.message
    );

    return bot.sendMessage(
      chatId,
      "❌ Unable to load courses."
    );
  }
}

async function showRollFrom(
  bot,
  userState,
  chatId
) {
  const state =
    getState(
      userState,
      chatId
    );

  if (!state) {
    return start(
      bot,
      userState,
      chatId
    );
  }

  state.bulkStep =
    "roll_from";

  userState.set(
    chatId,
    state
  );

  return replaceMessage(
    bot,
    userState,
    chatId,
    `📚 <b>Bulk Result — Subject</b>

<b>Step 4 of 5</b>

📅 Session: <b>${escapeHtml(
      state.session
    )}</b>

🎓 Exam Type: <b>${escapeHtml(
      state.examType
    )}</b>

📚 Course: <b>${escapeHtml(
      state.course
    )}</b>

🔢 <b>Enter Roll From</b>

Send the first roll number.

Example:

<code>2520641060001</code>`,
    {
      parse_mode: "HTML",
      ...navigation(
        "BULK_SUBJECT_COURSE"
      ),
    }
  );
}

async function showRollTo(
  bot,
  userState,
  chatId
) {
  const state =
    getState(
      userState,
      chatId
    );

  if (!state) {
    return start(
      bot,
      userState,
      chatId
    );
  }

  state.bulkStep =
    "roll_to";

  userState.set(
    chatId,
    state
  );

  return replaceMessage(
    bot,
    userState,
    chatId,
    `📚 <b>Bulk Result — Subject</b>

<b>Step 5 of 5</b>

📅 Session: <b>${escapeHtml(
      state.session
    )}</b>

🎓 Exam Type: <b>${escapeHtml(
      state.examType
    )}</b>

📚 Course: <b>${escapeHtml(
      state.course
    )}</b>

🔢 Roll From:

<code>${escapeHtml(
      state.rollFrom
    )}</code>

🔢 <b>Enter Roll To</b>

Send the last roll number.

Example:

<code>2520641060200</code>`,
    {
      parse_mode: "HTML",
      ...navigation(
        "BULK_SUBJECT_ROLL_FROM"
      ),
    }
  );
}

function isValidRoll(value) {
  return /^\d{5,20}$/.test(
    String(value || "").trim()
  );
}

function getRollCount(
  from,
  to
) {
  try {
    const start =
      BigInt(
        String(from)
      );

    const end =
      BigInt(
        String(to)
      );

    if (end < start) {
      return 0;
    }

    // BigInt ke saath 1n use karna zaroori hai
    const count =
      end - start + 1n;

    return Number(count);
  } catch (_) {
    return 0;
  }
}

function generateRolls(
  from,
  to
) {
  const start =
    BigInt(
      String(from)
    );

  const end =
    BigInt(
      String(to)
    );

  const width =
    String(from).length;

  const rolls = [];

  for (
    let current = start;
    current <= end;
    current++
  ) {
    rolls.push(
      current
        .toString()
        .padStart(
          width,
          "0"
        )
    );
  }

  return rolls;
}

function silenceConsole() {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
  };

  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};

  return function restoreConsole() {
    console.log =
      original.log;

    console.info =
      original.info;

    console.warn =
      original.warn;
  };
}

async function downloadPdf(
  url,
  filePath
) {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      REQUEST_TIMEOUT
    );

  try {
    const response =
      await fetch(
        url,
        {
          method: "GET",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
            Accept:
              "application/pdf,*/*",
          },
          signal:
            controller.signal,
        }
      );

    if (!response.ok) {
      return false;
    }

    const buffer =
      Buffer.from(
        await response.arrayBuffer()
      );

    if (!hasPdfShape(buffer)) {
      return false;
    }

    await fs.promises.writeFile(
      filePath,
      buffer
    );

    return true;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/*
 * Cheap check: PDF header + %%EOF marker near the end.
 * Truncated / corrupted downloads fail this.
 */
function hasPdfShape(buffer) {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length < 100
  ) {
    return false;
  }

  if (
    buffer
      .subarray(0, 5)
      .toString() !== "%PDF-"
  ) {
    return false;
  }

  const tail = buffer
    .subarray(
      Math.max(
        0,
        buffer.length - 2048
      )
    )
    .toString("latin1");

  return tail.includes("%%EOF");
}

/*
 * Strict check: pdf-lib must be able to load it,
 * because merge uses exactly the same loader.
 */
async function isMergeablePdf(buffer) {
  if (!hasPdfShape(buffer)) {
    return false;
  }

  try {
    const doc =
      await PDFDocument.load(
        buffer,
        {
          ignoreEncryption: true,
          updateMetadata: false,
        }
      );

    return doc.getPageCount() > 0;
  } catch (_) {
    return false;
  }
}

/*
 * initializeArchive() ko 15 workers parallel
 * call kar rahe the (MEGA 3 baar connect ho raha tha).
 * Ab sirf ek baar chalega.
 */
let archiveInitPromise = null;

/*
 * Circuit breaker: agar MEGA lookup/download baar-baar fail
 * ho raha ho to 2 minute ke liye lookup skip karo (seedha
 * portal), taaki har roll par time aur log spam na ho.
 */
let archiveLookupFailures = 0;
let archiveLookupPausedUntil = 0;

function ensureArchiveReady() {
  if (!archiveInitPromise) {
    archiveInitPromise =
      Promise.resolve(
        initializeArchive()
      ).catch((error) => {
        archiveInitPromise = null;

        throw error;
      });
  }

  return archiveInitPromise;
}

async function saveDownloadedResult(item, config) {
  try {
    const details = await extractResultDetails(
      item.filePath
    );

    const roll =
      details.roll ||
      item.roll;

    // =========================
    // SUPABASE
    // =========================

    let saved = null;

    try {
      saved = await saveResult(
        details,
        {
          roll,

          session:
            config.session,

          examType:
            config.examType,

          course:
            config.course,

          pdfUrl:
            item.pdfUrl,

          source:
            "bulk_subject",
        }
      );

      if (
        saved &&
        !saved.skipped
      ) {
        if (process.env.DEBUG_LOGS === "1") {
          console.log(
            `💾 Supabase saved: ${roll}`
          );
        }
      }
    } catch (error) {
      console.error(
        `⚠️ Supabase save failed for ${roll}:`,
        error.message
      );
    }

    return {
      item,
      details,
      saved: Boolean(
        saved &&
        !saved.skipped
      ),
    };
  } catch (error) {
    console.error(
      `⚠️ Result processing failed for ${item.roll}:`,
      error.message
    );

    return {
      item,
      details: null,
      saved: false,
    };
  }
}

async function saveAllDownloadedResults(
  results,
  config
) {
  if (!results.length) {
    return;
  }

  /*
   * Extraction concurrency is intentionally
   * lower than search concurrency so that
   * PDF parsing does not overload Render RAM.
   */
  const concurrency =
    Math.min(
      5,
      results.length
    );

  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index =
        nextIndex++;

      if (
        index >= results.length
      ) {
        return;
      }

      await saveDownloadedResult(
        results[index],
        config
      );
    }
  }

  const workers = [];

  for (
    let i = 0;
    i < concurrency;
    i++
  ) {
    workers.push(
      worker()
    );
  }

  await Promise.all(
    workers
  );
}

async function searchAndDownloadRoll(
  config,
  roll,
  workDir
) {
  const filename =
    `${sanitizeFilename(roll)}.pdf`;

  const filePath =
    path.join(
      workDir,
      filename
    );

  /*
   * MEGA archive key mein session + exam + course bhi hai.
   * Sirf roll se archive karne par ek hi roll ka dusre
   * semester/course ka PDF galti se wapas aa jaata tha.
   */
  const archiveFilename =
    makeArchiveFilename({
      roll,
      session:
        config.session,
      examType:
        config.examType,
      course:
        config.course,
    });

  let pdfBuffer = null;
  let pdfUrl = null;
  let archiveHit = false;

  /*
   * =====================================================
   * 1. MEGA INDIVIDUAL PDF LOOKUP
   * =====================================================
   */
  try {
    await ensureArchiveReady();

    const archivedFile =
      Date.now() < archiveLookupPausedUntil
        ? null
        : await findIndividualPdf({
        roll,
        filename: archiveFilename,
      });

    if (archivedFile) {
      console.log(
        `♻️ MEGA archive found: ${filename}`
      );

      const archivedBuffer =
        await getIndividualPdf({
          roll,
          filename: archiveFilename,
        });

      if (
        Buffer.isBuffer(archivedBuffer) &&
        (await isMergeablePdf(
          archivedBuffer
        ))
      ) {
        pdfBuffer = archivedBuffer;
        archiveHit = true;
        archiveLookupFailures = 0;

        console.log(
          `☁️ Using MEGA PDF: ${filename}`
        );
      } else {
        // Corrupt / truncated archive copy -> portal se dobara lo
        console.error(
          `⚠️ MEGA PDF invalid, falling back to portal: ${filename}`
        );
      }
    }
  } catch (archiveError) {
    archiveLookupFailures++;

    if (archiveLookupFailures >= 3) {
      archiveLookupPausedUntil =
        Date.now() + 2 * 60 * 1000;

      archiveLookupFailures = 0;
    }

    console.error(
      `⚠️ MEGA lookup failed (${filename}):`,
      archiveError?.message ||
        archiveError
    );
  }

  /*
   * =====================================================
   * 2. PORTAL FALLBACK
   * =====================================================
   */
  if (!pdfBuffer) {
    const result =
      await checkResult({
        session:
          config.session,
        examType:
          config.examType,
        course:
          config.course,
        roll,
      });

    if (
      !result ||
      !result.success ||
      result.type !== "pdf" ||
      !result.pdfUrl
    ) {
      return null;
    }

    pdfUrl = result.pdfUrl;

    const downloaded =
      await downloadPdf(
        pdfUrl,
        filePath
      );

    if (!downloaded) {
      return null;
    }

    /*
     * Downloaded original PDF ko memory
     * mein bhi rakho, taaki MEGA mein
     * exactly same PDF upload ho.
     */
    try {
      pdfBuffer =
        await fs.promises.readFile(
          filePath
        );
    } catch (readError) {
      console.error(
        `⚠️ Unable to read downloaded PDF (${filename}):`,
        readError?.message ||
          readError
      );

      return null;
    }

    if (
      !(await isMergeablePdf(
        pdfBuffer
      ))
    ) {
      console.error(
        `⚠️ Portal PDF invalid, skipped: ${filename}`
      );

      return null;
    }
  }

  /*
   * =====================================================
   * 3. WRITE LOCAL FILE (archive se PEHLE)
   * =====================================================
   *
   * MEGA upload buffer ko in-place encrypt/modify kar sakta
   * hai. Isliye local file archive se pehle likhi jaati hai,
   * aur archive ko buffer ki COPY di jaati hai. Portal path
   * mein file downloadPdf() se pehle hi disk par hai.
   */
  if (archiveHit) {
    try {
      await fs.promises.writeFile(
        filePath,
        pdfBuffer
      );
    } catch (writeError) {
      console.error(
        `⚠️ Unable to prepare bulk PDF (${filename}):`,
        writeError?.message ||
          writeError
      );

      return null;
    }
  }

  /*
   * =====================================================
   * 4. MEGA ARCHIVE
   * =====================================================
   *
   * Sirf individual original PDF archive hoga.
   * Merged PDF yahan se kabhi archive nahi hoga.
   */
  if (
    Buffer.isBuffer(pdfBuffer) &&
    !archiveHit
  ) {
    try {
      const archiveResult =
        await archiveIndividualPdf({
          buffer: Buffer.from(pdfBuffer),
          roll,
          session:
            config.session,
          examType:
            config.examType,
          course:
            config.course,
          filename: archiveFilename,
        });

      if (
        archiveResult?.ok &&
        (
          archiveResult.uploaded ||
          archiveResult.existed
        )
      ) {
        console.log(
          `☁️ Bulk Subject archived: ${filename}`
        );
      } else {
        console.warn(
          `⚠️ Bulk Subject archive returned unexpected result: ${filename}`
        );
      }
    } catch (archiveError) {
      console.error(
        `⚠️ Bulk Subject MEGA upload failed (${filename}):`,
        archiveError?.message ||
          archiveError
      );
    }
  } else if (archiveHit) {
    console.log(
      `♻️ Bulk Subject using archived PDF: ${filename}`
    );
  }

  return {
    roll,
    pdfUrl,
    filePath,
  };
}

async function updateProgress(
  bot,
  userState,
  chatId,
  progressMessageId,
  config,
  completed,
  total,
  found,
  force = false
) {
  const state =
    getState(
      userState,
      chatId
    );

  if (
    !state ||
    state.bulkCancelled
  ) {
    return;
  }

  if (
    !force &&
    completed !== total &&
    completed % 5 !== 0
  ) {
    return;
  }

  const width =
    Math.max(
      4,
      String(total).length
    );

  const current =
    String(completed)
      .padStart(
        width,
        "0"
      );

  const totalFormatted =
    String(total)
      .padStart(
        width,
        "0"
      );

  const text =
    `🔎 <b>Checking: ${current}/${totalFormatted}</b>\n` +
    `📥 <b>Downloaded: ${found}</b>`;

  try {
    await bot.editMessageText(
      text,
      {
        chat_id:
          chatId,
        message_id:
          progressMessageId,
        parse_mode:
          "HTML",
      }
    );
  } catch (_) {}
}

async function searchAllRolls(
  bot,
  userState,
  chatId,
  config,
  rolls,
  progressMessageId
) {
  const results = [];

  let nextIndex = 0;

  let completed = 0;

  let found = 0;

  async function worker() {
    while (true) {
      const state =
        getState(
          userState,
          chatId
        );

      if (
        !state ||
        state.bulkCancelled
      ) {
        return;
      }

      const index =
        nextIndex++;

      if (
        index >=
        rolls.length
      ) {
        return;
      }

      const roll =
        rolls[index];

      try {
        const result =
          await searchAndDownloadRoll(
            config,
            roll,
            config.workDir
          );

        if (result) {
          results.push(
            result
          );

          found++;
        }
      } catch (_) {}

      completed++;

      await updateProgress(
        bot,
        userState,
        chatId,
        progressMessageId,
        config,
        completed,
        rolls.length,
        found
      );
    }
  }

  const workerCount =
    Math.min(
      SEARCH_CONCURRENCY,
      rolls.length
    );

  const workers = [];

  for (
    let i = 0;
    i < workerCount;
    i++
  ) {
    workers.push(
      worker()
    );
  }

  const restoreConsole =
    silenceConsole();

  try {
    await Promise.all(
      workers
    );
  } finally {
    restoreConsole();
  }

  results.sort(
    (a, b) => {
      const aa =
        BigInt(a.roll);

      const bb =
        BigInt(b.roll);

      if (aa < bb) {
        return -1;
      }

      if (aa > bb) {
        return 1;
      }

      return 0;
    }
  );

  await updateProgress(
    bot,
    userState,
    chatId,
    progressMessageId,
    config,
    completed,
    rolls.length,
    found,
    true
  );

  return {
    results,
    completed,
    found,
  };
}

async function mergePdfs(
  files,
  outputFile
) {
  const merged =
    await PDFDocument.create();

  let addedPages = 0;
  let skippedFiles = 0;

  /*
   * Files parallel batch mein disk se padho (I/O fast),
   * phir order maintain karke merge karo.
   */
  const BATCH = 25;

  for (
    let i = 0;
    i < files.length;
    i += BATCH
  ) {
    const batch =
      files.slice(
        i,
        i + BATCH
      );

    const buffers =
      await Promise.all(
        batch.map((file) =>
          fs.promises
            .readFile(file)
            .catch(() => null)
        )
      );

    for (
      let j = 0;
      j < batch.length;
      j++
    ) {
      const buffer =
        buffers[j];

      if (!buffer) {
        skippedFiles++;

        continue;
      }

      try {
        const source =
          await PDFDocument.load(
            buffer,
            {
              ignoreEncryption:
                true,
              updateMetadata:
                false,
              ...FAST_PARSE,
            }
          );

        const pages =
          await merged.copyPages(
            source,
            source.getPageIndices()
          );

        for (
          const page of pages
        ) {
          merged.addPage(
            page
          );

          addedPages++;
        }
      } catch (mergeError) {
        skippedFiles++;

        console.error(
          `⚠️ Merge skipped ${path.basename(
            batch[j]
          )}:`,
          mergeError?.message ||
            mergeError
        );
      }
    }
  }

  if (skippedFiles) {
    console.error(
      `⚠️ Merge: ${skippedFiles}/${files.length} file(s) skipped (invalid PDF)`
    );
  }

  if (!addedPages) {
    throw new Error(
      "No valid PDF pages could be merged."
    );
  }

  /*
   * useObjectStreams:false => save() kaafi fast
   * (file size thodi badi, par result PDFs chhoti hain).
   */
  const bytes =
    await merged.save({
      useObjectStreams: false,
    });

  await fs.promises.writeFile(
    outputFile,
    bytes
  );

  return outputFile;
}

async function sendMergedPdf(
  bot,
  chatId,
  config,
  outputFile
) {
  const filename =
    `Patliputra_${sanitizeFilename(
      config.course
    )}_${config.rollFrom}-${config.rollTo}_${sanitizeFilename(
      config.session
    )}.pdf`;

  const caption =
    `📚 <b>Patliputra University Bulk Result</b>\n\n` +
    `📅 Session: <b>${escapeHtml(
      config.session
    )}</b>\n` +
    `🎓 Exam Type: <b>${escapeHtml(
      config.examType
    )}</b>\n` +
    `📖 Course: <b>${escapeHtml(
      config.course
    )}</b>\n` +
    `🔢 Roll Range: <b>${escapeHtml(
      config.rollFrom
    )} → ${escapeHtml(
      config.rollTo
    )}</b>\n` +
    `📄 Results Found: <b>${config.found}</b>`;

  const targets = [
    {
      name: "Bot Chat",
      chatId,
    },
  ];

  const channelId =
    process.env.BULK_CHANNEL_ID ||
    process.env.CHANNEL_ID ||
    process.env.CHAT_ID;

  if (
    channelId &&
    String(channelId) !==
      String(chatId)
  ) {
    targets.push({
      name: "Channel",
      chatId: channelId,
    });
  }

  /*
   * PDF sirf EK baar upload hoti hai (Bot Chat).
   * Channel ko Telegram ke file_id se bheja jaata hai,
   * jo instant hai (re-upload nahi).
   */
  const results = [];

  let fileRef = outputFile;
  let usingFileId = false;

  for (const target of targets) {
    const sendOnce = (ref, withName) =>
      bot.sendDocument(
        target.chatId,
        ref,
        {
          caption,
          parse_mode: "HTML",
        },
        withName
          ? {
              filename,
              contentType:
                "application/pdf",
            }
          : {}
      );

    try {
      let sent;

      try {
        sent = await sendOnce(
          fileRef,
          !usingFileId
        );
      } catch (error) {
        if (!usingFileId) {
          throw error;
        }

        // file_id fail hua -> normal upload fallback
        sent = await sendOnce(
          outputFile,
          true
        );
      }

      const fileId =
        sent?.document?.file_id;

      if (fileId) {
        fileRef = fileId;
        usingFileId = true;
      }

      results.push({
        name: target.name,
        success: true,
      });
    } catch (error) {
      results.push({
        name: target.name,
        success: false,
        error:
          error.message ||
          "Unknown error",
      });
    }
  }

  const sentTo = [];

  const failed = [];

  for (
    const result of results
  ) {
    if (result.success) {
      sentTo.push(
        result.name
      );
    } else {
      failed.push({
        name:
          result.name,
        error:
          result.error,
      });
    }
  }

  return {
    filename,
    sentTo,
    failed,
  };
}

async function runBulk(
  bot,
  userState,
  chatId
) {
  const state =
    getState(
      userState,
      chatId
    );

  if (!state) {
    return;
  }

  if (
    state.bulkRunning
  ) {
    return;
  }

  state.bulkRunning =
    true;

  state.bulkCancelled =
    false;

  userState.set(
    chatId,
    state
  );

  const config = {
    session:
      state.session,
    examType:
      state.examType,
    course:
      state.course,
    rollFrom:
      state.rollFrom,
    rollTo:
      state.rollTo,
    found: 0,
    workDir: null,
  };

  let workDir = null;

  try {
    const count =
      getRollCount(
        config.rollFrom,
        config.rollTo
      );

    if (!count) {
      throw new Error(
        "Invalid roll range."
      );
    }

    if (
      count > MAX_ROLLS
    ) {
      throw new Error(
        `Maximum ${MAX_ROLLS} rolls are allowed in one bulk run.`
      );
    }

    workDir =
      await fs.promises.mkdtemp(
        path.join(
          os.tmpdir(),
          "ppu-bulk-"
        )
      );

    config.workDir =
      workDir;

    const rolls =
      generateRolls(
        config.rollFrom,
        config.rollTo
      );

    console.log(
      `🚀 Bulk search started: ${config.course} | ${count} rolls`
    );

    const width =
      Math.max(
        4,
        String(count).length
      );

    const initialText =
      `🔎 <b>Checking: ${String(
        0
      ).padStart(
        width,
        "0"
      )}/${String(
        count
      ).padStart(
        width,
        "0"
      )}</b>\n` +
      `📥 <b>Downloaded: 0</b>`;

    const progressMessage =
      await replaceMessage(
        bot,
        userState,
        chatId,
        initialText,
        {
          parse_mode:
            "HTML",
        }
      );

    const searchData =
      await searchAllRolls(
        bot,
        userState,
        chatId,
        config,
        rolls,
        progressMessage.message_id
      );

    const latestState =
      getState(
        userState,
        chatId
      );

    if (
      latestState &&
      latestState.bulkCancelled
    ) {
      await replaceMessage(
        bot,
        userState,
        chatId,
        "❌ <b>Bulk process cancelled.</b>",
        {
          parse_mode:
            "HTML",
        }
      );

      return;
    }

    const foundResults =
      searchData.results;

    config.found =
      foundResults.length;

    if (
      !foundResults.length
    ) {
      await replaceMessage(
        bot,
        userState,
        chatId,
        `❌ <b>No Results Found</b>\n\n` +
          `📅 Session: <b>${escapeHtml(
            config.session
          )}</b>\n` +
          `🎓 Exam Type: <b>${escapeHtml(
            config.examType
          )}</b>\n` +
          `📚 Course: <b>${escapeHtml(
            config.course
          )}</b>\n` +
          `🔢 Roll Range: <code>${escapeHtml(
            config.rollFrom
          )}</code> → <code>${escapeHtml(
            config.rollTo
          )}</code>`,
        {
          parse_mode:
            "HTML",
        }
      );

      return;
    }

    await replaceMessage(
      bot,
      userState,
      chatId,
      `📦 <b>Merging PDFs...</b>\n\n` +
        `🔎 Rolls Checked: <b>${searchData.completed}/${count}</b>\n` +
        `📄 PDFs Found: <b>${foundResults.length}</b>`,
      {
        parse_mode: "HTML",
      }
    );

    const downloadedFiles = foundResults
      .map((item) => item.filePath)
      .filter(Boolean);

    const outputFile =
      path.join(
        workDir,
        `Patliputra_${sanitizeFilename(
          config.course
        )}_${config.rollFrom}-${config.rollTo}_${sanitizeFilename(
          config.session
        )}.pdf`
      );

    await mergePdfs(
      downloadedFiles,
      outputFile
    );

    const stat =
      await fs.promises.stat(
        outputFile
      );

    const sizeMB =
      (
        stat.size /
        1024 /
        1024
      ).toFixed(2);

    const sendResult =
      await sendMergedPdf(
        bot,
        chatId,
        config,
        outputFile
      );

    let finalText =
      `🎉 <b>Bulk Result Completed</b>\n\n` +
      `📅 Session: <b>${escapeHtml(
        config.session
      )}</b>\n` +
      `🎓 Exam Type: <b>${escapeHtml(
        config.examType
      )}</b>\n` +
      `📚 Course: <b>${escapeHtml(
        config.course
      )}</b>\n` +
      `🔢 Roll Range: <code>${escapeHtml(
        config.rollFrom
      )}</code> → <code>${escapeHtml(
        config.rollTo
      )}</code>\n` +
      `🔎 Rolls Checked: <b>${searchData.completed}/${count}</b>\n` +
      `📄 PDFs Downloaded: <b>${foundResults.length}</b>\n` +
      `💾 Merged PDF: <b>${sizeMB} MB</b>\n\n` +
      `📤 <b>Sent To</b>\n`;

    if (
      sendResult.sentTo.length
    ) {
      finalText +=
        sendResult.sentTo
          .map(
            (name) =>
              `✅ ${escapeHtml(
                name
              )}`
          )
          .join("\n");
    } else {
      finalText +=
        "❌ None";
    }

    if (
      sendResult.failed.length
    ) {
      finalText +=
        `\n\n⚠️ <b>Failed</b>\n` +
        sendResult.failed
          .map(
            (item) =>
              `❌ ${escapeHtml(
                item.name
              )}`
          )
          .join("\n");
    }

    await replaceMessage(
      bot,
      userState,
      chatId,
      finalText,
      {
        parse_mode:
          "HTML",

        reply_markup: {
          inline_keyboard: [
            [
              {
                text:
                  "🔄 New Bulk",
                callback_data:
                  "BULK_MENU",
              },
              {
                text:
                  "❌ Close",
                callback_data:
                  "BULK_CANCEL",
              },
            ],
          ],
        },
      }
    );

    console.log(
      `🎉 Bulk completed: ${foundResults.length} PDFs`
    );

    /*
     * Supabase save ab delivery ke BAAD hota hai,
     * taaki user ko PDF jaldi mile. workDir cleanup
     * finally block mein iske baad hi hota hai.
     */
    try {
      await saveAllDownloadedResults(
        foundResults,
        config
      );
    } catch (saveError) {
      console.error(
        "⚠️ Post-send save failed:",
        saveError?.message ||
          saveError
      );
    }
  } catch (error) {
    console.error(
      "❌ Bulk subject error:",
      error.message
    );

    await replaceMessage(
      bot,
      userState,
      chatId,
      `❌ <b>Bulk Process Failed</b>\n\n${escapeHtml(
        error.message
      )}`,
      {
        parse_mode:
          "HTML",
      }
    );
  } finally {
    const latestState =
      getState(
        userState,
        chatId
      );

    if (latestState) {
      latestState.bulkRunning =
        false;

      userState.set(
        chatId,
        latestState
      );
    }

    if (workDir) {
      try {
        await fs.promises.rm(
          workDir,
          {
            recursive:
              true,
            force:
              true,
          }
        );
      } catch (_) {}
    }
  }
}

async function handleCallback(
  bot,
  userState,
  chatId,
  data
) {
  const state =
    getState(
      userState,
      chatId
    );

  if (!state) {
    return start(
      bot,
      userState,
      chatId
    );
  }

  if (
    data ===
    "BULK_SUBJECT"
  ) {
    return startSubject(
      bot,
      userState,
      chatId
    );
  }

  if (
    data ===
    "BULK_MENU"
  ) {
    return start(
      bot,
      userState,
      chatId
    );
  }

  if (
    data ===
    "BULK_SUBJECT_SESSION"
  ) {
    return showSessions(
      bot,
      userState,
      chatId
    );
  }

  if (
    data ===
    "BULK_SUBJECT_EXAM"
  ) {
    return showExamTypes(
      bot,
      userState,
      chatId,
      state.session
    );
  }

  if (
    data ===
    "BULK_SUBJECT_COURSE"
  ) {
    return showCourses(
      bot,
      userState,
      chatId,
      state.session,
      state.examType
    );
  }

  if (
    data ===
    "BULK_SUBJECT_ROLL_FROM"
  ) {
    return showRollFrom(
      bot,
      userState,
      chatId
    );
  }

  if (
    data.startsWith(
      "BULKS_"
    )
  ) {
    const session =
      decodeValue(
        data.substring(6)
      );

    state.session =
      session;

    state.examType =
      null;

    state.course =
      null;

    state.rollFrom =
      null;

    state.rollTo =
      null;

    userState.set(
      chatId,
      state
    );

    return showExamTypes(
      bot,
      userState,
      chatId,
      session
    );
  }

  if (
    data.startsWith(
      "BULKE_"
    )
  ) {
    const examType =
      decodeValue(
        data.substring(6)
      );

    state.examType =
      examType;

    state.course =
      null;

    state.rollFrom =
      null;

    state.rollTo =
      null;

    userState.set(
      chatId,
      state
    );

    return showCourses(
      bot,
      userState,
      chatId,
      state.session,
      examType
    );
  }

  if (
    data.startsWith(
      "BULKC_"
    )
  ) {
    const course =
      decodeValue(
        data.substring(6)
      );

    state.course =
      course;

    state.rollFrom =
      null;

    state.rollTo =
      null;

    userState.set(
      chatId,
      state
    );

    return showRollFrom(
      bot,
      userState,
      chatId
    );
  }

  return false;
}

async function handleMessage(
  bot,
  userState,
  msg
) {
  if (!msg.text) {
    return false;
  }

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === "/bulksubject") {
    return startSubject(
      bot,
      userState,
      chatId
    );
  }

  const state = userState.get(chatId);

  if (!state) {
    return false;
  }

  if (
    state.mode !== "bulk"
  ) {
    return false;
  }

  if (
    state.bulkType !== "subject"
  ) {
    return false;
  }

  if (
    state.bulkStep ===
    "roll_from"
  ) {
    if (
      !isValidRoll(text)
    ) {
      await bot.sendMessage(
        chatId,
        `❌ <b>Invalid Roll Number</b>\n\n` +
          `Please enter a valid numeric roll number.\n\n` +
          `Example:\n<code>2520641060001</code>`,
        {
          parse_mode:
            "HTML",
        }
      );

      return true;
    }

    state.rollFrom =
      text;

    state.rollTo =
      null;

    userState.set(
      chatId,
      state
    );

    await showRollTo(
      bot,
      userState,
      chatId
    );

    return true;
  }

  if (
    state.bulkStep ===
    "roll_to"
  ) {
    if (
      !isValidRoll(text)
    ) {
      await bot.sendMessage(
        chatId,
        `❌ <b>Invalid Roll Number</b>\n\n` +
          `Please enter a valid numeric roll number.\n\n` +
          `Example:\n<code>2520641060200</code>`,
        {
          parse_mode:
            "HTML",
        }
      );

      return true;
    }

    let fromBigInt;
    let toBigInt;

    try {
      fromBigInt =
        BigInt(
          state.rollFrom
        );

      toBigInt =
        BigInt(text);
    } catch (_) {
      return true;
    }

    if (
      toBigInt <
      fromBigInt
    ) {
      await bot.sendMessage(
        chatId,
        `❌ <b>Invalid Roll Range</b>\n\n` +
          `Roll To must be greater than or equal to Roll From.\n\n` +
          `Roll From:\n<code>${escapeHtml(
            state.rollFrom
          )}</code>`,
        {
          parse_mode:
            "HTML",
        }
      );

      return true;
    }

    const count =
      getRollCount(
        state.rollFrom,
        text
      );

    if (
      count > MAX_ROLLS
    ) {
      await bot.sendMessage(
        chatId,
        `❌ <b>Roll Range Too Large</b>\n\n` +
          `Selected: <b>${count}</b> rolls\n` +
          `Maximum allowed: <b>${MAX_ROLLS}</b> rolls.`,
        {
          parse_mode:
            "HTML",
        }
      );

      return true;
    }

    state.rollTo =
      text;

    state.bulkStep =
      "ready";

    state.bulkRunning =
      false;

    state.bulkCancelled =
      false;

    userState.set(
      chatId,
      state
    );

    await runBulk(
      bot,
      userState,
      chatId
    );

    return true;
  }

  return false;
}

module.exports = {
  start,
  startSubject,
  handleCallback,
  handleMessage,
};