import { useEffect, useRef, useState } from "react";
import type { Tag } from "./lib/tag";

// A small styled combobox for the "add tag" input — a native <input
// list="..."> datalist looks and behaves however the OS wants (an unstyled
// system popup on Windows), so this replaces it with a plain positioned
// list this app actually controls. Shared by the Inbox gallery card and the
// Group files panel row, both of which let you add a tag to one file.
export function TagCombobox({
  value,
  onChange,
  options,
  placeholder,
  onCommit,
  onCancel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Tag[];
  placeholder: string;
  onCommit: (nameOverride?: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    const rect = inputRef.current?.getBoundingClientRect();
    if (rect)
      setMenuPos({ top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 150) });
  }, []);

  const query = value.trim().toLowerCase();
  const filtered = query ? options.filter((o) => o.name.toLowerCase().includes(query)) : options;
  const hasExactMatch = filtered.some((o) => o.name.toLowerCase() === query);

  return (
    <>
      <input
        ref={inputRef}
        className="gallery-tag-input"
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => onCommit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit();
          if (e.key === "Escape") onCancel();
        }}
      />
      {menuPos && (filtered.length > 0 || query) && (
        <div
          className="tag-combobox-menu"
          style={{ top: menuPos.top, left: menuPos.left, width: menuPos.width }}
        >
          {filtered.map((option) => (
            <button
              key={option.id}
              className="tag-combobox-option"
              // mousedown (not click) fires before the input's blur, and
              // preventDefault keeps focus on the input so blur never fires
              // at all — otherwise onBlur's commit would race this one.
              onMouseDown={(e) => {
                e.preventDefault();
                onCommit(option.name);
              }}
            >
              {option.name}
            </button>
          ))}
          {query && !hasExactMatch && (
            <div className="tag-combobox-hint">
              {placeholder} "{value.trim()}"
            </div>
          )}
        </div>
      )}
    </>
  );
}
