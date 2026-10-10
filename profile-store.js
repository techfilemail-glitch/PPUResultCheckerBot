const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/*
=========================================================
STUDENT PROFILE STORE (JSON file)

- One Telegram ID -> one profile
- One roll number -> maximum 5 Telegram accounts
=========================================================
*/

const DB_FILE = process.env.PROFILE_DB
  ? path.resolve(process.env.PROFILE_DB)
  : path.join(__dirname, "profiles.json");

let profiles = {}; // key: telegramId (string)

/*
/delprofile ke baad bhi roll-change limit bypass na ho.
Sirf rollChanges + rollHash store hota hai.
*/
const LEDGER_FILE = process.env.PROFILE_LEDGER_DB
  ? path.resolve(process.env.PROFILE_LEDGER_DB)
  : path.join(__dirname, "profile-ledger.json");

let ledger = {};

const MAX_ACCOUNTS_PER_ROLL = 5;

function hashRoll(roll) {
  return crypto
    .createHash("sha256")
    .update(`ppu-roll:${String(roll || "").trim()}`)
    .digest("hex")
    .slice(0, 24);
}

function load() {
  try {
    try {
      if (fs.existsSync(LEDGER_FILE)) {
        const l = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8"));

        if (l && typeof l === "object" && !Array.isArray(l)) {
          ledger = l;
        }
      }
    } catch (_) {}

    if (!fs.existsSync(DB_FILE)) {
      return;
    }

    const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      profiles = parsed;
    }

    require("./logger").debug(
      `Profiles loaded: ${Object.keys(profiles).length}`
    );
  } catch (error) {
    console.error("⚠️ Profile DB load failed:", error.message);
  }
}

let writeChain = Promise.resolve();

function persist() {
  writeChain = writeChain
    .then(async () => {
      const tmp = DB_FILE + ".tmp";

      await fs.promises.writeFile(
        tmp,
        JSON.stringify(profiles, null, 2),
        "utf8"
      );

      await fs.promises.rename(tmp, DB_FILE);
    })
    .catch((error) => {
      console.error("⚠️ Profile DB save failed:", error.message);
    });

  return writeChain;
}

let ledgerChain = Promise.resolve();

function persistLedger() {
  ledgerChain = ledgerChain
    .then(async () => {
      const tmp = LEDGER_FILE + ".tmp";

      await fs.promises.writeFile(
        tmp,
        JSON.stringify(ledger, null, 2),
        "utf8"
      );

      await fs.promises.rename(tmp, LEDGER_FILE);
    })
    .catch((error) => {
      console.error(
        "⚠️ Profile ledger save failed:",
        error.message
      );
    });

  return ledgerChain;
}

function getLedger(telegramId) {
  return ledger[String(telegramId)] || null;
}

function clearLedger(telegramId) {
  const key = String(telegramId);

  if (ledger[key]) {
    delete ledger[key];
    return persistLedger();
  }

  return Promise.resolve();
}

// User ka /delprofile:
// sirf us Telegram account ki profile delete hoti hai.
async function removeSelf(telegramId) {
  const key = String(telegramId);
  const profile = profiles[key];

  if (!profile) {
    return null;
  }

  const rollChanges = Number(profile.rollChanges || 0);

  delete profiles[key];

  ledger[key] = {
    rollChanges,
    rollHash: hashRoll(profile.roll),
  };

  await Promise.all([
    persist(),
    persistLedger(),
  ]);

  return profile;
}

function getByTelegramId(telegramId) {
  return profiles[String(telegramId)] || null;
}

/*
=========================================================
ROLL ACCOUNT HELPERS
=========================================================
*/

/*
Same roll se linked saare Telegram accounts.
*/
function getProfilesByRoll(roll) {
  const target = String(roll || "").trim();

  if (!target) {
    return [];
  }

  return Object.values(profiles).filter(
    (profile) =>
      String(profile.roll || "").trim() === target
  );
}

/*
Number of Telegram accounts currently linked to roll.
*/
function countByRoll(roll) {
  return getProfilesByRoll(roll).length;
}

/*
Check whether this particular Telegram account is already
linked to the roll.
*/
function isTelegramLinkedToRoll(telegramId, roll) {
  const telegramKey = String(telegramId);
  const target = String(roll || "").trim();

  const profile = profiles[telegramKey];

  return Boolean(
    profile &&
    String(profile.roll || "").trim() === target
  );
}

/*
Check whether another Telegram account can use this roll.

Important:
- Existing same Telegram ID -> allowed
- New Telegram ID -> allowed until account limit
*/
function canLinkRoll(telegramId, roll) {
  const telegramKey = String(telegramId);
  const target = String(roll || "").trim();

  if (!target) {
    return {
      allowed: false,
      reason: "invalid_roll",
    };
  }

  const ownProfile = profiles[telegramKey];

  // Same account already has this roll.
  if (
    ownProfile &&
    String(ownProfile.roll || "").trim() === target
  ) {
    return {
      allowed: true,
      existing: true,
    };
  }

  const linkedProfiles = getProfilesByRoll(target);

  const linkedToAnotherAccount = linkedProfiles.some(
    (profile) =>
      String(profile.telegramId) !== telegramKey
  );

  if (
    linkedToAnotherAccount &&
    linkedProfiles.length >= MAX_ACCOUNTS_PER_ROLL
  ) {
    return {
      allowed: false,
      reason: "limit",
    };
  }

  return {
    allowed: true,
    existing: false,
  };
}

/*
Backward-compatible getByRoll():

Purane code ko ek profile object hi milega.
Ab same roll multiple accounts se linked ho sakta hai,
isliye first matching profile return hota hai.
*/
function getByRoll(roll) {
  const profilesForRoll = getProfilesByRoll(roll);

  return profilesForRoll.length
    ? profilesForRoll[0]
    : null;
}

function save(profile) {
  profile.updatedAt = new Date().toISOString();

  profiles[String(profile.telegramId)] = profile;

  return persist();
}

function remove(telegramId) {
  delete profiles[String(telegramId)];

  return persist();
}

function list() {
  return Object.values(profiles);
}

load();

module.exports = {
  getByTelegramId,
  getByRoll,
  getProfilesByRoll,
  countByRoll,
  isTelegramLinkedToRoll,
  canLinkRoll,
  save,
  remove,
  removeSelf,
  getLedger,
  clearLedger,
  hashRoll,
  list,
  MAX_ACCOUNTS_PER_ROLL,
};