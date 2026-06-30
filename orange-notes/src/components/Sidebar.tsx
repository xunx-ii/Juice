import { Plus, FolderPlus, Settings, RefreshCw } from "lucide-react";
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

function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const darkMode = useNoteStore((s) => s.darkMode);
  const toggleDarkMode = useNoteStore((s) => s.toggleDarkMode);
  const [diarySync, setDiarySync] = useState(true);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
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
          {/* Diary Sync */}
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm font-medium">日记同步</span>
              <p className="text-xs text-muted-foreground">
                自动同步日记到本地
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`inline-block w-2 h-2 rounded-full ${
                  diarySync ? "bg-green-500" : "bg-red-500"
                }`}
              />
              <span className="text-xs text-muted-foreground">
                {diarySync ? "已同步" : "未同步"}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setDiarySync(!diarySync)}
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <Separator />
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
          <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
          <span className="text-[11px] text-muted-foreground">日记已同步</span>
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
