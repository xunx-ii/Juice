use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

use crate::auth;
use crate::db::{Database, NotebookState};

type OutboundSender = mpsc::UnboundedSender<ServerMessage>;

#[derive(Clone, Serialize)]
pub struct ClientInfo {
    pub username: String,
    pub connected_at: String,
}

#[derive(Clone)]
struct ClientSession {
    info: ClientInfo,
    tx: OutboundSender,
}

#[derive(Clone, Debug, Serialize)]
pub struct AttachmentMeta {
    pub file_name: String,
    pub mime: String,
}

#[derive(Clone, Default)]
pub struct ClientMap {
    clients: Arc<Mutex<HashMap<String, ClientSession>>>,
}

impl ClientMap {
    pub fn new() -> Self {
        Self::default()
    }

    async fn add(&self, session_id: String, session: ClientSession) {
        self.clients.lock().await.insert(session_id, session);
    }

    pub async fn remove(&self, session_id: &str) {
        self.clients.lock().await.remove(session_id);
    }

    pub async fn broadcast_user(&self, username: &str, message: ServerMessage) {
        let mut clients = self.clients.lock().await;
        let mut stale_sessions = Vec::new();

        for (session_id, session) in clients.iter() {
            if session.info.username != username {
                continue;
            }

            if session.tx.send(message.clone()).is_err() {
                stale_sessions.push(session_id.clone());
            }
        }

        for session_id in stale_sessions {
            clients.remove(&session_id);
        }
    }

    pub fn count(&self) -> usize {
        if let Ok(guard) = self.clients.try_lock() {
            guard.len()
        } else {
            0
        }
    }

    pub fn list(&self) -> Vec<ClientInfo> {
        if let Ok(guard) = self.clients.try_lock() {
            guard.values().map(|session| session.info.clone()).collect()
        } else {
            Vec::new()
        }
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(tag = "type")]
#[serde(rename_all = "snake_case")]
enum ClientMessage {
    Authenticate { username: String, password: String },
    Push {
        state: NotebookState,
        base_version: i64,
    },
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(tag = "type")]
#[serde(rename_all = "snake_case")]
pub enum ServerMessage {
    Welcome {
        session_id: String,
    },
    Authenticated,
    AuthenticationFailed,
    PushAck {
        version: i64,
    },
    PushRejected {
        state: NotebookState,
        attachments: Vec<AttachmentMeta>,
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

async fn handle_socket(
    socket: WebSocket,
    path_username: String,
    db: Arc<Database>,
    clients: Arc<ClientMap>,
) {
    let session_id = uuid::Uuid::new_v4().to_string();
    let (mut socket_tx, mut socket_rx) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<ServerMessage>();

    let writer = tokio::spawn(async move {
        while let Some(message) = out_rx.recv().await {
            let Ok(json) = serde_json::to_string(&message) else {
                break;
            };

            if socket_tx.send(Message::Text(json)).await.is_err() {
                break;
            }
        }
    });

    send_channel(
        &out_tx,
        ServerMessage::Welcome {
            session_id: session_id.clone(),
        },
    );

    let mut authenticated_user: Option<String> = None;

    while let Some(message) = socket_rx.next().await {
        let Ok(message) = message else {
            break;
        };

        match message {
            Message::Text(text) => match serde_json::from_str::<ClientMessage>(&text) {
                Ok(ClientMessage::Authenticate { username, password }) => {
                    if authenticated_user.is_some() {
                        continue;
                    }

                    if username != path_username {
                        send_channel(&out_tx, ServerMessage::AuthenticationFailed);
                        continue;
                    }

                    match authenticate(&db, &username, &password).await {
                        Ok(true) => {
                            authenticated_user = Some(username.clone());
                            clients
                                .add(
                                    session_id.clone(),
                                    ClientSession {
                                        info: ClientInfo {
                                            username: username.clone(),
                                            connected_at: chrono::Utc::now().to_rfc3339(),
                                        },
                                        tx: out_tx.clone(),
                                    },
                                )
                                .await;

                            send_channel(&out_tx, ServerMessage::Authenticated);
                            if let Err(error) = send_current_state(&out_tx, &db, &username).await {
                                send_channel(&out_tx, ServerMessage::Error { message: error });
                            }
                        }
                        Ok(false) => {
                            send_channel(&out_tx, ServerMessage::AuthenticationFailed);
                        }
                        Err(error) => {
                            send_channel(&out_tx, ServerMessage::Error { message: error });
                        }
                    }
                }
                Ok(ClientMessage::Push {
                    state,
                    base_version,
                }) => {
                    let Some(user) = authenticated_user.as_deref() else {
                        send_channel(
                            &out_tx,
                            ServerMessage::Error {
                                message: "未完成同步认证".to_string(),
                            },
                        );
                        continue;
                    };

                    let version = match apply_state(&db, user, &state, base_version).await {
                        Ok(ApplyResult::Accepted { version }) => version,
                        Ok(ApplyResult::Rejected { latest }) => {
                            send_channel(&out_tx, latest);
                            continue;
                        }
                        Err(error) => {
                            send_channel(
                                &out_tx,
                                ServerMessage::Error {
                                    message: format!("同步写入失败: {error}"),
                                },
                            );
                            continue;
                        }
                    };

                    send_channel(
                        &out_tx,
                        ServerMessage::PushAck { version },
                    );

                    if let Err(error) = broadcast_current_state(&clients, &db, user).await {
                        send_channel(&out_tx, ServerMessage::Error { message: error });
                    }
                }
                Err(error) => {
                    send_channel(
                        &out_tx,
                        ServerMessage::Error {
                            message: format!("同步消息格式错误: {error}"),
                        },
                    );
                }
            },
            Message::Close(_) => break,
            _ => {}
        }
    }

    clients.remove(&session_id).await;
    writer.abort();
}

async fn authenticate(db: &Database, username: &str, password: &str) -> Result<bool, String> {
    match db.get_user_password_hash(username.to_string()).await {
        Ok(Some(hash)) => Ok(auth::verify_password(password, hash.as_str())),
        Ok(None) => Ok(false),
        Err(error) => Err(format!("数据库错误: {error}")),
    }
}

fn send_channel(tx: &OutboundSender, message: ServerMessage) {
    let _ = tx.send(message);
}

async fn read_state_and_attachments(
    db: &Database,
    username: &str,
) -> Result<(NotebookState, Vec<AttachmentMeta>), String> {
    let state = db
        .get_state(username)
        .await
        .map_err(|error| format!("读取同步状态失败: {error}"))?;
    let attachments = db
        .list_attachments(username)
        .await
        .map_err(|error| format!("读取附件列表失败: {error}"))?
        .into_iter()
        .map(|(file_name, mime)| AttachmentMeta { file_name, mime })
        .collect();

    Ok((state, attachments))
}

async fn current_state_message(db: &Database, username: &str) -> Result<ServerMessage, String> {
    let (state, attachments) = read_state_and_attachments(db, username).await?;
    Ok(ServerMessage::State { state, attachments })
}

async fn send_current_state(
    tx: &OutboundSender,
    db: &Database,
    username: &str,
) -> Result<(), String> {
    let message = current_state_message(db, username).await?;
    tx.send(message)
        .map_err(|_| "同步连接已断开".to_string())
}

async fn broadcast_current_state(
    clients: &ClientMap,
    db: &Database,
    username: &str,
) -> Result<(), String> {
    let message = current_state_message(db, username).await?;
    clients.broadcast_user(username, message).await;
    Ok(())
}

enum ApplyResult {
    Accepted { version: i64 },
    Rejected { latest: ServerMessage },
}

async fn apply_state(
    db: &Database,
    user_id: &str,
    state: &NotebookState,
    base_version: i64,
) -> Result<ApplyResult, String> {
    match db
        .replace_state_if_version(user_id.to_string(), state.clone(), base_version)
        .await
        .map_err(|error| format!("替换笔记本状态失败: {error}"))?
    {
        Some(version) => Ok(ApplyResult::Accepted { version }),
        None => {
            let (state, attachments) = read_state_and_attachments(db, user_id).await?;
            Ok(ApplyResult::Rejected {
                latest: ServerMessage::PushRejected { state, attachments },
            })
        }
    }
}
