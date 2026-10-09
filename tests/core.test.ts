import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, hash, normalize } from "../src/store.ts";
import { defaultTemplate, renderResume, planResume } from "../src/resume.ts";
const posting = {
  company: "Example Co",
  title: "Software Intern",
  location: "Remote",
  url: "https://example.com/jobs/1",
  requisition: "INT-1",
  description: "A software engineering internship using C++ and Linux.",
  adapter: "manual",
};
function fresh() {
  const s = new Store(":memory:");
  const { id } = s.importJob(posting);
  return { s, id };
}
function reach(s: Store, id: string, status: string) {
  const states = [
    "QUALIFIED",
    "RESUME_PLANNED",
    "RESUME_GENERATED",
    "RESUME_VALIDATED",
    "READY_TO_APPLY",
    "APPLYING",
    "WAITING_FOR_SUBMISSION_APPROVAL",
  ];
  for (const next of states) {
    s.transition(id, next);
    if (next === status) break;
  }
}
test("deduplicates requisitions across tracking URLs and normalized company names", () => {
  const { s, id } = fresh();
  assert.deepEqual(
    s.importJob({
      ...posting,
      company: " EXAMPLE  CO ",
      url: "https://other.example/jobs/2",
    }),
    { id, duplicate: true },
  );
  assert.equal(s.list().length, 1);
  s.db.close();
});
test("deduplicates tracking URL variants without a requisition", () => {
  const s = new Store(":memory:");
  s.importJob({
    ...posting,
    requisition: "",
    url: "https://example.com/1?utm_source=test",
  });
  assert.equal(
    s.importJob({ ...posting, requisition: "", url: "https://example.com/1" })
      .duplicate,
    true,
  );
  s.db.close();
});
test("rejects invalid states and prevents submission without approval", () => {
  const { s, id } = fresh();
  assert.throws(() => s.transition(id, "SUBMITTED"), /Invalid transition/);
  assert.throws(() => s.resolve("missing", { decision: "approve" }));
  s.db.close();
});
test("audit records cannot be mutated or removed", () => {
  const { s } = fresh();
  assert.throws(() => s.db.exec("DELETE FROM events"), /append-only/);
  assert.throws(
    () => s.db.exec("UPDATE events SET actor='attacker'"),
    /append-only/,
  );
  s.db.close();
});
test("answers only reuse with exact question and authorized scope", () => {
  const { s, id } = fresh();
  reach(s, id, "APPLYING");
  s.transition(id, "WAITING_FOR_USER");
  const q = s.ask(id, "answer", "Why this company?", "motivation");
  s.resolve(q, {
    decision: "approve",
    answer: "My approved response",
    scope: "company",
  });
  assert.equal(s.get(id).status, "READY_TO_RESUME");
  assert.equal(
    s.answerFor(s.get(id), "motivation", " WHY this company? ")?.value,
    "My approved response",
  );
  assert.equal(
    s.answerFor(
      { ...s.get(id), company: "Other" },
      "motivation",
      "Why this company?",
    ),
    undefined,
  );
  assert.equal(
    s.answerFor(s.get(id), "motivation", "Why this team?"),
    undefined,
  );
  assert.throws(
    () => s.resolve(q, { decision: "approve", answer: "different" }),
    /no longer pending/,
  );
  s.db.close();
});
test("submission approval binds to exact bundle, rejects tampering and rolls back", () => {
  const { s, id } = fresh();
  reach(s, id, "APPLYING");
  const bundle = { answers: { name: "Original" }, resumeHash: "abc" };
  s.transition(id, "WAITING_FOR_SUBMISSION_APPROVAL", {
    checkpoint: { bundle },
  });
  const q = s.ask(id, "submission", "Submit?", "submission", {
    bundleHash: hash({ ...bundle, resumeHash: "wrong" }),
  });
  assert.throws(() => s.resolve(q, { decision: "approve" }), /stale/);
  assert.equal(s.get(id).status, "WAITING_FOR_SUBMISSION_APPROVAL");
  assert.equal(s.questions()[0].state, "pending");
  s.db.close();
});
test("approved submission cannot be replayed", () => {
  const { s, id } = fresh();
  reach(s, id, "APPLYING");
  const bundle = { answers: { name: "Example" }, resumeHash: "abc" };
  s.transition(id, "WAITING_FOR_SUBMISSION_APPROVAL", {
    checkpoint: { bundle },
  });
  const q = s.ask(id, "submission", "Submit?", "submission", {
    bundleHash: hash(bundle),
  });
  s.resolve(q, { decision: "approve" });
  assert.equal(s.get(id).status, "SUBMITTING");
  assert.throws(() => s.resolve(q, { decision: "approve" }));
  s.transition(id, "SUBMISSION_UNKNOWN");
  assert.throws(() => s.retry(id));
  assert.throws(() => s.transition(id, "SUBMITTING"));
  s.db.close();
});
test("waiting applications do not block unrelated work and leases are exclusive", () => {
  const { s, id } = fresh();
  reach(s, id, "APPLYING");
  s.transition(id, "WAITING_FOR_USER");
  const next = s.importJob({
    ...posting,
    requisition: "INT-2",
    url: "https://example.com/2",
  });
  assert.equal(s.lease()?.id, next.id);
  assert.equal(s.lease(), null);
  s.release(next.id);
  assert.equal(s.lease()?.id, next.id);
  s.db.close();
});
test("stale submission lease becomes unknown instead of automatically retrying", () => {
  const { s, id } = fresh();
  reach(s, id, "WAITING_FOR_SUBMISSION_APPROVAL");
  s.transition(id, "SUBMITTING");
  s.db.prepare("UPDATE applications SET lease_until=1 WHERE id=?").run(id);
  assert.equal(s.lease(), null);
  assert.equal(s.get(id).status, "SUBMISSION_UNKNOWN");
  s.db.close();
});
test("retries are bounded", () => {
  const { s, id } = fresh();
  reach(s, id, "QUALIFIED");
  for (let i = 0; i < 3; i++) {
    s.transition(id, "RETRYABLE_ERROR");
    s.retry(id);
  }
  s.transition(id, "RETRYABLE_ERROR");
  assert.throws(() => s.retry(id), /limit/);
  s.db.close();
});
test("requires explicitly approved facts and source evidence", () => {
  const { s } = fresh();
  assert.throws(() =>
    s.saveProfile({ name: "Test", email: "test@example.com", approved: false }),
  );
  assert.throws(() =>
    s.addEvidence({
      title: "Role",
      bullet: "Did things",
      skills: [],
      approved: true,
    }),
  );
  s.db.close();
});
test("resume selection stays evidence-linked and escapes untrusted content", () => {
  const { s, id } = fresh();
  const evidence = [
    {
      id: "one",
      title: "Test & Project",
      bullet: "Built 20% faster C++ tests",
      skills: ["C++"],
      source: "verified",
      approved: true as const,
    },
  ];
  const plan = planResume(s.get(id), evidence);
  assert.deepEqual(plan.selected_bullet_ids, ["one"]);
  assert.equal(plan.new_factual_claims_allowed, false);
  const profile = {
    name: "A & B",
    email: "a@example.com",
    education: "BS",
    phone: "",
    location: "",
    roles: [],
    locations: [],
    approved: true as const,
  };
  const tex = renderResume(defaultTemplate, profile, evidence);
  assert.ok(tex.includes("A \\& B"));
  assert.ok(tex.includes("20\\%"));
  assert.ok(tex.startsWith(defaultTemplate.split("% BEGIN")[0]));
  assert.ok(tex.endsWith(defaultTemplate.split("% END AGENT CONTENT")[1]));
  assert.throws(
    () => renderResume("missing markers", profile, evidence),
    /marker/,
  );
  s.db.close();
});
test("normalization does not imply semantic equivalence", () => {
  assert.notEqual(
    normalize("Do you need sponsorship now?"),
    normalize("Do you need sponsorship in the future?"),
  );
});

test("interrupted résumé generation is recovered instead of stranded", () => {
  const { s, id } = fresh();
  reach(s, id, "RESUME_PLANNED");
  s.db.prepare("UPDATE applications SET lease_until=1 WHERE id=?").run(id);
  assert.equal(s.lease(), null);
  assert.equal(s.get(id).status, "RETRYABLE_ERROR");
  s.retry(id);
  assert.equal(s.get(id).status, "QUALIFIED");
  s.db.close();
});

test("state and audit writes roll back together", () => {
  const { s, id } = fresh();
  s.db.exec(
    "CREATE TRIGGER fail_audit BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'Simulated storage failure'); END;",
  );
  assert.throws(
    () => s.transition(id, "QUALIFIED"),
    /Simulated storage failure/,
  );
  assert.equal(s.get(id).status, "DISCOVERED");
  s.db.close();
});

test("one scoped approval unblocks compatible questions, not another employer", () => {
  const { s, id } = fresh();
  const second = s.importJob({ ...posting, requisition: "INT-2" }).id,
    other = s.importJob({
      ...posting,
      company: "Other Co",
      requisition: "INT-3",
    }).id;
  for (const job of [id, second, other]) {
    reach(s, job, "APPLYING");
    s.transition(job, "WAITING_FOR_USER");
    s.ask(job, "answer", "Why this company?", "motivation");
  }
  const q = s.questions().find((q) => q.application_id === id)!;
  s.resolve(String(q.id), {
    decision: "approve",
    answer: "Verified motivation",
    scope: "company",
  });
  assert.equal(s.get(second).status, "READY_TO_RESUME");
  assert.equal(s.get(other).status, "WAITING_FOR_USER");
  assert.equal(
    s.questions().find((q) => q.application_id === second)!.state,
    "reused",
  );
  s.db.close();
});

test("resume rejection cannot bypass approval through retry", () => {
  const { s, id } = fresh();
  reach(s, id, "RESUME_VALIDATED");
  const q = s.ask(id, "resume", "Review resume", "resume");
  s.resolve(q, { decision: "reject" });
  assert.equal(s.get(id).status, "NEEDS_MANUAL_REVIEW");
  assert.equal(s.get(id).checkpoint.resumeApproved, false);
  s.retry(id);
  assert.equal(s.get(id).status, "QUALIFIED");
  s.db.close();
});

test("regeneration invalidates prior approvals and cannot touch uncertain submissions", () => {
  const { s, id } = fresh();
  reach(s, id, "WAITING_FOR_SUBMISSION_APPROVAL");
  const q = s.ask(id, "submission", "Submit?", "submission", {
    bundleHash: "old",
  });
  s.regenerate(id);
  assert.equal(s.get(id).status, "QUALIFIED");
  assert.deepEqual(s.get(id).checkpoint, {});
  assert.equal(s.questions()[0].state, "superseded");
  assert.throws(() => s.resolve(q, { decision: "approve" }));
  s.db.close();
  const fixture = fresh();
  reach(fixture.s, fixture.id, "WAITING_FOR_SUBMISSION_APPROVAL");
  fixture.s.transition(fixture.id, "SUBMITTING");
  fixture.s.transition(fixture.id, "SUBMISSION_UNKNOWN");
  assert.throws(() => fixture.s.regenerate(fixture.id), /Cannot regenerate/);
  fixture.s.db.close();
});

test("reconciliation requires a durable receipt and never resubmits", () => {
  const s = new Store(":memory:");
  const id = s.importJob({ ...posting, adapter: "test" }).id;
  reach(s, id, "WAITING_FOR_SUBMISSION_APPROVAL");
  s.transition(id, "SUBMITTING");
  s.transition(id, "SUBMISSION_UNKNOWN");
  assert.throws(() => s.reconcile(id), /No confirmed receipt/);
  s.setting(`receipt:${id}`, { received: "fixture" });
  s.reconcile(id);
  assert.equal(s.get(id).status, "SUBMITTED");
  s.db.close();
});
