import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { Group } from "./lib/group";
import type { Tag } from "./lib/tag";
import type { Tab } from "./lib/tab";
import { FILE_DRAG_MIME } from "./lib/dnd";
import { Modal } from "./Modal";
import { GroupCreateModal } from "./GroupCreateModal";
import { GroupScanModal } from "./GroupScanModal";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
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
  mobileOpen,
  onCloseMobile,
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
  mobileOpen: boolean;
  onCloseMobile: () => void;
}) {
  const { t } = useI18n();
  const [groups, setGroups] = useState<Group[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const [dragOverTag, setDragOverTag] = useState<string | null>(null);
  const [showGroupCreate, setShowGroupCreate] = useState(false);
  const [showTagCreate, setShowTagCreate] = useState(false);
  const [scanningGroup, setScanningGroup] = useState<Group | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);

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

  function groupCreated() {
    setShowGroupCreate(false);
    refreshGroups();
    void emit("groups-changed");
  }

  function tagCreated() {
    setShowTagCreate(false);
    refreshTags();
    void emit("tags-changed");
  }

  async function changeGroupFolder(group: Group) {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected !== "string") return;
      await invoke("update_group_destination", { groupId: group.id, destinationPath: selected });
      refreshGroups();
      void emit("groups-changed");
    } catch (err) {
      window.alert(String(err));
    }
  }

  async function deleteGroup(group: Group) {
    if (!window.confirm(t("groups.deleteConfirm", { name: group.name }))) return;
    try {
      await invoke("delete_group", { groupId: group.id });
      if (selectedGroupId === group.id) onSelectGroup(null);
      refreshGroups();
      void emit("groups-changed");
    } catch (err) {
      window.alert(String(err));
    }
  }

  async function deleteTag(tag: Tag) {
    if (!window.confirm(t("tags.deleteConfirm", { name: tag.name }))) return;
    try {
      await invoke("delete_tag", { tagId: tag.id });
      if (activeTagId === tag.id) onTagSelect(null);
      refreshTags();
      void emit("tags-changed");
    } catch (err) {
      window.alert(String(err));
    }
  }

  function handleGroupContextMenu(group: Group, x: number, y: number) {
    setContextMenu({
      x,
      y,
      items: [
        {
          label: t("sidebar.groupMenu.view"),
          onSelect: () => {
            onSelectGroup(group.id);
            onTabChange("groups");
          },
        },
        {
          label: t("sidebar.groupMenu.scan"),
          onSelect: () => {
            setScanningGroup(group);
          },
        },
        {
          label: t("sidebar.groupMenu.changeFolder"),
          onSelect: () => {
            void changeGroupFolder(group);
          },
        },
        {
          label: t("sidebar.groupMenu.delete"),
          danger: true,
          onSelect: () => {
            void deleteGroup(group);
          },
        },
      ],
    });
  }

  function handleTagContextMenu(tag: Tag, x: number, y: number) {
    setContextMenu({
      x,
      y,
      items: [
        {
          label: t("sidebar.tagMenu.filter"),
          onSelect: () => {
            onTagSelect(activeTagId === tag.id ? null : tag.id);
            onTabChange("inbox");
          },
        },
        {
          label: t("sidebar.tagMenu.delete"),
          danger: true,
          onSelect: () => {
            void deleteTag(tag);
          },
        },
      ],
    });
  }

  const locationItems: { tab: Tab; icon: ReactNode; label: string; badge?: number }[] = [
    { tab: "inbox", icon: <InboxIcon />, label: t("nav.inbox"), badge: readyFilesCount },
    { tab: "temporary", icon: <TemporaryIcon />, label: t("nav.temporary") },
  ];

  return (
    <>
      {mobileOpen && <div className="sidebar-mobile-backdrop" onClick={onCloseMobile} />}
      <nav
        className={`sidebar ${collapsed ? "sidebar-collapsed" : ""} ${mobileOpen ? "sidebar-mobile-open" : ""}`}
      >
        <div className="sidebar-inner">
          <div className="sidebar-section">
            <div className="sidebar-section-title">{t("sidebar.locations")}</div>
            {locationItems.map((item) => (
              <button
                key={item.tab}
                className={`nav-item ${tab === item.tab ? "active" : ""}`}
                onClick={() => onTabChange(item.tab)}
              >
                {item.icon} <span className="sidebar-item-label">{item.label}</span>
                {!!item.badge && <span className="nav-badge">{item.badge}</span>}
              </button>
            ))}
          </div>

          <div className="sidebar-section sidebar-section-groups">
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
                title={t("sidebar.addGroup")}
                onClick={() => setShowGroupCreate(true)}
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
                onContextMenu={(e) => {
                  e.preventDefault();
                  handleGroupContextMenu(group, e.clientX, e.clientY);
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

          <div className="sidebar-section sidebar-section-tags">
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
                onClick={() => setShowTagCreate(true)}
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
                  onContextMenu={(e) => {
                    e.preventDefault();
                    handleTagContextMenu(tag, e.clientX, e.clientY);
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
              <HistoryIcon /> <span className="sidebar-item-label">{t("nav.history")}</span>
            </button>
            <button
              className={`nav-item ${tab === "settings" ? "active" : ""}`}
              onClick={() => onTabChange("settings")}
            >
              <SettingsIcon /> <span className="sidebar-item-label">{t("nav.settings")}</span>
            </button>
          </div>
        </div>

        {showGroupCreate && (
          <GroupCreateModal onClose={() => setShowGroupCreate(false)} onCreated={groupCreated} />
        )}

        {showTagCreate && (
          <TagCreateModal onClose={() => setShowTagCreate(false)} onCreated={tagCreated} />
        )}

        {scanningGroup && (
          <GroupScanModal
            group={scanningGroup}
            onClose={() => setScanningGroup(null)}
            onImported={() => {
              setScanningGroup(null);
              refreshGroups();
              void emit("groups-changed");
            }}
          />
        )}

        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={contextMenu.items}
            onClose={() => setContextMenu(null)}
          />
        )}
      </nav>
    </>
  );
}

function TagCreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateName, setDuplicateName] = useState<string | null>(null);

  async function createTag(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    setDuplicateName(null);
    try {
      await invoke("create_tag", { tagName: name.trim() });
      onCreated();
    } catch (err) {
      if (err === "duplicate_name") {
        setDuplicateName(name.trim());
      } else {
        setError(String(err));
      }
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal title={t("tags.create")} onClose={onClose}>
      <form onSubmit={(e) => void createTag(e)} className="group-form">
        <input
          className={`group-form-name ${duplicateName ? "input-error" : ""}`}
          placeholder={t("tags.namePlaceholder")}
          value={name}
          autoFocus
          onChange={(e) => {
            setName(e.target.value);
            setDuplicateName(null);
          }}
        />
        {duplicateName && (
          <p className="form-error">{t("tags.duplicateNameError", { name: duplicateName })}</p>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn-primary" disabled={creating}>
            {creating ? t("tags.creating") : t("tags.create")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
