import { create } from "zustand";
import type { RemoteFolder, RemoteNote, RemoteNotebookState } from "./protocol";
import { syncClient } from "./client";

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
  lastSync: number | null;
  lastError: string | null;
  testing: boolean;

  setSettings: (s: Partial<SyncSettings>) => void;
  resetSettings: () => void;
  testConnection: () => Promise<RemoteNotebookState>;
  pushState: (state: RemoteNotebookState) => Promise<RemoteNotebookState>;
  setState: (s: Partial<Pick<SyncStore, "connected" | "lastSync" | "lastError" | "testing">>) => void;
}

export const useSyncStore = create<SyncStore>((set, get) => ({
  settings: loadSyncSettings(),
  connected: false,
  lastSync: null,
  lastError: null,
  testing: false,

  setSettings: (partial) => {
    const next = { ...get().settings, ...partial };
    saveSyncSettings(next);
    set({ settings: next });
  },

  resetSettings: () => {
    saveSyncSettings({ address: "", username: "", password: "" });
    set({ settings: { address: "", username: "", password: "" }, connected: false });
    syncClient.disconnect();
  },

  testConnection: async () => {
    get().setState({ testing: true, lastError: null });
    try {
      const url = SyncClient.loginUrl(get().settings.address, get().settings.username);
      syncClient.connect(url, get().settings.username, get().settings.password);
      setTimeout(() => {
        syncClient.disconnect();
      }, 5000);
      const state = await syncClient.requestState();
      get().setState({ testing: false });
      return state;
    } catch (e) {
      get().setState({ testing: false, lastError: String(e) });
      throw e;
    }
  },

  pushState: async (state) => {
    try {
      const url = SyncClient.loginUrl(get().settings.address, get().settings.username);
      syncClient.connect(url, get().settings.username, get().settings.password);
      const result = await syncClient.push(state);
      get().setState({ lastSync: Date.now(), lastError: null });
      return result;
    } catch (e) {
      get().setState({ lastError: String(e) });
      throw e;
    }
  },

  setState: (partial) => set(partial as SyncStore),
}));

syncClient.addListener((connected, error) => {
  useSyncStore.getState().setState({ connected, lastError: error ?? null });
});

syncClient.addStateHandler((state) => {
  useSyncStore.getState().setState({ lastSync: Date.now() });
  // This handler intentionally does not apply state to the UI — that happens
  // explicitly via the return value of testConnection/pushState.
});
