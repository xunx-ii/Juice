// Shared protocol types matching orange-notes-server/src/sync.rs

export interface RemoteFolder {
  id: string;
  name: string;
  sort_order: number;
  parent_id: string | null;
  updated_at: number;
}

export interface RemoteNote {
  id: string;
  title: string;
  content: string;
  folder: string;
  created_at: number;
  updated_at: number;
  sort_order: number;
  pinned: boolean;
  favorite: boolean;
}

export interface RemoteDeletedChange {
  entity_type: "folder" | "note";
  id: string;
  deleted_at: number;
}

export interface RemoteNotebookState {
  folders: RemoteFolder[];
  notes: RemoteNote[];
  deleted: RemoteDeletedChange[];
  version: number;
}

export type ClientMessage =
  | { type: "authenticate"; username: string; password: string }
  | { type: "push"; state: RemoteNotebookState }
  | { type: "request_state" };

export interface RemoteAttachmentMeta {
  file_name: string;
  mime: string;
}

export type ServerMessage =
  | { type: "welcome"; session_id: string }
  | { type: "authenticated" }
  | { type: "authentication_failed" }
  | { type: "push_ack"; version: number }
  | { type: "error"; message: string }
  | { type: "state"; state: RemoteNotebookState; attachments: RemoteAttachmentMeta[] };
