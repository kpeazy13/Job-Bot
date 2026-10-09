# Internship Application Agent — Project Context

**Status:** Design specification / pre-implementation  
**Last updated:** October 8, 2026  
**Primary objective:** Build a local-first, AI-assisted internship application system that discovers relevant postings, tailors a truthful LaTeX résumé for each posting, fills applications in a dedicated browser, and asynchronously requests user input on a phone when necessary.

> This document records proposed design decisions, not claims that the system already exists or that any application has been submitted. Use it as the starting context for an AI coding agent. Confirm choices as implementation progresses.

## 1. Product vision

The user wants to leave their computer running while away (for example, at the gym). The system should process internship applications with minimal supervision. When it encounters a genuinely new question, uncertainty, authentication challenge, or final-submission checkpoint, it should queue the issue and allow the user to respond from a phone. The agent should keep working on other applications rather than blocking globally.

The system should learn from **explicitly approved answers**, reusing them when relevant and appropriately scoped. It should never invent applicant facts or silently alter material representations.

### Primary use cases

1. Discover and deduplicate suitable internship openings, focusing initially on software engineering, embedded systems, hardware/ECE, controls, and related roles.
2. Score postings against user-defined preferences and actual qualifications.
3. Tailor a one-page résumé from a canonical LaTeX template and evidence-backed experience bank; compile a separate PDF per job.
4. Navigate company application portals through a dedicated local browser session.
5. Auto-fill approved factual information and reuse approved answers to semantically equivalent questions.
6. Queue novel questions and user approvals on a mobile-friendly dashboard; resume the relevant application after a response.
7. Keep processing independent jobs while some applications wait for input.
8. Track every application, submitted artifact, answer provenance, and state transition; prevent duplicate submissions.

## 2. Architectural decision: local-first, browser-scoped control

**Preferred V1:** Run the orchestrator and browser controller on the user's own computer, using **Playwright** with a **dedicated browser profile**. Do **not** give the language model unrestricted operating-system mouse/keyboard, shell, files, or personal-browser access.

**Why local-first:** Easier access to existing job-portal sign-ins, files, and LaTeX tooling; simpler debugging; greater direct control over where data is stored.

**Tradeoffs:** A local computer must remain awake and connected. Local does **not** automatically mean safer: an unsandboxed local agent may have a larger blast radius than an isolated cloud browser. Keep the browser and local service permissions narrow. Cloud execution may be reconsidered in a later release.

**Phone interaction:** Prefer a secure mobile web dashboard for questions and approvals, not continuous remote-desktop control. Remote desktop is an optional troubleshooting fallback.

### Proposed high-level flow

```text
Job sources / career portals
            |
            v
   Job scout + deduplicator
            |
            v
 Qualification / relevance filter
            |
            v
 Job-specific resume planner <--- Evidence-backed applicant profile
            |
            v
 LaTeX generator -> PDF compiler -> validation
            |
            v
     Application queue
            |
            v
 Local Playwright browser agent <--- Approved answer/context store
            |
      +-----+--------------------+
      |                          |
      v                          v
Known/safe response      New/ambiguous question
      |                          |
      v                          v
Fill and continue         Mobile question queue
                                 |
                                 v
                         User edits/approves
                                 |
                                 v
                         Save provenance + resume

All stages -> append-only audit events, status, and stored artifacts
Final submission -> explicit user approval in V1
```

## 3. Core services

### A. Job Scout
- Import listings from user-selected job boards and company career pages through permitted access methods.
- Normalize employer, job title, location, URL, description, requisition ID, and requirements.
- Deduplicate cross-posted roles and roles already applied to.
- Filter according to preferences (internship season, roles, geography, eligibility, etc.).
- Respect site policies, rate limits, and access restrictions; do not bypass CAPTCHAs, MFA, or anti-bot controls.

### B. Resume Tailor
- Accept the user's **original LaTeX source** as the formatting source of truth.
- Maintain an expanded bank of **verified** experiences, skills, projects, metrics, and approved bullet variants, beyond what fits on one page.
- Extract priorities from each job description and produce a structured `resume_plan.json` describing selected evidence, bullets, keyword emphasis, and ordering.
- Modify only allowed content portions of the template, rather than rewriting all LaTeX indiscriminately.
- Select and rewrite bullets for relevance while keeping claims factual; never insert unsupported skills, invented metrics, or fictitious work.
- Compile a unique `.tex` and `.pdf` for each application using a local TeX toolchain (`latexmk` or equivalent).
- Validate successful compilation, correct contact details, selectable/extractable PDF text, page count (normally one page), and output existence before upload.
- If compilation/formatting fails, retry bounded, safe repairs; otherwise queue a review.
- Record the precise generated PDF and source used for each application.

### C. Application Agent
- Automate a dedicated browser profile with Playwright; keep normal personal browser sessions separate.
- Parse application fields and map them to explicit, approved profile facts or stored answers.
- Limit model-invoked actions to an allowlist, such as `open_url`, `read_page`, `click_element`, `fill_field`, `select_option`, `upload_resume`, `request_user_input`, and `pause_application`.
- Validate target elements and page state before interacting; avoid blind clicks.
- Ask about unfamiliar questions, uncertainty, and sensitive attestations. Never guess eligibility, sponsorship, legal, demographic, or other material facts.
- Preserve application progress and resume safely after interruptions; note that some portals cannot restore partially completed pages automatically.
- **Require explicit user approval before final submission for V1.** A later configurable policy may permit limited auto-submission after testing and explicit authorization.

### D. Context and Answer Engine
Store four kinds of context with clear boundaries:

1. **Global profile:** Applicant identity/contact info, education, approved factual claims, skills and evidence, location preferences, and other reusable facts.
2. **Company context:** Employer-specific motivation statements, portal details, previously approved company answers, and submission history.
3. **Job context:** Posting text, requisition ID, relevant competencies, generated résumé, current application state, and answers used.
4. **Question library:** Canonical semantic question/topic, exact encountered question, approved answer, scope (`global`, `company`, or `job`), reuse rules, source, version, and approver.

Important distinction:
- **Exact facts:** Reuse verbatim and never creatively adapt (e.g., graduation date, work authorization).
- **Draftable narrative answers:** May be adapted to a genuinely equivalent question if permitted, while preserving facts.
- **High-impact or sensitive answers:** Use an explicitly authorized exact value or ask, and require suitable review.

Semantic similarity is only a retrieval aid, **not proof that two questions are interchangeable**. Confirm company scope, intent, qualifiers, and answer constraints before reuse. Do not automatically propagate company-specific answers to other employers.

### E. Mobile Question Queue
- Display outstanding questions, model drafts, source evidence, and company/job identity.
- Support **Approve**, **Edit**, **Answer manually**, **Skip/hold**, and **Open application for manual intervention**.
- Allow the user to decide whether an approved response may be reused globally, only for the company, or only for the posting.
- Group duplicates so a single authorized response can unblock multiple compatible applications.
- Make notifications optional and configurable; minimize interruptions.
- Keep a queue of approvals for final submission and tailored résumés when required.
- Access the dashboard over authenticated HTTPS or a secure private tunnel; never expose an unauthenticated laptop API to the public internet.

### F. Orchestrator and Audit System
- Manage a persistent queue and independently track each application.
- Continue unrelated applications while one is waiting for user input.
- Prevent double submission through stable portal/application identifiers and idempotency checks.
- Record each state transition, webpage/field snapshot as appropriate, generated artifacts, inputs, and provenance.
- Implement bounded retries, recovery, timeouts, resource limits, and manual escalation.
- Limit browser concurrency to avoid overloading the laptop or triggering portal defenses.

## 4. Suggested technology stack (provisional)

| Layer | Proposed choice | Rationale |
|---|---|---|
| Browser control | Playwright | Deterministic, browser-scoped automation |
| Application orchestrator | Python or TypeScript | Either works; choose one primary runtime initially |
| AI reasoning | LLM API with structured outputs | Job analysis, field classification, safe draft generation |
| Local persistence | SQLite (V1) | Simple transactional storage and auditability |
| Background job processing | Persistent DB-backed worker queue | Resume after crashes; independent jobs |
| Phone dashboard | Mobile-responsive web app | Review questions and approvals anywhere |
| Remote access | Authenticated tunnel/private network | Avoid direct exposure of development server |
| LaTeX compiler | `latexmk` + installed TeX distribution | Reliable automated PDF creation |
| Files/artifacts | Local job-specific directories | Traceability and reproducibility |
| Notifications | Optional push/email integration | Alerts for actionable queued work |

**Implementation preference:** A single local backend + SQLite + one browser worker + simple web dashboard is enough for the first prototype. Avoid microservices until needed.

## 5. Resume tailoring rules

1. A master résumé template remains immutable; each job gets a generated copy.
2. All bullet text and skills must map to an approved experience or evidence record.
3. Never fabricate tools, numbers, responsibilities, employers, dates, or qualifications.
4. Tailor by selecting, ordering, and rephrasing supported content—not keyword stuffing.
5. Prefer clear, natural ATS-friendly wording and a text-readable PDF.
6. Do not make invisible text or deceptive keyword insertions.
7. If the job requires a skill absent from the evidence bank, do not include it; optionally flag the gap.
8. Preserve the output `.tex`, `.pdf`, résumé plan, and metadata with the relevant application.
9. Initially make revised résumés reviewable before upload/submission. Low-risk automatic résumé approval may be a later user-controlled option.

Example structure:

```text
resume/
  master_template.tex
  profile.yaml
  experience_bank.yaml
  generated/
    nvidia_gpu_intern_12345/
      resume_plan.json
      resume.tex
      resume.pdf
      validation.json
```

Example résumé plan:

```json
{
  "job_id": "nvidia_gpu_intern_12345",
  "focus": "systems software",
  "priority_keywords": ["C++", "Linux", "testing"],
  "selected_bullet_ids": ["research_test_01", "project_cpp_02"],
  "unsupported_keywords": ["CUDA"],
  "new_factual_claims_allowed": false
}
```

The identifiers and keywords above are illustrative, not assertions about the user's verified skills.

## 6. Application state machine

```text
DISCOVERED
  -> FILTERED_OUT | QUALIFIED
QUALIFIED
  -> RESUME_PLANNED
  -> RESUME_GENERATED
  -> RESUME_VALIDATED
  -> READY_TO_APPLY
READY_TO_APPLY
  -> APPLYING
APPLYING
  -> WAITING_FOR_USER
  -> WAITING_FOR_AUTH
  -> WAITING_FOR_SUBMISSION_APPROVAL
  -> RETRYABLE_ERROR
  -> NEEDS_MANUAL_REVIEW
WAITING_FOR_USER -> READY_TO_RESUME -> APPLYING
WAITING_FOR_AUTH -> READY_TO_RESUME -> APPLYING
WAITING_FOR_SUBMISSION_APPROVAL -> SUBMITTING | REJECTED_BY_USER
SUBMITTING -> SUBMITTED | SUBMISSION_UNKNOWN
RETRYABLE_ERROR -> READY_TO_RESUME | NEEDS_MANUAL_REVIEW
```

`SUBMISSION_UNKNOWN` is important: if the page times out after pressing Submit, **do not blindly click Submit again**. Inspect portal status first.

The worker should lease a job temporarily, update checkpoints durably, and reclaim stale work after a crash. Each application can wait independently.

## 7. Proposed minimal data model

| Entity | Key fields |
|---|---|
| `applicant_profiles` | `id`, `profile_version`, approved facts |
| `experience_evidence` | `id`, project/role, verified facts, skills, bullet variants |
| `companies` | `id`, normalized name, portal metadata |
| `job_postings` | `id`, company, requisition ID, URL, description, fingerprint |
| `applications` | `id`, job ID, status, timestamps, portal session reference |
| `resume_artifacts` | `id`, application ID, LaTeX path, PDF path, plan path, hashes, validation result |
| `question_templates` | `id`, normalized intent/topic, sensitivity, allowed scope |
| `approved_answers` | `id`, template ID, company/job scope, answer, adaptation rule, source, version, approval timestamp |
| `question_requests` | `id`, application ID, original question, suggested answer, state, priority |
| `application_answers` | `id`, application ID, question, final value, linked approved answer, provenance |
| `audit_events` | `id`, application ID, action, actor, timestamp, result, details |
| `submission_approvals` | `id`, application ID, reviewed artifact hash, approval timestamp, decision |

Design guidance: Store passwords/tokens in an OS credential store or appropriate secrets manager, **not** in SQLite in plaintext or in LLM prompts. Avoid storing unnecessary sensitive demographic data and raw page dumps. Encryption, retention limits, and deletion/export controls matter even for a local-first tool.

### Example approved answer record

```json
{
  "company_id": "nvidia",
  "topic": "company_interest",
  "original_question": "Why are you interested in NVIDIA?",
  "answer": "<user-approved narrative here>",
  "scope": "company",
  "approved_by_user": true,
  "adaptation_allowed": true,
  "source": "mobile_question_queue",
  "version": 1
}
```

## 8. Example asynchronous workflow

1. User launches the local agent and leaves home.
2. Scout finds multiple suitable postings and eliminates duplicates.
3. Résumé Tailor generates and validates one role-specific PDF per application.
4. Agent applies to Posting A using approved data.
5. At Posting B, the portal asks a novel question. The application transitions to `WAITING_FOR_USER`, and the question appears on the user's phone.
6. Agent continues Posting C and D without waiting on B.
7. User edits and approves the suggested answer for B on the mobile dashboard.
8. The system stores the answer with the user's selected reuse scope and provenance.
9. Posting B resumes at its saved checkpoint; a later same-company equivalent question can reuse the approved answer if applicable.
10. Every completed application waits for explicit final-submit approval in V1; the system saves the submitted résumé and exact answers.

### Mobile dashboard example

```text
AMD — Firmware Engineering Intern
Question: Describe your experience with C/C++.
Draft: [generated from verified experience bank]

[Approve] [Edit] [Answer manually] [Hold]
Reuse scope: ( ) This job  ( ) AMD  ( ) Global

Other applications:
- Qualcomm: Applying
- NVIDIA: Awaiting final approval
- Apple: Resume validated
```

## 9. Safety, reliability, and privacy requirements

- **No invented applicant facts:** Unknown = ask user, not guess.
- **No unauthorized submissions:** Explicit final approval by default, tied to the exact job, answers, and résumé version.
- **No unrestricted computer access:** Keep Playwright confined to the dedicated browser and tightly control any local file reads/writes.
- **Prompt-injection defense:** Treat job descriptions, page text, and portal messages as untrusted content; they must not override system instructions or access secrets.
- **Credential hygiene:** User handles password entry, MFA, and CAPTCHA challenges; do not attempt bypasses.
- **Minimal exposure:** Never send passwords, session cookies, or unnecessary sensitive data to the LLM. Restrict remote dashboard access.
- **Portal compliance:** Respect applicable rules/terms and throttling; escalate sites that disallow automated applications.
- **Safe retries:** Log all retries and distinguish network failures from possible successful submissions.
- **Provenance:** For any answer, record where it came from, whether it was transformed, who approved it, and exactly what was submitted.
- **Data portability:** Allow user to inspect, export, edit, and delete their records.
- **Local uptime:** Document power/sleep/network prerequisites and restart behavior.

## 10. Development roadmap

### Milestone 1 — Trusted applicant data + résumé generation
- [ ] Import original LaTeX résumé and dependencies.
- [ ] Build applicant profile and evidence bank; review factual claims.
- [ ] Parse a pasted job description into requirements and priorities.
- [ ] Generate an evidence-linked résumé plan.
- [ ] Produce job-specific `.tex` and compile `.pdf`.
- [ ] Validate PDF and preserve artifacts.
- [ ] Manually inspect output from several diverse internship postings.

**Exit criteria:** Five distinct postings produce valid, truthful, readable, one-page PDFs without altering the master template.

### Milestone 2 — Application database + queue
- [ ] Implement SQLite schema and audit log.
- [ ] Implement job/posting normalization and deduplication.
- [ ] Implement application state machine and durable queue.
- [ ] Implement checkpointing, leases, failure recovery, and idempotency.

**Exit criteria:** Can simulate many independent applications, crashes, retries, and waiting states without losing or double-processing work.

### Milestone 3 — Browser automation for a limited portal
- [ ] Create a dedicated local Chrome/Chromium profile.
- [ ] Build allowlisted Playwright actions and field classification.
- [ ] Support uploading validated résumé PDFs.
- [ ] Implement one or two approved portal adapters/workflows.
- [ ] Stop for authentication, ambiguous questions, and final submission.

**Exit criteria:** Reliably completes sample/test applications through the review stage without making unsupported factual claims.

### Milestone 4 — Mobile approval + shared context
- [ ] Build responsive dashboard and secure authentication.
- [ ] Implement question requests, edits, approvals, and scoped answer persistence.
- [ ] Implement semantic answer retrieval with explicit applicability checks.
- [ ] Resume individual waiting applications after approval.
- [ ] Add optional actionable notifications.

**Exit criteria:** User can resolve a question from a phone, and a paused application resumes while other jobs continue.

### Milestone 5 — Job discovery + operational hardening
- [ ] Integrate permitted job sources.
- [ ] Add fit scoring and user-configurable filters.
- [ ] Add monitoring, alerting, pause-all/kill switch, rate limits, and recovery.
- [ ] Test longer unattended runs with explicit review gates.
- [ ] Evaluate when, if ever, narrowly authorized automatic submission is appropriate.

**Exit criteria:** Demonstrates a reliable, auditable end-to-end run across multiple jobs and portals.

## 11. Open decisions

1. **Primary language:** Python or TypeScript for orchestrator and browser automation?
2. **Mobile transport:** Private VPN/tunnel or securely hosted relay/dashboard?
3. **Notification method:** Push, email, or messaging integration?
4. **Job intake:** Start with a curated list of career URLs, job-board imports, or both?
5. **Resume template:** Existing LaTeX file structure, compiler, fonts, packages, and single-page constraints?
6. **Applicant facts:** Which values are verified globally and which need per-application confirmation?
7. **Answer reuse:** How strict should semantic matching and narrative adaptation be?
8. **Portal priority:** Which application platform to support first?
9. **Approvals:** Which resume changes require review, and should V1 always request final submission approval? (Current answer: yes.)
10. **Concurrency:** How many browser contexts should run safely on the local laptop?

## 12. Instructions for future coding agents

- Treat this document as a design baseline and **not** as proof the application or any data store already exists.
- Before coding, inspect the repository and propose a small milestone-aligned implementation plan.
- Preserve the local-first and browser-scoped security model unless explicitly changed by the user.
- Never assume facts about the applicant beyond verified source records.
- Favor typed interfaces, structured model outputs, testable deterministic code, and auditable state transitions.
- Keep all novel questions and consequential actions inside the explicit approval workflow.
- Produce narrowly scoped changes, unit/integration tests, and concise setup instructions.
- Ask for the original LaTeX source, verified experience bank, credentials setup, and portal selection when implementation needs them.

---

**Initial scope:** A local-first internship-application assistant with user-in-the-loop final submission and a persistent mobile question queue. The long-term aspiration is greater autonomy, but reliability, factuality, security, and user control take priority over raw application volume.
