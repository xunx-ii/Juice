import { create } from "zustand";
import { useNoteStore } from "@/store/useNoteStore";

interface UIState {
  /** Currently selected row — may be a note (default) or folder. */
  selectedNodeId: string | null;
  selectedNodeIsFolder: boolean;
  selectNode: (id: string | null, isFolder?: boolean) => void;

  /** Drop indicator state for drag & drop animations. */
  dropTargetId: string | null;
  /** Determines the positioning of the drop indicator:
   *   "before" → line on top edge of target row
   *   "after"  → line on bottom edge of target row
   *   "inside" → filled highlight across the whole row
   */
  dropPosition: "before" | "after" | "inside" | null;
  setDropTarget: (
    id: string | null,
    position?: "before" | "after" | "inside" | null
  ) => void;

  /** Drag lifecycle. */
  dragNodeId: string | null;
  setDragNodeId: (id: string | null) => void;

  /** Visibility hint: when the tree is entirely empty show a "new folder" hint. */
  showEmptyHint: boolean;
  setShowEmptyHint: (v: boolean) => void;
}

export const useStateStore = create<UIState>((set) => ({
  selectedNodeId: null,
  selectedNodeIsFolder: false,
  selectNode: (id, isFolder = false) =>
    set({ selectedNodeId: id, selectedNodeIsFolder: isFolder }),

  dropTargetId: null,
  dropPosition: null,
  setDropTarget: (id, position = null) =>
    set({ dropTargetId: id, dropPosition: position }),

  dragNodeId: null,
  setDragNodeId: (id) => set({ dragNodeId: id }),

  showEmptyHint: true,
  setShowEmptyHint: (v) => set({ showEmptyHint: v }),
}));
