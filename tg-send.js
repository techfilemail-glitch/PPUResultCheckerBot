const fs = require("fs");
const path = require("path");
const os = require("os");
const { PDFDocument } = require("pdf-lib");

const MAX_BYTES = 45 * 1024 * 1024; // Telegram bot upload limit is 50MB
const SEND_TIMEOUT = 180000;
const RETRIES = 3;

function withTimeout(promise, ms) {
  let timer;

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Telegram send timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Split a big PDF into parts below MAX_BYTES (by pages).
async function splitPdf(filePath, fileName) {
  const source = await PDFDocument.load(await fs.promises.readFile(filePath), {
    ignoreEncryption: true,
  });

  const total = source.getPageCount();
  const size = (await fs.promises.stat(filePath)).size;
  const parts = Math.max(2, Math.ceil(size / (MAX_BYTES * 0.8)));
  const perPart = Math.ceil(total / parts);

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tg-split-"));
  const base = fileName.replace(/\.pdf$/i, "");
  const out = [];

  for (let i = 0; i < total; i += perPart) {
    const doc = await PDFDocument.create();
    const idx = [];

    for (let p = i; p < Math.min(i + perPart, total); p++) idx.push(p);

    for (const page of await doc.copyPages(source, idx)) doc.addPage(page);

    const partName = `${base}_part${out.length + 1}.pdf`;
    const partPath = path.join(dir, partName);

    await fs.promises.writeFile(partPath, await doc.save());

    out.push({ filePath: partPath, fileName: partName });
  }

  return { files: out, dir };
}

function createSender(bot) {
  async function sendOne(chatId, filePath, fileName) {
    let lastError;

    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        await withTimeout(
          bot.sendDocument(
            chatId,
            fs.createReadStream(filePath),
            {},
            { filename: fileName, contentType: "application/pdf" }
          ),
          SEND_TIMEOUT
        );

        return true;
      } catch (error) {
        lastError = error;

        const retryAfter = error?.response?.body?.parameters?.retry_after;

        await sleep(retryAfter ? retryAfter * 1000 + 500 : attempt * 2000);
      }
    }

    throw lastError;
  }

  async function sendFiles(chatId, files) {
    for (const f of files) {
      await sendOne(chatId, f.filePath, f.fileName);
    }
  }

  async function sendMergedPdf({
    destination,
    fallbackDestination,
    channelId,
    filePath,
    fileName,
  }) {
    let files = [{ filePath, fileName }];
    let splitDir = null;

    try {
      const { size } = await fs.promises.stat(filePath);

      if (size > MAX_BYTES) {
        const split = await splitPdf(filePath, fileName);

        files = split.files;
        splitDir = split.dir;
      }

      const result = { sent: false, channelSent: false, parts: files.length };

      // Main destination, then fallback chat.
      try {
        await sendFiles(destination, files);
        result.sent = true;
      } catch (error) {
        result.error = error.message;

        if (fallbackDestination && String(fallbackDestination) !== String(destination)) {
          try {
            await sendFiles(fallbackDestination, files);
            result.sent = true;
          } catch (e) {
            result.error = e.message;
          }
        }
      }

      // Channel copy (optional).
      if (
        channelId &&
        String(channelId) !== String(destination) &&
        String(channelId) !== String(fallbackDestination)
      ) {
        try {
          await sendFiles(channelId, files);
          result.channelSent = true;
        } catch (error) {
          result.channelError = error.message;
        }
      }

      return result;
    } finally {
      if (splitDir) {
        fs.promises.rm(splitDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  return { sendMergedPdf };
}

module.exports = { createSender };