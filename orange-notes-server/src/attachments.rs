use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use std::sync::Arc;

use crate::db::Database;

/// GET /api/sync/files/:username — list all attachment metadata for a user.
pub async fn list_attachments(
    Path(username): Path<String>,
    State(db): State<Arc<Database>>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
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
    State(db): State<Arc<Database>>,
) -> Result<Response, (StatusCode, String)> {
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
    State(db): State<Arc<Database>>,
    body: Bytes,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let filename = url_decode(&filename);
    if filename.is_empty() || filename.contains('/') || filename.contains('\\') {
        return Err((StatusCode::BAD_REQUEST, "无效的文件名".to_string()));
    }

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
    State(db): State<Arc<Database>>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    match db.delete_attachment(&username, &url_decode(&filename)).await {
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
