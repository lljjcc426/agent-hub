import {
  constants,
  createWriteStream,
  createReadStream,
  openSync,
  fstatSync,
  closeSync,
  readdirSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BrowserError } from "./browser-contract.ts";
import { chatUploadLimits } from "./chat-attachments.ts";

export const browserFilename = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (s) => s !== "." && s !== ".." && !/[\x00-\x1f\x7f/\\]/.test(s),
    "Invalid filename",
  );
export function browserDownloads(directory: string) {
  const root = join(directory, "downloads");
  return readdirSync(root, { withFileTypes: true })
    .filter((f) => f.isFile() && !f.name.endsWith(".crdownload"))
    .map((f) => ({ name: f.name }));
}
export function browserDownload(directory: string, name: string) {
  const path = join(directory, "downloads", browserFilename.parse(name));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stat = fstatSync(fd);
  if (!stat.isFile()) {
    closeSync(fd);
    throw new BrowserError("browser_missing", "Download is unavailable.", 404);
  }
  return {
    bytes: stat.size,
    stream: createReadStream(path, { fd, autoClose: true }),
  };
}
/** Chrome may read the selected file when a later form submission starts. */
export async function browserUpload(
  directory: string,
  name: string,
  body: AsyncIterable<Uint8Array>,
  use: (path: string) => Promise<void>,
) {
  const root = join(directory, "uploads", randomUUID()),
    path = join(root, browserFilename.parse(name));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let bytes = 0;
  try {
    await pipeline(
      body,
      async function* (source) {
        for await (const chunk of source) {
          bytes += chunk.byteLength;
          if (bytes > chatUploadLimits.maxBytes)
            throw new BrowserError(
              "attachment_too_large",
              "File exceeds 100 MiB.",
              413,
            );
          yield chunk;
        }
      },
      createWriteStream(path, { flags: "wx", mode: 0o600 }),
    );
    await use(path);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
