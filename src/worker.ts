import type { Store } from "./store.ts";
import { BrowserWorker } from "./browser.ts";
import { generateResume } from "./resume.ts";
export class Worker {
  busy = false;
  browser: BrowserWorker;
  store: Store;
  dataDir: string;
  constructor(store: Store, dataDir: string, origin: string, headless = false) {
    this.store = store;
    this.dataDir = dataDir;
    this.browser = new BrowserWorker(store, dataDir, origin, headless);
  }
  async tick() {
    if (this.busy || this.store.getSetting("paused", true)) return;
    this.busy = true;
    let id: string | undefined;
    try {
      const a = this.store.lease();
      if (!a) return;
      id = a.id;
      if (a.status === "DISCOVERED") {
        const p = this.store.profile(),
          text = `${a.title} ${a.description}`.toLowerCase();
        const roleMatch =
          !p?.roles.length ||
          p.roles.some((r) => text.includes(r.toLowerCase()));
        const locationMatch =
          !p?.locations.length ||
          p.locations.some((l) =>
            a.location.toLowerCase().includes(l.toLowerCase()),
          );
        const matched = this.store
          .evidence()
          .flatMap((e) => e.skills)
          .filter((s) => text.includes(s.toLowerCase()));
        const score = Math.min(
          100,
          30 +
            (roleMatch ? 25 : 0) +
            (locationMatch ? 15 : 0) +
            new Set(matched).size * 5,
        );
        this.store.transition(
          a.id,
          roleMatch && locationMatch ? "QUALIFIED" : "FILTERED_OUT",
          {
            score,
            reason:
              roleMatch && locationMatch
                ? "Matches configured preferences; eligibility still requires user verification"
                : "Outside configured role or location preferences",
          },
        );
      } else if (a.status === "QUALIFIED")
        await generateResume(this.store, a, this.dataDir);
      else if (a.status === "SUBMITTING") await this.browser.submit(a);
      else {
        this.store.transition(a.id, "APPLYING");
        await this.browser.fill(this.store.get(a.id));
      }
    } catch (e) {
      if (id) {
        const a = this.store.get(id),
          reason = e instanceof Error ? e.message : "Worker failed";
        if (a.status === "SUBMITTING")
          this.store.transition(id, "SUBMISSION_UNKNOWN", { reason });
        else this.store.transition(id, "RETRYABLE_ERROR", { reason });
      }
    } finally {
      if (id) this.store.release(id);
      this.busy = false;
    }
  }
}
