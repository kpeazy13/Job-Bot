# Launchpad — local internship application assistant

A local-first implementation of [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md): a mobile-friendly dashboard, trusted applicant data, evidence-linked résumé preparation, persistent SQLite queues, scoped answers, and explicit approval gates.

## Run

Requires **Node.js 24+**.

```powershell
npm install
npm run browser:install
npm start
```

Open **http://127.0.0.1:3210** and paste the access token printed in the terminal. A fresh token is generated at each launch unless `DASHBOARD_TOKEN` is supplied in the environment. The worker starts paused.

1. In **Profile & evidence**, enter and explicitly approve your real contact information, education, experience bullets, and supporting sources. No applicant facts are preloaded.
2. In **Résumé studio**, import a trusted, self-contained `.tex` template or use the included starter. Put `% BEGIN AGENT CONTENT` and `% END AGENT CONTENT` around the replaceable body. Preamble and surrounding content remain unchanged.
3. Install a TeX distribution with `latexmk`, `pdflatex`, `geometry`, and `lmodern` available on `PATH`. Restart the terminal after installation. LaTeX is compiled with shell escape disabled, a timeout, and restrictive TeX file-access settings. Only use templates you trust; TeX is executable input, not a complete sandbox.
4. Add a posting with its employer, description, location, and requisition ID. Resume the agent.
5. Review generated PDFs in **Review inbox**, approve answers with a selected reuse scope, and review the exact submission bundle.

## What works

- Local HTTP service bound exclusively to loopback, token sign-in, HttpOnly/SameSite cookies, origin and host validation, login throttling, request-size limits, and content security policy.
- Responsive overview, application pipeline, review inbox, profile/evidence forms, résumé template editor, artifact downloads, audit trail, and JSON export.
- Greenhouse job discovery from user-selected public boards, scheduled every 15 minutes while running, with internship/co-op filtering, persisted cooldowns, feed-size limits, and rate-limit handling.
- SQLite persistence, transactional question approvals, append-only audit events, stable posting deduplication, durable leases, bounded user-triggered retries, independent waiting applications, pause and browser-stop controls.
- Configurable role/location filtering and transparent heuristic relevance scores. Scores are not eligibility determinations.
- Verbatim approved evidence selection, LaTeX escaping, per-job artifact directories and content hashes, PDF page/text/contact validation, and mandatory résumé review.
- Exact-question answer retrieval with job/company/global scope checks. Similar wording does not automatically authorize reuse.
- One scoped answer approval can unblock compatible waiting questions. Résumé changes can be requested, and regeneration invalidates older pending approvals. Uncertain local test submissions can be reconciled against saved receipts.
- A dedicated Playwright profile and **local test portal adapter** demonstrating filling, PDF upload, question resolution, exact-content final approval, receipt confirmation, and uncertain-submission handling.
- Optional structured AI selection of approved evidence IDs. All generated bullets remain the approved verbatim text.

## Current boundaries

This is a runnable initial V1, not a finished unattended multi-portal applicant. Real postings are supported for résumé preparation; real employer portals deliberately enter manual review because no production adapter has been validated. No real applications have been submitted during development.

- Real Greenhouse/Lever/Workday application adapters, portal authentication recovery, notifications, semantic narrative drafting, and bundled LaTeX dependencies remain future work.
- Paste job descriptions manually or configure a Greenhouse board in **Job discovery**. Deduplication uses normalized employer + requisition when present, otherwise a cleaned posting URL; cross-posts without shared identifiers require manual checking.
- Template imports currently accept one self-contained `.tex` file. The replaceable body uses a simple standard layout; complex existing macros may require adapting that region.
- Missing TeX, invalid PDF layout, absent profile data, and AI errors become visible retryable errors. Fix the cause, then use **Retry after fixing issue** in application details. No blind automated repair changes factual content.
- `SUBMISSION_UNKNOWN` never retries automatically. For the local test portal, **Check saved test portal receipt** confirms a persisted receipt without clicking submit again. Production reconciliation is not implemented.
- Exact-answer matching is intentionally conservative. Global reuse is allowed only when you explicitly choose it. There are no automated sensitive eligibility/legal answers.
- SQLite and browser profile files are not encrypted by this app. Use OS account protections and full-disk encryption. No password collection or secrets in the database.

## Local test workflow

Select **Local test portal** when adding a posting and use `http://127.0.0.1:3210/test-portal` as its URL (adjust if `PORT` differs). Complete normal résumé generation and review. The test portal asks one motivation question and waits for submission approval. It never contacts an employer. Keep the dedicated browser open while reviewing.

The browser integration test uses synthetic data and an upload fixture to exercise the approval/submission boundary without installing TeX. It does **not** substitute for an actual PDF compilation check.

## Job discovery

In **Job discovery**, add an employer name and its board token from `job-boards.greenhouse.io/<token>`. By default, only titles explicitly containing intern/internship/co-op are imported. Disable that filter to consider all roles; your profile role/location preferences are still applied by the worker. Prospect-only entries and malformed postings are skipped. Each board syncs independently, with a minimum one-minute manual cooldown and 15-minute automatic interval. The implementation reads the documented [Greenhouse public Job Board API](https://docs.greenhouse.io/job-board.html) and never posts applications to that API. Mocked feed tests cover normalization, deduplication, disabled sources, source failures, and HTTP 429 handling; no employer board is configured by default.

## Configuration

Set environment variables before `npm start`; `.env` files are not loaded automatically.

| Variable           | Default           | Purpose                                                   |
| ------------------ | ----------------- | --------------------------------------------------------- |
| `PORT`             | `3210`            | Loopback service port                                     |
| `DATA_DIR`         | `./data`          | SQLite, artifacts, dedicated browser profile              |
| `DASHBOARD_TOKEN`  | Random per launch | Sign-in token; set a strong secret for persistence        |
| `PUBLIC_ORIGIN`    | Local URL         | Exact HTTPS origin of your private tunnel                 |
| `BROWSER_HEADLESS` | `false`           | Set `true` to hide the dedicated browser                  |
| `AI_ENABLED`       | `false`           | Explicitly enable remote AI evidence selection            |
| `OPENAI_API_KEY`   | Unset             | API credential supplied through environment               |
| `OPENAI_MODEL`     | Unset             | Structured-output-capable model available to your account |

When AI is enabled, posting text and approved experience titles/bullets/skills are sent to the OpenAI Responses API. Contact profile fields, evidence source URLs, cookies, and portal credentials are not sent. The request uses `store: false`; evidence IDs are validated locally. API errors stop the current application for review. No AI calls are made by the test suite. Integration format follows the [official structured outputs documentation](https://developers.openai.com/api/docs/guides/structured-outputs).

For phone access, use a private HTTPS tunnel or private-network reverse proxy to the loopback service. Set `PUBLIC_ORIGIN` to that exact HTTPS origin and preserve its Host header. This repository does not provision a tunnel. Do not expose the process directly or remove authentication. With remote HTTPS configured, sign in through that HTTPS address so the Secure cookie works.

Keep the laptop awake, the process running, and its network connected. Restart preserves SQLite and artifacts, invalidates browser sign-in sessions to the dashboard, and pauses work. Expired leases are reclaimed after resuming; submissions that may have started become unknown instead of being replayed.

## Data and development

```text
src/store.ts       Schema, states, approvals, leases, audit
src/resume.ts      Planning, LaTeX rendering/compilation, PDF validation
src/ai.ts          Optional constrained evidence selection
src/browser.ts     Dedicated browser and explicit local adapter
src/worker.ts      Persistent queue processor
src/scout.ts       Public Greenhouse discovery, filtering, cooldowns
src/server.ts      Authenticated HTTP API and test portal
public/           Responsive dashboard, no frontend build step
tests/            Domain and real-browser integration tests
data/             Private runtime data, excluded from git
```

Use **Export data** for profile, evidence, applications, answers, and complete audit history. Download artifacts separately. Back up the entire data directory with the service stopped for a complete portable copy. Profile details and the template can be edited in the UI; evidence and approval history are append-only in this version. To permanently delete all local records, stop the process and remove the configured `DATA_DIR`, including its browser profile. There is no per-record audit deletion UI yet.

```powershell
npm run check
npm test
npm run format
```

Tests cover deduplication, invalid transitions, audit immutability, scoped reuse, approval hashes, submission replay prevention, lease recovery, retry limits, unsupported AI evidence, authentication/CSRF, mobile overflow, and the local browser workflow. Browser tests require the Playwright installation and write screenshots to ignored `test-results/`. Temporary test databases are isolated from your real `data/` directory.
