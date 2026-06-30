import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import {
  ChevronRight,
  ChevronDown,
  FileText,
  FolderIcon,
  Trash2,
  Pencil,
  FilePlus,
  FolderPlus,
  FolderOpenIcon,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useNoteStore } from "@/store/useNoteStore";
import { cn } from "@/lib/utils";

/* ───────────────────────────────────────────────────────────────────
 * VSCode-style drop indicator (a thin horizontal line with end-caps
 * placed at the correct indent level).
 * ─────────────────────────────────────────────────────────────────── */
function DropIndicator({ depth, position }: { depth: number; position: "before" | "after" }) {
  return (
    <div
      className={cn(
        "absolute pointer-events-none z-20",
        "h-[2px] rounded-full bg-[var(--vscode-list-dropBackground,var(--primary,#0078d4))]",
        position === "before" ? "top-[-1px]" : "bottom-[-1px]"
      )}
      style={{
        left: `${depth * 16 + 8}px`,
        right: "0px",
      }}
    >
      {/* End-caps: two small squares at each end of the line */}
      <div
        className="absolute top-[-2px] left-0 h-[6px] w-[6px] rounded-full bg-[var(--vscode-list-dropBackground,var(--primary,#0078d4))]"
      />
      <div
        className="absolute top-[-2px] right-0 h-[6px] w-[6px] rounded-full bg-[var(--vscode-list-dropBackground,var(--primary,#0078d4))]"
      />
    </div>
  );
}

/* ─── Rename / New ─── */
function RenameDialog({
  open,
  title,
  initialValue,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  initialValue: string;
  onConfirm: (v: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (open) setValue(initialValue);
  }, [initialValue, open]);

  const confirm = () => {
    const next = value.trim();
    if (next) onConfirm(next);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-[360px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") confirm();
            if (e.key === "Escape") onCancel();
          }}
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>取消</Button>
          <Button onClick={confirm}>确认</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Confirmation ─── */
function ConfirmDialog({
  open,
  title,
  message,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onCancel()}>
      <DialogContent className="sm:max-w-[360px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{message}</p>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onCancel}>
            取消
          </Button>
          <Button variant="destructive" disabled={busy} onClick={onConfirm}>
            确认删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Context Menu ─── */
interface ContextMenuState {
  x: number;
  y: number;
  type: "folder" | "note" | "empty";
  id: string;
}

function ContextMenuFlyout({
  state,
  onClose,
  onNewNoteInFolder,
  onNewFolder,
  onRename,
  onDelete,
}: {
  state: ContextMenuState;
  onClose: () => void;
  onNewNoteInFolder: (id: string) => void;
  onNewFolder: (parentId: string | null) => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [onClose]);

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const style: React.CSSProperties = useMemo(() => {
    const menuWidth = 188;
    const menuHeight = state.type === "folder" ? 180 : state.type === "empty" ? 80 : 100;
    return {
      position: "fixed",
      left: Math.max(8, Math.min(state.x, vw - menuWidth - 8)),
      top: Math.max(8, Math.min(state.y, vh - menuHeight - 8)),
      zIndex: 9999,
    };
  }, [state.x, state.y, state.type, vw, vh]);

  const act = (fn: () => void) => {
    fn();
    onClose();
  };

  return (
    <div
      ref={menuRef}
      style={style}
      className="min-w-[170px] rounded-lg border bg-popover p-1 text-popover-foreground shadow-xl animate-in fade-in-0 zoom-in-95"
    >
      {state.type === "folder" ? (
        <>
          <button
            className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-sm hover:bg-accent"
            onClick={() => act(() => onNewNoteInFolder(state.id))}
          >
            <FilePlus className="h-4 w-4" />新建笔记
          </button>
          <button
            className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-sm hover:bg-accent"
            onClick={() => act(() => onNewFolder(state.id))}
          >
            <FolderPlus className="h-4 w-4" />新建子文件夹
          </button>
          <div className="h-px bg-border my-1" />
          <button
            className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-sm hover:bg-accent"
            onClick={() => act(() => onRename(state.id))}
          >
            <Pencil className="h-4 w-4" />重命名
          </button>
          <button
            className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-sm hover:bg-accent text-destructive"
            onClick={() => act(() => onDelete(state.id))}
          >
            <Trash2 className="h-4 w-4" />删除文件夹
          </button>
        </>
      ) : state.type === "empty" ? (
        <>
          <button
            className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-sm hover:bg-accent"
            onClick={() => act(() => onNewFolder(null))}
          >
            <FolderPlus className="h-4 w-4" />新建文件夹
          </button>
        </>
      ) : (
        <>
          <button
            className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-sm hover:bg-accent"
            onClick={() => act(() => onRename(state.id))}
          >
            <Pencil className="h-4 w-4" />重命名
          </button>
          <div className="h-px bg-border my-1" />
          <button
            className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-sm hover:bg-accent text-destructive"
            onClick={() => act(() => onDelete(state.id))}
          >
            <Trash2 className="h-4 w-4" />删除
          </button>
        </>
      )}
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────────
 * Main VSCode-style tree
 * ─────────────────────────────────────────────────────────────────── */

interface Row {
  id: string;
  type: "folder" | "note";
  depth: number;
  parentId: string | null;
  parentFolderId?: string;
  label: string;
  isExpanded?: boolean;
  isActive?: boolean;
  isPinned?: boolean;
}

interface DragState {
  id: string;
  type: "folder" | "note";
  pointerId: number;
  startX: number;
  startY: number;
  hasMoved: boolean;
}

export function TreeView() {
  const folders = useNoteStore((s) => s.folders);
  const notes = useNoteStore((s) => s.notes);
  const activeNoteId = useNoteStore((s) => s.activeNoteId);
  const expandedFolders = useNoteStore((s) => s.expandedFolders);
  const searchQuery = useNoteStore((s) => s.searchQuery);
  const setActiveNote = useNoteStore((s) => s.setActiveNote);
  const createNote = useNoteStore((s) => s.createNote);
  const deleteNote = useNoteStore((s) => s.deleteNote);
  const updateNote = useNoteStore((s) => s.updateNote);
  const reorderNote = useNoteStore((s) => s.reorderNote);
  const addFolder = useNoteStore((s) => s.addFolder);
  const renameFolder = useNoteStore((s) => s.renameFolder);
  const deleteFolder = useNoteStore((s) => s.deleteFolder);
  const moveFolderTo = useNoteStore((s) => s.moveFolderTo);
  const toggleFolder = useNoteStore((s) => s.toggleFolder);

  const [renameNoteId, setRenameNoteId] = useState<string | null>(null);
  const [renameFolderId, setRenameFolderId] = useState<string | null>(null);
  const [deleteNoteId, setDeleteNoteId] = useState<string | null>(null);
  const [deleteFolderId, setDeleteFolderId] = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderParentId, setNewFolderParentId] = useState<string | null>(null);

  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);

  // ── Drag state ──
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dropPos, setDropPos] = useState<"before" | "after" | "inside" | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const rowsRef = useRef<Row[]>([]);
  const deleteInFlightRef = useRef(false);
  const expandTimerRef = useRef<number | null>(null);

  // ── Search ──
  const query = searchQuery.toLowerCase().trim();
  const isSearching = query.length > 0;
  const matchedNotes = useMemo(() => {
    if (!isSearching) return null;
    return new Set(
      notes
        .filter((n) => n.title.toLowerCase().includes(query) || n.content.toLowerCase().includes(query))
        .map((n) => n.id)
    );
  }, [notes, query, isSearching]);

  // Pre-compute, for search mode, the set of folder IDs that must be visible
  // (ancestor-of-matched-note OR folder-name match).
  const visibleFolders = useMemo(() => {
    if (!isSearching || !matchedNotes) return null;
    const visible = new Set<string>();
    for (const f of folders) {
      if (f.name.toLowerCase().includes(query)) visible.add(f.id);
    }
    for (const n of notes) {
      if (matchedNotes.has(n.id)) visible.add(n.folder);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const f of folders) {
        if (visible.has(f.id) && f.parentId && !visible.has(f.parentId)) {
          visible.add(f.parentId);
          changed = true;
        }
      }
    }
    return visible;
  }, [isSearching, matchedNotes, folders, notes, query]);

  // ── Build flat row list (recursive) ──
  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    const childrenByParent = new Map<string | null, typeof folders>();
    for (const f of folders) {
      const arr = childrenByParent.get(f.parentId) ?? [];
      arr.push(f);
      childrenByParent.set(f.parentId, arr);
    }
    for (const arr of childrenByParent.values()) arr.sort((a, b) => a.sortOrder - b.sortOrder);

    const notesByFolder = new Map<string, typeof notes>();
    for (const n of notes) {
      const arr = notesByFolder.get(n.folder) ?? [];
      arr.push(n);
      notesByFolder.set(n.folder, arr);
    }
    for (const arr of notesByFolder.values()) arr.sort((a, b) => a.sortOrder - b.sortOrder);

    const walk = (parentId: string | null, depth: number) => {
      for (const folder of childrenByParent.get(parentId) ?? []) {
        const isExpanded = expandedFolders.has(folder.id);

        if (isSearching) {
          // During search we auto-expand every visible folder and only show matching notes.
          if (!visibleFolders?.has(folder.id)) continue;
          out.push({
            id: folder.id,
            type: "folder",
            depth,
            parentId,
            label: folder.name,
            isExpanded: true,
          });
          walk(folder.id, depth + 1);
          for (const note of notesByFolder.get(folder.id) ?? []) {
            if (!matchedNotes?.has(note.id)) continue;
            out.push({
              id: note.id,
              type: "note",
              depth: depth + 1,
              parentId: folder.id,
              parentFolderId: folder.id,
              label: note.title || "未命名笔记",
              isActive: note.id === activeNoteId,
              isPinned: note.pinned,
            });
          }
          continue;
        }

        out.push({
          id: folder.id,
          type: "folder",
          depth,
          parentId,
          label: folder.name,
          isExpanded,
        });
        if (isExpanded) {
          walk(folder.id, depth + 1);
          for (const note of notesByFolder.get(folder.id) ?? []) {
            out.push({
              id: note.id,
              type: "note",
              depth: depth + 1,
              parentId: folder.id,
              parentFolderId: folder.id,
              label: note.title || "未命名笔记",
              isActive: note.id === activeNoteId,
              isPinned: note.pinned,
            });
          }
        }
      }
    };
    walk(null, 0);
    return out;
  }, [folders, notes, expandedFolders, activeNoteId, isSearching, visibleFolders, matchedNotes]);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  // ── Drop position calculator (VSCode uses three zones on folders) ──
  const computeDropPos = useCallback(
    (clientY: number, targetId: string): "before" | "after" | "inside" => {
      const el = document.querySelector<HTMLElement>(`[data-tree-id="${targetId}"]`);
      if (!el) return "inside";
      const rect = el.getBoundingClientRect();
      const mid = rect.height / 2;
      const rel = clientY - rect.top;
      if (el.dataset.treeType === "folder") {
        // Top third → before, middle third → inside, bottom third → after
        if (rel < rect.height / 3) return "before";
        if (rel < (rect.height * 2) / 3) return "inside";
        return "after";
      }
      return rel < mid ? "before" : "after";
    },
    []
  );

  // ── Auto-expand a collapsed folder on hover while dragging ──
  const scheduleExpand = useCallback(
    (folderId: string) => {
      if (expandTimerRef.current != null) return;
      expandTimerRef.current = window.setTimeout(() => {
        expandTimerRef.current = null;
        if (useNoteStore.getState().expandedFolders.has(folderId)) return;
        toggleFolder(folderId);
      }, 450);
    },
    [toggleFolder]
  );

  const cancelExpandTimer = useCallback(() => {
    if (expandTimerRef.current != null) {
      window.clearTimeout(expandTimerRef.current);
      expandTimerRef.current = null;
    }
  }, []);

  const finishDrag = useCallback(
    (clientX: number, clientY: number) => {
      const dragged = dragRef.current;
      dragRef.current = null;
      setDragId(null);
      setDropTargetId(null);
      setDropPos(null);
      cancelExpandTimer();
      if (!dragged?.hasMoved) return;

      const el = document
        .elementFromPoint(clientX, clientY)
        ?.closest<HTMLElement>("[data-tree-id]");
      if (!el) return;
      const targetId = el.dataset.treeId;
      const targetType = el.dataset.treeType;
      if (
        !targetId ||
        (targetType !== "folder" && targetType !== "note") ||
        targetId === dragged.id
      )
        return;

      const target = rowsRef.current.find((r) => r.id === targetId && r.type === targetType);
      if (!target) return;

      const pos = computeDropPos(clientY, targetId);

      if (dragged.type === "folder") {
        const targetFolder = folders.find((f) => f.id === targetId);
        if (!targetFolder) return;

        if (pos === "inside" && targetType === "folder") {
          const childCount = folders.filter((f) => f.parentId === targetId).length;
          void moveFolderTo(dragged.id, targetId, childCount);
          return;
        }

        const targetParentId = targetFolder.parentId;
        const insertIdx =
          targetType === "folder"
            ? (() => {
                const siblings = folders
                  .filter((f) => f.parentId === targetParentId)
                  .sort((a, b) => a.sortOrder - b.sortOrder);
                const i = siblings.findIndex((f) => f.id === targetId);
                return pos === "before" ? i : i + 1;
              })()
            : (() => {
                const siblings = folders.filter((f) => f.parentId === targetParentId).sort((a, b) => a.sortOrder - b.sortOrder);
                return pos === "before" ? 0 : siblings.length;
              })();
        void moveFolderTo(dragged.id, targetParentId, Math.max(0, insertIdx));
        return;
      }

      // Note drop
      const dropFolderId =
        targetType === "folder"
          ? pos === "inside"
            ? targetId
            : (() => {
                const t = folders.find((f) => f.id === targetId);
                return t?.parentId ?? targetId;
              })()
          : target.parentFolderId!;

      if (!dropFolderId) return;

      const folderNotesInTarget = notes.filter((n) => n.folder === dropFolderId).sort((a, b) => a.sortOrder - b.sortOrder);

      if (pos === "inside" && targetType === "folder") {
        void reorderNote(dragged.id, dropFolderId, folderNotesInTarget.length);
        return;
      }

      const targetNoteIdx = targetType === "note" ? folderNotesInTarget.findIndex((n) => n.id === targetId) : -1;
      const insertAt =
        pos === "before"
          ? Math.max(0, targetNoteIdx)
          : targetNoteIdx >= 0
            ? targetNoteIdx + 1
            : folderNotesInTarget.length;
      void reorderNote(dragged.id, dropFolderId, insertAt);
    },
    [cancelExpandTimer, computeDropPos, folders, notes, moveFolderTo, reorderNote]
  );

  const onPointerDown = useCallback((e: React.PointerEvent, row: Row) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    dragRef.current = {
      id: row.id,
      type: row.type,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      hasMoved: false,
    };
    el.setPointerCapture?.(e.pointerId);

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.pointerId !== ev.pointerId) return;
      const dist = Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY);
      if (dist < 4) return;
      d.hasMoved = true;
      setDragId(d.id);

      let rowEl = document.querySelector<HTMLElement>(`[data-tree-id="${d.id}"]`);
      if (rowEl) rowEl.style.visibility = "hidden";
      const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-tree-id]");
      if (rowEl) rowEl.style.visibility = "";

      if (!under || under.dataset.treeId === d.id) {
        setDropTargetId(null);
        setDropPos(null);
        cancelExpandTimer();
        return;
      }

      const id = under.dataset.treeId!;
      const type = under.dataset.treeType as "folder" | "note";
      const pos = computeDropPos(ev.clientY, id);

      // When hovering over a collapsed folder in "inside" slot, auto-expand it
      if (type === "folder" && pos === "inside") {
        const f = useNoteStore.getState().folders.find((x) => x.id === id);
        if (f && !useNoteStore.getState().expandedFolders.has(id)) {
          scheduleExpand(id);
        }
      } else {
        cancelExpandTimer();
      }

      setDropTargetId(id);
      setDropPos(pos);
    };

    const onUp = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.pointerId !== ev.pointerId) return;
      cleanup();
      el.releasePointerCapture?.(ev.pointerId);
      if (d.hasMoved) (el as HTMLElement).dataset.dragClicked = "true";
      finishDrag(ev.clientX, ev.clientY);
    };

    const onCancel = () => {
      cleanup();
      el.releasePointerCapture?.(e.pointerId);
      dragRef.current = null;
      setDragId(null);
      setDropTargetId(null);
      setDropPos(null);
      cancelExpandTimer();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }, [cancelExpandTimer, computeDropPos, finishDrag, scheduleExpand]);

  // ── Handlers ──
  const onSelect = useCallback((id: string) => setActiveNote(id), [setActiveNote]);

  const onCtx = useCallback(
    (e: React.MouseEvent, type: "folder" | "note", id: string) => {
      e.preventDefault();
      e.stopPropagation();
      setCtxMenu({ x: e.clientX, y: e.clientY, type, id });
    },
    []
  );

  const confirmRenameNote = useCallback(
    (name: string) => {
      if (renameNoteId && name.trim()) void updateNote(renameNoteId, { title: name.trim() });
      setRenameNoteId(null);
    },
    [renameNoteId, updateNote]
  );
  const confirmRenameFolder = useCallback(
    (name: string) => {
      if (renameFolderId && name.trim()) void renameFolder(renameFolderId, name.trim());
      setRenameFolderId(null);
    },
    [renameFolderId, renameFolder]
  );

  const confirmDeleteNote = useCallback(async () => {
    if (!deleteNoteId || deleteInFlightRef.current) return;
    deleteInFlightRef.current = true;
    try {
      await deleteNote(deleteNoteId);
      setDeleteNoteId(null);
    } finally {
      deleteInFlightRef.current = false;
    }
  }, [deleteNoteId, deleteNote]);

  const confirmDeleteFolder = useCallback(async () => {
    if (!deleteFolderId || deleteInFlightRef.current) return;
    deleteInFlightRef.current = true;
    try {
      await deleteFolder(deleteFolderId);
      setDeleteFolderId(null);
    } finally {
      deleteInFlightRef.current = false;
    }
  }, [deleteFolderId, deleteFolder]);

  const handleAddFolder = useCallback(
    (name: string) => {
      if (name.trim()) void addFolder(name.trim(), newFolderParentId);
      setNewFolderOpen(false);
      setNewFolderParentId(null);
    },
    [addFolder, newFolderParentId]
  );

  return (
    <>
      <div
        className={cn(
          "flex-1 min-h-0 relative",
          dragId && "select-none"
        )}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setCtxMenu({ x: e.clientX, y: e.clientY, type: "empty", id: "" });
        }}
      >
        <ScrollArea className="h-full">
          <div className="py-1 space-y-0 relative">
            {rows.length === 0 && !isSearching && (
              <EmptyHint onCreateFolder={() => openFolderDialog(null)} />
            )}
            {rows.length === 0 && isSearching && (
              <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                无匹配结果
              </div>
            )}

            {rows.map((row) => (
              <TreeRow
                key={`${row.type}-${row.id}`}
                row={row}
                dragging={dragId === row.id}
                dropIndicator={
                  dropTargetId === row.id && dropPos !== "inside" ? dropPos : null
                }
                dropInside={dropTargetId === row.id && dropPos === "inside"}
                onSelect={onSelect}
                onToggleFolder={toggleFolder}
                onCtx={onCtx}
                onPointerDown={onPointerDown}
              />
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <ContextMenuFlyout
          state={ctxMenu}
          onClose={() => setCtxMenu(null)}
          onNewNoteInFolder={(id) => {
            setCtxMenu(null);
            void createNote(id);
          }}
          onNewFolder={(parentId) => {
            setCtxMenu(null);
            openFolderDialog(parentId ?? null);
          }}
          onRename={(id) => {
            setCtxMenu(null);
            if (ctxMenu.type === "note") setRenameNoteId(id);
            else setRenameFolderId(id);
          }}
          onDelete={(id) => {
            setCtxMenu(null);
            if (ctxMenu.type === "note") setDeleteNoteId(id);
            else setDeleteFolderId(id);
          }}
        />
      )}

      <RenameDialog
        open={renameNoteId !== null}
        title="重命名笔记"
        initialValue={notes.find((n) => n.id === renameNoteId)?.title ?? ""}
        onConfirm={confirmRenameNote}
        onCancel={() => setRenameNoteId(null)}
      />
      <RenameDialog
        open={renameFolderId !== null}
        title="重命名文件夹"
        initialValue={folders.find((f) => f.id === renameFolderId)?.name ?? ""}
        onConfirm={confirmRenameFolder}
        onCancel={() => setRenameFolderId(null)}
      />
      <RenameDialog
        open={newFolderOpen}
        title={newFolderParentId ? "新建子文件夹" : "新建文件夹"}
        initialValue=""
        onConfirm={handleAddFolder}
        onCancel={() => {
          setNewFolderOpen(false);
          setNewFolderParentId(null);
        }}
      />

      <ConfirmDialog
        open={deleteNoteId !== null}
        title="删除笔记"
        message={
          deleteNoteId
            ? `确定要删除「${notes.find((n) => n.id === deleteNoteId)?.title || ""}」吗？此操作无法撤销。`
            : ""
        }
        onConfirm={confirmDeleteNote}
        onCancel={() => setDeleteNoteId(null)}
      />
      <ConfirmDialog
        open={deleteFolderId !== null}
        title="删除文件夹"
        message={
          deleteFolderId
            ? `确定要删除文件夹「${folders.find((f) => f.id === deleteFolderId)?.name || ""}」及其所有子内容吗？此操作无法撤销。`
            : ""
        }
        onConfirm={confirmDeleteFolder}
        onCancel={() => setDeleteFolderId(null)}
      />
    </>
  );

  function openFolderDialog(parentId: string | null) {
    setNewFolderParentId(parentId);
    setNewFolderOpen(true);
  }
}

function TreeRow({
  row,
  dragging,
  dropIndicator,
  dropInside,
  onSelect,
  onToggleFolder,
  onCtx,
  onPointerDown,
}: {
  row: Row;
  dragging: boolean;
  dropIndicator: "before" | "after" | null;
  dropInside: boolean;
  onSelect: (id: string) => void;
  onToggleFolder: (id: string) => void;
  onCtx: (e: React.MouseEvent, type: "folder" | "note", id: string) => void;
  onPointerDown: (e: React.PointerEvent, row: Row) => void;
}) {
  const isFolder = row.type === "folder";
  const Icon = isFolder ? (row.isExpanded ? FolderOpenIcon : FolderIcon) : FileText;

  return (
    <div
      data-tree-id={row.id}
      data-tree-type={row.type}
      onContextMenu={(e) => onCtx(e, row.type, row.id)}
      onClick={(e) => {
        const el = e.currentTarget;
        if (el.dataset.dragClicked === "true") {
          delete el.dataset.dragClicked;
          return;
        }
        if (isFolder) onToggleFolder(row.id);
        else onSelect(row.id);
      }}
      onPointerDown={(e) => onPointerDown(e, row)}
      className={cn(
        "group relative flex items-center gap-1 px-1 py-[2px] rounded-[3px] cursor-pointer text-sm select-none touch-none",
        "transition-colors duration-75",
        row.isActive && "bg-[var(--vscode-list-activeSelectionBackground,var(--accent,#094771))] text-[var(--vscode-list-activeSelectionForeground,var(--accent-foreground,#fff))]",
        !row.isActive && "hover:bg-[var(--vscode-list-hoverBackground,hsl(var(--accent)/0.4))]",
        dragging && "opacity-40",
        dropInside &&
          isFolder &&
          "bg-[var(--vscode-list-dropBackground,hsl(var(--primary)/15%,#0078d426))]"
      )}
      style={{ paddingLeft: `${8 + row.depth * 16}px` }}
    >
      {/* Drop indicator line — rendered as an absolutely-positioned sibling. */}
      {dropIndicator && (
        <DropIndicator depth={row.depth} position={dropIndicator} />
      )}

      {/* Chevron */}
      <span className="w-4 flex items-center justify-center shrink-0">
        {isFolder ? (
          row.isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
          )
        ) : (
          <span className="w-3.5" />
        )}
      </span>

      {/* Icon */}
      <Icon
        className={cn(
          "h-[18px] w-[18px] shrink-0",
          isFolder ? "text-sky-400 dark:text-sky-500" : row.isPinned ? "text-amber-500" : "text-foreground/65"
        )}
      />

      {/* Label */}
      <span className="flex-1 truncate text-[13px] leading-tight">{row.label}</span>
    </div>
  );
}

function EmptyHint({ onCreateFolder }: { onCreateFolder: () => void }) {
  return (
    <div className="px-3 py-6 flex flex-col items-center gap-2 text-muted-foreground">
      <FolderPlus className="h-6 w-6 opacity-40" />
      <p className="text-xs">还没有文件夹</p>
      <Button
        variant="outline"
        size="xs"
        className="h-7 text-xs gap-1 mt-1"
        onClick={onCreateFolder}
      >
        <FolderPlus className="h-3 w-3" />
        新建文件夹
      </Button>
    </div>
  );
}
