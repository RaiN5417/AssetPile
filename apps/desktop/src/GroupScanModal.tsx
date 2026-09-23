import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatSize } from "./lib/file";
import type { Group } from "./lib/group";
import { useI18n } from "./i18n/context";
import { Modal } from "./Modal";

export interface ImportableFile {
  name: string;
  path: string;
  size_bytes: number;
}

export function GroupScanModal({
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
              {selected.size === candidates.length
                ? t("groups.scanDeselectAll")
                : t("groups.scanSelectAll")}
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
            <label className="form-label">
              <span className="form-label-text">{t("groups.scanTagsLabel")}</span>
              <input
                className="group-scan-tags"
                placeholder={t("groups.scanTagsPlaceholder")}
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
              />
            </label>
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
            {importing
              ? t("groups.importing")
              : t("groups.importWithCount", { count: selected.size })}
          </button>
        </div>
      </div>
    </Modal>
  );
}
