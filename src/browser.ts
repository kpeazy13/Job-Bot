import { chromium, type BrowserContext, type Page } from "playwright";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { hash, type Application, type Store } from "./store.ts";
export const motivationQuestion = "Why are you interested in this internship?";
// V1 only automates our explicit test adapter. Unknown portals always require manual work.
export class BrowserWorker {
  context: BrowserContext | undefined;
  pages = new Map<string, Page>();
  store: Store;
  dataDir: string;
  portalOrigin: string;
  headless: boolean;
  constructor(
    store: Store,
    dataDir: string,
    portalOrigin: string,
    headless = false,
  ) {
    this.store = store;
    this.dataDir = dataDir;
    this.portalOrigin = portalOrigin;
    this.headless = headless;
  }
  async page(a: Application) {
    for (const [id, page] of this.pages)
      if (page.isClosed()) this.pages.delete(id);
    if (!this.pages.has(a.id) && this.pages.size >= 5)
      throw new Error(
        "Five browser tabs are awaiting review. Resolve their approvals before retrying.",
      );
    if (!this.context)
      this.context = await chromium.launchPersistentContext(
        join(this.dataDir, "browser-profile"),
        { headless: this.headless, acceptDownloads: false },
      );
    let page = this.pages.get(a.id);
    if (!page || page.isClosed()) {
      page = await this.context.newPage();
      this.pages.set(a.id, page);
    }
    page.setDefaultTimeout(10000);
    return page;
  }
  async fill(a: Application) {
    if (a.adapter !== "test") {
      this.store.transaction(() => {
        this.store.transition(a.id, "NEEDS_MANUAL_REVIEW", {
          reason:
            "This portal has no approved adapter. Open the posting to continue manually.",
        });
        this.store.ask(
          a.id,
          "manual",
          "This portal requires manual completion. Automated submission is disabled.",
          "portal",
          { url: a.url },
        );
      });
      return;
    }
    const expected = new URL(
      `/test-portal/${a.id}`,
      this.portalOrigin,
    ).toString();
    if (a.url !== new URL("/test-portal", this.portalOrigin).toString())
      throw new Error("Test adapter only accepts the local test portal URL");
    const profile = this.store.profile();
    if (!profile) throw new Error("Profile missing");
    const answer = this.store.answerFor(a, "motivation", motivationQuestion);
    if (!answer) {
      this.store.transaction(() => {
        this.store.transition(a.id, "WAITING_FOR_USER");
        this.store.ask(a.id, "answer", motivationQuestion, "motivation", {
          evidence: this.store
            .evidence()
            .map((e) => ({ id: e.id, title: e.title, bullet: e.bullet })),
        });
      });
      return;
    }
    const artifact = a.checkpoint.artifact;
    if (!artifact) throw new Error("Validated artifact missing");
    if (!a.checkpoint.resumeApproved)
      throw new Error(
        "Explicit résumé approval required before browser upload",
      );
    const path = join(
      this.dataDir,
      "artifacts",
      a.id,
      artifact.version,
      "resume.pdf",
    );
    if (hash((await readFile(path)).toString("base64")) !== artifact.pdfHash)
      throw new Error("Artifact changed since review");
    const page = await this.page(a);
    await page.goto(expected, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    if (page.url() !== expected)
      throw new Error("Unexpected portal navigation");
    await page.getByLabel("Full name", { exact: true }).fill(profile.name);
    await page.getByLabel("Email", { exact: true }).fill(profile.email);
    await page
      .getByLabel(motivationQuestion, { exact: true })
      .fill(String(answer.value));
    await page.getByLabel("Résumé PDF", { exact: true }).setInputFiles(path);
    const bundle = {
      job: a.id,
      url: expected,
      resumeHash: artifact.pdfHash,
      answers: {
        name: profile.name,
        email: profile.email,
        motivation: String(answer.value),
      },
      provenance: { motivationAnswerId: answer.id },
    };
    this.store.transaction(() => {
      this.store.transition(a.id, "WAITING_FOR_SUBMISSION_APPROVAL", {
        checkpoint: { ...a.checkpoint, bundle },
      });
      this.store.ask(
        a.id,
        "submission",
        "Approve the exact résumé and answers shown below for submission.",
        "submission",
        { bundle, bundleHash: hash(bundle) },
      );
    });
  }
  async submit(a: Application) {
    const bundle = a.checkpoint.bundle;
    if (
      a.status !== "SUBMITTING" ||
      a.adapter !== "test" ||
      !bundle ||
      a.checkpoint.approval?.bundleHash !== hash(bundle)
    )
      throw new Error("Matching explicit approval required");
    const page = this.pages.get(a.id);
    if (!page || page.isClosed()) {
      this.store.transition(a.id, "SUBMISSION_UNKNOWN", {
        reason:
          "Browser session lost. Inspect portal receipt before taking any further action.",
      });
      return;
    }
    try {
      if (page.url() !== bundle.url)
        throw new Error("Portal navigation changed");
      const actual = {
        name: await page.getByLabel("Full name", { exact: true }).inputValue(),
        email: await page.getByLabel("Email", { exact: true }).inputValue(),
        motivation: await page
          .getByLabel(motivationQuestion, { exact: true })
          .inputValue(),
      };
      if (hash(actual) !== hash(bundle.answers))
        throw new Error("Form changed after approval");
      const uploaded = await page
        .getByLabel("Résumé PDF", { exact: true })
        .evaluate(async (el) => {
          const f = (el as HTMLInputElement).files?.[0];
          if (!f) return "";
          const bytes = new Uint8Array(await f.arrayBuffer());
          let s = "";
          for (const b of bytes) s += String.fromCharCode(b);
          return btoa(s);
        });
      if (hash(uploaded) !== bundle.resumeHash)
        throw new Error("Uploaded PDF changed after approval");
      if (this.store.getSetting("paused", true)) return;
      this.store.audit(a.id, "submission.started", {
        bundleHash: hash(bundle),
      });
      await page
        .getByRole("button", { name: "Submit test application", exact: true })
        .click({ timeout: 15000 });
      await page
        .getByText("Test application received", { exact: true })
        .waitFor({ timeout: 15000 });
      this.store.transition(a.id, "SUBMITTED", {
        reason: "Local test portal confirmed receipt",
      });
      await page.close();
      this.pages.delete(a.id);
    } catch (e) {
      this.store.transition(a.id, "SUBMISSION_UNKNOWN", {
        reason: e instanceof Error ? e.message : "Submission uncertain",
      });
    }
  }
  async close() {
    await this.context?.close();
    this.context = undefined;
    this.pages.clear();
  }
}
