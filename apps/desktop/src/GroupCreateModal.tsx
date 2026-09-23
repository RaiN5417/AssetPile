import { useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useI18n } from "./i18n/context";
import { Modal } from "./Modal";

export function GroupCreateModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [destinationPath, setDestinationPath] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateName, setDuplicateName] = useState<string | null>(null);

  function folderName(path: string): string {
    const trimmed = path.replace(/[/\\]+$/, "");
    const parts = trimmed.split(/[/\\]/);
    return parts[parts.length - 1] ?? trimmed;
  }

  async function pickFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      setDestinationPath(selected);
      if (!name.trim()) {
        setName(folderName(selected));
      }
    }
  }

  async function createGroup(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !destinationPath.trim()) return;
    setCreating(true);
    setError(null);
    setDuplicateName(null);
    try {
      await invoke("create_group", {
        name: name.trim(),
        destinationPath: destinationPath.trim(),
      });
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
    <Modal title={t("groups.create")} onClose={onClose}>
      <form onSubmit={(e) => void createGroup(e)} className="group-form">
        <label className="form-label">
          <span className="form-label-text">{t("groups.nameLabel")}</span>
          <input
            className={`group-form-name ${duplicateName ? "input-error" : ""}`}
            placeholder={t("groups.namePlaceholder")}
            value={name}
            autoFocus
            onChange={(e) => {
              setName(e.target.value);
              setDuplicateName(null);
            }}
          />
        </label>
        {duplicateName && (
          <p className="form-error">{t("groups.duplicateNameError", { name: duplicateName })}</p>
        )}
        <label className="form-label">
          <span className="form-label-text">{t("groups.pathLabel")}</span>
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
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            className="btn-primary"
            disabled={creating || !name.trim() || !destinationPath.trim()}
          >
            {creating ? t("groups.creating") : t("groups.create")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
