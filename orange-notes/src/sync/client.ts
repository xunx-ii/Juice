// WebSocket sync client. Handles connect, authenticate, push, and fetching
// remote state from the orange-notes-server.

import type {
  ClientMessage,
  RemoteNotebookState,
  ServerMessage,
} from "./protocol";
import { useSyncStore } from "./useSyncStore";

type Listener = (connected: boolean, error?: string) => void;
type StateHandler = (state: RemoteNotebookState) => void;

export class SyncClient {
  private ws: WebSocket | null = null;
  private url: string | null = null;
  private username: string | null = null;
  private password: string | null = null;
  private authenticated = false;
  private pendingPush: RemoteNotebookState | null = null;
  private pendingResolve: ((state: RemoteNotebookState) => void) | null = null;
  private pendingReject: ((error: Error) => void) | null = null;
  private listeners: Set<Listener> = new Set();
  private stateHandlers: Set<StateHandler> = new Set();
  private reconnectHandler: ReturnType<typeof setTimeout> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;

  isConnected() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  isAuthenticated() {
    return this.authenticated;
  }

  addListener(listener: Listener) {
    this.listeners.add(listener);
  }

  removeListener(listener: Listener) {
    this.listeners.delete(listener);
  }

  addStateHandler(handler: StateHandler) {
    this.stateHandlers.add(handler);
  }

  removeStateHandler(handler: StateHandler) {
    this.stateHandlers.delete(handler);
  }

  clearReconnect() {
    if (this.reconnectHandler) {
      clearTimeout(this.reconnectHandler);
      this.reconnectHandler = null;
    }
  }

  // Convert a user-entered address (e.g. "example.com:8777") into a ws:// URL.
  static resolveUrl(address: string): string {
    const trimmed = address.trim();
    if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed;
    const proto = trimmed.startsWith("https://") ? "wss://" : "ws://";
    const cleaned = trimmed.replace(/^https?:\/\//, "").replace(/\/$/, "");
    return `${proto}${cleaned}/ws`;
  }

  static loginUrl(address: string, username: string): string {
    const base = SyncClient.resolveUrl(address);
    return `${base}/${encodeURIComponent(username)}`;
  }

  // Connect and authenticate. Resolves once the server has confirmed
  // authentication (or auto-registered the user). Rejects on failure.
  connect(url: string, username: string, password: string): Promise<void> {
    // If we're already authenticated with the same url+user, resolve immediately.
    if (
      this.url === url &&
      this.username === username &&
      this.ws &&
      this.ws.readyState === WebSocket.OPEN &&
      this.authenticated
    ) {
      return Promise.resolve();
    }

    // Disconnect any existing socket before reconnecting.
    this.disconnect();

    this.url = url;
    this.username = username;
    this.password = password;

    return new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.doConnect();

      // Timeout if auth never completes.
      this.reconnectHandler = setTimeout(() => {
        if (!this.authenticated && this.connectReject === reject) {
          this.connectReject = null;
          this.connectResolve = null;
          reject(new Error("连接超时：认证未完成"));
        }
      }, 15000);
    });
  }

  private doConnect() {
    this.closeWebSocket();

    try {
      this.ws = new WebSocket(this.url!);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.notifyAll(false, String(e));
      this.connectReject?.(err);
      this.connectReject = null;
      this.connectResolve = null;
      return;
    }

    this.ws.onopen = () => {
      this.notifyAll(true);
      // Defer authenticate until we receive a Welcome message.
    };

    this.ws.onclose = () => {
      const wasAuth = this.authenticated;
      this.authenticated = false;
      this.notifyAll(false);
      // Only reject if the connect promise hasn't been settled yet.
      if (!wasAuth && this.connectReject) {
        this.connectReject(new Error("连接已断开"));
        this.connectReject = null;
        this.connectResolve = null;
      }
    };

    this.ws.onerror = () => {
      // onerror usually precedes onclose; let onclose handle the reject
      // to avoid double-rejecting the connect promise.
      if (this.authenticated) {
        this.notifyAll(false, "WebSocket error");
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as ServerMessage;
        this.handleMessage(data);
      } catch {
        // ignore malformed messages
      }
    };
  }

  private handleMessage(msg: ServerMessage) {
    switch (msg.type) {
      case "welcome": {
        // Server ready — send credentials to authenticate.
        this.sendMessage({
          type: "authenticate",
          username: this.username!,
          password: this.password!,
        });
        break;
      }
      case "authenticated": {
        this.authenticated = true;
        if (this.pendingPush) {
          this.sendMessage({ type: "push", state: this.pendingPush });
          this.pendingPush = null;
        }
        // Resolve the connect() promise.
        if (this.connectResolve) {
          this.clearReconnect();
          this.connectResolve();
          this.connectResolve = null;
          this.connectReject = null;
        }
        break;
      }
      case "authentication_failed": {
        this.authenticated = false;
        const err = new Error("认证失败：用户名或密码错误");
        this.connectReject?.(err);
        this.connectReject = null;
        this.connectResolve = null;
        this.pendingReject?.(err);
        this.pendingReject = null;
        this.pendingResolve = null;
        this.notifyAll(false, "认证失败：用户名或密码错误");
        break;
      }
      case "push_ack": {
        // Server accepted our push. Request latest state to be safe.
        this.sendMessage({ type: "request_state" });
        break;
      }
      case "state": {
        if (this.pendingResolve) {
          this.pendingResolve(msg.state);
          this.pendingResolve = null;
          this.pendingReject = null;
        }
        this.stateHandlers.forEach((h) => h(msg.state));
        // After state is applied, download any images we're missing.
        if (msg.attachments && msg.attachments.length > 0) {
          void useSyncStore.getState().downloadNewImages(msg.attachments);
        }
        break;
      }
      case "error": {
        const err = new Error(msg.message);
        this.connectReject?.(err);
        this.connectReject = null;
        this.connectResolve = null;
        this.pendingReject?.(err);
        this.pendingReject = null;
        this.pendingResolve = null;
        this.notifyAll(this.authenticated, msg.message);
        break;
      }
    }
  }

  private sendMessage(msg: ClientMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.pendingPush = msg.type === "push" ? msg.state : null;
    }
  }

  // Push local notebook state to the server. Resolves with the server's
  // latest state after acknowledging the push.
  push(state: RemoteNotebookState, timeoutMs = 15000): Promise<RemoteNotebookState> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket 未连接"));
        return;
      }
      if (!this.authenticated) {
        reject(new Error("尚未完成认证"));
        return;
      }
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      this.sendMessage({ type: "push", state });
      setTimeout(() => {
        if (this.pendingResolve === resolve) {
          this.pendingResolve = null;
          this.pendingReject = null;
          reject(new Error("同步超时"));
        }
      }, timeoutMs);
    });
  }

  // Request the current remote state; resolves when it arrives.
  // Must be called only after connect() resolves.
  requestState(timeoutMs = 10000): Promise<RemoteNotebookState> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket 未连接"));
        return;
      }
      if (!this.authenticated) {
        reject(new Error("尚未完成认证"));
        return;
      }
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      this.sendMessage({ type: "request_state" });
      setTimeout(() => {
        if (this.pendingResolve === resolve) {
          this.pendingResolve = null;
          this.pendingReject = null;
          reject(new Error("获取状态超时"));
        }
      }, timeoutMs);
    });
  }

  // Convenience: connect, authenticate, then request state in one call.
  connectAndFetchState(url: string, username: string, password: string, timeoutMs = 10000): Promise<RemoteNotebookState> {
    return this.connect(url, username, password).then(() =>
      this.requestState(timeoutMs)
    );
  }

  disconnect() {
    this.clearReconnect();
    this.closeWebSocket();
    this.authenticated = false;
    this.pendingPush = null;
    this.pendingResolve = null;
    this.pendingReject = null;
    this.connectResolve = null;
    this.connectReject = null;
  }

  private closeWebSocket() {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  private notifyAll(connected: boolean, error?: string) {
    this.listeners.forEach((l) => l(connected, error));
  }
}

export const syncClient = new SyncClient();
