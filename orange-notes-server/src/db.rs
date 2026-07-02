use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use std::collections::HashSet;
use tokio::sync::Mutex;

fn default_ai_permission() -> String {
    "write".to_string()
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
    pub parent_id: Option<String>,
    pub updated_at: i64,
    #[serde(default = "default_ai_permission")]
    pub ai_permission: String,
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
    #[serde(default = "default_ai_permission")]
    pub ai_permission: String,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct NoteSummary {
    pub id: String,
    pub title: String,
    pub folder: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub sort_order: i64,
    pub pinned: bool,
    pub favorite: bool,
    pub content_preview: String,
    pub ai_permission: String,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct EncryptionMeta {
    pub enabled: bool,
    pub version: i64,
    pub algorithm: String,
    pub kdf: String,
    pub salt: String,
    pub iterations: i64,
    pub key_check_iv: String,
    pub key_check: String,
    #[serde(default, skip_serializing)]
    pub mcp_check: Option<String>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct NotebookState {
    pub folders: Vec<Folder>,
    pub notes: Vec<Note>,
    pub version: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encryption: Option<EncryptionMeta>,
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

fn normalize_ai_permission(permission: &str) -> &str {
    match permission {
        "read" | "write" | "none" => permission,
        _ => "write",
    }
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
        self.conn(move |conn| conn.query_row(&sql, [], |row| row.get::<_, i64>(0)))
            .await
    }

    // -----------------------------------------------------------------------
    // Users
    // -----------------------------------------------------------------------

    pub async fn list_users(
        &self,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<String>, rusqlite::Error> {
        self.conn(move |conn| {
            let mut stmt = conn
                .prepare("SELECT username FROM users ORDER BY username ASC LIMIT ?1 OFFSET ?2")?;
            let rows = stmt.query_map(params![limit, offset], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()
        })
        .await
    }

    pub async fn get_user_password_hash(
        &self,
        username: String,
    ) -> Result<Option<String>, rusqlite::Error> {
        self.conn(move |conn| {
            conn.query_row(
                "SELECT password_hash FROM users WHERE username = ?1",
                params![username],
                |row| row.get::<_, String>(0),
            )
            .optional()
        })
        .await
    }

    pub async fn get_mcp_token(&self, user_id: &str) -> Result<Option<String>, rusqlite::Error> {
        let user_id = user_id.to_string();
        self.conn(move |conn| {
            conn.query_row(
                "SELECT token FROM mcp_tokens WHERE user_id = ?1",
                params![user_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
        })
        .await
    }

    pub async fn user_by_mcp_token(&self, token: &str) -> Result<Option<String>, rusqlite::Error> {
        let token = token.to_string();
        self.conn(move |conn| {
            conn.query_row(
                "SELECT user_id FROM mcp_tokens WHERE token = ?1",
                params![token],
                |row| row.get::<_, String>(0),
            )
            .optional()
        })
        .await
    }

    pub async fn generate_mcp_token(&self, user_id: &str) -> Result<String, rusqlite::Error> {
        let user_id = user_id.to_string();
        let token = format!(
            "mcp_{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        self.conn(move |conn| {
            let now = chrono::Utc::now().timestamp_millis();
            conn.execute(
                "INSERT INTO mcp_tokens (user_id, token, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?3)
                 ON CONFLICT(user_id) DO UPDATE SET token = excluded.token, updated_at = excluded.updated_at",
                params![user_id, token, now],
            )?;
            Ok(token)
        }).await
    }

    pub async fn create_user(
        &self,
        username: String,
        password_hash: String,
    ) -> Result<(), rusqlite::Error> {
        self.conn(move |conn| {
            let tx = conn.transaction()?;
            tx.execute(
                "INSERT INTO users (username, password_hash) VALUES (?1, ?2)",
                params![username, password_hash],
            )?;
            tx.execute(
                "INSERT OR IGNORE INTO sync_meta (user_id, version) VALUES (?1, 0)",
                params![username],
            )?;
            tx.commit()
        })
        .await
    }

    /// Delete a user and all data owned by that user.
    pub async fn delete_user(&self, username: &str) -> Result<bool, rusqlite::Error> {
        let username = username.to_string();
        self.conn(move |conn| {
            conn.execute(
                "DELETE FROM notes WHERE user_id = ?1",
                params![username.clone()],
            )?;
            conn.execute(
                "DELETE FROM folders WHERE user_id = ?1",
                params![username.clone()],
            )?;
            conn.execute(
                "DELETE FROM attachments WHERE user_id = ?1",
                params![username.clone()],
            )?;
            conn.execute(
                "DELETE FROM sync_meta WHERE user_id = ?1",
                params![username.clone()],
            )?;
            conn.execute(
                "DELETE FROM encryption_meta WHERE user_id = ?1",
                params![username.clone()],
            )?;
            let deleted =
                conn.execute("DELETE FROM users WHERE username = ?1", params![username])?;
            Ok(deleted > 0)
        })
        .await
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

            let encryption = conn
                .query_row(
                    "SELECT enabled, version, algorithm, kdf, salt, iterations, key_check_iv, key_check, mcp_check
                     FROM encryption_meta
                     WHERE user_id = ?1",
                    params![user_id.clone()],
                    |row| {
                        Ok(EncryptionMeta {
                            enabled: row.get::<_, i64>(0)? != 0,
                            version: row.get(1)?,
                            algorithm: row.get(2)?,
                            kdf: row.get(3)?,
                            salt: row.get(4)?,
                            iterations: row.get(5)?,
                            key_check_iv: row.get(6)?,
                            key_check: row.get(7)?,
                            mcp_check: row.get(8)?,
                        })
                    },
                )
                .optional()?
                .filter(|meta| meta.enabled);

            let folders = {
                let mut stmt = conn.prepare(
                "SELECT id, name, sort_order, parent_id, updated_at, ai_permission FROM folders WHERE user_id = ?1 ORDER BY sort_order ASC",
                )?;
                let rows = stmt.query_map(params![user_id.clone()], |row| {
                    Ok(Folder {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        sort_order: row.get(2)?,
                        parent_id: row.get(3)?,
                        updated_at: row.get(4)?,
                        ai_permission: row.get(5)?,
                    })
                })?;
                rows.collect::<Result<Vec<_>, _>>()?
            };

            let notes = {
                let mut stmt = conn.prepare(
                    "SELECT id, title, content, folder, created_at, updated_at, sort_order, pinned, favorite, ai_permission FROM notes WHERE user_id = ?1 ORDER BY folder ASC, sort_order ASC",
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
                        ai_permission: row.get(9)?,
                    })
                })?;
                rows.collect::<Result<Vec<_>, _>>()?
            };

            Ok(NotebookState {
                folders,
                notes,
                version,
                encryption,
            })
        }).await
    }

    pub async fn encryption_enabled(&self, user_id: &str) -> Result<bool, rusqlite::Error> {
        let user_id = user_id.to_string();
        self.conn(move |conn| {
            let enabled = conn
                .query_row(
                    "SELECT enabled FROM encryption_meta WHERE user_id = ?1",
                    params![user_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .unwrap_or(0);
            Ok(enabled != 0)
        })
        .await
    }

    pub async fn get_encryption_meta(
        &self,
        user_id: &str,
    ) -> Result<Option<EncryptionMeta>, rusqlite::Error> {
        let user_id = user_id.to_string();
        self.conn(move |conn| {
            conn.query_row(
                "SELECT enabled, version, algorithm, kdf, salt, iterations, key_check_iv, key_check, mcp_check
                 FROM encryption_meta
                 WHERE user_id = ?1",
                params![user_id],
                |row| {
                    Ok(EncryptionMeta {
                        enabled: row.get::<_, i64>(0)? != 0,
                        version: row.get(1)?,
                        algorithm: row.get(2)?,
                        kdf: row.get(3)?,
                        salt: row.get(4)?,
                        iterations: row.get(5)?,
                        key_check_iv: row.get(6)?,
                        key_check: row.get(7)?,
                        mcp_check: row.get(8)?,
                    })
                },
            )
            .optional()
        })
        .await
    }

    pub async fn update_encryption_mcp_check(
        &self,
        user_id: &str,
        mcp_check: String,
        encryption: &EncryptionMeta,
    ) -> Result<bool, rusqlite::Error> {
        let user_id = user_id.to_string();
        let encryption = encryption.clone();
        self.conn(move |conn| {
            let changed = conn.execute(
                "UPDATE encryption_meta
                 SET mcp_check = ?2
                 WHERE user_id = ?1
                   AND enabled = ?3
                   AND version = ?4
                   AND algorithm = ?5
                   AND kdf = ?6
                   AND salt = ?7
                   AND iterations = ?8
                   AND key_check_iv = ?9
                   AND key_check = ?10",
                params![
                    user_id,
                    mcp_check,
                    encryption.enabled as i64,
                    encryption.version,
                    encryption.algorithm,
                    encryption.kdf,
                    encryption.salt,
                    encryption.iterations,
                    encryption.key_check_iv,
                    encryption.key_check,
                ],
            )?;
            Ok(changed > 0)
        })
        .await
    }

    pub async fn list_notes_page(
        &self,
        user_id: &str,
        folder_id: Option<String>,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<Note>, rusqlite::Error> {
        let user_id = user_id.to_string();
        self.conn(move |conn| {
            let map_row = |row: &rusqlite::Row<'_>| {
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
            };

            if let Some(folder_id) = folder_id {
                let mut stmt = conn.prepare(
                    "SELECT id, title, content, folder, created_at, updated_at, sort_order, pinned, favorite, ai_permission
                     FROM notes
                     WHERE user_id = ?1 AND folder = ?2
                     ORDER BY folder ASC, sort_order ASC
                     LIMIT ?3 OFFSET ?4",
                )?;
                let rows = stmt.query_map(params![user_id, folder_id, limit, offset], map_row)?;
                return rows.collect::<Result<Vec<_>, _>>();
            }

            let mut stmt = conn.prepare(
                "SELECT id, title, content, folder, created_at, updated_at, sort_order, pinned, favorite, ai_permission
                 FROM notes
                 WHERE user_id = ?1
                 ORDER BY folder ASC, sort_order ASC
                 LIMIT ?2 OFFSET ?3",
            )?;
            let rows = stmt.query_map(params![user_id, limit, offset], map_row)?;
            rows.collect::<Result<Vec<_>, _>>()
        })
        .await
    }

    pub async fn list_folders(&self, user_id: &str) -> Result<Vec<Folder>, rusqlite::Error> {
        let user_id = user_id.to_string();
        self.conn(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT id, name, sort_order, parent_id, updated_at, ai_permission
                 FROM folders
                 WHERE user_id = ?1
                 ORDER BY sort_order ASC",
            )?;
            let rows = stmt.query_map(params![user_id], |row| {
                Ok(Folder {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    sort_order: row.get(2)?,
                    parent_id: row.get(3)?,
                    updated_at: row.get(4)?,
                    ai_permission: row.get(5)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()
        })
        .await
    }

    pub async fn list_note_summaries(
        &self,
        user_id: &str,
        folder_id: Option<String>,
        query: Option<String>,
        limit: i64,
        offset: i64,
        preview_chars: i64,
    ) -> Result<Vec<NoteSummary>, rusqlite::Error> {
        let user_id = user_id.to_string();
        let query = query.map(|value| format!("%{}%", value.to_lowercase()));
        self.conn(move |conn| {
            let map_row = |row: &rusqlite::Row<'_>| {
                Ok(NoteSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    folder: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    sort_order: row.get(5)?,
                    pinned: row.get::<_, i64>(6)? != 0,
                    favorite: row.get::<_, i64>(7)? != 0,
                    content_preview: row.get(8)?,
                    ai_permission: row.get(9)?,
                })
            };

            match (folder_id, query) {
                (Some(folder_id), Some(query)) => {
                    let mut stmt = conn.prepare(
                        "SELECT n.id, n.title, n.folder, n.created_at, n.updated_at, n.sort_order, n.pinned, n.favorite, substr(n.content, 1, ?3), n.ai_permission
                         FROM notes n
                         JOIN folders f ON f.user_id = n.user_id AND f.id = n.folder
                         WHERE n.user_id = ?1 AND n.folder = ?2 AND n.ai_permission != 'none' AND f.ai_permission != 'none' AND (lower(n.title) LIKE ?4 OR lower(n.content) LIKE ?4)
                         ORDER BY n.folder ASC, n.sort_order ASC
                         LIMIT ?5 OFFSET ?6",
                    )?;
                    let rows = stmt.query_map(
                        params![user_id, folder_id, preview_chars, query, limit, offset],
                        map_row,
                    )?;
                    rows.collect::<Result<Vec<_>, _>>()
                }
                (Some(folder_id), None) => {
                    let mut stmt = conn.prepare(
                        "SELECT n.id, n.title, n.folder, n.created_at, n.updated_at, n.sort_order, n.pinned, n.favorite, substr(n.content, 1, ?3), n.ai_permission
                         FROM notes n
                         JOIN folders f ON f.user_id = n.user_id AND f.id = n.folder
                         WHERE n.user_id = ?1 AND n.folder = ?2 AND n.ai_permission != 'none' AND f.ai_permission != 'none'
                         ORDER BY n.folder ASC, n.sort_order ASC
                         LIMIT ?4 OFFSET ?5",
                    )?;
                    let rows = stmt.query_map(
                        params![user_id, folder_id, preview_chars, limit, offset],
                        map_row,
                    )?;
                    rows.collect::<Result<Vec<_>, _>>()
                }
                (None, Some(query)) => {
                    let mut stmt = conn.prepare(
                        "SELECT n.id, n.title, n.folder, n.created_at, n.updated_at, n.sort_order, n.pinned, n.favorite, substr(n.content, 1, ?2), n.ai_permission
                         FROM notes n
                         JOIN folders f ON f.user_id = n.user_id AND f.id = n.folder
                         WHERE n.user_id = ?1 AND n.ai_permission != 'none' AND f.ai_permission != 'none' AND (lower(n.title) LIKE ?3 OR lower(n.content) LIKE ?3)
                         ORDER BY n.folder ASC, n.sort_order ASC
                         LIMIT ?4 OFFSET ?5",
                    )?;
                    let rows = stmt.query_map(
                        params![user_id, preview_chars, query, limit, offset],
                        map_row,
                    )?;
                    rows.collect::<Result<Vec<_>, _>>()
                }
                (None, None) => {
                    let mut stmt = conn.prepare(
                        "SELECT n.id, n.title, n.folder, n.created_at, n.updated_at, n.sort_order, n.pinned, n.favorite, substr(n.content, 1, ?2), n.ai_permission
                         FROM notes n
                         JOIN folders f ON f.user_id = n.user_id AND f.id = n.folder
                         WHERE n.user_id = ?1 AND n.ai_permission != 'none' AND f.ai_permission != 'none'
                         ORDER BY n.folder ASC, n.sort_order ASC
                         LIMIT ?3 OFFSET ?4",
                    )?;
                    let rows =
                        stmt.query_map(params![user_id, preview_chars, limit, offset], map_row)?;
                    rows.collect::<Result<Vec<_>, _>>()
                }
            }
        })
        .await
    }

    pub async fn get_note_by_id(
        &self,
        user_id: &str,
        note_id: &str,
    ) -> Result<Option<Note>, rusqlite::Error> {
        let user_id = user_id.to_string();
        let note_id = note_id.to_string();
        self.conn(move |conn| {
            conn.query_row(
                "SELECT id, title, content, folder, created_at, updated_at, sort_order, pinned, favorite, ai_permission
                 FROM notes
                 WHERE user_id = ?1 AND id = ?2",
                params![user_id, note_id],
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
            )
            .optional()
        })
        .await
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
            let encryption = state.encryption.clone().filter(|meta| meta.enabled);
            let encryption_enabled = encryption.is_some();

            let referenced_attachments = state
                .notes
                .iter()
                .flat_map(|note| extract_image_file_names(&note.content))
                .collect::<HashSet<_>>();

            for folder in state.folders {
                tx.execute(
                    "INSERT INTO folders (id, name, sort_order, parent_id, updated_at, user_id, ai_permission)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        folder.id,
                        folder.name,
                        folder.sort_order,
                        folder.parent_id,
                        folder.updated_at,
                        user_id.clone(),
                        normalize_ai_permission(&folder.ai_permission),
                    ],
                )?;
            }

            for note in state.notes {
                tx.execute(
                    "INSERT INTO notes (id, title, content, folder, created_at, updated_at, sort_order, pinned, favorite, user_id, ai_permission)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
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
                        normalize_ai_permission(&note.ai_permission),
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
                if encryption_enabled || referenced_attachments.contains(&file_name) {
                    continue;
                }
                tx.execute(
                    "DELETE FROM attachments WHERE user_id = ?1 AND file_name = ?2",
                    params![user_id.clone(), file_name],
                )?;
            }

            if let Some(encryption) = encryption {
                tx.execute(
                    "INSERT INTO encryption_meta (user_id, enabled, version, algorithm, kdf, salt, iterations, key_check_iv, key_check)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                     ON CONFLICT(user_id) DO UPDATE SET
                       enabled = excluded.enabled,
                       version = excluded.version,
                       algorithm = excluded.algorithm,
                       kdf = excluded.kdf,
                       salt = excluded.salt,
                       iterations = excluded.iterations,
                       key_check_iv = excluded.key_check_iv,
                       key_check = excluded.key_check,
                       mcp_check = CASE
                         WHEN encryption_meta.version = excluded.version
                           AND encryption_meta.algorithm = excluded.algorithm
                           AND encryption_meta.kdf = excluded.kdf
                           AND encryption_meta.salt = excluded.salt
                           AND encryption_meta.iterations = excluded.iterations
                           AND encryption_meta.key_check_iv = excluded.key_check_iv
                           AND encryption_meta.key_check = excluded.key_check
                         THEN encryption_meta.mcp_check
                         ELSE NULL
                       END",
                    params![
                        user_id.clone(),
                        encryption.enabled as i64,
                        encryption.version,
                        encryption.algorithm,
                        encryption.kdf,
                        encryption.salt,
                        encryption.iterations,
                        encryption.key_check_iv,
                        encryption.key_check,
                    ],
                )?;
            } else {
                tx.execute(
                    "DELETE FROM encryption_meta WHERE user_id = ?1",
                    params![user_id.clone()],
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
            conn.query_row(
                "SELECT COUNT(*) FROM notes WHERE user_id = ?1",
                params![user_id],
                |row| row.get::<_, i64>(0),
            )
        })
        .await
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
                params![
                    user_id,
                    file_name,
                    mime,
                    data,
                    chrono::Utc::now().timestamp_millis()
                ],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn list_attachments(
        &self,
        user_id: &str,
    ) -> Result<Vec<(String, String)>, rusqlite::Error> {
        let user_id = user_id.to_string();
        self.conn(move |conn| {
            let encryption_enabled = conn
                .query_row(
                    "SELECT enabled FROM encryption_meta WHERE user_id = ?1",
                    params![user_id.clone()],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .unwrap_or(0)
                != 0;
            if encryption_enabled {
                let mut stmt = conn.prepare(
                    "SELECT file_name, mime FROM attachments WHERE user_id = ?1 ORDER BY file_name ASC",
                )?;
                let rows = stmt.query_map(params![user_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?;
                return rows.collect::<Result<Vec<_>, _>>();
            }

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

            let mut stmt = conn.prepare(
                "SELECT file_name, mime FROM attachments WHERE user_id = ?1 ORDER BY file_name ASC",
            )?;
            let rows = stmt.query_map(params![user_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            let files = rows
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .filter(|(file_name, _)| referenced.contains(file_name))
                .collect();
            Ok(files)
        })
        .await
    }

    pub async fn get_attachment(
        &self,
        user_id: &str,
        file_name: &str,
    ) -> Result<Option<(String, Vec<u8>)>, rusqlite::Error> {
        let user_id = user_id.to_string();
        let file_name = file_name.to_string();
        self.conn(move |conn| {
            conn.query_row(
                "SELECT mime, data FROM attachments WHERE user_id = ?1 AND file_name = ?2",
                params![user_id, file_name],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)),
            )
            .optional()
        })
        .await
    }

    pub async fn delete_attachment(
        &self,
        user_id: &str,
        file_name: &str,
    ) -> Result<(), rusqlite::Error> {
        let user_id = user_id.to_string();
        let file_name = file_name.to_string();
        self.conn(move |conn| {
            conn.execute(
                "DELETE FROM attachments WHERE user_id = ?1 AND file_name = ?2",
                params![user_id, file_name],
            )?;
            Ok(())
        })
        .await
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
          updated_at INTEGER NOT NULL,
          ai_permission TEXT NOT NULL DEFAULT 'write',
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
          ai_permission TEXT NOT NULL DEFAULT 'write',
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

        CREATE TABLE IF NOT EXISTS encryption_meta (
          user_id TEXT PRIMARY KEY,
          enabled INTEGER NOT NULL,
          version INTEGER NOT NULL,
          algorithm TEXT NOT NULL,
          kdf TEXT NOT NULL,
          salt TEXT NOT NULL,
          iterations INTEGER NOT NULL,
          key_check_iv TEXT NOT NULL,
          key_check TEXT NOT NULL,
          mcp_check TEXT,
          FOREIGN KEY(user_id) REFERENCES users(username) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS mcp_tokens (
          user_id TEXT PRIMARY KEY,
          token TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(user_id) REFERENCES users(username) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_notes_user_folder_sort
          ON notes(user_id, folder, sort_order);

        CREATE INDEX IF NOT EXISTS idx_notes_user_updated
          ON notes(user_id, updated_at);
    ",
    )?;
    ensure_text_column(conn, "folders", "ai_permission", "'write'")?;
    ensure_text_column(conn, "notes", "ai_permission", "'write'")?;
    ensure_nullable_text_column(conn, "encryption_meta", "mcp_check")?;
    Ok(())
}

fn ensure_text_column(
    conn: &Connection,
    table: &str,
    column: &str,
    default_value: &str,
) -> Result<(), rusqlite::Error> {
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

fn ensure_nullable_text_column(
    conn: &Connection,
    table: &str,
    column: &str,
) -> Result<(), rusqlite::Error> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let exists = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .any(|name| name == column);
    if !exists {
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} TEXT"), [])?;
    }
    Ok(())
}
