import { useEffect, useState, type FormEvent, type ReactNode } from "react";
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
import { formatRelative, formatSize, type FileRecord, type TrackedFile } from "./lib/file";
import type { Group } from "./lib/group";
import type { Tag } from "./lib/tag";
import type { Tab } from "./lib/tab";
import { FILE_DRAG_MIME, setDragPreview } from "./lib/dnd";
import { fileNameFromPath, type Operation } from "./lib/operation";
import { checkForUpdate, type UpdateInfo } from "./lib/update";
import { useI18n } from "./i18n/context";
import type { Locale, TranslationKey } from "./i18n/locales";
import { useTheme } from "./theme/context";
import type { ThemeMode } from "./theme/context";
import { InboxGallery } from "./InboxGallery";
import { Sidebar } from "./Sidebar";
import { Modal } from "./Modal";
import { TagCombobox } from "./TagCombobox";
import { Onboarding } from "./Onboarding";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import {
  CloseIcon,
  GalleryViewIcon,
  GroupsIcon,
  HistoryIcon,
  InboxIcon,
  ListViewIcon,
  MaximizeIcon,
  MinimizeIcon,
  RestoreIcon,
  SidebarToggleIcon,
  TagIcon,
  TemporaryIcon,
} from "./icons";

const SIDEBAR_COLLAPSED_KEY = "assetpile:sidebar-collapsed";
const ONBOARDING_DISMISSED_KEY = "onboarding_dismissed";

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
        <span className="topbar-title">{tabLabel(tab, t)}</span>
        <WindowControls />
      </div>

      <div className="shell">
        <Sidebar
          collapsed={sidebarCollapsed}
          tab={tab}
          onTabChange={setTab}
          readyFilesCount={readyFiles.length}
          activeTagId={activeTagId}
          onTagSelect={setActiveTagId}
          selectedGroupId={selectedGroupId}
          onSelectGroup={setSelectedGroupId}
          onFileDropOnGroup={(fileId, groupId) => void fileToGroup(fileId, groupId)}
          onFileDropOnTag={(fileId, tagName) => void fileToTag(fileId, tagName)}
        />

        <main className="content">
          {tab === "inbox" && (
            <InboxPanel
              files={readyFiles}
              onUndo={(id) => void undoOperation(id)}
              onReorder={reorderFiles}
              activeTagId={activeTagId}
              onClearTagFilter={() => setActiveTagId(null)}
            />
          )}
          {tab === "groups" && (
            <GroupsPanel selectedGroupId={selectedGroupId} onSelectGroup={setSelectedGroupId} />
          )}
          {tab === "tags" && <TagsPanel />}
          {tab === "temporary" && <TemporaryPanel />}
          {tab === "history" && <HistoryPanel />}
          {tab === "settings" && <SettingsPanel onOpenOnboarding={() => setOnboardingOpen(true)} />}
        </main>
      </div>

      {onboardingOpen && <Onboarding onClose={closeOnboarding} />}
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
}: {
  files: TrackedFile[];
  onUndo: (operationId: string) => void;
  onReorder: (fromId: string, toId: string) => void;
  activeTagId: string | null;
  onClearTagFilter: () => void;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<"gallery" | "list">("gallery");
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagsByFile, setTagsByFile] = useState<Record<string, Tag[]>>({});
  const [groups, setGroups] = useState<Group[]>([]);
  const [contextMenu, setContextMenu] = useState<{
    file: TrackedFile;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (!activeTagId) return;
    invoke<Tag[]>("list_tags")
      .then(setTags)
      .catch(() => {});
    invoke<Record<string, Tag[]>>("list_all_file_tags")
      .then(setTagsByFile)
      .catch(() => {});
  }, [activeTagId, files]);

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

  const visibleFiles = activeTagId
    ? files.filter((f) => (tagsByFile[f.id] ?? []).some((tag) => tag.id === activeTagId))
    : files;
  const activeTagName = tags.find((tag) => tag.id === activeTagId)?.name ?? "";

  function openContextMenu(file: TrackedFile, x: number, y: number) {
    setContextMenu({ file, x, y });
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

  async function recycleViaMenu(file: TrackedFile) {
    if (!window.confirm(t("temporary.recycleBinConfirm", { name: file.current_name }))) return;
    try {
      await invoke("move_to_recycle_bin", { fileId: file.id });
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
      onSelect: () => void recycleViaMenu(file),
    });
    return items;
  }

  return (
    <>
      <header className="panel-header">
        <div className="panel-header-row">
          <div>
            <h1>{t("inbox.title")}</h1>
            <p>{t("inbox.description")}</p>
          </div>
          {files.length > 0 && (
            <div className="view-toggle">
              <button
                className={view === "gallery" ? "active" : ""}
                onClick={() => setView("gallery")}
              >
                <GalleryViewIcon width={14} height={14} /> {t("inbox.viewGallery")}
              </button>
              <button className={view === "list" ? "active" : ""} onClick={() => setView("list")}>
                <ListViewIcon width={14} height={14} /> {t("inbox.viewList")}
              </button>
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

      {visibleFiles.length === 0 ? (
        <EmptyState
          icon={<InboxIcon width={28} height={28} />}
          text={activeTagId ? t("inbox.emptyFiltered") : t("inbox.empty")}
        />
      ) : view === "gallery" ? (
        <InboxGallery
          files={visibleFiles}
          onUndo={onUndo}
          onReorder={onReorder}
          onContextMenu={openContextMenu}
        />
      ) : (
        <ul className="file-list">
          {visibleFiles.map((file) => (
            <li
              key={file.id}
              className="file-row"
              draggable
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

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={menuItemsFor(contextMenu.file)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
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
          <button className="btn-primary" onClick={() => setShowCreate(true)}>
            {t("groups.create")}
          </button>
        </div>
      </header>
      {error && <p className="form-error">{error}</p>}

      {groups.length === 0 ? (
        <EmptyState icon={<GroupsIcon width={28} height={28} />} text={t("groups.empty")} />
      ) : (
        <ul className="group-list">
          {groups.map((group) => (
            <li
              key={group.id}
              className="group-card"
              role="button"
              tabIndex={0}
              onClick={() => onSelectGroup(group.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSelectGroup(group.id);
              }}
            >
              <GroupsIcon width={18} height={18} />
              <div>
                <div className="group-name">{group.name}</div>
                <div className="group-path">{group.destination_path}</div>
              </div>
              <button
                className="btn-link btn-link-danger"
                disabled={deletingId === group.id}
                onClick={(e) => {
                  e.stopPropagation();
                  void deleteGroup(group.id, group.name);
                }}
              >
                {t("groups.delete")}
              </button>
            </li>
          ))}
        </ul>
      )}

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

function GroupCreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [destinationPath, setDestinationPath] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pickFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") setDestinationPath(selected);
  }

  async function createGroup(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !destinationPath.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await invoke("create_group", {
        name: name.trim(),
        destinationPath: destinationPath.trim(),
      });
      onCreated();
    } catch (err) {
      setError(String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal title={t("groups.create")} onClose={onClose}>
      <form onSubmit={(e) => void createGroup(e)} className="group-form">
        <input
          className="group-form-name"
          placeholder={t("groups.namePlaceholder")}
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
        <div className="group-form-path">
          <input
            placeholder={t("groups.pathPlaceholder")}
            value={destinationPath}
            onChange={(e) => setDestinationPath(e.target.value)}
          />
          <button type="button" className="btn-secondary" onClick={() => void pickFolder()}>
            {t("groups.browse")}
          </button>
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn-primary" disabled={creating}>
            {creating ? t("groups.creating") : t("groups.create")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function GroupFilesPanel({
  group,
  deleting,
  onDelete,
}: {
  group: Group;
  deleting: boolean;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tagsByFile, setTagsByFile] = useState<Record<string, Tag[]>>({});
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [showScan, setShowScan] = useState(false);

  function refreshFiles() {
    setLoading(true);
    invoke<FileRecord[]>("list_group_files", { groupId: group.id })
      .then(setFiles)
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
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

  return (
    <>
      <header className="panel-header">
        <div className="panel-header-row">
          <div>
            <h1>{group.name}</h1>
            <p title={group.destination_path ?? undefined}>{group.destination_path}</p>
          </div>
          <div className="panel-header-actions">
            <button className="btn-secondary" onClick={() => setShowScan(true)}>
              {t("groups.scan")}
            </button>
            <button className="btn-link btn-link-danger" disabled={deleting} onClick={onDelete}>
              {t("groups.delete")}
            </button>
          </div>
        </div>
      </header>
      {error && <p className="form-error">{error}</p>}

      {!loading && files.length === 0 ? (
        <EmptyState icon={<GroupsIcon width={28} height={28} />} text={t("groups.filesEmpty")} />
      ) : (
        <ul className="file-list">
          {files.map((file) => (
            <li key={file.id} className="file-row file-row-tagged">
              <div className="file-row-main">
                <span className="file-name" title={file.current_name}>
                  {file.current_name}
                </span>
                <span className="file-size">{formatSize(file.size_bytes)}</span>
                <span className={`status-badge status-badge-${file.status}`}>
                  {t(`status.${file.status}` as TranslationKey)}
                </span>
              </div>
              <FileTagEditor
                fileId={file.id}
                tags={tagsByFile[file.id] ?? []}
                allTags={allTags}
                onAddTag={addTag}
                onRemoveTag={removeTag}
              />
            </li>
          ))}
        </ul>
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
          options={allTags.filter((candidate) => !tags.some((existing) => existing.id === candidate.id))}
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

interface ImportableFile {
  name: string;
  path: string;
  size_bytes: number | null;
}

function GroupScanModal({
  group,
  onClose,
  onImported,
}: {
  group: Group;
  onClose: () => void;
  onImported: () => void;
}) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<ImportableFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tagsInput, setTagsInput] = useState("");
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    invoke<ImportableFile[]>("scan_group_folder", { groupId: group.id })
      .then((found) => {
        setCandidates(found);
        setSelected(new Set(found.map((f) => f.path)));
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [group.id]);

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === candidates.length ? new Set() : new Set(candidates.map((f) => f.path)),
    );
  }

  async function runImport() {
    const paths = candidates.map((f) => f.path).filter((path) => selected.has(path));
    if (paths.length === 0) return;
    setImporting(true);
    setError(null);
    try {
      const tagNames = tagsInput
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      await invoke("import_group_files", { groupId: group.id, paths, tagNames });
      onImported();
    } catch (err) {
      setError(String(err));
    } finally {
      setImporting(false);
    }
  }

  return (
    <Modal title={t("groups.scanTitle", { name: group.name })} onClose={onClose}>
      <div className="group-scan">
        <p className="group-scan-description">{t("groups.scanDescription")}</p>
        {error && <p className="form-error">{error}</p>}

        {loading ? (
          <p className="group-scan-status">{t("groups.scanning")}</p>
        ) : candidates.length === 0 ? (
          <p className="group-scan-status">{t("groups.scanEmpty")}</p>
        ) : (
          <>
            <button type="button" className="btn-link" onClick={toggleAll}>
              {t("groups.scanSelectAll")}
            </button>
            <ul className="group-scan-list">
              {candidates.map((file) => (
                <li key={file.path} className="group-scan-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(file.path)}
                      onChange={() => toggle(file.path)}
                    />
                    <span className="file-name" title={file.name}>
                      {file.name}
                    </span>
                    <span className="file-size">{formatSize(file.size_bytes)}</span>
                  </label>
                </li>
              ))}
            </ul>
            <input
              className="group-scan-tags"
              placeholder={t("groups.scanTagsPlaceholder")}
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
            />
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={importing || selected.size === 0}
            onClick={() => void runImport()}
          >
            {importing ? t("groups.importing") : t("groups.import")}
          </button>
        </div>
      </div>
    </Modal>
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

function TemporaryPanel() {
  const { t } = useI18n();
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  async function moveToRecycleBin(fileId: string, name: string) {
    if (!window.confirm(t("temporary.recycleBinConfirm", { name }))) return;
    setBusyId(fileId);
    try {
      await invoke("move_to_recycle_bin", { fileId });
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
                  onClick={() => void moveToRecycleBin(file.id, file.current_name)}
                >
                  {t("temporary.recycleBin")}
                </button>
              </div>
            </li>
          ))}
        </ul>
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
        <ul className="file-list">
          {operations.map((op) => {
            const canUndo =
              op.operation_type === "move" && op.status === "completed" && !op.undone_at;
            return (
              <li key={op.id} className="file-row">
                <span
                  className="file-name"
                  title={op.destination_path ?? op.source_path ?? undefined}
                >
                  {fileNameFromPath(op.destination_path ?? op.source_path)}
                </span>
                <span className="file-meta">
                  {t(`operation.${op.operation_type}` as TranslationKey)}
                </span>
                <span className={`status-badge status-badge-${op.status}`}>
                  {op.undone_at
                    ? t("operation.undone")
                    : t(`operation.${op.status}` as TranslationKey)}
                </span>
                <span className="file-meta">{formatRelative(op.created_at)}</span>
                {canUndo && (
                  <button
                    className="btn-link"
                    disabled={busyId === op.id}
                    onClick={() => void undo(op.id)}
                  >
                    {t("history.undo")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
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

  return (
    <>
      <header className="panel-header">
        <h1>{t("settings.title")}</h1>
        <p>{t("settings.description")}</p>
      </header>

      <div className="settings-field">
        <label className="settings-label">{t("settings.language")}</label>
        <select value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
          <option value="zh">{t("settings.languageZh")}</option>
          <option value="en">{t("settings.languageEn")}</option>
        </select>
      </div>

      <div className="settings-field">
        <label className="settings-label">{t("settings.theme")}</label>
        <select value={mode} onChange={(e) => setMode(e.target.value as ThemeMode)}>
          <option value="system">{t("settings.themeSystem")}</option>
          <option value="light">{t("settings.themeLight")}</option>
          <option value="dark">{t("settings.themeDark")}</option>
        </select>
      </div>

      <div className="settings-field settings-field-wide">
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
        {autostartError && <p className="form-error">{autostartError}</p>}
        <div className="update-status">
          {updateCheck.status === "checking" && <span>{t("settings.checkingForUpdates")}</span>}
          {updateCheck.status === "upToDate" && <span>{t("settings.upToDate")}</span>}
          {updateCheck.status === "error" && <span>{t("settings.updateCheckFailed")}</span>}
          {updateCheck.status === "available" && (
            <>
              <span className="update-status-available">
                {t("settings.updateAvailable", { version: updateCheck.info.version })}
              </span>
              <button className="btn-link" onClick={() => void viewUpdate(updateCheck.info.url)}>
                {t("settings.viewUpdate")}
              </button>
            </>
          )}
          {updateCheck.status !== "checking" && (
            <button className="btn-link" onClick={() => void runUpdateCheck()}>
              {t("settings.checkForUpdates")}
            </button>
          )}
        </div>
      </div>

      <div className="settings-field settings-field-wide">
        <label className="settings-label">{t("settings.watchedFolders")}</label>
        <p className="settings-hint">{t("settings.watchedFoldersHint")}</p>
        {folderError && <p className="form-error">{folderError}</p>}
        {folders.length === 0 ? (
          <p className="settings-hint">{t("settings.noWatchedFolders")}</p>
        ) : (
          <ul className="folder-list">
            {folders.map((path) => (
              <li key={path} className="folder-row">
                <span className="folder-path" title={path}>
                  {path}
                </span>
                <button
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
        <button className="btn-secondary" disabled={folderBusy} onClick={() => void addFolder()}>
          {t("settings.addFolder")}
        </button>
      </div>

      <div className="settings-field">
        <button className="btn-secondary" onClick={onOpenOnboarding}>
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
