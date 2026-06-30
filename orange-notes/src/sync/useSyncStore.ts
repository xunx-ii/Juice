import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { RemoteFolder, RemoteNote, RemoteNotebookState, RemoteAttachmentMeta } from "./protocol";
import { syncClient, SyncClient } from "./client";
import { useNoteStore } from "../store/useNoteStore";

// Regex must match the one in NoteEditor.tsx.
const IMAGE_TOKEN_RE = /!\[\[([^\]\r\n]+)\]\]/g;

/// Extract all image filenames referenced in a piece of markdown content.
function extractImageTokens(content: string): string[] {
  const result: string[] = [];
  let match: RegExpExecArray | null;
  IMAGE_TOKEN_RE.lastIndex = 0;
  while ((match = IMAGE_TOKEN_RE.exec(content)) !== null) {
    const name = match[1].trim();
    if (name) result.push(name);
  }
  return result;
}

/// Derive the HTTP base URL from a ws:// sync address.
function httpBaseFromSyncAddress(address: string): string {
  let httpBase = address.trim();
  if (httpBase.startsWith("ws://")) httpBase = "http://" + httpBase.slice(5);
  else if (httpBase.startsWith("wss://")) httpBase = "https://" + httpBase.slice(6);
  else if (!httpBase.startsWith("http")) httpBase = "http://" + httpBase;
  return httpBase.replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// Sync scheduler – coalesces rapid mutations (typing, drag, …) into a single
// network round-trip so we don't hammer the server on every keystroke.
// ---------------------------------------------------------------------------
let scheduleTimer: ReturnType<typeof setTimeout> | null = null;
let scheduleImmediate = false; // when true, sync on next tick (discrete op)

function scheduleSync() {
  if (scheduleTimer) clearTimeout(scheduleTimer);
  scheduleTimer = setTimeout(runSync, 1200);
}

function runSync() {
  scheduleTimer = null;
  const store = useSyncStore.getState();
  if (store.settings.address && store.settings.username && store.settings.password) {
    void store.startSync();
  }
}

export interface SyncSettings {
  address: string;   // e.g. "example.com:8777"
  username: string;
  password: string;
}

const STORAGE_KEY = "orange-notes-sync-settings";

export function loadSyncSettings(): SyncSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SyncSettings>;
      return {
        address: parsed.address ?? "",
        username: parsed.username ?? "",
        password: parsed.password ?? "",
      };
    }
  } catch {}
  return { address: "", username: "", password: "" };
}

export function saveSyncSettings(s: SyncSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

export interface SyncStore {
  settings: SyncSettings;
  connected: boolean;
  authenticated: boolean;
  lastSync: number | null;
  lastError: string | null;
  testing: boolean;
  syncing: boolean;

  setSettings: (s: Partial<SyncSettings>) => void;
  resetSettings: () => void;
  testConnection: () => Promise<RemoteNotebookState>;
  pushState: (state: RemoteNotebookState) => Promise<RemoteNotebookState>;
  startSync: () => Promise<void>;
  scheduleSync: () => void;
  syncImages: () => Promise<void>;
  downloadImage: (fileName: string, mime: string) => Promise<void>;
  downloadNewImages: (attachments: RemoteAttachmentMeta[]) => Promise<void>;
  setState: (s: Partial<Pick<SyncStore, "connected" | "authenticated" | "lastSync" | "lastError" | "testing" | "syncing">>) => void;
}

export const useSyncStore = create<SyncStore>((set, get) => ({
  settings: loadSyncSettings(),
  connected: false,
  authenticated: false,
  lastSync: null,
  lastError: null,
  testing: false,
  syncing: false,

  setSettings: (partial) => {
    const next = { ...get().settings, ...partial };
    saveSyncSettings(next);
    set({ settings: next });
  },

  resetSettings: () => {
    saveSyncSettings({ address: "", username: "", password: "" });
    set({ settings: { address: "", username: "", password: "" }, connected: false, authenticated: false });
    syncClient.disconnect();
  },

  testConnection: async () => {
    const { settings } = get();
    if (!settings.address || !settings.username || !settings.password) {
      const err = new Error("请填写服务器地址、用户名和密码");
      set({ lastError: String(err) });
      throw err;
    }

    set({ testing: true, lastError: null });

    try {
      const url = SyncClient.loginUrl(settings.address, settings.username);
      const state = await syncClient.connectAndFetchState(
        url,
        settings.username,
        settings.password
      );
      set({ testing: false, authenticated: true });
      return state;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ testing: false, lastError: msg, authenticated: false });
      // Disconnect so the next test starts fresh.
      syncClient.disconnect();
      throw new Error(msg);
    }
  },

  pushState: async (state) => {
    const { settings } = get();
    try {
      // If not connected, establish connection first.
      if (!syncClient.isAuthenticated()) {
        const url = SyncClient.loginUrl(settings.address, settings.username);
        await syncClient.connect(url, settings.username, settings.password);
      }
      const result = await syncClient.push(state);
      set({ lastSync: Date.now(), lastError: null, authenticated: true });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ lastError: msg, authenticated: syncClient.isAuthenticated() });
      throw e;
    }
  },

  scheduleSync: () => {
    scheduleSync();
  },

  // -----------------------------------------------------------------------
  // Image sync
  // -----------------------------------------------------------------------

  /// Upload all images referenced in the current local notes to the server.
  syncImages: async () => {
    const { settings } = get();
    if (!settings.address || !settings.username) return;

    const notes = useNoteStore.getState().notes;
    const httpBase = httpBaseFromSyncAddress(settings.address);

    // Collect all referenced image filenames.
    const allNames = new Set<string>();
    for (const note of notes) {
      for (const name of extractImageTokens(note.content)) {
        allNames.add(name);
      }
    }

    for (const fileName of allNames) {
      try {
        // Read raw bytes from local disk.
        const bytes = await invoke<number[]>("read_note_image_bytes", { fileName });
        if (!bytes || bytes.length === 0) continue;

        // Build a Uint8Array for the fetch body.
        const body = new Uint8Array(bytes);

        await fetch(
          `${httpBase}/api/sync/files/${encodeURIComponent(settings.username)}/${encodeURIComponent(fileName)}`,
          { method: "POST", body }
        );
      } catch {
        // Image might not exist locally yet — skip.
      }
    }
  },

  /// Download a single image from the server and save it locally.
  downloadImage: async (fileName: string, mime: string) => {
    const { settings } = get();
    if (!settings.address || !settings.username) return;

    const httpBase = httpBaseFromSyncAddress(settings.address);
    const url = `${httpBase}/api/sync/files/${encodeURIComponent(settings.username)}/${encodeURIComponent(fileName)}`;

    try {
      const r = await fetch(url);
      if (!r.ok) return;
      const blob = await r.blob();
      const arrayBuf = await blob.arrayBuffer();
      const bytes = Array.from(new Uint8Array(arrayBuf));

      await invoke("save_synced_image", { fileName, mime, bytes });
    } catch {
      // Network error — skip.
    }
  },

  /// Download any images that the server has but we don't have locally.
  downloadNewImages: async (attachments: RemoteAttachmentMeta[]) => {
    const { settings } = get();
    if (!settings.address || !settings.username || attachments.length === 0) return;

    for (const att of attachments) {
      try {
        // Check if the file already exists locally.
        const exists = await invoke<boolean>("image_file_exists", { fileName: att.file_name });
        if (!exists) {
          await get().downloadImage(att.file_name, att.mime);
        }
      } catch {
        // Try to download anyway on error.
        await get().downloadImage(att.file_name, att.mime);
      }
    }
  },

  startSync: async () => {
    const { settings } = get();
    if (!settings.address || !settings.username || !settings.password) {
      set({ lastError: "请先配置服务器地址、用户名和密码" });
      return;
    }
    if (get().syncing) return; // already syncing

    set({ syncing: true, lastError: null });

    try {
      // Get current local state and push to server.
      const payload = useNoteStore.getState().getSyncPayload();
      const result = await get().pushState(payload);
      // Apply any remote changes back to the UI.
      await useNoteStore.getState().applyRemoteChanges(result);
      set({ lastSync: Date.now(), lastError: null, authenticated: true });
      // Upload local images and download missing remote images.
      await get().syncImages();
      // Request state response will include attachments metadata;
      // we handle that in the WS message handler.
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ lastError: msg });
    } finally {
      set({ syncing: false });
    }
  },

  setState: (partial) => set(partial as SyncStore),
}));

// Keep the store in sync with the client's connection state.
syncClient.addListener((connected, error) => {
  useSyncStore.getState().setState({
    connected,
    authenticated: syncClient.isAuthenticated(),
    lastError: error ?? null,
  });
});

syncClient.addStateHandler((state) => {
  useSyncStore.getState().setState({ lastSync: Date.now() });
});
