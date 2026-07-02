use axum::{
    extract::FromRef,
    routing::{delete, get, post},
    Router,
};
use std::net::SocketAddr;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tracing_subscriber::EnvFilter;

mod admin;
mod admin_auth;
mod admin_static;
mod attachments;
mod auth;
mod db;
mod health;
mod mcp;
mod sync;

use db::Database;

#[derive(Clone)]
struct AppState {
    db: Arc<Database>,
    clients: Arc<sync::ClientMap>,
}

// Allow axum to extract Arc<Database> and Arc<ClientMap> from AppState.
impl FromRef<AppState> for Arc<Database> {
    fn from_ref(state: &AppState) -> Self {
        state.db.clone()
    }
}
impl FromRef<AppState> for Arc<sync::ClientMap> {
    fn from_ref(state: &AppState) -> Self {
        state.clients.clone()
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    health::START_TIME.get_or_init(std::time::Instant::now);

    // Load admin token from environment.
    if let Ok(token) = std::env::var("ADMIN_TOKEN") {
        admin_auth::TOKEN.get_or_init(|| token.clone());
        if token.is_empty() {
            tracing::warn!("ADMIN_TOKEN is empty — admin endpoints are unprotected");
        } else {
            tracing::info!("Admin authentication enabled");
        }
    } else {
        tracing::warn!("ADMIN_TOKEN not set — admin endpoints are unprotected");
    }

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "notes.sqlite".into());
    let state = AppState {
        db: Arc::new(Database::new(&database_url).await?),
        clients: Arc::new(sync::ClientMap::new()),
    };

    let app = Router::new()
        // API routes
        .route("/api/health", get(health::health))
        .route("/api/admin/systeminfo", get(admin::system_info))
        .route("/api/admin/ws_clients", get(admin::list_ws_clients))
        .route("/api/admin/users", get(admin::list_users))
        .route("/api/admin/register", post(admin::register_user))
        .route("/api/admin/users/:username", delete(admin::delete_user))
        // File/attachment sync (HTTP binary, no admin token needed)
        .route(
            "/api/sync/files/:username",
            get(attachments::list_attachments),
        )
        .route(
            "/api/sync/files/:username/:filename",
            get(attachments::download_attachment),
        )
        .route(
            "/api/sync/files/:username/:filename",
            post(attachments::upload_attachment),
        )
        .route(
            "/api/sync/files/:username/:filename",
            delete(attachments::delete_attachment),
        )
        .route("/api/sync/mcp-token/:username", get(mcp::get_token))
        .route("/api/sync/mcp-token/:username", post(mcp::generate_token))
        .route(
            "/api/sync/e2ee-check/:username",
            post(mcp::store_e2ee_check),
        )
        .route(
            "/api/sync/e2ee-check/:username/verify",
            post(mcp::verify_e2ee_check),
        )
        .route("/mcp", get(mcp::mcp_info))
        .route("/mcp", post(mcp::mcp_handler))
        // WebSocket sync
        .route("/ws/:username", get(sync::ws_handler))
        // Admin dashboard (static HTML) — merge routes so it shares state
        .merge(admin_static::admin_router())
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr: SocketAddr = "0.0.0.0:8777".parse()?;
    tracing::info!("Server listening on {}", addr);
    tracing::info!("Admin dashboard available at http://{}/admin", addr);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
