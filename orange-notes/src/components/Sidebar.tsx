import { Plus, FolderPlus, Settings, Check, Loader2, Save, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchBar } from "@/components/SearchBar";
import { TreeView } from "@/components/TreeView";
import { useNoteStore } from "@/store/useNoteStore";
import { Separator } from "@/components/ui/separator";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSyncStore } from "@/sync/useSyncStore";

function SyncSettingsSection() {
  const { settings, lastError, lastSync, setSettings, testing, syncing, startSync } = useSyncStore();
  const [address, setAddress] = useState(settings.address);
  const [username, setUsername] = useState(settings.username);
  const [password, setPassword] = useState(settings.password);
  const [status, setStatus] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [showRegister, setShowRegister] = useState(false);
  const [regUsername, setRegUsername] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regStatus, setRegStatus] = useState<"idle" | "loading" | "ok" | "fail">("idle");
  const [regMessage, setRegMessage] = useState<string | null>(null);

  const handleRegister = async () => {
    if (!address) {
      setRegStatus("fail");
      setRegMessage("请先填写服务器地址");
      return;
    }
    if (!regUsername.trim() || !regPassword) {
      setRegStatus("fail");
      setRegMessage("请填写用户名和密码");
      return;
    }
    setRegStatus("loading");
    setRegMessage("注册中…");
    try {
      // Derive HTTP base from WS address.
      let httpBase = address.trim();
      if (httpBase.startsWith("ws://")) httpBase = "http://" + httpBase.slice(5);
      else if (httpBase.startsWith("wss://")) httpBase = "https://" + httpBase.slice(6);
      else if (!httpBase.startsWith("http")) httpBase = "http://" + httpBase;
      httpBase = httpBase.replace(/\/$/, "");

      const r = await fetch(`${httpBase}/api/admin/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: regUsername.trim(), password: regPassword }),
      });
      const data = await r.json();
      if (data.success) {
        setRegStatus("ok");
        setRegMessage(data.message);
        // Auto-fill the credentials.
        setUsername(regUsername.trim());
        setPassword(regPassword);
        setRegUsername("");
        setRegPassword("");
      } else {
        setRegStatus("fail");
        setRegMessage(data.message);
      }
    } catch (e) {
      setRegStatus("fail");
      setRegMessage(e instanceof Error ? e.message : "注册请求失败");
    }
  };

  const handleTest = async () => {
    if (!address || !username || !password) {
      setStatus("fail");
      setStatusMessage("请填写所有字段");
      return;
    }
    setSettings({ address, username, password });
    setStatus("testing");
    setStatusMessage("正在连接并认证…");
    try {
      const { testConnection } = useSyncStore.getState();
      await testConnection();
      setStatus("ok");
      setStatusMessage("连接成功！");
    } catch (e) {
      setStatus("fail");
      setStatusMessage(e instanceof Error ? e.message : String(e));
      // Ensure store testing flag is reset even if testConnection throws
      // unexpectedly before reaching its own cleanup.
      useSyncStore.getState().setState({ testing: false });
    }
  };

  const handleSave = () => {
    setSettings({ address, username, password });
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

      {status !== "idle" && (
        <div className={`text-xs ${
          status === "fail" ? "text-destructive" : status === "ok" ? "text-emerald-500" : "text-muted-foreground"
        }`}>
          {statusMessage}
        </div>
      )}

      <div className="flex gap-2">
        <Button variant="secondary" size="sm" disabled={testing} onClick={handleTest}>
          {testing ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Check className="mr-1 h-3 w-3" />
          )}
          测试连接
        </Button>
        <Button size="sm" onClick={handleSave}>
          <Save className="mr-1 h-3 w-3" />
          保存
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={syncing || testing}
          onClick={startSync}
          title="立即同步笔记"
        >
          {syncing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
        </Button>
      </div>

      {lastError && (
        <div className="text-xs text-destructive">❌ {lastError}</div>
      )}

      {!lastError && lastSync && (
        <div className="text-xs text-muted-foreground">
          ✓ {formatLastSync(lastSync)}
        </div>
      )}

      {/* Registration toggle */}
      <button
        type="button"
        className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer"
        onClick={() => setShowRegister(!showRegister)}
      >
        {showRegister ? "取消注册" : "还没有账号？立即注册"}
      </button>

      {showRegister && (
        <div className="space-y-2 pt-2 border-t border-border/50">
          <div className="text-xs text-muted-foreground">注册新账号（将同步到服务器）</div>
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
            disabled={regStatus === "loading"}
            onClick={handleRegister}
          >
            {regStatus === "loading" ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : null}
            注册
          </Button>
          {regMessage && (
            <div className={`text-xs ${
              regStatus === "ok" ? "text-emerald-500" :
              regStatus === "fail" ? "text-destructive" : "text-muted-foreground"
            }`}>
              {regStatus === "ok" ? "✓ " : regStatus === "fail" ? "❌ " : ""}{regMessage}
            </div>
          )}
        </div>
      )}
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
          <DialogDescription>应用偏好设置和同步状态</DialogDescription>
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
              className="min-w-[80px]"
            >
              {darkMode ? "🌙 深色" : "☀️ 浅色"}
            </Button>
          </div>
          <Separator />

          {/* Sync Settings */}
          <SyncSettingsSection />

          {/* About */}
          <div className="text-xs text-muted-foreground">
            <p>桔子笔记 v1.0.0</p>
            <p>基于 React + shadcn/ui 构建</p>
          </div>
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
  const folders = useNoteStore((s) => s.folders);
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
    <div className="flex flex-col h-full bg-background border-r border-border">
      {/* Header */}
      <div className="px-3 py-3">
        <h1 className="text-sm font-semibold text-foreground tracking-tight mb-3">
          桔子笔记
        </h1>
        <SearchBar />
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-2 pb-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs gap-1 px-2"
          onClick={handleCreateNote}
        >
          <Plus className="h-3.5 w-3.5" />
          新建笔记
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs gap-1 px-2"
          onClick={() => setShowNewFolder(true)}
        >
          <FolderPlus className="h-3.5 w-3.5" />
          新建文件夹
        </Button>
      </div>

      <Separator className="mx-3 w-auto" />

      {/* Tree View */}
      <TreeView />

      {/* Footer */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-border shrink-0">
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${syncConnected ? "bg-green-500" : "bg-gray-400"}`} />
          <span className="text-[11px] text-muted-foreground">
            {syncConnected
              ? syncLastSync
                ? `已同步 · ${new Date(syncLastSync).toLocaleTimeString("zh-CN")}`
                : "已连接"
              : "未连接"}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
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
