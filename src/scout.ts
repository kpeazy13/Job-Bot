import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Job, Store } from "./store.ts";

export const sourceSchema = z.object({
  company: z.string().trim().min(1).max(200),
  token: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  internshipsOnly: z.boolean().default(true),
});
export type Source = z.infer<typeof sourceSchema> & {
  id: string;
  enabled: boolean;
  lastSync: string | null;
  nextSync: number;
  lastError: string | null;
  lastResult: { imported: number; duplicates: number; skipped: number } | null;
};
const greenhouseJobSchema = z.object({
  id: z.number().int().positive(),
  internal_job_id: z.number().nullable().optional(),
  title: z.string(),
  absolute_url: z.url(),
  content: z.string(),
  location: z.object({ name: z.string() }).optional(),
});
export function plainText(html: string) {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  let decoded = html;
  for (let n = 0; n < 2; n++)
    decoded = decoded.replace(
      /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (full, entity: string) => {
        if (entity[0] === "#") {
          const code =
            entity[1].toLowerCase() === "x"
              ? parseInt(entity.slice(2), 16)
              : parseInt(entity.slice(1), 10);
          return code > 0 && code <= 0x10ffff
            ? String.fromCodePoint(code)
            : " ";
        }
        return entities[entity.toLowerCase()] || full;
      },
    );
  return decoded
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6])\s*>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\t ]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}
export function normalizeGreenhouse(
  payload: unknown,
  source: Pick<Source, "company" | "token" | "internshipsOnly">,
): { jobs: Job[]; skipped: number } {
  const root = z
    .object({ jobs: z.array(z.unknown()).max(10000) })
    .parse(payload);
  const jobs: Job[] = [];
  let skipped = 0;
  for (const item of root.jobs) {
    const parsed = greenhouseJobSchema.safeParse(item);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    const j = parsed.data;
    if (
      j.internal_job_id === null ||
      (source.internshipsOnly &&
        !/\bintern(?:ship)?\b|\bco[ -]?op\b/i.test(j.title))
    ) {
      skipped++;
      continue;
    }
    const description = plainText(j.content);
    if (
      description.length < 20 ||
      new URL(j.absolute_url).protocol !== "https:" ||
      jobs.length >= 500
    ) {
      skipped++;
      continue;
    }
    jobs.push({
      company: source.company,
      title: j.title,
      location: j.location?.name || "",
      url: j.absolute_url,
      requisition: `greenhouse:${source.token}:${j.internal_job_id ?? j.id}`,
      description,
      adapter: "manual",
    });
  }
  return { jobs, skipped };
}
async function limitedJson(response: Response) {
  if (!response.body) throw new Error("Source returned no data");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 5 * 1024 * 1024)
        throw new Error("Job feed exceeds 5 MB limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export class Scout {
  store: Store;
  request: typeof fetch;
  busy = false;
  constructor(store: Store, request: typeof fetch = fetch) {
    this.store = store;
    this.request = request;
  }
  list() {
    return this.store.getSetting<Source[]>("sources", []);
  }
  save(sources: Source[]) {
    this.store.setting("sources", sources);
  }
  add(input: unknown) {
    const source = sourceSchema.parse(input);
    if (this.list().some((s) => s.token === source.token))
      throw new Error("This board is already configured");
    const result: Source = {
      ...source,
      id: randomUUID(),
      enabled: true,
      lastSync: null,
      nextSync: 0,
      lastError: null,
      lastResult: null,
    };
    this.store.transaction(() => {
      this.save([...this.list(), result]);
      this.store.audit(
        null,
        "source.added",
        { id: result.id, company: source.company, token: source.token },
        "user",
      );
    });
    return result;
  }
  toggle(id: string, enabled: boolean) {
    if (typeof enabled !== "boolean")
      throw new Error("enabled must be boolean");
    const all = this.list(),
      source = all.find((s) => s.id === id);
    if (!source) throw new Error("Source not found");
    source.enabled = enabled;
    this.store.transaction(() => {
      this.save(all);
      this.store.audit(null, "source.updated", { id, enabled }, "user");
    });
  }
  async sync(id: string, manual = false) {
    if (this.busy) throw new Error("A source sync is already running");
    const source = this.list().find((s) => s.id === id);
    if (!source) throw new Error("Source not found");
    if (!source.enabled) throw new Error("Enable this source first");
    const cooldown = this.store.getSetting<number>(`source-cooldown:${id}`, 0);
    if (cooldown > Date.now())
      throw new Error("Source is cooling down; wait before syncing again");
    this.busy = true;
    this.store.setting(`source-cooldown:${id}`, Date.now() + 60000);
    let nextSync = Date.now() + 15 * 60000;
    try {
      const response = await this.request(
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(source.token)}/jobs?content=true`,
        {
          headers: { Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(20000),
        },
      );
      if (response.status === 429) {
        const retry = response.headers.get("retry-after") || "";
        const retryMs = /^\d+$/.test(retry)
          ? Number(retry) * 1000
          : Date.parse(retry) - Date.now();
        nextSync = Math.max(
          nextSync,
          Date.now() + (Number.isFinite(retryMs) ? retryMs : 0),
        );
        this.store.setting(`source-cooldown:${id}`, nextSync);
        throw new Error(
          "Greenhouse rate limit; source will retry after its cooldown",
        );
      }
      if (!response.ok)
        throw new Error(
          `Greenhouse returned HTTP ${response.status}; check the board token`,
        );
      const normalized = normalizeGreenhouse(
        await limitedJson(response),
        source,
      );
      let imported = 0,
        duplicates = 0;
      this.store.transaction(() => {
        for (const job of normalized.jobs) {
          const result = this.store.importJob(job);
          if (result.duplicate) duplicates++;
          else imported++;
        }
        this.update(id, {
          lastSync: new Date().toISOString(),
          nextSync,
          lastError: null,
          lastResult: { imported, duplicates, skipped: normalized.skipped },
        });
        this.store.audit(
          null,
          "source.synced",
          { id, imported, duplicates, skipped: normalized.skipped },
          manual ? "user" : "worker",
        );
      });
      return { imported, duplicates, skipped: normalized.skipped };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Source sync failed";
      this.update(id, { nextSync, lastError: message });
      this.store.audit(null, "source.failed", { id, error: message });
      throw error;
    } finally {
      this.busy = false;
    }
  }
  update(id: string, patch: Partial<Source>) {
    this.save(this.list().map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }
  async tick() {
    if (this.busy || this.store.getSetting("paused", true)) return;
    const next = this.list().find(
      (s) =>
        s.enabled &&
        s.nextSync <= Date.now() &&
        this.store.getSetting<number>(`source-cooldown:${s.id}`, 0) <=
          Date.now(),
    );
    if (next)
      try {
        await this.sync(next.id);
      } catch {
        /* Error recorded per source; other sources remain runnable. */
      }
  }
}
