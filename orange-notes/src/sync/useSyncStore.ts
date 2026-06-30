import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { RemoteAttachmentMeta } from "./protocol";
import { syncClient, SyncClient, type RemoteStateMessage } from "./client";
import { useNoteStore } from "../store/useNoteStore";

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
  connectRealtime: () => Promise<void>;
  pushNow: () => Promise<void>;
  schedulePush: () => void;
  syncImages: () => Promise<void>;
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
    void useSyncStore.getState().connectRealtime().catch(() => {
      scheduleReconnect();
    });
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
  }, reconnectDelay);
}

async function applyRemoteState(message: RemoteStateMessage) {
  await useNoteStore.getState().applyRemoteChanges(message.state);
  await useSyncStore.getState().downloadNewImages(message.attachments);
  useSyncStore.setState({
    lastSync: Date.now(),
    lastError: null,
    authenticated: syncClient.isAuthenticated(),
    connected: syncClient.isConnected(),
  });
}

async function mergeRejectedState(message: RemoteStateMessage) {
  await useNoteStore.getState().mergeRemoteSnapshot(message.state);
  await useSyncStore.getState().downloadNewImages(message.attachments);
}

async function applyIncomingState(message: RemoteStateMessage) {
  const noteStore = useNoteStore.getState();
  const localVersion = noteStore.syncVersion;

  const store = useSyncStore.getState();
  if (message.state.version === 0 && localVersion === 0 && noteStore.hasContent()) {
    store.schedulePush();
    return;
  }

  if (message.state.version <= localVersion) return;

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

    if (hasCompleteSettings(settings)) {
      void get().connectRealtime().catch(() => {
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

  connectRealtime: async () => {
    const { settings } = get();
    if (!hasCompleteSettings(settings)) {
      set({ lastError: "请先配置服务器地址、用户名和密码" });
      return;
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
      scheduleReconnect();
      throw new Error(message);
    }
  },

  pushNow: async () => {
    if (!hasCompleteSettings(get().settings)) {
      set({ lastError: "请先配置服务器地址、用户名和密码" });
      return;
    }

    if (get().syncing) {
      pushAgainAfterCurrent = true;
      return;
    }

    clearPushTimer();
    set({ syncing: true, lastError: null });

    try {
      await get().connectRealtime();
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ lastError: message });
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
      void useSyncStore.getState().pushNow();
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

  downloadImage: async (fileName, mime) => {
    const { settings } = get();
    if (!hasCompleteSettings(settings)) return;

    const httpBase = SyncClient.httpBaseUrl(settings.address);
    const url = `${httpBase}/api/sync/files/${encodeURIComponent(settings.username)}/${encodeURIComponent(fileName)}`;

    try {
      const response = await fetch(url, { headers: syncAuthHeaders(settings) });
      if (!response.ok) return;

      const bytes = Array.from(new Uint8Array(await response.arrayBuffer()));
      await invoke("save_synced_image", { fileName, mime, bytes });
    } catch {
      // Remote images are retried on the next state broadcast.
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
