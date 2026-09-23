import { useEffect, useRef } from "react";
import { useI18n } from "./i18n/context";
import { CloseIcon } from "./icons";

export type FormatFilterType = "all" | "image" | "psd" | "png" | "ai" | "doc" | "video";

export type SortByType = "newest" | "oldest" | "name_asc" | "name_desc" | "size_desc" | "size_asc";

export interface SearchFilterBarProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  formatFilter: FormatFilterType;
  onFormatFilterChange: (f: FormatFilterType) => void;
  sortBy: SortByType;
  onSortChange: (s: SortByType) => void;
}

export function SearchFilterBar({
  searchQuery,
  onSearchChange,
  formatFilter,
  onFormatFilterChange,
  sortBy,
  onSortChange,
}: SearchFilterBarProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const formatPills: { type: FormatFilterType; label: string }[] = [
    { type: "all", label: t("inbox.filterAll") },
    { type: "image", label: t("inbox.filterImages") },
    { type: "psd", label: t("inbox.filterPsd") },
    { type: "png", label: t("inbox.filterPng") },
    { type: "ai", label: t("inbox.filterAi") },
    { type: "doc", label: t("inbox.filterDocs") },
    { type: "video", label: t("inbox.filterVideos") },
  ];

  return (
    <div className="search-filter-container">
      <div className="search-bar-row">
        <div className="search-input-wrap">
          <span className="search-icon" aria-hidden="true">
            🔍
          </span>
          <input
            ref={inputRef}
            type="text"
            className="search-input"
            placeholder={t("inbox.searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                onSearchChange("");
                inputRef.current?.blur();
              }
            }}
          />
          {searchQuery ? (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => {
                onSearchChange("");
                inputRef.current?.focus();
              }}
              aria-label="清除搜索"
            >
              <CloseIcon width={12} height={12} />
            </button>
          ) : (
            <span className="search-shortcut-badge">Ctrl + K</span>
          )}
        </div>
      </div>

      <div className="filter-sort-row">
        <div className="format-pills">
          {formatPills.map((pill) => (
            <button
              key={pill.type}
              type="button"
              className={`format-pill-btn ${formatFilter === pill.type ? "active" : ""}`}
              onClick={() => onFormatFilterChange(pill.type)}
            >
              {pill.label}
            </button>
          ))}
        </div>

        <div className="sort-select-wrap">
          <span className="sort-icon" aria-hidden="true">
            ⇅
          </span>
          <select
            className="sort-select"
            value={sortBy}
            onChange={(e) => onSortChange(e.target.value as SortByType)}
            aria-label="排序方式"
          >
            <option value="newest">{t("inbox.sortNewest")}</option>
            <option value="oldest">{t("inbox.sortOldest")}</option>
            <option value="name_asc">{t("inbox.sortNameAsc")}</option>
            <option value="name_desc">{t("inbox.sortNameDesc")}</option>
            <option value="size_desc">{t("inbox.sortSizeDesc")}</option>
            <option value="size_asc">{t("inbox.sortSizeAsc")}</option>
          </select>
        </div>
      </div>
    </div>
  );
}
