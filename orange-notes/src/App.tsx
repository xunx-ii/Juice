import { useEffect } from "react";
import {
  PanelLeft,
  PanelRight,
  Moon,
  Sun,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/components/Sidebar";
import { NoteEditor } from "@/components/NoteEditor";
import { ToastViewport } from "@/components/ToastViewport";
import { useNoteStore } from "@/store/useNoteStore";
import { useSyncStore } from "@/sync/useSyncStore";
import { cn } from "@/lib/utils";

function App() {
  const sidebarOpen = useNoteStore((s) => s.sidebarOpen);
  const toggleSidebar = useNoteStore((s) => s.toggleSidebar);
  const darkMode = useNoteStore((s) => s.darkMode);
  const toggleDarkMode = useNoteStore((s) => s.toggleDarkMode);
  const initialize = useNoteStore((s) => s.initialize);
  const loading = useNoteStore((s) => s.loading);
  const error = useNoteStore((s) => s.error);
  const connectRealtime = useSyncStore((s) => s.connectRealtime);

  useEffect(() => {
    void initialize().then(() => {
      const { settings } = useSyncStore.getState();
      if (settings.address && settings.username && settings.password) {
        void connectRealtime(true).catch(() => {});
      }
    });
  }, [connectRealtime, initialize]);

  // Apply dark mode class
  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }, [darkMode]);

  return (
    <TooltipProvider>
      <div className="h-screen w-screen flex overflow-hidden bg-background text-foreground relative">
        {/* Sidebar */}
        <div
          className={cn(
            "flex-shrink-0 transition-all duration-300 ease-[cubic-bezier(0.25,0.1,0.25,1)] overflow-hidden",
            sidebarOpen ? "w-[280px]" : "w-0"
          )}
        >
          <div className="w-[280px] h-full">
            <Sidebar />
          </div>
        </div>

        {/* Main Content */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Editor */}
          <main className="flex-1 min-h-0">
            {loading ? (
              <div className="h-full flex flex-col items-center justify-center gap-3 text-muted-foreground/60">
                <div className="relative">
                  <Loader2 className="h-7 w-7 animate-spin text-primary/40" />
                </div>
                <span className="text-sm">加载中...</span>
              </div>
            ) : error ? (
              <div className="h-full flex items-center justify-center text-sm text-destructive bg-destructive/5">
                <div className="flex items-center gap-2 px-6 py-3 rounded-lg border border-destructive/20 bg-destructive/5">
                  <span className="font-medium">{error}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs ml-2"
                    onClick={() => useNoteStore.getState().initialize()}
                  >
                    重试
                  </Button>
                </div>
              </div>
            ) : (
              <NoteEditor />
            )}
          </main>
        </div>
      </div>
      <ToastViewport />
    </TooltipProvider>
  );
}

export default App;
