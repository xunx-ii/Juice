use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path,
        State,
    },
    response::IntoResponse,
};
use std::sync::Arc;
use tokio_tungstenite::tungstenite as ws2;

use crate::auth;
use crate::db::{Database, Folder, Note, NotebookState};

#[derive(Debug, serde::Deserialize)]
#[serde(tag = "type")]
#[serde(rename_all = "snake_case")]
enum ClientMessage {
    Authenticate {
        username: String,
        password: String,
    },
    Push {
        state: NotebookState,
    },
    RequestState,
}

#[derive(Debug, serde::Serialize)]
#[serde(tag = "type")]
#[serde(rename_all = "snake_case")]
enum ServerMessage {
    Welcome {
        session_id: String,
    },
    Authenticated,
    AuthenticationFailed,
    PushAck {
        version: i64,
    },
    Error {
        message: String,
    },
    State {
        state: NotebookState,
    },
    /// Sent when an authenticated user pushes new changes; other sessions
    /// of the same user receive this so they can load the latest state.
    ServerDone,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(username): Path<String>,
    State(database): State<Arc<Database>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, username, database))
}

async fn handle_socket(mut socket: WebSocket, username: String, db: Arc<Database>) {
    let session_id = uuid::Uuid::new_v4().to_string();
    let _ = send(&mut socket, &ServerMessage::Welcome {
        session_id,
    }).await;

    let mut auth_success = false;

    while let Some(Ok(message)) = socket.recv().await {
        match message {
            Message::Text(text) => {
                match serde_json::from_str::<ClientMessage>(&text) {
                    Ok(client_message) => {
                        match client_message {
                            ClientMessage::Authenticate { username, password } => {
                                match db.get_user_password_hash(&username).await {
                                    Ok(Some(hash)) => {
                                        if auth::verify_password(&password, hash.as_str()) {
                                            auth_success = true;
                                            let _ = send(&mut socket, &ServerMessage::Authenticated).await;
                                        } else {
                                            let _ = send(&mut socket, &ServerMessage::AuthenticationFailed).await;
                                        }
                                    }
                                    Ok(None) => {
                                        // Auto-create user if it doesn't exist yet.
                                        match auth::hash_password(&password) {
                                            Ok(hash) => {
                                                match db.create_user(&username, &hash).await {
                                                    Ok(_) => {
                                                        auth_success = true;
                                                        let _ = send(&mut socket, &ServerMessage::Authenticated).await;
                                                    }
                                                    Err(e) => {
                                                        let _ = send(&mut socket, &ServerMessage::Error {
                                                            message: format!("Failed to create user: {}", e),
                                                        }).await;
                                                    }
                                                }
                                            }
                                            Err(e) => {
                                                let _ = send(&mut socket, &ServerMessage::Error {
                                                    message: format!("Failed to hash password: {}", e),
                                                }).await;
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        let _ = send(&mut socket, &ServerMessage::Error {
                                            message: format!("Database error: {}", e),
                                        }).await;
                                    }
                                }
                            }
                            ClientMessage::Push { state } => {
                                if !auth_success {
                                    let _ = send(&mut socket, &ServerMessage::Error {
                                        message: "Not authenticated".to_string(),
                                    }).await;
                                    continue;
                                }

                                if let Err(e) = apply_state(&db, &state).await {
                                    let _ = send(&mut socket, &ServerMessage::Error {
                                        message: format!("Push failed: {}", e),
                                    }).await;
                                    continue;
                                }

                                let new_version = chrono::Utc::now().timestamp_millis();
                                let _ = send(&mut socket, &ServerMessage::PushAck {
                                    version: new_version,
                                }).await;
                            }
                            ClientMessage::RequestState => {
                                if !auth_success {
                                    let _ = send(&mut socket, &ServerMessage::Error {
                                        message: "Not authenticated".to_string(),
                                    }).await;
                                    continue;
                                }

                                match db.get_state().await {
                                    Ok(state) => {
                                        let _ = send(&mut socket, &ServerMessage::State {
                                            state,
                                        }).await;
                                    }
                                    Err(e) => {
                                        let _ = send(&mut socket, &ServerMessage::Error {
                                            message: format!("Failed to load state: {}", e),
                                        }).await;
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        let _ = send(&mut socket, &ServerMessage::Error {
                            message: format!("Invalid message: {}", e),
                        }).await;
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
}

async fn send(socket: &mut WebSocket, msg: &ServerMessage) -> Result<(), axum::Error> {
    match serde_json::to_string(msg) {
        Ok(json) => socket.send(Message::Text(json)).await,
        Err(_) => Err(axum::Error::new("serialization failed")),
    }
}

async fn apply_state(db: &Database, state: &NotebookState) -> Result<(), String> {
    for folder in &state.folders {
        db.upsert_folder(folder)
            .await
            .map_err(|e| format!("upsert folder {}: {}", folder.id, e))?;
    }

    for note in &state.notes {
        db.upsert_note(note)
            .await
            .map_err(|e| format!("upsert note {}: {}", note.id, e))?;
    }

    for deleted in &state.deleted {
        db.delete_entity(&deleted.entity_type, &deleted.id)
            .await
            .map_err(|e| format!("delete {} {}: {}", deleted.entity_type, deleted.id, e))?;
    }

    Ok(())
}
