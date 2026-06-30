use axum::{
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use std::sync::OnceLock;

/// The admin token from the ADMIN_TOKEN environment variable.
pub static TOKEN: OnceLock<String> = OnceLock::new();

/// Marker type indicating admin auth was validated.
pub struct AdminAuth;

/// Check if the request has a valid admin token.
/// Returns Ok(AdminAuth) if valid or no token is configured.
/// Returns Err(Response) with 401 if token is required but missing/invalid.
pub fn check_admin_auth(headers: &HeaderMap) -> Result<AdminAuth, Response> {
    let Some(expected) = TOKEN.get() else {
        // No token configured — allow (dev mode).
        return Ok(AdminAuth);
    };
    if expected.is_empty() {
        return Ok(AdminAuth);
    }

    let header = headers
        .get("Authorization")
        .and_then(|v| v.to_str().ok());

    match header {
        Some(value) if value == format!("Bearer {}", expected) => Ok(AdminAuth),
        _ => Err((
            StatusCode::UNAUTHORIZED,
            "Unauthorized: invalid or missing admin token",
        )
            .into_response()),
    }
}
