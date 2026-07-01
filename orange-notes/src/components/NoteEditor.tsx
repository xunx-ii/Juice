import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Eye,
  Edit3,
  Pin,
  Trash2,
  MoreHorizontal,
  Folders,
  Clock,
  Star,
  CalendarDays,
  PanelLeft,
  PanelRight,
  Moon,
  Sun,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useNoteStore } from "@/store/useNoteStore";
import { useDebounce } from "@/hooks/useDebounce";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  NOTE_IMAGE_AVAILABLE_EVENT,
  NOTE_IMAGE_DELETED_EVENT,
  noteImageAvailableFileName,
  noteImageDeletedFileName,
} from "@/lib/noteImageEvents";
import { cn } from "@/lib/utils";

const IMAGE_TOKEN_RE = /!\[\[([^\]\r\n]+)\]\]/g;
const EMPTY_EDITOR_MIN_HEIGHT = 96;
const TEXT_SEGMENT_MIN_HEIGHT = 28;

type Segment =
  | { type: "text"; value: string }
  | { type: "image"; fileName: string };

interface StoredImage {
  fileName: string;
}

interface ImagePayload {
  mime: string;
  bytes: number[];
}

const imageUrlCache = new Map<string, string>();

function revokeCachedImage(fileName: string) {
  const url = imageUrlCache.get(fileName);
  if (url) {
    URL.revokeObjectURL(url);
    imageUrlCache.delete(fileName);
  }
}

function normalizeFileName(value: string): string | null {
  const fileName = value.trim();
  if (!fileName || fileName.includes("/") || fileName.includes("\\")) return null;
  return fileName;
}

function imageToken(fileName: string) {
  return `![[${fileName}]]`;
}

function splitSegments(content: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  IMAGE_TOKEN_RE.lastIndex = 0;

  while ((match = IMAGE_TOKEN_RE.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", value: content.slice(lastIndex, match.index) });
    }

    const fileName = normalizeFileName(match[1]);
    segments.push(fileName ? { type: "image", fileName } : { type: "text", value: match[0] });
    lastIndex = IMAGE_TOKEN_RE.lastIndex;
  }

  if (lastIndex < content.length) {
    segments.push({ type: "text", value: content.slice(lastIndex) });
  }
  return segments;
}

function segmentsToMarkdown(segments: Segment[]) {
  return segments
    .map((segment) => (segment.type === "text" ? segment.value : imageToken(segment.fileName)))
    .join("");
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function NoteImage({
  fileName,
  className,
}: {
  fileName: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState(() => imageUrlCache.get(fileName) ?? "");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setSrc(imageUrlCache.get(fileName) ?? "");
    setFailed(false);
  }, [fileName]);

  useEffect(() => {
    const handleImageAvailable = (event: Event) => {
      if (noteImageAvailableFileName(event) !== fileName) return;
      setFailed(false);
      setSrc(imageUrlCache.get(fileName) ?? "");
    };

    window.addEventListener(NOTE_IMAGE_AVAILABLE_EVENT, handleImageAvailable);
    return () => {
      window.removeEventListener(NOTE_IMAGE_AVAILABLE_EVENT, handleImageAvailable);
    };
  }, [fileName]);

  useEffect(() => {
    const handleImageDeleted = (event: Event) => {
      if (noteImageDeletedFileName(event) !== fileName) return;
      revokeCachedImage(fileName);
      setSrc("");
      setFailed(true);
    };

    window.addEventListener(NOTE_IMAGE_DELETED_EVENT, handleImageDeleted);
    return () => {
      window.removeEventListener(NOTE_IMAGE_DELETED_EVENT, handleImageDeleted);
    };
  }, [fileName]);

  useEffect(() => {
    const node = ref.current;
    if (!node || src || failed) return;

    let canceled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();

        void invoke<ImagePayload>("load_note_image", { fileName })
          .then((payload) => {
            if (canceled) return;
            const url = URL.createObjectURL(
              new Blob([new Uint8Array(payload.bytes)], { type: payload.mime })
            );
            imageUrlCache.set(fileName, url);
            setSrc(url);
          })
          .catch((error) => {
            console.error("Failed to load note image", error);
            if (!canceled) setFailed(true);
          });
      },
      { rootMargin: "700px 0px" }
    );

    observer.observe(node);
    return () => {
      canceled = true;
      observer.disconnect();
    };
  }, [failed, fileName, src]);

  return (
    <div
      ref={ref}
      className={cn(
        "not-prose my-1 inline-flex min-h-14 min-w-20 max-w-full items-center justify-center overflow-hidden rounded-lg border border-border/50 bg-muted/20 align-top",
        "shadow-sm transition-shadow duration-200 hover:shadow-md"
      )}
    >
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          className={
            className
              ? `m-0 block ${className}`
              : "m-0 block max-h-[560px] max-w-full object-contain"
          }
        />
      ) : (
        <div className="flex flex-col items-center gap-1 px-4 py-3 text-muted-foreground/50">
          <div className="h-6 w-6 animate-pulse rounded bg-muted-foreground/20" />
          <span className="text-[10px] tracking-wide">加载中…</span>
        </div>
      )}
    </div>
  );
}

function UnifiedTopBar({
  sidebarOpen,
  toggleSidebar,
  darkMode,
  toggleDarkMode,
  noteInfo,
  actions,
}: {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  darkMode: boolean;
  toggleDarkMode: () => void;
  noteInfo?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-3 h-10 border-b border-border/50 shrink-0 bg-muted/20 backdrop-blur-sm">
      {/* Left: app controls */}
      <div className="flex items-center gap-0.5">
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-md"
              onClick={toggleSidebar}
            >
              {sidebarOpen ? (
                <PanelLeft className="h-3.5 w-3.5" />
              ) : (
                <PanelRight className="h-3.5 w-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {sidebarOpen ? "收起侧边栏" : "展开侧边栏"}
          </TooltipContent>
        </Tooltip>
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-md"
              onClick={toggleDarkMode}
            >
              {darkMode ? (
                <Sun className="h-3.5 w-3.5 text-amber-500" strokeWidth={2.2} />
              ) : (
                <Moon className="h-3.5 w-3.5" strokeWidth={2.2} />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {darkMode ? "浅色模式" : "深色模式"}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Center: note info (only when a note is active) */}
      {noteInfo && (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70 truncate max-w-[60%]">
          {noteInfo}
        </div>
      )}

      {/* Right: note actions (only when a note is active) */}
      {actions && (
        <div className="flex items-center gap-0.5">{actions}</div>
      )}
    </div>
  );
}

function NoteStats({ content }: { content: string }) {
  const stats = useMemo(() => {
    const text = content.replace(/!\[\[[^\]\r\n]+\]\]/g, "");
    const charCount = text.length;
    // Approximate: CJK chars + space-separated Latin words
    const cjkCount = (text.match(/[一-鿿぀-ヿ가-��]/g) ?? []).length;
    const wordCount = cjkCount + (text.replace(/[一-鿿぀-ヿ가-��]/g, "").match(/\S+/g) ?? []).length;
    const readingMinutes = Math.max(1, Math.round(wordCount / 350));
    return { charCount, wordCount, readingMinutes };
  }, [content]);

  return (
    <div className="flex items-center gap-4 text-[11px] text-muted-foreground/50">
      <span>{stats.charCount} 字符</span>
      <span className="text-muted-foreground/20">|</span>
      <span>{stats.wordCount} 字</span>
      <span className="text-muted-foreground/20">|</span>
      <span>约 {stats.readingMinutes} 分钟阅读</span>
    </div>
  );
}

function TextSegmentEditor({
  value,
  onChange,
  expanded,
}: {
  value: string;
  onChange: (value: string) => void;
  expanded: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    const minHeight = expanded ? EMPTY_EDITOR_MIN_HEIGHT : TEXT_SEGMENT_MIN_HEIGHT;
    textarea.style.height = `${Math.max(textarea.scrollHeight, minHeight)}px`;
  }, [expanded, value]);

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder="开始写作..."
      className="editor-focus-mode block w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-[15px] leading-[1.8] tracking-wide text-foreground outline-none placeholder:text-muted-foreground/40 focus-visible:ring-0 selection:bg-primary/15"
      spellCheck
    />
  );
}

function LiveEditor({
  content,
  onChange,
  onImageRemove,
  onPasteCapture,
}: {
  content: string;
  onChange: (v: string) => void;
  onImageRemove: (v: string) => void;
  onPasteCapture: (e: React.ClipboardEvent) => void;
}) {
  const segments = useMemo<Segment[]>(
    () => {
      const parsed = splitSegments(content);
      return parsed.length > 0 ? parsed : [{ type: "text", value: "" }];
    },
    [content]
  );

  const updateTextSegment = useCallback(
    (segmentIndex: number, newText: string) => {
      const next = segments.map((segment, index) =>
        index === segmentIndex && segment.type === "text"
          ? { ...segment, value: newText }
          : segment
      );
      onChange(segmentsToMarkdown(next));
    },
    [onChange, segments]
  );

  const removeImage = useCallback(
    (segmentIndex: number) => {
      const segment = segments[segmentIndex];
      if (segment?.type === "image") {
        revokeCachedImage(segment.fileName);
      }
      const next = segmentsToMarkdown(segments.filter((_, index) => index !== segmentIndex));
      onImageRemove(next);
    },
    [onImageRemove, segments]
  );

  return (
    <div
      className="w-full min-h-full text-[15px] leading-[1.8] whitespace-pre-wrap break-words tracking-wide outline-none"
      onPasteCapture={onPasteCapture}
    >
      {segments.map((segment, index) =>
        segment.type === "image" ? (
            <span
              key={`${segment.fileName}-${index}`}
              className="inline-flex items-start gap-1 my-1 mx-0.5 group relative"
            >
              <NoteImage
                fileName={segment.fileName}
                className="max-h-[240px] max-w-[min(460px,80vw)] object-contain"
              />
              <button
                onClick={() => removeImage(index)}
                className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-destructive text-destructive-foreground text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm hover:scale-110"
                title="删除图片"
              >
                x
              </button>
            </span>
          ) : (
            <TextSegmentEditor
              key={`text-${index}`}
              value={segment.value}
              expanded={segments.length === 1}
              onChange={(value) => updateTextSegment(index, value)}
            />
          )
      )}
    </div>
  );
}

function PreviewContent({ content }: { content: string }) {
  const segments = useMemo(() => splitSegments(content), [content]);
  if (segments.length === 0) {
    return <Markdown remarkPlugins={[remarkGfm]}>*空白笔记*</Markdown>;
  }

  return (
    <>
      {segments.map((segment, index) =>
        segment.type === "image" ? (
          <NoteImage key={`${segment.fileName}-${index}`} fileName={segment.fileName} />
        ) : (
          <Markdown key={`text-${index}`} remarkPlugins={[remarkGfm]}>
            {segment.value}
          </Markdown>
        )
      )}
    </>
  );
}

export function NoteEditor() {
  const activeNoteId = useNoteStore((s) => s.activeNoteId);
  const notes = useNoteStore((s) => s.notes);
  const folders = useNoteStore((s) => s.folders);
  const updateNote = useNoteStore((s) => s.updateNote);
  const deleteNote = useNoteStore((s) => s.deleteNote);
  const sidebarOpen = useNoteStore((s) => s.sidebarOpen);
  const toggleSidebar = useNoteStore((s) => s.toggleSidebar);
  const darkMode = useNoteStore((s) => s.darkMode);
  const toggleDarkMode = useNoteStore((s) => s.toggleDarkMode);

  const activeNote = notes.find((n) => n.id === activeNoteId);
  const activeFolder = folders.find((f) => f.id === activeNote?.folder);
  const activeContent = activeNote?.content;
  const activeTitle = activeNote?.title;

  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editTitle, setEditTitle] = useState(false);
  const syncedNoteIdRef = useRef<string | null>(null);
  const contentDirtyRef = useRef(false);
  const titleDirtyRef = useRef(false);
  const contentRef = useRef("");
  const skipNextContentSaveRef = useRef(false);
  const skipNextTitleSaveRef = useRef(false);
  const pasteLockRef = useRef(false);
  const deleteInFlightRef = useRef(false);
  const debouncedContent = useDebounce(content, 500);
  const debouncedTitle = useDebounce(title, 500);

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  useEffect(() => {
    if (
      activeNoteId &&
      activeContent !== undefined &&
      activeTitle !== undefined &&
      syncedNoteIdRef.current !== activeNoteId
    ) {
      skipNextContentSaveRef.current = true;
      skipNextTitleSaveRef.current = true;
      contentDirtyRef.current = false;
      titleDirtyRef.current = false;
      setContent(activeContent);
      setTitle(activeTitle);
      setEditTitle(false);
      syncedNoteIdRef.current = activeNoteId;
    }
  }, [activeContent, activeNoteId, activeTitle]);

  useEffect(() => {
    if (
      activeNoteId &&
      activeContent !== undefined &&
      syncedNoteIdRef.current === activeNoteId &&
      content !== activeContent
    ) {
      if (contentDirtyRef.current) return;
      skipNextContentSaveRef.current = true;
      setContent(activeContent);
      return;
    }
    if (
      activeNoteId &&
      activeContent !== undefined &&
      syncedNoteIdRef.current === activeNoteId &&
      content === activeContent
    ) {
      contentDirtyRef.current = false;
    }
  }, [activeContent, activeNoteId, content]);

  useEffect(() => {
    if (
      activeNoteId &&
      activeTitle !== undefined &&
      syncedNoteIdRef.current === activeNoteId &&
      title.trim() !== activeTitle
    ) {
      if (titleDirtyRef.current) return;
      skipNextTitleSaveRef.current = true;
      setTitle(activeTitle);
      return;
    }
    if (
      activeNoteId &&
      activeTitle !== undefined &&
      syncedNoteIdRef.current === activeNoteId &&
      title.trim() === activeTitle
    ) {
      titleDirtyRef.current = false;
    }
  }, [activeNoteId, activeTitle, title]);

  useEffect(() => {
    if (skipNextContentSaveRef.current) {
      skipNextContentSaveRef.current = false;
      return;
    }
    if (activeNoteId && activeContent !== undefined && debouncedContent !== activeContent) {
      void updateNote(activeNoteId, { content: debouncedContent });
    }
  }, [activeContent, activeNoteId, debouncedContent, updateNote]);

  useEffect(() => {
    if (skipNextTitleSaveRef.current) {
      skipNextTitleSaveRef.current = false;
      return;
    }
    const normalizedTitle = debouncedTitle.trim();
    if (activeNoteId && activeTitle !== undefined && normalizedTitle && normalizedTitle !== activeTitle) {
      void updateNote(activeNoteId, { title: normalizedTitle });
    }
  }, [activeNoteId, activeTitle, debouncedTitle, updateNote]);

  const openDeleteDialog = useCallback(() => {
    if (!activeNote || deleteInFlightRef.current) return;
    setDeleteTarget({ id: activeNote.id, title: activeNote.title || "未命名笔记" });
    setShowDeleteDialog(true);
  }, [activeNote]);

  const handleDelete = useCallback(async () => {
    if (deleteInFlightRef.current || !deleteTarget) return;
    deleteInFlightRef.current = true;
    setDeleting(true);
    try {
      await deleteNote(deleteTarget.id);
      setShowDeleteDialog(false);
      setDeleteTarget(null);
    } finally {
      deleteInFlightRef.current = false;
      setDeleting(false);
    }
  }, [deleteNote, deleteTarget]);

  const handleImageRemove = useCallback(
    (nextContent: string) => {
      contentDirtyRef.current = true;
      setContent(nextContent);
      if (activeNoteId) {
        skipNextContentSaveRef.current = true;
        void updateNote(activeNoteId, { content: nextContent });
      }
    },
    [activeNoteId, updateNote]
  );

  const handlePasteCapture = useCallback(async (event: React.ClipboardEvent) => {
    const imageItem = Array.from(event.clipboardData.items).find((item) =>
      item.type.startsWith("image/")
    );
    if (!imageItem || pasteLockRef.current) return;

    const file = imageItem.getAsFile();
    if (!file) return;
    const targetNoteId = activeNoteId;
    if (!targetNoteId) return;

    pasteLockRef.current = true;
    event.preventDefault();
    event.stopPropagation();

    try {
      const base64Data = await fileToBase64(file);
      const saved = await invoke<StoredImage>("save_clipboard_image", {
        mime: file.type,
        base64Data,
      });
      imageUrlCache.set(saved.fileName, URL.createObjectURL(file));
      contentDirtyRef.current = true;
      const currentContent = contentRef.current;
      const prefix = currentContent.length === 0 || currentContent.endsWith("\n") ? "" : "\n";
      const nextContent = `${currentContent}${prefix}${imageToken(saved.fileName)}\n`;
      setContent(nextContent);
      skipNextContentSaveRef.current = true;
      void updateNote(targetNoteId, { content: nextContent });
    } finally {
      window.setTimeout(() => {
        pasteLockRef.current = false;
      }, 0);
    }
  }, [activeNoteId, updateNote]);

  if (!activeNote) {
    return (
      <div className="flex flex-col h-full bg-background">
        <UnifiedTopBar
          sidebarOpen={sidebarOpen}
          toggleSidebar={toggleSidebar}
          darkMode={darkMode}
          toggleDarkMode={toggleDarkMode}
        />
        <div className="flex flex-col items-center justify-center flex-1 text-muted-foreground bg-gradient-to-b from-transparent to-muted/10">
          <div className="text-center max-w-sm fade-in">
            <div className="mb-5 inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-primary/10 to-primary/5 shadow-inner">
              <Edit3 className="h-7 w-7 text-primary/50" strokeWidth={1.5} />
            </div>
            <h2 className="text-lg font-semibold text-foreground/70 mb-2">
              选择一个笔记开始写作
            </h2>
            <p className="text-sm text-muted-foreground/60 leading-relaxed">
              从左侧列表中选择一个笔记，
              <br />
              或点击「新建笔记」开始创作。
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Unified top bar: sidebar + dark mode (left), note info + actions (right) */}
      <UnifiedTopBar
        sidebarOpen={sidebarOpen}
        toggleSidebar={toggleSidebar}
        darkMode={darkMode}
        toggleDarkMode={toggleDarkMode}
        noteInfo={
          <>
            <span className="inline-flex items-center gap-1.5">
              <Folders className="h-3.5 w-3.5" />
              <span className="font-medium">{activeFolder?.name || "未分类"}</span>
            </span>
            <span className="text-muted-foreground/25">|</span>
            <span className="inline-flex items-center gap-1.5">
              <CalendarDays className="h-3.5 w-3.5" />
              {new Date(activeNote.updatedAt).toLocaleDateString("zh-CN", {
                month: "short",
                day: "numeric",
              })}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              {new Date(activeNote.updatedAt).toLocaleTimeString("zh-CN", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </>
        }
        actions={
          <>
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "h-7 w-7 rounded-md",
                    activeNote.pinned &&
                      "text-amber-500 bg-amber-500/10 hover:bg-amber-500/15"
                  )}
                  onClick={() =>
                    void updateNote(activeNote.id, {
                      pinned: !activeNote.pinned,
                    })
                  }
                >
                  <Pin
                    className={cn(
                      "h-3.5 w-3.5",
                      activeNote.pinned && "fill-current"
                    )}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                {activeNote.pinned ? "取消置顶" : "置顶"}
              </TooltipContent>
            </Tooltip>
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "h-7 w-7 rounded-md",
                    activeNote.favorite &&
                      "text-rose-500 bg-rose-500/10 hover:bg-rose-500/15"
                  )}
                  onClick={() =>
                    void updateNote(activeNote.id, {
                      favorite: !activeNote.favorite,
                    })
                  }
                >
                  <Star
                    className={cn(
                      "h-3.5 w-3.5",
                      activeNote.favorite && "fill-current"
                    )}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                {activeNote.favorite ? "取消收藏" : "收藏"}
              </TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 rounded-md"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive focus:bg-destructive/10"
                  onClick={openDeleteDialog}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  删除笔记
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <Tabs defaultValue="preview" className="flex-1 flex flex-col min-h-0">
        <div className="px-6 pt-2 pb-0 border-b border-border/40">
          <TabsList className="h-9 bg-transparent p-0 gap-1">
            <TabsTrigger
              value="edit"
              className="h-8 rounded-t-lg rounded-b-none border border-b-0 border-transparent data-[state=active]:border-border/60 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm px-4 text-xs gap-1.5 text-muted-foreground"
            >
              <Edit3 className="h-3.5 w-3.5" />
              编辑
            </TabsTrigger>
            <TabsTrigger
              value="preview"
              className="h-8 rounded-t-lg rounded-b-none border border-b-0 border-transparent data-[state=active]:border-border/60 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm px-4 text-xs gap-1.5 text-muted-foreground"
            >
              <Eye className="h-3.5 w-3.5" />
              预览
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="edit" className="flex-1 p-0 m-0 min-h-0 fade-in">
          <div className="h-full flex flex-col">
            <div className="px-8 pt-6 pb-0">
              {editTitle ? (
                <Input
                  value={title}
                  onChange={(e) => {
                    titleDirtyRef.current = true;
                    setTitle(e.target.value);
                  }}
                  onBlur={() => setEditTitle(false)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setEditTitle(false);
                  }}
                  className="text-[1.7rem] font-bold tracking-tight border-0 p-0 h-11 leading-tight focus-visible:ring-0 bg-transparent"
                  autoFocus
                />
              ) : (
                <h2
                  className="text-[1.7rem] font-bold tracking-tight leading-tight cursor-text hover:bg-muted/40 -ml-2 px-2 py-1 rounded-lg transition-colors text-foreground"
                  onClick={() => setEditTitle(true)}
                >
                  {activeNote.title || "未命名笔记"}
                </h2>
              )}
            </div>
            <div className="flex-1 overflow-auto px-8 pb-3 pt-3">
              <div className="max-w-[72ch] mx-auto">
                <LiveEditor
                  content={content}
                  onChange={(nextContent) => {
                    contentDirtyRef.current = true;
                    setContent(nextContent);
                  }}
                  onImageRemove={handleImageRemove}
                  onPasteCapture={handlePasteCapture}
                />
              </div>
            </div>
            <div className="px-8 py-1.5 border-t border-border/30">
              <NoteStats content={content} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="preview" className="flex-1 p-0 m-0 min-h-0 overflow-auto fade-in">
          <div className="px-8 pt-6 pb-4 w-full">
            <div className="max-w-[72ch] mx-auto">
              <h1 className="text-[1.7rem] font-bold tracking-tight leading-tight text-foreground pb-2">
                {activeNote.title || "未命名笔记"}
              </h1>
              <div className="note-prose">
                <PreviewContent content={content} />
              </div>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog
        open={showDeleteDialog}
        onOpenChange={(open) => {
          if (deleting) return;
          setShowDeleteDialog(open);
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>删除笔记</DialogTitle>
            <DialogDescription>
              确定要删除「{deleteTarget?.title || "未命名笔记"}」吗？此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={deleting}
              onClick={() => {
                setShowDeleteDialog(false);
                setDeleteTarget(null);
              }}
            >
              取消
            </Button>
            <Button variant="destructive" disabled={deleting} onClick={handleDelete}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
