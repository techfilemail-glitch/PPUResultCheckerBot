const fs = require("fs");
const path = require("path");

const { getSessions, getExamTypes, getCourses } = require("../result-checker");

const MAX_SUBJECTS_PER_SELECTION = 100;
const COLLEGES_PER_PAGE = 25;
const CSV_PER_PAGE = 20;
const SUBJECTS_PER_PAGE = 25;

// Telegram message limit is 4096 chars; keep summary list safely below it.
const SUMMARY_SUBJECT_TEXT_LIMIT = 2600;

// FIXED ROLL RANGE — NEVER ASK USER
const FIXED_ROLL_FROM = 1;
const FIXED_ROLL_TO = 250;

let csvCache = null;
let csvCacheTime = 0;
const CSV_CACHE_TTL = 60 * 1000;

function getState(userState, chatId) {
  if (!userState.has(chatId)) {
    userState.set(chatId, {});
  }

  return userState.get(chatId);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalize(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeCode(value) {
  return String(value || "").trim().replace(/\s+/g, "");
}

/*
=========================================================
CSV PARSER
=========================================================
*/

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let insideQuotes = false;

  const hasContent = (r) => r.some((value) => String(value || "").trim() !== "");

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (insideQuotes && next === '"') {
        field += '"';
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }

      continue;
    }

    if (char === "," && !insideQuotes) {
      row.push(field);
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !insideQuotes) {
      if (char === "\r" && next === "\n") {
        i++;
      }

      row.push(field);
      field = "";

      if (hasContent(row)) {
        rows.push(row);
      }

      row = [];
      continue;
    }

    field += char;
  }

  if (field !== "" || row.length > 0) {
    row.push(field);

    if (hasContent(row)) {
      rows.push(row);
    }
  }

  return rows;
}

function detectColumn(headers, names) {
  const normalizedHeaders = headers.map((header) => normalize(header));

  for (const name of names) {
    const index = normalizedHeaders.indexOf(normalize(name));

    if (index !== -1) {
      return index;
    }
  }

  return -1;
}

function detectSectionColumns(headers) {
  const result = [];

  headers.forEach((header, index) => {
    const value = normalize(header);

    if (
      value === "pg reg" ||
      value === "pg voc" ||
      value === "ug voc" ||
      value === "ug reg" ||
      value === "ug regular"
    ) {
      result.push({
        index,
        section: String(header).trim(),
      });
    }
  });

  return result;
}

function normalizeSection(value) {
  const text = normalize(value);

  if (text === "ug voc" || text.includes("ug vocational")) {
    return "UG VOC";
  }

  if (text === "pg voc" || text.includes("pg vocational")) {
    return "PG VOC";
  }

  if (text === "pg reg" || text.includes("pg regular")) {
    return "PG REG";
  }

  if (text === "ug reg" || text === "ug regular") {
    return "UG REG";
  }

  return String(value || "").trim();
}

function isVocationalCsv(fileName) {
  const name = normalize(path.basename(fileName || ""));

  return name === "pgv code.csv" || name === "ugv code.csv";
}

/*
=========================================================
FIND ALL CSV FILES
=========================================================
*/

function getBulkFolder() {
  return __dirname;
}

function scanCsvFiles(force = false) {
  const now = Date.now();

  if (!force && csvCache && now - csvCacheTime < CSV_CACHE_TTL) {
    return csvCache;
  }

  const folder = getBulkFolder();

  if (!fs.existsSync(folder)) {
    throw new Error(`Bulk folder not found: ${folder}`);
  }

  const files = fs
    .readdirSync(folder, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && path.extname(entry.name).toLowerCase() === ".csv"
    )
    .map((entry) => {
      const fullPath = path.join(folder, entry.name);

      const stat = fs.statSync(fullPath);

      return {
        name: entry.name,
        path: fullPath,
        size: stat.size,
        modified: stat.mtimeMs,
      };
    })
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: "base",
      })
    );

  csvCache = files;
  csvCacheTime = now;

  console.log(`📂 Bulk CSV scan: ${files.length} file(s)`);

  for (const file of files) {
    console.log(`   📄 ${file.name}`);
  }

  return files;
}

/*
=========================================================
LOAD ONE CSV
=========================================================
*/

function loadCsvFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");

  const rows = parseCSV(text);

  if (!rows.length) {
    throw new Error(`${path.basename(filePath)} is empty.`);
  }

  const headers = rows[0].map((header) =>
    String(header || "")
      .replace(/^\uFEFF/, "")
      .trim()
  );

  const codeIndex = detectColumn(headers, [
    "College Code",
    "CollegeCode",
    "College Code ",
    "Code",
  ]);

  const collegeIndex = detectColumn(headers, [
    "College",
    "College Name",
    "CollegeName",
  ]);

  const subjectIndex = detectColumn(headers, [
    "Subject",
    "Subject Name",
    "SubjectName",
  ]);

  const subjectCodeIndex = detectColumn(headers, [
    "SubjectCode",
    "Subject Code",
    "Subject_Code",
    "Subject Code ",
  ]);

  const sectionIndex = detectColumn(headers, [
    "Section",
    "Type",
    "Category",
    "Programme",
    "Program",
  ]);

  const courseIndex = detectColumn(headers, ["Course", "Degree", "UG Degree"]);

  // Master CSV: "Course Duration" (e.g. "4", "2", "1 YEAR")
  const durationIndex = detectColumn(headers, [
    "Course Duration",
    "Duration",
    "Course Duration (Years)",
  ]);

  const sectionColumns = detectSectionColumns(headers);

  if (
    codeIndex === -1 ||
    collegeIndex === -1 ||
    subjectIndex === -1 ||
    subjectCodeIndex === -1
  ) {
    throw new Error(
      `${path.basename(
        filePath
      )} has invalid headers.\nRequired: College Code, College, Subject, SubjectCode`
    );
  }

  const data = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    if (!row || !row.length) {
      continue;
    }

    const collegeCode = String(row[codeIndex] || "").trim();
    const collegeName = String(row[collegeIndex] || "").trim();
    const subject = String(row[subjectIndex] || "").trim();
    const subjectCode = String(row[subjectCodeIndex] || "").trim();

    if (!collegeCode || !collegeName || !subject) {
      continue;
    }

    let section = "";

    if (sectionIndex !== -1) {
      section = String(row[sectionIndex] || "").trim();
    }

    if (!section && sectionColumns.length) {
      for (const item of sectionColumns) {
        const value = String(row[item.index] || "").trim();

        if (value) {
          section = item.section;
          break;
        }
      }
    }

    if (!section) {
      section = path.basename(filePath, ".csv").trim();
    }

    section = normalizeSection(section);

    data.push({
      collegeCode,
      collegeName,
      section,
      subject,
      subjectCode,
      course: courseIndex !== -1 ? String(row[courseIndex] || "").trim() : "",
      duration:
        durationIndex !== -1 ? String(row[durationIndex] || "").trim() : "",
    });
  }

  return data;
}

/*
=========================================================
LOAD SELECTED CSV
=========================================================
*/

function loadSelectedCsv(state) {
  if (!state.collegeCsvPath) {
    throw new Error("No CSV file selected.");
  }

  if (!fs.existsSync(state.collegeCsvPath)) {
    throw new Error("Selected CSV file no longer exists.");
  }

  return loadCsvFile(state.collegeCsvPath);
}

/*
=========================================================
COLLEGE LIST
=========================================================
*/

function getColleges(data) {
  const map = new Map();

  for (const item of data) {
    const key = `${normalizeCode(item.collegeCode)}|||${normalize(
      item.collegeName
    )}`;

    if (!map.has(key)) {
      map.set(key, {
        code: String(item.collegeCode).trim(),
        name: String(item.collegeName).trim(),
      });
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    const aa = Number(a.code);
    const bb = Number(b.code);

    if (!Number.isNaN(aa) && !Number.isNaN(bb)) {
      return aa - bb;
    }

    return a.code.localeCompare(b.code, undefined, { numeric: true });
  });
}

/*
=========================================================
SUBJECT LIST
=========================================================
*/

function getSubjects(data, collegeCode) {
  const map = new Map();

  for (const item of data) {
    if (normalizeCode(item.collegeCode) !== normalizeCode(collegeCode)) {
      continue;
    }

    const key = `${normalize(item.subject)}|||${normalizeCode(
      item.subjectCode
    )}`;

    if (!map.has(key)) {
      map.set(key, {
        subject: item.subject,
        subjectCode: item.subjectCode,
        section: item.section || "",
      });
    } else {
      const existing = map.get(key);

      if (!existing.section && item.section) {
        existing.section = item.section;
      }
    }
  }

  return Array.from(map.values()).sort((a, b) =>
    a.subject.localeCompare(b.subject, undefined, { sensitivity: "base" })
  );
}

/*
=========================================================
SUBJECT CATEGORY
=========================================================
*/

const ARTS_KEYWORDS = [
  "economics",
  "history",
  "political",
  "sociology",
  "geography",
  "psychology",
  "philosophy",
  "english",
  "hindi",
  "urdu",
  "sanskrit",
  "persian",
  "home science",
  "home-science",
  "music",
  "fine arts",
  "social work",
  "social science",
  "ancient history",
  "medieval history",
  "public administration",
];

const SCIENCE_KEYWORDS = [
  "physics",
  "chemistry",
  "mathematics",
  "math",
  "botany",
  "zoology",
  "biology",
  "computer",
  "statistics",
  "electronics",
  "geology",
  "environmental",
  "biotechnology",
  "microbiology",
  "information technology",
  "information science",
  "data science",
];

const COMMERCE_KEYWORDS = [
  "commerce",
  "account",
  "accountancy",
  "business",
  "management",
  "finance",
  "marketing",
  "banking",
  "taxation",
  "corporate",
];

function getSubjectCategory(subject) {
  const text = normalize(subject?.subject);
  const section = normalize(subject?.section);

  // First preference: CSV itself says Arts / Science / Commerce.
  if (section.includes("arts") || section.includes("humanities")) {
    return "arts";
  }

  if (section.includes("science")) {
    return "science";
  }

  if (section.includes("commerce")) {
    return "commerce";
  }

  if (ARTS_KEYWORDS.some((word) => text.includes(word))) {
    return "arts";
  }

  if (SCIENCE_KEYWORDS.some((word) => text.includes(word))) {
    return "science";
  }

  if (COMMERCE_KEYWORDS.some((word) => text.includes(word))) {
    return "commerce";
  }

  // Unknown subjects stay in Arts so the UI always has 3 categories.
  return "arts";
}

function getSubjectsByCategory(subjects, category) {
  return subjects.filter((subject) => getSubjectCategory(subject) === category);
}

/*
=========================================================
MESSAGE HELPERS
=========================================================
*/

async function safeDelete(bot, chatId, messageId) {
  if (!messageId) {
    return;
  }

  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (_) {}
}

async function replaceMessage(bot, userState, chatId, text, options = {}) {
  const state = getState(userState, chatId);

  if (state.collegeMessageId) {
    await safeDelete(bot, chatId, state.collegeMessageId);
  }

  const sent = await bot.sendMessage(chatId, text, options);

  state.collegeMessageId = sent.message_id;

  userState.set(chatId, state);

  return sent;
}

/*
 * Edit the current bulk-college message in place.
 * If editing is not possible, fall back to replaceMessage
 * so the tracked message id always stays correct
 * (no duplicate / stale messages with dead buttons).
 */
async function renderInPlace(bot, userState, chatId, text, options = {}) {
  const state = getState(userState, chatId);

  if (state.collegeMessageId) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: state.collegeMessageId,
        ...options,
      });

      return;
    } catch (error) {
      const description = String(
        error?.response?.body?.description || error?.message || ""
      );

      if (description.includes("message is not modified")) {
        return;
      }
    }
  }

  await replaceMessage(bot, userState, chatId, text, options);
}

function cancelButtons() {
  return [{ text: "❌ Cancel", callback_data: "COLLEGE_CANCEL" }];
}

/*
=========================================================
START
=========================================================
*/

async function start(bot, userState, chatId) {
  const state = getState(userState, chatId);

  resetCollegeState(state);

  state.mode = "bulk";
  state.bulkType = "college";
  state.collegeStep = "session";

  state.session = null;
  state.examType = null;
  state.course = null;

  userState.set(chatId, state);

  console.log("🏫 Bulk College started");

  try {
    await showSessions(bot, userState, chatId);
  } catch (error) {
    console.error("❌ Bulk College start error:", error);

    await replaceMessage(
      bot,
      userState,
      chatId,
      `❌ <b>Bulk College Error</b>

${escapeHtml(error.message)}`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [cancelButtons()] },
      }
    );
  }
}

/*
=========================================================
OPTION RESOLVER
(callback_data is limited to 64 bytes, so long session /
exam / course values are referenced by index instead)
=========================================================
*/

async function resolveOption(state, key, loader, index) {
  let values = Array.isArray(state[key]) ? state[key] : null;

  if (!values) {
    const items = await loader();

    values = Array.isArray(items) ? items.map((item) => item.value) : [];

    state[key] = values;
  }

  return values[index];
}

/*
=========================================================
SESSION
=========================================================
*/

async function showSessions(bot, userState, chatId) {
  const state = getState(userState, chatId);

  state.collegeStep = "session";

  userState.set(chatId, state);

  const sessions = await getSessions();

  if (!Array.isArray(sessions) || !sessions.length) {
    throw new Error("No sessions available.");
  }

  state.collegeSessionValues = sessions.map((session) => session.value);

  const buttons = [];

  for (let i = 0; i < sessions.length; i += 2) {
    const row = [];

    for (let j = i; j < Math.min(i + 2, sessions.length); j++) {
      const session = sessions[j];

      row.push({
        text:
          state.session === session.value
            ? `✅ ${session.text}`
            : session.text,

        callback_data: `COLLEGE_SESSION_${j}`,
      });
    }

    buttons.push(row);
  }

  buttons.push(cancelButtons());

  await replaceMessage(
    bot,
    userState,
    chatId,
    `🏫 <b>Bulk College Result</b>

📅 <b>Step 1 — Select Session</b>

Choose the examination session.`,
    {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    }
  );
}

/*
=========================================================
EXAM TYPE
=========================================================
*/

async function showExamTypes(bot, userState, chatId) {
  const state = getState(userState, chatId);

  if (!state.session) {
    return showSessions(bot, userState, chatId);
  }

  state.collegeStep = "exam";

  userState.set(chatId, state);

  const exams = await getExamTypes(state.session);

  if (!Array.isArray(exams) || !exams.length) {
    throw new Error("No exam types available.");
  }

  state.collegeExamValues = exams.map((exam) => exam.value);

  const buttons = [];

  for (let i = 0; i < exams.length; i += 2) {
    const row = [];

    for (let j = i; j < Math.min(i + 2, exams.length); j++) {
      const exam = exams[j];

      row.push({
        text: state.examType === exam.value ? `✅ ${exam.text}` : exam.text,

        callback_data: `COLLEGE_EXAM_${j}`,
      });
    }

    buttons.push(row);
  }

  buttons.push([
    { text: "⬅️ Back", callback_data: "COLLEGE_BACK_SESSION" },
    { text: "❌ Cancel", callback_data: "COLLEGE_CANCEL" },
  ]);

  await replaceMessage(
    bot,
    userState,
    chatId,
    `🏫 <b>Bulk College Result</b>

📅 Session: <b>${escapeHtml(state.session)}</b>

🎓 <b>Step 2 — Select Exam Type</b>`,
    {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    }
  );
}

/*
=========================================================
COURSE
=========================================================
*/

async function showCourses(bot, userState, chatId) {
  const state = getState(userState, chatId);

  if (!state.session || !state.examType) {
    return showSessions(bot, userState, chatId);
  }

  state.collegeStep = "course";

  userState.set(chatId, state);

  const courses = await getCourses(state.session, state.examType);

  if (!Array.isArray(courses) || !courses.length) {
    throw new Error("No courses available.");
  }

  state.collegeCourseValues = courses.map((course) => course.value);

  const buttons = [];

  for (let i = 0; i < courses.length; i += 2) {
    const row = [];

    for (let j = i; j < Math.min(i + 2, courses.length); j++) {
      const course = courses[j];

      row.push({
        text:
          state.course === course.value ? `✅ ${course.text}` : course.text,

        callback_data: `COLLEGE_COURSE_${j}`,
      });
    }

    buttons.push(row);
  }

  buttons.push([
    { text: "⬅️ Back", callback_data: "COLLEGE_BACK_EXAM" },
    { text: "❌ Cancel", callback_data: "COLLEGE_CANCEL" },
  ]);

  await replaceMessage(
    bot,
    userState,
    chatId,
    `🏫 <b>Bulk College Result</b>

📅 Session: <b>${escapeHtml(state.session)}</b>

🎓 Exam Type: <b>${escapeHtml(state.examType)}</b>

📚 <b>Step 3 — Select Course / Semester</b>`,
    {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    }
  );
}

/*
=========================================================
CSV LIST
=========================================================
*/

async function showCsvFiles(bot, userState, chatId) {
  const state = getState(userState, chatId);

  const files = scanCsvFiles(true);

  if (!files.length) {
    throw new Error("No CSV files found inside the bulk folder.");
  }

  state.collegeCsvFiles = files;
  state.collegeCsvPage = 0;
  state.collegeStep = "csv";

  userState.set(chatId, state);

  await renderCsvPage(bot, userState, chatId);
}

async function renderCsvPage(bot, userState, chatId) {
  const state = getState(userState, chatId);

  const files = state.collegeCsvFiles || scanCsvFiles();

  const totalPages = Math.max(1, Math.ceil(files.length / CSV_PER_PAGE));

  let page = Number(state.collegeCsvPage || 0);

  page = Math.max(0, Math.min(page, totalPages - 1));

  state.collegeCsvPage = page;

  userState.set(chatId, state);

  const start = page * CSV_PER_PAGE;

  const end = Math.min(start + CSV_PER_PAGE, files.length);

  const buttons = [];

  for (let i = start; i < end; i++) {
    const file = files[i];

    buttons.push([
      {
        text: `📄 ${file.name}`,
        callback_data: `COLLEGE_CSV_${i}`,
      },
    ]);
  }

  const nav = [];

  if (page > 0) {
    nav.push({ text: "⬅️ Previous", callback_data: "COLLEGE_CSV_PREV" });
  }

  if (page < totalPages - 1) {
    nav.push({ text: "Next ➡️", callback_data: "COLLEGE_CSV_NEXT" });
  }

  if (nav.length) {
    buttons.push(nav);
  }

  buttons.push([
    { text: "⬅️ Back", callback_data: "COLLEGE_BACK_COURSE" },
    { text: "❌ Cancel", callback_data: "COLLEGE_CANCEL" },
  ]);

  await replaceMessage(
    bot,
    userState,
    chatId,
    `📂 <b>Step 4 — Select CSV</b>

📅 Session: <b>${escapeHtml(state.session)}</b>

🎓 Exam Type: <b>${escapeHtml(state.examType)}</b>

📚 Course: <b>${escapeHtml(state.course)}</b>

CSV files found: <b>${files.length}</b>

Select the CSV you want to use:`,
    {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    }
  );
}

/*
=========================================================
COLLEGE LIST
=========================================================
*/

async function showColleges(bot, userState, chatId) {
  const state = getState(userState, chatId);

  const data = loadSelectedCsv(state);

  const colleges = getColleges(data);

  if (!colleges.length) {
    throw new Error("No colleges found in selected CSV.");
  }

  state.collegeList = colleges;
  state.collegePage = 0;
  state.collegeStep = "college";

  userState.set(chatId, state);

  await renderCollegePage(bot, userState, chatId);
}

async function renderCollegePage(bot, userState, chatId) {
  const state = getState(userState, chatId);

  const colleges =
    state.collegeList || getColleges(loadSelectedCsv(state));

  const totalPages = Math.max(
    1,
    Math.ceil(colleges.length / COLLEGES_PER_PAGE)
  );

  let page = Number(state.collegePage || 0);

  page = Math.max(0, Math.min(page, totalPages - 1));

  state.collegePage = page;

  userState.set(chatId, state);

  const start = page * COLLEGES_PER_PAGE;

  const end = Math.min(start + COLLEGES_PER_PAGE, colleges.length);

  const buttons = [];

  for (let i = start; i < end; i++) {
    const college = colleges[i];

    buttons.push([
      {
        text: `${i + 1}. ${college.code} — ${college.name}`,
        callback_data: `COLLEGE_PICK_${i}`,
      },
    ]);
  }

  const nav = [];

  if (page > 0) {
    nav.push({ text: "⬅️ Previous", callback_data: "COLLEGE_PAGE_PREV" });
  }

  if (page < totalPages - 1) {
    nav.push({ text: "Next ➡️", callback_data: "COLLEGE_PAGE_NEXT" });
  }

  if (nav.length) {
    buttons.push(nav);
  }

  buttons.push([
    { text: "⬅️ Back", callback_data: "COLLEGE_BACK_CSV" },
    { text: "❌ Cancel", callback_data: "COLLEGE_CANCEL" },
  ]);

  await replaceMessage(
    bot,
    userState,
    chatId,
    `🏫 <b>Step 5 — Select College</b>

📂 CSV: <b>${escapeHtml(state.collegeCsvName)}</b>

Choose a college.

📄 Page <b>${page + 1}</b> / <b>${totalPages}</b>

🏫 Total Colleges: <b>${colleges.length}</b>`,
    {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    }
  );
}

/*
=========================================================
SUBJECT SELECTION
=========================================================
*/

function sameSubject(a, b) {
  return (
    normalizeCode(a.subjectCode) === normalizeCode(b.subjectCode) &&
    normalize(a.subject) === normalize(b.subject)
  );
}

function subjectSelected(state, subject) {
  return Array.isArray(state.selectedSubjects)
    ? state.selectedSubjects.some((item) => sameSubject(item, subject))
    : false;
}

function toggleSubject(state, subject) {
  if (!Array.isArray(state.selectedSubjects)) {
    state.selectedSubjects = [];
  }

  const index = state.selectedSubjects.findIndex((item) =>
    sameSubject(item, subject)
  );

  if (index === -1) {
    if (state.selectedSubjects.length >= MAX_SUBJECTS_PER_SELECTION) {
      return false;
    }

    state.selectedSubjects.push(subject);
  } else {
    state.selectedSubjects.splice(index, 1);
  }

  return true;
}

/*
=========================================================
LOAD + SHOW SUBJECT CATEGORIES
=========================================================
*/

async function showSubjects(bot, userState, chatId) {
  const state = getState(userState, chatId);

  if (!state.collegeCode) {
    throw new Error("College is not selected.");
  }

  const data = loadSelectedCsv(state);

  const subjects = getSubjects(data, state.collegeCode);

  if (!subjects.length) {
    throw new Error("No subjects found for this college in selected CSV.");
  }

  state.availableSubjects = subjects;
  state.selectedSubjects = Array.isArray(state.selectedSubjects)
    ? state.selectedSubjects
    : [];
  state.subjectCategory = null;
  state.subjectPage = 0;
  state.collegeStep = "subject_category";

  userState.set(chatId, state);

  // VOCATIONAL → Arts / Science / Commerce नहीं दिखाना
  if (isVocationalCsv(state.collegeCsvName)) {
    state.isVocational = true;

    userState.set(chatId, state);

    await showVocationalCategory(bot, userState, chatId);

    return;
  }

  state.isVocational = false;

  userState.set(chatId, state);

  await showSubjectCategories(bot, userState, chatId);
}

async function showVocationalCategory(bot, userState, chatId) {
  const state = getState(userState, chatId);

  const subjects = state.availableSubjects || [];

  const text = [
    "📚 <b>Step 6 — Select Subject Category</b>",
    "",
    `🏫 <b>College:</b> ${escapeHtml(state.collegeName || "N/A")}`,
    `🔢 <b>Code:</b> ${escapeHtml(state.collegeCode || "N/A")}`,
    `📄 <b>CSV:</b> ${escapeHtml(state.collegeCsvName || "N/A")}`,
    "",
    `🎓 <b>Vocational Subjects:</b> ${subjects.length}`,
    `✅ <b>Selected:</b> ${(state.selectedSubjects || []).length}`,
    "",
    "Select <b>Vocational</b> to view the complete subject list.",
  ].join("\n");

  const keyboard = [
    [
      {
        text: `🎓 Vocational (${subjects.length})`,
        callback_data: "COLLEGE_CATEGORY_VOCATIONAL",
      },
    ],
    [{ text: "➡️ Next", callback_data: "COLLEGE_SUBJECT_DONE" }],
    [
      { text: "⬅️ Back", callback_data: "COLLEGE_BACK_COLLEGE" },
      { text: "❌ Cancel", callback_data: "COLLEGE_CANCEL" },
    ],
  ];

  await renderInPlace(bot, userState, chatId, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard },
  });
}

/*
=========================================================
SHOW SUBJECT CATEGORIES
=========================================================
*/

async function showSubjectCategories(bot, userState, chatId) {
  const state = getState(userState, chatId);

  const subjects = state.availableSubjects || [];

  if (!subjects.length) {
    throw new Error("No subjects found for this college in selected CSV.");
  }

  if (!Array.isArray(state.selectedSubjects)) {
    state.selectedSubjects = [];
  }

  const arts = getSubjectsByCategory(subjects, "arts");
  const science = getSubjectsByCategory(subjects, "science");
  const commerce = getSubjectsByCategory(subjects, "commerce");

  state.collegeStep = "subject_category";
  state.subjectCategory = null;
  state.subjectPage = 0;

  userState.set(chatId, state);

  await replaceMessage(
    bot,
    userState,
    chatId,
    `📚 <b>Step 6 — Select Subject Category</b>

🏫 College: <b>${escapeHtml(state.collegeName)}</b>

🔢 College Code: <b>${escapeHtml(state.collegeCode)}</b>

📂 CSV: <b>${escapeHtml(state.collegeCsvName)}</b>

📊 Selected Subjects: <b>${state.selectedSubjects.length}</b>

Choose a category:`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: `🎨 Arts (${arts.length})`,
              callback_data: "COLLEGE_CATEGORY_ARTS",
            },
          ],
          [
            {
              text: `🔬 Science (${science.length})`,
              callback_data: "COLLEGE_CATEGORY_SCIENCE",
            },
          ],
          [
            {
              text: `💼 Commerce (${commerce.length})`,
              callback_data: "COLLEGE_CATEGORY_COMMERCE",
            },
          ],
          [
            {
              text: `➡️ Next (${state.selectedSubjects.length})`,
              callback_data: "COLLEGE_SUBJECT_DONE",
            },
          ],
          [
            { text: "⬅️ Back", callback_data: "COLLEGE_BACK_COLLEGE" },
            { text: "❌ Cancel", callback_data: "COLLEGE_CANCEL" },
          ],
        ],
      },
    }
  );
}

/*
=========================================================
SHOW SUBJECTS OF CATEGORY
=========================================================
*/

async function showCategorySubjects(bot, userState, chatId, category) {
  const state = getState(userState, chatId);

  const subjects = getSubjectsByCategory(
    state.availableSubjects || [],
    category
  );

  if (!subjects.length) {
    await bot.sendMessage(
      chatId,
      `⚠️ No ${category} subjects found for this college.`
    );

    return;
  }

  state.subjectCategory = category;
  state.subjectPage = 0;
  state.collegeStep = "subject";

  userState.set(chatId, state);

  await renderSubjectPage(bot, userState, chatId);
}

/*
=========================================================
CATEGORY UNSELECT
=========================================================
*/

function unselectCategory(state, category) {
  const categorySubjects = getSubjectsByCategory(
    state.availableSubjects || [],
    category
  );

  state.selectedSubjects = (state.selectedSubjects || []).filter(
    (selected) =>
      !categorySubjects.some((subject) => sameSubject(subject, selected))
  );
}

async function renderVocationalSubjectPage(bot, userState, chatId) {
  const state = getState(userState, chatId);

  const subjects = state.availableSubjects || [];
  const selected = state.selectedSubjects || [];

  const totalPages = Math.max(1, Math.ceil(subjects.length / SUBJECTS_PER_PAGE));

  const page = Math.min(Math.max(state.subjectPage || 0, 0), totalPages - 1);

  state.subjectPage = page;

  userState.set(chatId, state);

  const start = page * SUBJECTS_PER_PAGE;
  const pageSubjects = subjects.slice(start, start + SUBJECTS_PER_PAGE);

  const selectedCodes = new Set(selected.map((s) => String(s.subjectCode || "")));

  const text = [
    "🎓 <b>Vocational Subjects</b>",
    "",
    `🏫 <b>College:</b> ${escapeHtml(state.collegeName || "N/A")}`,
    `📄 <b>CSV:</b> ${escapeHtml(state.collegeCsvName || "N/A")}`,
    "",
    `📚 <b>Total Subjects:</b> ${subjects.length}`,
    `✅ <b>Selected:</b> ${selected.length}/${MAX_SUBJECTS_PER_SELECTION}`,
    "",
    `📄 <b>Page:</b> ${page + 1}/${totalPages}`,
    "",
    "Select or unselect subjects:",
  ].join("\n");

  const keyboard = [];

  pageSubjects.forEach((subject, index) => {
    const isSelected = selectedCodes.has(String(subject.subjectCode || ""));

    keyboard.push([
      {
        text: `${isSelected ? "✅" : "☐"} ${start + index + 1}. ${
          subject.subject
        } (${subject.subjectCode || "N/A"})`,
        callback_data: `COLLEGE_VOC_SUBJECT_${start + index}`,
      },
    ]);
  });

  keyboard.push([
    { text: "✅ Select All", callback_data: "COLLEGE_VOC_SELECT_ALL" },
    { text: "❌ Unselect All", callback_data: "COLLEGE_VOC_UNSELECT_ALL" },
  ]);

  const navigation = [];

  if (page > 0) {
    navigation.push({
      text: "⬅️ Previous",
      callback_data: "COLLEGE_VOC_PREV",
    });
  }

  if (page < totalPages - 1) {
    navigation.push({
      text: "Next ➡️",
      callback_data: "COLLEGE_VOC_NEXT",
    });
  }

  if (navigation.length) {
    keyboard.push(navigation);
  }

  keyboard.push([{ text: "➡️ Next", callback_data: "COLLEGE_SUBJECT_DONE" }]);

  keyboard.push([
    { text: "⬅️ Back", callback_data: "COLLEGE_VOC_BACK" },
    { text: "❌ Cancel", callback_data: "COLLEGE_CANCEL" },
  ]);

  await renderInPlace(bot, userState, chatId, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard },
  });
}

/*
=========================================================
RENDER CATEGORY SUBJECT PAGE
=========================================================
*/

async function renderSubjectPage(bot, userState, chatId) {
  const state = getState(userState, chatId);

  const category = state.subjectCategory;

  if (!category) {
    return showSubjectCategories(bot, userState, chatId);
  }

  const subjects = getSubjectsByCategory(
    state.availableSubjects || [],
    category
  );

  if (!subjects.length) {
    return showSubjectCategories(bot, userState, chatId);
  }

  if (!Array.isArray(state.selectedSubjects)) {
    state.selectedSubjects = [];
  }

  const totalPages = Math.max(1, Math.ceil(subjects.length / SUBJECTS_PER_PAGE));

  let page = Number(state.subjectPage || 0);

  page = Math.max(0, Math.min(page, totalPages - 1));

  state.subjectPage = page;

  userState.set(chatId, state);

  const start = page * SUBJECTS_PER_PAGE;

  const end = Math.min(start + SUBJECTS_PER_PAGE, subjects.length);

  const buttons = [];

  for (let i = start; i < end; i++) {
    const subject = subjects[i];

    const selected = subjectSelected(state, subject);

    buttons.push([
      {
        text: `${selected ? "✅" : "☐"} ${i + 1}. ${subject.subject} (${
          subject.subjectCode || "N/A"
        })`,

        callback_data: `COLLEGE_CATEGORY_SUBJECT_${i}`,
      },
    ]);
  }

  const categoryLabel =
    category === "arts"
      ? "🎨 Arts"
      : category === "science"
      ? "🔬 Science"
      : "💼 Commerce";

  const plainLabel = categoryLabel.replace(/[^\w\s]/g, "").trim();

  const selectedInCategory = subjects.filter((subject) =>
    subjectSelected(state, subject)
  ).length;

  const allSelected =
    selectedInCategory === subjects.length && subjects.length > 0;

  buttons.push([
    {
      text: allSelected
        ? `✅ All ${plainLabel} Selected`
        : `☑️ Select All ${plainLabel}`,

      callback_data: "COLLEGE_CATEGORY_SELECT_ALL",
    },
  ]);

  buttons.push([
    {
      text: `⬜ Unselect All ${plainLabel}`,
      callback_data: "COLLEGE_CATEGORY_UNSELECT_ALL",
    },
  ]);

  buttons.push([
    {
      text: `➡️ Next (${state.selectedSubjects.length})`,
      callback_data: "COLLEGE_SUBJECT_DONE",
    },
  ]);

  const nav = [];

  if (page > 0) {
    nav.push({ text: "⬅️ Previous", callback_data: "COLLEGE_SUBJECT_PREV" });
  }

  if (page < totalPages - 1) {
    nav.push({ text: "Next ➡️", callback_data: "COLLEGE_SUBJECT_NEXT" });
  }

  if (nav.length) {
    buttons.push(nav);
  }

  buttons.push([
    { text: "⬅️ Categories", callback_data: "COLLEGE_SUBJECT_CATEGORIES" },
    { text: "❌ Cancel", callback_data: "COLLEGE_CANCEL" },
  ]);

  await renderInPlace(
    bot,
    userState,
    chatId,
    `📚 <b>Step 6 — ${categoryLabel} Subjects</b>

🏫 College: <b>${escapeHtml(state.collegeName)}</b>

🔢 College Code: <b>${escapeHtml(state.collegeCode)}</b>

📂 CSV: <b>${escapeHtml(state.collegeCsvName)}</b>

📚 ${categoryLabel} Subjects: <b>${subjects.length}</b>
☑️ Selected in ${categoryLabel}: <b>${selectedInCategory}</b>
📊 Total Selected: <b>${state.selectedSubjects.length}</b>

Page: <b>${page + 1}/${totalPages}</b>

Select individual subjects or use Select All.`,
    {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    }
  );
}

/*
=========================================================
REGISTRATION YEAR
=========================================================
*/

async function showRegistrationYear(bot, userState, chatId) {
  const state = getState(userState, chatId);

  state.collegeStep = "registration_year";

  userState.set(chatId, state);

  await replaceMessage(
    bot,
    userState,
    chatId,
    `🗓️ <b>Step 7 — Registration Year</b>

🏫 College: <b>${escapeHtml(state.collegeName)}</b>

🔢 College Code: <b>${escapeHtml(state.collegeCode)}</b>

📚 Selected Subjects: <b>${state.selectedSubjects.length}</b>

Enter Registration Year — exactly <b>2 digits</b>.

Example:

<code>25</code>

HINT: First 2-Digit Of Your Roll No From Admit Card.`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "⬅️ Back", callback_data: "COLLEGE_BACK_SUBJECTS" },
            { text: "❌ Cancel", callback_data: "COLLEGE_CANCEL" },
          ],
        ],
      },
    }
  );
}

/*
=========================================================
FIXED ROLL RANGE
=========================================================
*/

function getFixedRollRange() {
  return {
    from: FIXED_ROLL_FROM,
    to: FIXED_ROLL_TO,
    fromText: String(FIXED_ROLL_FROM).padStart(4, "0"),
    toText: String(FIXED_ROLL_TO).padStart(4, "0"),
  };
}

/*
=========================================================
ROLL NUMBER
=========================================================
*/

function createRollNumber(registrationYear, collegeCode, subjectCode, roll) {
  return (
    String(registrationYear).padStart(2, "0") +
    String(collegeCode).padStart(3, "0") +
    String(subjectCode).padStart(4, "0") +
    String(roll).padStart(4, "0")
  );
}

/*
=========================================================
BUILD JOBS
=========================================================
*/

function buildJobs(state) {
  const jobs = [];

  if (!Array.isArray(state.selectedSubjects)) {
    return jobs;
  }

  const rollRange = getFixedRollRange();

  for (const subject of state.selectedSubjects) {
    const subjectCode = normalizeCode(subject.subjectCode);

    const subjectCodeLower = subjectCode.toLowerCase();

    if (
      !subjectCode ||
      subjectCodeLower === "na" ||
      subjectCodeLower === "n/a"
    ) {
      continue;
    }

    const fullRollFrom = createRollNumber(
      state.registrationYear,
      state.collegeCode,
      subjectCode,
      FIXED_ROLL_FROM
    );

    const fullRollTo = createRollNumber(
      state.registrationYear,
      state.collegeCode,
      subjectCode,
      FIXED_ROLL_TO
    );

    jobs.push({
      session: state.session,
      examType: state.examType,
      course: state.course,
      csvFile: state.collegeCsvName,
      collegeCode: state.collegeCode,
      collegeName: state.collegeName,
      subject: subject.subject,
      subjectCode,
      registrationYear: state.registrationYear,
      rollFrom: rollRange.fromText,
      rollTo: rollRange.toText,
      fullRollFrom,
      fullRollTo,
      prefix: fullRollFrom.slice(0, -4),
    });
  }

  return jobs;
}

/*
=========================================================
SUMMARY
=========================================================
*/

async function showSummary(bot, userState, chatId) {
  const state = getState(userState, chatId);

  const jobs = buildJobs(state);

  if (!jobs.length) {
    throw new Error("No valid subject jobs available.");
  }

  state.collegeJobs = jobs;
  state.collegeStep = "summary";

  userState.set(chatId, state);

  // Telegram messages are limited to 4096 characters, so a long
  // subject list is trimmed in the summary (all jobs still run).
  let subjectText = "";
  let shown = 0;

  for (const job of jobs) {
    const block =
      `• ${escapeHtml(job.subject)} — <code>${escapeHtml(
        job.subjectCode
      )}</code>\n` +
      `  <code>${job.fullRollFrom}</code> → <code>${job.fullRollTo}</code>\n`;

    if (subjectText.length + block.length > SUMMARY_SUBJECT_TEXT_LIMIT) {
      break;
    }

    subjectText += block;
    shown++;
  }

  if (shown < jobs.length) {
    subjectText += `\n… and <b>${jobs.length - shown}</b> more subject(s)\n`;
  }

  await replaceMessage(
    bot,
    userState,
    chatId,
    `📋 <b>Bulk College Summary</b>

📅 Session: <b>${escapeHtml(state.session)}</b>

🎓 Exam Type: <b>${escapeHtml(state.examType)}</b>

📚 Course: <b>${escapeHtml(state.course)}</b>

📂 CSV: <b>${escapeHtml(state.collegeCsvName)}</b>

🏫 College: <b>${escapeHtml(state.collegeName)}</b>

🔢 College Code: <b>${escapeHtml(state.collegeCode)}</b>

🗓️ Registration Year: <b>${escapeHtml(state.registrationYear)}</b>

📚 <b>Selected Subjects (${jobs.length})</b>

${subjectText}

🚀 Ready to start bulk search.`,
    {
      parse_mode: "HTML",

      reply_markup: {
        inline_keyboard: [
          [{ text: "🚀 Start Bulk Search", callback_data: "COLLEGE_START" }],
          [
            { text: "⬅️ Back", callback_data: "COLLEGE_BACK_YEAR" },
            { text: "❌ Cancel", callback_data: "COLLEGE_CANCEL" },
          ],
        ],
      },
    }
  );
}

/*
=========================================================
RESET
=========================================================
*/

function resetCollegeState(state) {
  state.collegeStep = null;
  state.collegeSessionValues = null;
  state.collegeExamValues = null;
  state.collegeCourseValues = null;
  state.collegeCsvFiles = null;
  state.collegeCsvPage = 0;
  state.collegeCsvPath = null;
  state.collegeCsvName = null;
  state.collegeList = null;
  state.collegePage = 0;
  state.collegeCode = null;
  state.collegeName = null;
  state.availableSubjects = null;
  state.subjectPage = 0;
  state.subjectCategory = null;
  state.selectedSubjects = [];
  state.isVocational = false;
  state.registrationYear = null;
  state.collegeJobs = [];
  state.collegeMessageId = null;
}

/*
=========================================================
CALLBACK
=========================================================
*/

async function handleCallback(bot, userState, queryOrChatId, maybeData) {
  let query = null;
  let chatId = null;
  let data = "";

  if (queryOrChatId && typeof queryOrChatId === "object") {
    query = queryOrChatId;

    if (query.message && query.message.chat) {
      chatId = query.message.chat.id;
    }

    data = query.data || "";
  } else {
    chatId = queryOrChatId;

    data = maybeData || "";
  }

  if (!chatId) {
    console.error("❌ Bulk College callback: chatId missing");

    return null;
  }

  const state = getState(userState, chatId);

  try {
    // ---------------- CANCEL ----------------
    if (data === "COLLEGE_CANCEL") {
      // Keep the current message id so the old menu gets deleted
      // (no dead buttons left behind).
      const oldMessageId = state.collegeMessageId;

      resetCollegeState(state);

      state.collegeMessageId = oldMessageId;

      state.mode = "bulk";
      state.bulkType = null;
      state.bulkStep = "type";

      userState.set(chatId, state);

      await replaceMessage(
        bot,
        userState,
        chatId,
        `❌ <b>College Bulk Cancelled</b>

Use /bulk to start again.`,
        { parse_mode: "HTML" }
      );

      return { action: "cancel" };
    }

    // ---------------- SESSION ----------------
    if (/^COLLEGE_SESSION_\d+$/.test(data)) {
      const index = Number(data.slice("COLLEGE_SESSION_".length));

      const session = await resolveOption(
        state,
        "collegeSessionValues",
        getSessions,
        index
      );

      if (session === undefined) {
        throw new Error("Invalid session selection.");
      }

      state.session = session;
      state.examType = null;
      state.course = null;
      state.collegeExamValues = null;
      state.collegeCourseValues = null;
      state.collegeStep = "exam";

      userState.set(chatId, state);

      console.log("📅 College Session:", session);

      await showExamTypes(bot, userState, chatId);

      return null;
    }

    // ---------------- EXAM ----------------
    if (/^COLLEGE_EXAM_\d+$/.test(data)) {
      const index = Number(data.slice("COLLEGE_EXAM_".length));

      const examType = await resolveOption(
        state,
        "collegeExamValues",
        () => getExamTypes(state.session),
        index
      );

      if (examType === undefined) {
        throw new Error("Invalid exam type selection.");
      }

      state.examType = examType;
      state.course = null;
      state.collegeCourseValues = null;
      state.collegeStep = "course";

      userState.set(chatId, state);

      console.log("🎓 College Exam:", examType);

      await showCourses(bot, userState, chatId);

      return null;
    }

    // ---------------- COURSE ----------------
    if (/^COLLEGE_COURSE_\d+$/.test(data)) {
      const index = Number(data.slice("COLLEGE_COURSE_".length));

      const course = await resolveOption(
        state,
        "collegeCourseValues",
        () => getCourses(state.session, state.examType),
        index
      );

      if (course === undefined) {
        throw new Error("Invalid course selection.");
      }

      state.course = course;

      userState.set(chatId, state);

      console.log("📚 College Course:", course);

      await showCsvFiles(bot, userState, chatId);

      return null;
    }

    // ---------------- CSV NEXT / PREV ----------------
    if (data === "COLLEGE_CSV_NEXT") {
      state.collegeCsvPage = Number(state.collegeCsvPage || 0) + 1;

      userState.set(chatId, state);

      await renderCsvPage(bot, userState, chatId);

      return null;
    }

    if (data === "COLLEGE_CSV_PREV") {
      state.collegeCsvPage = Math.max(
        0,
        Number(state.collegeCsvPage || 0) - 1
      );

      userState.set(chatId, state);

      await renderCsvPage(bot, userState, chatId);

      return null;
    }

    // ---------------- CSV PICK ----------------
    if (/^COLLEGE_CSV_\d+$/.test(data)) {
      const index = Number(data.slice("COLLEGE_CSV_".length));

      const files = state.collegeCsvFiles || scanCsvFiles();

      if (!Number.isInteger(index) || !files[index]) {
        throw new Error("Invalid CSV selection.");
      }

      const file = files[index];

      loadCsvFile(file.path);

      state.collegeCsvPath = file.path;
      state.collegeCsvName = file.name;
      state.collegeCsvPage = Math.floor(index / CSV_PER_PAGE);
      state.collegeList = null;
      state.collegePage = 0;

      userState.set(chatId, state);

      console.log("📂 CSV selected:", file.name);

      await showColleges(bot, userState, chatId);

      return null;
    }

    // ---------------- COLLEGE PAGE NEXT / PREV ----------------
    if (data === "COLLEGE_PAGE_NEXT") {
      state.collegePage = Number(state.collegePage || 0) + 1;

      userState.set(chatId, state);

      await renderCollegePage(bot, userState, chatId);

      return null;
    }

    if (data === "COLLEGE_PAGE_PREV") {
      state.collegePage = Math.max(0, Number(state.collegePage || 0) - 1);

      userState.set(chatId, state);

      await renderCollegePage(bot, userState, chatId);

      return null;
    }

    // ---------------- COLLEGE PICK ----------------
    if (/^COLLEGE_PICK_\d+$/.test(data)) {
      const index = Number(data.slice("COLLEGE_PICK_".length));

      const colleges =
        state.collegeList || getColleges(loadSelectedCsv(state));

      if (!Number.isInteger(index) || !colleges[index]) {
        throw new Error("Invalid college selection.");
      }

      const college = colleges[index];

      state.collegeCode = String(college.code).trim();
      state.collegeName = String(college.name).trim();
      state.availableSubjects = null;
      state.selectedSubjects = [];
      state.subjectPage = 0;
      state.subjectCategory = null;

      userState.set(chatId, state);

      console.log("🏫 College selected:", state.collegeName, state.collegeCode);

      await showSubjects(bot, userState, chatId);

      return null;
    }

    // ---------------- SUBJECT CATEGORY PICK ----------------
    if (data === "COLLEGE_CATEGORY_ARTS") {
      await showCategorySubjects(bot, userState, chatId, "arts");

      return null;
    }

    if (data === "COLLEGE_CATEGORY_SCIENCE") {
      await showCategorySubjects(bot, userState, chatId, "science");

      return null;
    }

    if (data === "COLLEGE_CATEGORY_COMMERCE") {
      await showCategorySubjects(bot, userState, chatId, "commerce");

      return null;
    }

    if (data === "COLLEGE_CATEGORY_VOCATIONAL") {
      state.subjectCategory = "vocational";
      state.subjectPage = 0;
      state.collegeStep = "subject";

      userState.set(chatId, state);

      await renderVocationalSubjectPage(bot, userState, chatId);

      return null;
    }

    // ---------------- BACK TO CATEGORIES ----------------
    if (data === "COLLEGE_SUBJECT_CATEGORIES") {
      state.subjectCategory = null;
      state.subjectPage = 0;

      await showSubjectCategories(bot, userState, chatId);

      return null;
    }

    // ---------------- CATEGORY SUBJECT PREV / NEXT ----------------
    if (data === "COLLEGE_SUBJECT_PREV") {
      state.subjectPage = Math.max(0, Number(state.subjectPage || 0) - 1);

      userState.set(chatId, state);

      await renderSubjectPage(bot, userState, chatId);

      return null;
    }

    if (data === "COLLEGE_SUBJECT_NEXT") {
      state.subjectPage = Number(state.subjectPage || 0) + 1;

      userState.set(chatId, state);

      await renderSubjectPage(bot, userState, chatId);

      return null;
    }

    // ---------------- CATEGORY SUBJECT PICK ----------------
    if (/^COLLEGE_CATEGORY_SUBJECT_\d+$/.test(data)) {
      const index = Number(data.slice("COLLEGE_CATEGORY_SUBJECT_".length));

      const subjects = getSubjectsByCategory(
        state.availableSubjects || [],
        state.subjectCategory
      );

      if (!Number.isInteger(index) || !subjects[index]) {
        throw new Error("Invalid subject selection.");
      }

      const result = toggleSubject(state, subjects[index]);

      if (!result) {
        await bot.sendMessage(
          chatId,
          `⚠️ Maximum ${MAX_SUBJECTS_PER_SELECTION} subjects can be selected.`
        );

        return null;
      }

      userState.set(chatId, state);

      await renderSubjectPage(bot, userState, chatId);

      return null;
    }

    // ---------------- CATEGORY SELECT ALL ----------------
    if (data === "COLLEGE_CATEGORY_SELECT_ALL") {
      if (!state.subjectCategory) {
        return showSubjectCategories(bot, userState, chatId);
      }

      if (!Array.isArray(state.selectedSubjects)) {
        state.selectedSubjects = [];
      }

      const subjects = getSubjectsByCategory(
        state.availableSubjects || [],
        state.subjectCategory
      );

      const availableSlots = Math.max(
        0,
        MAX_SUBJECTS_PER_SELECTION - state.selectedSubjects.length
      );

      const pending = subjects.filter(
        (subject) => !subjectSelected(state, subject)
      );

      const toAdd = pending.slice(0, availableSlots);

      for (const subject of toAdd) {
        state.selectedSubjects.push(subject);
      }

      userState.set(chatId, state);

      if (pending.length > toAdd.length) {
        await bot.sendMessage(
          chatId,
          `⚠️ Maximum ${MAX_SUBJECTS_PER_SELECTION} subjects can be selected.`
        );
      }

      await renderSubjectPage(bot, userState, chatId);

      return null;
    }

    // ---------------- CATEGORY UNSELECT ALL ----------------
    if (data === "COLLEGE_CATEGORY_UNSELECT_ALL") {
      if (!state.subjectCategory) {
        return showSubjectCategories(bot, userState, chatId);
      }

      unselectCategory(state, state.subjectCategory);

      userState.set(chatId, state);

      await renderSubjectPage(bot, userState, chatId);

      return null;
    }

    // ---------------- VOCATIONAL SUBJECT SELECT / UNSELECT ----------------
    if (data.startsWith("COLLEGE_VOC_SUBJECT_")) {
      const index = Number(data.replace("COLLEGE_VOC_SUBJECT_", ""));

      const subject = state.availableSubjects?.[index];

      if (!subject) {
        return null;
      }

      if (!Array.isArray(state.selectedSubjects)) {
        state.selectedSubjects = [];
      }

      const existingIndex = state.selectedSubjects.findIndex(
        (item) =>
          String(item.subjectCode || "") === String(subject.subjectCode || "")
      );

      if (existingIndex >= 0) {
        state.selectedSubjects.splice(existingIndex, 1);
      } else {
        if (state.selectedSubjects.length >= MAX_SUBJECTS_PER_SELECTION) {
          if (query?.id) {
            try {
              await bot.answerCallbackQuery(query.id, {
                text: `Maximum ${MAX_SUBJECTS_PER_SELECTION} subjects can be selected.`,
                show_alert: true,
              });
            } catch (_) {}
          } else {
            await bot.sendMessage(
              chatId,
              `⚠️ Maximum ${MAX_SUBJECTS_PER_SELECTION} subjects can be selected.`
            );
          }

          return null;
        }

        state.selectedSubjects.push(subject);
      }

      userState.set(chatId, state);

      await renderVocationalSubjectPage(bot, userState, chatId);

      return null;
    }

    // ---------------- VOCATIONAL SELECT ALL ----------------
    if (data === "COLLEGE_VOC_SELECT_ALL") {
      const subjects = Array.isArray(state.availableSubjects)
        ? state.availableSubjects
        : [];

      state.selectedSubjects = subjects.slice(0, MAX_SUBJECTS_PER_SELECTION);

      userState.set(chatId, state);

      await renderVocationalSubjectPage(bot, userState, chatId);

      return null;
    }

    // ---------------- VOCATIONAL UNSELECT ALL ----------------
    if (data === "COLLEGE_VOC_UNSELECT_ALL") {
      state.selectedSubjects = [];

      userState.set(chatId, state);

      await renderVocationalSubjectPage(bot, userState, chatId);

      return null;
    }

    // ---------------- VOCATIONAL PREV / NEXT PAGE ----------------
    if (data === "COLLEGE_VOC_PREV") {
      state.subjectPage = Math.max(0, (state.subjectPage || 0) - 1);

      userState.set(chatId, state);

      await renderVocationalSubjectPage(bot, userState, chatId);

      return null;
    }

    if (data === "COLLEGE_VOC_NEXT") {
      const subjects = Array.isArray(state.availableSubjects)
        ? state.availableSubjects
        : [];

      const totalPages = Math.max(
        1,
        Math.ceil(subjects.length / SUBJECTS_PER_PAGE)
      );

      state.subjectPage = Math.min(totalPages - 1, (state.subjectPage || 0) + 1);

      userState.set(chatId, state);

      await renderVocationalSubjectPage(bot, userState, chatId);

      return null;
    }

    // ---------------- VOCATIONAL BACK TO CATEGORY ----------------
    if (data === "COLLEGE_VOC_BACK") {
      state.subjectPage = 0;
      state.subjectCategory = null;
      state.collegeStep = "subject_category";

      userState.set(chatId, state);

      await showVocationalCategory(bot, userState, chatId);

      return null;
    }

    // ---------------- SUBJECT DONE ----------------
    if (data === "COLLEGE_SUBJECT_DONE") {
      if (
        !Array.isArray(state.selectedSubjects) ||
        !state.selectedSubjects.length
      ) {
        await bot.sendMessage(chatId, "⚠️ Please select at least one subject.");

        return null;
      }

      console.log("📚 Selected subjects:", state.selectedSubjects.length);

      await showRegistrationYear(bot, userState, chatId);

      return null;
    }

    // ---------------- BACK: SESSION ----------------
    if (data === "COLLEGE_BACK_SESSION") {
      state.session = null;
      state.examType = null;
      state.course = null;

      await showSessions(bot, userState, chatId);

      return null;
    }

    // ---------------- BACK: EXAM ----------------
    if (data === "COLLEGE_BACK_EXAM") {
      state.examType = null;
      state.course = null;

      await showExamTypes(bot, userState, chatId);

      return null;
    }

    // ---------------- BACK: COURSE ----------------
    if (data === "COLLEGE_BACK_COURSE") {
      state.course = null;

      await showCourses(bot, userState, chatId);

      return null;
    }

    // ---------------- BACK: CSV ----------------
    if (data === "COLLEGE_BACK_CSV") {
      await showCsvFiles(bot, userState, chatId);

      return null;
    }

    // ---------------- BACK: COLLEGE ----------------
    if (data === "COLLEGE_BACK_COLLEGE") {
      state.collegeCode = null;
      state.collegeName = null;
      state.availableSubjects = null;
      state.selectedSubjects = [];
      state.subjectPage = 0;
      state.subjectCategory = null;

      await showColleges(bot, userState, chatId);

      return null;
    }

    // ---------------- BACK: SUBJECTS ----------------
    if (data === "COLLEGE_BACK_SUBJECTS") {
      state.subjectCategory = null;
      state.subjectPage = 0;

      if (state.isVocational || isVocationalCsv(state.collegeCsvName)) {
        state.collegeStep = "subject_category";

        await showVocationalCategory(bot, userState, chatId);

        return null;
      }

      await showSubjectCategories(bot, userState, chatId);

      return null;
    }

    // ---------------- BACK: REGISTRATION YEAR ----------------
    if (data === "COLLEGE_BACK_YEAR") {
      await showRegistrationYear(bot, userState, chatId);

      return null;
    }

    // ---------------- START ----------------
    if (data === "COLLEGE_START") {
      const jobs = buildJobs(state);

      if (!jobs.length) {
        throw new Error("No valid jobs available.");
      }

      state.collegeJobs = jobs;
      state.collegeStep = "running";

      userState.set(chatId, state);

      console.log("🚀 College bulk jobs:", jobs.length);

      console.log(
        `🔢 Fixed Roll Range: ${String(FIXED_ROLL_FROM).padStart(
          4,
          "0"
        )} - ${String(FIXED_ROLL_TO).padStart(4, "0")}`
      );

      return {
        action: "start",
        jobs,
        state,
      };
    }

    return null;
  } catch (error) {
    console.error("❌ Bulk College callback error:", error);

    await replaceMessage(
      bot,
      userState,
      chatId,
      `❌ <b>Bulk College Error</b>

${escapeHtml(error.message)}`,
      {
        parse_mode: "HTML",

        reply_markup: {
          inline_keyboard: [
            [
              { text: "⬅️ Back", callback_data: "COLLEGE_BACK_SUBJECTS" },
              { text: "❌ Cancel", callback_data: "COLLEGE_CANCEL" },
            ],
          ],
        },
      }
    );

    return null;
  }
}

/*
=========================================================
MESSAGE HANDLER
=========================================================
*/

async function handleMessage(bot, userState, msg) {
  if (!msg || !msg.chat) {
    return null;
  }

  const chatId = msg.chat.id;

  // Do not create an empty state for chats that are not in this flow.
  const state = userState.get(chatId);

  if (
    !state ||
    state.mode !== "bulk" ||
    state.bulkType !== "college" ||
    state.collegeStep !== "registration_year"
  ) {
    return null;
  }

  const text = String(msg.text || "").trim();

  if (!text) {
    return true;
  }

  // Let bot commands (/bulk, /start ...) pass through to the main handler.
  if (text.startsWith("/")) {
    return null;
  }

  // ---------------- REGISTRATION YEAR ----------------
  if (!/^\d{2}$/.test(text)) {
    await bot.sendMessage(
      chatId,
      `❌ <b>Invalid Registration Year</b>

Enter exactly 2 digits.

Example:

<code>25</code>

HINT: First 2-Digit Of Your Roll No From Admit Card.`,
      { parse_mode: "HTML" }
    );

    return true;
  }

  state.registrationYear = text;

  userState.set(chatId, state);

  try {
    await showSummary(bot, userState, chatId);
  } catch (error) {
    console.error("❌ Bulk College summary error:", error);

    await bot.sendMessage(
      chatId,
      `❌ <b>Bulk College Error</b>

${escapeHtml(error.message)}`,
      { parse_mode: "HTML" }
    );
  }

  return true;
}

/*
=========================================================
GET JOBS
=========================================================
*/

function getJobs(userState, chatId) {
  const state = getState(userState, chatId);

  return Array.isArray(state.collegeJobs) ? state.collegeJobs : [];
}

/*
=========================================================
CLEAR
=========================================================
*/

function clear(userState, chatId) {
  const state = getState(userState, chatId);

  resetCollegeState(state);

  userState.set(chatId, state);
}

/*
=========================================================
EXPORTS
=========================================================
*/

module.exports = {
  start,
  handleCallback,
  handleMessage,
  getJobs,
  clear,
  scanCsvFiles,
  loadCsvFile,
  getColleges,
  getSubjects,
  createRollNumber,
  buildJobs,
  getSubjectCategory,
  FIXED_ROLL_FROM,
  FIXED_ROLL_TO,
};