use axum::{response::IntoResponse, routing::get, Router};

const ADMIN_HTML: &str = include_str!("admin.html");

pub fn admin_router() -> Router<crate::AppState> {
    Router::new().route("/admin", get(serve_admin))
}

async fn serve_admin() -> impl IntoResponse {
    (
        [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
        ADMIN_HTML,
    )
}
