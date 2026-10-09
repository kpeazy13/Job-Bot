let state,
  view = "overview",
  search = "",
  filter = "all";
const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const label = (s) =>
  s
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (s) => s.toUpperCase());
const pending = () => state.questions.filter((q) => q.state === "pending");
const badge = (s) =>
  `<span class="badge ${/WAITING|VALIDATED|ERROR|REVIEW|UNKNOWN/.test(s) ? "review" : s === "SUBMITTED" ? "done" : ""}">${esc(label(s))}</span>`;
let toastTimer;
function toast(message, error = false) {
  $("#toast").textContent = message;
  $("#toast").className = error ? "error" : "";
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 6000);
}
async function api(path, data) {
  const res = await fetch("/api/" + path, {
    method: data === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await res.json();
  if (res.status === 401) {
    $("#login").hidden = false;
    $("#workspace").hidden = true;
  }
  if (!res.ok) throw new Error(result.error || "Request failed");
  return result;
}
async function refresh(renderPage = true) {
  state = await api("state");
  $("#login").hidden = true;
  $("#workspace").hidden = false;
  $("#review-count").textContent = pending().length;
  $("#worker-status").textContent = state.paused
    ? "Agent paused"
    : "Agent running";
  $("#worker-status").className =
    "status-pill" + (state.paused ? "" : " running");
  $("#toggle-worker").textContent = state.paused
    ? "Resume agent"
    : "Pause agent";
  if (renderPage) render();
}
function intro(title, description) {
  return `<div class="intro"><div><p class="eyebrow">MAKE YOUR NEXT MOVE</p><h1>${title}</h1><p>${description}</p></div><span class="date-label">${new Date().toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}</span></div>`;
}
function empty(title, description, action = "") {
  return `<div class="empty"><div class="empty-icon">↗</div><h3>${title}</h3><p>${description}</p>${action}</div>`;
}
function table(apps) {
  if (!apps.length)
    return empty(
      "Your next opportunity starts here",
      "Add a job posting. Launchpad will help you prepare a truthful, tailored application.",
      "<button data-add-job>+ Add your first opportunity</button>",
    );
  return `<div class="table-wrap"><table><thead><tr><th>OPPORTUNITY</th><th>STATUS</th><th>FIT</th><th>DETAILS</th></tr></thead><tbody>${apps.map((a) => `<tr><td><strong>${esc(a.company)}</strong><small>${esc(a.title)} · ${esc(a.location || "Unspecified location")}</small></td><td>${badge(a.status)}</td><td>${a.score ? a.score + "%" : "—"}</td><td><button class="text-button" data-detail="${a.id}">View →</button></td></tr>`).join("")}</tbody></table></div>`;
}
function overview() {
  const apps = state.applications;
  return (
    intro(
      "A little closer to what’s next.",
      "A clear view of your applications, and the decisions that need you.",
    ) +
    `<div class="stats">${[
      ["In your pipeline", apps.length, "Every opportunity, in one place", "▤"],
      [
        "Ready for your review",
        pending().length,
        "Your input keeps things moving",
        "◉",
      ],
      [
        "In progress",
        apps.filter(
          (a) =>
            !["SUBMITTED", "FILTERED_OUT", "REJECTED_BY_USER"].includes(
              a.status,
            ),
        ).length,
        "Moving at your pace",
        "↗",
      ],
      [
        "Submitted",
        apps.filter((a) => a.status === "SUBMITTED").length,
        "Confirmed applications only",
        "✓",
      ],
    ]
      .map(
        ([title, value, note, icon]) =>
          `<div class="stat"><div class="stat-top">${title}<span class="stat-icon">${icon}</span></div><strong class="stat-value">${value}</strong><small>${note}</small></div>`,
      )
      .join(
        "",
      )}</div><div class="dashboard-grid"><div><section class="panel"><div class="panel-heading"><h2>Application pipeline</h2><button class="text-button" data-view="applications">View all →</button></div>${table(apps.slice(0, 5))}</section><section class="panel"><div class="panel-heading"><h2>Needs a moment of your time</h2><small>${pending().length} PENDING</small></div>${
      pending().length
        ? `<div class="panel-body">${pending()
            .slice(0, 3)
            .map(
              (q) =>
                `<div class="evidence-card"><h3>${esc(q.company)} <span class="badge review">${esc(label(q.kind))}</span></h3><p>${esc(q.prompt)}</p><button class="text-button" data-view="reviews">Review request →</button></div>`,
            )
            .join("")}</div>`
        : empty(
            "You’re all caught up",
            "Questions and approval requests will appear here when the agent needs your input.",
          )
    }</section></div><div class="dashboard-side"><section class="panel"><div class="panel-heading"><h2>Your launch checklist</h2><small>GETTING STARTED</small></div><div class="panel-body"><ol class="steps">${[
      [
        !!state.profile,
        "Build your factual foundation",
        "Add your verified contact and education details.",
        "profile",
      ],
      [
        !!state.evidence.length,
        "Give your experience a home",
        "Save projects, skills, and evidence-backed bullets.",
        "profile",
      ],
      [
        state.template.includes("BEGIN AGENT CONTENT"),
        "Prepare your résumé template",
        "Review the LaTeX template in Résumé studio.",
        "resume",
      ],
      [
        !!apps.length,
        "Find your first opportunity",
        "Paste a posting to start your pipeline.",
        "applications",
      ],
    ]
      .map(
        ([done, title, desc, target], i) =>
          `<li><span class="step-number">${done ? "✓" : i + 1}</span><div><button class="text-button" data-view="${target}"><strong>${title}</strong></button><p>${desc}</p></div></li>`,
      )
      .join(
        "",
      )}</ol></div></section><div class="note"><span class="leaf">❋</span><h3>Built around your real experience.</h3><p>Every résumé starts with facts you approve. Every application pauses for your final say.</p><p>Good opportunities deserve thoughtful applications.</p></div></div></div>`
  );
}
function reviews() {
  return (
    intro(
      "Your judgment. At the right moment.",
      "Review questions, tailored résumés, and final submission details.",
    ) +
    (pending().length
      ? pending()
          .map(
            (q) =>
              `<article class="review-card"><span class="badge review">${esc(label(q.kind))} review</span><h3>${esc(q.company)}</h3><small>${esc(q.title)}</small><p class="question">${esc(q.prompt)}</p>${q.kind === "answer" ? `<details><summary>Approved evidence</summary><pre>${esc((q.payload.evidence || []).map((e) => `${e.title}: ${e.bullet}`).join("\n\n") || "No supporting evidence available.")}</pre></details><form data-answer="${q.id}"><label>Your approved answer<textarea name="answer" rows="4" required placeholder="Write the answer you want used…"></textarea></label><div class="review-actions"><select name="scope" aria-label="Answer reuse scope"><option value="job">Only this job</option><option value="company">This company</option><option value="global">Global · exact same question</option></select><button>Approve answer →</button><button type="button" class="secondary" data-hold="${q.id}">Hold</button></div></form>` : q.kind === "resume" ? `<div class="artifact-links"><a href="/api/artifacts/${q.application_id}/resume.pdf" target="_blank" rel="noopener">Open PDF ↗</a><a href="/api/artifacts/${q.application_id}/resume.tex" target="_blank">LaTeX source ↗</a><a href="/api/artifacts/${q.application_id}/resume_plan.json" target="_blank">Evidence plan ↗</a></div><p class="muted">Validated: one page, extractable text, matching contact details.</p><div class="review-actions"><button data-approve="${q.id}">Approve résumé</button><button class="secondary" data-hold="${q.id}">Hold</button></div>` : q.kind === "submission" ? `<pre>${esc(JSON.stringify(q.payload.bundle, null, 2))}</pre><div class="artifact-links"><a href="/api/artifacts/${q.application_id}/resume.pdf" target="_blank" rel="noopener">Review exact résumé ↗</a></div><p class="muted">Approval authorizes one submission of the exact answers and PDF above.</p><div class="review-actions"><button data-approve="${q.id}">Approve submission</button><button class="secondary" data-reject="${q.id}">Reject</button></div>` : `<a href="${esc(q.payload.url)}" target="_blank" rel="noopener noreferrer">Open application for manual work ↗</a><p class="muted">This application stays in manual review. Launchpad will not submit it.</p>`}</article>`,
          )
          .join("")
      : empty(
          "Nothing waiting on you",
          "Keep the agent running to receive questions and review requests.",
        ))
  );
}
function profile() {
  const p = state.profile || {};
  return (
    intro(
      "Your experience is the source of truth.",
      "Only explicitly approved facts and evidence can be used in applications.",
    ) +
    `<div class="two-column"><section class="panel"><div class="panel-heading"><h2>Applicant profile</h2><small>${state.profile ? "APPROVED" : "NOT SET UP"}</small></div><form id="profile-form" class="panel-body"><div class="form-grid">${[
      ["name", "Full name"],
      ["email", "Email"],
      ["phone", "Phone"],
      ["location", "Location"],
    ]
      .map(
        ([key, title]) =>
          `<label>${title}<input name="${key}" value="${esc(p[key])}" ${["name", "email"].includes(key) ? "required" : ""} ${key === "email" ? 'type="email"' : ""}></label>`,
      )
      .join(
        "",
      )}</div><label>Education<textarea name="education" rows="3" placeholder="Degree, school, and graduation date — only facts you have verified">${esc(p.education)}</textarea></label><label>Preferred role keywords (comma-separated)<input name="roles" value="${esc((p.roles || []).join(", "))}" placeholder="software, firmware, embedded"></label><label>Preferred locations (comma-separated)<input name="locations" value="${esc((p.locations || []).join(", "))}" placeholder="Leave blank to consider every location"></label><label class="check"><input type="checkbox" name="approved" required>I verify these details and approve their use in my applications.</label><button>Save approved profile</button></form></section><div><section class="panel"><div class="panel-heading"><h2>Add verified experience</h2></div><form id="evidence-form" class="panel-body"><label>Project or role<input name="title" required placeholder="Project name · your role"></label><label>Approved résumé bullet<textarea name="bullet" required rows="3" placeholder="Describe what you actually did, using verified metrics only."></textarea></label><label>Supported skills (comma-separated)<input name="skills" required placeholder="C++, Linux, testing"></label><label>Evidence source<input name="source" required placeholder="Repository URL, document, or personal verification"></label><label class="check"><input type="checkbox" name="approved" required>I verify this claim and these skills.</label><button>Add evidence</button></form></section></div><section class="panel full-width"><div class="panel-heading"><h2>Evidence bank</h2><small>${state.evidence.length} VERIFIED RECORDS</small></div><div class="panel-body">${state.evidence.length ? state.evidence.map((e) => `<article class="evidence-card"><h3>${esc(e.title)}</h3><p>${esc(e.bullet)}</p><div class="chips">${e.skills.map((s) => `<span>${esc(s)}</span>`).join("")}</div><p class="muted">Source: ${esc(e.source)}</p></article>`).join("") : '<p class="muted">Your verified experience will appear here. No example applicant facts are preloaded.</p>'}</div></section></div>`
  );
}
function resume() {
  return (
    intro(
      "A résumé that stays true to you.",
      "Each posting gets its own source, evidence plan, validated PDF, and review.",
    ) +
    `<section class="panel"><div class="panel-heading"><h2>Master LaTeX template</h2><small>ORIGINAL PRESERVED PER GENERATION</small></div><form id="template-form" class="panel-body"><p class="muted">Paste your trusted, self-contained LaTeX template. Place one pair of <code>% BEGIN AGENT CONTENT</code> / <code>% END AGENT CONTENT</code> markers around the content that may be replaced. The rest remains unchanged. Requires a local TeX distribution and latexmk.</p><label>Import .tex file<input id="template-file" type="file" accept=".tex"></label><label>Template source<textarea name="template" class="code" spellcheck="false">${esc(state.template)}</textarea></label><button>Save master template</button></form></section><section class="panel"><div class="panel-heading"><h2>Generated artifacts</h2></div>${
      state.applications
        .filter((a) => a.checkpoint.artifact)
        .map(
          (a) =>
            `<div class="panel-body"><h3>${esc(a.company)} · ${esc(a.title)}</h3><div class="artifact-links"><a href="/api/artifacts/${a.id}/resume.pdf" target="_blank">PDF ↗</a><a href="/api/artifacts/${a.id}/resume.tex" target="_blank">Source ↗</a><a href="/api/artifacts/${a.id}/validation.json" target="_blank">Validation ↗</a></div></div>`,
        )
        .join("") ||
      empty(
        "No generated résumés yet",
        "Approve your profile and evidence, add a posting, then resume the agent.",
      )
    }</section>`
  );
}
function applications() {
  const apps = state.applications.filter(
    (a) =>
      (filter === "all" || a.status === filter) &&
      `${a.company} ${a.title}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    intro(
      "Every opportunity, in view.",
      "Track preparation, questions, and confirmed outcomes.",
    ) +
    `<div class="toolbar"><input id="search" aria-label="Search applications" placeholder="Search company or role…" value="${esc(search)}"><select id="filter" aria-label="Filter status"><option value="all">All statuses</option>${[...new Set(state.applications.map((a) => a.status))].map((s) => `<option value="${s}" ${filter === s ? "selected" : ""}>${label(s)}</option>`).join("")}</select></div><section class="panel">${table(apps)}</section>`
  );
}
function sources() {
  return (
    intro(
      "Let opportunities come to you.",
      "Follow the Greenhouse boards you choose. New internships arrive in your pipeline.",
    ) +
    `<div class="two-column"><section class="panel"><div class="panel-heading"><h2>Add a company board</h2><small>GREENHOUSE</small></div><form id="source-form" class="panel-body"><p class="muted">Use the board token from the company’s Greenhouse careers URL: job-boards.greenhouse.io/<strong>board-token</strong>. Only public job listings are read.</p><label>Company name<input name="company" required placeholder="Company display name"></label><label>Board token<input name="token" required pattern="[a-zA-Z0-9_-]{1,100}" placeholder="board-token"></label><label class="check"><input name="internshipsOnly" type="checkbox" checked>Import internships and co-ops only</label><button>Add job source</button><p class="muted">Enabled boards sync every 15 minutes while the agent runs. You can also sync a board manually.</p></form></section><section class="panel"><div class="panel-heading"><h2>Your sources</h2><small>${state.sources.length} BOARDS</small></div><div class="panel-body">${state.sources.length ? state.sources.map((s) => `<article class="evidence-card"><h3>${esc(s.company)} <span class="badge">${s.enabled ? "Enabled" : "Paused"}</span></h3><p>${esc(s.token)} · ${s.internshipsOnly ? "Internships & co-ops" : "All roles"}</p><p class="muted">${s.lastSync ? "Last synced " + esc(new Date(s.lastSync).toLocaleString()) : "Not synced yet"}</p>${s.lastResult ? `<p>${s.lastResult.imported} imported · ${s.lastResult.duplicates} duplicates · ${s.lastResult.skipped} skipped</p>` : ""}${s.lastError ? `<p class="source-error">${esc(s.lastError)}</p>` : ""}<div class="review-actions"><button class="secondary" data-source-sync="${s.id}" ${!s.enabled ? "disabled" : ""}>Sync now</button><button class="text-button" data-source-toggle="${s.id}">${s.enabled ? "Pause source" : "Enable source"}</button></div></article>`).join("") : '<p class="muted">No boards selected yet. Add a company to start discovering openings.</p>'}</div></section></div>`
  );
}
function activity() {
  return (
    intro(
      "A transparent trail.",
      "Every approval and state transition is recorded with its source.",
    ) +
    `<section class="panel"><div class="panel-body">${state.events.map((e) => `<div class="event"><time>${esc(new Date(e.created).toLocaleString())}</time><div>${esc(e.action)} <span class="badge">${esc(e.actor)}</span><small>${esc(e.application_id || "Workspace")}</small><details><summary>Details</summary><pre>${esc(e.details)}</pre></details></div></div>`).join("") || '<p class="muted">Your audit trail starts with your first action.</p>'}</div></section>`
  );
}
function render() {
  const views = {
    overview,
    applications,
    reviews,
    profile,
    resume,
    activity,
    sources,
  };
  $("#content").innerHTML = views[view]();
  $("#page-name").textContent = {
    overview: "Overview",
    applications: "Applications",
    reviews: "Review inbox",
    profile: "Profile & evidence",
    resume: "Résumé studio",
    activity: "Activity log",
    sources: "Job discovery",
  }[view];
  document
    .querySelectorAll("nav button")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  if (view === "reviews")
    for (const q of pending().filter((q) => q.kind === "resume"))
      document
        .querySelector(`[data-approve="${q.id}"]`)
        ?.parentElement.insertAdjacentHTML(
          "beforeend",
          `<button class="secondary" data-reject="${q.id}">Request changes</button>`,
        );
}
function openJob() {
  $("#test-url-hint").textContent =
    `For the test workflow use ${state.origin}/test-portal as the posting URL.`;
  $("#job-dialog").showModal();
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  try {
    if (b.dataset.view) {
      view = b.dataset.view;
      render();
    }
    if (b.id === "add-job" || b.hasAttribute("data-add-job")) openJob();
    if (b.id === "close-dialog") $("#job-dialog").close();
    if (b.id === "toggle-worker") {
      await api("control", { paused: !state.paused });
      await refresh();
    }
    if (b.id === "kill") {
      await api("kill", {});
      await refresh();
      toast("Worker paused and dedicated browser stopped");
    }
    if (b.id === "logout") {
      await api("logout", {});
      $("#login").hidden = false;
      $("#workspace").hidden = true;
      state = null;
    }
    for (const [key, decision] of [
      ["approve", "approve"],
      ["reject", "reject"],
      ["hold", "hold"],
    ])
      if (b.dataset[key]) {
        b.disabled = true;
        await api("questions/" + b.dataset[key], { decision });
        await refresh();
        toast(decision === "hold" ? "Held for later review" : "Decision saved");
      }
    if (b.dataset.retry) {
      await api(`applications/${b.dataset.retry}/retry`, {});
      await refresh();
      toast("Application queued for a safe retry");
    }
    if (b.dataset.sourceSync) {
      b.disabled = true;
      const result = await api(`sources/${b.dataset.sourceSync}/sync`, {});
      await refresh();
      toast(
        `${result.imported} opportunities added; ${result.duplicates} duplicates skipped`,
      );
    }
    if (b.dataset.sourceToggle) {
      const source = state.sources.find((s) => s.id === b.dataset.sourceToggle);
      await api(`sources/${source.id}/toggle`, { enabled: !source.enabled });
      await refresh();
    }
    for (const action of ["regenerate", "reconcile"])
      if (b.dataset[action]) {
        await api(`applications/${b.dataset[action]}/${action}`, {});
        await refresh();
        toast(
          action === "regenerate"
            ? "Résumé regeneration queued; prior pending approvals invalidated"
            : "Submission confirmed from receipt",
        );
      }
    if (b.dataset.detail) {
      view = "applications";
      const a = state.applications.find((a) => a.id === b.dataset.detail);
      $("#content").innerHTML =
        intro(esc(a.company), esc(a.title)) +
        `<div class="panel detail">${badge(a.status)}<p>${esc(a.reason)}</p><p><a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">Open posting ↗</a></p>${["RETRYABLE_ERROR", "NEEDS_MANUAL_REVIEW"].includes(a.status) ? `<button data-retry="${a.id}">Retry after fixing issue</button>` : ""}<details><summary>Posting description</summary><pre>${esc(a.description)}</pre></details><details><summary>Saved checkpoint</summary><pre>${esc(JSON.stringify(a.checkpoint, null, 2))}</pre></details></div><button class="secondary" data-view="applications">← All applications</button>`;
      if (
        [
          "RESUME_VALIDATED",
          "READY_TO_APPLY",
          "WAITING_FOR_USER",
          "WAITING_FOR_SUBMISSION_APPROVAL",
          "NEEDS_MANUAL_REVIEW",
          "RETRYABLE_ERROR",
        ].includes(a.status)
      )
        $(".detail").insertAdjacentHTML(
          "beforeend",
          `<p><button class="secondary" data-regenerate="${a.id}">Regenerate résumé with current profile & template</button></p>`,
        );
      if (a.status === "SUBMISSION_UNKNOWN" && a.adapter === "test")
        $(".detail").insertAdjacentHTML(
          "beforeend",
          `<p><button class="secondary" data-reconcile="${a.id}">Check saved test portal receipt</button></p>`,
        );
    }
  } catch (err) {
    toast(err.message, true);
    b.disabled = false;
  }
});
document.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target,
    data = Object.fromEntries(new FormData(f)),
    button = f.querySelector('button[type="submit"],button:not([type])');
  if (button) button.disabled = true;
  try {
    if (f.id === "login-form") {
      await api("login", data);
      f.reset();
      await refresh();
    }
    if (f.id === "job-form") {
      const result = await api("jobs", data);
      $("#job-dialog").close();
      f.reset();
      await refresh();
      toast(
        result.duplicate
          ? "This opportunity is already in your pipeline"
          : "Opportunity added",
      );
    }
    if (f.id === "source-form") {
      await api("sources", {
        ...data,
        internshipsOnly: data.internshipsOnly === "on",
      });
      await refresh();
      toast("Company board added");
    }
    if (f.id === "profile-form") {
      await api("profile", {
        ...data,
        approved: true,
        roles: data.roles
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        locations: data.locations
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      await refresh();
      toast("Profile approved and saved");
    }
    if (f.id === "evidence-form") {
      await api("evidence", {
        ...data,
        approved: true,
        skills: data.skills
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      await refresh();
      toast("Verified evidence saved");
    }
    if (f.id === "template-form") {
      await api("template", data);
      toast("Master template saved");
    }
    if (f.dataset.answer) {
      await api("questions/" + f.dataset.answer, {
        ...data,
        decision: "approve",
      });
      await refresh();
      toast("Answer approved; this application can resume");
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (button) button.disabled = false;
  }
});
document.addEventListener("change", async (e) => {
  if (e.target.id === "filter") {
    filter = e.target.value;
    render();
  }
  if (e.target.id === "template-file") {
    const file = e.target.files[0];
    if (file) {
      if (file.size > 200000) return toast("Template exceeds 200 KB", true);
      $("#template-form textarea").value = await file.text();
    }
  }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "search") {
    search = e.target.value;
    const start = e.target.selectionStart;
    render();
    $("#search").focus();
    $("#search").setSelectionRange(start, start);
  }
});
refresh().catch(() => {});
setInterval(() => {
  if (state && !document.hidden)
    refresh(
      !["profile", "resume", "applications", "sources"].includes(view) &&
        !(
          view === "reviews" &&
          ([...document.querySelectorAll("#content textarea")].some(
            (el) => el.value,
          ) ||
            document.activeElement?.closest("form"))
        ) &&
        !$("#job-dialog").open,
    ).catch((e) => toast(e.message, true));
}, 5000);
