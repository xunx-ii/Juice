use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
    pub parent_id: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub content: String,
    pub folder: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub sort_order: i64,
    pub pinned: bool,
    pub favorite: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct NotebookState {
    pub folders: Vec<Folder>,
    pub notes: Vec<Note>,
    pub deleted: Vec<DeletedChange>,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeletedChange {
    pub entity_type: String,
    pub id: String,
    pub deleted_at: i64,
}

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub async fn new(path: &str) -> Result<Self, rusqlite::Error> {
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let conn = Connection::open_with_path(path, flags)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "TRUE")?;
        init_schema(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    async fn conn<F, T>(&self, f: F) -> Result<T, rusqlite::Error>
    where
        F: FnOnce(&mut Connection) -> Result<T, rusqlite::Error> + Send + 'static,
        T: Send + 'static,
    {
        let result = {
            let mut conn = self.conn.lock().await;
            f(&mut conn)?
        };
        Ok(result)
    }

    pub async fn get_state(&self) -> Result<NotebookState, rusqlite::Error> {
        let folders = self.get_folders().await?;
        let notes = self.get_notes().await?;
        let deleted = self.get_deleted().await?;
        let version = chrono::Utc::now().timestamp_millis();
        Ok(NotebookState {
            folders,
            notes,
            deleted,
            version,
        })
    }

    pub async fn get_folders(&self) -> Result<Vec<Folder>, rusqlite::Error> {
        self.conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, name, sort_order, parent_id, updated_at FROM folders ORDER BY sort_order ASC",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(Folder {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    sort_order: row.get(2)?,
                    parent_id: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()
        }).await
    }

    pub async fn get_notes(&self) -> Result<Vec<Note>, rusqlite::Error> {
        self.conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, title, content, folder, created_at, updated_at, sort_order, pinned, favorite FROM notes ORDER BY folder ASC, sort_order ASC",
            )?;
            let rows = stmt.query_map([], |row| {
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
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()
        }).await
    }

    pub async fn get_deleted(&self) -> Result<Vec<DeletedChange>, rusqlite::Error> {
        self.conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT entity_type, id, deleted_at FROM deleted_log ORDER BY deleted_at ASC",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(DeletedChange {
                    entity_type: row.get(0)?,
                    id: row.get(1)?,
                    deleted_at: row.get(2)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()
        }).await
    }

    pub async fn upsert_folder(&self, folder: &Folder) -> Result<(), rusqlite::Error> {
        self.conn(|conn| {
            conn.execute(
                "INSERT INTO folders (id, name, sort_order, parent_id, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                   name = excluded.name,
                   sort_order = excluded.sort_order,
                   parent_id = excluded.parent_id,
                   updated_at = excluded.updated_at",
                params![
                    folder.id,
                    folder.name,
                    folder.sort_order,
                    folder.parent_id,
                    folder.updated_at
                ],
            )?;
            Ok(())
        }).await
    }

    pub async fn upsert_note(&self, note: &Note) -> Result<(), rusqlite::Error> {
        self.conn(|conn| {
            conn.execute(
                "INSERT INTO notes (id, title, content, folder, created_at, updated_at, sort_order, pinned, favorite)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET
                   title = excluded.title,
                   content = excluded.content,
                   folder = excluded.folder,
                   created_at = excluded.created_at,
                   updated_at = excluded.updated_at,
                   sort_order = excluded.sort_order,
                   pinned = excluded.pinned,
                   favorite = excluded.favorite",
                params![
                    note.id,
                    note.title,
                    note.content,
                    note.folder,
                    note.created_at,
                    note.updated_at,
                    note.sort_order,
                    note.pinned as i64,
                    note.favorite as i64
                ],
            )?;
            Ok(())
        }).await
    }

    pub async fn delete_entity(
        &self,
        entity_type: &str,
        id: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn(|conn| {
            match entity_type {
                "folder" => {
                    conn.execute("DELETE FROM notes WHERE folder = ?1", params![id])?;
                    conn.execute("DELETE FROM folders WHERE id = ?1", params![id])?;
                }
                "note" => {
                    conn.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
                }
                _ => {}
            }
            let deleted_at = chrono::Utc::now().timestamp_millis();
            conn.execute(
                "INSERT OR REPLACE INTO deleted_log (entity_type, id, deleted_at) VALUES (?1, ?2, ?3)",
                params![entity_type, id, deleted_at],
            )?;
            Ok(())
        }).await
    }

    pub async fn get_user_password_hash(&self, username: &str) -> Result<Option<String>, rusqlite::Error> {
        self.conn(|conn| {
            conn.query_row(
                "SELECT password_hash FROM users WHERE username = ?1",
                params![username],
                |row| row.get::<_, String>(0),
            ).optional()
        }).await
    }

    pub async fn create_user(&self, username: &str, password_hash: &str) -> Result<(), rusqlite::Error> {
        self.conn(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO users (username, password_hash) VALUES (?1, ?2)",
                params![username, password_hash],
            )?;
            Ok(())
        }).await
    }
}

fn init_schema(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS users (
          username TEXT PRIMARY KEY,
          password_hash TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS folders (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          sort_order INTEGER NOT NULL,
          parent_id TEXT,
          updated_at INTEGER NOT NULL
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
          FOREIGN KEY(folder) REFERENCES folders(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS deleted_log (
          entity_type TEXT NOT NULL,
          id TEXT NOT NULL,
          deleted_at INTEGER NOT NULL,
          PRIMARY KEY (entity_type, id)
        );
        ",
    )
}
