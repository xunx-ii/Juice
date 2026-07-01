import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { RemoteAttachmentMeta } from "./protocol";
import { syncClient, SyncClient, type RemoteStateMessage } from "./client";
import { useNoteStore } from "../store/useNoteStore";
import { showToast } from "@/store/useToastStore";
import {
  notifyNoteImageAvailable,
  notifyNoteImagesDeleted,
} from "@/lib/noteImageEvents";

const IMAGE_TOKEN_RE = /!\[\[([^\]\r\n]+)\]\]/g;
const STORAGE_KEY = "orange-notes-sync-settings";
const PUSH_DELAY_MS = 300;
const RECONNECT_MIN_DELAY_MS = 1_500;
const RECONNECT_MAX_DELAY_MS = 15_000;
const MAX_PUSH_ATTEMPTS = 3;

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = RECONNECT_MIN_DELAY_MS;
let pushAgainAfterCurrent = false;
let deferredRemoteState: RemoteStateMessage | null = null;

export interface SyncSettings {
  address: string;
  username: string;
  password: string;
}

export interface SyncStore {
  settings: SyncSettings;
  connected: boolean;
  authenticated: boolean;
  lastSync: number | null;
  lastError: string | null;
  syncing: boolean;

  setSettings: (settings: Partial<SyncSettings>) => void;
  resetSettings: () => void;
  connectRealtime: (silent?: boolean) => Promise<void>;
  pushNow: (silent?: boolean) => Promise<void>;
  schedulePush: () => void;
  syncImages: () => Promise<void>;
  cleanupLocalImages: () => Promise<void>;
  downloadImage: (fileName: string, mime: string) => Promise<void>;
  downloadNewImages: (attachments: RemoteAttachmentMeta[]) => Promise<void>;
}

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
  } catch {
    // Ignore malformed local settings.
  }
  return { address: "", username: "", password: "" };
}

export function saveSyncSettings(settings: SyncSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function hasCompleteSettings(settings: SyncSettings) {
  return Boolean(settings.address && settings.username && settings.password);
}

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

function referencedImagesFromRemoteState(message: RemoteStateMessage): Set<string> {
  const names = new Set<string>();
  for (const note of message.state.notes) {
    for (const name of extractImageTokens(note.content)) {
      names.add(name);
    }
  }
  return names;
}

function filterReferencedAttachments(message: RemoteStateMessage): RemoteAttachmentMeta[] {
  const referenced = referencedImagesFromRemoteState(message);
  return message.attachments.filter((attachment) => referenced.has(attachment.file_name));
}

function syncAuthHeaders(settings: SyncSettings): HeadersInit {
  return {
    "x-orange-notes-user": settings.username,
    "x-orange-notes-password": settings.password,
  };
}

function clearPushTimer() {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  const { settings, authenticated, connected } = useSyncStore.getState();
  if (!hasCompleteSettings(settings) || authenticated || connected || reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    // Always silent: this is an automatic background retry, not user-initiated.
    // Startup connection and manual "连接" button use connectRealtime(false) directly.
    void useSyncStore.getState().connectRealtime(true).catch(() => {
      scheduleReconnect();
    });
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
  }, reconnectDelay);
}

async function applyRemoteState(message: RemoteStateMessage) {
  await useNoteStore.getState().applyRemoteChanges(message.state);
  await useSyncStore.getState().cleanupLocalImages();
  await useSyncStore.getState().downloadNewImages(filterReferencedAttachments(message));
  useSyncStore.setState({
    lastSync: Date.now(),
    lastError: null,
    authenticated: syncClient.isAuthenticated(),
    connected: syncClient.isConnected(),
  });
}

async function mergeRejectedState(message: RemoteStateMessage) {
  await useNoteStore.getState().mergeRemoteSnapshot(message.state);
  await useSyncStore.getState().cleanupLocalImages();
  await useSyncStore.getState().downloadNewImages(filterReferencedAttachments(message));
}

async function applyIncomingState(message: RemoteStateMessage) {
  const noteStore = useNoteStore.getState();
  const localVersion = noteStore.syncVersion;

  const store = useSyncStore.getState();
  if (message.state.version === 0 && localVersion === 0 && noteStore.hasContent()) {
    store.schedulePush();
    return;
  }

  if (message.state.version <= localVersion) {
    if (!noteStore.hasLocalChanges()) {
      await store.cleanupLocalImages();
    }
    await store.downloadNewImages(filterReferencedAttachments(message));
    return;
  }

  if (store.syncing || pushTimer || noteStore.hasLocalChanges()) {
    deferredRemoteState = message;
    if (noteStore.hasLocalChanges() && !pushTimer) {
      store.schedulePush();
    }
    return;
  }

  await applyRemoteState(message);
}

export const useSyncStore = create<SyncStore>((set, get) => ({
  settings: loadSyncSettings(),
  connected: false,
  authenticated: false,
  lastSync: null,
  lastError: null,
  syncing: false,

  setSettings: (partial) => {
    const settings = { ...get().settings, ...partial };
    saveSyncSettings(settings);
    set({ settings, lastError: null });

    // Background reconnect — never toast. The "连接" button in settings
    // calls connectRealtime(false) directly for explicit user intent.
    if (hasCompleteSettings(settings)) {
      void get().connectRealtime(true).catch(() => {
        scheduleReconnect();
      });
    }
  },

  resetSettings: () => {
    clearPushTimer();
    clearReconnectTimer();
    saveSyncSettings({ address: "", username: "", password: "" });
    set({
      settings: { address: "", username: "", password: "" },
      connected: false,
      authenticated: false,
      lastError: null,
      syncing: false,
    });
    syncClient.disconnect();
  },

  connectRealtime: async (silent = false) => {
    const { settings } = get();
    if (!hasCompleteSettings(settings)) {
      const msg = "请先配置服务器地址、用户名和密码";
      set({ lastError: msg });
      throw new Error(msg);
    }

    try {
      const url = SyncClient.loginUrl(settings.address, settings.username);
      await syncClient.connect(url, settings.username, settings.password);
      reconnectDelay = RECONNECT_MIN_DELAY_MS;
      clearReconnectTimer();
      set({
        connected: syncClient.isConnected(),
        authenticated: syncClient.isAuthenticated(),
        lastError: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({
        connected: syncClient.isConnected(),
        authenticated: syncClient.isAuthenticated(),
        lastError: message,
      });
      // Only surface as toast when explicitly user-initiated (e.g. "连接" button).
      // Background reconnect / setSettings-triggered calls stay silent.
      if (!silent) showToast(message, "destructive");
      scheduleReconnect();
      throw new Error(message);
    }
  },

  pushNow: async (silent = false) => {
    if (!hasCompleteSettings(get().settings)) {
      const msg = "请先配置服务器地址、用户名和密码";
      set({ lastError: msg });
      if (!silent) showToast(msg, "destructive");
      return;
    }

    if (get().syncing) {
      pushAgainAfterCurrent = true;
      return;
    }

    clearPushTimer();
    set({ syncing: true, lastError: null });

    try {
      await get().connectRealtime(silent);
      await get().syncImages();
      for (let attempt = 0; attempt < MAX_PUSH_ATTEMPTS; attempt += 1) {
        const noteStore = useNoteStore.getState();
        const payload = noteStore.getSyncPayload();
        const result = await syncClient.push(payload, noteStore.syncVersion);
        if (result.accepted) {
          await useNoteStore.getState().markSynced(result.version);
          break;
        }

        await mergeRejectedState(result.remote);
        if (attempt === MAX_PUSH_ATTEMPTS - 1) {
          throw new Error("远端版本持续变化，同步稍后重试");
        }
      }
      set({
        lastSync: Date.now(),
        connected: syncClient.isConnected(),
        authenticated: syncClient.isAuthenticated(),
        lastError: null,
      });
      if (!silent) showToast("同步完成", "success", 2500);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ lastError: message });
      if (!silent) showToast(message, "destructive");
      scheduleReconnect();
    } finally {
      set({ syncing: false });
      if (pushAgainAfterCurrent) {
        pushAgainAfterCurrent = false;
        get().schedulePush();
      } else if (deferredRemoteState) {
        const remote = deferredRemoteState;
        deferredRemoteState = null;
        void applyIncomingState(remote);
      }
    }
  },

  schedulePush: () => {
    clearPushTimer();
    pushTimer = setTimeout(() => {
      pushTimer = null;
      void useSyncStore.getState().pushNow(true);
    }, PUSH_DELAY_MS);
  },

  syncImages: async () => {
    const { settings } = get();
    if (!hasCompleteSettings(settings)) return;

    const httpBase = SyncClient.httpBaseUrl(settings.address);
    const allNames = new Set<string>();
    for (const note of useNoteStore.getState().notes) {
      for (const name of extractImageTokens(note.content)) {
        allNames.add(name);
      }
    }

    for (const fileName of allNames) {
      try {
        const bytes = await invoke<number[]>("read_note_image_bytes", { fileName });
        if (!bytes.length) continue;

        await fetch(
          `${httpBase}/api/sync/files/${encodeURIComponent(settings.username)}/${encodeURIComponent(fileName)}`,
          {
            method: "POST",
            headers: syncAuthHeaders(settings),
            body: new Uint8Array(bytes),
          }
        );
      } catch {
        // Missing local images should not block note state sync.
      }
    }
  },

  cleanupLocalImages: async () => {
    try {
      const deletedImages = await invoke<string[]>("cleanup_unreferenced_note_images");
      notifyNoteImagesDeleted(deletedImages);
    } catch (error) {
      console.warn("Failed to cleanup local note images", error);
    }
  },

  downloadImage: async (fileName, mime) => {
    const { settings } = get();
    if (!hasCompleteSettings(settings)) return;

    const httpBase = SyncClient.httpBaseUrl(settings.address);
    const url = `${httpBase}/api/sync/files/${encodeURIComponent(settings.username)}/${encodeURIComponent(fileName)}`;

    try {
      const response = await fetch(url, { headers: syncAuthHeaders(settings) });
      if (!response.ok) {
        throw new Error(`下载图片失败: ${response.status} ${response.statusText}`);
      }

      const bytes = Array.from(new Uint8Array(await response.arrayBuffer()));
      await invoke("save_synced_image", { fileName, mime, bytes });
      notifyNoteImageAvailable(fileName);
      set({ lastError: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ lastError: message });
      // Silent — image download failures are retryable and not user-critical.
      console.debug(`Failed to download synced image: ${fileName}`, error);
    }
  },

  downloadNewImages: async (attachments) => {
    const { settings } = get();
    if (!hasCompleteSettings(settings) || attachments.length === 0) return;

    for (const attachment of attachments) {
      try {
        const exists = await invoke<boolean>("image_file_exists", {
          fileName: attachment.file_name,
        });
        if (!exists) {
          await get().downloadImage(attachment.file_name, attachment.mime);
        }
      } catch {
        await get().downloadImage(attachment.file_name, attachment.mime);
      }
    }
  },
}));

syncClient.addListener(({ connected, authenticated, error }) => {
  useSyncStore.setState((state) => ({
    connected,
    authenticated,
    lastError: error ?? (authenticated ? null : state.lastError),
  }));

  if (!connected && !authenticated) scheduleReconnect();
});

syncClient.addStateHandler((message) => {
  void applyIncomingState(message);
});
