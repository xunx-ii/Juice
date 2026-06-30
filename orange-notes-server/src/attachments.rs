use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use std::sync::Arc;

use crate::{auth, db::Database};

const SYNC_USER_HEADER: &str = "x-orange-notes-user";
const SYNC_PASSWORD_HEADER: &str = "x-orange-notes-password";

/// GET /api/sync/files/:username — list all attachment metadata for a user.
pub async fn list_attachments(
    Path(username): Path<String>,
    headers: HeaderMap,
    State(db): State<Arc<Database>>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    require_sync_auth(&headers, db.as_ref(), &username).await?;

    match db.list_attachments(&username).await {
        Ok(list) => {
            let files: Vec<AttachmentMeta> = list
                .into_iter()
                .map(|(file_name, mime)| AttachmentMeta { file_name, mime })
                .collect();
            Ok(Json(serde_json::json!({ "files": files })))
        }
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, format!("数据库错误: {}", e))),
    }
}

#[derive(Serialize)]
pub struct AttachmentMeta {
    pub file_name: String,
    pub mime: String,
}

/// GET /api/sync/files/:username/:filename — download a specific file (binary).
pub async fn download_attachment(
    Path((username, filename)): Path<(String, String)>,
    headers: HeaderMap,
    State(db): State<Arc<Database>>,
) -> Result<Response, (StatusCode, String)> {
    require_sync_auth(&headers, db.as_ref(), &username).await?;
    let filename = validated_filename(&filename)?;

    match db.get_attachment(&username, &filename).await {
        Ok(Some((mime, data))) => {
            Ok((
                [(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "public, max-age=86400".to_string())],
                data,
            )
                .into_response())
        }
        Ok(None) => Err((StatusCode::NOT_FOUND, "文件不存在".to_string())),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, format!("数据库错误: {}", e))),
    }
}

/// POST /api/sync/files/:username/:filename — upload a file (binary body).
pub async fn upload_attachment(
    Path((username, filename)): Path<(String, String)>,
    headers: HeaderMap,
    State(db): State<Arc<Database>>,
    body: Bytes,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    require_sync_auth(&headers, db.as_ref(), &username).await?;
    let filename = validated_filename(&filename)?;

    // Determine MIME type from filename extension, default to octet-stream.
    let mime = guess_mime(&filename);

    match db.upsert_attachment(&username, &filename, &mime, &body).await {
        Ok(()) => Ok(Json(serde_json::json!({ "success": true, "filename": filename }))),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, format!("存储失败: {}", e))),
    }
}

/// DELETE /api/sync/files/:username/:filename — delete a specific file.
pub async fn delete_attachment(
    Path((username, filename)): Path<(String, String)>,
    headers: HeaderMap,
    State(db): State<Arc<Database>>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    require_sync_auth(&headers, db.as_ref(), &username).await?;
    let filename = validated_filename(&filename)?;

    match db.delete_attachment(&username, &filename).await {
        Ok(()) => Ok(Json(serde_json::json!({ "success": true }))),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, format!("删除失败: {}", e))),
    }
}

// ---- helpers ----

fn url_decode(s: &str) -> String {
    percent_encoding::percent_decode_str(s)
        .decode_utf8_lossy()
        .to_string()
}

fn required_header<'a>(
    headers: &'a HeaderMap,
    name: &'static str,
) -> Result<&'a str, (StatusCode, String)> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "缺少同步认证信息".to_string()))
}

async fn require_sync_auth(
    headers: &HeaderMap,
    db: &Database,
    username: &str,
) -> Result<(), (StatusCode, String)> {
    let auth_user = required_header(headers, SYNC_USER_HEADER)?;
    let password = required_header(headers, SYNC_PASSWORD_HEADER)?;

    if auth_user != username {
        return Err((StatusCode::FORBIDDEN, "同步用户不匹配".to_string()));
    }

    match db.get_user_password_hash(auth_user.to_string()).await {
        Ok(Some(hash)) if auth::verify_password(password, hash.as_str()) => Ok(()),
        Ok(_) => Err((StatusCode::UNAUTHORIZED, "同步认证失败".to_string())),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, format!("数据库错误: {}", e))),
    }
}

fn validated_filename(raw: &str) -> Result<String, (StatusCode, String)> {
    let filename = url_decode(raw);
    if filename.is_empty() || filename.contains('/') || filename.contains('\\') {
        return Err((StatusCode::BAD_REQUEST, "无效的文件名".to_string()));
    }
    Ok(filename)
}

fn guess_mime(filename: &str) -> String {
    let lower = filename.to_lowercase();
    if lower.ends_with(".png") {
        "image/png".to_string()
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg".to_string()
    } else if lower.ends_with(".gif") {
        "image/gif".to_string()
    } else if lower.ends_with(".webp") {
        "image/webp".to_string()
    } else if lower.ends_with(".svg") {
        "image/svg+xml".to_string()
    } else if lower.ends_with(".bmp") {
        "image/bmp".to_string()
    } else {
        "application/octet-stream".to_string()
    }
}
