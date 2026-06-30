use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::{admin_auth, auth, db::Database};
use crate::sync::ClientMap;

#[derive(Serialize)]
pub struct SystemInfo {
    pub version: &'static str,
    pub uptime_seconds: u64,
    pub folder_count: i64,
    pub note_count: i64,
    pub user_count: i64,
    pub active_ws_clients: usize,
}

#[derive(Serialize)]
pub struct UserInfo {
    pub username: String,
}

#[derive(Default, Deserialize)]
pub struct Pagination {
    #[serde(default = "default_page")]
    pub page: i64,
    #[serde(default = "default_page_size")]
    pub page_size: i64,
}

fn default_page() -> i64 { 1 }
fn default_page_size() -> i64 { 20 }

pub async fn system_info(
    headers: HeaderMap,
    State(db): State<Arc<Database>>,
    State(clients): State<Arc<ClientMap>>,
) -> Result<impl IntoResponse, Response> {
    admin_auth::check_admin_auth(&headers)?;
    let (folder_count, note_count, user_count) = match gather_counts(&db).await {
        Some(c) => c,
        None => return Ok(Json(serde_json::json!({ "error": "database error" })).into_response()),
    };

    Ok(Json(SystemInfo {
        version: env!("CARGO_PKG_VERSION"),
        uptime_seconds: crate::health::START_TIME.get().map(|t| t.elapsed().as_secs()).unwrap_or(0),
        folder_count,
        note_count,
        user_count,
        active_ws_clients: clients.count(),
    }).into_response())
}

async fn gather_counts(db: &Database) -> Option<(i64, i64, i64)> {
    let folder_count: i64 = db.conn_count("SELECT COUNT(*) FROM folders").await.ok()?;
    let note_count: i64 = db.conn_count("SELECT COUNT(*) FROM notes").await.ok()?;
    let user_count: i64 = db.conn_count("SELECT COUNT(*) FROM users").await.ok()?;
    Some((folder_count, note_count, user_count))
}

pub async fn list_users(
    headers: HeaderMap,
    State(db): State<Arc<Database>>,
    Query(pagination): Query<Pagination>,
) -> Result<impl IntoResponse, Response> {
    admin_auth::check_admin_auth(&headers)?;
    let page = pagination.page.max(1);
    let page_size = pagination.page_size.clamp(1, 100);
    let offset = (page - 1) * page_size;

    let users: Vec<UserInfo> = match db.list_users(page_size, offset).await {
        Ok(list) => list
            .into_iter()
            .map(|username| UserInfo { username })
            .collect(),
        Err(_) => return Ok(Json(serde_json::json!({ "error": "database error" })).into_response()),
    };

    let total = db.conn_count("SELECT COUNT(*) FROM users").await.unwrap_or(0);

    Ok(Json(serde_json::json!({
        "users": users,
        "pager": { "page": page, "page_size": page_size, "total_rows": total }
    })).into_response())
}

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub password: String,
}

pub async fn register_user(
    State(db): State<Arc<Database>>,
    Json(body): Json<RegisterRequest>,
) -> Result<impl IntoResponse, Response> {
    // Public endpoint — users self-register from the client.
    // Admin-only user management (delete, list) is protected via admin_auth.
    let username = body.username.trim().to_string();
    if username.is_empty() || username.len() > 64 {
        return Ok(Json(serde_json::json!({
            "success": false,
            "message": "用户名长度需为 1-64 个字符",
        })));
    }
    if body.password.is_empty() || body.password.len() > 128 {
        return Ok(Json(serde_json::json!({
            "success": false,
            "message": "密码长度需为 1-128 个字符",
        })));
    }

    // Check if user already exists.
    match db.get_user_password_hash(username.clone()).await {
        Ok(Some(_)) => {
            return Ok(Json(serde_json::json!({
                "success": false,
                "message": "用户名已被注册",
            })));
        }
        Ok(None) => {}
        Err(e) => {
            return Ok(Json(serde_json::json!({
                "success": false,
                "message": format!("数据库错误: {}", e),
            })));
        }
    }

    match auth::hash_password(&body.password) {
        Ok(hash) => match db.create_user(username.clone(), hash).await {
            Ok(_) => Ok(Json(serde_json::json!({
                "success": true,
                "message": format!("用户 '{}' 注册成功", username),
            }))),
            Err(e) => Ok(Json(serde_json::json!({
                "success": false,
                "message": format!("创建用户失败: {}", e),
            }))),
        },
        Err(e) => Ok(Json(serde_json::json!({
            "success": false,
            "message": format!("密码哈希失败: {}", e),
        }))),
    }
}

pub async fn list_ws_clients(
    headers: HeaderMap,
    State(clients): State<Arc<ClientMap>>,
) -> Result<impl IntoResponse, Response> {
    admin_auth::check_admin_auth(&headers)?;
    Ok(Json(serde_json::json!({ "clients": clients.list() })).into_response())
}

pub async fn delete_user(
    headers: HeaderMap,
    Path(username): Path<String>,
    State(db): State<Arc<Database>>,
) -> Result<impl IntoResponse, Response> {
    admin_auth::check_admin_auth(&headers)?;

    // Get note count before deletion for the response.
    let note_count = db.note_count(&username).await.unwrap_or(0);

    match db.delete_user(&username).await {
        Ok(true) => Ok(Json(serde_json::json!({
            "success": true,
            "message": format!("用户 '{}' 及其 {} 条笔记已删除", username, note_count),
        }))),
        Ok(false) => Ok(Json(serde_json::json!({
            "success": false,
            "message": format!("用户 '{}' 不存在", username),
        }))),
        Err(e) => Ok(Json(serde_json::json!({
            "success": false,
            "message": format!("删除失败: {}", e),
        }))),
    }
}
