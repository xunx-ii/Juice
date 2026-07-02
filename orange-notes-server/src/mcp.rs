use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use uuid::Uuid;

use crate::{
    auth,
    db::{Database, Folder, Note, NoteSummary, NotebookState},
    sync::{self, ClientMap},
};

const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
const MCP_SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_NOTE_LIST_LIMIT: i64 = 50;
const MAX_NOTE_LIST_LIMIT: i64 = 200;
const NOTE_PREVIEW_CHARS: i64 = 240;
const SYNC_AUTH_HEADER: &str = "x-orange-notes-auth";
const SYNC_USER_HEADER: &str = "x-orange-notes-user";
const SYNC_PASSWORD_HEADER: &str = "x-orange-notes-password";

pub async fn get_token(
    Path(username): Path<String>,
    headers: HeaderMap,
    State(db): State<Arc<Database>>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    require_sync_auth(&headers, db.as_ref(), &username).await?;
    let token = db.get_mcp_token(&username).await.map_err(database_error)?;
    Ok(Json(json!({ "token": token })))
}

pub async fn generate_token(
    Path(username): Path<String>,
    headers: HeaderMap,
    State(db): State<Arc<Database>>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    require_sync_auth(&headers, db.as_ref(), &username).await?;
    let token = db
        .generate_mcp_token(&username)
        .await
        .map_err(database_error)?;
    Ok(Json(json!({ "token": token })))
}

pub async fn mcp_info() -> impl IntoResponse {
    Json(json!({
        "name": "orange-notes-server",
        "transport": "streamable-http",
        "endpoint": "/mcp",
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "supportedProtocolVersions": MCP_SUPPORTED_PROTOCOL_VERSIONS,
        "capabilities": { "tools": {} },
        "tools": tools()
    }))
}

pub async fn mcp_handler(
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    State(db): State<Arc<Database>>,
    State(clients): State<Arc<ClientMap>>,
    body: Bytes,
) -> Response {
    let Some(token) = query.get("token").filter(|value| !value.is_empty()) else {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "invalid or missing token" }),
        );
    };
    let user_id = match db.user_by_mcp_token(token).await {
        Ok(Some(user_id)) => user_id,
        Ok(None) => {
            return json_response(
                StatusCode::UNAUTHORIZED,
                json!({ "error": "invalid or missing token" }),
            );
        }
        Err(error) => {
            return json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": error.to_string() }),
            )
        }
    };

    let payload = match serde_json::from_slice::<Value>(&body) {
        Ok(value) => value,
        Err(error) => {
            return json_response(
                StatusCode::OK,
                rpc_error(Value::Null, -32700, &format!("parse error: {error}")),
            );
        }
    };

    if let Some(messages) = payload.as_array() {
        let mut responses = Vec::new();
        for message in messages {
            if let Some(response) =
                handle_rpc(db.as_ref(), clients.as_ref(), &user_id, &headers, message).await
            {
                responses.push(response);
            }
        }
        if responses.is_empty() {
            return StatusCode::ACCEPTED.into_response();
        }
        return json_response(StatusCode::OK, Value::Array(responses));
    }

    match handle_rpc(db.as_ref(), clients.as_ref(), &user_id, &headers, &payload).await {
        Some(response) => json_response(StatusCode::OK, response),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

async fn handle_rpc(
    db: &Database,
    clients: &ClientMap,
    user_id: &str,
    headers: &HeaderMap,
    message: &Value,
) -> Option<Value> {
    let id = message.get("id").cloned()?;
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let result = match method {
        "initialize" => Ok(initialize_result(message)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => call_tool(db, clients, user_id, headers, message).await,
        _ => return Some(rpc_error(id, -32601, "method not found")),
    };

    Some(match result {
        Ok(result) => rpc_success(id, result),
        Err(message) => rpc_error(id, -32000, &message),
    })
}

async fn call_tool(
    db: &Database,
    clients: &ClientMap,
    user_id: &str,
    _headers: &HeaderMap,
    message: &Value,
) -> Result<Value, String> {
    let params = message
        .get("params")
        .and_then(Value::as_object)
        .ok_or_else(|| "missing params".to_string())?;
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing tool name".to_string())?;
    let arguments = match params.get("arguments") {
        Some(Value::Object(_)) => params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({})),
        Some(Value::Null) | None => json!({}),
        Some(_) => return Err("tool arguments must be an object".to_string()),
    };

    let (result, changed) = match name {
        "list_folders" => (list_folders(db, user_id).await?, false),
        "list_notes" => (list_notes(db, user_id, &arguments).await?, false),
        "get_note" => (get_note(db, user_id, &arguments).await?, false),
        "create_note" => (create_note(db, user_id, &arguments).await?, true),
        "update_note" => (update_note(db, user_id, &arguments).await?, true),
        "delete_note" => (delete_note(db, user_id, &arguments).await?, true),
        _ => return Err(format!("unknown tool: {name}")),
    };

    if changed {
        let _ = sync::broadcast_current_state(clients, db, user_id).await;
    }

    let text = serde_json::to_string_pretty(&result).map_err(|error| error.to_string())?;
    Ok(json!({
        "content": [
            {
                "type": "text",
                "text": text
            }
        ]
    }))
}

fn initialize_result(message: &Value) -> Value {
    let protocol_version = message
        .get("params")
        .and_then(|params| params.get("protocolVersion"))
        .and_then(Value::as_str)
        .filter(|version| MCP_SUPPORTED_PROTOCOL_VERSIONS.contains(version))
        .unwrap_or(MCP_PROTOCOL_VERSION);

    json!({
        "protocolVersion": protocol_version,
        "capabilities": { "tools": {} },
        "serverInfo": {
            "name": "orange-notes-server",
            "version": env!("CARGO_PKG_VERSION")
        }
    })
}

fn tools() -> Value {
    json!([
        tool_definition(
            "list_folders",
            "List folders in Orange Notes.",
            json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        ),
        tool_definition(
            "list_notes",
            "List note metadata with bounded previews. Supports limit/offset and page/pageSize pagination. Full content is not returned; use get_note for one note's content.",
            json!({
                "type": "object",
                "properties": {
                    "folderId": { "type": "string", "description": "Filter by folder id." },
                    "folder_id": { "type": "string", "description": "Alias for folderId." },
                    "folderName": { "type": "string", "description": "Filter by folder name when folderId is not available." },
                    "folder_name": { "type": "string", "description": "Alias for folderName." },
                    "query": { "type": "string", "description": "Search title and content." },
                    "includeContent": { "type": "boolean", "description": "Deprecated compatibility flag; bulk lists always omit full content." },
                    "include_content": { "type": "boolean", "description": "Alias for includeContent." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200, "description": "Page size controlled by the MCP client. Defaults to 50 and caps at 200." },
                    "offset": { "type": "integer", "minimum": 0, "description": "Zero-based result offset controlled by the MCP client. Use nextOffset from the previous response to fetch the next page." },
                    "page": { "type": "integer", "minimum": 1, "description": "One-based page number. Used only when offset is omitted." },
                    "pageSize": { "type": "integer", "minimum": 1, "maximum": 200, "description": "Alias for limit." },
                    "page_size": { "type": "integer", "minimum": 1, "maximum": 200, "description": "Alias for pageSize." }
                },
                "additionalProperties": false
            }),
        ),
        tool_definition(
            "get_note",
            "Get one note by id.",
            json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"],
                "additionalProperties": false
            }),
        ),
        tool_definition(
            "create_note",
            "Create a note. If no folder is provided, the first root folder is used or created.",
            json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "content": { "type": "string" },
                    "folderId": { "type": "string" },
                    "folder_id": { "type": "string", "description": "Alias for folderId." },
                    "folderName": { "type": "string" },
                    "folder_name": { "type": "string", "description": "Alias for folderName." },
                    "pinned": { "type": "boolean" },
                    "favorite": { "type": "boolean" }
                },
                "additionalProperties": false
            }),
        ),
        tool_definition(
            "update_note",
            "Update fields on an existing note. folderId/folderName can move the note across folders.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "title": { "type": "string" },
                    "content": { "type": "string" },
                    "folderId": { "type": "string" },
                    "folder_id": { "type": "string", "description": "Alias for folderId." },
                    "folderName": { "type": "string" },
                    "folder_name": { "type": "string", "description": "Alias for folderName." },
                    "sortOrder": { "type": "integer" },
                    "sort_order": { "type": "integer", "description": "Alias for sortOrder." },
                    "pinned": { "type": "boolean" },
                    "favorite": { "type": "boolean" }
                },
                "required": ["id"],
                "additionalProperties": false
            }),
        ),
        tool_definition(
            "delete_note",
            "Delete a note by id.",
            json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"],
                "additionalProperties": false
            }),
        )
    ])
}

fn tool_definition(name: &str, description: &str, input_schema: Value) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": input_schema.clone(),
        "input_schema": input_schema
    })
}

async fn list_folders(db: &Database, user_id: &str) -> Result<Value, String> {
    let folders = db
        .list_folders(user_id)
        .await
        .map_err(|error| format!("database error: {error}"))?;
    let readable_folders = readable_folder_ids(&folders);
    let folders = folders
        .into_iter()
        .filter(|folder| readable_folders.contains(&folder.id))
        .collect::<Vec<_>>();
    Ok(json!({ "folders": folders }))
}

async fn list_notes(
    db: &Database,
    user_id: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let requested_folder_id = trimmed_string_arg(arguments, &["folderId", "folder_id"]);
    let requested_folder_name = trimmed_string_arg(arguments, &["folderName", "folder_name"]);
    let query = trimmed_string_arg(arguments, &["query"]);
    let include_content_requested =
        bool_arg(arguments, &["includeContent", "include_content"]).unwrap_or(false);
    let limit = i64_arg(arguments, &["limit", "pageSize", "page_size"])
        .unwrap_or(DEFAULT_NOTE_LIST_LIMIT)
        .clamp(1, MAX_NOTE_LIST_LIMIT);
    let offset = i64_arg(arguments, &["offset"])
        .map(|value| value.max(0))
        .or_else(|| i64_arg(arguments, &["page"]).map(|page| (page.max(1) - 1) * limit))
        .unwrap_or(0);

    let folders = db
        .list_folders(user_id)
        .await
        .map_err(|error| format!("database error: {error}"))?;
    let readable_folders = readable_folder_ids(&folders);
    let folder_id = resolve_folder_filter(&folders, requested_folder_id, requested_folder_name);
    if let Some(folder_id) = folder_id.as_ref() {
        if !readable_folders.contains(folder_id) {
            return Ok(json!({
                "notes": [],
                "limit": limit,
                "offset": offset,
                "nextOffset": null,
                "hasMore": false,
                "contentIncluded": false,
                "includeContentIgnored": include_content_requested
            }));
        }
    }

    let mut db_offset = 0;
    let mut visible_seen = 0;
    let mut selected = Vec::new();
    loop {
        let batch = db
            .list_note_summaries(
                user_id,
                folder_id.clone(),
                query.clone(),
                MAX_NOTE_LIST_LIMIT,
                db_offset,
                NOTE_PREVIEW_CHARS,
            )
            .await
            .map_err(|error| format!("database error: {error}"))?;
        if batch.is_empty() {
            break;
        }
        let batch_len = batch.len() as i64;
        for summary in batch {
            if !readable_folders.contains(&summary.folder) || !can_read(&summary.ai_permission) {
                continue;
            }
            if visible_seen >= offset && selected.len() < limit.saturating_add(1) as usize {
                selected.push(summary);
            }
            visible_seen += 1;
        }
        if batch_len < MAX_NOTE_LIST_LIMIT || selected.len() > limit as usize {
            break;
        }
        db_offset += batch_len;
    }

    let has_more = selected.len() > limit as usize;
    let notes = selected
        .into_iter()
        .take(limit as usize)
        .map(note_summary_value)
        .collect::<Vec<_>>();

    Ok(json!({
        "notes": notes,
        "limit": limit,
        "offset": offset,
        "nextOffset": if has_more { Value::from(offset + limit) } else { Value::Null },
        "hasMore": has_more,
        "contentIncluded": false,
        "includeContentIgnored": include_content_requested
    }))
}

async fn get_note(
    db: &Database,
    user_id: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let id = required_string(arguments, &["id"])?;
    let note = db
        .get_note_by_id(user_id, &id)
        .await
        .map_err(|error| format!("database error: {error}"))?
        .ok_or_else(|| format!("note not found: {id}"))?;
    let folders = db
        .list_folders(user_id)
        .await
        .map_err(|error| format!("database error: {error}"))?;
    ensure_note_readable_from_folders(&note, &folders)?;
    Ok(json!(note))
}

fn note_summary_value(note: NoteSummary) -> Value {
    json!({
        "id": note.id,
        "title": note.title,
        "folder": note.folder,
        "createdAt": note.created_at,
        "updatedAt": note.updated_at,
        "sortOrder": note.sort_order,
        "pinned": note.pinned,
        "favorite": note.favorite,
        "contentPreview": note.content_preview,
        "aiPermission": note.ai_permission
    })
}

async fn create_note(
    db: &Database,
    user_id: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let mut state = get_state(db, user_id).await?;
    let base_version = state.version;
    let folder_id = ensure_folder(
        &mut state,
        string_arg(arguments, &["folderId", "folder_id"]),
        string_arg(arguments, &["folderName", "folder_name"]),
    )?;
    ensure_folder_writable(&state, &folder_id)?;
    let sort_order = state
        .notes
        .iter()
        .filter(|note| note.folder == folder_id)
        .map(|note| note.sort_order)
        .max()
        .unwrap_or(-1)
        + 1;
    let now = now_millis();
    let note = Note {
        id: generate_id(),
        title: string_arg(arguments, &["title"])
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "未命名笔记".to_string()),
        content: string_arg(arguments, &["content"]).unwrap_or_default(),
        folder: folder_id,
        created_at: now,
        updated_at: now,
        sort_order,
        pinned: bool_arg(arguments, &["pinned"]).unwrap_or(false),
        favorite: bool_arg(arguments, &["favorite"]).unwrap_or(false),
        ai_permission: "write".to_string(),
    };
    state.notes.push(note.clone());
    let version = save_state(db, user_id, state, base_version).await?;
    Ok(json!({ "note": note, "version": version }))
}

async fn update_note(
    db: &Database,
    user_id: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let id = required_string(arguments, &["id"])?;
    let mut state = get_state(db, user_id).await?;
    let base_version = state.version;
    let note_index = state
        .notes
        .iter()
        .position(|note| note.id == id)
        .ok_or_else(|| format!("note not found: {id}"))?;
    ensure_note_writable(&state, &state.notes[note_index])?;
    let folder_id = trimmed_string_arg(arguments, &["folderId", "folder_id"]);
    let folder_name = trimmed_string_arg(arguments, &["folderName", "folder_name"]);
    let folder = if folder_id.is_some() || folder_name.is_some() {
        let folder = ensure_folder(
            &mut state,
            folder_id,
            folder_name,
        )?;
        ensure_folder_writable(&state, &folder)?;
        folder
    } else {
        state.notes[note_index].folder.clone()
    };
    let note = &mut state.notes[note_index];

    if let Some(title) = string_arg(arguments, &["title"]).filter(|value| !value.trim().is_empty())
    {
        note.title = title;
    }
    if let Some(content) = string_arg(arguments, &["content"]) {
        note.content = content;
    }
    if let Some(sort_order) = i64_arg(arguments, &["sortOrder", "sort_order"]) {
        note.sort_order = sort_order;
    }
    if let Some(pinned) = bool_arg(arguments, &["pinned"]) {
        note.pinned = pinned;
    }
    if let Some(favorite) = bool_arg(arguments, &["favorite"]) {
        note.favorite = favorite;
    }
    note.folder = folder;
    note.updated_at = now_millis();
    let updated = note.clone();
    let version = save_state(db, user_id, state, base_version).await?;
    Ok(json!({ "note": updated, "version": version }))
}

async fn delete_note(
    db: &Database,
    user_id: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let id = required_string(arguments, &["id"])?;
    let mut state = get_state(db, user_id).await?;
    let base_version = state.version;
    let note = state
        .notes
        .iter()
        .find(|note| note.id == id)
        .ok_or_else(|| format!("note not found: {id}"))?;
    ensure_note_writable(&state, note)?;
    let before = state.notes.len();
    state.notes.retain(|note| note.id != id);
    if state.notes.len() == before {
        return Err(format!("note not found: {id}"));
    }
    let version = save_state(db, user_id, state, base_version).await?;
    Ok(json!({ "id": id, "deleted": true, "version": version }))
}

async fn get_state(db: &Database, user_id: &str) -> Result<NotebookState, String> {
    db.get_state(user_id)
        .await
        .map_err(|error| format!("database error: {error}"))
}

async fn save_state(
    db: &Database,
    user_id: &str,
    state: NotebookState,
    base_version: i64,
) -> Result<i64, String> {
    db.replace_state_if_version(user_id.to_string(), state, base_version)
        .await
        .map_err(|error| format!("database error: {error}"))?
        .ok_or_else(|| {
            "state changed while applying MCP operation; retry the tool call".to_string()
        })
}

fn ensure_folder(
    state: &mut NotebookState,
    folder_id: Option<String>,
    folder_name: Option<String>,
) -> Result<String, String> {
    if let Some(folder_id) = folder_id.filter(|value| !value.trim().is_empty()) {
        if state.folders.iter().any(|folder| folder.id == folder_id) {
            return Ok(folder_id);
        }
        return Err(format!("folder not found: {folder_id}"));
    }

    if let Some(folder_name) = folder_name.filter(|value| !value.trim().is_empty()) {
        if let Some(folder) = state
            .folders
            .iter()
            .find(|folder| folder.name == folder_name)
        {
            return Ok(folder.id.clone());
        }
        let folder = new_folder(folder_name, next_root_folder_sort_order(state));
        let id = folder.id.clone();
        state.folders.push(folder);
        return Ok(id);
    }

    if let Some(folder) = state
        .folders
        .iter()
        .find(|folder| folder.parent_id.is_none() && can_write(&folder.ai_permission))
    {
        return Ok(folder.id.clone());
    }
    if let Some(folder) = state
        .folders
        .iter()
        .find(|folder| can_write(&folder.ai_permission))
    {
        return Ok(folder.id.clone());
    }
    if !state.folders.is_empty() {
        return Err("没有可写文件夹".to_string());
    }

    let folder = new_folder("笔记".to_string(), 0);
    let id = folder.id.clone();
    state.folders.push(folder);
    Ok(id)
}

fn resolve_folder_filter(
    folders: &[Folder],
    folder_id: Option<String>,
    folder_name: Option<String>,
) -> Option<String> {
    if folder_id.is_some() {
        return folder_id;
    }
    let folder_name = folder_name?;
    folders
        .iter()
        .find(|folder| folder.name == folder_name)
        .map(|folder| folder.id.clone())
        .or_else(|| Some("__orange_notes_folder_not_found__".to_string()))
}

fn next_root_folder_sort_order(state: &NotebookState) -> i64 {
    state
        .folders
        .iter()
        .filter(|folder| folder.parent_id.is_none())
        .map(|folder| folder.sort_order)
        .max()
        .unwrap_or(-1)
        + 1
}

fn new_folder(name: String, sort_order: i64) -> Folder {
    Folder {
        id: generate_id(),
        name,
        sort_order,
        parent_id: None,
        updated_at: now_millis(),
        ai_permission: "write".to_string(),
    }
}

fn can_read(permission: &str) -> bool {
    matches!(permission, "read" | "write")
}

fn can_write(permission: &str) -> bool {
    matches!(permission, "write")
}

fn ensure_folder_writable(state: &NotebookState, folder_id: &str) -> Result<(), String> {
    if folder_allows(&state.folders, folder_id, can_write) {
        return Ok(());
    }
    Err(format!("folder is not writable: {folder_id}"))
}

fn ensure_note_readable_from_folders(note: &Note, folders: &[Folder]) -> Result<(), String> {
    if can_read(&note.ai_permission) && folder_allows(folders, &note.folder, can_read) {
        return Ok(());
    }
    Err(format!("note is not readable: {}", note.id))
}

fn ensure_note_writable(state: &NotebookState, note: &Note) -> Result<(), String> {
    if can_write(&note.ai_permission) && folder_allows(&state.folders, &note.folder, can_write) {
        return Ok(());
    }
    Err(format!("note is not writable: {}", note.id))
}

fn readable_folder_ids(folders: &[Folder]) -> HashSet<String> {
    folders
        .iter()
        .filter(|folder| folder_allows(folders, &folder.id, can_read))
        .map(|folder| folder.id.clone())
        .collect()
}

fn folder_allows(folders: &[Folder], folder_id: &str, predicate: fn(&str) -> bool) -> bool {
    let by_id = folders
        .iter()
        .map(|folder| (folder.id.as_str(), folder))
        .collect::<HashMap<_, _>>();
    let mut seen = HashSet::new();
    let mut current = Some(folder_id);
    while let Some(id) = current {
        if !seen.insert(id) {
            return false;
        }
        let Some(folder) = by_id.get(id) else {
            return false;
        };
        if !predicate(&folder.ai_permission) {
            return false;
        }
        current = folder.parent_id.as_deref();
    }
    true
}

async fn require_sync_auth(
    headers: &HeaderMap,
    db: &Database,
    username: &str,
) -> Result<(), (StatusCode, String)> {
    let (auth_user, password) = sync_credentials(headers)?;
    if auth_user != username {
        return Err((StatusCode::FORBIDDEN, "同步用户不匹配".to_string()));
    }
    match db.get_user_password_hash(auth_user).await {
        Ok(Some(hash)) if auth::verify_password(&password, hash.as_str()) => Ok(()),
        Ok(_) => Err((StatusCode::UNAUTHORIZED, "同步认证失败".to_string())),
        Err(error) => Err(database_error(error)),
    }
}

fn sync_credentials(headers: &HeaderMap) -> Result<(String, String), (StatusCode, String)> {
    if let Some(encoded) = header_value(headers, SYNC_AUTH_HEADER) {
        let Some((user, password)) = encoded.split_once(':') else {
            return Err((StatusCode::UNAUTHORIZED, "同步认证信息格式错误".to_string()));
        };
        return Ok((decode_header_part(user)?, decode_header_part(password)?));
    }

    Ok((
        required_header(headers, SYNC_USER_HEADER)?,
        required_header(headers, SYNC_PASSWORD_HEADER)?,
    ))
}

fn header_value<'a>(headers: &'a HeaderMap, name: &'static str) -> Option<&'a str> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
}

fn required_header(
    headers: &HeaderMap,
    name: &'static str,
) -> Result<String, (StatusCode, String)> {
    header_value(headers, name)
        .map(str::to_string)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "缺少同步认证信息".to_string()))
}

fn decode_header_part(value: &str) -> Result<String, (StatusCode, String)> {
    percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .map(|value| value.into_owned())
        .map_err(|_| (StatusCode::UNAUTHORIZED, "同步认证信息格式错误".to_string()))
}

fn database_error(error: rusqlite::Error) -> (StatusCode, String) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("数据库错误: {error}"),
    )
}

fn required_string(arguments: &Value, names: &[&str]) -> Result<String, String> {
    string_arg(arguments, names)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("missing required argument: {}", names[0]))
}

fn trimmed_string_arg(arguments: &Value, names: &[&str]) -> Option<String> {
    string_arg(arguments, names)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn string_arg(arguments: &Value, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        arguments
            .get(*name)
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

fn bool_arg(arguments: &Value, names: &[&str]) -> Option<bool> {
    names
        .iter()
        .find_map(|name| arguments.get(*name).and_then(Value::as_bool))
}

fn i64_arg(arguments: &Value, names: &[&str]) -> Option<i64> {
    names
        .iter()
        .find_map(|name| arguments.get(*name).and_then(Value::as_i64))
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn generate_id() -> String {
    format!("id-{}", Uuid::new_v4().simple())
}

fn rpc_success(id: Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message
        }
    })
}

fn json_response(status: StatusCode, value: Value) -> Response {
    (status, Json(value)).into_response()
}
