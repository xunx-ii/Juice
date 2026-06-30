// WebSocket sync client. Handles connect, authenticate, push, and fetching
// remote state from the orange-notes-server.

import type {
  ClientMessage,
  RemoteNotebookState,
  ServerMessage,
} from "./protocol";

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
  private listeners: Set<Listener> = new Set();
  private stateHandlers: Set<StateHandler> = new Set();
  private reconnectHandler: ReturnType<typeof setTimeout> | null = null;

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

  connect(url: string, username: string, password: string) {
    // If we're already connected to the same url+user, keep the socket.
    if (
      this.url === url &&
      this.username === username &&
      this.ws &&
      this.ws.readyState === WebSocket.OPEN
    ) {
      if (this.authenticated) return;
      // Socket open but not yet authenticated — re-send auth in case the
      // previous attempt was dropped.
      this.sendMessage({
        type: "authenticate",
        username: this.username!,
        password: this.password!,
      });
      return;
    }

    this.url = url;
    this.username = username;
    this.password = password;
    this.authenticated = false;
    this.pendingPush = null;
    this.pendingResolve = null;
    this.clearReconnect();
    this.doConnect();

    // Schedule a second attempt in case the server spins up slowly.
    this.reconnectHandler = setTimeout(() => {
      if (!this.authenticated) this.doConnect();
    }, 4000);
  }

  private doConnect() {
    this.closeWebSocket();

    try {
      this.ws = new WebSocket(this.url!);
    } catch (e) {
      this.notifyAll(false, String(e));
      return;
    }

    this.ws.onopen = () => {
      this.notifyAll(true);
      // DeferAuthenticate until we receive a Welcome message.
    };

    this.ws.onclose = () => {
      this.authenticated = false;
      this.notifyAll(false);
    };

    this.ws.onerror = () => {
      this.notifyAll(false, "WebSocket error");
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data) as ServerMessage;
      this.handleMessage(data);
    };
  }

  private handleMessage(msg: ServerMessage) {
    switch (msg.type) {
      case "welcome": {
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
        break;
      }
      case "authentication_failed": {
        this.authenticated = false;
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
        }
        this.stateHandlers.forEach((h) => h(msg.state));
        break;
      }
      case "error": {
        this.notifyAll(false, msg.message);
        break;
      }
      case "server_done": break;
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
      if (!this.ws) {
        reject(new Error("WebSocket not connected"));
        return;
      }
      this.pendingResolve = resolve;
      if (this.authenticated) {
        this.sendMessage({ type: "push", state });
      } else {
        this.pendingPush = state;
      }
      setTimeout(() => {
        if (this.pendingResolve === resolve) {
          this.pendingResolve = null;
          reject(new Error("Sync timeout"));
        }
      }, timeoutMs);
    });
  }

  // Request the current remote state; resolves when it arrives.
  requestState(timeoutMs = 10000): Promise<RemoteNotebookState> {
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error("WebSocket not connected"));
        return;
      }
      this.pendingResolve = resolve;
      this.sendMessage({ type: "request_state" });
      setTimeout(() => {
        if (this.pendingResolve === resolve) {
          this.pendingResolve = null;
          reject(new Error("State request timeout"));
        }
      }, timeoutMs);
    });
  }

  disconnect() {
    this.clearReconnect();
    this.closeWebSocket();
    this.authenticated = false;
    this.pendingPush = null;
    this.pendingResolve = null;
  }

  private closeWebSocket() {
    if (this.ws) {
      this.ws.onclose = null;
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  private notifyAll(connected: boolean, error?: string) {
    this.listeners.forEach((l) => l(connected, error));
  }
}

export const syncClient = new SyncClient();
