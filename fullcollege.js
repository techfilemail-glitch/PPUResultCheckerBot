const bulkCollege = require("./bulk/college");
const {
  getSessions,
  getExamTypes,
  getCourses,
} = require("./result-checker");

const COLLEGES_PER_PAGE = 25;
const SUBJECTS_PER_PAGE = 10;

const ROLL_FROM = 1;
const ROLL_TO = 250;

const COLLEGE_PAGE_PREFIX = "FC_COLLEGE_PAGE_";
const COLLEGE_PREFIX = "FC_COLLEGE_";
const SUBJECT_PAGE_PREFIX = "FC_SUBJECT_PAGE_";

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function norm(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function sectionOf(value) {
  const s = norm(value).toUpperCase();

  if (
    s.includes("PG") &&
    (s.includes("VOC") || s.includes("VOCATIONAL"))
  ) {
    return "PG VOC";
  }

  if (s.includes("PG")) {
    return "PG REG";
  }

  if (s.includes("VOC") || s.includes("VOCATIONAL")) {
    return "UG VOC";
  }

  return "UG REG";
}

function streamOf(subject, section) {
  if (section !== "UG REG") {
    return "";
  }

  const s = norm(subject).toLowerCase();

  if (
    /commerce|account|business|management|finance|banking|taxation|marketing/.test(
      s
    )
  ) {
    return "COMMERCE";
  }

  if (
    /physics|chemistry|mathematics|math|botany|zoology|biology|geology|computer science|statistics|electronics|environmental science/.test(
      s
    )
  ) {
    return "SCIENCE";
  }

  return "ARTS";
}

function cleanRow(row) {
  if (!row || typeof row !== "object") {
    return null;
  }

  const collegeCode = norm(
    row.collegeCode ??
      row["College Code"] ??
      row.college_code ??
      row.code
  );

  const collegeName = norm(
    row.collegeName ??
      row["College"] ??
      row.college ??
      row["College Name"] ??
      row.name
  );

  const subject = norm(
    row.subject ??
      row["Subject"] ??
      row.subjectName ??
      row["Subject Name"]
  );

  const subjectCode = norm(
    row.subjectCode ??
      row["SubjectCode"] ??
      row["Subject Code"] ??
      row.subject_code
  );

  const section = sectionOf(
    row.section ??
      row.category ??
      row.type ??
      row.stream ??
      ""
  );

  if (!collegeCode || !collegeName || !subject || !subjectCode) {
    return null;
  }

  if (!/^\d{1,5}$/.test(collegeCode)) {
    return null;
  }

  if (!/^\d{1,8}$/.test(subjectCode)) {
    return null;
  }

  return {
    collegeCode: collegeCode.replace(/^0+(?=\d)/, ""),
    collegeName,
    subject,
    subjectCode,
    section,
    stream: streamOf(subject, section),
  };
}

async function readAllRows() {
  if (typeof bulkCollege.scanCsvFiles !== "function") {
    throw new Error(
      "bulk/college.js does not export scanCsvFiles()."
    );
  }

  if (typeof bulkCollege.loadCsvFile !== "function") {
    throw new Error(
      "bulk/college.js does not export loadCsvFile()."
    );
  }

  const files = await Promise.resolve(
    bulkCollege.scanCsvFiles(true)
  );

  const rows = [];

  for (const file of Array.isArray(files) ? files : []) {
    const source =
      file?.path ||
      file?.filePath ||
      file?.fullPath ||
      file;

    if (!source) {
      continue;
    }

    try {
      const loaded = await Promise.resolve(
        bulkCollege.loadCsvFile(source)
      );

      if (Array.isArray(loaded)) {
        rows.push(...loaded);
      } else if (Array.isArray(loaded?.rows)) {
        rows.push(...loaded.rows);
      }
    } catch (error) {
      console.error(
        "[FULLCOLLEGE] CSV load failed:",
        source,
        error.message
      );
    }
  }

  return rows
    .map(cleanRow)
    .filter(Boolean);
}

async function getCollegeList() {
  const rows = await readAllRows();

  const map = new Map();

  for (const row of rows) {
    if (!map.has(row.collegeCode)) {
      map.set(row.collegeCode, {
        collegeCode: row.collegeCode,
        collegeName: row.collegeName,
      });
    }
  }

  return [...map.values()].sort((a, b) =>
    String(a.collegeCode).localeCompare(
      String(b.collegeCode),
      undefined,
      {
        numeric: true,
      }
    )
  );
}

function findOption(options, candidates, regexes = []) {
  const list = Array.isArray(options)
    ? options
    : [];

  const wanted = candidates
    .map((x) => norm(x).toLowerCase())
    .filter(Boolean);

  for (const option of list) {
    const value = norm(
      option?.value ??
        option?.id ??
        ""
    );

    const text = norm(
      option?.text ??
        option?.label ??
        option?.name ??
        value
    );

    const hay =
      `${value} ${text}`.toLowerCase();

    if (
      wanted.some(
        (w) =>
          hay === w ||
          hay.includes(w)
      )
    ) {
      return option;
    }
  }

  for (const option of list) {
    const text = norm(
      option?.text ??
        option?.label ??
        option?.name ??
        option?.value ??
        ""
    );

    if (
      regexes.some((re) => re.test(text))
    ) {
      return option;
    }
  }

  return null;
}

async function resolvePortalMapping(job, year) {
  const sessions = await getSessions();

  const sessionOptions =
    Array.isArray(sessions)
      ? sessions
      : [];

  let session = null;

  if (job.section.startsWith("UG")) {
    session = findOption(
      sessionOptions,
      [
        `YEAR-20${year}`,
        `YEAR-${year}`,
        `20${year}`,
      ],
      [
        new RegExp(
          `YEAR[- ]?20?${year}$`,
          "i"
        ),
        new RegExp(`20${year}`, "i"),
      ]
    );
  } else {
    const endYear = String(
      Number(year) + 2
    ).padStart(2, "0");

    session = findOption(
      sessionOptions,
      [
        `SEMESTER(${year}-${endYear})`,
        `SEMESTER(20${year}-20${String(
          Number(year) + 2
        )})`,
      ],
      [
        new RegExp(
          `SEMESTER.*20?${year}.*${endYear}`,
          "i"
        ),
        new RegExp(`20${year}`, "i"),
      ]
    );
  }

  if (!session) {
    console.log(
      `[FULLCOLLEGE] Session not found → ${job.section} ${year}`
    );

    return {};
  }

  const sessionValue =
    session.value ??
    session.id ??
    session.text;

  const examOptions =
    await getExamTypes(sessionValue);

  let examWanted = "UG";

  if (job.section === "UG VOC") {
    examWanted = "Vocational";
  } else if (job.section === "PG REG") {
    examWanted = "PG (Regular)";
  } else if (job.section === "PG VOC") {
    examWanted = "PG (Vocational)";
  }

  const exam = findOption(
    examOptions,
    [examWanted],
    [
      new RegExp(
        examWanted
          .replace(/[()]/g, "\\$&")
          .replace(/\s+/g, "\\s*"),
        "i"
      ),
    ]
  );

  if (!exam) {
    console.log(
      `[FULLCOLLEGE] Exam not found → ${job.section} ${year}`
    );

    return {};
  }

  const examValue =
    exam.value ??
    exam.id ??
    exam.text;

  const courses =
    await getCourses(
      sessionValue,
      examValue
    );

  let course = null;

  if (job.section === "UG VOC") {
    course = findOption(
      courses,
      [
        "PART-I",
        "PART 1",
      ],
      [
        /PART\s*[- ]?I/i,
      ]
    );
  } else if (
    job.section === "PG REG" ||
    job.section === "PG VOC"
  ) {
    course = findOption(
      courses,
      [
        "SEM-1",
        "SEM-I",
        "SEM 1",
      ],
      [
        /SEM\s*[- ]?I\b/i,
      ]
    );
  } else if (
    job.stream === "COMMERCE"
  ) {
    course = findOption(
      courses,
      [
        "BCOM(SEM-I)",
        "B.COM(SEM-I)",
        "BCOM",
      ],
      [
        /BCOM/i,
      ]
    );
  } else if (
    job.stream === "SCIENCE"
  ) {
    course = findOption(
      courses,
      [
        "BSC(SEM-I)",
        "B.SC(SEM-I)",
        "BSC",
      ],
      [
        /BSC/i,
      ]
    );
  } else {
    course = findOption(
      courses,
      [
        "BA(SEM-I)",
        "B.A.(SEM-I)",
        "BA",
      ],
      [
        /^BA/i,
        /B\.A/i,
      ]
    );
  }

  if (!course) {
    console.log(
      `[FULLCOLLEGE] Course not found → ${job.subject} | ${job.stream}`
    );

    return {};
  }

  return {
    session:
      session.value ??
      session.id ??
      session.text,

    sessionText:
      session.text ??
      session.value,

    examType:
      exam.value ??
      exam.id ??
      exam.text,

    examText:
      exam.text ??
      exam.value,

    course:
      course.value ??
      course.id ??
      course.text,

    courseText:
      course.text ??
      course.value,
  };
}

async function getCollegeSubjects(
  collegeCode,
  registrationYear
) {
  const rows = await readAllRows();

  const code = String(
    collegeCode
  );

  const year = String(
    registrationYear
  ).padStart(2, "0");

  const map = new Map();

  for (const row of rows) {
    if (
      String(row.collegeCode) !== code
    ) {
      continue;
    }

    const key =
      `${row.section}|${row.stream}|${row.subjectCode}|${row.subject}`;

    if (!map.has(key)) {
      map.set(key, {
        collegeCode:
          row.collegeCode,

        collegeName:
          row.collegeName,

        subject:
          row.subject,

        subjectCode:
          row.subjectCode,

        section:
          row.section,

        stream:
          row.stream,

        registrationYear:
          year,

        rollFrom:
          ROLL_FROM,

        rollTo:
          ROLL_TO,
      });
    }
  }

  const subjects =
    [...map.values()];

  console.log(
    `[FULLCOLLEGE] ${subjects.length} subjects detected for college ${code}`
  );

  for (const job of subjects) {
    const mapping =
      await resolvePortalMapping(
        job,
        year
      );

    Object.assign(
      job,
      mapping
    );

    job.prefix =
      `${year}` +
      `${String(job.collegeCode).padStart(3, "0")}` +
      `${String(job.subjectCode).padStart(4, "0")}`;
  }

  return subjects.filter(
    (job) =>
      job.session &&
      job.examType &&
      job.course
  );
}

function pageItems(
  items,
  page,
  size
) {
  const totalPages =
    Math.max(
      1,
      Math.ceil(
        items.length / size
      )
    );

  const safePage =
    Math.min(
      Math.max(
        0,
        Number(page) || 0
      ),
      totalPages - 1
    );

  return {
    page: safePage,
    totalPages,
    items: items.slice(
      safePage * size,
      (safePage + 1) * size
    ),
  };
}

async function sendCollegePage(
  bot,
  userState,
  chatId,
  page = 0
) {
  const colleges =
    await getCollegeList();

  const p = pageItems(
    colleges,
    page,
    COLLEGES_PER_PAGE
  );

  const buttons =
    p.items.map((college) => [
      {
        text:
          `🏫 ${college.collegeCode} — ` +
          `${String(
            college.collegeName
          ).slice(0, 45)}`,

        callback_data:
          `${COLLEGE_PREFIX}${encodeURIComponent(
            college.collegeCode
          )}`,
      },
    ]);

  const nav = [];

  if (p.page > 0) {
    nav.push({
      text: "⬅️",
      callback_data:
        `${COLLEGE_PAGE_PREFIX}${p.page - 1}`,
    });
  }

  nav.push({
    text:
      `${p.page + 1}/${p.totalPages}`,
    callback_data:
      "FC_NOOP",
  });

  if (
    p.page <
    p.totalPages - 1
  ) {
    nav.push({
      text: "➡️",
      callback_data:
        `${COLLEGE_PAGE_PREFIX}${p.page + 1}`,
    });
  }

  buttons.push(nav);

  buttons.push([
    {
      text: "❌ Cancel",
      callback_data:
        "FC_CANCEL",
    },
  ]);

  const sent =
    await bot.sendMessage(
      chatId,
      `🏫 <b>Full College Bulk</b>\n\n` +
        `Choose a college:\n` +
        `📄 Page <b>${p.page + 1}/${p.totalPages}</b>\n` +
        `🏫 Colleges: <b>${colleges.length}</b>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard:
            buttons,
        },
      }
    );

  const state =
    userState.get(chatId) || {};

  state.mode =
    "fullcollege";

  state.step =
    "college";

  state.messageId =
    sent.message_id;

  state.fullCollegePage =
    p.page;

  userState.set(
    chatId,
    state
  );

  return sent;
}

async function start(
  bot,
  userState,
  chatId,
  userId
) {
  console.log(
    `[FULLCOLLEGE] Starting → chat=${chatId} user=${userId}`
  );

  const colleges =
    await getCollegeList();

  if (!colleges.length) {
    throw new Error(
      "No colleges found in CSV files."
    );
  }

  userState.set(
    chatId,
    {
      mode: "fullcollege",
      step: "college",
      ownerId: String(userId),
      messageId: null,
      fullCollegePage: 0,
      selectedCollege: null,
      registrationYear: null,
      jobs: null,
      subjectPage: 0,
    }
  );

  return sendCollegePage(
    bot,
    userState,
    chatId,
    0
  );
}

async function sendReadyPage(
  bot,
  userState,
  chatId,
  page = 0
) {
  const state =
    userState.get(chatId);

  const jobs =
    Array.isArray(state?.jobs)
      ? state.jobs
      : [];

  const p = pageItems(
    jobs,
    page,
    SUBJECTS_PER_PAGE
  );

  const lines =
    p.items.map((job, i) => {
      const number =
        p.page *
          SUBJECTS_PER_PAGE +
        i +
        1;

      return (
        `${number}. <b>${esc(
          job.subject
        )}</b>\n` +

        `   Code: <code>${esc(
          job.subjectCode
        )}</code> · ` +

        `${esc(job.section)}` +

        `${
          job.stream
            ? ` · ${esc(
                job.stream
              )}`
            : ""
        }\n` +

        `   Roll: <code>${esc(
          job.prefix
        )}0001</code> – ` +

        `<code>${esc(
          job.prefix
        )}0250</code>\n` +

        `   ${esc(
          job.sessionText ||
            job.session
        )} · ` +

        `${esc(
          job.examText ||
            job.examType
        )} · ` +

        `${esc(
          job.courseText ||
            job.course
        )}`
      );
    });

  const nav = [];

  if (p.page > 0) {
    nav.push({
      text: "⬅️",
      callback_data:
        `${SUBJECT_PAGE_PREFIX}${p.page - 1}`,
    });
  }

  nav.push({
    text:
      `${p.page + 1}/${p.totalPages}`,
    callback_data:
      "FC_NOOP",
  });

  if (
    p.page <
    p.totalPages - 1
  ) {
    nav.push({
      text: "➡️",
      callback_data:
        `${SUBJECT_PAGE_PREFIX}${p.page + 1}`,
    });
  }

  const keyboard = [];

  if (p.totalPages > 1) {
    keyboard.push(nav);
  }

  keyboard.push([
    {
      text:
        "🚀 Start Bulk Search",
      callback_data:
        "FC_START",
    },
  ]);

  keyboard.push([
    {
      text: "❌ Cancel",
      callback_data:
        "FC_CANCEL",
    },
  ]);

  const college =
    state.selectedCollege;

  const message =
    `🚀 <b>Full College Bulk Ready</b>\n\n` +

    `🏫 College: <b>${esc(
      college.collegeName
    )}</b>\n` +

    `🔢 Code: <code>${esc(
      college.collegeCode
    )}</code>\n` +

    `📅 Registration Year: <b>${esc(
      state.registrationYear
    )}</b>\n` +

    `📚 Subjects: <b>${jobs.length}</b>\n` +

    `🔢 Total Rolls: <b>${
      jobs.length * 250
    }</b>\n\n` +

    lines.join("\n\n") +

    (
      p.totalPages > 1
        ? `\n\n📄 Subject page <b>${p.page + 1}/${p.totalPages}</b>`
        : ""
    ) +

    `\n\nPress <b>Start Bulk Search</b> to begin.`;

  return bot.sendMessage(
    chatId,
    message,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard:
          keyboard,
      },
    }
  );
}

async function handleCallback(
  bot,
  userState,
  chatId,
  query,
  data
) {
  const state =
    userState.get(chatId);

  if (
    !state ||
    state.mode !==
      "fullcollege"
  ) {
    return bot.sendMessage(
      chatId,
      "❌ Full College session expired. Use /fullcollege again."
    );
  }

  if (data === "FC_NOOP") {
    return;
  }

  if (data === "FC_CANCEL") {
    userState.delete(chatId);

    return bot.sendMessage(
      chatId,
      "❌ <b>Full College Bulk cancelled.</b>",
      {
        parse_mode: "HTML",
      }
    );
  }

  if (
    data.startsWith(
      COLLEGE_PAGE_PREFIX
    )
  ) {
    const page =
      Number(
        data.slice(
          COLLEGE_PAGE_PREFIX.length
        )
      ) || 0;

    return sendCollegePage(
      bot,
      userState,
      chatId,
      page
    );
  }

  if (
    data.startsWith(
      COLLEGE_PREFIX
    )
  ) {
    const code =
      decodeURIComponent(
        data.slice(
          COLLEGE_PREFIX.length
        )
      );

    const colleges =
      await getCollegeList();

    const college =
      colleges.find(
        (x) =>
          String(
            x.collegeCode
          ) === String(code)
      );

    if (!college) {
      return bot.sendMessage(
        chatId,
        "❌ College not found. Use /fullcollege again."
      );
    }

    state.step = "year";
    state.selectedCollege =
      college;
    state.messageId = null;

    userState.set(
      chatId,
      state
    );

    return bot.sendMessage(
      chatId,
      `🏫 <b>${esc(
        college.collegeName
      )}</b>\n\n` +

        `College Code: <code>${esc(
          college.collegeCode
        )}</code>\n\n` +

        `📅 Enter <b>Registration Year</b> as exactly 2 digits.\n\n` +

        `Example: <code>26</code>`,
      {
        parse_mode: "HTML",
      }
    );
  }

  if (
    data.startsWith(
      SUBJECT_PAGE_PREFIX
    )
  ) {
    const page =
      Number(
        data.slice(
          SUBJECT_PAGE_PREFIX.length
        )
      ) || 0;

    return sendReadyPage(
      bot,
      userState,
      chatId,
      page
    );
  }

  if (data === "FC_START") {
    if (
      !Array.isArray(
        state.jobs
      ) ||
      !state.jobs.length
    ) {
      return bot.sendMessage(
        chatId,
        "❌ Jobs expired. Use /fullcollege again."
      );
    }

    const jobs =
      state.jobs;

    state.step =
      "running";

    state.fullCollegeStartedAt =
      Date.now();

    userState.set(
      chatId,
      state
    );

    return {
      action: "start",
      jobs,
    };
  }

  return null;
}

async function handleMessage(
  bot,
  userState,
  msg
) {
  const chatId =
    msg.chat.id;

  const state =
    userState.get(chatId);

  if (
    !state ||
    state.mode !==
      "fullcollege" ||
    state.step !== "year"
  ) {
    return false;
  }

  const text =
    String(
      msg.text || ""
    ).trim();

  if (!/^\d{2}$/.test(text)) {
    await bot.sendMessage(
      chatId,
      `❌ Registration Year exactly <b>2 digits</b> mein do.\n\nExample: <code>26</code>`,
      {
        parse_mode: "HTML",
      }
    );

    return true;
  }

  const year = text;

  try {
    await bot.sendMessage(
      chatId,
      `🔎 <b>Preparing Full College Bulk...</b>\n\n` +
        `College: <b>${esc(
          state.selectedCollege.collegeName
        )}</b>\n` +
        `Registration Year: <b>${esc(
          year
        )}</b>\n\n` +
        `CSV subjects aur portal Session / Exam / Course resolve ho raha hai...`,
      {
        parse_mode: "HTML",
      }
    );

    const jobs =
      await getCollegeSubjects(
        state.selectedCollege.collegeCode,
        year
      );

    if (!jobs.length) {
      await bot.sendMessage(
        chatId,
        `❌ <b>No valid subjects found.</b>\n\n` +
          `College: <code>${esc(
            state.selectedCollege.collegeCode
          )}</code>\n` +
          `Registration Year: <code>${esc(
            year
          )}</code>\n\n` +
          `CSV mapping ya portal dropdown mapping check karo.`,
        {
          parse_mode: "HTML",
        }
      );

      return true;
    }

    state.registrationYear =
      year;

    state.jobs =
      jobs;

    state.step =
      "ready";

    state.subjectPage =
      0;

    userState.set(
      chatId,
      state
    );

    await sendReadyPage(
      bot,
      userState,
      chatId,
      0
    );

    return true;
  } catch (error) {
    console.error(
      "[FULLCOLLEGE] Preparation failed:",
      error
    );

    await bot.sendMessage(
      chatId,
      `❌ <b>Full College preparation failed.</b>\n\n<code>${esc(
        error.message
      )}</code>`,
      {
        parse_mode: "HTML",
      }
    );

    return true;
  }
}

module.exports = {
  start,
  handleCallback,
  handleMessage,
  getCollegeList,
  getCollegeSubjects,

  COLLEGES_PER_PAGE,
  SUBJECTS_PER_PAGE,

  ROLL_FROM,
  ROLL_TO,
};