"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Mega = require("megajs");

const MEGA_EMAIL = String(
  process.env.MEGA_EMAIL || ""
).trim();

const MEGA_PASSWORD = String(
  process.env.MEGA_PASSWORD || ""
).trim();

const MEGA_ARCHIVE_ROOT = String(
  process.env.MEGA_ARCHIVE_ROOT || "PPU-ARCHIVE"
).trim();

const LOCKER_FOLDER = "LOCKER";
const INDIVIDUAL_FOLDER = "INDIVIDUAL PDF";

const LOCKER_MAX_PDFS = Math.max(
  1,
  Number(process.env.LOCKER_ARCHIVE_MAX_PDFS || 10)
);

// Folder listing cache (MEGA loadAttributes() har lookup par nahi chalega)
const FOLDER_INDEX_TTL = 30 * 1000;

// Ek MEGA file download ka max time
const DOWNLOAD_TIMEOUT = 45 * 1000;

let storage = null;
let rootFolder = null;
let lockerRoot = null;
let individualFolder = null;

let initPromise = null;

const individualCache = new Map();
const lockerCache = new Map();

// folder object -> { map, time, pending }
const folderIndexes = new WeakMap();

function clean(value) {
  if (
    value === undefined ||
    value === null
  ) {
    return "";
  }

  return String(value)
    .replace(/\s+/g, " ")
    .trim();
}

function safeName(value) {
  return (
    clean(value)
      .replace(/[\\/:*?"<>|#%{}[\]^`]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "") ||
    "UNKNOWN"
  );
}

function safeFolderName(value) {
  return (
    clean(value)
      .replace(/[\\/:*?"<>|#%{}\[\]^`]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 150) || "UNKNOWN"
  );
}

function normalizeRoll(roll) {
  return clean(roll).replace(/\D/g, "");
}

function normalizeKeyPart(value) {
  return safeName(
    clean(value)
      .toUpperCase()
      .replace(/[–—]/g, "-")
  );
}

function makeArchiveKey({
  roll,
  session,
  examType,
  course,
  semester,
} = {}) {
  return [
    normalizeKeyPart(session),
    normalizeKeyPart(examType),
    normalizeKeyPart(course),
    normalizeKeyPart(roll),
    normalizeKeyPart(semester),
  ].join("__");
}

function makeArchiveFilename({
  roll,
  session,
  examType,
  course,
  semester,
} = {}) {
  const key = makeArchiveKey({
    roll,
    session,
    examType,
    course,
    semester,
  });

  return `${key}.pdf`;
}

function makeLockerFilename({
  roll,
  session,
  examType,
  course,
  semester,
  label,
} = {}) {
  const rollPart = normalizeRoll(roll) || "UNKNOWN";

  const labelPart =
    safeName(label) ||
    [
      session,
      examType,
      course,
      semester,
    ]
      .filter(Boolean)
      .map(safeName)
      .join("_") ||
    "RESULT";

  return `${rollPart}_${labelPart}.pdf`;
}

function bufferToStream(buffer) {
  const { Readable } = require("stream");
  return Readable.from([buffer]);
}

function isValidPdfBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    return false;
  }

  if (buffer.length < 5) {
    return false;
  }

  return buffer.subarray(0, 5).toString() === "%PDF-";
}

function isArchiveConfigured() {
  return Boolean(
    MEGA_EMAIL &&
      MEGA_PASSWORD
  );
}

async function loginMega() {
  if (!isArchiveConfigured()) {
    throw new Error(
      "MEGA_EMAIL or MEGA_PASSWORD is missing"
    );
  }

  console.log(
    "☁️ Connecting to MEGA..."
  );

  const mega = await new Promise(
    (resolve, reject) => {
      const account = new Mega({
        email: MEGA_EMAIL,
        password: MEGA_PASSWORD,
      });

      account.ready
        .then(() => resolve(account))
        .catch(reject);
    }
  );

  storage = mega;

  console.log(
    "✅ MEGA connected"
  );

  return storage;
}

function findChild(parent, name) {
  if (!parent) {
    return null;
  }

  const children = parent.children || [];

  const target = String(name);

  return (
    children.find(
      (item) =>
        item &&
        item.name === target
    ) || null
  );
}

async function getOrCreateFolder(
  parent,
  name
) {
  const existing = findChild(
    parent,
    name
  );

  if (existing) {
    return existing;
  }

  console.log(
    `📁 Creating MEGA folder: ${name}`
  );

  return await parent.mkdir(name);
}

async function initializeArchive() {
  if (
    rootFolder &&
    lockerRoot &&
    individualFolder
  ) {
    return {
      ready: true,
      rootFolder,
      lockerRoot,
      individualFolder,
    };
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    await loginMega();

    const root = storage.root;

    rootFolder =
      await getOrCreateFolder(
        root,
        MEGA_ARCHIVE_ROOT
      );

    lockerRoot =
      await getOrCreateFolder(
        rootFolder,
        LOCKER_FOLDER
      );

    individualFolder =
      await getOrCreateFolder(
        rootFolder,
        INDIVIDUAL_FOLDER
      );

    console.log(
      `📦 MEGA archive ready: ${MEGA_ARCHIVE_ROOT}`
    );

    return {
      ready: true,
      rootFolder,
      lockerRoot,
      individualFolder,
    };
  })();

  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

async function getLockerFolder(
  roll,
  studentName = "",
  createIfMissing = true
) {
  const normalizedRoll = normalizeRoll(roll);

  if (!normalizedRoll) {
    throw new Error("Locker roll number is missing");
  }

  await initializeArchive();

  if (lockerCache.has(normalizedRoll)) {
    return lockerCache.get(normalizedRoll);
  }

  const children = await listChildren(lockerRoot);

  // Existing folder ko SIRF roll number se identify karo.
  let folder = children.find(
    (item) =>
      item &&
      typeof item.name === "string" &&
      (
        item.name === normalizedRoll ||
        item.name.startsWith(`${normalizedRoll} - `)
      )
  );

  // Lookup ke waqt folder create nahi karna.
  if (!folder && !createIfMissing) {
    return null;
  }

  // Sirf archive/upload ke waqt naya named folder create hoga.
  if (!folder) {
    const folderName = studentName
      ? `${normalizedRoll} - ${safeFolderName(studentName)}`
      : normalizedRoll;

    console.log(`📁 Creating MEGA folder: ${folderName}`);
    folder = await lockerRoot.mkdir(folderName);
  }

  lockerCache.set(normalizedRoll, folder);

  return folder;
}


async function listChildren(
  folder
) {
  if (!folder) {
    return [];
  }

  try {
    await folder.loadAttributes();
  } catch (_) {}

  return Array.isArray(
    folder.children
  )
    ? folder.children
    : [];
}

/*
 * Folder ke files ka name -> file index (cached).
 *
 * Pehle har findFile() par folder.loadAttributes() (network call)
 * chalta tha. Bulk mein 200 rolls x 15 workers par ye bahut slow
 * tha. Ab listing FOLDER_INDEX_TTL tak cache hoti hai, parallel
 * refresh ek hi baar hota hai, aur upload ke baad index update hota hai.
 */
async function getFolderIndex(
  folder
) {
  if (!folder) {
    return new Map();
  }

  let entry =
    folderIndexes.get(folder);

  if (!entry) {
    entry = {
      map: null,
      time: 0,
      pending: null,
    };

    folderIndexes.set(
      folder,
      entry
    );
  }

  if (entry.pending) {
    return entry.pending;
  }

  if (
    entry.map &&
    Date.now() - entry.time <
      FOLDER_INDEX_TTL
  ) {
    return entry.map;
  }

  entry.pending = (async () => {
    const children =
      await listChildren(folder);

    const map = new Map();

    for (const item of children) {
      if (
        item &&
        typeof item.name ===
          "string" &&
        typeof item.download ===
          "function"
      ) {
        map.set(item.name, item);
      }
    }

    entry.map = map;
    entry.time = Date.now();

    return map;
  })().finally(() => {
    entry.pending = null;
  });

  return entry.pending;
}

function rememberFile(
  folder,
  filename,
  file
) {
  const entry =
    folderIndexes.get(folder);

  if (
    entry &&
    entry.map &&
    file
  ) {
    entry.map.set(filename, file);
  }
}

async function findFile(
  folder,
  filename
) {
  const index =
    await getFolderIndex(folder);

  return (
    index.get(filename) || null
  );
}

async function uploadBuffer(
  folder,
  filename,
  buffer
) {
  if (!isValidPdfBuffer(buffer)) {
    throw new Error(
      `Invalid PDF buffer: ${filename}`
    );
  }

  const existing =
    await findFile(
      folder,
      filename
    );

  if (existing) {
    console.log(
      `♻️ MEGA already exists: ${filename}`
    );

    return {
      uploaded: false,
      existed: true,
      file: existing,
      filename,
    };
  }

  console.log(
    `⬆️ MEGA uploading: ${filename}`
  );

  const upload = folder.upload(
    {
      name: filename,
      size: buffer.length,
    },
    buffer
  );

  const file = await upload.complete;

  rememberFile(
    folder,
    filename,
    file
  );

  console.log(
    `✅ MEGA uploaded: ${filename}`
  );

  return {
    uploaded: true,
    existed: false,
    file,
    filename,
  };
}

async function streamToBuffer(
  stream
) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(
      Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk)
    );
  }

  return Buffer.concat(chunks);
}

/*
 * megajs ka file.download() STREAM (Pumpify) return karta hai,
 * Buffer nahi. Pehle code usi stream par Buffer.from() chala
 * deta tha -> "Received an instance of Pumpify". Ab stream ko
 * collect karke Buffer banate hain (aur promise/Buffer dono
 * forms bhi handle hote hain).
 */
async function downloadFile(
  file
) {
  if (
    !file ||
    typeof file.download !==
      "function"
  ) {
    throw new Error(
      "Invalid MEGA file"
    );
  }

  console.log(
    `⬇️ MEGA downloading: ${file.name}`
  );

  const work = (async () => {
    let data = file.download();

    if (
      data &&
      typeof data.then ===
        "function"
    ) {
      data = await data;
    }

    if (Buffer.isBuffer(data)) {
      return data;
    }

    if (
      data &&
      (typeof data[
        Symbol.asyncIterator
      ] === "function" ||
        typeof data.pipe ===
          "function")
    ) {
      return await streamToBuffer(
        data
      );
    }

    return Buffer.from(data);
  })();

  let timer = null;

  const timeout = new Promise(
    (_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `MEGA download timeout: ${file.name}`
            )
          ),
        DOWNLOAD_TIMEOUT
      );
    }
  );

  let buffer;

  try {
    buffer = await Promise.race([
      work,
      timeout,
    ]);
  } finally {
    clearTimeout(timer);

    // timeout jeet jaye to work ka late error unhandled na ho
    work.catch(() => {});
  }

  if (!isValidPdfBuffer(buffer)) {
    throw new Error(
      `Downloaded MEGA file is not a valid PDF: ${file.name}`
    );
  }

  return buffer;
}

async function archiveIndividualPdf({
  buffer,
  roll,
  session,
  examType,
  course,
  semester,
  filename,
} = {}) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error(
      "archiveIndividualPdf requires a Buffer"
    );
  }

  const normalizedRoll =
    normalizeRoll(roll);

  if (!normalizedRoll) {
    throw new Error(
      "archiveIndividualPdf: roll number is missing"
    );
  }

  await initializeArchive();

  const finalFilename =
    filename ||
    makeArchiveFilename({
      roll: normalizedRoll,
      session,
      examType,
      course,
      semester,
    });

  const existing =
    await findFile(
      individualFolder,
      finalFilename
    );

  if (existing) {
    console.log(
      `♻️ Individual archive exists: ${finalFilename}`
    );

    return {
      ok: true,
      uploaded: false,
      existed: true,
      filename: finalFilename,
      file: existing,
    };
  }

  return await uploadBuffer(
    individualFolder,
    finalFilename,
    buffer
  ).then((result) => ({
    ...result,
    ok: true,
  }));
}

async function findIndividualPdf({
  roll,
  session,
  examType,
  course,
  semester,
  filename,
} = {}) {
  const normalizedRoll =
    normalizeRoll(roll);

  if (!normalizedRoll) {
    return null;
  }

  await initializeArchive();

  const finalFilename =
    filename ||
    makeArchiveFilename({
      roll: normalizedRoll,
      session,
      examType,
      course,
      semester,
    });

  return await findFile(
    individualFolder,
    finalFilename
  );
}

async function getIndividualPdf({
  roll,
  session,
  examType,
  course,
  semester,
  filename,
} = {}) {
  const file =
    await findIndividualPdf({
      roll,
      session,
      examType,
      course,
      semester,
      filename,
    });

  if (!file) {
    return null;
  }

  return await downloadFile(
    file
  );
}

async function listLockerPdfs(
  roll
) {
  const folder =
  await getLockerFolder(
    roll,
    "",
    false
  );

  const children =
    await listChildren(folder);

  return children.filter(
    (item) =>
      item &&
      /\.pdf$/i.test(
        String(item.name || "")
      ) &&
      typeof item.download ===
        "function"
  );
}

async function archiveLockerPdf({
  buffer,
  roll,
  studentName,
  session,
  examType,
  course,
  semester,
  label,
  filename,
} = {}) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error(
      "archiveLockerPdf requires a Buffer"
    );
  }

  const normalizedRoll =
    normalizeRoll(roll);

  if (!normalizedRoll) {
    throw new Error(
      "archiveLockerPdf: roll number is missing"
    );
  }

  const folder =
  await getLockerFolder(
    normalizedRoll,
    studentName,
    true
  );

  const finalFilename =
    filename ||
    makeLockerFilename({
      roll: normalizedRoll,
      session,
      examType,
      course,
      semester,
      label,
    });

  const existing =
    await findFile(
      folder,
      finalFilename
    );

  if (existing) {
    console.log(
      `♻️ Locker archive exists: ${normalizedRoll}/${finalFilename}`
    );

    return {
      ok: true,
      uploaded: false,
      existed: true,
      filename: finalFilename,
      file: existing,
    };
  }

  const existingPdfs =
    await listLockerPdfs(
      normalizedRoll
    );

  if (
    existingPdfs.length >=
    LOCKER_MAX_PDFS
  ) {
    console.warn(
      `⚠️ Locker archive limit reached for ${normalizedRoll}: ${LOCKER_MAX_PDFS}`
    );

    return {
      ok: false,
      uploaded: false,
      limitReached: true,
      filename: finalFilename,
      limit: LOCKER_MAX_PDFS,
    };
  }

  const result =
    await uploadBuffer(
      folder,
      finalFilename,
      buffer
    );

  return {
    ...result,
    ok: true,
    roll: normalizedRoll,
  };
}

async function findLockerPdf({
  roll,
  session,
  examType,
  course,
  semester,
  label,
  filename,
} = {}) {
  const normalizedRoll =
    normalizeRoll(roll);

  if (!normalizedRoll) {
    return null;
  }

  // Lookup ke waqt khali locker folder create nahi hona chahiye.
  const folder =
    await getLockerFolder(
      normalizedRoll,
      "",
      false
    );

  if (!folder) {
    return null;
  }

  const finalFilename =
    filename ||
    makeLockerFilename({
      roll: normalizedRoll,
      session,
      examType,
      course,
      semester,
      label,
    });

  return await findFile(
    folder,
    finalFilename
  );
}

async function getLockerPdf(
  options = {}
) {
  const file =
    await findLockerPdf(
      options
    );

  if (!file) {
    return null;
  }

  return await downloadFile(
    file
  );
}

async function getOrArchiveIndividualPdf({
  roll,
  session,
  examType,
  course,
  semester,
  filename,
  downloadFn,
} = {}) {
  const existing =
    await findIndividualPdf({
      roll,
      session,
      examType,
      course,
      semester,
      filename,
    });

  if (existing) {
    console.log(
      `♻️ Using archived PDF: ${existing.name}`
    );

    const buffer =
      await downloadFile(
        existing
      );

    return {
      source: "mega",
      downloadedFromPortal: false,
      archived: true,
      file: existing,
      buffer,
    };
  }

  if (
    typeof downloadFn !==
    "function"
  ) {
    throw new Error(
      "PDF not archived and downloadFn is missing"
    );
  }

  const buffer =
    await downloadFn();

  if (!isValidPdfBuffer(buffer)) {
    throw new Error(
      "Portal returned an invalid PDF"
    );
  }

  const archived =
    await archiveIndividualPdf({
      buffer: Buffer.from(buffer),
      roll,
      session,
      examType,
      course,
      semester,
      filename,
    });

  return {
    source: "portal",
    downloadedFromPortal: true,
    archived: Boolean(
      archived?.ok
    ),
    file:
      archived?.file || null,
    buffer,
  };
}

async function getOrArchiveLockerPdf({
  roll,
  session,
  examType,
  course,
  semester,
  label,
  filename,
  downloadFn,
} = {}) {
  const existing =
    await findLockerPdf({
      roll,
      session,
      examType,
      course,
      semester,
      label,
      filename,
    });

  if (existing) {
    console.log(
      `♻️ Using locker archived PDF: ${existing.name}`
    );

    const buffer =
      await downloadFile(
        existing
      );

    return {
      source: "locker-mega",
      downloadedFromPortal: false,
      archived: true,
      file: existing,
      buffer,
    };
  }

  const central =
    await findIndividualPdf({
      roll,
      session,
      examType,
      course,
      semester,
    });

  if (central) {
    console.log(
      `♻️ Locker reusing central archive: ${central.name}`
    );

    const buffer =
      await downloadFile(
        central
      );

    const locker =
      await archiveLockerPdf({
        buffer: Buffer.from(buffer),
        roll,
        session,
        examType,
        course,
        semester,
        label,
        filename,
      });

    return {
      source: "individual-mega",
      downloadedFromPortal: false,
      archived: Boolean(
        locker?.ok
      ),
      file:
        locker?.file || null,
      buffer,
    };
  }

  if (
    typeof downloadFn !==
    "function"
  ) {
    throw new Error(
      "PDF not archived and downloadFn is missing"
    );
  }

  const buffer =
    await downloadFn();

  if (!isValidPdfBuffer(buffer)) {
    throw new Error(
      "Portal returned an invalid PDF"
    );
  }


  const locker =
    await archiveLockerPdf({
      buffer: Buffer.from(buffer),
      roll,
      session,
      examType,
      course,
      semester,
      label,
      filename,
    });

  return {
    source: "portal",
    downloadedFromPortal: true,
    archived:
      Boolean(locker?.ok),
    file:
      locker?.file ||
      null,
    buffer,
  };
}

function getArchiveStatus() {
  return {
    configured:
      isArchiveConfigured(),
    initialized:
      Boolean(
        rootFolder &&
          lockerRoot &&
          individualFolder
      ),
    root:
      MEGA_ARCHIVE_ROOT,
    lockerFolder:
      LOCKER_FOLDER,
    individualFolder:
      INDIVIDUAL_FOLDER,
    lockerMaxPdfs:
      LOCKER_MAX_PDFS,
  };
}

module.exports = {
  initializeArchive,
  isArchiveConfigured,
  getArchiveStatus,

  makeArchiveKey,
  makeArchiveFilename,
  makeLockerFilename,

  archiveIndividualPdf,
  findIndividualPdf,
  getIndividualPdf,

  archiveLockerPdf,
  findLockerPdf,
  getLockerPdf,
  listLockerPdfs,

  getOrArchiveIndividualPdf,
  getOrArchiveLockerPdf,
};