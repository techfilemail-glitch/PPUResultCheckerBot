const fs = require("fs");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs");

/*
 * =========================================================
 * CONFIG
 * =========================================================
 */

const DEBUG = process.env.DEBUG_LOGS === "1";

// Merged PDF page extraction concurrency.
// 4–8 is usually a good range for Node.js.
const PAGE_CONCURRENCY = Math.max(
  1,
  Math.min(Number(process.env.PDF_PAGE_CONCURRENCY) || 6, 12)
);

// rawText can be large.
// Keep disabled by default to reduce RAM usage.
const INCLUDE_RAW_TEXT = process.env.INCLUDE_RAW_TEXT === "1";

/*
 * =========================================================
 * LOGGING
 * =========================================================
 */

function debug(...args) {
  if (DEBUG) {
    console.log(...args);
  }
}

function maskRoll(roll) {
  const text = String(roll || "");

  if (text.length <= 4) {
    return text;
  }

  return "*".repeat(text.length - 4) + text.slice(-4);
}

/*
 * =========================================================
 * PDF TEXT EXTRACTION
 * =========================================================
 */

async function loadPdf(pdfPath) {
  const buffer = await fs.promises.readFile(pdfPath);

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: true,
  });

  return {
    pdf: await loadingTask.promise,
    loadingTask,
  };
}

async function extractPageText(pdf, pageNo) {
  const page = await pdf.getPage(pageNo);

  try {
    const content = await page.getTextContent();

    return normalizePdfText(
      content.items
        .map((item) => item?.str || "")
        .join(" ")
    );
  } finally {
    try {
      page.cleanup();
    } catch (_) {}
  }
}

/*
 * =========================================================
 * NORMALIZE
 * =========================================================
 */

function normalizePdfText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/[–—−]/g, "-")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/*
 * =========================================================
 * GENERIC HELPERS
 * =========================================================
 */

function cleanValue(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,:-]+/, "")
    .replace(/[\s,:-]+$/, "")
    .trim();
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match?.[1]) {
      const value = cleanValue(match[1]);

      if (value) {
        return value;
      }
    }
  }

  return null;
}

function firstNumericMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

/*
 * =========================================================
 * STUDENT NAME
 * =========================================================
 */

function extractStudentName(text) {
  return firstMatch(text, [
    /Student'?s?\s+Name\s*[:\-]?\s*(.+?)(?=\s+Father'?s?\s+Name\b)/i,
    /Student\s+Name\s*[:\-]?\s*(.+?)(?=\s+Father\b)/i,
    /Candidate\s+Name\s*[:\-]?\s*(.+?)(?=\s+Father\b)/i,

    // Naye layouts: "Name of Student : X", "Name : X Father's Name ..."
    /Name\s+of\s+(?:the\s+)?(?:Student|Candidate|Examinee)\s*[:\-]?\s*(.+?)(?=\s+(?:Father|Mother|Guardian|Roll|Reg|Enroll|Course|College|Session|Exam|Semester)\b)/i,

    /(?<![A-Za-z'])Name\s*[:\-]\s*([A-Za-z][A-Za-z .']{2,60}?)(?=\s+(?:Father|Mother|Guardian|Roll|Reg|Enroll|Course|College|Session|Exam|Semester)\b)/,
  ]);
}

/*
 * =========================================================
 * FATHER NAME
 * =========================================================
 */

function extractFatherName(text) {
  return firstMatch(text, [
    /Father'?s?\s+Name\s*[:\-]?\s*(.+?)(?=\s+Mother'?s?\s+Name\b)/i,
    /Father'?s?\s+Name\s*[:\-]?\s*(.+?)(?=\s+Enroll\.?\s*No\b)/i,
    /Father\s+Name\s*[:\-]?\s*(.+?)(?=\s+Mother\b)/i,

    /Father'?s?\s+Name\s*[:\-]?\s*([A-Za-z][A-Za-z .']{2,60}?)(?=\s+(?:Mother|Guardian|Roll|Reg|Enroll|Course|College|Session|Exam|Semester)\b)/i,
  ]);
}

/*
 * =========================================================
 * MOTHER NAME
 * =========================================================
 */

function extractMotherName(text) {
  return firstMatch(text, [
    /Mother'?s?\s+Name\s*[:\-]?\s*(.+?)(?=\s+Exam\.?\s*Type\b)/i,
    /Mother'?s?\s+Name\s*[:\-]?\s*(.+?)(?=\s+COURSE\b)/i,
    /Mother\s+Name\s*[:\-]?\s*(.+?)(?=\s+Exam\b)/i,

    /Mother'?s?\s+Name\s*[:\-]?\s*([A-Za-z][A-Za-z .']{2,60}?)(?=\s+(?:Guardian|Roll|Reg|Enroll|Course|College|Session|Exam|Semester)\b)/i,
  ]);
}

/*
 * =========================================================
 * ROLL NUMBER
 * =========================================================
 */

function extractRollNumber(text) {
  return firstNumericMatch(text, [
    /Roll\.?\s*No\.?\s*[:\-]?\s*(\d{8,20})/i,
    /Roll\s+Number\s*[:\-]?\s*(\d{8,20})/i,
    /\bRoll\s*[:\-]?\s*(\d{8,20})/i,
  ]);
}

/*
 * =========================================================
 * ENROLLMENT NUMBER
 * =========================================================
 */

function extractEnrollmentNumber(text) {
  return firstNumericMatch(text, [
    /Enroll\.?\s*No\.?\s*[:\-]?\s*(\d{6,30})/i,
    /Enrollment\s+No\.?\s*[:\-]?\s*(\d{6,30})/i,
    /Registration\s+No\.?\s*[:\-]?\s*(\d{6,30})/i,
  ]);
}

/*
 * =========================================================
 * COLLEGE CODE
 * =========================================================
 */

function extractCollegeCode(text) {
  return firstNumericMatch(text, [
    /College\s+Code\s*&?\s*Name\s*[:\-]?\s*(\d{2,6})\s*[-:]/i,
    /College\s+Code\s*[:\-]?\s*(\d{2,6})/i,
  ]);
}

/*
 * =========================================================
 * COLLEGE NAME
 * =========================================================
 */

function extractCollegeName(text) {
  const value = firstMatch(text, [
    /College\s+Code\s*&?\s*Name\s*[:\-]?\s*\d{2,6}\s*[-:]\s*(.+?)(?=\s+This\s+is\s+an\s+internet\s+copy\b)/i,

    /College\s+Code\s*&?\s*Name\s*[:\-]?\s*\d{2,6}\s*[-:]\s*(.+?)(?=\s+This\s+is\b)/i,

    /College\s+Code\s*&?\s*Name\s*[:\-]?\s*\d{2,6}\s*[-:]\s*(.+?)(?=\s+Student'?s?\s+Name\b)/i,

    /College\s+Code\s*&?\s*Name\s*[:\-]?\s*\d{2,6}\s*[-:]\s*(.+?)(?=\s+Exam\.?\s*Type\b)/i,
  ]);

  if (!value) {
    return null;
  }

  return value
    .replace(/\s+/g, " ")
    .replace(/\s*[-:]\s*$/, "")
    .trim()
    .toUpperCase();
}

/*
 * =========================================================
 * SESSION
 * =========================================================
 */

function extractSession(text) {
  const patterns = [
    /SESSION\s*[-:]?\s*(\d{4}\s*[-/]\s*\d{4})/i,
    /\b(\d{4}\s*[-/]\s*\d{4})\b/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match?.[1]) {
      return match[1]
        .replace(/\s+/g, "")
        .replace(/\//g, "-");
    }
  }

  return null;
}

/*
 * =========================================================
 * EXAM TYPE
 * =========================================================
 */

function extractExamType(text) {
  const match = text.match(
    /Exam\.?\s*Type\s*[:\-]?\s*(Regular|Back|Private|Ex-Regular|Vocational|Annual|Improvement|Special)/i
  );

  return match?.[1]
    ? match[1].trim().toUpperCase()
    : null;
}

/*
 * =========================================================
 * COURSE
 * =========================================================
 */

function extractCourse(text) {
  const patterns = [
    /\b(BACHELOR\s+OF\s+ARTS(?:\s*\([^)]*\))?)\s*-\s*YEAR\b/i,

    /\b(BACHELOR\s+OF\s+COMMERCE(?:\s*\([^)]*\))?)\s*-\s*YEAR\b/i,

    /\b(BACHELOR\s+OF\s+SCIENCE(?:\s*\([^)]*\))?)\s*-\s*YEAR\b/i,

    /\b(BACHELOR\s+OF\s+VOCATIONAL(?:\s*\([^)]*\))?)\s*-\s*YEAR\b/i,

    /\b(BACHELOR\s+OF\s+COMPUTER\s+APPLICATIONS?)\s*-\s*YEAR\b/i,

    /\b(MASTER\s+OF\s+ARTS(?:\s*\([^)]*\))?)\s*-\s*YEAR\b/i,

    /\b(MASTER\s+OF\s+SCIENCE(?:\s*\([^)]*\))?)\s*-\s*YEAR\b/i,

    /\b(MASTER\s+OF\s+COMMERCE(?:\s*\([^)]*\))?)\s*-\s*YEAR\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match?.[1]) {
      return cleanValue(match[1]).toUpperCase();
    }
  }

  const fallbackPatterns = [
    /\b((?:BACHELOR|MASTER)\s+OF\s+[A-Z][A-Z\s()&.'/-]{2,150}?)(?=\s*-\s*YEAR\b)/i,

    /\b((?:BACHELOR|MASTER)\s+OF\s+[A-Z][A-Z\s()&.'/-]{2,150}?)(?=\s+SESSION\b)/i,
  ];

  for (const pattern of fallbackPatterns) {
    const match = text.match(pattern);

    if (match?.[1]) {
      return cleanValue(match[1]).toUpperCase();
    }
  }

  return null;
}

/*
 * =========================================================
 * SEMESTER
 * =========================================================
 */

function extractSemester(text) {
  const patterns = [
    /YEAR\s*-\s*\d+\s*-\s*SEM\s*-\s*([IVX]+)/i,

    /YEAR\s*-\s*\d+\s*-\s*SEMESTER\s*-\s*([IVX]+)/i,

    /\bSEM\s*-\s*([IVX]+)\b/i,

    /\bSEMESTER\s*-\s*([IVX]+)\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match?.[1]) {
      return `SEM-${match[1].toUpperCase()}`;
    }
  }

  return null;
}

/*
 * =========================================================
 * MAJOR PAPER
 * =========================================================
 */

function extractMajorPaper(text) {
  if (!text) {
    return null;
  }

  const patterns = [
    // ECONOMICS [MAJOR]
    /\b([A-Za-z][A-Za-z0-9 &.'/-]{1,100}?)\s*\[\s*MAJOR\s*\]/i,

    // ECONOMICS (MAJOR)
    /\b([A-Za-z][A-Za-z0-9 &.'/-]{1,100}?)\s*\(\s*MAJOR\s*\)/i,

    // ECONOMICS [MAJOR PAPER]
    /\b([A-Za-z][A-Za-z0-9 &.'/-]{1,100}?)\s*\[\s*MAJOR\s+PAPER\s*\]/i,

    // ECONOMICS (MAJOR PAPER)
    /\b([A-Za-z][A-Za-z0-9 &.'/-]{1,100}?)\s*\(\s*MAJOR\s+PAPER\s*\)/i,

    // ECONOMICS - MAJOR
    /\b([A-Za-z][A-Za-z0-9 &.'/-]{1,100}?)\s*-\s*MAJOR\b/i,

    // MAJOR: ECONOMICS
    /\bMAJOR\s*[:\-]\s*([A-Za-z][A-Za-z0-9 &.'/-]{1,100})/i,

    // MAJOR PAPER: ECONOMICS
    /\bMAJOR\s+PAPER\s*[:\-]\s*([A-Za-z][A-Za-z0-9 &.'/-]{1,100})/i,

    // MAJOR SUBJECT: ECONOMICS
    /\bMAJOR\s+SUBJECT\s*[:\-]\s*([A-Za-z][A-Za-z0-9 &.'/-]{1,100})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (!match?.[1]) {
      continue;
    }

    const value = cleanMajorPaper(match[1]);

    if (value) {
      return value;
    }
  }

  return null;
}

/*
 * =========================================================
 * CLEAN MAJOR PAPER
 * =========================================================
 */

function cleanMajorPaper(value) {
  let result = cleanValue(value);

  if (!result) {
    return null;
  }

  /*
   * Remove result-related information accidentally captured
   * after subject name.
   */

  result = result
    .replace(
      /\s+\b(?:SGPA|S\.G\.P\.A|CGPA|C\.G\.P\.A)\b.*$/i,
      ""
    )
    .trim();

  result = result
    .replace(
      /\s+\b(?:TOTAL\s+MARKS?|MARKS?|GRADE|CREDIT|CREDITS|RESULT|REMARKS?|SEMESTER|CURRENT\s+RESULT|CURRENT\s+SEM)\b.*$/i,
      ""
    )
    .trim();

  /*
   * Remove subject/paper codes.
   */

  result = result
    .replace(/^\d{3,8}\s+/, "")
    .replace(/\s+\d{3,8}\s*$/, "")
    .trim();

  /*
   * Remove major markers.
   */

  result = result
    .replace(/\s*\[\s*MAJOR\s*\]\s*$/i, "")
    .replace(/\s*\(\s*MAJOR\s*\)\s*$/i, "")
    .replace(/\s*-\s*MAJOR\s*$/i, "")
    .replace(/\s*\[\s*MAJOR\s+PAPER\s*\]\s*$/i, "")
    .replace(/\s*\(\s*MAJOR\s+PAPER\s*\)\s*$/i, "")
    .trim();

  result = result
    .replace(/[,:;|]+$/, "")
    .trim();

  if (!result || result.length > 100) {
    return null;
  }

  const rejected = new Set([
    "CURRENT",
    "PREVIOUS",
    "TOTAL",
    "RESULT",
    "MARKS",
    "GRADE",
    "CREDIT",
    "CREDITS",
    "SEMESTER",
    "PAPER",
    "SUBJECT",
    "COURSE",
    "THEORY",
    "PRACTICAL",
    "SESSIONAL",
    "SGPA",
    "CGPA",
  ]);

  if (rejected.has(result.toUpperCase())) {
    return null;
  }

  return result.toUpperCase();
}

/*
 * =========================================================
 * SGPA
 * =========================================================
 */

function extractSGPA(text) {
  const patterns = [
    /(?:^|\s)SGPA\s*[:\-]?\s*(\d+(?:\.\d+)?)/i,

    /S\.G\.P\.A\s*[:\-]?\s*(\d+(?:\.\d+)?)/i,

    /SEM(?:ESTER)?\s+SGPA\s*[:\-]?\s*(\d+(?:\.\d+)?)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

/*
 * =========================================================
 * CGPA
 * =========================================================
 */

function extractCGPA(text) {
  const patterns = [
    /(?:^|\s)CGPA\s*[:\-]?\s*(\d+(?:\.\d+)?)/i,

    /C\.G\.P\.A\s*[:\-]?\s*(\d+(?:\.\d+)?)/i,

    /CUMULATIVE\s+GPA\s*[:\-]?\s*(\d+(?:\.\d+)?)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

/*
 * =========================================================
 * REMARKS
 * =========================================================
 */

function extractRemarks(text) {
  // Sirf "Remarks : PASS" / "Result : PASSED" jaisi chhoti value.
  // "Publication of Result : 26-Sep-2026" aur disclaimer paragraph ko nahi pakadna.
  const patterns = [
    /\bRemarks?\s*[:\-]\s*([A-Za-z][A-Za-z ./()-]{1,60}?)(?=\s+(?:Total|Credit|CGPA|SGPA|Result|Publication|Date|This|Roll)\b|\s*$)/i,

    /(?<!of\s)\bResult\s*[:\-]\s*(PASS(?:ED)?|FAIL(?:ED)?|PROMOTED|WITHHELD|ABSENT|COMPARTMENT(?:AL)?|PCP|QUALIFIED|NOT\s+QUALIFIED|DETAINED|CANCELLED|UFM)\b/i,
  ];

  const value = firstMatch(text, patterns);

  if (!value || value.length > 60 || /not\s+responsible|inadvertent/i.test(value)) {
    return null;
  }

  return value;
}

/*
 * =========================================================
 * TOTAL EARNED CREDITS
 * =========================================================
 */

function extractTotalEarnCredits(text) {
  const patterns = [
    /Total\s+Earned\s+Credits?\s*[:\-]?\s*(\d+(?:\.\d+)?)/i,

    /Total\s+Earn\s+Credits?\s*[:\-]?\s*(\d+(?:\.\d+)?)/i,

    /Earned\s+Credits?\s*[:\-]?\s*(\d+(?:\.\d+)?)/i,

    /Total\s+Credits?\s*[:\-]?\s*(\d+(?:\.\d+)?)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

/*
 * =========================================================
 * RESULT / PUBLICATION DATE
 * =========================================================
 */

function extractResultDate(text) {
  const month = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*";

  const patterns = [
    // "Publication of Result : 26-Sep-2026"
    new RegExp(
      "Publication\\s+of\\s+Result\\s*[:\\-]?\\s*(\\d{1,2}[ \\/.-]" + month + "[ \\/.-]\\d{4})",
      "i"
    ),

    /Publication\s+of\s+Result\s*[:\-]?\s*(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4})/i,

    /(?:Result|Publication|Published)\s+Date\s*[:\-]?\s*(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4})/i,

    new RegExp(
      "(?:Result|Publication|Published)\\s+Date\\s*[:\\-]?\\s*(\\d{1,2}[ \\/.-]" + month + "[ \\/.-]\\d{4})",
      "i"
    ),

    /Date\s+of\s+(?:Result|Publication)\s*[:\-]?\s*(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4})/i,

    new RegExp("\\b(\\d{1,2}-" + month + "-\\d{4})\\b", "i"),

    /\b(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4})\b/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

/*
 * =========================================================
 * EMPTY DETAILS
 * =========================================================
 */

function emptyDetails() {
  return {
    name: null,
    fatherName: null,
    motherName: null,
    roll: null,
    enrollmentNo: null,
    collegeName: null,
    collegeCode: null,
    session: null,
    examType: null,
    courseTitle: null,
    course: null,
    semester: null,
    majorPaper: null,
    sgpa: null,
    cgpa: null,
    remarks: null,
    totalEarnedCredits: null,
    totalEarnCredits: null,
    publicationDate: null,
    resultDate: null,
    rawText: null,
  };
}

/*
 * =========================================================
 * BUILD DETAILS FROM TEXT
 *
 * IMPORTANT:
 * All extraction is centralized here.
 * This prevents duplicate regex work.
 * =========================================================
 */

function extractDetailsFromText(fullText, includeRawText = INCLUDE_RAW_TEXT) {
  const text = normalizePdfText(fullText);

  if (!text) {
    return emptyDetails();
  }

  const course = extractCourse(text);
  const resultDate = extractResultDate(text);
  const totalCredits = extractTotalEarnCredits(text);

  return {
    name: extractStudentName(text),

    fatherName: extractFatherName(text),

    motherName: extractMotherName(text),

    roll: extractRollNumber(text),

    enrollmentNo: extractEnrollmentNumber(text),

    collegeName: extractCollegeName(text),

    collegeCode: extractCollegeCode(text),

    session: extractSession(text),

    examType: extractExamType(text),

    courseTitle: course,

    course,

    semester: extractSemester(text),

    majorPaper: extractMajorPaper(text),

    sgpa: extractSGPA(text),

    cgpa: extractCGPA(text),

    remarks: extractRemarks(text),

    totalEarnedCredits: totalCredits,

    totalEarnCredits: totalCredits,

    publicationDate: resultDate,

    resultDate,

    ...(includeRawText ? { rawText: text } : { rawText: null }),
  };
}

/*
 * =========================================================
 * SINGLE RESULT PDF
 * =========================================================
 */

async function extractResultDetails(pdfPath) {
  let loadingTask = null;

  try {
    const loaded = await loadPdf(pdfPath);

    const pdf = loaded.pdf;
    loadingTask = loaded.loadingTask;

    let fullText = "";

    /*
     * Most individual result PDFs are only one page.
     * Sequential extraction is intentional here.
     */

    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const pageText = await extractPageText(pdf, pageNo);

      if (pageText) {
        fullText += " " + pageText;
      }
    }

    fullText = normalizePdfText(fullText);

    if (DEBUG) {
      debug(
        "📄 Extracted Result Text:",
        fullText.slice(0, 5000)
      );
    }

    const details = extractDetailsFromText(fullText);

    if (DEBUG) {
      console.log(
        `📊 Extracted: roll ${maskRoll(details.roll) || "not found"}` +
          ` | sem ${details.semester || "-"}` +
          ` | name ${details.name ? "ok" : "MISSING"}` +
          ` | sgpa ${details.sgpa ? "ok" : "MISSING"}`
      );
    }

    return details;
  } catch (error) {
    console.error(
      "⚠️ Result PDF text extraction failed:",
      error.message
    );

    return emptyDetails();
  } finally {
    try {
      if (loadingTask) {
        await loadingTask.destroy();
      }
    } catch (_) {}
  }
}

/*
 * =========================================================
 * CONTROLLED CONCURRENCY WORKER
 * =========================================================
 */

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);

  let nextIndex = 0;

  async function runner() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) {
        return;
      }

      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = {
          error,
          index,
        };
      }
    }
  }

  const workerCount = Math.min(
    concurrency,
    items.length
  );

  await Promise.all(
    Array.from(
      { length: workerCount },
      () => runner()
    )
  );

  return results;
}

/*
 * =========================================================
 * MERGED PDF
 * =========================================================
 */

async function extractResultsFromMergedPdf(pdfPath) {
  let loadingTask = null;

  try {
    const startTime = Date.now();

    const loaded = await loadPdf(pdfPath);

    const pdf = loaded.pdf;
    loadingTask = loaded.loadingTask;

    console.log("======================================");
    console.log("📚 BULK MERGED PDF EXTRACTION");
    console.log("======================================");
    console.log(`📑 Total Pages: ${pdf.numPages}`);
    console.log(`⚙️ Page Workers: ${PAGE_CONCURRENCY}`);

    const pageNumbers = Array.from(
      { length: pdf.numPages },
      (_, index) => index + 1
    );

    /*
     * Process multiple pages concurrently.
     *
     * Important:
     * We do NOT use Promise.all() for hundreds/thousands
     * of pages at once. That can spike RAM.
     */

    const pageResults = await mapWithConcurrency(
      pageNumbers,
      PAGE_CONCURRENCY,
      async (pageNo) => {
        const pageText = await extractPageText(
          pdf,
          pageNo
        );

        if (!pageText) {
          return null;
        }

        const details = extractDetailsFromText(
          pageText
        );

        /*
         * Roll is the mandatory student identifier.
         */

        if (!details.roll) {
          if (DEBUG) {
            debug(
              `⚠️ Page ${pageNo}/${pdf.numPages}: Roll not found`
            );
          }

          return null;
        }

        if (DEBUG) {
          debug(
            `✅ Page ${pageNo}/${pdf.numPages} → ${maskRoll(
              details.roll
            )}`
          );
        }

        return details;
      }
    );

    const results = pageResults.filter(
      (item) => item && !item.error
    );

    /*
     * =====================================================
     * DEDUPLICATION
     * =====================================================
     */

    const uniqueMap = new Map();

    for (const result of results) {
      const key = [
        result.session || "",
        result.examType || "",
        result.course || "",
        result.roll || "",
        result.semester || "",
      ]
        .join("|||")
        .toUpperCase();

      const existing = uniqueMap.get(key);

      if (!existing) {
        uniqueMap.set(key, result);
        continue;
      }

      /*
       * Merge missing fields from duplicate result.
       */

      for (const [field, value] of Object.entries(result)) {
        const existingValue = existing[field];

        if (
          (existingValue === null ||
            existingValue === undefined ||
            existingValue === "") &&
          value !== null &&
          value !== undefined &&
          value !== ""
        ) {
          existing[field] = value;
        }
      }
    }

    const uniqueResults = Array.from(
      uniqueMap.values()
    );

    const elapsed = Date.now() - startTime;

    console.log("======================================");
    console.log("📊 BULK EXTRACTION COMPLETE");
    console.log("======================================");
    console.log(`📑 Pages scanned: ${pdf.numPages}`);
    console.log(`👨‍🎓 Valid results: ${results.length}`);
    console.log(`♻️ Unique students: ${uniqueResults.length}`);
    console.log(`⏱️ Extraction time: ${elapsed} ms`);
    console.log("======================================");

    return uniqueResults;
  } catch (error) {
    console.error(
      "❌ Merged PDF extraction failed:",
      error.message
    );

    return [];
  } finally {
    try {
      if (loadingTask) {
        await loadingTask.destroy();
      }
    } catch (_) {}
  }
}

/*
 * =========================================================
 * HTML ESCAPE
 * =========================================================
 */

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/*
 * =========================================================
 * TELEGRAM CAPTION
 * =========================================================
 */

function buildResultCaption(
  details,
  state,
  fallbackRoll
) {
  const name =
    details?.name || "Not Available";

  const roll =
    details?.roll ||
    fallbackRoll ||
    "Not Available";

  const sgpa =
    details?.sgpa ||
    "Not Available";

  const remarks =
    details?.remarks ||
    "Not Available";

  return [
    "🎓 <b>Patliputra University Result</b>",
    "",
    `👤 <b>Student Name:</b> ${escapeHtml(name)}`,
    `🧾 <b>Roll No:</b> <code>${escapeHtml(roll)}</code>`,
    `📊 <b>SGPA:</b> ${escapeHtml(sgpa)}`,
    `📝 <b>Remarks:</b> ${escapeHtml(remarks)}`,
    "",
  ].join("\n");
}

/*
 * =========================================================
 * EXPORTS
 * =========================================================
 */

module.exports = {
  maskRoll,

  extractResultDetails,

  extractResultsFromMergedPdf,

  buildResultCaption,

  extractStudentName,

  extractFatherName,

  extractMotherName,

  extractRollNumber,

  extractEnrollmentNumber,

  extractCollegeName,

  extractCollegeCode,

  extractSession,

  extractExamType,

  extractCourse,

  extractSemester,

  extractMajorPaper,

  extractSGPA,

  extractCGPA,

  extractRemarks,

  extractTotalEarnCredits,

  extractResultDate,
};

/*
 * =========================================================
 * CLI DEBUG
 *
 *   node result-details.js <file.pdf>
 *   node result-details.js <https://...pdf>
 *   node result-details.js --url <session> <exam> <course> <roll>
 *       e.g. node result-details.js --url YEAR-2026 UG "BA(SEM-IV)" 2520641060001
 *
 * PDF ka text aur nikle hue fields dikhata hai. Naam, father, mother,
 * enrollment aur roll output mein [NAME] / [FATHER] ... se chhupa diye jaate hain.
 * =========================================================
 */

if (require.main === module) {
  (async () => {
    const os = require("os");
    const path = require("path");

    const args = process.argv.slice(2);

    let target = args[0];

    if (!target) {
      console.log(
        "Usage:\n" +
          '  node result-details.js C:\\path\\to\\file.pdf\n' +
          "  node result-details.js https://.../file.pdf\n" +
          '  node result-details.js --url YEAR-2026 UG "BA(SEM-IV)" 2520641060001'
      );
      process.exit(1);
    }

    if (target === "--url") {
      const [, session, exam, course, roll] = args;

      if (!session || !exam || !course || !roll) {
        console.log('Usage: node result-details.js --url <session> <exam> <course> <roll>');
        process.exit(1);
      }

      target =
        "https://lu.indiaexaminfo.co.in/PATLIPUTRA/" +
        [session, exam, course, roll].map(encodeURIComponent).join("/") +
        ".pdf";
    }

    let filePath = target;

    if (/^https?:\/\//i.test(target)) {
      console.log("Downloading:", target.replace(/\d{9}(\d{4})\.pdf/, "*********$1.pdf"));

      const response = await fetch(target);

      if (!response.ok) {
        throw new Error(`Download failed: HTTP ${response.status}`);
      }

      filePath = path.join(os.tmpdir(), "result-details-debug.pdf");

      await fs.promises.writeFile(filePath, Buffer.from(await response.arrayBuffer()));
    }

    const loaded = await loadPdf(filePath);

    let text = "";

    for (let i = 1; i <= Math.min(loaded.pdf.numPages, 3); i++) {
      text += " " + (await extractPageText(loaded.pdf, i));
    }

    text = normalizePdfText(text);

    const details = extractDetailsFromText(text, false);

    const hide = (value, label) => {
      if (value && String(value).length > 2) {
        text = text.split(String(value)).join(label);
      }
    };

    hide(details.name, "[NAME]");
    hide(details.fatherName, "[FATHER]");
    hide(details.motherName, "[MOTHER]");
    hide(details.enrollmentNo, "[ENROLL]");
    hide(details.roll, "[ROLL]");

    console.log("TEXT (first 2500 chars):\n" + text.slice(0, 2500));
    console.log("\nFIELDS:");
    console.log(
      JSON.stringify(
        {
          ...details,
          name: details.name ? "[NAME]" : null,
          fatherName: details.fatherName ? "[FATHER]" : null,
          motherName: details.motherName ? "[MOTHER]" : null,
          enrollmentNo: details.enrollmentNo ? "[ENROLL]" : null,
          roll: details.roll ? maskRoll(details.roll) : null,
        },
        null,
        2
      )
    );

    await loaded.loadingTask.destroy();
  })().catch((error) => {
    console.error("❌", error.message);
    process.exit(1);
  });
}