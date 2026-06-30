export interface Note {
  id: string;
  title: string;
  content: string;
  folder: string;
  createdAt: number;
  updatedAt: number;
  sortOrder: number;
  pinned: boolean;
  favorite: boolean;
}

export interface Folder {
  id: string;
  name: string;
  sortOrder: number;
  parentId: string | null;
}

/** A fully-resolved node in the sidebar tree. Folders and notes share this shape. */
export interface TreeNode {
  /** Folder id or Note id. */
  id: string;
  type: "folder" | "note";
  depth: number;
  parentId: string | null;
  label: string;
  sortOrder: number;
  isExpanded?: boolean;
  isActive?: boolean;
  isPinned?: boolean;

  /** Tree-walk state used by drag & drop. */
  /** When the pointer is hovering to drop "before" this item. */
  dropBefore?: boolean;
  /** When the pointer is hovering to drop "after" this item. */
  dropAfter?: boolean;
  /** When the pointer is hovering to drop "inside" this folder. */
  dropInside?: boolean;
}
