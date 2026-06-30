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

  private static normalizeServerAddress(address: string): {
    host: string;
    path: string;
    secure: boolean;
  } {
    const trimmed = address.trim();
    if (!trimmed) throw new Error("服务器地址不能为空");

    const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
      ? trimmed
      : `http://${trimmed}`;
    const parsed = new URL(withScheme);
    const protocol = parsed.protocol.toLowerCase();
    if (!["http:", "https:", "ws:", "wss:"].includes(protocol)) {
      throw new Error("服务器地址协议不支持");
    }

    const secure = protocol === "https:" || protocol === "wss:";
    let path = parsed.pathname.replace(/\/+$/, "");
    if (path === "/") path = "";
    if (path.endsWith("/ws")) path = path.slice(0, -3);

    return { host: parsed.host, path, secure };
  }

  static resolveUrl(address: string): string {
    const { host, path, secure } = SyncClient.normalizeServerAddress(address);
    const proto = secure ? "wss://" : "ws://";
    return `${proto}${host}${path}/ws`;
  }

  static httpBaseUrl(address: string): string {
    const { host, path, secure } = SyncClient.normalizeServerAddress(address);
    const proto = secure ? "https://" : "http://";
    return `${proto}${host}${path}`;
  }

  static loginUrl(address: string, username: string): string {
    return `${SyncClient.resolveUrl(address)}/${encodeURIComponent(username)}`;
  }

  connect(url: string, username: string, password: string): Promise<void> {
    const sameConnection =
      this.url === url && this.username === username && this.password === password;

    if (
      sameConnection &&
      this.isConnected() &&
      this.authenticated
    ) {
      return Promise.resolve();
    }

    if (this.connectPromise && sameConnection) {
      return this.connectPromise;
    }

    this.disconnect(this.connectPromise ? "同步连接已切换" : "同步连接已关闭");
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
        this.rejectPendingConnection(error);
        this.notify(error.message);
        this.failPending(error);
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

  disconnect(reason = "同步连接已关闭") {
    const error = new Error(reason);
    this.rejectPendingConnection(error);
    this.closeWebSocket();
    this.authenticated = false;
    this.failPending(error);
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
        if (!this.authenticated || this.connectReject) {
          this.failConnection(new Error(message.message));
          return;
        }
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
    this.rejectPendingConnection(error);
    this.authenticated = false;
    this.closeWebSocket();
    this.failPending(error);
    this.notify(error.message);
  }

  private rejectPendingConnection(error: Error) {
    this.clearConnectTimer();
    this.connectReject?.(error);
    this.connectReject = null;
    this.connectResolve = null;
    this.connectPromise = null;
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
