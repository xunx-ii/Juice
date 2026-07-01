import { useState } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useNoteStore } from "@/store/useNoteStore";
import { cn } from "@/lib/utils";

export function SearchBar() {
  const { searchQuery, setSearchQuery } = useNoteStore();
  const [localQuery, setLocalQuery] = useState(searchQuery);
  const [focused, setFocused] = useState(false);

  const handleChange = (value: string) => {
    setLocalQuery(value);
    setSearchQuery(value);
  };

  return (
    <div
      className={cn(
        "relative rounded-lg transition-all duration-200",
        focused && "ring-2 ring-ring/30 shadow-sm"
      )}
    >
      <Search
        className={cn(
          "absolute left-2.5 top-2.5 h-4 w-4 transition-colors duration-200",
          focused ? "text-primary/60" : "text-muted-foreground/50"
        )}
      />
      <Input
        placeholder="搜索笔记..."
        value={localQuery}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className="pl-8 pr-8 h-9 text-sm bg-muted/40 border-0 focus-visible:ring-0 focus-visible:bg-muted/60"
      />
      {localQuery && (
        <button
          onClick={() => handleChange("")}
          className="absolute right-2 top-2 text-muted-foreground/50 hover:text-foreground rounded p-0.5 hover:bg-foreground/10 transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
