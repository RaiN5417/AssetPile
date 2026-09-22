import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { Group } from "./lib/group";
import type { Tag } from "./lib/tag";
import type { Tab } from "./lib/tab";
import { FILE_DRAG_MIME } from "./lib/dnd";
import { Modal } from "./Modal";
import { useI18n } from "./i18n/context";
import {
  GroupsIcon,
  HistoryIcon,
  InboxIcon,
  PlusIcon,
  SettingsIcon,
  TagIcon,
  TemporaryIcon,
} from "./icons";

function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

// A macOS Finder-style sidebar: "Locations" (Inbox/Temporary), Groups shown
// as drop-target folders you can drag Inbox cards onto to file them, and
// Tags as a click-to-filter list — mirrors Finder's Favorites/Tags split.
// History and Settings are utility destinations, not content locations, so
// they're pinned near the bottom instead of mixed into "Locations". The
// section title itself (not a duplicate nav row) is the way into each
// section's management view — Groups.title/Tags.title being both a heading
// and the "see everything" affordance.
export function Sidebar({
  collapsed,
  tab,
  onTabChange,
  readyFilesCount,
  activeTagId,
  onTagSelect,
  selectedGroupId,
  onSelectGroup,
  onFileDropOnGroup,
  onFileDropOnTag,
}: {
  collapsed: boolean;
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  readyFilesCount: number;
  activeTagId: string | null;
  onTagSelect: (tagId: string | null) => void;
  selectedGroupId: string | null;
  onSelectGroup: (groupId: string | null) => void;
  onFileDropOnGroup: (fileId: string, groupId: string) => void;
  onFileDropOnTag: (fileId: string, tagName: string) => void;
}) {
  const { t } = useI18n();
  const [groups, setGroups] = useState<Group[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const [dragOverTag, setDragOverTag] = useState<string | null>(null);
  const [addingGroup, setAddingGroup] = useState(false);
  const [showTagModal, setShowTagModal] = useState(false);

  function refreshGroups() {
    invoke<Group[]>("list_groups")
      .then(setGroups)
      .catch(() => setGroups([]));
  }

  function refreshTags() {
    invoke<Tag[]>("list_tags")
      .then(setTags)
      .catch(() => setTags([]));
  }

  useEffect(() => {
    refreshGroups();
    refreshTags();

    const unlistenGroups = listen("groups-changed", refreshGroups);
    const unlistenTags = listen("tags-changed", refreshTags);
    return () => {
      unlistenGroups.then((fn) => fn());
      unlistenTags.then((fn) => fn());
    };
  }, []);

  // Cheap local queries — refetch on every tab switch too, in case a group
  // or tag was created without the event round trip (e.g. before mount).
  useEffect(() => {
    refreshGroups();
    refreshTags();
  }, [tab]);

  async function addGroupFromFolder() {
    if (addingGroup) return;
    setAddingGroup(true);
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected !== "string") return;
      await invoke("create_group", { name: folderName(selected), destinationPath: selected });
      refreshGroups();
      void emit("groups-changed");
    } catch (err) {
      window.alert(String(err));
    } finally {
      setAddingGroup(false);
    }
  }

  async function createTag(name: string) {
    await invoke("create_tag", { tagName: name });
    refreshTags();
    void emit("tags-changed");
  }

  const locationItems: { tab: Tab; icon: ReactNode; label: string; badge?: number }[] = [
    { tab: "inbox", icon: <InboxIcon />, label: t("nav.inbox"), badge: readyFilesCount },
    { tab: "temporary", icon: <TemporaryIcon />, label: t("nav.temporary") },
  ];

  return (
    <nav className={`sidebar ${collapsed ? "sidebar-collapsed" : ""}`}>
      <div className="sidebar-inner">
        <div className="sidebar-section">
          <div className="sidebar-section-title">{t("sidebar.locations")}</div>
          {locationItems.map((item) => (
            <button
              key={item.tab}
              className={`nav-item ${tab === item.tab ? "active" : ""}`}
              onClick={() => onTabChange(item.tab)}
            >
              {item.icon} {item.label}
              {!!item.badge && <span className="nav-badge">{item.badge}</span>}
            </button>
          ))}
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-title">
            <button
              className={`sidebar-section-title-label ${tab === "groups" && !selectedGroupId ? "active" : ""}`}
              onClick={() => {
                onSelectGroup(null);
                onTabChange("groups");
              }}
            >
              {t("groups.title")}
            </button>
            <button
              className="sidebar-section-action"
              disabled={addingGroup}
              title={t("sidebar.addGroup")}
              onClick={() => void addGroupFromFolder()}
            >
              <PlusIcon width={12} height={12} />
            </button>
          </div>
          {groups.map((group) => (
            <button
              key={group.id}
              className={`nav-item sidebar-folder ${dragOverGroup === group.id ? "drag-over" : ""} ${
                tab === "groups" && selectedGroupId === group.id ? "active" : ""
              }`}
              title={t("inbox.dropToGroup")}
              onClick={() => {
                onSelectGroup(group.id);
                onTabChange("groups");
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverGroup(group.id);
              }}
              onDragLeave={() => setDragOverGroup((cur) => (cur === group.id ? null : cur))}
              onDrop={(e) => {
                e.preventDefault();
                setDragOverGroup(null);
                const fileId = e.dataTransfer.getData(FILE_DRAG_MIME);
                if (fileId) onFileDropOnGroup(fileId, group.id);
              }}
            >
              <GroupsIcon width={14} height={14} />
              <span className="sidebar-item-label">{group.name}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-title">
            <button
              className={`sidebar-section-title-label ${tab === "tags" ? "active" : ""}`}
              onClick={() => onTabChange("tags")}
            >
              {t("sidebar.tags")}
            </button>
            <button
              className="sidebar-section-action"
              title={t("sidebar.addTag")}
              onClick={() => setShowTagModal(true)}
            >
              <PlusIcon width={12} height={12} />
            </button>
          </div>
          {tags.length === 0 ? (
            <div className="sidebar-empty-hint">{t("sidebar.noTags")}</div>
          ) : (
            tags.map((tag) => (
              <button
                key={tag.id}
                className={`nav-item sidebar-folder ${dragOverTag === tag.id ? "drag-over" : ""} ${
                  activeTagId === tag.id ? "active" : ""
                }`}
                title={t("sidebar.dropToTag")}
                onClick={() => {
                  onTagSelect(activeTagId === tag.id ? null : tag.id);
                  onTabChange("inbox");
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverTag(tag.id);
                }}
                onDragLeave={() => setDragOverTag((cur) => (cur === tag.id ? null : cur))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverTag(null);
                  const fileId = e.dataTransfer.getData(FILE_DRAG_MIME);
                  if (fileId) onFileDropOnTag(fileId, tag.name);
                }}
              >
                <TagIcon width={14} height={14} />
                <span className="sidebar-item-label">{tag.name}</span>
              </button>
            ))
          )}
        </div>

        <div className="sidebar-spacer" />

        <div className="sidebar-section sidebar-section-bottom">
          <button
            className={`nav-item ${tab === "history" ? "active" : ""}`}
            onClick={() => onTabChange("history")}
          >
            <HistoryIcon /> {t("nav.history")}
          </button>
          <button
            className={`nav-item ${tab === "settings" ? "active" : ""}`}
            onClick={() => onTabChange("settings")}
          >
            <SettingsIcon /> {t("nav.settings")}
          </button>
        </div>
      </div>

      {showTagModal && (
        <TagCreateModal
          onClose={() => setShowTagModal(false)}
          onCreate={createTag}
        />
      )}
    </nav>
  );
}

function TagCreateModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    setError(null);
    try {
      await onCreate(trimmed);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal title={t("sidebar.createTag")} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="group-form">
        <input
          className="group-form-name"
          placeholder={t("sidebar.newTagPlaceholder")}
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn-primary" disabled={creating}>
            {creating ? t("sidebar.creatingTag") : t("sidebar.createTag")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
