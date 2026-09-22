import { useEffect, useMemo, useRef, useState } from "react";
import Masonry from "react-masonry-css";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { formatSize, isImageFile, type TrackedFile } from "./lib/file";
import type { Tag } from "./lib/tag";
import { FILE_DRAG_MIME, setDragPreview } from "./lib/dnd";
import { TagCombobox } from "./TagCombobox";
import { useI18n } from "./i18n/context";
import type { TranslationKey } from "./i18n/locales";
import { CloseIcon, GenericFileIcon, TagIcon } from "./icons";

// Width tiers the masonry container's own width is checked against (react-
// masonry-css measures its wrapper, not the viewport). The widest tier
// (3000) is well past any realistic window width, so it always applies —
// it stands in for `default`.
const WIDTH_TIERS = [3000, 2200, 1850, 1500, 1150, 780, 480];

// Card-size slider (Inbox toolbar): rather than a fixed column count, each
// tier's column count is derived from container width / target card size,
// so dragging the slider changes how many columns fit at any window size
// instead of just resizing whatever columns happen to exist. The default
// (360px) reproduces the original fixed BREAKPOINTS below almost exactly,
// so nothing changes for anyone who never touches the slider.
function computeBreakpoints(cardSize: number): Record<string | number, number> {
  const cols = (width: number) => Math.max(1, Math.round(width / cardSize));
  const breakpoints: Record<string | number, number> = { default: cols(WIDTH_TIERS[0]) };
  for (const tier of WIDTH_TIERS.slice(1)) {
    breakpoints[tier] = cols(tier);
  }
  return breakpoints;
}

// Eagle-style masonry gallery for the Inbox: image thumbnails (base64 data
// URIs from the Rust `get_thumbnail` command, since Tauri's asset-protocol
// scope can't cover arbitrary runtime-chosen paths) or a generic icon for
// non-image files, inline rename, tag chips, and drag-to-reorder. Filing a
// card into a Group happens by dragging it onto a folder in the sidebar
// (see Sidebar.tsx) rather than a target inside the gallery itself.
export function InboxGallery({
  files,
  onUndo,
  onReorder,
  onContextMenu,
  cardSize,
}: {
  files: TrackedFile[];
  onUndo: (operationId: string) => void;
  onReorder: (fromId: string, toId: string) => void;
  onContextMenu: (file: TrackedFile, x: number, y: number) => void;
  cardSize: number;
}) {
  const breakpointCols = useMemo(() => computeBreakpoints(cardSize), [cardSize]);
  const [tagsByFile, setTagsByFile] = useState<Record<string, Tag[]>>({});
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});

  useEffect(() => {
    refreshTags();
    // The sidebar's "+" can create a tag with no file attached yet, and vice
    // versa — either side creating/removing a tag should refresh this list.
    const unlisten = listen("tags-changed", refreshTags);
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  function refreshTags() {
    invoke<Record<string, Tag[]>>("list_all_file_tags")
      .then(setTagsByFile)
      .catch(() => {});
    invoke<Tag[]>("list_tags")
      .then(setAllTags)
      .catch(() => {});
  }

  useEffect(() => {
    for (const file of files) {
      if (thumbnails[file.id] || !isImageFile(file.current_name)) continue;
      invoke<string>("get_thumbnail", { path: file.current_path })
        .then((dataUri) => setThumbnails((prev) => ({ ...prev, [file.id]: dataUri })))
        .catch(() => {});
    }
    // Only re-scan when the file set itself changes, not on every thumbnail arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  async function renameFile(fileId: string, newName: string) {
    await invoke("rename_file", { fileId, newName });
  }

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
    <div className="inbox-gallery-wrap">
      <Masonry
        breakpointCols={breakpointCols}
        className="gallery-masonry"
        columnClassName="gallery-masonry-column"
      >
        {files.map((file) => (
          <GalleryCard
            key={file.id}
            file={file}
            thumbnail={thumbnails[file.id]}
            tags={tagsByFile[file.id] ?? []}
            allTags={allTags}
            onUndo={onUndo}
            onReorder={onReorder}
            onRename={renameFile}
            onAddTag={addTag}
            onRemoveTag={removeTag}
            onContextMenu={onContextMenu}
          />
        ))}
      </Masonry>
    </div>
  );
}

function GalleryCard({
  file,
  thumbnail,
  tags,
  allTags,
  onUndo,
  onReorder,
  onRename,
  onAddTag,
  onRemoveTag,
  onContextMenu,
}: {
  file: TrackedFile;
  thumbnail?: string;
  tags: Tag[];
  allTags: Tag[];
  onUndo: (operationId: string) => void;
  onReorder: (fromId: string, toId: string) => void;
  onRename: (fileId: string, newName: string) => Promise<void>;
  onAddTag: (fileId: string, tagName: string) => Promise<void>;
  onRemoveTag: (fileId: string, tagId: string) => Promise<void>;
  onContextMenu: (file: TrackedFile, x: number, y: number) => void;
}) {
  const { t } = useI18n();
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(file.current_name);
  const [addingTag, setAddingTag] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editingName) setNameDraft(file.current_name);
  }, [file.current_name, editingName]);

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

  return (
    <div
      className={`gallery-card ${dragOver ? "drag-over" : ""}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(FILE_DRAG_MIME, file.id);
        e.dataTransfer.effectAllowed = "move";
        setDragPreview(e, file.current_name);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const fromId = e.dataTransfer.getData(FILE_DRAG_MIME);
        if (fromId && fromId !== file.id) onReorder(fromId, file.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(file, e.clientX, e.clientY);
      }}
    >
      <div className="gallery-card-preview">
        {thumbnail ? <img src={thumbnail} alt="" /> : <GenericFileIcon width={32} height={32} />}
      </div>

      <div className="gallery-card-body">
        {editingName ? (
          <input
            ref={nameInputRef}
            className="gallery-card-name-input"
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
            className="gallery-card-name"
            title={t("inbox.rename")}
            onClick={() => setEditingName(true)}
          >
            {file.current_name}
          </button>
        )}

        <div className="gallery-card-meta">
          <span>{formatSize(file.size_bytes)}</span>
          <span className={`status-badge status-badge-${file.status}`}>
            {t(`status.${file.status}` as TranslationKey)}
          </span>
        </div>

        <div className="gallery-card-tags">
          {tags.map((tag) => (
            <span key={tag.id} className="gallery-tag-chip">
              {tag.name}
              <button
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
            <button className="gallery-tag-add" onClick={() => setAddingTag(true)}>
              <TagIcon width={11} height={11} /> {t("inbox.addTag")}
            </button>
          )}
        </div>

        {file.status === "organized" && file.operationId && (
          <button className="btn-link" onClick={() => onUndo(file.operationId!)}>
            {t("common.undo")}
          </button>
        )}
      </div>
    </div>
  );
}

