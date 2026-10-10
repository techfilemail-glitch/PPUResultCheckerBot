/*
Chhota logger: normal run mein sirf zaroori cheezein dikhti hain.
Detail logs ke liye .env mein DEBUG_LOGS=1 rakho.
*/
const DEBUG = process.env.DEBUG_LOGS === "1";

module.exports = {
  DEBUG,
  debug: (...args) => {
    if (DEBUG) console.log(...args);
  },
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};