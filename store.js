// Everything the app remembers lives in one IndexedDB record on this phone.
// With a passcode set, that record is encrypted with AES-GCM using a key
// derived from the passcode (PBKDF2); the passcode itself is never stored.

const DB_NAME = "confidant";
const STORE = "kv";
const PBKDF2_ITERATIONS = 310000;

let db;
let key = null; // CryptoKey while unlocked with a passcode

function idb() {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve((db = req.result));
    req.onerror = () => reject(req.error);
  });
}

async function get(k) {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const req = d.transaction(STORE).objectStore(STORE).get(k);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(entries) {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, "readwrite");
    const s = tx.objectStore(STORE);
    for (const [k, v] of Object.entries(entries)) s.put(v, k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deriveKey(passcode, salt) {
  const base = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passcode), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function encrypt(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { iv, ct: new Uint8Array(ct) };
}

async function decrypt(box) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: box.iv }, key, box.ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

export async function isLocked() {
  const meta = await get("meta");
  return Boolean(meta?.encrypted) && !key;
}

export async function hasPasscode() {
  return Boolean((await get("meta"))?.encrypted);
}

// Throws if the passcode is wrong.
export async function unlock(passcode) {
  const meta = await get("meta");
  const candidate = await deriveKey(passcode, meta.salt);
  const box = await get("data");
  const prev = key;
  key = candidate;
  try {
    await decrypt(box);
  } catch {
    key = prev;
    throw new Error("Wrong passcode");
  }
}

export function lock() {
  key = null;
}

export async function load() {
  const meta = await get("meta");
  const data = await get("data");
  if (!data) return null;
  return meta?.encrypted ? decrypt(data) : data;
}

export async function save(obj) {
  const meta = await get("meta");
  await put({ data: meta?.encrypted ? await encrypt(obj) : obj });
}

// Pass null to remove the passcode and store data unencrypted again.
export async function setPasscode(passcode, obj) {
  if (passcode) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    key = await deriveKey(passcode, salt);
    await put({ meta: { encrypted: true, salt }, data: await encrypt(obj) });
  } else {
    key = null;
    await put({ meta: { encrypted: false }, data: obj });
  }
}

export async function wipe() {
  key = null;
  db?.close();
  db = null;
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}
