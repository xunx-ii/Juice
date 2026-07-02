import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { AiPermission, Folder, Note } from "@/types/note";
import type { RemoteNotebookState } from "@/sync/protocol";
import { decryptNotebookState, encryptNotebookState, getLocalEncryptionMetadata } from "@/sync/encryption";
import { useSyncStore } from "@/sync/useSyncStore";
import { notifyNoteImagesDeleted } from "@/lib/noteImageEvents";

interface PersistedData {
  folders: Folder[];
  notes: Note[];
  syncVersion: number;
  dirtyNotes: string[];
  dirtyFolders: string[];
  deletedNotes: string[];
  deletedFolders: string[];
}

type NotePatch = Partial<
  Pick<Note, "title" | "content" | "folder" | "sortOrder" | "pinned" | "favorite" | "aiPermission">
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
  syncVersion: number;
  dirtyNotes: Set<string>;
  dirtyFolders: Set<string>;
  deletedNotes: Set<string>;
  deletedFolders: Set<string>;

  initialize: () => Promise<void>;
  createNote: (folderId: string) => Promise<void>;
  deleteNote: (id: string) => Promise<void>;
  updateNote: (id: string, data: NotePatch) => Promise<void>;
  reorderNote: (noteId: string, targetFolderId: string, targetIndex: number) => Promise<void>;
  setActiveNote: (id: string | null) => void;

  addFolder: (name: string, parentId?: string | null) => Promise<void>;
  renameFolder: (id: string, name: string) => Promise<void>;
  updateFolderPermission: (id: string, aiPermission: AiPermission) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  reorderFolder: (folderId: string, targetIndex: number) => Promise<void>;
  moveFolderTo: (folderId: string, targetParentId: string | null, targetIndex: number) => Promise<void>;

  setSearchQuery: (query: string) => void;
  toggleSidebar: () => void;
  toggleDarkMode: () => void;
  toggleFolder: (folderId: string) => void;

  // Sync helpers
  getSyncPayload: () => Promise<RemoteNotebookState>;
  applyRemoteChanges: (state: RemoteNotebookState) => Promise<void>;
  mergeRemoteSnapshot: (state: RemoteNotebookState) => Promise<void>;
  markSynced: (version: number) => Promise<void>;
  hasContent: () => boolean;
  hasLocalChanges: () => boolean;
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

async function persistSyncMarkers() {
  const state = useNoteStore.getState();
  try {
    await invoke("set_sync_markers", {
      dirtyNotes: Array.from(state.dirtyNotes),
      dirtyFolders: Array.from(state.dirtyFolders),
      deletedNotes: Array.from(state.deletedNotes),
      deletedFolders: Array.from(state.deletedFolders),
    });
  } catch (error) {
    console.warn("Failed to persist sync markers", error);
  }
}

function collectDescendantFolderIds(folders: Folder[], rootId: string): string[] {
  const childrenByParent = new Map<string | null, Folder[]>();
  for (const folder of folders) {
    const siblings = childrenByParent.get(folder.parentId) ?? [];
    siblings.push(folder);
    childrenByParent.set(folder.parentId, siblings);
  }

  const result: string[] = [];
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    for (const child of childrenByParent.get(id) ?? []) {
      stack.push(child.id);
    }
  }
  return result;
}

function payloadToLocal(state: RemoteNotebookState) {
  const folders: Folder[] = state.folders.map((rf) => ({
    id: rf.id,
    name: rf.name,
    sortOrder: rf.sort_order,
    parentId: rf.parent_id,
    aiPermission: rf.ai_permission ?? "write",
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
    aiPermission: rn.ai_permission ?? "write",
  }));
  return { folders, notes };
}

function localToPayload(
  folders: Folder[],
  notes: Note[],
  version: number
): RemoteNotebookState {
  return {
    folders: folders.map((f) => ({
      id: f.id,
      name: f.name,
      sort_order: f.sortOrder,
      parent_id: f.parentId,
      updated_at: 0,
      ai_permission: f.aiPermission,
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
      ai_permission: n.aiPermission,
    })),
    version,
    encryption: getLocalEncryptionMetadata(),
  };
}

function deleteMany<T>(set: Set<T>, values: Iterable<T>) {
  for (const value of values) set.delete(value);
}

function collectChangedNoteIds(previous: Note[], next: Note[]): Set<string> {
  const previousById = new Map(previous.map((note) => [note.id, note]));
  const changed = new Set<string>();
  for (const note of next) {
    const before = previousById.get(note.id);
    if (
      !before ||
      before.title !== note.title ||
      before.content !== note.content ||
      before.folder !== note.folder ||
      before.sortOrder !== note.sortOrder ||
      before.pinned !== note.pinned ||
      before.favorite !== note.favorite ||
      before.aiPermission !== note.aiPermission
    ) {
      changed.add(note.id);
    }
  }
  return changed;
}

function collectChangedFolderIds(previous: Folder[], next: Folder[]): Set<string> {
  const previousById = new Map(previous.map((folder) => [folder.id, folder]));
  const changed = new Set<string>();
  for (const folder of next) {
    const before = previousById.get(folder.id);
    if (
      !before ||
      before.name !== folder.name ||
      before.parentId !== folder.parentId ||
      before.sortOrder !== folder.sortOrder ||
      before.aiPermission !== folder.aiPermission
    ) {
      changed.add(folder.id);
    }
  }
  return changed;
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
  syncVersion: 0,
  dirtyNotes: new Set<string>(),
  dirtyFolders: new Set<string>(),
  deletedNotes: new Set<string>(),
  deletedFolders: new Set<string>(),

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
        syncVersion: data.syncVersion,
        dirtyNotes: new Set(data.dirtyNotes),
        dirtyFolders: new Set(data.dirtyFolders),
        deletedNotes: new Set(data.deletedNotes),
        deletedFolders: new Set(data.deletedFolders),
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
        dirtyNotes: new Set([...state.dirtyNotes, newNote.id]),
        deletedNotes: new Set([...state.deletedNotes].filter((noteId) => noteId !== newNote.id)),
      }));
      await persistSyncMarkers();
      useSyncStore.getState().schedulePush();
    } catch (error) {
      setAsyncError(error, "创建笔记失败");
    }
  },

  deleteNote: async (id: string) => {
    try {
      const deletedImages = await invoke<string[]>("delete_note", { id });
      notifyNoteImagesDeleted(deletedImages);
      set((state) => {
        const notes = state.notes.filter((n) => n.id !== id);
        const dirtyNotes = new Set(state.dirtyNotes);
        dirtyNotes.delete(id);
        return {
          notes,
          activeNoteId: state.activeNoteId === id ? notes[0]?.id ?? null : state.activeNoteId,
          dirtyNotes,
          deletedNotes: new Set([...state.deletedNotes, id]),
        };
      });
      await persistSyncMarkers();
      useSyncStore.getState().schedulePush();
    } catch (error) {
      setAsyncError(error, "删除笔记失败");
    }
  },

  updateNote: async (id: string, data: NotePatch) => {
    const previous = get().notes;
    const wasDirty = get().dirtyNotes.has(id);
    const now = Date.now();
    const next = previous.map((note) =>
      note.id === id ? { ...note, ...data, updatedAt: now } : note
    );
    set((state) => ({ notes: next, dirtyNotes: new Set([...state.dirtyNotes, id]) }));

    try {
      const deletedImages = await invoke<string[]>("update_note", { id, patch: data });
      notifyNoteImagesDeleted(deletedImages);
      await persistSyncMarkers();
      useSyncStore.getState().schedulePush();
    } catch (error) {
      set((state) => {
        const dirtyNotes = new Set(state.dirtyNotes);
        if (!wasDirty) dirtyNotes.delete(id);
        return { notes: previous, dirtyNotes };
      });
      setAsyncError(error, "保存笔记失败");
    }
  },

  reorderNote: async (noteId: string, targetFolderId: string, targetIndex: number) => {
    try {
      const previousNotes = get().notes;
      const data = await invoke<PersistedData>("reorder_note", {
        noteId,
        targetFolderId,
        targetIndex,
      });
      const dirtyNoteIds = collectChangedNoteIds(previousNotes, data.notes);
      dirtyNoteIds.add(noteId);
      set((state) => ({
        folders: data.folders,
        notes: data.notes,
        expandedFolders: new Set([
          ...state.expandedFolders,
          targetFolderId,
        ]),
        dirtyNotes: new Set([...state.dirtyNotes, ...dirtyNoteIds]),
      }));
      await persistSyncMarkers();
      useSyncStore.getState().schedulePush();
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
        dirtyFolders: new Set([...state.dirtyFolders, folder.id]),
        deletedFolders: new Set(
          [...state.deletedFolders].filter((folderId) => folderId !== folder.id)
        ),
      }));
      if (parentId) {
        set((state) => ({
          expandedFolders: new Set([...state.expandedFolders, parentId]),
        }));
      }
      await persistSyncMarkers();
      useSyncStore.getState().schedulePush();
    } catch (error) {
      setAsyncError(error, "创建文件夹失败");
    }
  },

  renameFolder: async (id: string, name: string) => {
    const previous = get().folders;
    const wasDirty = get().dirtyFolders.has(id);
    set((state) => ({
      folders: previous.map((folder) => (folder.id === id ? { ...folder, name } : folder)),
      dirtyFolders: new Set([...state.dirtyFolders, id]),
    }));
    try {
      await invoke("rename_folder", { id, name });
      await persistSyncMarkers();
      useSyncStore.getState().schedulePush();
    } catch (error) {
      set((state) => {
        const dirtyFolders = new Set(state.dirtyFolders);
        if (!wasDirty) dirtyFolders.delete(id);
        return { folders: previous, dirtyFolders };
      });
      setAsyncError(error, "重命名文件夹失败");
    }
  },

  updateFolderPermission: async (id: string, aiPermission: AiPermission) => {
    const previous = get().folders;
    const wasDirty = get().dirtyFolders.has(id);
    set((state) => ({
      folders: previous.map((folder) =>
        folder.id === id ? { ...folder, aiPermission } : folder
      ),
      dirtyFolders: new Set([...state.dirtyFolders, id]),
    }));
    try {
      await invoke("update_folder_permission", { id, aiPermission });
      await persistSyncMarkers();
      useSyncStore.getState().schedulePush();
    } catch (error) {
      set((state) => {
        const dirtyFolders = new Set(state.dirtyFolders);
        if (!wasDirty) dirtyFolders.delete(id);
        return { folders: previous, dirtyFolders };
      });
      setAsyncError(error, "更新文件夹权限失败");
    }
  },

  deleteFolder: async (id: string) => {
    const previousFolders = get().folders;
    const previousNotes = get().notes;
    const previousActive = get().activeNoteId;
    const previousDirtyNotes = new Set(get().dirtyNotes);
    const previousDirtyFolders = new Set(get().dirtyFolders);
    const previousDeletedNotes = new Set(get().deletedNotes);
    const previousDeletedFolders = new Set(get().deletedFolders);
    const deletedFolderIds = collectDescendantFolderIds(previousFolders, id);
    const deletedFolderSet = new Set(deletedFolderIds);
    const deletedNoteIds = previousNotes
      .filter((note) => deletedFolderSet.has(note.folder))
      .map((note) => note.id);
    const notes = previousNotes.filter((note) => !deletedFolderSet.has(note.folder));
    const folders = previousFolders.filter((folder) => !deletedFolderSet.has(folder.id));
    set((state) => {
      const dirtyNotes = new Set(state.dirtyNotes);
      const dirtyFolders = new Set(state.dirtyFolders);
      deleteMany(dirtyNotes, deletedNoteIds);
      deleteMany(dirtyFolders, deletedFolderIds);
      return {
        folders,
        notes,
        activeNoteId: notes.some((note) => note.id === previousActive)
          ? previousActive
          : notes[0]?.id ?? null,
        dirtyNotes,
        dirtyFolders,
        deletedNotes: new Set([...state.deletedNotes, ...deletedNoteIds]),
        deletedFolders: new Set([...state.deletedFolders, ...deletedFolderIds]),
      };
    });

    try {
      const data = await invoke<PersistedData>("delete_folder", { id });
      set((state) => ({
        folders: data.folders,
        notes: data.notes,
        activeNoteId: data.notes.some((note) => note.id === state.activeNoteId)
          ? state.activeNoteId
          : data.notes[0]?.id ?? null,
      }));
      await persistSyncMarkers();
      useSyncStore.getState().schedulePush();
    } catch (error) {
      set({
        folders: previousFolders,
        notes: previousNotes,
        activeNoteId: previousActive,
        dirtyNotes: previousDirtyNotes,
        dirtyFolders: previousDirtyFolders,
        deletedNotes: previousDeletedNotes,
        deletedFolders: previousDeletedFolders,
      });
      setAsyncError(error, "删除文件夹失败");
    }
  },

  reorderFolder: async (folderId: string, targetIndex: number) => {
    try {
      const previousFolders = get().folders;
      const data = await invoke<PersistedData>("reorder_folder", { folderId, targetIndex });
      const dirtyFolderIds = collectChangedFolderIds(previousFolders, data.folders);
      dirtyFolderIds.add(folderId);
      set((state) => ({
        folders: data.folders,
        notes: data.notes,
        expandedFolders: new Set(state.expandedFolders),
        dirtyFolders: new Set([...state.dirtyFolders, ...dirtyFolderIds]),
      }));
      await persistSyncMarkers();
      useSyncStore.getState().schedulePush();
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
      const previousFolders = get().folders;
      const data = await invoke<PersistedData>("move_folder", {
        folderId,
        targetParentId: targetParentId ?? null,
        targetIndex,
      });
      const dirtyFolderIds = collectChangedFolderIds(previousFolders, data.folders);
      dirtyFolderIds.add(folderId);
      set((state) => ({
        folders: data.folders,
        notes: data.notes,
        expandedFolders: new Set([
          ...state.expandedFolders,
          ...(targetParentId ? [targetParentId] : []),
        ]),
        dirtyFolders: new Set([...state.dirtyFolders, ...dirtyFolderIds]),
      }));
      await persistSyncMarkers();
      useSyncStore.getState().schedulePush();
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

  getSyncPayload: async (): Promise<RemoteNotebookState> => {
    const { folders, notes } = get();
    return encryptNotebookState(localToPayload(folders, notes, Date.now()));
  },

  applyRemoteChanges: async (state: RemoteNotebookState) => {
    const decryptedState = await decryptNotebookState(state);
    const { folders, notes } = payloadToLocal(decryptedState);

    const deletedImages = await invoke<string[]>("apply_remote_notebook", {
      remoteFolders: decryptedState.folders,
      remoteNotes: decryptedState.notes,
      version: state.version,
      clearChanges: true,
    });
    notifyNoteImagesDeleted(deletedImages);

    set({
      folders,
      notes,
      syncVersion: state.version,
      dirtyNotes: new Set<string>(),
      dirtyFolders: new Set<string>(),
      deletedNotes: new Set<string>(),
      deletedFolders: new Set<string>(),
      activeNoteId: notes.some((note) => note.id === get().activeNoteId)
        ? get().activeNoteId
        : notes[0]?.id ?? null,
    });
  },

  mergeRemoteSnapshot: async (state: RemoteNotebookState) => {
    const decryptedState = await decryptNotebookState(state);
    const remote = payloadToLocal(decryptedState);
    const local = get();
    const foldersById = new Map<string, Folder>();
    for (const folder of remote.folders) foldersById.set(folder.id, folder);
    for (const folder of local.folders) {
      if (local.dirtyFolders.has(folder.id)) foldersById.set(folder.id, folder);
    }
    for (const folderId of local.deletedFolders) foldersById.delete(folderId);

    const folderIds = new Set(foldersById.keys());
    const notesById = new Map<string, Note>();
    for (const note of remote.notes) {
      if (folderIds.has(note.folder)) notesById.set(note.id, note);
    }
    for (const note of local.notes) {
      if (!folderIds.has(note.folder) || !local.dirtyNotes.has(note.id)) continue;
      notesById.set(note.id, note);
    }
    for (const noteId of local.deletedNotes) notesById.delete(noteId);

    const folders = Array.from(foldersById.values()).sort(
        (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "zh-CN")
      );
    const notes = Array.from(notesById.values()).sort(
        (a, b) =>
          a.folder.localeCompare(b.folder) ||
          a.sortOrder - b.sortOrder ||
          b.updatedAt - a.updatedAt
      );
    const payload = {
      ...state,
      ...localToPayload(folders, notes, state.version),
    };

    const deletedImages = await invoke<string[]>("apply_remote_notebook", {
      remoteFolders: payload.folders,
      remoteNotes: payload.notes,
      version: state.version,
      clearChanges: false,
    });
    notifyNoteImagesDeleted(deletedImages);

    set({
      folders,
      notes,
      syncVersion: state.version,
    });
  },

  markSynced: async (version: number) => {
    await invoke("set_sync_version", { version });
    set({
      syncVersion: version,
      dirtyNotes: new Set<string>(),
      dirtyFolders: new Set<string>(),
      deletedNotes: new Set<string>(),
      deletedFolders: new Set<string>(),
    });
  },

  hasContent: () => get().folders.length > 0 || get().notes.length > 0,
  hasLocalChanges: () => {
    const state = get();
    return (
      state.dirtyNotes.size > 0 ||
      state.dirtyFolders.size > 0 ||
      state.deletedNotes.size > 0 ||
      state.deletedFolders.size > 0
    );
  },
}));
