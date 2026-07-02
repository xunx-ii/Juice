use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_clipboard_manager::ClipboardExt;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
enum AppError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("path error: {0}")]
    Path(String),
    #[error("invalid image data")]
    InvalidImageData,
    #[error("clipboard error: {0}")]
    Clipboard(String),
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Folder {
    id: String,
    name: String,
    sort_order: i64,
    parent_id: Option<String>,
    ai_permission: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Note {
    id: String,
    title: String,
    content: String,
    folder: String,
    created_at: i64,
    updated_at: i64,
    sort_order: i64,
    pinned: bool,
    favorite: bool,
    ai_permission: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotebookData {
    folders: Vec<Folder>,
    notes: Vec<Note>,
    sync_version: i64,
    dirty_notes: Vec<String>,
    dirty_folders: Vec<String>,
    deleted_notes: Vec<String>,
    deleted_folders: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotePatch {
    title: Option<String>,
    content: Option<String>,
    folder: Option<String>,
    sort_order: Option<i64>,
    pinned: Option<bool>,
    favorite: Option<bool>,
    ai_permission: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredImage {
    file_name: String,
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImagePayload {
    mime: String,
    bytes: Vec<u8>,
}

struct AppState {
    db: Mutex<Connection>,
    img_dir: PathBuf,
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn generate_id() -> String {
    format!("id-{}", Uuid::new_v4().simple())
}

fn extract_image_file_names(content: &str) -> HashSet<String> {
    let mut names = HashSet::new();
    let mut rest = content;
    while let Some(start) = rest.find("![[") {
        let after_start = &rest[start + 3..];
        let Some(end) = after_start.find("]]") else {
            break;
        };
        let file_name = after_start[..end].trim();
        if !file_name.is_empty()
            && !file_name.contains('/')
            && !file_name.contains('\\')
            && !file_name.contains('\n')
            && !file_name.contains('\r')
        {
            names.insert(file_name.to_string());
        }
        rest = &after_start[end + 2..];
    }
    names
}

fn normalize_ai_permission(permission: &str) -> &str {
    match permission {
        "read" | "write" | "none" => permission,
        _ => "write",
    }
}

fn cleanup_unreferenced_images(
    conn: &Connection,
    img_dir: &PathBuf,
    candidates: HashSet<String>,
) -> Result<Vec<String>, AppError> {
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let mut referenced = HashSet::new();
    let mut stmt = conn.prepare("SELECT content FROM notes")?;
    let contents = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for content in contents {
        referenced.extend(extract_image_file_names(&content));
    }

    let canonical_img = img_dir.canonicalize()?;
    let mut deleted = Vec::new();
    for file_name in candidates.difference(&referenced) {
        let path = img_dir.join(file_name);
        let Ok(canonical_path) = path.canonicalize() else {
            continue;
        };
        if canonical_path.starts_with(&canonical_img) {
            match fs::remove_file(&canonical_path) {
                Ok(()) => deleted.push(file_name.clone()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(AppError::Io(error)),
            }
        }
    }

    Ok(deleted)
}

fn local_image_file_names(img_dir: &PathBuf) -> Result<HashSet<String>, AppError> {
    let mut names = HashSet::new();
    for entry in fs::read_dir(img_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let Some(file_name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !file_name.is_empty() && !file_name.contains('/') && !file_name.contains('\\') {
            names.insert(file_name);
        }
    }
    Ok(names)
}

fn executable_data_dir() -> Result<PathBuf, AppError> {
    let exe = std::env::current_exe()?;
    let parent = exe
        .parent()
        .ok_or_else(|| AppError::Path("failed to resolve executable directory".to_string()))?;
    Ok(parent.to_path_buf())
}

fn executable_img_dir() -> Result<PathBuf, AppError> {
    let parent = executable_data_dir()?;
    let img_dir = parent.join("img");
    fs::create_dir_all(&img_dir)?;
    Ok(img_dir)
}

fn init_schema(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS folders (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          sort_order INTEGER NOT NULL,
          parent_id TEXT,
          ai_permission TEXT NOT NULL DEFAULT 'write'
        );

        CREATE TABLE IF NOT EXISTS notes (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          folder TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          sort_order INTEGER NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0,
          favorite INTEGER NOT NULL DEFAULT 0,
          ai_permission TEXT NOT NULL DEFAULT 'write',
          FOREIGN KEY(folder) REFERENCES folders(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS sync_meta (
          key TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sync_changes (
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          PRIMARY KEY (entity_type, entity_id, operation)
        );
        ",
    )?;
    ensure_text_column(conn, "folders", "ai_permission", "'write'")?;
    ensure_text_column(conn, "notes", "ai_permission", "'write'")?;
    Ok(())
}

fn ensure_text_column(
    conn: &Connection,
    table: &str,
    column: &str,
    default_value: &str,
) -> Result<(), AppError> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let exists = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .any(|name| name == column);
    if !exists {
        conn.execute(
            &format!(
                "ALTER TABLE {table} ADD COLUMN {column} TEXT NOT NULL DEFAULT {default_value}"
            ),
            [],
        )?;
    }
    Ok(())
}

#[tauri::command]
fn apply_remote_notebook(
    state: tauri::State<'_, AppState>,
    remote_folders: Vec<RemoteFolderArg>,
    remote_notes: Vec<RemoteNoteArg>,
    version: i64,
    clear_changes: bool,
) -> Result<Vec<String>, AppError> {
    let mut conn = state.db.lock().expect("database mutex poisoned");
    let previous_images = {
        let mut stmt = conn.prepare("SELECT content FROM notes")?;
        let contents = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut images = HashSet::new();
        for content in contents {
            images.extend(extract_image_file_names(&content));
        }
        images
    };

    let mut remote_images = HashSet::new();
    for note in &remote_notes {
        remote_images.extend(extract_image_file_names(&note.content));
    }
    let removed_images = previous_images
        .difference(&remote_images)
        .cloned()
        .collect::<HashSet<_>>();
    let mut cleanup_candidates = removed_images;
    for file_name in local_image_file_names(&state.img_dir)? {
        if !remote_images.contains(&file_name) {
            cleanup_candidates.insert(file_name);
        }
    }

    let tx = conn.transaction()?;

    tx.execute("DELETE FROM notes", [])?;
    tx.execute("DELETE FROM folders", [])?;

    for f in &remote_folders {
        tx.execute(
            "INSERT INTO folders (id, name, sort_order, parent_id, ai_permission)
             VALUES ($1, $2, $3, $4, $5)",
            params![
                f.id,
                f.name,
                f.sort_order,
                f.parent_id,
                normalize_ai_permission(f.ai_permission.as_deref().unwrap_or("write"))
            ],
        )?;
    }

    for n in &remote_notes {
        tx.execute(
            "INSERT INTO notes (id, title, content, folder, created_at, updated_at, sort_order, pinned, favorite, ai_permission)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
            params![
                n.id,
                n.title,
                n.content,
                n.folder,
                n.created_at,
                n.updated_at,
                n.sort_order,
                n.pinned as i64,
                n.favorite as i64,
                normalize_ai_permission(n.ai_permission.as_deref().unwrap_or("write"))
            ],
        )?;
    }

    tx.execute(
        "INSERT INTO sync_meta (key, value)
         VALUES ('notebook_version', $1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![version],
    )?;
    if clear_changes {
        tx.execute("DELETE FROM sync_changes", [])?;
    }
    tx.commit()?;
    cleanup_unreferenced_images(&conn, &state.img_dir, cleanup_candidates)
}

#[tauri::command]
fn set_sync_version(state: tauri::State<'_, AppState>, version: i64) -> Result<(), AppError> {
    let mut conn = state.db.lock().expect("database mutex poisoned");
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO sync_meta (key, value)
         VALUES ('notebook_version', $1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![version],
    )?;
    tx.execute("DELETE FROM sync_changes", [])?;
    tx.commit()?;
    Ok(())
}

#[tauri::command]
fn set_sync_markers(
    state: tauri::State<'_, AppState>,
    dirty_notes: Vec<String>,
    dirty_folders: Vec<String>,
    deleted_notes: Vec<String>,
    deleted_folders: Vec<String>,
) -> Result<(), AppError> {
    let mut conn = state.db.lock().expect("database mutex poisoned");
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM sync_changes", [])?;

    for id in dirty_notes {
        tx.execute(
            "INSERT INTO sync_changes (entity_type, entity_id, operation) VALUES ('note', $1, 'dirty')",
            params![id],
        )?;
    }
    for id in dirty_folders {
        tx.execute(
            "INSERT INTO sync_changes (entity_type, entity_id, operation) VALUES ('folder', $1, 'dirty')",
            params![id],
        )?;
    }
    for id in deleted_notes {
        tx.execute(
            "INSERT INTO sync_changes (entity_type, entity_id, operation) VALUES ('note', $1, 'deleted')",
            params![id],
        )?;
    }
    for id in deleted_folders {
        tx.execute(
            "INSERT INTO sync_changes (entity_type, entity_id, operation) VALUES ('folder', $1, 'deleted')",
            params![id],
        )?;
    }

    tx.commit()?;
    Ok(())
}

#[derive(Debug, Deserialize)]
struct RemoteFolderArg {
    id: String,
    name: String,
    sort_order: i64,
    parent_id: Option<String>,
    ai_permission: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RemoteNoteArg {
    id: String,
    title: String,
    content: String,
    folder: String,
    created_at: i64,
    updated_at: i64,
    sort_order: i64,
    pinned: bool,
    favorite: bool,
    ai_permission: Option<String>,
}

fn read_all(conn: &Connection) -> Result<NotebookData, AppError> {
    let mut folders_stmt = conn.prepare(
        "SELECT id, name, sort_order, parent_id, ai_permission
         FROM folders
         ORDER BY sort_order ASC",
    )?;
    let folders = folders_stmt
        .query_map([], |row| {
            Ok(Folder {
                id: row.get(0)?,
                name: row.get(1)?,
                sort_order: row.get(2)?,
                parent_id: row.get(3)?,
                ai_permission: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut notes_stmt = conn.prepare(
        "SELECT id, title, content, folder, created_at, updated_at, sort_order, pinned, favorite, ai_permission
         FROM notes
         ORDER BY folder ASC, sort_order ASC, updated_at DESC",
    )?;
    let notes = notes_stmt
        .query_map([], |row| {
            Ok(Note {
                id: row.get(0)?,
                title: row.get(1)?,
                content: row.get(2)?,
                folder: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                sort_order: row.get(6)?,
                pinned: row.get::<_, i64>(7)? != 0,
                favorite: row.get::<_, i64>(8)? != 0,
                ai_permission: row.get(9)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let sync_version = conn
        .query_row(
            "SELECT value FROM sync_meta WHERE key = 'notebook_version'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0);

    let read_changes = |entity_type: &str, operation: &str| -> Result<Vec<String>, AppError> {
        let mut stmt = conn.prepare(
            "SELECT entity_id FROM sync_changes WHERE entity_type = $1 AND operation = $2 ORDER BY entity_id ASC",
        )?;
        let rows = stmt
            .query_map(params![entity_type, operation], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    };

    Ok(NotebookData {
        folders,
        notes,
        sync_version,
        dirty_notes: read_changes("note", "dirty")?,
        dirty_folders: read_changes("folder", "dirty")?,
        deleted_notes: read_changes("note", "deleted")?,
        deleted_folders: read_changes("folder", "deleted")?,
    })
}

#[tauri::command]
fn load_notebook(state: tauri::State<'_, AppState>) -> Result<NotebookData, AppError> {
    let conn = state.db.lock().expect("database mutex poisoned");
    read_all(&conn)
}

#[tauri::command]
fn create_note(state: tauri::State<'_, AppState>, folder_id: String) -> Result<Note, AppError> {
    let conn = state.db.lock().expect("database mutex poisoned");
    let max_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) FROM notes WHERE folder = $1",
        params![folder_id],
        |row| row.get(0),
    )?;
    let now = now_millis();
    let note = Note {
        id: generate_id(),
        title: "未命名笔记".to_string(),
        content: String::new(),
        folder: folder_id,
        created_at: now,
        updated_at: now,
        sort_order: max_order + 1,
        pinned: false,
        favorite: false,
        ai_permission: "write".to_string(),
    };
    conn.execute(
        "INSERT INTO notes (id, title, content, folder, created_at, updated_at, sort_order, pinned, favorite, ai_permission)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        params![
            note.id,
            note.title,
            note.content,
            note.folder,
            note.created_at,
            note.updated_at,
            note.sort_order,
            note.pinned as i64,
            note.favorite as i64,
            note.ai_permission
        ],
    )?;
    Ok(note)
}

#[tauri::command]
fn delete_note(state: tauri::State<'_, AppState>, id: String) -> Result<Vec<String>, AppError> {
    let conn = state.db.lock().expect("database mutex poisoned");
    let content = conn
        .query_row(
            "SELECT content FROM notes WHERE id = $1",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_default();
    let candidates = extract_image_file_names(&content);
    conn.execute("DELETE FROM notes WHERE id = $1", params![id])?;
    cleanup_unreferenced_images(&conn, &state.img_dir, candidates)
}

#[tauri::command]
fn update_note(
    state: tauri::State<'_, AppState>,
    id: String,
    patch: NotePatch,
) -> Result<Vec<String>, AppError> {
    let conn = state.db.lock().expect("database mutex poisoned");
    let existing: Note = conn.query_row(
        "SELECT id, title, content, folder, created_at, updated_at, sort_order, pinned, favorite, ai_permission FROM notes WHERE id = $1",
        params![id],
        |row| {
            Ok(Note {
                id: row.get(0)?,
                title: row.get(1)?,
                content: row.get(2)?,
                folder: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                sort_order: row.get(6)?,
                pinned: row.get::<_, i64>(7)? != 0,
                favorite: row.get::<_, i64>(8)? != 0,
                ai_permission: row.get(9)?,
            })
        },
    )?;

    let old_images = extract_image_file_names(&existing.content);
    let next_content = patch.content.unwrap_or(existing.content);
    let new_images = extract_image_file_names(&next_content);
    let removed_images = old_images
        .difference(&new_images)
        .cloned()
        .collect::<HashSet<_>>();

    conn.execute(
        "UPDATE notes
         SET title = $1, content = $2, folder = $3, updated_at = $4, sort_order = $5, pinned = $6, favorite = $7, ai_permission = $8
         WHERE id = $9",
        params![
            patch.title.unwrap_or(existing.title),
            next_content,
            patch.folder.unwrap_or(existing.folder),
            now_millis(),
            patch.sort_order.unwrap_or(existing.sort_order),
            patch.pinned.unwrap_or(existing.pinned) as i64,
            patch.favorite.unwrap_or(existing.favorite) as i64,
            normalize_ai_permission(
                patch
                    .ai_permission
                    .as_deref()
                    .unwrap_or(existing.ai_permission.as_str()),
            ),
            existing.id
        ],
    )?;
    cleanup_unreferenced_images(&conn, &state.img_dir, removed_images)
}

#[tauri::command]
fn reorder_note(
    state: tauri::State<'_, AppState>,
    note_id: String,
    target_folder_id: String,
    target_index: i64,
) -> Result<NotebookData, AppError> {
    let conn = state.db.lock().expect("database mutex poisoned");
    let source_folder_id: String = conn.query_row(
        "SELECT folder FROM notes WHERE id = $1",
        params![note_id],
        |row| row.get(0),
    )?;

    if source_folder_id != target_folder_id {
        let source_ids = {
            let mut source_stmt = conn.prepare(
                "SELECT id FROM notes WHERE folder = $1 AND id != $2 ORDER BY sort_order ASC",
            )?;
            let ids = source_stmt
                .query_map(params![source_folder_id, note_id], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<Result<Vec<_>, _>>()?;
            ids
        };
        for (index, id) in source_ids.iter().enumerate() {
            conn.execute(
                "UPDATE notes SET sort_order = $1 WHERE id = $2",
                params![index as i64, id],
            )?;
        }
    }

    let mut target_ids = {
        let mut target_stmt = conn.prepare(
            "SELECT id FROM notes WHERE folder = $1 AND id != $2 ORDER BY sort_order ASC",
        )?;
        let ids = target_stmt
            .query_map(params![target_folder_id, note_id], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        ids
    };
    let insert_at = target_index.clamp(0, target_ids.len() as i64) as usize;
    target_ids.insert(insert_at, note_id);

    for (index, id) in target_ids.iter().enumerate() {
        conn.execute(
            "UPDATE notes SET folder = $1, sort_order = $2 WHERE id = $3",
            params![target_folder_id, index as i64, id],
        )?;
    }

    read_all(&conn)
}

#[tauri::command]
fn create_folder(
    state: tauri::State<'_, AppState>,
    name: String,
    parent_id: Option<String>,
) -> Result<Folder, AppError> {
    let conn = state.db.lock().expect("database mutex poisoned");
    // SQLite compares NULLs as not-equal, so we need two queries (or a
    // COALESCE sentinel). We use a sentinel string for the root level.
    let max_order: i64 = if parent_id.is_none() {
        conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) FROM folders WHERE parent_id IS NULL",
            [],
            |row| row.get(0),
        )?
    } else {
        conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) FROM folders WHERE parent_id = $1",
            params![parent_id],
            |row| row.get(0),
        )?
    };
    let folder = Folder {
        id: generate_id(),
        name,
        sort_order: max_order + 1,
        parent_id,
        ai_permission: "write".to_string(),
    };
    conn.execute(
        "INSERT INTO folders (id, name, sort_order, parent_id, ai_permission)
         VALUES ($1, $2, $3, $4, $5)",
        params![
            folder.id,
            folder.name,
            folder.sort_order,
            folder.parent_id,
            folder.ai_permission
        ],
    )?;
    Ok(folder)
}

#[tauri::command]
fn rename_folder(
    state: tauri::State<'_, AppState>,
    id: String,
    name: String,
) -> Result<(), AppError> {
    let conn = state.db.lock().expect("database mutex poisoned");
    conn.execute(
        "UPDATE folders SET name = $1 WHERE id = $2",
        params![name, id],
    )?;
    Ok(())
}

#[tauri::command]
fn update_folder_permission(
    state: tauri::State<'_, AppState>,
    id: String,
    ai_permission: String,
) -> Result<(), AppError> {
    let conn = state.db.lock().expect("database mutex poisoned");
    let ai_permission = normalize_ai_permission(&ai_permission);
    conn.execute(
        "UPDATE folders SET ai_permission = $1 WHERE id = $2",
        params![ai_permission, id],
    )?;
    Ok(())
}

#[tauri::command]
fn delete_folder(state: tauri::State<'_, AppState>, id: String) -> Result<NotebookData, AppError> {
    let conn = state.db.lock().expect("database mutex poisoned");
    let mut folder_ids = Vec::new();
    let mut folder_queue = vec![id.clone()];
    let mut seen_folder_ids = HashSet::new();
    while let Some(parent_id) = folder_queue.pop() {
        if !seen_folder_ids.insert(parent_id.clone()) {
            continue;
        }
        folder_ids.push(parent_id.clone());

        let child_ids = {
            let mut stmt = conn.prepare("SELECT id FROM folders WHERE parent_id = $1")?;
            let rows = stmt
                .query_map(params![parent_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        folder_queue.extend(child_ids);
    }

    let mut candidates = HashSet::new();
    for folder_id in &folder_ids {
        let mut stmt = conn.prepare("SELECT content FROM notes WHERE folder = $1")?;
        let contents = stmt
            .query_map(params![folder_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        for content in contents {
            candidates.extend(extract_image_file_names(&content));
        }
    }

    for folder_id in folder_ids.iter().rev() {
        conn.execute("DELETE FROM notes WHERE folder = $1", params![folder_id])?;
        conn.execute("DELETE FROM folders WHERE id = $1", params![folder_id])?;
    }
    let _ = cleanup_unreferenced_images(&conn, &state.img_dir, candidates)?;
    read_all(&conn)
}

/// Move a folder under a new parent (or to root when target_parent_id is null),
/// at the given sort index among that parent's direct children.
#[tauri::command]
fn move_folder(
    state: tauri::State<'_, AppState>,
    folder_id: String,
    target_parent_id: Option<String>,
    target_index: i64,
) -> Result<NotebookData, AppError> {
    let conn = state.db.lock().expect("database mutex poisoned");

    // Reject move into self.
    if target_parent_id.as_ref() == Some(&folder_id) {
        return Err(AppError::Path("cannot move folder into itself".into()));
    }

    // Reject move into a descendant — walk up from the target parent and
    // ensure we never encounter the folder being moved.
    if let Some(ref target) = target_parent_id {
        let mut current = target.clone();
        loop {
            if current == folder_id {
                return Err(AppError::Path(
                    "cannot move folder into its own descendant".into(),
                ));
            }
            let parent: Option<String> = conn.query_row(
                "SELECT parent_id FROM folders WHERE id = $1",
                params![current],
                |row| row.get(0),
            )?;
            match parent {
                Some(p) => current = p,
                None => break,
            }
        }
    }

    // Update the folder's parent and assign an initial sort_order (will be
    // recomputed below within the target parent's child group).
    conn.execute(
        "UPDATE folders SET parent_id = $1, sort_order = $2 WHERE id = $3",
        params![target_parent_id.clone(), target_index, folder_id],
    )?;

    // Re-sort siblings in the new parent group.
    let sibling_ids: Vec<String> = if target_parent_id.is_none() {
        conn.prepare(
            "SELECT id FROM folders WHERE id != $1 AND parent_id IS NULL ORDER BY sort_order ASC, name ASC",
        )?
        .query_map(params![folder_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?
    } else {
        conn.prepare(
            "SELECT id FROM folders WHERE id != $1 AND parent_id = $2 ORDER BY sort_order ASC, name ASC",
        )?
        .query_map(params![folder_id, target_parent_id.clone()], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?
    };
    let insert_at = target_index.clamp(0, sibling_ids.len() as i64) as usize;
    let mut sorted = sibling_ids;
    sorted.insert(insert_at, folder_id);
    for (index, id) in sorted.iter().enumerate() {
        conn.execute(
            "UPDATE folders SET sort_order = $1 WHERE id = $2",
            params![index as i64, id],
        )?;
    }

    read_all(&conn)
}

#[tauri::command]
fn reorder_folder(
    state: tauri::State<'_, AppState>,
    folder_id: String,
    target_index: i64,
) -> Result<NotebookData, AppError> {
    let conn = state.db.lock().expect("database mutex poisoned");
    let mut folder_ids = {
        let mut stmt =
            conn.prepare("SELECT id FROM folders WHERE id != $1 ORDER BY sort_order ASC")?;
        let ids = stmt
            .query_map(params![folder_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids
    };
    let insert_at = target_index.clamp(0, folder_ids.len() as i64) as usize;
    folder_ids.insert(insert_at, folder_id);

    for (index, id) in folder_ids.iter().enumerate() {
        conn.execute(
            "UPDATE folders SET sort_order = $1 WHERE id = $2",
            params![index as i64, id],
        )?;
    }

    read_all(&conn)
}

fn extension_from_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/bmp" => Some("bmp"),
        "image/svg+xml" => Some("svg"),
        _ => None,
    }
}

fn mime_from_file_name(file_name: &str) -> &'static str {
    let ext = file_name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

#[tauri::command]
fn save_clipboard_image(
    state: tauri::State<'_, AppState>,
    mime: String,
    base64_data: String,
) -> Result<StoredImage, AppError> {
    let ext = extension_from_mime(&mime).ok_or(AppError::InvalidImageData)?;
    let bytes = STANDARD
        .decode(base64_data)
        .map_err(|_| AppError::InvalidImageData)?;
    if bytes.is_empty() {
        return Err(AppError::InvalidImageData);
    }

    let hash = Sha256::digest(&bytes);
    let file_name = format!("{hash:x}.{ext}");
    let path = state.img_dir.join(&file_name);
    if !path.exists() {
        fs::write(&path, bytes)?;
    }
    let path = path.canonicalize()?;

    Ok(StoredImage {
        file_name,
        path: path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn load_note_image(
    state: tauri::State<'_, AppState>,
    file_name: String,
) -> Result<ImagePayload, AppError> {
    let path = state.img_dir.join(&file_name);
    let canonical_img = state.img_dir.canonicalize()?;
    let canonical_path = path.canonicalize()?;
    if !canonical_path.starts_with(canonical_img) {
        return Err(AppError::Path(
            "image path escaped img directory".to_string(),
        ));
    }

    Ok(ImagePayload {
        mime: mime_from_file_name(&file_name).to_string(),
        bytes: fs::read(canonical_path)?,
    })
}

/// Read a local image file as raw bytes (for uploading to the server).
#[tauri::command]
fn read_note_image_bytes(
    state: tauri::State<'_, AppState>,
    file_name: String,
) -> Result<Vec<u8>, AppError> {
    let path = state.img_dir.join(&file_name);
    let canonical_img = state.img_dir.canonicalize()?;
    let canonical_path = path.canonicalize()?;
    if !canonical_path.starts_with(canonical_img) {
        return Err(AppError::Path(
            "image path escaped img directory".to_string(),
        ));
    }
    Ok(fs::read(canonical_path)?)
}

/// Check if a local image file exists (without reading it).
#[tauri::command]
fn image_file_exists(
    state: tauri::State<'_, AppState>,
    file_name: String,
) -> Result<bool, AppError> {
    if file_name.contains('/') || file_name.contains('\\') || file_name.is_empty() {
        return Ok(false);
    }
    let path = state.img_dir.join(&file_name);
    Ok(path.exists())
}

#[tauri::command]
fn cleanup_unreferenced_note_images(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, AppError> {
    let conn = state.db.lock().expect("database mutex poisoned");
    cleanup_unreferenced_images(
        &conn,
        &state.img_dir,
        local_image_file_names(&state.img_dir)?,
    )
}

/// Save a downloaded image to the local img directory (for syncing from server).
#[tauri::command]
fn save_synced_image(
    state: tauri::State<'_, AppState>,
    file_name: String,
    mime: String,
    bytes: Vec<u8>,
) -> Result<(), AppError> {
    if file_name.contains('/') || file_name.contains('\\') || file_name.is_empty() {
        return Err(AppError::Path("invalid file name".to_string()));
    }
    let path = state.img_dir.join(&file_name);
    let canonical_img = state.img_dir.canonicalize()?;

    if path.exists() {
        let canonical_path = path.canonicalize()?;
        if !canonical_path.starts_with(&canonical_img) {
            return Err(AppError::Path(
                "image path escaped img directory".to_string(),
            ));
        }
    } else {
        fs::write(&path, &bytes)?;
        let canonical_path = path.canonicalize()?;
        if !canonical_path.starts_with(&canonical_img) {
            let _ = fs::remove_file(&canonical_path);
            return Err(AppError::Path(
                "image path escaped img directory".to_string(),
            ));
        }
    }
    let _ = mime; // mime is informational; filename already encodes type
    Ok(())
}

#[tauri::command]
fn copy_text_to_clipboard(app: tauri::AppHandle, text: String) -> Result<(), AppError> {
    if text.is_empty() {
        return Ok(());
    }
    app.clipboard()
        .write_text(text)
        .map_err(|error| AppError::Clipboard(error.to_string()))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let db_path = executable_data_dir()?.join("notes.sqlite");
            let conn = Connection::open(db_path)?;
            init_schema(&conn)?;
            let img_dir = executable_img_dir()?;
            app.manage(AppState {
                db: Mutex::new(conn),
                img_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_notebook,
            create_note,
            delete_note,
            update_note,
            reorder_note,
            create_folder,
            rename_folder,
            update_folder_permission,
            delete_folder,
            reorder_folder,
            move_folder,
            save_clipboard_image,
            load_note_image,
            read_note_image_bytes,
            image_file_exists,
            cleanup_unreferenced_note_images,
            save_synced_image,
            apply_remote_notebook,
            set_sync_version,
            set_sync_markers,
            copy_text_to_clipboard
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
