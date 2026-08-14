import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { ImageInput } from "./types.js";

export interface ContextOptions {
  readonly maxFileCharacters?: number;
}

export async function describeArguments(
  args: readonly unknown[],
  options: ContextOptions = {}
): Promise<{ display: unknown[]; images: ImageInput[]; files: string[] }> {
  const max = options.maxFileCharacters ?? 25_000;
  const display: unknown[] = [];
  const images: ImageInput[] = [];
  const files: string[] = [];
  for (const value of args) {
    if (typeof value === "string" && /^data:image\//.test(value)) {
      const comma = value.indexOf(",");
      if (comma > 0) {
        const mimeType = value.slice(5, comma).split(";")[0];
        images.push(mimeType ? { data: value.slice(comma + 1), mimeType } : { data: value.slice(comma + 1) });
      }
      display.push("<image data>");
      continue;
    }
    if (typeof value === "string" && extname(value).toLowerCase().match(/^\.(png|jpe?g|gif|webp)$/)) {
      try {
        const data = await readFile(value, "base64");
        images.push({ data, mimeType: mimeTypeFor(value) });
        display.push(`<image file: ${basename(value)}>`);
        files.push(value);
        continue;
      } catch {
        // Treat an unreadable path as a normal argument so the provider can explain it.
      }
    }
    if (typeof value === "string" && value.length > 0 && value.length <= max) {
      display.push(value);
      continue;
    }
    display.push(value);
  }
  return { display, images, files };
}

function mimeTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: return "image/png";
  }
}
