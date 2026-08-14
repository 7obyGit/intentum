import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Cache } from "./types.js";

export class MemoryCache implements Cache {
  private readonly values = new Map<string, string>();

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }

  set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

export class FileCache implements Cache {
  constructor(private readonly directory = ".intentum-cache") {}

  private path(key: string): string {
    return join(this.directory, `${createHash("sha256").update(key).digest("hex")}.txt`);
  }

  async get(key: string): Promise<string | undefined> {
    try {
      return await readFile(this.path(key), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async set(key: string, value: string): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.path(key), value, "utf8");
  }
}
