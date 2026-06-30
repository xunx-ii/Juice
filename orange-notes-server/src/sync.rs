use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path,
        State,
    },
    response::IntoResponse,
};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::auth;
use crate::db::{Database, NotebookState};

#[derive(Clone, Serialize)]
pub struct ClientInfo {
    pub username: String,
    pub connected_at: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct AttachmentMeta {
    pub file_name: String,
    pub mime: String,
}

#[derive(Clone, Default)]
pub struct ClientMap {
    clients: Arc<Mutex<HashMap<String, ClientInfo>>>,
}

impl ClientMap {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn add(&self, session_id: String, info: ClientInfo) {
        self.clients.lock().await.insert(session_id, info);
    }

    pub async fn remove(&self, session_id: &str) {
        self.clients.lock().await.remove(session_id);
    }

    pub fn count(&self) -> usize {
        // Best-effort count; if the lock is contended, skip.
        if let Ok(guard) = self.clients.try_lock() {
            guard.len()
        } else {
            0
        }
    }

    pub fn list(&self) -> Vec<ClientInfo> {
        if let Ok(guard) = self.clients.try_lock() {
            guard.values().cloned().collect()
        } else {
            Vec::new()
        }
    }
}

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
        attachments: Vec<AttachmentMeta>,
    },
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(username): Path<String>,
    State(database): State<Arc<Database>>,
    State(clients): State<Arc<ClientMap>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, username, database, clients))
}

async fn handle_socket(mut socket: WebSocket, username: String, db: Arc<Database>, clients: Arc<ClientMap>) {
    let session_id = uuid::Uuid::new_v4().to_string();
    let connected_at = chrono::Utc::now().to_rfc3339();
    clients.add(session_id.clone(), ClientInfo {
        username: username.clone(),
        connected_at,
    }).await;

    let _ = send(&mut socket, &ServerMessage::Welcome {
        session_id: session_id.clone(),
    }).await;

    let mut auth_success = false;
    let mut authenticated_user: Option<String> = None;

    while let Some(Ok(message)) = socket.recv().await {
        match message {
            Message::Text(text) => {
                match serde_json::from_str::<ClientMessage>(&text) {
                    Ok(client_message) => {
                        match client_message {
                            ClientMessage::Authenticate { username: auth_username, password } => {
                                if auth_username != username {
                                    let _ = send(&mut socket, &ServerMessage::AuthenticationFailed).await;
                                    continue;
                                }

                                // Only authenticate existing users — no auto-registration.
                                match db.get_user_password_hash(auth_username.clone()).await {
                                    Ok(Some(hash)) => {
                                        if auth::verify_password(&password, hash.as_str()) {
                                            auth_success = true;
                                            authenticated_user = Some(auth_username.clone());
                                            clients.add(session_id.clone(), ClientInfo {
                                                username: auth_username.clone(),
                                                connected_at: chrono::Utc::now().to_rfc3339(),
                                            }).await;
                                            let _ = send(&mut socket, &ServerMessage::Authenticated).await;
                                        } else {
                                            let _ = send(&mut socket, &ServerMessage::AuthenticationFailed).await;
                                        }
                                    }
                                    Ok(None) => {
                                        // User does not exist — reject with a clear message.
                                        let _ = send(&mut socket, &ServerMessage::Error {
                                            message: format!("用户 '{}' 不存在，请先在管理后台注册", auth_username),
                                        }).await;
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

                                let user = authenticated_user.clone().unwrap_or_default();
                                if let Err(e) = apply_state(&db, &user, &state).await {
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

                                let user = authenticated_user.clone().unwrap_or_default();
                                match db.get_state(&user).await {
                                    Ok(state) => {
                                        // Also fetch attachment metadata so the client
                                        // can download images it's missing locally.
                                        let attachments = db
                                            .list_attachments(&user)
                                            .await
                                            .unwrap_or_default()
                                            .into_iter()
                                            .map(|(file_name, mime)| AttachmentMeta { file_name, mime })
                                            .collect();
                                        let _ = send(&mut socket, &ServerMessage::State {
                                            state,
                                            attachments,
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

    // Client disconnected — remove from active clients map.
    clients.remove(&session_id).await;
}

async fn send(socket: &mut WebSocket, msg: &ServerMessage) -> Result<(), axum::Error> {
    match serde_json::to_string(msg) {
        Ok(json) => socket.send(Message::Text(json)).await,
        Err(_) => Err(axum::Error::new("serialization failed")),
    }
}

async fn apply_state(db: &Database, user_id: &str, state: &NotebookState) -> Result<(), String> {
    for folder in &state.folders {
        db.upsert_folder(user_id.to_string(), folder.clone())
            .await
            .map_err(|e| format!("upsert folder {}: {}", folder.id, e))?;
    }

    for note in &state.notes {
        db.upsert_note(user_id.to_string(), note.clone())
            .await
            .map_err(|e| format!("upsert note {}: {}", note.id, e))?;
    }

    for deleted in &state.deleted {
        db.delete_entity(user_id.to_string(), deleted.entity_type.clone(), deleted.id.clone())
            .await
            .map_err(|e| format!("delete {} {}: {}", deleted.entity_type, deleted.id, e))?;
    }

    Ok(())
}
