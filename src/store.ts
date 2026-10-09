import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const profileSchema = z.object({
  name: z.string().min(1),
  email: z.email(),
  phone: z.string().default(""),
  location: z.string().default(""),
  education: z.string().default(""),
  approved: z.literal(true),
  roles: z.array(z.string()).default([]),
  locations: z.array(z.string()).default([]),
});
export const evidenceSchema = z.object({
  title: z.string().min(1),
  bullet: z.string().min(1),
  skills: z.array(z.string()),
  source: z.string().min(1),
  approved: z.literal(true),
});
export const jobSchema = z.object({
  company: z.string().min(1),
  title: z.string().min(1),
  location: z.string().default(""),
  url: z.url(),
  requisition: z.string().default(""),
  description: z.string().min(20),
  adapter: z.enum(["manual", "test"]).default("manual"),
});
export type Profile = z.infer<typeof profileSchema>;
export type Evidence = z.infer<typeof evidenceSchema> & { id: string };
export type Job = z.infer<typeof jobSchema>;
export type Application = Job & {
  id: string;
  status: string;
  created: string;
  updated: string;
  score: number;
  reason: string;
  checkpoint: Record<string, any>;
  attempts: number;
  lease_until: number;
};
export const hash = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
export const normalize = (s: string) =>
  s.trim().toLowerCase().replace(/\s+/g, " ");
const edges: Record<string, string[]> = {
  DISCOVERED: ["QUALIFIED", "FILTERED_OUT"],
  QUALIFIED: ["RESUME_PLANNED"],
  RESUME_PLANNED: ["RESUME_GENERATED"],
  RESUME_GENERATED: ["RESUME_VALIDATED"],
  RESUME_VALIDATED: ["READY_TO_APPLY", "NEEDS_MANUAL_REVIEW", "QUALIFIED"],
  READY_TO_APPLY: ["APPLYING", "QUALIFIED"],
  APPLYING: [
    "WAITING_FOR_USER",
    "WAITING_FOR_AUTH",
    "WAITING_FOR_SUBMISSION_APPROVAL",
    "NEEDS_MANUAL_REVIEW",
  ],
  WAITING_FOR_USER: ["READY_TO_RESUME", "QUALIFIED"],
  WAITING_FOR_AUTH: ["READY_TO_RESUME"],
  READY_TO_RESUME: ["APPLYING"],
  WAITING_FOR_SUBMISSION_APPROVAL: [
    "SUBMITTING",
    "REJECTED_BY_USER",
    "QUALIFIED",
  ],
  SUBMITTING: ["SUBMITTED", "SUBMISSION_UNKNOWN"],
  SUBMISSION_UNKNOWN: ["SUBMITTED"],
  RETRYABLE_ERROR: ["QUALIFIED", "READY_TO_RESUME", "NEEDS_MANUAL_REVIEW"],
  NEEDS_MANUAL_REVIEW: ["QUALIFIED", "READY_TO_RESUME"],
};
export class Store {
  db: DatabaseSync;
  private transactionDepth = 0;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY,data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS applications(id TEXT PRIMARY KEY,fingerprint TEXT UNIQUE NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,lease_until INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY,application_id TEXT NOT NULL REFERENCES applications(id),kind TEXT NOT NULL,prompt TEXT NOT NULL,topic TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',answer TEXT,payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS answers(id TEXT PRIMARY KEY,topic TEXT NOT NULL,question TEXT NOT NULL,value TEXT NOT NULL,scope TEXT NOT NULL,company TEXT,job TEXT,version INTEGER NOT NULL,approved_at TEXT NOT NULL,source TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,application_id TEXT,action TEXT NOT NULL,actor TEXT NOT NULL,created TEXT NOT NULL,details TEXT NOT NULL);
  CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'Audit is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'Audit is append-only'); END;`);
  }
  transaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth++;
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.transactionDepth--;
    }
  }
  getSetting<T>(key: string, fallback: T): T {
    const r = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key);
    return r ? JSON.parse(String(r.value)) : fallback;
  }
  setting(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  audit(
    id: string | null,
    action: string,
    details: unknown = {},
    actor = "worker",
  ) {
    this.db
      .prepare(
        "INSERT INTO events(application_id,action,actor,created,details) VALUES(?,?,?,?,?)",
      )
      .run(
        id,
        action,
        actor,
        new Date().toISOString(),
        JSON.stringify(details),
      );
  }
  profile() {
    return this.getSetting<Profile | null>("profile", null);
  }
  evidence(): Evidence[] {
    return this.db
      .prepare("SELECT * FROM evidence")
      .all()
      .map((r) => ({ id: String(r.id), ...JSON.parse(String(r.data)) }));
  }
  saveProfile(input: unknown) {
    const p = profileSchema.parse(input);
    this.transaction(() => {
      this.setting("profile", p);
      this.audit(null, "profile.approved", { hash: hash(p) }, "user");
    });
    return p;
  }
  addEvidence(input: unknown) {
    const data = evidenceSchema.parse(input);
    const id = randomUUID();
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO evidence VALUES(?,?)")
        .run(id, JSON.stringify(data));
      this.audit(
        null,
        "evidence.approved",
        { id, source: data.source },
        "user",
      );
    });
    return id;
  }
  list(): Application[] {
    return this.db
      .prepare("SELECT * FROM applications ORDER BY created DESC")
      .all()
      .map((r) => this.decode(r));
  }
  decode(r: any): Application {
    return {
      ...JSON.parse(r.data),
      id: r.id,
      status: r.status,
      created: r.created,
      updated: r.updated,
      lease_until: r.lease_until,
      attempts: r.attempts,
    };
  }
  get(id: string) {
    const r = this.db.prepare("SELECT * FROM applications WHERE id=?").get(id);
    if (!r) throw new Error("Application not found");
    return this.decode(r);
  }
  importJob(input: unknown) {
    const job = jobSchema.parse(input);
    const url = new URL(job.url);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("HTTP(S) job URL required");
    url.hash = "";
    for (const key of [...url.searchParams.keys()])
      if (/^utm_|^(ref|source)$/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    job.url = url.toString();
    const fingerprint = hash(
      job.requisition
        ? `${normalize(job.company)}:${normalize(job.requisition)}`
        : job.url,
    );
    const existing = this.db
      .prepare("SELECT id FROM applications WHERE fingerprint=?")
      .get(fingerprint);
    if (existing) return { id: String(existing.id), duplicate: true };
    const id = randomUUID(),
      now = new Date().toISOString();
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO applications(id,fingerprint,status,data,created,updated) VALUES(?,?,?,?,?,?)",
        )
        .run(
          id,
          fingerprint,
          "DISCOVERED",
          JSON.stringify({ ...job, score: 0, reason: "", checkpoint: {} }),
          now,
          now,
        );
      this.audit(id, "job.imported", {}, "user");
    });
    return { id, duplicate: false };
  }
  transition(id: string, next: string, patch: Record<string, unknown> = {}) {
    this.transaction(() => {
      const a = this.get(id);
      if (
        !edges[a.status]?.includes(next) &&
        !(
          next === "RETRYABLE_ERROR" &&
          ![
            "SUBMITTING",
            "SUBMITTED",
            "SUBMISSION_UNKNOWN",
            "REJECTED_BY_USER",
          ].includes(a.status)
        )
      )
        throw new Error(`Invalid transition ${a.status} → ${next}`);
      this.db
        .prepare("UPDATE applications SET status=?,data=?,updated=? WHERE id=?")
        .run(
          next,
          JSON.stringify({ ...a, ...patch }),
          new Date().toISOString(),
          id,
        );
      this.audit(id, "state.changed", { from: a.status, to: next });
    });
  }
  questions(): Array<Record<string, any>> {
    return this.db
      .prepare(
        "SELECT q.*,json_extract(a.data,'$.company') company,json_extract(a.data,'$.title') title FROM questions q JOIN applications a ON a.id=q.application_id ORDER BY q.rowid DESC",
      )
      .all()
      .map((r) => ({ ...r, payload: JSON.parse(String(r.payload)) }));
  }
  ask(
    id: string,
    kind: string,
    prompt: string,
    topic: string,
    payload: unknown = {},
  ) {
    const old = this.db
      .prepare(
        "SELECT id FROM questions WHERE application_id=? AND kind=? AND topic=? AND state='pending'",
      )
      .get(id, kind, topic);
    if (old) return String(old.id);
    const q = randomUUID();
    this.db
      .prepare(
        "INSERT INTO questions(id,application_id,kind,prompt,topic,payload) VALUES(?,?,?,?,?,?)",
      )
      .run(q, id, kind, prompt, topic, JSON.stringify(payload));
    this.audit(id, "question.requested", { question_id: q, kind });
    return q;
  }
  answerFor(a: Application, topic: string, question: string) {
    return this.db
      .prepare(
        "SELECT * FROM answers WHERE topic=? AND question=? AND (scope='global' OR (scope='company' AND company=?) OR (scope='job' AND job=?)) ORDER BY CASE scope WHEN 'job' THEN 0 WHEN 'company' THEN 1 ELSE 2 END, rowid DESC LIMIT 1",
      )
      .get(topic, normalize(question), normalize(a.company), a.id);
  }
  resolve(
    qid: string,
    input: { decision: string; answer?: string; scope?: string },
  ) {
    return this.transaction(() => {
      const q = this.db.prepare("SELECT * FROM questions WHERE id=?").get(qid);
      if (!q || q.state !== "pending")
        throw new Error("Question is no longer pending");
      const a = this.get(String(q.application_id)),
        payload = JSON.parse(String(q.payload));
      if (input.decision === "hold") {
        this.audit(a.id, "question.held", { qid }, "user");
        return;
      }
      if (input.decision === "reject") {
        if (q.kind === "submission") this.transition(a.id, "REJECTED_BY_USER");
        else if (q.kind === "resume")
          this.transition(a.id, "NEEDS_MANUAL_REVIEW", {
            reason:
              "Résumé changes requested. Edit the template or profile and regenerate.",
            checkpoint: { ...a.checkpoint, resumeApproved: false },
          });
        else throw new Error("Use Hold for this review");
      } else if (input.decision === "approve") {
        if (q.kind === "answer") {
          if (!input.answer?.trim()) throw new Error("Answer required");
          const scope = input.scope || "job";
          if (!["job", "company", "global"].includes(scope))
            throw new Error("Invalid scope");
          const aid = randomUUID();
          this.db
            .prepare("INSERT INTO answers VALUES(?,?,?,?,?,?,?,?,?,?)")
            .run(
              aid,
              q.topic,
              normalize(String(q.prompt)),
              input.answer,
              scope,
              normalize(a.company),
              a.id,
              1,
              new Date().toISOString(),
              "dashboard",
            );
          this.transition(a.id, "READY_TO_RESUME");
          this.audit(
            a.id,
            "answer.approved",
            { answerId: aid, questionId: qid, scope },
            "user",
          );
          // Only exact questions in the explicitly approved scope may unblock together.
          for (const other of this.questions().filter(
            (r) =>
              r.kind === "answer" &&
              r.state === "pending" &&
              r.id !== qid &&
              r.topic === q.topic &&
              normalize(r.prompt) === normalize(String(q.prompt)),
          )) {
            const waiting = this.get(String(other.application_id));
            if (waiting.status !== "WAITING_FOR_USER") continue;
            const reusable = this.answerFor(
              waiting,
              String(q.topic),
              String(q.prompt),
            );
            if (reusable?.id !== aid) continue;
            this.db
              .prepare(
                "UPDATE questions SET state='reused',answer=? WHERE id=?",
              )
              .run(input.answer, String(other.id));
            this.transition(waiting.id, "READY_TO_RESUME");
            this.audit(waiting.id, "answer.reused", {
              answerId: aid,
              questionId: other.id,
              approvedVia: qid,
              scope,
            });
          }
        } else if (q.kind === "resume") {
          if (a.status !== "RESUME_VALIDATED")
            throw new Error("Stale resume review");
          if (
            payload.pdfHash &&
            payload.pdfHash !== a.checkpoint.artifact?.pdfHash
          )
            throw new Error("Reviewed résumé has changed");
          this.transition(a.id, "READY_TO_APPLY", {
            checkpoint: { ...a.checkpoint, resumeApproved: true },
          });
        } else if (q.kind === "submission") {
          if (
            a.status !== "WAITING_FOR_SUBMISSION_APPROVAL" ||
            payload.bundleHash !== hash(a.checkpoint.bundle)
          )
            throw new Error("Review is stale");
          this.transition(a.id, "SUBMITTING", {
            checkpoint: {
              ...a.checkpoint,
              approval: {
                bundleHash: payload.bundleHash,
                at: new Date().toISOString(),
              },
            },
          });
        } else if (q.kind === "manual") {
          throw new Error(
            "Manual portal execution is not supported; record progress outside this automated workflow",
          );
        } else throw new Error("Unsupported question kind");
      } else throw new Error("Invalid decision");
      this.db
        .prepare("UPDATE questions SET state=?,answer=? WHERE id=?")
        .run(input.decision, input.answer || null, qid);
      this.audit(
        a.id,
        "question.resolved",
        { qid, decision: input.decision, scope: input.scope, payload },
        "user",
      );
    });
  }
  lease() {
    return this.transaction(() => {
      const now = Date.now();
      for (const r of this.db
        .prepare(
          "SELECT id,status FROM applications WHERE lease_until>0 AND lease_until<?",
        )
        .all(now)) {
        const a = this.get(String(r.id));
        if (a.status === "SUBMITTING")
          this.transition(a.id, "SUBMISSION_UNKNOWN");
        else if (
          ["APPLYING", "RESUME_PLANNED", "RESUME_GENERATED"].includes(a.status)
        )
          this.transition(a.id, "RETRYABLE_ERROR", {
            reason: "Worker interrupted; safe retry required",
          });
        this.db
          .prepare("UPDATE applications SET lease_until=0 WHERE id=?")
          .run(a.id);
      }
      const r = this.db
        .prepare(
          "SELECT * FROM applications WHERE status IN ('DISCOVERED','QUALIFIED','READY_TO_APPLY','READY_TO_RESUME','SUBMITTING') AND lease_until=0 ORDER BY created LIMIT 1",
        )
        .get();
      if (!r) return null;
      this.db
        .prepare("UPDATE applications SET lease_until=? WHERE id=?")
        .run(now + 180000, String(r.id));
      return this.decode(r);
    });
  }
  release(id: string) {
    this.db.prepare("UPDATE applications SET lease_until=0 WHERE id=?").run(id);
  }
  retry(id: string) {
    const a = this.get(id);
    if (a.attempts >= 3)
      throw new Error("Retry limit reached; manual intervention required");
    this.transaction(() => {
      this.transition(
        id,
        a.checkpoint.artifact && a.checkpoint.resumeApproved
          ? "READY_TO_RESUME"
          : "QUALIFIED",
      );
      this.db
        .prepare("UPDATE applications SET attempts=attempts+1 WHERE id=?")
        .run(id);
    });
  }
  regenerate(id: string) {
    this.transaction(() => {
      const a = this.get(id);
      if (
        a.lease_until > Date.now() ||
        ![
          "RESUME_VALIDATED",
          "READY_TO_APPLY",
          "WAITING_FOR_USER",
          "WAITING_FOR_SUBMISSION_APPROVAL",
          "NEEDS_MANUAL_REVIEW",
          "RETRYABLE_ERROR",
        ].includes(a.status)
      )
        throw new Error(
          "Cannot regenerate while processing or after a submission may have started",
        );
      this.db
        .prepare(
          "UPDATE questions SET state='superseded' WHERE application_id=? AND state='pending'",
        )
        .run(id);
      this.transition(id, "QUALIFIED", {
        checkpoint: {},
        reason: "Résumé regeneration requested",
      });
      this.audit(id, "resume.regeneration_requested", {}, "user");
    });
  }
  reconcile(id: string) {
    this.transaction(() => {
      const a = this.get(id);
      if (a.status !== "SUBMISSION_UNKNOWN" || a.adapter !== "test")
        throw new Error(
          "Only uncertain local test submissions support receipt reconciliation",
        );
      const receipt = this.getSetting(`receipt:${id}`, null);
      if (!receipt)
        throw new Error(
          "No confirmed receipt found. Application remains uncertain; do not resubmit.",
        );
      this.transition(id, "SUBMITTED", {
        reason: "Confirmed by persisted local test portal receipt",
      });
      this.audit(id, "submission.reconciled", { receipt }, "user");
    });
  }
  snapshot() {
    return {
      applications: this.list(),
      questions: this.questions(),
      profile: this.profile(),
      evidence: this.evidence(),
      paused: this.getSetting("paused", true),
      events: this.db
        .prepare("SELECT * FROM events ORDER BY id DESC LIMIT 100")
        .all(),
    };
  }
}
