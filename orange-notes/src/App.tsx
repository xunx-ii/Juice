import { useEffect, useRef } from "react";
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
  const startSync = useSyncStore((s) => s.startSync);

  // Auto-sync every 30s when settings are complete.
  const startSyncRef = useRef(startSync);
  useEffect(() => {
    startSyncRef.current = startSync;
  }, [startSync]);

  useEffect(() => {
    const handler = async () => {
      const { settings: s, syncing } = useSyncStore.getState();
      if (!s.address || !s.username || !s.password || syncing) return;
      await startSyncRef.current();
    };

    const id = window.setInterval(handler, 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    void initialize();
  }, [initialize]);

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
      <div className="h-screen w-screen flex overflow-hidden bg-background text-foreground">
        {/* Sidebar */}
        <div
          className={cn(
            "flex-shrink-0 transition-all duration-200 ease-in-out overflow-hidden",
            sidebarOpen ? "w-72" : "w-0"
          )}
        >
          <Sidebar />
        </div>

        {/* Main Content */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Top Bar */}
          <header className="flex items-center justify-between px-3 h-10 border-b bg-muted/10 shrink-0">
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={toggleSidebar}
              >
                {sidebarOpen ? (
                  <PanelLeft className="h-4 w-4" />
                ) : (
                  <PanelRight className="h-4 w-4" />
                )}
              </Button>
            </div>

            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={toggleDarkMode}
              >
                {darkMode ? (
                  <Sun className="h-4 w-4" />
                ) : (
                  <Moon className="h-4 w-4" />
                )}
              </Button>
            </div>
          </header>

          {/* Editor */}
          <main className="flex-1 min-h-0">
            {loading ? (
              <div className="h-full flex items-center justify-center text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : error ? (
              <div className="h-full flex items-center justify-center text-sm text-destructive">
                {error}
              </div>
            ) : (
              <NoteEditor />
            )}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}

export default App;
