"use strict";

require("dotenv").config();

const Mega = require("megajs");

console.log("Email:", process.env.MEGA_EMAIL);
console.log(
  "Password loaded:",
  Boolean(process.env.MEGA_PASSWORD)
);

const account = new Mega({
  email: process.env.MEGA_EMAIL,
  password: process.env.MEGA_PASSWORD,
});

account.ready
  .then(() => {
    console.log("✅ MEGA LOGIN SUCCESS");
    console.log("Name:", account.name || "-");
    console.log("Email:", account.email || "-");
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ MEGA LOGIN FAILED");
    console.error(error);
    process.exit(1);
  });