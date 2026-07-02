// Shared protocol types matching orange-notes-server/src/sync.rs

import type { AiPermission } from "@/types/note";

export interface RemoteFolder {
  id: string;
  name: string;
  sort_order: number;
  parent_id: string | null;
  updated_at: number;
  ai_permission: AiPermission;
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
  ai_permission: AiPermission;
}

export interface RemoteNotebookState {
  folders: RemoteFolder[];
  notes: RemoteNote[];
  version: number;
  deleted_note_ids?: string[];
  deleted_folder_ids?: string[];
}

export type ClientMessage =
  | { type: "authenticate"; username: string; password: string }
  | { type: "push"; state: RemoteNotebookState; base_version: number };

export interface RemoteAttachmentMeta {
  file_name: string;
  mime: string;
}

export type ServerMessage =
  | { type: "welcome"; session_id: string }
  | { type: "authenticated" }
  | { type: "authentication_failed" }
  | { type: "push_ack"; version: number }
  | { type: "push_rejected"; state: RemoteNotebookState; attachments: RemoteAttachmentMeta[] }
  | { type: "error"; message: string }
  | { type: "state"; state: RemoteNotebookState; attachments: RemoteAttachmentMeta[] };
