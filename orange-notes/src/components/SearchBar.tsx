import { useState } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useNoteStore } from "@/store/useNoteStore";

export function SearchBar() {
  const { searchQuery, setSearchQuery } = useNoteStore();
  const [localQuery, setLocalQuery] = useState(searchQuery);

  const handleChange = (value: string) => {
    setLocalQuery(value);
    setSearchQuery(value);
  };

  return (
    <div className="relative">
      <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
      <Input
        placeholder="搜索笔记..."
        value={localQuery}
        onChange={(e) => handleChange(e.target.value)}
        className="pl-8 pr-8 h-9 text-sm bg-muted/50 border-0 focus-visible:ring-1"
      />
      {localQuery && (
        <button
          onClick={() => handleChange("")}
          className="absolute right-2 top-2.5 text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
