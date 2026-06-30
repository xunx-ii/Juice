use axum::{
    routing::get,
    Router,
};
use std::net::SocketAddr;
use std::sync::Arc;
use tracing_subscriber::EnvFilter;

mod auth;
mod db;
mod sync;

use db::Database;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "notes.sqlite".into());
    let db = Arc::new(Database::new(&database_url).await?);

    let app = Router::new()
        .route("/ws/:username", get(sync::ws_handler))
        .with_state(db);

    let addr: SocketAddr = "0.0.0.0:8777".parse()?;
    tracing::info!("Server listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
