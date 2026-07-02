import {
  Plus,
  FolderPlus,
  Settings,
  Check,
  Loader2,
  Save,
  RefreshCw,
  Moon,
  Sun,
  Wifi,
  WifiOff,
  KeyRound,
  Copy,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { SearchBar } from "@/components/SearchBar";
import { TreeView } from "@/components/TreeView";
import { useNoteStore } from "@/store/useNoteStore";
import { Separator } from "@/components/ui/separator";
import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSyncStore } from "@/sync/useSyncStore";
import { SyncClient } from "@/sync/client";
import { showToast } from "@/store/useToastStore";

function SyncSettingsSection() {
  const {
    settings,
    lastSync,
    setSettings,
    syncing,
    pushNow,
    connectRealtime,
    authenticated,
  } = useSyncStore();
  const [address, setAddress] = useState(settings.address);
  const [username, setUsername] = useState(settings.username);
  const [password, setPassword] = useState(settings.password);
  const [testing, setTesting] = useState(false);
  const [showRegister, setShowRegister] = useState(false);
  const [regUsername, setRegUsername] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regLoading, setRegLoading] = useState(false);

  const handleRegister = async () => {
    if (!address.trim()) {
      showToast("请先填写服务器地址", "destructive");
      return;
    }
    if (!regUsername.trim() || !regPassword) {
      showToast("请填写用户名和密码", "destructive");
      return;
    }
    setRegLoading(true);
    try {
      const httpBase = SyncClient.httpBaseUrl(address);
      const r = await fetch(`${httpBase}/api/admin/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: regUsername.trim(), password: regPassword }),
      });
      const data = await r.json();
      if (data.success) {
        showToast(data.message || "注册成功", "success");
        setUsername(regUsername.trim());
        setPassword(regPassword);
        setRegUsername("");
        setRegPassword("");
      } else {
        showToast(data.message || "注册失败", "destructive");
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : "注册请求失败", "destructive");
    } finally {
      setRegLoading(false);
    }
  };

  const handleTest = async () => {
    if (!address.trim() || !username.trim() || !password) {
      showToast("请填写所有字段", "destructive");
      return;
    }
    setSettings({ address, username, password });
    setTesting(true);
    try {
      await connectRealtime(false); // toast on failure shown by connectRealtime
      showToast("实时同步已连接", "success");
    } catch {
      // Error already surfaced by connectRealtime
    } finally {
      setTesting(false);
    }
  };

  const handleSave = () => {
    setSettings({ address, username, password });
    showToast("设置已保存", "success", 2000);
  };

  const formatLastSync = (ts: number | null) => {
    if (!ts) return null;
    const d = new Date(ts);
    return `上次同步: ${d.toLocaleTimeString("zh-CN")}`;
  };

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium">同步服务器</div>

      <label className="block">
        <span className="text-xs text-muted-foreground mb-1 block">服务器地址</span>
        <Input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="例如 example.com:8777"
        />
      </label>

      <label className="block">
        <span className="text-xs text-muted-foreground mb-1 block">用户名</span>
        <Input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </label>

      <label className="block">
        <span className="text-xs text-muted-foreground mb-1 block">密码</span>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>

      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={testing || syncing}
          onClick={handleTest}
        >
          {testing ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Check className="mr-1 h-3 w-3" />
          )}
          {authenticated ? "已连接" : "连接"}
        </Button>
        <Button size="sm" onClick={handleSave}>
          <Save className="mr-1 h-3 w-3" />
          保存
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={syncing || testing}
          onClick={() => void pushNow()}
          title="立即同步笔记"
        >
          {syncing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
        </Button>
      </div>

      {/* Status line — only shows neutral info, never errors */}
      {lastSync && (
        <div className="text-xs text-muted-foreground">
          {formatLastSync(lastSync)}
        </div>
      )}

      {/* Registration toggle */}
      <button
        type="button"
        className="text-xs text-primary/80 hover:text-primary cursor-pointer transition-colors"
        onClick={() => setShowRegister(!showRegister)}
      >
        {showRegister ? "取消注册" : "还没有账号？立即注册"}
      </button>

      {showRegister && (
        <div className="space-y-2 pt-2 border-t border-border/50">
          <Input
            value={regUsername}
            onChange={(e) => setRegUsername(e.target.value)}
            placeholder="新用户名"
          />
          <Input
            type="password"
            value={regPassword}
            onChange={(e) => setRegPassword(e.target.value)}
            placeholder="设置密码"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={regLoading}
            onClick={handleRegister}
          >
            {regLoading ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : null}
            注册
          </Button>
        </div>
      )}
    </div>
  );
}

async function copyText(text: string, successMessage: string) {
  if (!text) return;
  try {
    await invoke("copy_text_to_clipboard", { text });
    showToast(successMessage, "success", 2000);
  } catch (error) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(successMessage, "success", 2000);
    } catch {
      showToast(error instanceof Error ? error.message : "复制失败", "destructive");
    }
  }
}

function McpSettingsSection() {
  const settings = useSyncStore((s) => s.settings);
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const mcpUrls = useMemo(() => {
    if (!settings.address || !settings.username) return null;
    try {
      const baseUrl = SyncClient.httpBaseUrl(settings.address);
      return {
        baseUrl,
        tokenUrl: `${baseUrl}/api/sync/mcp-token/${encodeURIComponent(settings.username)}`,
      };
    } catch {
      return null;
    }
  }, [settings.address, settings.username]);
  const hasCredentials = Boolean(settings.address && settings.username && settings.password);
  const hasSettings = hasCredentials && mcpUrls !== null;
  const endpoint = token && mcpUrls ? `${mcpUrls.baseUrl}/mcp?token=${token}` : "";

  useEffect(() => {
    let active = true;
    if (!hasCredentials || !mcpUrls) {
      setToken("");
      setLoading(false);
      return () => {
        active = false;
      };
    }

    setLoading(true);
    setToken("");
    void fetch(mcpUrls.tokenUrl, {
      headers: {
        "x-orange-notes-user": settings.username,
        "x-orange-notes-password": settings.password,
      },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return (await response.json()) as { token?: string | null };
      })
      .then((data) => {
        if (active) setToken(data.token ?? "");
      })
      .catch((error) => {
        if (active) setToken("");
        showToast(error instanceof Error ? error.message : "加载 MCP Token 失败", "destructive");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [hasCredentials, mcpUrls, settings.password, settings.username]);

  const handleGenerate = async () => {
    if (!hasSettings || !mcpUrls) {
      showToast("请先保存有效的同步服务器设置", "destructive");
      return;
    }
    setGenerating(true);
    try {
      const response = await fetch(mcpUrls.tokenUrl, {
        method: "POST",
        headers: {
          "x-orange-notes-user": settings.username,
          "x-orange-notes-password": settings.password,
        },
      });
      if (!response.ok) throw new Error(await response.text());
      const data = (await response.json()) as { token: string };
      setToken(data.token);
      showToast("MCP Token 已生成", "success", 2000);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "生成 MCP Token 失败", "destructive");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="text-sm font-medium">MCP 访问</div>
      <label className="block">
        <span className="text-xs text-muted-foreground mb-1 block">专属 Token</span>
        <Input
          readOnly
          value={token}
          placeholder={loading ? "读取中..." : "尚未生成"}
          className="font-mono text-xs"
        />
      </label>
      {endpoint && (
        <label className="block">
          <span className="text-xs text-muted-foreground mb-1 block">连接地址</span>
          <Input readOnly value={endpoint} className="font-mono text-xs" />
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={generating || loading}
          onClick={handleGenerate}
        >
          {generating ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <KeyRound className="mr-1 h-3 w-3" />
          )}
          {token ? "重新生成" : "生成 Token"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!token}
          onClick={() => void copyText(token, "Token 已复制")}
        >
          <Copy className="mr-1 h-3 w-3" />
          复制 Token
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!endpoint}
          onClick={() => void copyText(endpoint, "MCP 地址已复制")}
        >
          <Copy className="mr-1 h-3 w-3" />
          复制地址
        </Button>
      </div>
    </div>
  );
}

function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const darkMode = useNoteStore((s) => s.darkMode);
  const toggleDarkMode = useNoteStore((s) => s.toggleDarkMode);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {/* Theme */}
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm font-medium">深色模式</span>
              <p className="text-xs text-muted-foreground">切换应用主题</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={toggleDarkMode}
              className="min-w-[80px] gap-1.5"
            >
              {darkMode ? (
                <Moon className="h-3.5 w-3.5" />
              ) : (
                <Sun className="h-3.5 w-3.5" />
              )}
              {darkMode ? "深色" : "浅色"}
            </Button>
          </div>
          <Separator />

          {/* Sync Settings */}
          <SyncSettingsSection />
          <Separator />

          <McpSettingsSection />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Sidebar() {
  const createNote = useNoteStore((s) => s.createNote);
  const addFolder = useNoteStore((s) => s.addFolder);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const syncConnected = useSyncStore((s) => s.authenticated);
  const syncLastSync = useSyncStore((s) => s.lastSync);
  const [newFolderName, setNewFolderName] = useState("");

  const handleCreateNote = async () => {
    const fromStore = useNoteStore.getState();
    let targetFolder = fromStore.folders.find((f) => f.parentId === null);
    if (!targetFolder) {
      // No folders exist — create a default root folder first so the note
      // has somewhere to live.
      await fromStore.addFolder("笔记", null);
      const updated = useNoteStore.getState().folders;
      targetFolder = updated.find((f) => f.parentId === null) ?? updated[0];
    }
    if (targetFolder) void createNote(targetFolder.id);
  };

  const handleAddFolder = () => {
    if (newFolderName.trim()) {
      void addFolder(newFolderName.trim(), null);
      setNewFolderName("");
      setShowNewFolder(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-background/80 backdrop-blur-sm border-r border-border/60">
      {/* Header */}
      <div className="px-4 pt-4 pb-3">
        <h1 className="text-base font-bold text-foreground tracking-tight mb-3 flex items-center gap-2">
          <span className="inline-block h-5 w-1.5 rounded-full bg-gradient-to-b from-orange-400 to-amber-500" />
          桔子笔记
        </h1>
        <SearchBar />
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-1 px-3 pb-2">
        <Button
          variant="default"
          size="sm"
          className="h-8 text-xs gap-1.5 px-3 font-medium flex-1 shadow-sm"
          onClick={handleCreateNote}
        >
          <Plus className="h-3.5 w-3.5" />
          新建笔记
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => setShowNewFolder(true)}
        >
          <FolderPlus className="h-4 w-4" />
        </Button>
      </div>

      <div className="mx-4 mb-1 h-px bg-border/50" />

      {/* Tree View */}
      <TreeView />

      {/* Footer */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-border/60 shrink-0 backdrop-blur-sm bg-muted/20">
        <div className="flex items-center gap-2">
          <span className="relative flex items-center gap-1.5">
            {syncConnected ? (
              <>
                <span className="relative flex h-2 w-2 justify-center items-center">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-50" />
                  <Wifi className="h-3 w-3 text-emerald-500 relative" />
                </span>
                <span className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                  {syncLastSync
                    ? `已同步 · ${new Date(syncLastSync).toLocaleTimeString("zh-CN")}`
                    : "已连接"}
                </span>
              </>
            ) : (
              <>
                <WifiOff className="h-3 w-3 text-muted-foreground/50" />
                <span className="text-[11px] text-muted-foreground/60">
                  未连接
                </span>
              </>
            )}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 rounded-lg hover:bg-accent/60"
          onClick={() => setShowSettings(true)}
        >
          <Settings className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* New Folder Dialog */}
      <Dialog open={showNewFolder} onOpenChange={setShowNewFolder}>
        <DialogContent className="sm:max-w-[360px]">
          <DialogHeader>
            <DialogTitle>新建文件夹</DialogTitle>
          </DialogHeader>
          <Input
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddFolder();
              if (e.key === "Escape") setShowNewFolder(false);
            }}
            placeholder="文件夹名称"
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowNewFolder(false)}
            >
              取消
            </Button>
            <Button onClick={handleAddFolder}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Settings Dialog */}
      <SettingsDialog open={showSettings} onOpenChange={setShowSettings} />
    </div>
  );
}
