import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./paths.js";

/**
 * Comment attachments live in one host-private, content-addressed directory so a
 * pasted/dropped image is deduped by content and referenced by a stable URL the
 * daemon serves back. Stored outside any repo (like the rest of the central
 * store), so attachments aren't committed with the code.
 */
function attachmentsDir(): string {
  return join(configDir(), "attachments");
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/plain": "txt",
};
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
};

/** Stored ids are `<sha256>.<ext>` — the only shape `GET /attachments/:id` serves. */
const ID_RE = /^[a-f0-9]{64}\.[a-z0-9]+$/;

export function isValidAttachmentId(id: string): boolean {
  return ID_RE.test(id);
}

function extFor(mime: string, filename?: string): string {
  const byMime = EXT_BY_MIME[mime.toLowerCase()];
  if (byMime) return byMime;
  const ext = filename?.includes(".")
    ? filename.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "")
    : "";
  return ext || "bin";
}

/** Persist bytes content-addressed; identical content yields the same id. */
export async function storeAttachment(
  bytes: Buffer,
  mime: string,
  filename?: string,
): Promise<{ id: string }> {
  const sha = createHash("sha256").update(bytes).digest("hex");
  const id = `${sha}.${extFor(mime, filename)}`;
  await mkdir(attachmentsDir(), { recursive: true });
  await writeFile(join(attachmentsDir(), id), bytes);
  return { id };
}

export function attachmentPath(id: string): string {
  return join(attachmentsDir(), id);
}

/** Content-type for a (validated) id, defaulting to a non-renderable octet-stream. */
export function attachmentMime(id: string): string {
  const ext = id.split(".").pop() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}
