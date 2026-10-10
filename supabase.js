"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = String(
  process.env.SUPABASE_URL || ""
).trim();

const SUPABASE_SERVICE_ROLE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
).trim();

const SUPABASE_STORAGE_BUCKET = String(
  process.env.SUPABASE_STORAGE_BUCKET || "results"
).trim();

const PENDING_FILE =
  process.env.PENDING_SAVES_FILE ||
  path.join(__dirname, "pending-saves.ndjson");

const PDF_UPLOAD_CONCURRENCY = Math.max(
  1,
  Number(process.env.SUPABASE_PDF_UPLOAD_CONCURRENCY || 5)
);

/* =========================================================
   CONNECTION
========================================================= */

let supabase = null;

if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  try {
    if (!/^https?:\/\//i.test(SUPABASE_URL)) {
      throw new Error(
        "SUPABASE_URL must be a valid HTTP or HTTPS URL."
      );
    }

    supabase = createClient(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    );

    console.log("✅ Supabase connected");
    console.log(
      `☁️ Supabase Storage bucket: ${SUPABASE_STORAGE_BUCKET}`
    );
  } catch (error) {
    console.error(
      "❌ Supabase initialization failed:",
      error.message
    );

    supabase = null;
  }
} else {
  console.log(
    "⚠️ Supabase disabled: credentials missing"
  );
}

/* =========================================================
   BASIC HELPERS
========================================================= */

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function clean(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const result = String(value)
    .replace(/\s+/g, " ")
    .trim();

  return result || null;
}

function cleanUpper(value) {
  const result = clean(value);
  return result ? result.toUpperCase() : null;
}

function toNumeric(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const number = Number(
    String(value)
      .replace(/,/g, "")
      .trim()
  );

  return Number.isFinite(number) ? number : null;
}

/* =========================================================
   COURSE
========================================================= */

const SHORT_COURSE_MAP = {
  BA: "BACHELOR OF ARTS",
  BSC: "BACHELOR OF SCIENCE",
  BCOM: "BACHELOR OF COMMERCE",
  MA: "MASTER OF ARTS",
  MSC: "MASTER OF SCIENCE",
  MCOM: "MASTER OF COMMERCE",
};

function normalizeCourseName(value) {
  let course = clean(value);

  if (!course) return null;

  course = course.replace(
    /\s*[-–—]\s*YEAR\s*[-:]?\s*\d+.*$/i,
    ""
  );

  course = course.replace(
    /\s*[-–—]\s*SESSION\s*[-:]?\s*\d{4}\s*[-–/]\s*\d{4}.*$/i,
    ""
  );

  course = course.replace(
    /\s+SESSION\s*[-:]?\s*\d{4}\s*[-–/]\s*\d{4}.*$/i,
    ""
  );

  const short = course.match(
    /^(BA|BSC|BCOM|MA|MSC|MCOM)\s*\(\s*SEM/i
  );

  if (short) {
    return SHORT_COURSE_MAP[
      short[1].toUpperCase()
    ];
  }

  course = course
    .replace(/\s+/g, " ")
    .trim();

  return course
    ? course.toUpperCase()
    : null;
}

function getCourseType(courseName) {
  const course = String(
    courseName || ""
  ).toUpperCase();

  if (
    course.includes("BACHELOR OF ARTS") ||
    course.includes("BACHELOR OF SCIENCE") ||
    course.includes("BACHELOR OF COMMERCE") ||
    course.includes("B.COM")
  ) {
    return "UG";
  }

  if (
    course.includes("MASTER OF ARTS") ||
    course.includes("MASTER OF SCIENCE") ||
    course.includes("MASTER OF COMMERCE")
  ) {
    return "PG";
  }

  if (course.includes("BACHELOR")) {
    return "UG";
  }

  if (course.includes("MASTER")) {
    return "PG";
  }

  return null;
}

/* =========================================================
   SESSION
========================================================= */

function normalizeSessionName(value) {
  const session = clean(value);

  if (!session) return null;

  const match = session.match(
    /(\d{4})\s*[-–/]\s*(\d{4})/
  );

  if (match) {
    return `${match[1]}-${match[2]}`;
  }

  return session.toUpperCase();
}

function parseSessionYears(session) {
  const normalized =
    normalizeSessionName(session);

  if (!normalized) {
    return {
      startYear: null,
      endYear: null,
    };
  }

  const match =
    normalized.match(/^(\d{4})-(\d{4})$/);

  if (!match) {
    return {
      startYear: null,
      endYear: null,
    };
  }

  return {
    startYear: Number(match[1]),
    endYear: Number(match[2]),
  };
}

/* =========================================================
   SEMESTER
========================================================= */

const ROMAN = {
  I: 1,
  II: 2,
  III: 3,
  IV: 4,
  V: 5,
  VI: 6,
  VII: 7,
  VIII: 8,
  IX: 9,
  X: 10,
};

const ROMAN_BY_NUMBER = Object.fromEntries(
  Object.entries(ROMAN).map(
    ([roman, number]) => [number, roman]
  )
);

function normalizeSemester(value) {
  const text = clean(value);

  if (!text) return null;

  const match = text.match(
    /SEM(?:ESTER)?\s*[-:]?\s*([IVX]+|\d{1,2})\b/i
  );

  if (!match) return null;

  const token =
    match[1].toUpperCase();

  if (/^\d+$/.test(token)) {
    const roman =
      ROMAN_BY_NUMBER[Number(token)];

    return roman
      ? `SEM-${roman}`
      : null;
  }

  return ROMAN[token]
    ? `SEM-${token}`
    : null;
}

function semesterNumber(semester) {
  const match = String(
    semester || ""
  ).match(/^SEM-([IVX]+)$/);

  return match
    ? ROMAN[match[1]] || null
    : null;
}

/* =========================================================
   MAJOR PAPER / DATE
========================================================= */

function normalizeMajorPaper(value) {
  const major = clean(value);

  return major
    ? major.toUpperCase()
    : null;
}

function normalizeDate(value) {
  const text = clean(value);

  if (!text) return null;

  const match = text.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/
  );

  if (!match) return text;

  const day =
    match[1].padStart(2, "0");

  const month =
    match[2].padStart(2, "0");

  return `${match[3]}-${month}-${day}`;
}

/* =========================================================
   RESULT KEY
========================================================= */

function makeResultKey(row = {}) {
  const session =
    row.session ||
    row.sessionName ||
    "";

  const examType =
    row.examType ||
    row.exam_type ||
    "";

  const course =
    row.courseTitle ||
    row.course ||
    "";

  const roll =
    row.roll ||
    row.rollNo ||
    row.roll_no ||
    "";

  const semester =
    row.semester ||
    "";

  return [
    session,
    examType,
    course,
    roll,
    semester,
  ]
    .map((value) =>
      String(value || "")
        .trim()
        .toUpperCase()
    )
    .join("|||");
}

/* =========================================================
   PDF HELPERS
========================================================= */

function getPdfPathFromResult(
  row = {},
  meta = {}
) {
  return (
    row.pdfPath ||
    row.pdf_path ||
    meta.pdfPath ||
    meta.pdf_path ||
    null
  );
}

function getExistingPdfUrl(
  row = {},
  meta = {}
) {
  return clean(
    row.pdfUrl ||
      row.pdf_url ||
      meta.pdfUrl ||
      meta.pdf_url
  );
}

function sanitizeStoragePart(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|#%{}[\]^`]/g, "_")
    .replace(/\s+/g, "_");
}

function buildPdfStoragePath(row) {
  const session =
    sanitizeStoragePart(row.session);

  const examType =
    sanitizeStoragePart(row.exam_type);

  const course =
    sanitizeStoragePart(row.course);

  const semester =
    sanitizeStoragePart(row.semester);

  const roll =
    sanitizeStoragePart(row.roll_no);

  const filename =
    `${roll}.pdf`;

  return [
    session,
    examType,
    course,
    semester || "UNKNOWN-SEMESTER",
    filename,
  ].join("/");
}

function isPdfFile(filePath) {
  return (
    typeof filePath === "string" &&
    /\.pdf$/i.test(filePath)
  );
}

/* =========================================================
   UPLOAD PDF TO SUPABASE STORAGE
========================================================= */

async function uploadResultPdf(
  normalizedRow,
  sourcePdfPath
) {
  if (!supabase) {
    return {
      pdf_path: null,
      pdf_url: null,
    };
  }

  if (!sourcePdfPath) {
    return {
      pdf_path: null,
      pdf_url: null,
    };
  }

  if (!fs.existsSync(sourcePdfPath)) {
    console.warn(
      `⚠️ PDF not found: ${sourcePdfPath}`
    );

    return {
      pdf_path: null,
      pdf_url: null,
    };
  }

  if (!isPdfFile(sourcePdfPath)) {
    console.warn(
      `⚠️ Not a PDF file: ${sourcePdfPath}`
    );

    return {
      pdf_path: null,
      pdf_url: null,
    };
  }

  const storagePath =
    buildPdfStoragePath(normalizedRow);

  try {
    const buffer =
      fs.readFileSync(sourcePdfPath);

    console.log(
      `📤 PDF → Storage: ${normalizedRow.roll_no}`
    );

    const { error } =
      await supabase.storage
        .from(SUPABASE_STORAGE_BUCKET)
        .upload(
          storagePath,
          buffer,
          {
            contentType:
              "application/pdf",

            upsert: false,

            cacheControl:
              "31536000",
          }
        );

    /*
     * If file already exists, this is NOT a failure.
     *
     * We simply reuse the existing file.
     */
    if (error) {
      const message =
        String(error.message || "");

      const alreadyExists =
        /already exists|duplicate|exists/i.test(
          message
        );

      if (!alreadyExists) {
        throw error;
      }

      console.log(
        `♻️ PDF already exists → ${normalizedRow.roll_no}`
      );
    } else {
      console.log(
        `✅ PDF uploaded → ${normalizedRow.roll_no}`
      );
    }

    const {
      data: publicData,
    } = supabase.storage
      .from(SUPABASE_STORAGE_BUCKET)
      .getPublicUrl(storagePath);

    return {
      pdf_path: storagePath,
      pdf_url:
        publicData?.publicUrl || null,
    };
  } catch (error) {
    console.error(
      `❌ PDF upload failed (${normalizedRow.roll_no}):`,
      error.message
    );

    return {
      pdf_path: null,
      pdf_url: null,
    };
  }
}

/* =========================================================
   NORMALIZE RESULT
========================================================= */

function normalizeResultRow(
  row = {},
  meta = {}
) {
  const roll = clean(
    row.roll ||
      row.rollNo ||
      row.roll_no ||
      meta.roll
  );

  const session =
    normalizeSessionName(
      row.session ||
        row.sessionName ||
        meta.session
    );

  const examType =
    cleanUpper(
      row.examType ||
        row.exam_type ||
        meta.examType
    );

  const course =
    normalizeCourseName(
      row.courseTitle ||
        row.course ||
        row.course_name ||
        meta.course
    );

  const semester =
    normalizeSemester(row.semester) ||
    normalizeSemester(meta.semester) ||
    normalizeSemester(meta.course);

  const majorPaper =
    normalizeMajorPaper(
      row.majorPaper ||
        row.major_paper ||
        row.major ||
        meta.majorPaper
    );

  const resultKey =
    makeResultKey({
      roll,
      session,
      examType,
      course,
      semester,
    });

  const now =
    new Date().toISOString();

  const {
    rawText,
    pdfPath,
    pdf_path,
    pdfUrl,
    pdf_url,
    ...rawWithoutText
  } = row;

  return {
    result_key: resultKey,

    roll_no: roll,

    student_name: clean(
      row.studentName ||
        row.name ||
        row.student_name
    ),

    father_name: clean(
      row.fatherName ||
        row.father_name
    ),

    mother_name: clean(
      row.motherName ||
        row.mother_name
    ),

    enrollment_no: clean(
      row.enrollmentNo ||
        row.enrollment_no
    ),

    college_code: clean(
      row.collegeCode ||
        row.college_code
    ),

    college_name: clean(
      row.collegeName ||
        row.college_name
    ),

    session,

    exam_type: examType,

    course,

    semester,

    semester_no:
      semesterNumber(semester),

    sgpa: toNumeric(row.sgpa),

    cgpa: toNumeric(row.cgpa),

    remarks: cleanUpper(
      row.remarks
    ),

    total_earned_credits: clean(
      row.totalEarnedCredits ||
        row.total_earned_credits
    ),

    publication_date:
      normalizeDate(
        row.publicationDate ||
          row.publication_date
      ),

    pdf_url:
      getExistingPdfUrl(
        row,
        meta
      ),

    pdf_path: clean(
      row.pdfPath ||
        row.pdf_path ||
        meta.pdfPath ||
        meta.pdf_path
    ),

    source: clean(
      row.source ||
        meta.source
    ),

    last_seen_at: now,

    updated_at: now,

    raw_text:
      rawText
        ? String(rawText)
        : null,

    __majorPaper:
      majorPaper,

    __rawData:
      rawWithoutText,
  };
}

/* =========================================================
   MASTER TABLE CACHE
========================================================= */

const courseIdCache =
  new Map();

const sessionIdCache =
  new Map();

const majorPaperIdCache =
  new Map();

async function upsertMaster(
  table,
  conflictColumn,
  payload
) {
  const {
    data,
    error,
  } = await supabase
    .from(table)
    .upsert(
      payload,
      {
        onConflict:
          conflictColumn,
      }
    )
    .select("id")
    .single();

  if (error) throw error;

  return data?.id || null;
}

async function getOrCreateCourse(
  courseValue
) {
  if (!supabase) return null;

  const courseName =
    normalizeCourseName(courseValue);

  if (!courseName) return null;

  if (
    courseIdCache.has(courseName)
  ) {
    return courseIdCache.get(
      courseName
    );
  }

  try {
    const id =
      await upsertMaster(
        "courses",
        "course_name",
        {
          course_name:
            courseName,

          course_type:
            getCourseType(
              courseName
            ),
        }
      );

    if (id) {
      courseIdCache.set(
        courseName,
        id
      );
    }

    return id;
  } catch (error) {
    console.error(
      `⚠️ Course save failed (${courseName}):`,
      error.message
    );

    return null;
  }
}

async function getOrCreateSession(
  sessionValue
) {
  if (!supabase) return null;

  const sessionName =
    normalizeSessionName(
      sessionValue
    );

  if (!sessionName) return null;

  if (
    sessionIdCache.has(
      sessionName
    )
  ) {
    return sessionIdCache.get(
      sessionName
    );
  }

  try {
    const years =
      parseSessionYears(
        sessionName
      );

    const id =
      await upsertMaster(
        "sessions",
        "session_name",
        {
          session_name:
            sessionName,

          start_year:
            years.startYear,

          end_year:
            years.endYear,
        }
      );

    if (id) {
      sessionIdCache.set(
        sessionName,
        id
      );
    }

    return id;
  } catch (error) {
    console.error(
      `⚠️ Session save failed (${sessionName}):`,
      error.message
    );

    return null;
  }
}

async function getOrCreateMajorPaper(
  majorValue
) {
  if (!supabase) return null;

  const majorName =
    normalizeMajorPaper(
      majorValue
    );

  if (!majorName) return null;

  if (
    majorPaperIdCache.has(
      majorName
    )
  ) {
    return majorPaperIdCache.get(
      majorName
    );
  }

  try {
    const id =
      await upsertMaster(
        "major_papers",
        "major_name",
        {
          major_name:
            majorName,
        }
      );

    if (id) {
      majorPaperIdCache.set(
        majorName,
        id
      );
    }

    return id;
  } catch (error) {
    console.error(
      `⚠️ Major Paper save failed (${majorName}):`,
      error.message
    );

    return null;
  }
}

async function attachMasterReferences(
  rows
) {
  const unique = (list) =>
    [...new Set(
      list.filter(Boolean)
    )];

  await Promise.all([
    ...unique(
      rows.map(
        (r) => r.course
      )
    ).map(
      getOrCreateCourse
    ),

    ...unique(
      rows.map(
        (r) => r.session
      )
    ).map(
      getOrCreateSession
    ),

    ...unique(
      rows.map(
        (r) =>
          r.__majorPaper
      )
    ).map(
      getOrCreateMajorPaper
    ),
  ]);

  for (const row of rows) {
    row.course_id =
      row.course
        ? courseIdCache.get(
            row.course
          ) || null
        : null;

    row.session_id =
      row.session
        ? sessionIdCache.get(
            row.session
          ) || null
        : null;

    row.major_paper_id =
      row.__majorPaper
        ? majorPaperIdCache.get(
            row.__majorPaper
          ) || null
        : null;
  }
}

/* =========================================================
   PREPARE / DEDUPE
========================================================= */

function prepareForDatabase(
  normalizedRow
) {
  const row = {
    ...normalizedRow,
  };

  delete row.__majorPaper;
  delete row.__rawData;

  row.major_paper =
    normalizedRow.__majorPaper ||
    null;

  row.raw_data =
    normalizedRow.__rawData ||
    null;

  return row;
}

function dedupeByKey(rows) {
  const map = new Map();

  for (const row of rows) {
    const existing =
      map.get(row.result_key);

    if (!existing) {
      map.set(
        row.result_key,
        row
      );
      continue;
    }

    for (const [
      field,
      value,
    ] of Object.entries(row)) {
      const current =
        existing[field];

      if (
        (current === null ||
          current === undefined ||
          current === "") &&
        value
      ) {
        existing[field] = value;
      }
    }
  }

  return [...map.values()];
}

function sortRows(rows) {
  return rows.sort((a, b) => {
    return (
      String(
        a.session || ""
      ).localeCompare(
        String(b.session || "")
      ) ||

      String(
        a.course || ""
      ).localeCompare(
        String(b.course || "")
      ) ||

      (a.semester_no || 0) -
        (b.semester_no || 0) ||

      String(
        a.roll_no || ""
      ).localeCompare(
        String(b.roll_no || ""),
        undefined,
        {
          numeric: true,
        }
      )
    );
  });
}

function logQuality(rows) {
  const missing = (field) =>
    rows.filter(
      (r) => !r[field]
    ).length;

  const report = {
    student_name:
      missing("student_name"),

    father_name:
      missing("father_name"),

    mother_name:
      missing("mother_name"),

    enrollment_no:
      missing("enrollment_no"),

    college_code:
      missing("college_code"),

    semester:
      missing("semester"),

    sgpa:
      missing("sgpa"),

    cgpa:
      missing("cgpa"),

    remarks:
      missing("remarks"),

    publication_date:
      missing("publication_date"),

    major_paper:
      rows.filter(
        (r) =>
          !r.__majorPaper &&
          !r.major_paper
      ).length,
  };

  const problems =
    Object.entries(report)
      .filter(
        ([, count]) =>
          count > 0
      );

  if (problems.length && (rows.length > 1 || process.env.DEBUG_LOGS === "1")) {
    console.log(
      `🔎 Data check (${rows.length} rows) - missing: ` +
        problems
          .map(
            ([field, count]) =>
              `${field}=${count}`
          )
          .join(", ")
    );
  }
}

/* =========================================================
   PDF UPLOAD CONCURRENCY
========================================================= */

async function uploadPdfRows(
  normalizedRows,
  meta = {}
) {
  const queue =
    normalizedRows.filter(
      (row) =>
        getPdfPathFromResult(
          row,
          meta
        ) ||
        getExistingPdfUrl(
          row,
          meta
        )
    );

  if (!queue.length) {
    return;
  }

  let index = 0;

  async function worker() {
    while (true) {
      const current =
        index++;

      if (current >= queue.length) {
        return;
      }

      const row =
        queue[current];

      /*
       * If URL already exists, don't upload.
       */
      const existingUrl =
        getExistingPdfUrl(
          row,
          meta
        );

      if (
        existingUrl &&
        !getPdfPathFromResult(
          row,
          meta
        )
      ) {
        row.pdf_url =
          existingUrl;

        continue;
      }

      const pdfPath =
        getPdfPathFromResult(
          row,
          meta
        );

      if (!pdfPath) {
        continue;
      }

      const uploaded =
        await uploadResultPdf(
          row,
          pdfPath
        );

      if (
        uploaded.pdf_path
      ) {
        row.pdf_path =
          uploaded.pdf_path;
      }

      if (
        uploaded.pdf_url
      ) {
        row.pdf_url =
          uploaded.pdf_url;
      }
    }
  }

  const workerCount =
    Math.min(
      PDF_UPLOAD_CONCURRENCY,
      queue.length
    );

  await Promise.all(
    Array.from(
      {
        length:
          workerCount,
      },
      worker
    )
  );
}

/* =========================================================
   RETRY HELPERS
========================================================= */

function isTransient(error) {
  const text =
    `${error?.code || ""} ` +
    `${error?.message || ""} ` +
    `${error?.details || ""}`;

  return /fetch failed|network|timeout|timed out|ECONN|ETIMEDOUT|EAI_AGAIN|\b429\b|\b50[234]\b|57014|rate limit/i.test(
    text
  );
}

/* =========================================================
   DATABASE WRITE
========================================================= */

async function upsertWithRetry(
  rows
) {
  let payload = rows;

  const droppedColumns =
    new Set();

  let attempt = 0;

  while (true) {
    attempt++;

    const {
      data,
      error,
    } = await supabase
      .from("results")
      .upsert(
        payload,
        {
          onConflict:
            "result_key",
        }
      )
      .select("result_key");

    if (!error) {
      return data || [];
    }

    const missingColumn =
      String(
        error.message || ""
      ).match(
        /Could not find the '([^']+)' column/i
      );

    if (
      missingColumn &&
      missingColumn[1] !==
        "result_key" &&
      !droppedColumns.has(
        missingColumn[1]
      )
    ) {
      const column =
        missingColumn[1];

      droppedColumns.add(
        column
      );

      console.warn(
        `⚠️ results table has no '${column}' column - saving without it for now.`
      );

      payload =
        payload.map((row) => {
          const copy = {
            ...row,
          };

          delete copy[column];

          return copy;
        });

      continue;
    }

    if (
      attempt >= 4 ||
      !isTransient(error)
    ) {
      throw error;
    }

    await sleep(
      500 *
        2 ** (attempt - 1)
    );
  }
}

function writePending(
  rows,
  reason
) {
  try {
    fs.appendFileSync(
      PENDING_FILE,
      JSON.stringify({
        at: new Date().toISOString(),
        reason,
        rows,
      }) + "\n",
      "utf8"
    );

    console.warn(
      `📥 ${rows.length} row(s) saved locally for retry (${path.basename(
        PENDING_FILE
      )})`
    );
  } catch (error) {
    console.error(
      "❌ Could not write pending-saves file:",
      error.message
    );
  }
}

async function saveChunk(
  chunk
) {
  try {
    return await upsertWithRetry(
      chunk
    );
  } catch (error) {
    if (chunk.length === 1) {
      writePending(
        chunk,
        error.message
      );

      return [];
    }

    console.warn(
      `⚠️ Batch failed (${error.message}) - saving row by row...`
    );

    const saved = [];
    const failed = [];

    for (const row of chunk) {
      try {
        saved.push(
          ...(await upsertWithRetry([
            row,
          ]))
        );
      } catch (rowError) {
        failed.push(row);

        console.error(
          `❌ Row save failed (${rowError.message})`
        );
      }
    }

    if (failed.length) {
      writePending(
        failed,
        "row-level failure"
      );
    }

    return saved;
  }
}

/* =========================================================
   PENDING REPLAY
========================================================= */

let replayRunning = false;

async function retryPendingSaves() {
  if (
    !supabase ||
    replayRunning ||
    !fs.existsSync(PENDING_FILE)
  ) {
    return;
  }

  replayRunning = true;

  try {
    const lines =
      fs
        .readFileSync(
          PENDING_FILE,
          "utf8"
        )
        .split("\n")
        .filter(Boolean);

    if (!lines.length) {
      return;
    }

    const stillPending = [];

    let recovered = 0;

    for (const line of lines) {
      let entry;

      try {
        entry =
          JSON.parse(line);
      } catch (_) {
        continue;
      }

      try {
        const saved =
          await upsertWithRetry(
            entry.rows
          );

        recovered +=
          saved.length;
      } catch (_) {
        stillPending.push(
          line
        );
      }
    }

    const tmp =
      PENDING_FILE +
      ".tmp";

    fs.writeFileSync(
      tmp,
      stillPending.length
        ? stillPending.join("\n") +
            "\n"
        : "",
      "utf8"
    );

    fs.renameSync(
      tmp,
      PENDING_FILE
    );

    if (recovered) {
      console.log(
        `♻️ Recovered ${recovered} pending result(s)`
      );
    }
  } catch (error) {
    console.error(
      "⚠️ Pending replay failed:",
      error.message
    );
  } finally {
    replayRunning = false;
  }
}

if (supabase) {
  setTimeout(
    () =>
      retryPendingSaves(),
    15000
  ).unref();

  setInterval(
    () =>
      retryPendingSaves(),
    5 * 60 * 1000
  ).unref();
}

/* =========================================================
   SAVE SINGLE RESULT
========================================================= */

async function saveResult(
  resultDetails,
  meta = {}
) {
  if (!supabase) {
    return {
      skipped: true,
      reason:
        "Supabase is not configured",
    };
  }

  const normalized =
    normalizeResultRow(
      resultDetails,
      meta
    );

  if (!normalized.roll_no) {
    throw new Error(
      "Roll number is missing"
    );
  }

  /*
   * PDF upload BEFORE database save.
   *
   * Therefore DB will contain the
   * correct PDF path/url.
   */
  await uploadPdfRows(
    [normalized],
    meta
  );

  await attachMasterReferences([
    normalized,
  ]);

  logQuality([
    normalized,
  ]);

  const saved =
    await saveChunk([
      prepareForDatabase(
        normalized
      ),
    ]);

  if (!saved.length) {
    throw new Error(
      "Result could not be saved (kept for retry)"
    );
  }

  return saved[0];
}

/* =========================================================
   SAVE MULTIPLE RESULTS
========================================================= */

const CHUNK_SIZE = Math.max(
  10,
  Number(
    process.env.SUPABASE_CHUNK_SIZE ||
      100
  )
);

async function saveResults(
  results = [],
  meta = {}
) {
  if (!supabase) {
    return {
      skipped: true,
      reason:
        "Supabase is not configured",
    };
  }

  if (
    !Array.isArray(results) ||
    !results.length
  ) {
    return [];
  }

  const normalizedRows = [];

  for (const result of results) {
    try {
      const normalized =
        normalizeResultRow(
          result,
          meta
        );

      if (normalized.roll_no) {
        normalizedRows.push(
          normalized
        );
      }
    } catch (error) {
      console.error(
        "⚠️ Result normalization failed:",
        error.message
      );
    }
  }

  if (!normalizedRows.length) {
    return [];
  }

  /*
   * Upload all individual PDFs
   * concurrently.
   */
  await uploadPdfRows(
    normalizedRows,
    meta
  );

  await attachMasterReferences(
    normalizedRows
  );

  const databaseRows =
    sortRows(
      dedupeByKey(
        normalizedRows
      ).map(
        prepareForDatabase
      )
    );

  logQuality(
    databaseRows
  );

  console.log(
    `☁️ Saving ${databaseRows.length} results to Supabase...`
  );

  const allSaved = [];

  const totalChunks =
    Math.ceil(
      databaseRows.length /
        CHUNK_SIZE
    );

  for (
    let i = 0;
    i < databaseRows.length;
    i += CHUNK_SIZE
  ) {
    const chunk =
      databaseRows.slice(
        i,
        i + CHUNK_SIZE
      );

    const saved =
      await saveChunk(
        chunk
      );

    allSaved.push(
      ...saved
    );

    console.log(
      `☁️ Batch ${
        Math.floor(
          i / CHUNK_SIZE
        ) + 1
      }/${totalChunks}: ${
        saved.length
      }/${chunk.length} saved`
    );
  }

  return allSaved;
}

/* =========================================================
   FETCH RESULT BY KEY
========================================================= */

async function getResultByKey(
  resultKey
) {
  if (!supabase || !resultKey) {
    return null;
  }

  const {
    data,
    error,
  } = await supabase
    .from("results")
    .select("*")
    .eq(
      "result_key",
      resultKey
    )
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

/* =========================================================
   FETCH RESULT BY ROLL
========================================================= */

async function findResult(
  {
    session,
    examType,
    course,
    semester,
    roll,
  } = {}
) {
  if (!supabase || !roll) {
    return null;
  }

  const normalizedSession =
    normalizeSessionName(
      session
    );

  const normalizedCourse =
    normalizeCourseName(
      course
    );

  const normalizedSemester =
    normalizeSemester(
      semester
    );

  let query =
    supabase
      .from("results")
      .select("*")
      .eq(
        "roll_no",
        clean(roll)
      );

  if (normalizedSession) {
    query = query.eq(
      "session",
      normalizedSession
    );
  }

  if (examType) {
    query = query.eq(
      "exam_type",
      cleanUpper(examType)
    );
  }

  if (normalizedCourse) {
    query = query.eq(
      "course",
      normalizedCourse
    );
  }

  if (normalizedSemester) {
    query = query.eq(
      "semester",
      normalizedSemester
    );
  }

  const {
    data,
    error,
  } = await query
    .order(
      "updated_at",
      {
        ascending: false,
      }
    )
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

/* =========================================================
   STATUS / EXPORTS
========================================================= */

function isSupabaseEnabled() {
  return Boolean(supabase);
}

module.exports = {
  saveResult,
  saveResults,

  getResultByKey,
  findResult,

  isSupabaseEnabled,

  retryPendingSaves,

  normalizeCourseName,
  normalizeSessionName,
  normalizeSemester,
  normalizeMajorPaper,

  getOrCreateCourse,
  getOrCreateSession,
  getOrCreateMajorPaper,

  makeResultKey,
  normalizeResultRow,
  semesterNumber,

  uploadResultPdf,
};