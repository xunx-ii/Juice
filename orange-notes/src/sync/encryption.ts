import type { RemoteEncryptionMeta, RemoteNotebookState } from "@/sync/protocol";

const STORAGE_KEY = "orange-notes-e2ee-settings";
const PAYLOAD_PREFIX = "orange-notes-e2ee:v1:";
const KEY_CHECK_TEXT = "orange-notes-key-check";
const MCP_KEY_CHECK_TEXT = "hello";
const DEFAULT_ITERATIONS = 310_000;

type EncryptionSettings = RemoteEncryptionMeta;
type StoredEncryptionSettings = EncryptionSettings & { updated_at?: number };

let activeKey: CryptoKey | null = null;
let activeKeyFingerprint = "";

export interface EncryptionStatus {
  enabled: boolean;
  keyReady: boolean;
  updatedAt: number | null;
}

export interface EncryptionStateSnapshot {
  settings: StoredEncryptionSettings | null;
  activeKey: CryptoKey | null;
  activeKeyFingerprint: string;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function randomBase64(size: number): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return encodeBase64(bytes);
}

function settingsFingerprint(settings: Pick<EncryptionSettings, "salt" | "iterations" | "key_check_iv" | "key_check">) {
  return `${settings.salt}:${settings.iterations}:${settings.key_check_iv}:${settings.key_check}`;
}

function loadSettings(): StoredEncryptionSettings | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<EncryptionSettings> & { updated_at?: number };
    if (!parsed.enabled || !parsed.salt || !parsed.key_check_iv || !parsed.key_check) return null;
    return {
      enabled: true,
      version: 1,
      algorithm: "AES-GCM",
      kdf: "PBKDF2-SHA256",
      salt: parsed.salt,
      iterations: parsed.iterations ?? DEFAULT_ITERATIONS,
      key_check_iv: parsed.key_check_iv,
      key_check: parsed.key_check,
      updated_at: parsed.updated_at,
    };
  } catch {
    return null;
  }
}

function saveSettings(settings: EncryptionSettings, updatedAt = Date.now()) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings, updated_at: updatedAt }));
}

async function deriveKey(passphrase: string, settings: Pick<EncryptionSettings, "salt" | "iterations">) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: bytesSource(decodeBase64(settings.salt)),
      iterations: settings.iterations,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptTextRaw(text: string, key: CryptoKey) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const plaintext = new TextEncoder().encode(text);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: bytesSource(iv) },
      key,
      bytesSource(plaintext)
    )
  );
  return { iv: encodeBase64(iv), ciphertext: encodeBase64(ciphertext) };
}

async function decryptTextRaw(iv: string, ciphertext: string, key: CryptoKey) {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytesSource(decodeBase64(iv)) },
    key,
    bytesSource(decodeBase64(ciphertext))
  );
  return new TextDecoder().decode(plaintext);
}

async function ensureKeyFor(settings: EncryptionSettings) {
  const fingerprint = settingsFingerprint(settings);
  if (!activeKey || activeKeyFingerprint !== fingerprint) {
    throw new Error("请先在设置中输入端对端密钥");
  }
  return activeKey;
}

async function verifyKey(key: CryptoKey, settings: Pick<EncryptionSettings, "key_check_iv" | "key_check">) {
  const text = await decryptTextRaw(settings.key_check_iv, settings.key_check, key);
  if (text !== KEY_CHECK_TEXT) throw new Error("端对端密钥不正确");
}

async function loadKey(passphrase: string, settings: EncryptionSettings) {
  const key = await deriveKey(passphrase, settings);
  await verifyKey(key, settings);
  activeKey = key;
  activeKeyFingerprint = settingsFingerprint(settings);
}

export function getEncryptionStatus(): EncryptionStatus {
  const settings = loadSettings();
  return {
    enabled: Boolean(settings?.enabled),
    keyReady: Boolean(settings && activeKeyFingerprint === settingsFingerprint(settings) && activeKey),
    updatedAt: settings?.updated_at ?? null,
  };
}

export function getLocalEncryptionMetadata(): RemoteEncryptionMeta | null {
  const settings = loadSettings();
  if (!settings?.enabled) return null;
  return {
    enabled: true,
    version: 1,
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA256",
    salt: settings.salt,
    iterations: settings.iterations,
    key_check_iv: settings.key_check_iv,
    key_check: settings.key_check,
  };
}

export function createEncryptionSnapshot(): EncryptionStateSnapshot {
  return {
    settings: loadSettings(),
    activeKey,
    activeKeyFingerprint,
  };
}

export function restoreEncryptionSnapshot(snapshot: EncryptionStateSnapshot) {
  if (snapshot.settings) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot.settings));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
  activeKey = snapshot.activeKey;
  activeKeyFingerprint = snapshot.activeKeyFingerprint;
}

export async function createRemoteKeyCheckPayload(): Promise<string> {
  const metadata = getLocalEncryptionMetadata();
  if (!metadata?.enabled) throw new Error("端到端加密尚未开启");
  const key = await ensureKeyFor(metadata);
  return encryptText(MCP_KEY_CHECK_TEXT, key);
}

export function cacheRemoteEncryptionMetadata(metadata?: RemoteEncryptionMeta | null) {
  if (!metadata?.enabled) return;
  saveSettings(metadata);
}

export async function enableEndToEndEncryption(passphrase: string) {
  const salt = randomBase64(16);
  const baseSettings = {
    enabled: true,
    version: 1,
    algorithm: "AES-GCM" as const,
    kdf: "PBKDF2-SHA256" as const,
    salt,
    iterations: DEFAULT_ITERATIONS,
  };
  const key = await deriveKey(passphrase, baseSettings);
  const check = await encryptTextRaw(KEY_CHECK_TEXT, key);
  const settings: EncryptionSettings = {
    ...baseSettings,
    key_check_iv: check.iv,
    key_check: check.ciphertext,
  };
  saveSettings(settings);
  activeKey = key;
  activeKeyFingerprint = settingsFingerprint(settings);
}

export async function unlockEndToEndEncryption(passphrase: string, metadata?: RemoteEncryptionMeta | null) {
  const settings = metadata ?? loadSettings();
  if (!settings?.enabled) throw new Error("端对端加密尚未开启");
  await loadKey(passphrase, settings);
  saveSettings(settings);
}

export async function updateEndToEndEncryptionKey(currentPassphrase: string, nextPassphrase: string) {
  const settings = loadSettings();
  if (!settings?.enabled) throw new Error("端对端加密尚未开启");
  await loadKey(currentPassphrase, settings);
  await enableEndToEndEncryption(nextPassphrase);
}

export function disableEndToEndEncryption() {
  activeKey = null;
  activeKeyFingerprint = "";
  localStorage.removeItem(STORAGE_KEY);
}

export function lockEndToEndEncryption() {
  activeKey = null;
  activeKeyFingerprint = "";
}

function isEncryptedText(value: string) {
  return value.startsWith(PAYLOAD_PREFIX);
}

async function encryptText(value: string, key: CryptoKey) {
  const encrypted = await encryptTextRaw(value, key);
  return `${PAYLOAD_PREFIX}${encrypted.iv}:${encrypted.ciphertext}`;
}

async function decryptText(value: string, key: CryptoKey) {
  if (!isEncryptedText(value)) return value;
  const [iv, ciphertext] = value.slice(PAYLOAD_PREFIX.length).split(":", 2);
  if (!iv || !ciphertext) throw new Error("加密数据格式错误");
  return decryptTextRaw(iv, ciphertext, key);
}

export async function encryptNotebookState(state: RemoteNotebookState): Promise<RemoteNotebookState> {
  const metadata = getLocalEncryptionMetadata();
  if (!metadata?.enabled) return { ...state, encryption: null };
  const key = await ensureKeyFor(metadata);
  return {
    ...state,
    encryption: metadata,
    folders: await Promise.all(
      state.folders.map(async (folder) => ({
        ...folder,
        name: await encryptText(folder.name, key),
      }))
    ),
    notes: await Promise.all(
      state.notes.map(async (note) => ({
        ...note,
        title: await encryptText(note.title, key),
        content: await encryptText(note.content, key),
      }))
    ),
  };
}

export async function decryptNotebookState(state: RemoteNotebookState): Promise<RemoteNotebookState> {
  if (!state.encryption?.enabled) return { ...state, encryption: null };
  const key = await ensureKeyFor(state.encryption);
  return {
    ...state,
    encryption: state.encryption,
    folders: await Promise.all(
      state.folders.map(async (folder) => ({
        ...folder,
        name: await decryptText(folder.name, key),
      }))
    ),
    notes: await Promise.all(
      state.notes.map(async (note) => ({
        ...note,
        title: await decryptText(note.title, key),
        content: await decryptText(note.content, key),
      }))
    ),
  };
}

export async function encryptAttachmentBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const metadata = getLocalEncryptionMetadata();
  if (!metadata?.enabled) return bytes;
  const key = await ensureKeyFor(metadata);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: bytesSource(iv) }, key, bytesSource(bytes))
  );
  const header = new TextEncoder().encode(`${PAYLOAD_PREFIX}bytes:v1:`);
  const out = new Uint8Array(header.length + iv.length + ciphertext.length);
  out.set(header);
  out.set(iv, header.length);
  out.set(ciphertext, header.length + iv.length);
  return out;
}

export async function decryptAttachmentBytes(bytes: Uint8Array, metadata?: RemoteEncryptionMeta | null): Promise<Uint8Array> {
  const prefix = new TextEncoder().encode(`${PAYLOAD_PREFIX}bytes:v1:`);
  const hasPrefix = bytes.length > prefix.length && prefix.every((byte, index) => bytes[index] === byte);
  if (!hasPrefix) return bytes;
  const settings = metadata ?? getLocalEncryptionMetadata();
  if (!settings?.enabled) throw new Error("请先在设置中输入端对端密钥");
  const key = await ensureKeyFor(settings);
  const iv = bytes.slice(prefix.length, prefix.length + 12);
  const ciphertext = bytes.slice(prefix.length + 12);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytesSource(iv) }, key, bytesSource(ciphertext))
  );
}
