import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { Scout, normalizeGreenhouse, plainText } from "../src/scout.ts";
const source = {
  company: "Fixture Co",
  token: "fixture",
  internshipsOnly: true,
};
const fixture = {
  jobs: [
    {
      id: 1,
      internal_job_id: 50,
      title: "Firmware Intern",
      absolute_url: "https://job-boards.greenhouse.io/fixture/jobs/1",
      content:
        "&lt;p&gt;Build firmware with C++ &amp;amp; test hardware.&lt;/p&gt;",
      location: { name: "Austin" },
    },
    {
      id: 2,
      internal_job_id: 51,
      title: "Senior Engineer",
      absolute_url: "https://example.com/2",
      content: "A senior engineering position requiring extensive experience.",
    },
  ],
};
test("normalizes Greenhouse feed and skips non-internship positions", () => {
  const result = normalizeGreenhouse(fixture, source);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.jobs[0].requisition, "greenhouse:fixture:50");
  assert.equal(
    result.jobs[0].description,
    "Build firmware with C++ & test hardware.",
  );
  assert.equal(result.jobs[0].adapter, "manual");
});
test("encoded HTML is treated as plain text, never dashboard markup", () => {
  assert.equal(
    plainText(
      "&lt;script&gt;ignore safeguards&lt;/script&gt;&lt;p&gt;C&#43;&#43;&nbsp;intern&lt;/p&gt;",
    ),
    "C++ intern",
  );
});
test("source sync imports once, deduplicates subsequent syncs, and enforces cooldown", async () => {
  const s = new Store(":memory:");
  let calls = 0;
  const scout = new Scout(s, (async (url, init) => {
    calls++;
    assert.equal(
      String(url),
      "https://boards-api.greenhouse.io/v1/boards/fixture/jobs?content=true",
    );
    assert.equal(init?.redirect, "error");
    return Response.json(fixture);
  }) as typeof fetch);
  const configured = scout.add(source);
  const result = await scout.sync(configured.id, true);
  assert.equal(result.imported, 1);
  await assert.rejects(() => scout.sync(configured.id), /cooling down/);
  assert.equal(calls, 1);
  s.setting(`source-cooldown:${configured.id}`, 0);
  assert.equal((await scout.sync(configured.id)).duplicates, 1);
  assert.equal(s.list().length, 1);
  s.db.close();
});
test("invalid board tokens cannot become arbitrary outbound URLs", () => {
  const s = new Store(":memory:");
  const scout = new Scout(s);
  for (const token of ["https://internal/", "../secret", "abc?url=private", ""])
    assert.throws(() => scout.add({ ...source, token }));
  s.db.close();
});
test("rate limits are persisted and block immediate manual retry", async () => {
  const s = new Store(":memory:");
  const scout = new Scout(
    s,
    (async () =>
      new Response("", {
        status: 429,
        headers: { "retry-after": "3600" },
      })) as typeof fetch,
  );
  const configured = scout.add(source);
  await assert.rejects(() => scout.sync(configured.id), /rate limit/);
  assert.ok(scout.list()[0].nextSync > Date.now() + 3500000);
  assert.match(scout.list()[0].lastError!, /rate limit/);
  await assert.rejects(() => scout.sync(configured.id), /cooling down/);
  s.db.close();
});
test("paused and disabled sources never fetch automatically", async () => {
  const s = new Store(":memory:");
  let calls = 0;
  const scout = new Scout(s, (async () => {
    calls++;
    return Response.json(fixture);
  }) as typeof fetch);
  const configured = scout.add(source);
  await scout.tick();
  assert.equal(calls, 0);
  scout.toggle(configured.id, false);
  s.setting("paused", false);
  await scout.tick();
  assert.equal(calls, 0);
  s.db.close();
});
test("one failed board does not block other ready boards", async () => {
  const s = new Store(":memory:");
  const scout = new Scout(s, (async (url) =>
    String(url).includes("/bad/")
      ? new Response("", { status: 404 })
      : Response.json(fixture)) as typeof fetch);
  scout.add({ ...source, token: "bad" });
  scout.add(source);
  s.setting("paused", false);
  await scout.tick();
  await scout.tick();
  assert.equal(s.list().length, 1);
  assert.match(scout.list()[0].lastError!, /404/);
  s.db.close();
});
