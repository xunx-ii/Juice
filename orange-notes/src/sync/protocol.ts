// Shared protocol types matching orange-notes-server/src/sync.rs

import type { AiPermission } from "@/types/note";

export interface RemoteEncryptionMeta {
  enabled: boolean;
  version: number;
  algorithm: "AES-GCM";
  kdf: "PBKDF2-SHA256";
  salt: string;
  iterations: number;
  key_check_iv: string;
  key_check: string;
}

export function isRemoteEncryptionMeta(value: unknown): value is RemoteEncryptionMeta {
  const candidate = value as Partial<RemoteEncryptionMeta> | null;
  return Boolean(
    candidate &&
      candidate.enabled === true &&
      candidate.version === 1 &&
      candidate.algorithm === "AES-GCM" &&
      candidate.kdf === "PBKDF2-SHA256" &&
      typeof candidate.salt === "string" &&
      typeof candidate.iterations === "number" &&
      typeof candidate.key_check_iv === "string" &&
      typeof candidate.key_check === "string"
  );
}

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
  encryption?: RemoteEncryptionMeta | null;
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
