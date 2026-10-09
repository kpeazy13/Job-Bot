import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PDFParse } from "pdf-parse";
import {
  hash,
  type Application,
  type Evidence,
  type Profile,
  type Store,
} from "./store.ts";
import { selectEvidence } from "./ai.ts";
const exec = promisify(execFile);
export const defaultTemplate = String.raw`\documentclass[10pt]{article}
\usepackage[margin=0.65in]{geometry}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\pagestyle{empty}
\begin{document}
% BEGIN AGENT CONTENT
% END AGENT CONTENT
\end{document}
`;
export function escapeTex(s: string) {
  return s.replace(
    /[\\{}$&#%_^~]/g,
    (c) =>
      ({
        "\\": "\\textbackslash{}",
        "{": "\\{",
        "}": "\\}",
        $: "\\$",
        "&": "\\&",
        "#": "\\#",
        "%": "\\%",
        _: "\\_",
        "^": "\\textasciicircum{}",
        "~": "\\textasciitilde{}",
      })[c]!,
  );
}
export function validateTemplate(template: string) {
  for (const marker of ["% BEGIN AGENT CONTENT", "% END AGENT CONTENT"])
    if (template.split(marker).length !== 2)
      throw new Error(`Template must contain exactly one ${marker} marker`);
  if (
    template.indexOf("% BEGIN AGENT CONTENT") >
    template.indexOf("% END AGENT CONTENT")
  )
    throw new Error("Template markers are reversed");
  if (template.length > 200000) throw new Error("Template too large");
}
export function planResume(a: Application, evidence: Evidence[]) {
  const text = a.description.toLowerCase();
  const ranked = evidence
    .map((e) => ({
      e,
      score: e.skills.filter((s) => text.includes(s.toLowerCase())).length,
    }))
    .sort((a, b) => b.score - a.score);
  return {
    job_id: a.id,
    focus: a.title,
    priority_keywords: [
      ...new Set(
        ranked.flatMap((x) =>
          x.e.skills.filter((s) => text.includes(s.toLowerCase())),
        ),
      ),
    ],
    selected_bullet_ids: ranked.slice(0, 6).map((x) => x.e.id),
    new_factual_claims_allowed: false,
    method: "Deterministic selection of approved verbatim evidence",
  };
}
export function renderResume(
  template: string,
  profile: Profile,
  evidence: Evidence[],
) {
  validateTemplate(template);
  const content = `\\begin{center}\n{\\LARGE\\bfseries ${escapeTex(profile.name)}}\\\\\n${escapeTex([profile.email, profile.phone, profile.location].filter(Boolean).join(" | "))}\n\\end{center}\n\\section*{Education}\n${escapeTex(profile.education)}\n\\section*{Experience and Projects}\n${evidence.map((e) => `\\noindent\\textbf{${escapeTex(e.title)}}\n\\begin{itemize}\n\\item ${escapeTex(e.bullet)}\n\\end{itemize}`).join("\n")}\n\\section*{Skills}\n${escapeTex([...new Set(evidence.flatMap((e) => e.skills))].join(", "))}`;
  return template.replace(
    /% BEGIN AGENT CONTENT[\s\S]*?% END AGENT CONTENT/,
    `% BEGIN AGENT CONTENT\n${content}\n% END AGENT CONTENT`,
  );
}
export async function generateResume(
  store: Store,
  a: Application,
  dataDir: string,
) {
  const profile = store.profile(),
    all = store.evidence();
  if (!profile || !all.length)
    throw new Error(
      "Approve your applicant profile and at least one evidence record first",
    );
  const template = store.getSetting<string>("template", defaultTemplate),
    selection = await selectEvidence(a, all),
    plan = {
      ...planResume(a, all),
      ...(selection || {}),
      method: selection
        ? "AI evidence selection; verbatim approved bullets"
        : "Deterministic selection of approved verbatim evidence",
    },
    selected = plan.selected_bullet_ids.map((id) =>
      all.find((e) => e.id === id)!,
    );
  const version = hash({ profile, plan, selected, template }).slice(0, 16),
    dir = join(dataDir, "artifacts", a.id, version);
  await mkdir(dir, { recursive: true });
  store.transition(a.id, "RESUME_PLANNED");
  const tex = renderResume(template, profile, selected);
  await Promise.all([
    writeFile(join(dir, "master_template.tex"), template),
    writeFile(join(dir, "resume.tex"), tex),
    writeFile(join(dir, "resume_plan.json"), JSON.stringify(plan, null, 2)),
  ]);
  store.transition(a.id, "RESUME_GENERATED");
  try {
    await exec(
      "latexmk",
      [
        "-pdf",
        "-no-shell-escape",
        "-interaction=nonstopmode",
        "-halt-on-error",
        "resume.tex",
      ],
      {
        cwd: dir,
        timeout: 60000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, openin_any: "p", openout_any: "p" },
      },
    );
  } catch {
    throw new Error(
      "LaTeX compilation failed. Install latexmk and a TeX distribution, or fix the template; generated source is preserved.",
    );
  }
  const pdf = await readFile(join(dir, "resume.pdf"));
  const parser = new PDFParse({ data: pdf });
  let result;
  try {
    result = await parser.getText();
  } finally {
    await parser.destroy();
  }
  const normalized = result.text.replace(/\s+/g, " ").toLowerCase();
  const validation = {
    pages: result.total,
    extractable: normalized.length > 50,
    namePresent: normalized.includes(profile.name.toLowerCase()),
    emailPresent: normalized.includes(profile.email.toLowerCase()),
    pdfHash: hash(pdf.toString("base64")),
    texHash: hash(tex),
    valid: false,
  };
  validation.valid =
    validation.pages === 1 &&
    validation.extractable &&
    validation.namePresent &&
    validation.emailPresent;
  await writeFile(
    join(dir, "validation.json"),
    JSON.stringify(validation, null, 2),
  );
  if (!validation.valid)
    throw new Error(
      "PDF validation failed: requires one page, selectable text, and matching name/email",
    );
  const artifact = { version, pdfHash: validation.pdfHash, plan, validation };
  store.transaction(() => {
    store.transition(a.id, "RESUME_VALIDATED", {
      checkpoint: { ...a.checkpoint, artifact, resumeApproved: false },
    });
    store.ask(
      a.id,
      "resume",
      "Review your tailored résumé before it can be uploaded.",
      "resume",
      artifact,
    );
  });
  return artifact;
}
