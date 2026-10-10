"use strict";

require("dotenv").config();

const fs = require("fs");
const {
  initializeArchive,
  getArchiveStatus,
  archiveIndividualPdf,
} = require("./pdf-archive");

(async () => {
  try {
    console.log("☁️ MEGA test starting...");
    console.log(getArchiveStatus());

    await initializeArchive();

    const testPdf = Buffer.from(
      "%PDF-1.4\n" +
      "1 0 obj\n" +
      "<< /Type /Catalog >>\n" +
      "endobj\n" +
      "%%EOF\n"
    );

    const result = await archiveIndividualPdf({
      buffer: testPdf,
      roll: "2520641060001",
      session: "2024-28",
      examType: "SEM-I",
      course: "BA",
      semester: "SEM-I",
    });

    console.log("✅ MEGA upload result:");
    console.log(result);
  } catch (error) {
    console.error("❌ MEGA test failed:");
    console.error(error);
    process.exitCode = 1;
  }
})();