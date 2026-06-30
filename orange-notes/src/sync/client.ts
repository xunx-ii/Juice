import type {
  ClientMessage,
  RemoteAttachmentMeta,
  RemoteNotebookState,
  ServerMessage,
} from "./protocol";

export interface RemoteStateMessage {
  state: RemoteNotebookState;
  attachments: RemoteAttachmentMeta[];
}

type ConnectionListener = (snapshot: {
  connected: boolean;
  authenticated: boolean;
  error: string | null;
}) => void;
type StateHandler = (message: RemoteStateMessage) => void;

type PushResult =
  | { accepted: true; version: number }
  | { accepted: false; remote: RemoteStateMessage };

interface PendingPush {
  resolve: (result: PushResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SyncClient {
  private ws: WebSocket | null = null;
  private url: string | null = null;
  private username: string | null = null;
  private password: string | null = null;
  private authenticated = false;
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPushes: PendingPush[] = [];
  private listeners = new Set<ConnectionListener>();
  private stateHandlers = new Set<StateHandler>();

  isConnected() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  isAuthenticated() {
    return this.authenticated;
  }

  addListener(listener: ConnectionListener) {
    this.listeners.add(listener);
  }

  removeListener(listener: ConnectionListener) {
    this.listeners.delete(listener);
  }

  addStateHandler(handler: StateHandler) {
    this.stateHandlers.add(handler);
  }

  removeStateHandler(handler: StateHandler) {
    this.stateHandlers.delete(handler);
  }

  static resolveUrl(address: string): string {
    const trimmed = address.trim();
    if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed;
    const proto = trimmed.startsWith("https://") ? "wss://" : "ws://";
    const cleaned = trimmed.replace(/^https?:\/\//, "").replace(/\/$/, "");
    return `${proto}${cleaned}/ws`;
  }

  static loginUrl(address: string, username: string): string {
    return `${SyncClient.resolveUrl(address)}/${encodeURIComponent(username)}`;
  }

  connect(url: string, username: string, password: string): Promise<void> {
    if (
      this.url === url &&
      this.username === username &&
      this.isConnected() &&
      this.authenticated
    ) {
      return Promise.resolve();
    }

    if (this.connectPromise && this.url === url && this.username === username) {
      return this.connectPromise;
    }

    this.disconnect();
    this.url = url;
    this.username = username;
    this.password = password;

    const promise = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      try {
        this.ws = new WebSocket(url);
      } catch (error) {
        this.failConnection(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      this.ws.onopen = () => {
        this.notify(null);
      };

      this.ws.onmessage = (event) => {
        try {
          this.handleMessage(JSON.parse(event.data) as ServerMessage);
        } catch {
          // Ignore malformed server messages; the connection can continue.
        }
      };

      this.ws.onerror = () => {
        if (this.authenticated) {
          this.notify("WebSocket 连接异常");
        }
      };

      this.ws.onclose = () => {
        const wasAuthenticated = this.authenticated;
        const error = new Error(wasAuthenticated ? "同步连接已断开" : "同步连接已关闭");
        this.authenticated = false;
        this.connectReject?.(error);
        this.connectReject = null;
        this.connectResolve = null;
        this.notify(error.message);
        this.failPending(error);
        this.clearConnectTimer();
        this.connectPromise = null;
      };

      this.connectTimer = setTimeout(() => {
        this.failConnection(new Error("连接超时：认证未完成"));
      }, 15_000);
    });

    this.connectPromise = promise;
    return promise.finally(() => {
      if (this.connectPromise === promise) {
        this.connectPromise = null;
      }
    });
  }

  push(state: RemoteNotebookState, baseVersion: number, timeoutMs = 10_000): Promise<PushResult> {
    if (!this.isConnected()) return Promise.reject(new Error("WebSocket 未连接"));
    if (!this.authenticated) return Promise.reject(new Error("尚未完成认证"));

    return new Promise((resolve, reject) => {
      const pending: PendingPush = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pendingPushes = this.pendingPushes.filter((item) => item !== pending);
          reject(new Error("同步超时"));
        }, timeoutMs),
      };
      this.pendingPushes.push(pending);
      this.sendMessage({ type: "push", state, base_version: baseVersion });
    });
  }

  disconnect() {
    this.clearConnectTimer();
    this.closeWebSocket();
    this.authenticated = false;
    this.connectPromise = null;
    this.failPending(new Error("同步连接已关闭"));
    this.notify(null);
  }

  private handleMessage(message: ServerMessage) {
    switch (message.type) {
      case "welcome":
        this.sendMessage({
          type: "authenticate",
          username: this.username ?? "",
          password: this.password ?? "",
        });
        break;

      case "authenticated":
        this.authenticated = true;
        this.clearConnectTimer();
        this.connectResolve?.();
        this.connectResolve = null;
        this.connectReject = null;
        this.notify(null);
        break;

      case "authentication_failed":
        this.failConnection(new Error("认证失败：用户名或密码错误"));
        break;

      case "push_ack": {
        const pending = this.pendingPushes.shift();
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve({ accepted: true, version: message.version });
        }
        break;
      }

      case "push_rejected": {
        const remote: RemoteStateMessage = {
          state: message.state,
          attachments: message.attachments,
        };
        const pending = this.pendingPushes.shift();
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve({ accepted: false, remote });
        } else {
          this.stateHandlers.forEach((handler) => handler(remote));
        }
        break;
      }

      case "state": {
        const remote: RemoteStateMessage = {
          state: message.state,
          attachments: message.attachments,
        };

        this.stateHandlers.forEach((handler) => handler(remote));
        break;
      }

      case "error":
        this.notify(message.message);
        this.failPending(new Error(message.message));
        break;
    }
  }

  private sendMessage(message: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private failConnection(error: Error) {
    this.clearConnectTimer();
    this.connectReject?.(error);
    this.connectReject = null;
    this.connectResolve = null;
    this.connectPromise = null;
    this.authenticated = false;
    this.closeWebSocket();
    this.failPending(error);
    this.notify(error.message);
  }

  private failPending(error: Error) {
    for (const pending of this.pendingPushes.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private clearConnectTimer() {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private closeWebSocket() {
    if (!this.ws) return;
    this.ws.onclose = null;
    this.ws.onerror = null;
    this.ws.onmessage = null;
    this.ws.onopen = null;
    try {
      this.ws.close();
    } catch {
      // Closing is best-effort.
    }
    this.ws = null;
  }

  private notify(error: string | null) {
    const snapshot = {
      connected: this.isConnected(),
      authenticated: this.authenticated,
      error,
    };
    this.listeners.forEach((listener) => listener(snapshot));
  }
}

export const syncClient = new SyncClient();
