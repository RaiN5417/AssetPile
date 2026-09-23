// Mirrors crates/domain/src/file.rs FileRecord's serde output (field names
// are not renamed, so this matches the Rust struct 1:1).
export interface FileRecord {
  id: string;
  current_name: string;
  current_path: string;
  size_bytes: number | null;
  status: string;
  ready_at: string | null;
  expires_at?: string | null;
  group_id?: string | null;
  extension?: string | null;
  mime_type?: string | null;
}

// A file plus, once known, the id of the move operation that organized it —
// that's what Undo needs when acting from the live Inbox list/gallery.
export interface TrackedFile extends FileRecord {
  operationId?: string;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

export function isImageFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase();
  return ext !== undefined && IMAGE_EXTENSIONS.has(ext);
}

export function formatSize(bytes: number | null): string {
  if (bytes === null) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Renders an ISO timestamp as "in 3 days" / "2 hours ago" style text.
export function formatRelative(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  let value: number;
  let unit: Intl.RelativeTimeFormatUnit;
  if (abs < hour) {
    value = Math.round(diffMs / minute);
    unit = "minute";
  } else if (abs < day) {
    value = Math.round(diffMs / hour);
    unit = "hour";
  } else {
    value = Math.round(diffMs / day);
    unit = "day";
  }

  return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(value, unit);
}
