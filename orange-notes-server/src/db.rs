use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use std::collections::HashSet;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
    pub parent_id: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
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

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct NotebookState {
    pub folders: Vec<Folder>,
    pub notes: Vec<Note>,
    pub version: i64,
}

pub struct Database {
    conn: Mutex<Connection>,
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

impl Database {
    pub async fn new(path: &str) -> Result<Self, rusqlite::Error> {
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let conn = Connection::open_with_flags(path, flags)?;
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

    // -----------------------------------------------------------------------
    // Counts (admin overview – global)
    // -----------------------------------------------------------------------

    pub async fn conn_count(&self, sql: &str) -> Result<i64, rusqlite::Error> {
        let sql = sql.to_string();
        self.conn(move |conn| {
            conn.query_row(&sql, [], |row| row.get::<_, i64>(0))
        }).await
    }

    // -----------------------------------------------------------------------
    // Users
    // -----------------------------------------------------------------------

    pub async fn list_users(&self, limit: i64, offset: i64) -> Result<Vec<String>, rusqlite::Error> {
        self.conn(move |conn| {
            let mut stmt = conn.prepare("SELECT username FROM users ORDER BY username ASC LIMIT ?1 OFFSET ?2")?;
            let rows = stmt.query_map(params![limit, offset], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()
        }).await
    }

    pub async fn get_user_password_hash(&self, username: String) -> Result<Option<String>, rusqlite::Error> {
        self.conn(move |conn| {
            conn.query_row(
                "SELECT password_hash FROM users WHERE username = ?1",
                params![username],
                |row| row.get::<_, String>(0),
            ).optional()
        }).await
    }

    pub async fn create_user(&self, username: String, password_hash: String) -> Result<(), rusqlite::Error> {
        self.conn(move |conn| {
            let tx = conn.transaction()?;
            tx.execute(
                "INSERT OR IGNORE INTO users (username, password_hash) VALUES (?1, ?2)",
                params![username, password_hash],
            )?;
            tx.execute(
                "INSERT OR IGNORE INTO sync_meta (user_id, version) VALUES (?1, 0)",
                params![username],
            )?;
            tx.commit()
        }).await
    }

    /// Delete a user and all data owned by that user.
    pub async fn delete_user(&self, username: &str) -> Result<bool, rusqlite::Error> {
        let username = username.to_string();
        self.conn(move |conn| {
            conn.execute("DELETE FROM notes WHERE user_id = ?1", params![username.clone()])?;
            conn.execute("DELETE FROM folders WHERE user_id = ?1", params![username.clone()])?;
            conn.execute("DELETE FROM attachments WHERE user_id = ?1", params![username.clone()])?;
            conn.execute("DELETE FROM sync_meta WHERE user_id = ?1", params![username.clone()])?;
            let deleted = conn.execute("DELETE FROM users WHERE username = ?1", params![username])?;
            Ok(deleted > 0)
        }).await
    }

    // -----------------------------------------------------------------------
    // Scoped per-user queries for sync
    // -----------------------------------------------------------------------

    pub async fn get_state(&self, user_id: &str) -> Result<NotebookState, rusqlite::Error> {
        let user_id = user_id.to_string();
        self.conn(move |conn| {
            let version = conn
                .query_row(
                    "SELECT version FROM sync_meta WHERE user_id = ?1",
                    params![user_id.clone()],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .unwrap_or(0);

            let folders = {
                let mut stmt = conn.prepare(
                "SELECT id, name, sort_order, parent_id, updated_at FROM folders WHERE user_id = ?1 ORDER BY sort_order ASC",
                )?;
                let rows = stmt.query_map(params![user_id.clone()], |row| {
                    Ok(Folder {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        sort_order: row.get(2)?,
                        parent_id: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
                })?;
                rows.collect::<Result<Vec<_>, _>>()?
            };

            let notes = {
                let mut stmt = conn.prepare(
                    "SELECT id, title, content, folder, created_at, updated_at, sort_order, pinned, favorite FROM notes WHERE user_id = ?1 ORDER BY folder ASC, sort_order ASC",
                )?;
                let rows = stmt.query_map(params![user_id], |row| {
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
                rows.collect::<Result<Vec<_>, _>>()?
            };

            Ok(NotebookState {
                folders,
                notes,
                version,
            })
        }).await
    }

    // -----------------------------------------------------------------------
    // Mutations (scoped to a user)
    // -----------------------------------------------------------------------

    pub async fn replace_state_if_version(
        &self,
        user_id: String,
        state: NotebookState,
        base_version: i64,
    ) -> Result<Option<i64>, rusqlite::Error> {
        self.conn(move |conn| {
            let tx = conn.transaction()?;
            let current_version = tx
                .query_row(
                    "SELECT version FROM sync_meta WHERE user_id = ?1",
                    params![user_id.clone()],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .unwrap_or(0);

            if current_version != base_version {
                return Ok(None);
            }

            let next_version = [
                current_version.saturating_add(1),
                state.version,
                chrono::Utc::now().timestamp_millis(),
            ]
            .into_iter()
            .max()
            .unwrap_or(1);

            tx.execute("DELETE FROM notes WHERE user_id = ?1", params![user_id.clone()])?;
            tx.execute("DELETE FROM folders WHERE user_id = ?1", params![user_id.clone()])?;

            let referenced_attachments = state
                .notes
                .iter()
                .flat_map(|note| extract_image_file_names(&note.content))
                .collect::<HashSet<_>>();

            for folder in state.folders {
                tx.execute(
                    "INSERT INTO folders (id, name, sort_order, parent_id, updated_at, user_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        folder.id,
                        folder.name,
                        folder.sort_order,
                        folder.parent_id,
                        folder.updated_at,
                        user_id.clone(),
                    ],
                )?;
            }

            for note in state.notes {
                tx.execute(
                    "INSERT INTO notes (id, title, content, folder, created_at, updated_at, sort_order, pinned, favorite, user_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
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
                        user_id.clone(),
                    ],
                )?;
            }

            let existing_attachments = {
                let mut stmt =
                    tx.prepare("SELECT file_name FROM attachments WHERE user_id = ?1")?;
                let file_names = stmt
                    .query_map(params![user_id.clone()], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                file_names
            };
            for file_name in existing_attachments {
                if referenced_attachments.contains(&file_name) {
                    continue;
                }
                tx.execute(
                    "DELETE FROM attachments WHERE user_id = ?1 AND file_name = ?2",
                    params![user_id.clone(), file_name],
                )?;
            }

            tx.execute(
                "INSERT INTO sync_meta (user_id, version)
                 VALUES (?1, ?2)
                 ON CONFLICT(user_id) DO UPDATE SET version = excluded.version",
                params![user_id, next_version],
            )?;
            tx.commit()?;
            Ok(Some(next_version))
        }).await
    }

    /// Total note count scoped to a user.
    pub async fn note_count(&self, user_id: &str) -> Result<i64, rusqlite::Error> {
        let user_id = user_id.to_string();
        self.conn(move |conn| {
            conn.query_row("SELECT COUNT(*) FROM notes WHERE user_id = ?1", params![user_id], |row| row.get::<_, i64>(0))
        }).await
    }

    // -----------------------------------------------------------------------
    // Attachments (images)
    // -----------------------------------------------------------------------

    pub async fn upsert_attachment(
        &self,
        user_id: &str,
        file_name: &str,
        mime: &str,
        data: &[u8],
    ) -> Result<(), rusqlite::Error> {
        let user_id = user_id.to_string();
        let file_name = file_name.to_string();
        let mime = mime.to_string();
        let data = data.to_vec();
        self.conn(move |conn| {
            conn.execute(
                "INSERT INTO attachments (user_id, file_name, mime, data, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(user_id, file_name) DO UPDATE SET
                   mime = excluded.mime,
                   data = excluded.data,
                   updated_at = excluded.updated_at",
                params![user_id, file_name, mime, data, chrono::Utc::now().timestamp_millis()],
            )?;
            Ok(())
        }).await
    }

    pub async fn list_attachments(&self, user_id: &str) -> Result<Vec<(String, String)>, rusqlite::Error> {
        let user_id = user_id.to_string();
        self.conn(move |conn| {
            let referenced = {
                let mut stmt = conn.prepare("SELECT content FROM notes WHERE user_id = ?1")?;
                let contents = stmt
                    .query_map(params![user_id.clone()], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                let mut names = HashSet::new();
                for content in contents {
                    names.extend(extract_image_file_names(&content));
                }
                names
            };
            if referenced.is_empty() {
                return Ok(Vec::new());
            }

            let mut stmt = conn.prepare("SELECT file_name, mime FROM attachments WHERE user_id = ?1 ORDER BY file_name ASC")?;
            let rows = stmt.query_map(params![user_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            let files = rows
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .filter(|(file_name, _)| referenced.contains(file_name))
                .collect();
            Ok(files)
        }).await
    }

    pub async fn get_attachment(&self, user_id: &str, file_name: &str) -> Result<Option<(String, Vec<u8>)>, rusqlite::Error> {
        let user_id = user_id.to_string();
        let file_name = file_name.to_string();
        self.conn(move |conn| {
            conn.query_row(
                "SELECT mime, data FROM attachments WHERE user_id = ?1 AND file_name = ?2",
                params![user_id, file_name],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)),
            ).optional()
        }).await
    }

    pub async fn delete_attachment(&self, user_id: &str, file_name: &str) -> Result<(), rusqlite::Error> {
        let user_id = user_id.to_string();
        let file_name = file_name.to_string();
        self.conn(move |conn| {
            conn.execute(
                "DELETE FROM attachments WHERE user_id = ?1 AND file_name = ?2",
                params![user_id, file_name],
            )?;
            Ok(())
        }).await
    }
}

fn init_schema(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch("
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
          updated_at INTEGER NOT NULL,
          user_id TEXT NOT NULL DEFAULT ''
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
          user_id TEXT NOT NULL DEFAULT '',
          FOREIGN KEY(folder) REFERENCES folders(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS attachments (
          user_id TEXT NOT NULL,
          file_name TEXT NOT NULL,
          mime TEXT NOT NULL,
          data BLOB NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, file_name)
        );

        CREATE TABLE IF NOT EXISTS sync_meta (
          user_id TEXT PRIMARY KEY,
          version INTEGER NOT NULL
        );
    ")
}
