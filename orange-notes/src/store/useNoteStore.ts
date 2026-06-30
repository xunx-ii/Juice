import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { Folder, Note } from "@/types/note";
import type { RemoteFolder, RemoteNote, RemoteNotebookState, RemoteDeletedChange } from "@/sync/protocol";
import { useSyncStore } from "@/sync/useSyncStore";

interface PersistedData {
  folders: Folder[];
  notes: Note[];
}

type NotePatch = Partial<
  Pick<Note, "title" | "content" | "folder" | "sortOrder" | "pinned" | "favorite">
>;

interface NoteStore {
  folders: Folder[];
  notes: Note[];
  activeNoteId: string | null;
  searchQuery: string;
  sidebarOpen: boolean;
  darkMode: boolean;
  expandedFolders: Set<string>;
  loading: boolean;
  error: string | null;

  // IDs deleted locally since the last sync payload was generated.
  // getSyncPayload() drains this into the `deleted` array so the server
  // knows to remove them (otherwise the server has no way to notice a
  // pure-delete — it only upserts what it receives).
  pendingDeletes: Set<string>;

  initialize: () => Promise<void>;
  createNote: (folderId: string) => Promise<void>;
  deleteNote: (id: string) => Promise<void>;
  updateNote: (id: string, data: NotePatch) => Promise<void>;
  reorderNote: (noteId: string, targetFolderId: string, targetIndex: number) => Promise<void>;
  setActiveNote: (id: string | null) => void;

  addFolder: (name: string, parentId?: string | null) => Promise<void>;
  renameFolder: (id: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  reorderFolder: (folderId: string, targetIndex: number) => Promise<void>;
  moveFolderTo: (folderId: string, targetParentId: string | null, targetIndex: number) => Promise<void>;

  setSearchQuery: (query: string) => void;
  toggleSidebar: () => void;
  toggleDarkMode: () => void;
  toggleFolder: (folderId: string) => void;

  // Sync helpers
  getSyncPayload: () => RemoteNotebookState;
  applyRemoteChanges: (state: RemoteNotebookState) => Promise<void>;
}

function readDarkMode(): boolean {
  try {
    return localStorage.getItem("obsidian-lite-dark") === "true";
  } catch {
    return false;
  }
}

function setAsyncError(error: unknown, fallback: string) {
  console.error(error);
  useNoteStore.setState({ error: error instanceof Error ? error.message : fallback });
}

async function loadNotebook(): Promise<PersistedData> {
  return invoke<PersistedData>("load_notebook");
}

export const useNoteStore = create<NoteStore>((set, get) => ({
  folders: [],
  notes: [],
  activeNoteId: null,
  searchQuery: "",
  sidebarOpen: true,
  darkMode: readDarkMode(),
  expandedFolders: new Set<string>(),
  loading: true,
  error: null,
  pendingDeletes: new Set<string>(),

  initialize: async () => {
    try {
      set({ loading: true, error: null });
      const data = await loadNotebook();
      // Only expand root-level folders by default so nested folders start
      // collapsed and the tree doesn't overwhelm the user.
      const defaultExpanded = new Set(
        data.folders.filter((f) => f.parentId === null).map((f) => f.id)
      );
      set({
        folders: data.folders,
        notes: data.notes,
        loading: false,
        expandedFolders: defaultExpanded,
        activeNoteId: data.notes[0]?.id ?? null,
      });
    } catch (error) {
      set({ loading: false });
      setAsyncError(error, "加载本地笔记失败");
    }
  },

  createNote: async (folderId: string) => {
    try {
      const newNote = await invoke<Note>("create_note", { folderId });
      set((state) => ({
        notes: [...state.notes, newNote],
        activeNoteId: newNote.id,
      }));
      useSyncStore.getState().scheduleSync();
    } catch (error) {
      setAsyncError(error, "创建笔记失败");
    }
  },

  deleteNote: async (id: string) => {
    try {
      await invoke("delete_note", { id });
      set((state) => {
        const notes = state.notes.filter((n) => n.id !== id);
        const pendingDeletes = new Set(state.pendingDeletes);
        pendingDeletes.add(id);
        return {
          notes,
          activeNoteId: state.activeNoteId === id ? notes[0]?.id ?? null : state.activeNoteId,
          pendingDeletes,
        };
      });
      useSyncStore.getState().scheduleSync();
    } catch (error) {
      setAsyncError(error, "删除笔记失败");
    }
  },

  updateNote: async (id: string, data: NotePatch) => {
    const previous = get().notes;
    const now = Date.now();
    const next = previous.map((note) =>
      note.id === id ? { ...note, ...data, updatedAt: now } : note
    );
    set({ notes: next });

    try {
      await invoke("update_note", { id, patch: data });
      useSyncStore.getState().scheduleSync();
    } catch (error) {
      set({ notes: previous });
      setAsyncError(error, "保存笔记失败");
    }
  },

  reorderNote: async (noteId: string, targetFolderId: string, targetIndex: number) => {
    try {
      const data = await invoke<PersistedData>("reorder_note", {
        noteId,
        targetFolderId,
        targetIndex,
      });
      set({
        folders: data.folders,
        notes: data.notes,
        expandedFolders: new Set([
          ...get().expandedFolders,
          targetFolderId,
        ]),
      });
      useSyncStore.getState().scheduleSync();
    } catch (error) {
      setAsyncError(error, "移动笔记失败");
    }
  },

  setActiveNote: (id: string | null) => set({ activeNoteId: id }),

  addFolder: async (name: string, parentId?: string | null) => {
    try {
      const folder = await invoke<Folder>("create_folder", { name, parentId: parentId ?? null });
      set((state) => ({
        folders: [...state.folders, folder],
        expandedFolders: new Set([...state.expandedFolders, folder.id]),
      }));
      if (parentId) {
        set((state) => ({
          expandedFolders: new Set([...state.expandedFolders, parentId]),
        }));
      }
      useSyncStore.getState().scheduleSync();
    } catch (error) {
      setAsyncError(error, "创建文件夹失败");
    }
  },

  renameFolder: async (id: string, name: string) => {
    const previous = get().folders;
    set({ folders: previous.map((folder) => (folder.id === id ? { ...folder, name } : folder)) });
    try {
      await invoke("rename_folder", { id, name });
      useSyncStore.getState().scheduleSync();
    } catch (error) {
      set({ folders: previous });
      setAsyncError(error, "重命名文件夹失败");
    }
  },

  deleteFolder: async (id: string) => {
    const previousFolders = get().folders;
    const previousNotes = get().notes;
    const previousActive = get().activeNoteId;
    const notes = previousNotes.filter((note) => note.folder !== id);
    set({
      folders: previousFolders.filter((folder) => folder.id !== id),
      notes,
      activeNoteId: notes.some((note) => note.id === previousActive)
        ? previousActive
        : notes[0]?.id ?? null,
    });

    try {
      await invoke("delete_folder", { id });
      // Register folder deletion so next sync payload tells the server.
      set((state) => ({
        pendingDeletes: new Set([...state.pendingDeletes, id]),
      }));
      useSyncStore.getState().scheduleSync();
    } catch (error) {
      set({ folders: previousFolders, notes: previousNotes, activeNoteId: previousActive });
      setAsyncError(error, "删除文件夹失败");
    }
  },

  reorderFolder: async (folderId: string, targetIndex: number) => {
    try {
      const data = await invoke<PersistedData>("reorder_folder", { folderId, targetIndex });
      set({
        folders: data.folders,
        notes: data.notes,
        expandedFolders: new Set(get().expandedFolders),
      });
      useSyncStore.getState().scheduleSync();
    } catch (error) {
      setAsyncError(error, "移动文件夹失败");
    }
  },

  moveFolderTo: async (
    folderId: string,
    targetParentId: string | null,
    targetIndex: number
  ) => {
    try {
      const data = await invoke<PersistedData>("move_folder", {
        folderId,
        targetParentId: targetParentId ?? null,
        targetIndex,
      });
      set({
        folders: data.folders,
        notes: data.notes,
        expandedFolders: new Set([
          ...get().expandedFolders,
          ...(targetParentId ? [targetParentId] : []),
        ]),
      });
      useSyncStore.getState().scheduleSync();
    } catch (error) {
      setAsyncError(error, "移动文件夹失败");
    }
  },

  setSearchQuery: (query: string) => set({ searchQuery: query }),

  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),

  toggleDarkMode: () => {
    set((state) => {
      const darkMode = !state.darkMode;
      localStorage.setItem("obsidian-lite-dark", String(darkMode));
      return { darkMode };
    });
  },

  toggleFolder: (folderId: string) => {
    set((state) => {
      const next = new Set(state.expandedFolders);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return { expandedFolders: next };
    });
  },

  getSyncPayload: (): RemoteNotebookState => {
    const { folders, notes, pendingDeletes } = get();

    // Drain pending deletes into the payload and clear the set.
    // The server needs these IDs to know which entities to remove
    // (a pure-delete doesn't appear in the notes/folders arrays).
    const deleted: RemoteDeletedChange[] = [];
    if (pendingDeletes.size > 0) {
      const now = Date.now();
      for (const id of pendingDeletes) {
        deleted.push({ entity_type: "note", id, deleted_at: now });
      }
      set({ pendingDeletes: new Set<string>() });
    }

    return {
      folders: folders.map((f) => ({
        id: f.id,
        name: f.name,
        sort_order: f.sortOrder,
        parent_id: f.parentId,
        updated_at: 0,
      })),
      notes: notes.map((n) => ({
        id: n.id,
        title: n.title,
        content: n.content,
        folder: n.folder,
        created_at: n.createdAt,
        updated_at: n.updatedAt,
        sort_order: n.sortOrder,
        pinned: n.pinned,
        favorite: n.favorite,
      })),
      deleted,
      version: Date.now(),
    };
  },

  applyRemoteChanges: async (state: RemoteNotebookState) => {
    const folders: Folder[] = state.folders.map((rf) => ({
      id: rf.id,
      name: rf.name,
      sortOrder: rf.sort_order,
      parentId: rf.parent_id,
    }));
    const notes: Note[] = state.notes.map((rn) => ({
      id: rn.id,
      title: rn.title,
      content: rn.content,
      folder: rn.folder,
      createdAt: rn.created_at,
      updatedAt: rn.updated_at,
      sortOrder: rn.sort_order,
      pinned: rn.pinned,
      favorite: rn.favorite,
    }));
    const deletedIds = new Set(state.deleted.map((d) => d.id));
    set({
      folders: folders.filter((f) => !deletedIds.has(f.id)),
      notes: notes.filter((n) => !deletedIds.has(n.id)),
    });

    // Persist to local SQLite.
    const { folders: f, notes: ns } = get();
    await invoke("apply_remote_notebook", {
      remoteFolders: state.folders,
      remoteNotes: state.notes,
      remoteDeleted: state.deleted,
    }).catch((e) => {
      // local persist failure — non-fatal, next local sync will overwrite.
      console.warn("Failed to persist remote state locally", e);
    });
  },
}));
