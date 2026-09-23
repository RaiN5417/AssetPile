import { useEffect, useState, useRef } from "react";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { formatSize, isImageFile, type TrackedFile } from "./lib/file";
import type { Tag } from "./lib/tag";
import type { Group } from "./lib/group";
import { TagCombobox } from "./TagCombobox";
import { useI18n } from "./i18n/context";
import type { TranslationKey } from "./i18n/locales";
import { CloseIcon, GenericFileIcon, TagIcon } from "./icons";

export interface DetailsDrawerProps {
  file: TrackedFile;
  onClose: () => void;
  tags: Tag[];
  allTags: Tag[];
  groups: Group[];
  thumbnail?: string;
  onRename: (fileId: string, newName: string) => Promise<void>;
  onAddTag: (fileId: string, tagName: string) => Promise<void>;
  onRemoveTag: (fileId: string, tagId: string) => Promise<void>;
  onAssignGroup?: (fileId: string, groupId: string) => Promise<void>;
  onRecycle?: (file: TrackedFile) => void;
  onUndo?: (operationId: string) => void;
}

export function DetailsDrawer({
  file,
  onClose,
  tags,
  allTags,
  groups,
  thumbnail,
  onRename,
  onAddTag,
  onRemoveTag,
  onAssignGroup,
  onRecycle,
  onUndo,
}: DetailsDrawerProps) {
  const { t } = useI18n();
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(file.current_name);
  const [addingTag, setAddingTag] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [zoom, setZoom] = useState(1);
  const [notes, setNotes] = useState(() => {
    try {
      return window.localStorage.getItem(`assetpile_notes_${file.id}`) ?? "";
    } catch {
      return "";
    }
  });
  const [sourceUrl, setSourceUrl] = useState(() => {
    try {
      return window.localStorage.getItem(`assetpile_url_${file.id}`) ?? "";
    } catch {
      return "";
    }
  });
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setNameDraft(file.current_name);
    setEditingName(false);
    setAddingTag(false);
    setZoom(1);
    try {
      setNotes(window.localStorage.getItem(`assetpile_notes_${file.id}`) ?? "");
      setSourceUrl(window.localStorage.getItem(`assetpile_url_${file.id}`) ?? "");
    } catch {
      setNotes("");
      setSourceUrl("");
    }
  }, [file.id, file.current_name]);

  function handleNotesChange(val: string) {
    setNotes(val);
    try {
      window.localStorage.setItem(`assetpile_notes_${file.id}`, val);
    } catch {
      // Local storage disabled or full
    }
  }

  function handleSourceUrlChange(val: string) {
    setSourceUrl(val);
    try {
      window.localStorage.setItem(`assetpile_url_${file.id}`, val);
    } catch {
      // Local storage disabled or full
    }
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function commitRename() {
    const trimmed = nameDraft.trim();
    setEditingName(false);
    if (!trimmed || trimmed === file.current_name) {
      setNameDraft(file.current_name);
      return;
    }
    try {
      await onRename(file.id, trimmed);
    } catch (err) {
      window.alert(String(err));
      setNameDraft(file.current_name);
    }
  }

  async function commitTag(nameOverride?: string) {
    const trimmed = (nameOverride ?? tagDraft).trim();
    setAddingTag(false);
    setTagDraft("");
    if (!trimmed) return;
    try {
      await onAddTag(file.id, trimmed);
    } catch (err) {
      window.alert(String(err));
    }
  }

  async function openContainingFolder() {
    try {
      const folder = file.current_path.replace(/[/\\][^/\\]+$/, "");
      await openUrl(folder);
    } catch (err) {
      window.alert(String(err));
    }
  }

  const ext = file.current_name.split(".").pop()?.toUpperCase() ?? "";
  const isImg = isImageFile(file.current_name);
  const assignedGroup = groups.find((g) => g.id === file.group_id) ?? null;

  return (
    <aside className="details-drawer" aria-label={t("details.title")}>
      <div className="details-drawer-header">
        <h2>{t("details.title")}</h2>
        <button className="details-drawer-close" onClick={onClose} aria-label={t("common.close")}>
          <CloseIcon width={14} height={14} />
        </button>
      </div>

      <div className="details-drawer-scroll">
        {/* Preview section */}
        <div className="details-preview-container">
          {isImg && thumbnail ? (
            <div className="details-preview-img-wrap">
              <img
                src={thumbnail}
                alt={file.current_name}
                style={{ transform: `scale(${zoom})` }}
                className="details-preview-img"
              />
            </div>
          ) : (
            <div className="details-preview-generic">
              <GenericFileIcon width={48} height={48} />
              <span className="details-generic-ext">{ext}</span>
            </div>
          )}

          {isImg && thumbnail && (
            <div className="details-preview-toolbar">
              <button
                type="button"
                className="details-zoom-btn"
                onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
                title="缩小"
              >
                −
              </button>
              <button
                type="button"
                className="details-zoom-level"
                onClick={() => setZoom(1)}
                title="重置缩放"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                className="details-zoom-btn"
                onClick={() => setZoom((z) => Math.min(3, Number((z + 0.25).toFixed(2))))}
                title="放大"
              >
                +
              </button>
            </div>
          )}
        </div>

        {/* Title & Quick Meta */}
        <div className="details-title-row">
          {editingName ? (
            <input
              ref={nameInputRef}
              className="details-name-input"
              value={nameDraft}
              autoFocus
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitRename();
                if (e.key === "Escape") {
                  setNameDraft(file.current_name);
                  setEditingName(false);
                }
              }}
            />
          ) : (
            <button
              className="details-name-btn"
              title={t("inbox.rename")}
              onClick={() => setEditingName(true)}
            >
              {file.current_name}
            </button>
          )}
          <div className="details-submeta">
            <span>{formatSize(file.size_bytes)}</span>
            {ext && <span className="details-ext-badge">{ext}</span>}
            <span className={`status-badge status-badge-${file.status}`}>
              {t(`status.${file.status}` as TranslationKey)}
            </span>
          </div>
        </div>

        {/* Notes Section (备注) */}
        <div className="details-section">
          <div className="details-section-label">{t("details.notes")}</div>
          <textarea
            className="details-textarea"
            placeholder={t("details.notesPlaceholder")}
            rows={3}
            value={notes}
            onChange={(e) => handleNotesChange(e.target.value)}
          />
        </div>

        {/* Source Link Section (来源链接) */}
        <div className="details-section">
          <div className="details-section-label">{t("details.sourceUrl")}</div>
          <input
            type="text"
            className="details-input"
            placeholder={t("details.sourceUrlPlaceholder")}
            value={sourceUrl}
            onChange={(e) => handleSourceUrlChange(e.target.value)}
          />
        </div>

        <hr className="details-divider" />

        {/* Tags Section */}
        <div className="details-section">
          <div className="details-section-label">{t("details.tags")}</div>
          <div className="details-tags-wrap">
            {tags.map((tag) => (
              <span key={tag.id} className="gallery-tag-chip">
                {tag.name}
                <button
                  type="button"
                  className="gallery-tag-remove"
                  aria-label={t("common.close")}
                  onClick={() => void onRemoveTag(file.id, tag.id)}
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
              <button type="button" className="gallery-tag-add" onClick={() => setAddingTag(true)}>
                <TagIcon width={11} height={11} /> {t("inbox.addTag")}
              </button>
            )}
          </div>
        </div>

        {/* Group Section */}
        {groups.length > 0 && onAssignGroup && (
          <div className="details-section">
            <div className="details-section-label">{t("details.group")}</div>
            <div className="details-group-selector">
              {assignedGroup ? (
                <span className="details-group-badge">{assignedGroup.name}</span>
              ) : (
                <span className="details-no-group">{t("details.noGroup")}</span>
              )}
              <select
                className="details-group-select"
                value={file.group_id ?? ""}
                onChange={(e) => {
                  if (e.target.value) {
                    void onAssignGroup(file.id, e.target.value);
                  }
                }}
              >
                <option value="" disabled>
                  {assignedGroup ? "更换分组…" : "归档到分组…"}
                </option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        <hr className="details-divider" />

        {/* File Metadata Table */}
        <div className="details-section">
          <div className="details-section-label">{t("details.fileInfo")}</div>
          <table className="details-meta-table">
            <tbody>
              <tr>
                <th>{t("details.fileName")}</th>
                <td title={file.current_name}>{file.current_name}</td>
              </tr>
              <tr>
                <th>{t("details.fileType")}</th>
                <td>{ext || "文件"}</td>
              </tr>
              <tr>
                <th>{t("details.fileSize")}</th>
                <td>
                  {formatSize(file.size_bytes)}
                  {file.size_bytes != null && ` (${file.size_bytes.toLocaleString()} 字节)`}
                </td>
              </tr>
              <tr>
                <th>{t("details.filePath")}</th>
                <td className="details-meta-path" title={file.current_path}>
                  {file.current_path}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Undo if organized */}
        {file.status === "organized" && file.operationId && onUndo && (
          <div className="details-section">
            <button
              type="button"
              className="btn-secondary details-undo-btn"
              onClick={() => onUndo(file.operationId!)}
            >
              {t("common.undo")}
            </button>
          </div>
        )}
      </div>

      {/* Footer Actions */}
      <div className="details-drawer-footer">
        <button
          type="button"
          className="btn-secondary details-action-btn"
          onClick={() => void openContainingFolder()}
        >
          {t("details.openLocation")}
        </button>
        {onRecycle && (
          <button
            type="button"
            className="btn-link btn-link-danger"
            onClick={() => onRecycle(file)}
          >
            {t("details.recycle")}
          </button>
        )}
      </div>
    </aside>
  );
}
