import { useEffect, useState, useMemo, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import {
  formatRelative,
  formatSize,
  isImageFile,
  type FileRecord,
  type TrackedFile,
} from "./lib/file";
import type { Group } from "./lib/group";
import type { Tag } from "./lib/tag";
import type { Tab } from "./lib/tab";
import { FILE_DRAG_MIME, setDragPreview } from "./lib/dnd";
import { fileNameFromPath, type Operation } from "./lib/operation";
import { checkForUpdate, type UpdateInfo } from "./lib/update";
import { useI18n } from "./i18n/context";
import type { Locale, TranslationKey } from "./i18n/locales";
import { useTheme } from "./theme/context";
import { InboxGallery } from "./InboxGallery";
import { Sidebar } from "./Sidebar";
import { Modal } from "./Modal";
import { GroupCreateModal } from "./GroupCreateModal";
import { GroupScanModal } from "./GroupScanModal";
import { TagCombobox } from "./TagCombobox";
import { Toast } from "./Toast";
import { Onboarding } from "./Onboarding";
import { DetailsDrawer } from "./DetailsDrawer";
import { SearchFilterBar, type FormatFilterType, type SortByType } from "./SearchFilterBar";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import {
  CloseIcon,
  GalleryViewIcon,
  GenericFileIcon,
  GroupsIcon,
  HamburgerIcon,
  HistoryIcon,
  InboxIcon,
  ListViewIcon,
  MaximizeIcon,
  MinimizeIcon,
  RestoreIcon,
  SidebarToggleIcon,
  TagIcon,
  TemporaryIcon,
  WarningIcon,
} from "./icons";

const SIDEBAR_COLLAPSED_KEY = "assetpile:sidebar-collapsed";
const ONBOARDING_DISMISSED_KEY = "onboarding_dismissed";

// Gallery card-size slider (spec's Inbox toolbar) — persisted the same way
// as sidebarCollapsed (localStorage, not the DB-backed `get_setting`/
// `set_setting` commands): purely a local UI preference, not something any
// other window or a future sync needs to see.
const CARD_SIZE_KEY = "assetpile:gallery-card-size";
export const CARD_SIZE_MIN = 160;
export const CARD_SIZE_MAX = 380;
// Matches the pre-slider default column layout (BREAKPOINTS in
// InboxGallery.tsx) almost exactly at this width, so introducing the
// slider doesn't change anyone's gallery density until they touch it.
const CARD_SIZE_DEFAULT = 360;

function loadCardSize(): number {
  try {
    const raw = Number(window.localStorage.getItem(CARD_SIZE_KEY));
    if (Number.isFinite(raw) && raw >= CARD_SIZE_MIN && raw <= CARD_SIZE_MAX) return raw;
  } catch {
    // Local storage can be unavailable — fall back to the default silently.
  }
  return CARD_SIZE_DEFAULT;
}

// The OS title bar already shows the app's name and icon — repeating both in
// an in-app topbar was pure duplication, so this bar instead names whatever
// section is currently open (a breadcrumb, not a second logo).
function tabLabel(tab: Tab, t: (key: TranslationKey) => string): string {
  switch (tab) {
    case "inbox":
      return t("nav.inbox");
    case "groups":
      return t("groups.title");
    case "tags":
      return t("tags.title");
    case "temporary":
      return t("nav.temporary");
    case "history":
      return t("nav.history");
    case "settings":
      return t("nav.settings");
  }
}

interface OrganizedEvent {
  file: FileRecord;
  operation_id: string;
}

// Main window shell.
export default function App() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("inbox");
  const [readyFiles, setReadyFiles] = useState<TrackedFile[]>([]);
  const [activeTagId, setActiveTagId] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  // Narrowest breakpoint (<720px, see styles.css): the sidebar hides behind
  // this hamburger toggle instead of always showing.
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [toast, setToast] = useState<{
    id: number;
    message: string;
    actionLabel?: string;
    onAction?: () => void;
  } | null>(null);

  function showToast(message: string, action?: { label: string; onAction: () => void }) {
    setToast({ id: Date.now(), message, actionLabel: action?.label, onAction: action?.onAction });
  }
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  function toggleSidebar() {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // Local storage can be unavailable (private mode, disabled site data) —
        // the toggle still works for this session, it just won't persist.
      }
      return next;
    });
  }

  // Load whatever's already pending/later/error in the DB so the Inbox
  // survives a restart instead of only reflecting this session's events.
  useEffect(() => {
    invoke<FileRecord[]>("list_inbox")
      .then((files) => setReadyFiles(files.map((f) => ({ ...f }))))
      .catch((err) => console.error("failed to load inbox", err));
  }, []);

  // First launch (or the user hasn't opted out yet): show the tour.
  useEffect(() => {
    invoke<string | null>("get_setting", { key: ONBOARDING_DISMISSED_KEY })
      .then((value) => {
        if (value !== '"true"') setOnboardingOpen(true);
      })
      .catch(() => {});
  }, []);

  function closeOnboarding(dontShowAgain: boolean) {
    setOnboardingOpen(false);
    invoke("set_setting", {
      key: ONBOARDING_DISMISSED_KEY,
      value: JSON.stringify(dontShowAgain),
    }).catch(() => {});
  }

  useEffect(() => {
    const unlistenReady = listen<FileRecord>("file-ready", (event) => {
      setReadyFiles((prev) => [event.payload, ...prev].slice(0, 50));
    });
    const unlistenOrganized = listen<OrganizedEvent>("file-organized", (event) => {
      const { file, operation_id: operationId } = event.payload;
      setReadyFiles((prev) => {
        const tracked: TrackedFile = { ...file, operationId };
        const exists = prev.some((f) => f.id === file.id);
        if (exists) {
          return prev.map((f) => (f.id === file.id ? tracked : f));
        }
        return [tracked, ...prev].slice(0, 50);
      });
    });
    // Undo can happen from History too (a past session's operation) — keep
    // the live Inbox list in sync either way.
    const unlistenRestored = listen<FileRecord>("file-restored", (event) => {
      const file = event.payload;
      setReadyFiles((prev) => {
        const tracked: TrackedFile = { ...file, operationId: undefined };
        const exists = prev.some((f) => f.id === file.id);
        if (exists) {
          return prev.map((f) => (f.id === file.id ? tracked : f));
        }
        return [tracked, ...prev].slice(0, 50);
      });
    });
    // A file the Inbox was still showing got deleted outside the app (not
    // by one of the app's own operations) — it's gone, so drop it rather
    // than leave a dead entry the user can't act on.
    const unlistenMissing = listen<FileRecord>("file-missing", (event) => {
      const missingId = event.payload.id;
      setReadyFiles((prev) => prev.filter((f) => f.id !== missingId));
    });
    return () => {
      unlistenReady.then((fn) => fn());
      unlistenOrganized.then((fn) => fn());
      unlistenRestored.then((fn) => fn());
      unlistenMissing.then((fn) => fn());
    };
  }, []);

  async function undoOperation(operationId: string) {
    try {
      await invoke<FileRecord>("undo_operation", { operationId });
      // The file-restored event (above) updates readyFiles; nothing else to do here.
    } catch (err) {
      window.alert(`${t("common.error")}: ${String(err)}`);
    }
  }

  // Local-only ordering (there's no persisted sort field for inbox items) so
  // the gallery can be dragged into whatever arrangement is useful right now.
  function reorderFiles(fromId: string, toId: string) {
    setReadyFiles((prev) => {
      const fromIndex = prev.findIndex((f) => f.id === fromId);
      const toIndex = prev.findIndex((f) => f.id === toId);
      if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }

  // Filing a card by dragging it onto a Group folder in the sidebar — the
  // same move `assign_group` already does for the Floating Card's buttons.
  async function fileToGroup(fileId: string, groupId: string) {
    try {
      await invoke("assign_group", { fileId, groupId });
    } catch (err) {
      window.alert(String(err));
    }
  }

  // Dragging a card onto a Tag in the sidebar — the same add as the
  // gallery card's own tag input, just via drag instead of typing.
  // `add_tag_to_file` keys on the tag's name (get-or-create), so the
  // sidebar passes that rather than the tag's id.
  async function fileToTag(fileId: string, tagName: string) {
    try {
      await invoke("add_tag_to_file", { fileId, tagName });
      void emit("tags-changed");
    } catch (err) {
      window.alert(String(err));
    }
  }

  return (
    <div className="app-root">
      <div className="topbar" data-tauri-drag-region>
        <button
          className="topbar-toggle"
          onClick={toggleSidebar}
          aria-label={t("sidebar.toggle")}
          title={t("sidebar.toggle")}
        >
          <SidebarToggleIcon width={16} height={16} />
        </button>
        <button
          className="topbar-toggle topbar-toggle-mobile"
          onClick={() => setMobileSidebarOpen((prev) => !prev)}
          aria-label={t("sidebar.menu")}
          title={t("sidebar.menu")}
        >
          <HamburgerIcon width={16} height={16} />
        </button>
        <span className="topbar-title">{tabLabel(tab, t)}</span>
        <WindowControls />
      </div>

      <div className="shell">
        <Sidebar
          collapsed={sidebarCollapsed}
          tab={tab}
          onTabChange={(next) => {
            setTab(next);
            setMobileSidebarOpen(false);
          }}
          readyFilesCount={readyFiles.length}
          activeTagId={activeTagId}
          onTagSelect={setActiveTagId}
          selectedGroupId={selectedGroupId}
          onSelectGroup={setSelectedGroupId}
          onFileDropOnGroup={(fileId, groupId) => void fileToGroup(fileId, groupId)}
          onFileDropOnTag={(fileId, tagName) => void fileToTag(fileId, tagName)}
          mobileOpen={mobileSidebarOpen}
          onCloseMobile={() => setMobileSidebarOpen(false)}
        />

        <main className={`content ${tab === "inbox" ? "content-inbox" : ""}`}>
          {tab === "inbox" && (
            <InboxPanel
              files={readyFiles}
              onUndo={(id) => void undoOperation(id)}
              onReorder={reorderFiles}
              activeTagId={activeTagId}
              onClearTagFilter={() => setActiveTagId(null)}
              onShowToast={showToast}
            />
          )}
          {tab === "groups" && (
            <GroupsPanel selectedGroupId={selectedGroupId} onSelectGroup={setSelectedGroupId} />
          )}
          {tab === "tags" && <TagsPanel />}
          {tab === "temporary" && <TemporaryPanel onShowToast={showToast} />}
          {tab === "history" && <HistoryPanel />}
          {tab === "settings" && <SettingsPanel onOpenOnboarding={() => setOnboardingOpen(true)} />}
        </main>
      </div>

      {onboardingOpen && <Onboarding onClose={closeOnboarding} />}
      {toast && (
        <Toast
          key={toast.id}
          message={toast.message}
          actionLabel={toast.actionLabel}
          onAction={toast.onAction}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  );
}

// The main window ships with `decorations: false` (spec: no native frame,
// rounded app-drawn corners instead), so these three replace what Windows
// would otherwise have drawn in the title bar.
function WindowControls() {
  const { t } = useI18n();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    win
      .isMaximized()
      .then(setMaximized)
      .catch(() => {});
    const unlisten = win.onResized(() => {
      win
        .isMaximized()
        .then(setMaximized)
        .catch(() => {});
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div className="window-controls">
      <button
        className="window-control-btn"
        aria-label={t("window.minimize")}
        onClick={() => void getCurrentWindow().minimize()}
      >
        <MinimizeIcon width={13} height={13} />
      </button>
      <button
        className="window-control-btn"
        aria-label={maximized ? t("window.restore") : t("window.maximize")}
        onClick={() => void getCurrentWindow().toggleMaximize()}
      >
        {maximized ? (
          <RestoreIcon width={13} height={13} />
        ) : (
          <MaximizeIcon width={13} height={13} />
        )}
      </button>
      <button
        className="window-control-btn window-control-close"
        aria-label={t("window.close")}
        onClick={() => void getCurrentWindow().close()}
      >
        <CloseIcon width={14} height={14} />
      </button>
    </div>
  );
}

function InboxPanel({
  files,
  onUndo,
  onReorder,
  activeTagId,
  onClearTagFilter,
  onShowToast,
}: {
  files: TrackedFile[];
  onUndo: (operationId: string) => void;
  onReorder: (fromId: string, toId: string) => void;
  activeTagId: string | null;
  onClearTagFilter: () => void;
  onShowToast: (message: string, action?: { label: string; onAction: () => void }) => void;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<"gallery" | "list">("gallery");
  const [cardSize, setCardSize] = useState<number>(loadCardSize);
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagsByFile, setTagsByFile] = useState<Record<string, Tag[]>>({});
  const [groups, setGroups] = useState<Group[]>([]);
  const [contextMenu, setContextMenu] = useState<{
    file: TrackedFile;
    x: number;
    y: number;
  } | null>(null);
  const [recycleTarget, setRecycleTarget] = useState<TrackedFile | null>(null);

  // Search, Filter & Selection states
  const [searchQuery, setSearchQuery] = useState("");
  const [formatFilter, setFormatFilter] = useState<FormatFilterType>("all");
  const [sortBy, setSortBy] = useState<SortByType>("newest");
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);

  function refreshTags() {
    invoke<Tag[]>("list_tags")
      .then(setTags)
      .catch(() => {});
    invoke<Record<string, Tag[]>>("list_all_file_tags")
      .then(setTagsByFile)
      .catch(() => {});
  }

  useEffect(() => {
    refreshTags();
    const unlisten = listen("tags-changed", refreshTags);
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    function refreshGroups() {
      invoke<Group[]>("list_groups")
        .then(setGroups)
        .catch(() => {});
    }
    refreshGroups();
    const unlisten = listen("groups-changed", refreshGroups);
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const selectedFile = useMemo(
    () => files.find((f) => f.id === selectedFileId) ?? null,
    [files, selectedFileId],
  );

  const [selectedThumbnail, setSelectedThumbnail] = useState<string | undefined>();

  useEffect(() => {
    if (!selectedFile || !isImageFile(selectedFile.current_name)) {
      setSelectedThumbnail(undefined);
      return;
    }
    let cancelled = false;
    invoke<string>("get_thumbnail", { path: selectedFile.current_path })
      .then((uri) => {
        if (!cancelled) setSelectedThumbnail(uri);
      })
      .catch(() => {
        if (!cancelled) setSelectedThumbnail(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedFile]);

  async function handleDrawerRename(fileId: string, newName: string) {
    await invoke("rename_file", { fileId, newName });
  }

  async function handleDrawerAddTag(fileId: string, tagName: string) {
    await invoke("add_tag_to_file", { fileId, tagName });
    refreshTags();
    void emit("tags-changed");
  }

  async function handleDrawerRemoveTag(fileId: string, tagId: string) {
    await invoke("remove_tag_from_file", { fileId, tagId });
    refreshTags();
    void emit("tags-changed");
  }

  async function handleDrawerAssignGroup(fileId: string, groupId: string) {
    await invoke("assign_group", { fileId, groupId });
  }

  const visibleFiles = useMemo(() => {
    let list = files;

    // 1. Filter by active tag (from sidebar)
    if (activeTagId) {
      list = list.filter((f) => (tagsByFile[f.id] ?? []).some((tag) => tag.id === activeTagId));
    }

    // 2. Filter by format category
    if (formatFilter !== "all") {
      list = list.filter((f) => {
        const ext = f.current_name.split(".").pop()?.toLowerCase() ?? "";
        switch (formatFilter) {
          case "image":
            return isImageFile(f.current_name);
          case "psd":
            return ext === "psd";
          case "png":
            return ext === "png";
          case "ai":
            return ext === "ai";
          case "doc":
            return ["pdf", "doc", "docx", "txt", "md", "xls", "xlsx", "ppt", "pptx"].includes(ext);
          case "video":
            return ["mp4", "mov", "mkv", "avi", "webm"].includes(ext);
          default:
            return true;
        }
      });
    }

    // 3. Filter by search query (file name, tag name, or group name)
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((f) => {
        if (f.current_name.toLowerCase().includes(q)) return true;
        const fileTags = tagsByFile[f.id] ?? [];
        if (fileTags.some((t) => t.name.toLowerCase().includes(q))) return true;
        if (f.group_id) {
          const group = groups.find((g) => g.id === f.group_id);
          if (group && group.name.toLowerCase().includes(q)) return true;
        }
        return false;
      });
    }

    // 4. Sort
    const sorted = [...list];
    switch (sortBy) {
      case "oldest":
        sorted.reverse();
        break;
      case "name_asc":
        sorted.sort((a, b) =>
          a.current_name.localeCompare(b.current_name, undefined, { sensitivity: "base" }),
        );
        break;
      case "name_desc":
        sorted.sort((a, b) =>
          b.current_name.localeCompare(a.current_name, undefined, { sensitivity: "base" }),
        );
        break;
      case "size_desc":
        sorted.sort((a, b) => (b.size_bytes ?? 0) - (a.size_bytes ?? 0));
        break;
      case "size_asc":
        sorted.sort((a, b) => (a.size_bytes ?? 0) - (b.size_bytes ?? 0));
        break;
      case "newest":
      default:
        break;
    }

    return sorted;
  }, [files, activeTagId, tagsByFile, formatFilter, searchQuery, groups, sortBy]);

  const activeTagName = tags.find((tag) => tag.id === activeTagId)?.name ?? "";

  function openContextMenu(file: TrackedFile, x: number, y: number) {
    setContextMenu({ file, x, y });
  }

  function updateCardSize(next: number) {
    setCardSize(next);
    try {
      window.localStorage.setItem(CARD_SIZE_KEY, String(next));
    } catch {
      // Local storage can be unavailable
    }
  }

  async function renameViaMenu(file: TrackedFile) {
    const name = window.prompt(t("inbox.renamePlaceholder"), file.current_name)?.trim();
    if (!name || name === file.current_name) return;
    try {
      await invoke("rename_file", { fileId: file.id, newName: name });
    } catch (err) {
      window.alert(String(err));
    }
  }

  async function fileToGroupViaMenu(fileId: string, groupId: string) {
    try {
      await invoke("assign_group", { fileId, groupId });
    } catch (err) {
      window.alert(String(err));
    }
  }

  async function markTemporaryViaMenu(fileId: string) {
    try {
      await invoke("mark_temporary", { fileId });
    } catch (err) {
      window.alert(String(err));
    }
  }

  async function confirmRecycle() {
    const file = recycleTarget;
    if (!file) return;
    setRecycleTarget(null);
    try {
      await invoke("move_to_recycle_bin", { fileId: file.id });
      onShowToast(t("temporary.movedToRecycleBin", { name: file.current_name }));
    } catch (err) {
      window.alert(String(err));
    }
  }

  function menuItemsFor(file: TrackedFile): ContextMenuItem[] {
    const items: ContextMenuItem[] = [
      { label: t("inbox.rename"), onSelect: () => void renameViaMenu(file) },
    ];
    if (groups.length > 0) {
      items.push({
        label: t("temporary.moveToGroup"),
        submenu: groups.map((group) => ({
          label: group.name,
          onSelect: () => void fileToGroupViaMenu(file.id, group.id),
        })),
      });
    }
    items.push({
      label: t("temporary.title"),
      onSelect: () => void markTemporaryViaMenu(file.id),
    });
    if (file.status === "organized" && file.operationId) {
      items.push({ label: t("common.undo"), onSelect: () => onUndo(file.operationId!) });
    }
    items.push({
      label: t("temporary.recycleBin"),
      danger: true,
      onSelect: () => setRecycleTarget(file),
    });
    return items;
  }

  return (
    <>
      <div className="inbox-layout-wrapper">
        <div className="inbox-main-content">
          <header className="panel-header">
            <div className="panel-header-row">
              <div>
                <h1>{t("inbox.title")}</h1>
                <p>{t("inbox.description")}</p>
              </div>
              {files.length > 0 && (
                <div className="inbox-toolbar">
                  {view === "gallery" && (
                    <div className="card-size-slider" title={t("inbox.cardSize")}>
                      <GalleryViewIcon width={11} height={11} />
                      <input
                        type="range"
                        min={CARD_SIZE_MIN}
                        max={CARD_SIZE_MAX}
                        step={10}
                        value={cardSize}
                        aria-label={t("inbox.cardSize")}
                        onChange={(e) => updateCardSize(Number(e.target.value))}
                      />
                      <GalleryViewIcon width={17} height={17} />
                    </div>
                  )}
                  <div className="view-toggle">
                    <button
                      className={view === "gallery" ? "active" : ""}
                      onClick={() => setView("gallery")}
                    >
                      <GalleryViewIcon width={14} height={14} /> {t("inbox.viewGallery")}
                    </button>
                    <button
                      className={view === "list" ? "active" : ""}
                      onClick={() => setView("list")}
                    >
                      <ListViewIcon width={14} height={14} /> {t("inbox.viewList")}
                    </button>
                  </div>
                </div>
              )}
            </div>
            {activeTagId && (
              <div className="active-filter-chip">
                {t("inbox.filteredBy", { name: activeTagName })}
                <button
                  className="active-filter-clear"
                  aria-label={t("inbox.clearFilter")}
                  onClick={onClearTagFilter}
                >
                  <CloseIcon width={11} height={11} />
                </button>
              </div>
            )}
          </header>

          <SearchFilterBar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            formatFilter={formatFilter}
            onFormatFilterChange={setFormatFilter}
            sortBy={sortBy}
            onSortChange={setSortBy}
          />

          {visibleFiles.length === 0 ? (
            <EmptyState
              icon={<InboxIcon width={28} height={28} />}
              text={
                searchQuery || formatFilter !== "all" || activeTagId
                  ? t("inbox.emptyFiltered")
                  : t("inbox.empty")
              }
            />
          ) : view === "gallery" ? (
            <InboxGallery
              files={visibleFiles}
              onUndo={onUndo}
              onReorder={onReorder}
              onContextMenu={openContextMenu}
              cardSize={cardSize}
              selectedFileId={selectedFileId}
              onSelectFile={(file) =>
                setSelectedFileId((prev) => (prev === file.id ? null : file.id))
              }
            />
          ) : (
            <ul className="file-list">
              {visibleFiles.map((file) => (
                <li
                  key={file.id}
                  className={`file-row ${selectedFileId === file.id ? "selected" : ""}`}
                  draggable
                  onClick={(e) => {
                    const target = e.target as HTMLElement;
                    if (target.closest("button, a")) return;
                    setSelectedFileId((prev) => (prev === file.id ? null : file.id));
                  }}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(FILE_DRAG_MIME, file.id);
                    e.dataTransfer.effectAllowed = "move";
                    setDragPreview(e, file.current_name);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    openContextMenu(file, e.clientX, e.clientY);
                  }}
                >
                  <span className="file-name" title={file.current_name}>
                    {file.current_name}
                  </span>
                  <span className="file-size">{formatSize(file.size_bytes)}</span>
                  <span className={`status-badge status-badge-${file.status}`}>
                    {t(`status.${file.status}` as TranslationKey)}
                  </span>
                  {file.status === "organized" && file.operationId && (
                    <button className="btn-link" onClick={() => onUndo(file.operationId!)}>
                      {t("common.undo")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {selectedFile && (
          <DetailsDrawer
            file={selectedFile}
            onClose={() => setSelectedFileId(null)}
            tags={tagsByFile[selectedFile.id] ?? []}
            allTags={tags}
            groups={groups}
            thumbnail={selectedThumbnail}
            onRename={handleDrawerRename}
            onAddTag={handleDrawerAddTag}
            onRemoveTag={handleDrawerRemoveTag}
            onAssignGroup={handleDrawerAssignGroup}
            onRecycle={(file) => setRecycleTarget(file)}
            onUndo={onUndo}
          />
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={menuItemsFor(contextMenu.file)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {recycleTarget && (
        <RecycleBinConfirmModal
          fileName={recycleTarget.current_name}
          onCancel={() => setRecycleTarget(null)}
          onConfirm={() => void confirmRecycle()}
        />
      )}
    </>
  );
}

// Shared by the Inbox context menu and the Temporary panel — both moves to
// the Recycle Bin used to gate on a native `window.confirm`; this in-app
// modal replaces both call sites with the same look (spec: title, the file
// named in the body, Cancel + a red primary "Move to Recycle Bin").
function RecycleBinConfirmModal({
  fileName,
  onCancel,
  onConfirm,
}: {
  fileName: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  return (
    <Modal title={t("temporary.recycleBinConfirmTitle")} onClose={onCancel}>
      <p className="modal-body-text">{t("temporary.recycleBinConfirm", { name: fileName })}</p>
      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button type="button" className="btn-danger" onClick={onConfirm}>
          {t("temporary.recycleBinConfirmAction")}
        </button>
      </div>
    </Modal>
  );
}

function GroupsPanel({
  selectedGroupId,
  onSelectGroup,
}: {
  selectedGroupId: string | null;
  onSelectGroup: (groupId: string | null) => void;
}) {
  const { t } = useI18n();
  const [groups, setGroups] = useState<Group[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    invoke<Group[]>("list_groups")
      .then(setGroups)
      .catch((err) => setError(String(err)));
  }

  useEffect(refresh, []);

  async function deleteGroup(groupId: string, groupName: string) {
    if (!window.confirm(t("groups.deleteConfirm", { name: groupName }))) return;
    setDeletingId(groupId);
    setError(null);
    try {
      await invoke("delete_group", { groupId });
      if (selectedGroupId === groupId) onSelectGroup(null);
      refresh();
      void emit("groups-changed");
    } catch (err) {
      setError(String(err));
    } finally {
      setDeletingId(null);
    }
  }

  const selectedGroup = groups.find((g) => g.id === selectedGroupId) ?? null;
  if (selectedGroupId && selectedGroup) {
    return (
      <GroupFilesPanel
        group={selectedGroup}
        deleting={deletingId === selectedGroup.id}
        onDelete={() => void deleteGroup(selectedGroup.id, selectedGroup.name)}
        onUpdated={() => {
          refresh();
          void emit("groups-changed");
        }}
      />
    );
  }

  return (
    <>
      <header className="panel-header">
        <div className="panel-header-row">
          <div>
            <h1>{t("groups.title")}</h1>
            <p>{t("groups.description")}</p>
          </div>
          <button className="btn-pill btn-pill-primary" onClick={() => setShowCreate(true)}>
            + {t("groups.cardNew")}
          </button>
        </div>
      </header>
      {error && <p className="form-error">{error}</p>}

      <div className="groups-grid">
        {groups.map((group) => (
          <div
            key={group.id}
            className="group-grid-card"
            role="button"
            tabIndex={0}
            onClick={() => onSelectGroup(group.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSelectGroup(group.id);
            }}
          >
            <div className="group-card-icon-wrap">
              <GroupsIcon width={20} height={20} />
            </div>
            <div className="group-card-body">
              <div className="group-card-name" title={group.name}>
                {group.name}
              </div>
              <div className="group-card-path" title={group.destination_path ?? undefined}>
                {group.destination_path}
              </div>
            </div>
            <div className="group-card-footer">
              <button
                type="button"
                className="btn-link btn-link-danger"
                disabled={deletingId === group.id}
                onClick={(e) => {
                  e.stopPropagation();
                  void deleteGroup(group.id, group.name);
                }}
              >
                {t("groups.delete")}
              </button>
            </div>
          </div>
        ))}
        <button
          type="button"
          className="group-grid-card group-grid-card-new"
          onClick={() => setShowCreate(true)}
        >
          <span className="group-new-label">+ {t("groups.cardNew")}</span>
        </button>
      </div>

      {showCreate && (
        <GroupCreateModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            refresh();
            void emit("groups-changed");
          }}
        />
      )}
    </>
  );
}

type DestinationError = "group_path_not_found" | "group_path_permission_denied";

function GroupFilesPanel({
  group,
  deleting,
  onDelete,
  onUpdated,
}: {
  group: Group;
  deleting: boolean;
  onDelete: () => void;
  onUpdated: () => void;
}) {
  const { t } = useI18n();
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tagsByFile, setTagsByFile] = useState<Record<string, Tag[]>>({});
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [showScan, setShowScan] = useState(false);
  const [destinationError, setDestinationError] = useState<DestinationError | null>(null);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});

  useEffect(() => {
    for (const file of files) {
      if (thumbnails[file.id] || !isImageFile(file.current_name)) continue;
      invoke<string>("get_thumbnail", { path: file.current_path })
        .then((dataUri) => setThumbnails((prev) => ({ ...prev, [file.id]: dataUri })))
        .catch(() => {});
    }
  }, [files, thumbnails]);

  function refreshFiles() {
    setLoading(true);
    setError(null);
    setDestinationError(null);
    invoke<FileRecord[]>("list_group_files", { groupId: group.id })
      .then(setFiles)
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));

    invoke("check_group_destination", { groupId: group.id })
      .then(() => setDestinationError(null))
      .catch((err) => {
        if (err === "group_path_not_found" || err === "group_path_permission_denied") {
          setDestinationError(err);
        }
      });
  }

  function refreshTags() {
    invoke<Record<string, Tag[]>>("list_all_file_tags")
      .then(setTagsByFile)
      .catch(() => {});
    invoke<Tag[]>("list_tags")
      .then(setAllTags)
      .catch(() => {});
  }

  useEffect(() => {
    refreshFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.id]);

  useEffect(() => {
    refreshTags();
    const unlisten = listen("tags-changed", refreshTags);
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  async function addTag(fileId: string, tagName: string) {
    await invoke("add_tag_to_file", { fileId, tagName });
    refreshTags();
    void emit("tags-changed");
  }

  async function removeTag(fileId: string, tagId: string) {
    await invoke("remove_tag_from_file", { fileId, tagId });
    refreshTags();
    void emit("tags-changed");
  }

  async function chooseDifferentFolder() {
    if (choosingFolder) return;
    setChoosingFolder(true);
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected !== "string") return;
      await invoke("update_group_destination", { groupId: group.id, destinationPath: selected });
      setDestinationError(null);
      onUpdated();
    } catch (err) {
      window.alert(String(err));
    } finally {
      setChoosingFolder(false);
    }
  }

  return (
    <>
      <header className="panel-header">
        <div className="panel-header-row">
          <div>
            <h1>{group.name}</h1>
            <p title={group.destination_path ?? undefined}>{group.destination_path}</p>
          </div>
          <div className="panel-header-actions">
            <button className="btn-pill btn-pill-secondary" onClick={() => setShowScan(true)}>
              {t("groups.scanNew")}
            </button>
            <button className="btn-link btn-link-danger" disabled={deleting} onClick={onDelete}>
              {t("groups.deleteGroup")}
            </button>
          </div>
        </div>
      </header>
      {error && <p className="form-error">{error}</p>}

      {destinationError ? (
        <div className={`destination-banner destination-banner-${destinationError}`}>
          <WarningIcon width={22} height={22} />
          <div className="destination-banner-body">
            <h3>
              {destinationError === "group_path_not_found"
                ? t("groups.pathNotFoundTitle")
                : t("groups.pathPermissionTitle")}
            </h3>
            <p>
              {destinationError === "group_path_not_found"
                ? t("groups.pathNotFoundDescription", { path: group.destination_path ?? "" })
                : t("groups.pathPermissionDescription", { path: group.destination_path ?? "" })}
            </p>
            <div className="destination-banner-actions">
              <button
                className="btn-secondary"
                disabled={choosingFolder}
                onClick={() => void chooseDifferentFolder()}
              >
                {t("groups.chooseDifferentFolder")}
              </button>
              <button className="btn-link btn-link-danger" disabled={deleting} onClick={onDelete}>
                {t("groups.removeGroup")}
              </button>
            </div>
          </div>
        </div>
      ) : !loading && files.length === 0 ? (
        <EmptyState icon={<GroupsIcon width={28} height={28} />} text={t("groups.filesEmpty")} />
      ) : (
        <div className="group-detail-table-wrap">
          <table className="group-detail-table">
            <thead>
              <tr>
                <th className="col-name">{t("table.name")}</th>
                <th className="col-format">{t("table.format")}</th>
                <th className="col-size">{t("table.dimensions")}</th>
                <th className="col-tags">{t("table.tags")}</th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => {
                const ext = file.current_name.split(".").pop()?.toUpperCase() ?? "FILE";
                const thumb = thumbnails[file.id];
                return (
                  <tr key={file.id} className="group-detail-row">
                    <td className="col-name">
                      <div className="group-file-title-wrap">
                        <div className="group-file-thumb">
                          {thumb ? (
                            <img src={thumb} alt="" />
                          ) : (
                            <GenericFileIcon width={18} height={18} />
                          )}
                        </div>
                        <span className="group-file-title" title={file.current_name}>
                          {file.current_name}
                        </span>
                      </div>
                    </td>
                    <td className="col-format">
                      <span className="group-file-ext">{ext}</span>
                    </td>
                    <td className="col-size">
                      <span className="group-file-size">{formatSize(file.size_bytes)}</span>
                    </td>
                    <td className="col-tags">
                      <FileTagEditor
                        fileId={file.id}
                        tags={tagsByFile[file.id] ?? []}
                        allTags={allTags}
                        onAddTag={addTag}
                        onRemoveTag={removeTag}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showScan && (
        <GroupScanModal
          group={group}
          onClose={() => setShowScan(false)}
          onImported={() => {
            setShowScan(false);
            refreshFiles();
            refreshTags();
          }}
        />
      )}
    </>
  );
}

// The same tag-chip-plus-combobox control the Inbox gallery card uses, just
// without the rename/thumbnail/drag chrome that only makes sense there —
// a file already filed under a Group gets tagged the same way one still in
// the Inbox does.
function FileTagEditor({
  fileId,
  tags,
  allTags,
  onAddTag,
  onRemoveTag,
}: {
  fileId: string;
  tags: Tag[];
  allTags: Tag[];
  onAddTag: (fileId: string, tagName: string) => Promise<void>;
  onRemoveTag: (fileId: string, tagId: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [addingTag, setAddingTag] = useState(false);
  const [tagDraft, setTagDraft] = useState("");

  async function commitTag(nameOverride?: string) {
    const name = (nameOverride ?? tagDraft).trim();
    setTagDraft("");
    setAddingTag(false);
    if (!name) return;
    await onAddTag(fileId, name);
  }

  return (
    <div className="gallery-card-tags file-row-tags">
      {tags.map((tag) => (
        <span key={tag.id} className="gallery-tag-chip">
          {tag.name}
          <button
            className="gallery-tag-remove"
            aria-label={t("common.close")}
            onClick={() => void onRemoveTag(fileId, tag.id)}
          >
            <CloseIcon width={10} height={10} />
          </button>
        </span>
      ))}
      {addingTag ? (
        <TagCombobox
          value={tagDraft}
          onChange={setTagDraft}
          options={allTags.filter(
            (candidate) => !tags.some((existing) => existing.id === candidate.id),
          )}
          placeholder={t("inbox.addTag")}
          onCommit={(name) => void commitTag(name)}
          onCancel={() => {
            setTagDraft("");
            setAddingTag(false);
          }}
        />
      ) : (
        <button className="gallery-tag-add" onClick={() => setAddingTag(true)}>
          <TagIcon width={11} height={11} /> {t("inbox.addTag")}
        </button>
      )}
    </div>
  );
}

function TagsPanel() {
  const { t } = useI18n();
  const [tags, setTags] = useState<Tag[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    invoke<Tag[]>("list_tags")
      .then(setTags)
      .catch((err) => setError(String(err)));
  }

  useEffect(refresh, []);

  async function deleteTag(tagId: string, tagName: string) {
    if (!window.confirm(t("tags.deleteConfirm", { name: tagName }))) return;
    setDeletingId(tagId);
    setError(null);
    try {
      await invoke("delete_tag", { tagId });
      refresh();
      void emit("tags-changed");
    } catch (err) {
      setError(String(err));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <>
      <header className="panel-header">
        <h1>{t("tags.title")}</h1>
        <p>{t("tags.description")}</p>
      </header>
      {error && <p className="form-error">{error}</p>}

      {tags.length === 0 ? (
        <EmptyState icon={<TagIcon width={28} height={28} />} text={t("sidebar.noTags")} />
      ) : (
        <ul className="group-list">
          {tags.map((tag) => (
            <li key={tag.id} className="group-card group-card-static">
              <TagIcon width={18} height={18} />
              <div className="group-name">{tag.name}</div>
              <button
                className="btn-link btn-link-danger"
                disabled={deletingId === tag.id}
                onClick={() => void deleteTag(tag.id, tag.name)}
              >
                {t("groups.delete")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function TemporaryPanel({
  onShowToast,
}: {
  onShowToast: (message: string, action?: { label: string; onAction: () => void }) => void;
}) {
  const { t } = useI18n();
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recycleTarget, setRecycleTarget] = useState<{ id: string; name: string } | null>(null);

  function refresh() {
    invoke<FileRecord[]>("list_temporary")
      .then(setFiles)
      .catch((err) => setError(String(err)));
  }

  useEffect(() => {
    refresh();
    invoke<Group[]>("list_groups")
      .then(setGroups)
      .catch(() => setGroups([]));

    const unlistenExpired = listen("temporary-expired", refresh);
    const unlistenMissing = listen("file-missing", refresh);
    return () => {
      unlistenExpired.then((fn) => fn());
      unlistenMissing.then((fn) => fn());
    };
  }, []);

  async function keepLonger(fileId: string) {
    setBusyId(fileId);
    try {
      await invoke("mark_temporary", { fileId });
      refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function moveToGroup(fileId: string, groupId: string) {
    if (!groupId) return;
    setBusyId(fileId);
    try {
      await invoke("assign_group", { fileId, groupId });
      refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function confirmMoveToRecycleBin() {
    const target = recycleTarget;
    if (!target) return;
    setRecycleTarget(null);
    setBusyId(target.id);
    try {
      await invoke("move_to_recycle_bin", { fileId: target.id });
      refresh();
      onShowToast(t("temporary.movedToRecycleBin", { name: target.name }));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <header className="panel-header">
        <h1>{t("temporary.title")}</h1>
        <p>{t("temporary.description")}</p>
      </header>
      {error && <p className="form-error">{error}</p>}

      {files.length === 0 ? (
        <EmptyState icon={<TemporaryIcon width={28} height={28} />} text={t("temporary.empty")} />
      ) : (
        <ul className="file-list">
          {files.map((file) => (
            <li key={file.id} className="file-row temporary-row">
              <span className="file-name" title={file.current_name}>
                {file.current_name}
              </span>
              <span className="file-size">{formatSize(file.size_bytes)}</span>
              <span className={`status-badge status-badge-${file.status}`}>
                {file.status === "cleanup_ready"
                  ? t("temporary.readyForCleanup")
                  : file.expires_at
                    ? t("temporary.expiresIn", { time: formatRelative(file.expires_at) })
                    : t("status.temporary")}
              </span>
              <div className="temporary-actions">
                <button
                  className="btn-link"
                  disabled={busyId === file.id}
                  onClick={() => void keepLonger(file.id)}
                >
                  {t("temporary.keepLonger")}
                </button>
                <select
                  disabled={busyId === file.id || groups.length === 0}
                  defaultValue=""
                  onChange={(e) => void moveToGroup(file.id, e.target.value)}
                >
                  <option value="" disabled>
                    {t("temporary.moveToGroup")}
                  </option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
                <button
                  className="btn-link btn-link-danger"
                  disabled={busyId === file.id}
                  onClick={() => setRecycleTarget({ id: file.id, name: file.current_name })}
                >
                  {t("temporary.recycleBin")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {recycleTarget && (
        <RecycleBinConfirmModal
          fileName={recycleTarget.name}
          onCancel={() => setRecycleTarget(null)}
          onConfirm={() => void confirmMoveToRecycleBin()}
        />
      )}
    </>
  );
}

function HistoryPanel() {
  const { t } = useI18n();
  const [operations, setOperations] = useState<Operation[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    invoke<Operation[]>("list_operations")
      .then(setOperations)
      .catch((err) => setError(String(err)));
  }

  useEffect(refresh, []);

  async function undo(operationId: string) {
    setBusyId(operationId);
    setError(null);
    try {
      await invoke("undo_operation", { operationId });
      refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <header className="panel-header">
        <h1>{t("history.title")}</h1>
        <p>{t("history.description")}</p>
      </header>
      {error && <p className="form-error">{error}</p>}

      {operations.length === 0 ? (
        <EmptyState icon={<HistoryIcon width={28} height={28} />} text={t("history.empty")} />
      ) : (
        <div className="history-table-wrap">
          <table className="history-table">
            <thead>
              <tr>
                <th className="col-file">{t("history.table.file")}</th>
                <th className="col-op">{t("history.table.operation")}</th>
                <th className="col-status">{t("history.table.status")}</th>
                <th className="col-time">{t("history.table.time")}</th>
                <th className="col-action">{t("history.table.action")}</th>
              </tr>
            </thead>
            <tbody>
              {operations.map((op) => {
                const canUndo =
                  op.operation_type === "move" && op.status === "completed" && !op.undone_at;
                const fileName = fileNameFromPath(op.destination_path ?? op.source_path);

                return (
                  <tr key={op.id} className="history-row">
                    <td className="col-file">
                      <span
                        className="history-file-name"
                        title={op.destination_path ?? op.source_path ?? undefined}
                      >
                        {fileName}
                      </span>
                    </td>
                    <td className="col-op">
                      <span className="history-op-badge">
                        {t(`operation.${op.operation_type}` as TranslationKey)}
                      </span>
                    </td>
                    <td className="col-status">
                      <span
                        className={`history-status-pill ${
                          op.undone_at
                            ? "status-undone"
                            : op.status === "completed"
                              ? "status-completed"
                              : op.status === "failed" || op.status === "error"
                                ? "status-failed"
                                : "status-pending"
                        }`}
                      >
                        {op.undone_at
                          ? t("operation.undone")
                          : t(`operation.${op.status}` as TranslationKey)}
                      </span>
                    </td>
                    <td className="col-time">
                      <span className="history-time">{formatRelative(op.created_at)}</span>
                    </td>
                    <td className="col-action">
                      {canUndo && (
                        <button
                          type="button"
                          className="btn-link history-undo-btn"
                          disabled={busyId === op.id}
                          onClick={() => void undo(op.id)}
                        >
                          {t("history.undo")}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

type UpdateCheckState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "upToDate" }
  | { status: "available"; info: UpdateInfo }
  | { status: "error" };

function SettingsToggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="settings-toggle-row">
      <div className="settings-toggle-copy">
        <span className="settings-toggle-label">{label}</span>
        <span className="settings-toggle-hint">{hint}</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`switch${checked ? " on" : ""}`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

function SettingsPanel({ onOpenOnboarding }: { onOpenOnboarding: () => void }) {
  const { t, locale, setLocale } = useI18n();
  const { mode, setMode } = useTheme();
  const [folders, setFolders] = useState<string[]>([]);
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);

  const [minimizeOnClose, setMinimizeOnClose] = useState(true);
  const [silentStart, setSilentStart] = useState(false);
  const [autostart, setAutostart] = useState(false);
  const [autostartError, setAutostartError] = useState<string | null>(null);
  const [autoCheckUpdate, setAutoCheckUpdate] = useState(true);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckState>({ status: "idle" });

  function refreshFolders() {
    invoke<string[]>("list_watched_folders")
      .then(setFolders)
      .catch((err) => setFolderError(String(err)));
  }

  useEffect(refreshFolders, []);

  async function runUpdateCheck() {
    setUpdateCheck({ status: "checking" });
    try {
      const info = await checkForUpdate(await getVersion());
      setUpdateCheck(info ? { status: "available", info } : { status: "upToDate" });
    } catch (err) {
      console.error("update check failed", err);
      setUpdateCheck({ status: "error" });
    }
  }

  useEffect(() => {
    invoke<string | null>("get_setting", { key: "minimizeOnClose" })
      .then((value) => {
        if (value !== null) setMinimizeOnClose(JSON.parse(value) as boolean);
      })
      .catch(() => {});
    invoke<string | null>("get_setting", { key: "silentStart" })
      .then((value) => {
        if (value !== null) setSilentStart(JSON.parse(value) as boolean);
      })
      .catch(() => {});
    isAutostartEnabled()
      .then(setAutostart)
      .catch(() => {});
    invoke<string | null>("get_setting", { key: "autoCheckUpdate" })
      .then((value) => {
        const enabled = value === null ? true : (JSON.parse(value) as boolean);
        setAutoCheckUpdate(enabled);
        if (enabled) void runUpdateCheck();
      })
      .catch(() => {});
  }, []);

  function updateMinimizeOnClose(next: boolean) {
    setMinimizeOnClose(next);
    invoke("set_setting", { key: "minimizeOnClose", value: JSON.stringify(next) }).catch(() => {});
  }

  function updateSilentStart(next: boolean) {
    setSilentStart(next);
    invoke("set_setting", { key: "silentStart", value: JSON.stringify(next) }).catch(() => {});
  }

  async function updateAutostart(next: boolean) {
    setAutostartError(null);
    setAutostart(next);
    try {
      if (next) await enableAutostart();
      else await disableAutostart();
    } catch (err) {
      setAutostart(!next);
      setAutostartError(String(err));
    }
  }

  function updateAutoCheckUpdate(next: boolean) {
    setAutoCheckUpdate(next);
    invoke("set_setting", { key: "autoCheckUpdate", value: JSON.stringify(next) }).catch(() => {});
    if (next) void runUpdateCheck();
    else setUpdateCheck({ status: "idle" });
  }

  async function viewUpdate(url: string) {
    try {
      await openUrl(url);
    } catch (err) {
      console.error("failed to open update url", err);
    }
  }

  async function addFolder() {
    if (folderBusy) return;
    setFolderBusy(true);
    setFolderError(null);
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected !== "string") return;
      setFolders(await invoke<string[]>("add_watched_folder", { path: selected }));
    } catch (err) {
      setFolderError(String(err));
    } finally {
      setFolderBusy(false);
    }
  }

  async function removeFolder(path: string) {
    setFolderBusy(true);
    setFolderError(null);
    try {
      setFolders(await invoke<string[]>("remove_watched_folder", { path }));
    } catch (err) {
      setFolderError(String(err));
    } finally {
      setFolderBusy(false);
    }
  }

  const [appVersion, setAppVersion] = useState<string>("v0.2.3");

  useEffect(() => {
    getVersion()
      .then((v) => setAppVersion(`v${v}`))
      .catch(() => {});
  }, []);

  return (
    <>
      <header className="panel-header">
        <h1>{t("settings.title")}</h1>
        <p>{t("settings.description")}</p>
      </header>

      {/* Card 1: Preferences & Background */}
      <div className="settings-card">
        {/* Language & Appearance */}
        <div className="settings-card-section">
          <h3 className="settings-card-subtitle">{t("settings.appearanceSection")}</h3>
          <div className="settings-fields-row">
            <div className="settings-field-col">
              <label className="settings-label">{t("settings.language")}</label>
              <select
                className="settings-select"
                value={locale}
                onChange={(e) => setLocale(e.target.value as Locale)}
              >
                <option value="zh">{t("settings.languageZh")}</option>
                <option value="en">{t("settings.languageEn")}</option>
              </select>
            </div>
            <div className="settings-field-col">
              <label className="settings-label">{t("settings.theme")}</label>
              <div className="theme-segment-control">
                <button
                  type="button"
                  className={`segment-btn ${mode === "system" ? "active" : ""}`}
                  onClick={() => setMode("system")}
                >
                  {t("settings.themeSystem")}
                </button>
                <button
                  type="button"
                  className={`segment-btn ${mode === "light" ? "active" : ""}`}
                  onClick={() => setMode("light")}
                >
                  {t("settings.themeLight")}
                </button>
                <button
                  type="button"
                  className={`segment-btn ${mode === "dark" ? "active" : ""}`}
                  onClick={() => setMode("dark")}
                >
                  {t("settings.themeDark")}
                </button>
              </div>
            </div>
          </div>
        </div>

        <hr className="settings-divider" />

        {/* Startup & Background */}
        <div className="settings-card-section">
          <h3 className="settings-card-subtitle">{t("settings.startupSection")}</h3>
          <div className="settings-toggles-list">
            <SettingsToggle
              label={t("settings.minimizeOnClose")}
              hint={t("settings.minimizeOnCloseHint")}
              checked={minimizeOnClose}
              onChange={updateMinimizeOnClose}
            />
            <SettingsToggle
              label={t("settings.autostart")}
              hint={t("settings.autostartHint")}
              checked={autostart}
              onChange={(next) => void updateAutostart(next)}
            />
            <SettingsToggle
              label={t("settings.silentStart")}
              hint={t("settings.silentStartHint")}
              checked={silentStart}
              onChange={updateSilentStart}
            />
            <SettingsToggle
              label={t("settings.autoCheckUpdate")}
              hint={t("settings.autoCheckUpdateHint")}
              checked={autoCheckUpdate}
              onChange={updateAutoCheckUpdate}
            />
          </div>
          {autostartError && <p className="form-error">{autostartError}</p>}
        </div>

        <hr className="settings-divider" />

        {/* Updates */}
        <div className="settings-card-section">
          <h3 className="settings-card-subtitle">{t("settings.updateSection")}</h3>
          <div className="settings-update-row">
            <span className="settings-version-text">
              {updateCheck.status === "available"
                ? t("settings.updateAvailable", { version: updateCheck.info.version })
                : updateCheck.status === "checking"
                  ? t("settings.checkingForUpdates")
                  : updateCheck.status === "error"
                    ? t("settings.updateCheckFailed")
                    : t("settings.versionLatest", { version: appVersion.replace(/^v/, "") })}
            </span>
            <div className="settings-update-actions">
              {updateCheck.status === "available" && (
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => void viewUpdate(updateCheck.info.url)}
                >
                  {t("settings.viewUpdate")}
                </button>
              )}
              {updateCheck.status !== "checking" && (
                <button type="button" className="btn-link" onClick={() => void runUpdateCheck()}>
                  {t("settings.checkForUpdates")}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Card 2: Watched Folders */}
      <div className="settings-card">
        <div className="settings-card-header">
          <div>
            <h3 className="settings-card-title">{t("settings.watchedFolders")}</h3>
            <p className="settings-card-desc">{t("settings.watchedFoldersHint")}</p>
          </div>
          <button
            type="button"
            className="btn-pill btn-pill-secondary"
            disabled={folderBusy}
            onClick={() => void addFolder()}
          >
            {t("settings.addFolderBtn")}
          </button>
        </div>
        {folderError && <p className="form-error">{folderError}</p>}
        {folders.length === 0 ? (
          <p className="settings-empty-hint">{t("settings.noWatchedFolders")}</p>
        ) : (
          <ul className="watched-folder-list">
            {folders.map((path) => (
              <li key={path} className="watched-folder-row">
                <span className="watched-folder-path" title={path}>
                  {path}
                </span>
                <button
                  type="button"
                  className="btn-link btn-link-danger"
                  disabled={folderBusy}
                  onClick={() => void removeFolder(path)}
                >
                  {t("groups.delete")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Card 3: Help */}
      <div className="settings-card settings-card-row">
        <h3 className="settings-card-title">{t("settings.help")}</h3>
        <button type="button" className="btn-pill btn-pill-secondary" onClick={onOpenOnboarding}>
          {t("settings.reopenOnboarding")}
        </button>
      </div>
    </>
  );
}

function EmptyState({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="empty-state">
      {icon}
      <p>{text}</p>
    </div>
  );
}
