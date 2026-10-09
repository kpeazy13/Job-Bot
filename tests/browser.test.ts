import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { Store, hash } from "../src/store.ts";
import { BrowserWorker, motivationQuestion } from "../src/browser.ts";

test(
  "authenticated dashboard, mobile layout, and explicit local test submission",
  { timeout: 90000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "launchpad-test-")),
      port = 3310 + Math.floor(Math.random() * 1000),
      origin = `http://127.0.0.1:${port}`;
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "src/server.ts"],
      {
        cwd: resolve("."),
        env: {
          ...process.env,
          PORT: String(port),
          DATA_DIR: dir,
          DASHBOARD_TOKEN: "local-test-token",
          AI_ENABLED: "false",
        },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    let browser, store: Store | undefined, agent: BrowserWorker | undefined;
    try {
      for (let n = 0; n < 100; n++) {
        if (output.includes("Worker starts paused")) break;
        if (child.exitCode !== null) throw new Error(output);
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.match(output, /Worker starts paused/);
      assert.equal((await fetch(origin + "/api/state")).status, 401);
      assert.equal(
        (
          await fetch(origin + "/api/login", {
            method: "POST",
            headers: {
              Origin: "https://attacker.example",
              "Content-Type": "application/json",
            },
            body: "{}",
          })
        ).status,
        403,
      );
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(origin);
      await page.getByLabel("Local access token").fill("local-test-token");
      await page.getByRole("button", { name: "Unlock workspace" }).click();
      await page
        .getByRole("heading", { name: "A little closer to what’s next." })
        .waitFor();
      await mkdir("test-results", { recursive: true });
      await page.screenshot({
        path: "test-results/dashboard-desktop.png",
        fullPage: true,
      });
      await page
        .locator("nav")
        .getByRole("button", { name: "Job discovery" })
        .click();
      await page
        .getByLabel("Company name", { exact: true })
        .fill("Fixture Source");
      await page.getByLabel("Board token", { exact: true }).fill("fixture");
      await page.getByRole("button", { name: "Add job source" }).click();
      await page.getByText("Company board added", { exact: true }).waitFor();
      await page
        .getByRole("button", { name: "Pause source", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Enable source", exact: true })
        .waitFor();
      await page.screenshot({
        path: "test-results/discovery-desktop.png",
        fullPage: true,
      });
      await page
        .locator("nav")
        .getByRole("button", { name: "Profile & evidence" })
        .click();
      await page
        .getByLabel("Full name", { exact: true })
        .fill("Test Applicant");
      await page.getByLabel("Email", { exact: true }).fill("test@example.com");
      await page.getByLabel("Education", { exact: true }).fill("Test degree");
      await page.getByLabel("I verify these details").check();
      await page.getByRole("button", { name: "Save approved profile" }).click();
      await page
        .getByText("Profile approved and saved", { exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "Add opportunity", exact: false })
        .click();
      await page.getByLabel("Company", { exact: true }).fill("Fixture Company");
      await page.getByLabel("Role title").fill("Software Intern");
      await page.getByLabel("Posting URL").fill(origin + "/test-portal");
      await page
        .getByLabel("Job description")
        .fill("A local test internship for software and testing.");
      await page.getByLabel("Workflow").selectOption("test");
      await page.getByRole("button", { name: "Create application" }).click();
      await page.getByText("Opportunity added", { exact: true }).waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      await page
        .locator("nav")
        .getByRole("button", { name: "Overview", exact: false })
        .click();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: "test-results/dashboard-mobile.png",
        fullPage: true,
      });
      store = new Store(join(dir, "agent.sqlite"));
      const a = store.list()[0];
      assert.equal(a.company, "Fixture Company");
      const pdf = Buffer.from(
        "%PDF-1.4\nBrowser-upload fixture; compiler validation is tested separately.",
      );
      const version = "fixture";
      await mkdir(join(dir, "artifacts", a.id, version), { recursive: true });
      await writeFile(join(dir, "artifacts", a.id, version, "resume.pdf"), pdf);
      for (const status of [
        "QUALIFIED",
        "RESUME_PLANNED",
        "RESUME_GENERATED",
        "RESUME_VALIDATED",
      ])
        store.transition(a.id, status, {
          checkpoint: {
            artifact: { version, pdfHash: hash(pdf.toString("base64")) },
          },
        });
      const resume = store.ask(a.id, "resume", "Review fixture", "resume");
      store.resolve(resume, { decision: "approve" });
      store.transition(a.id, "APPLYING");
      agent = new BrowserWorker(store, dir, origin, true);
      await agent.fill(store.get(a.id));
      assert.equal(store.get(a.id).status, "WAITING_FOR_USER");
      const q = store.questions().find((q) => q.kind === "answer");
      assert.equal(q?.prompt, motivationQuestion);
      store.resolve(String(q!.id), {
        decision: "approve",
        answer: "I enjoy testing software.",
        scope: "company",
      });
      store.transition(a.id, "APPLYING");
      await agent.fill(store.get(a.id));
      assert.equal(store.get(a.id).status, "WAITING_FOR_SUBMISSION_APPROVAL");
      assert.equal(store.getSetting(`receipt:${a.id}`, null), null);
      const submit = store.questions().find((q) => q.kind === "submission");
      store.resolve(String(submit!.id), { decision: "approve" });
      store.db
        .prepare("UPDATE applications SET lease_until=? WHERE id=?")
        .run(Date.now() + 180000, a.id);
      store.setting("paused", false);
      await agent.submit(store.get(a.id));
      store.setting("paused", true);
      assert.equal(store.get(a.id).status, "SUBMITTED", store.get(a.id).reason);
      assert.ok(store.getSetting(`receipt:${a.id}`, null));
      // Mutating a reviewed form must not result in a receipt or a replay.
      const second = store.importJob({ ...a, requisition: "tamper-case" });
      await mkdir(join(dir, "artifacts", second.id, version), {
        recursive: true,
      });
      await writeFile(
        join(dir, "artifacts", second.id, version, "resume.pdf"),
        pdf,
      );
      for (const status of [
        "QUALIFIED",
        "RESUME_PLANNED",
        "RESUME_GENERATED",
        "RESUME_VALIDATED",
        "READY_TO_APPLY",
        "APPLYING",
      ])
        store.transition(second.id, status, {
          checkpoint: {
            resumeApproved: true,
            artifact: { version, pdfHash: hash(pdf.toString("base64")) },
          },
        });
      await agent.fill(store.get(second.id));
      const secondReview = store
        .questions()
        .find((q) => q.application_id === second.id && q.kind === "submission");
      store.resolve(String(secondReview!.id), { decision: "approve" });
      await agent.pages
        .get(second.id)!
        .getByLabel("Email", { exact: true })
        .fill("changed@example.com");
      await agent.submit(store.get(second.id));
      assert.equal(store.get(second.id).status, "SUBMISSION_UNKNOWN");
      assert.equal(store.getSetting(`receipt:${second.id}`, null), null);
      await assert.rejects(
        () => agent!.submit(store!.get(second.id)),
        /approval required/,
      );
      assert.equal(errors.length, 0, errors.join("\n"));
    } finally {
      await agent?.close();
      await browser?.close();
      store?.db.close();
      child.kill();
    }
  },
);
