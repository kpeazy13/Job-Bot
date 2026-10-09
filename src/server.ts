import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.ts";
import { Worker } from "./worker.ts";
import { defaultTemplate, validateTemplate } from "./resume.ts";
import { motivationQuestion } from "./browser.ts";
import { Scout } from "./scout.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const dataDir = resolve(process.env.DATA_DIR || join(root, "data"));
await mkdir(dataDir, { recursive: true });
const store = new Store(join(dataDir, "agent.sqlite"));
const scout = new Scout(store);
const port = Number(process.env.PORT || 3210),
  origin = `http://127.0.0.1:${port}`;
const token = process.env.DASHBOARD_TOKEN || randomBytes(32).toString("hex");
const publicOrigin = process.env.PUBLIC_ORIGIN || origin;
if (publicOrigin !== origin && !publicOrigin.startsWith("https://"))
  throw new Error("Remote PUBLIC_ORIGIN must use HTTPS");
const sessions = new Map<string, number>();
const loginAttempts = new Map<string, { count: number; until: number }>();
const worker = new Worker(
  store,
  dataDir,
  origin,
  process.env.BROWSER_HEADLESS === "true",
);
// Restart paused. A human must intentionally resume each process launch.
store.setting("paused", true);
function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
async function body(req: IncomingMessage) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 300000) throw new Error("Request exceeds 300 KB limit");
  }
  return JSON.parse(text || "{}");
}
function authorized(req: IncomingMessage) {
  const cookie = req.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("agent_session="))
    ?.slice(14);
  return !!cookie && (sessions.get(cookie) || 0) > Date.now();
}
const server = createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  try {
    const url = new URL(req.url || "/", origin),
      path = url.pathname;
    if (
      ![new URL(origin).host, new URL(publicOrigin).host].includes(
        req.headers.host || "",
      )
    )
      return json(res, 403, { error: "Unrecognized host" });
    if (
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      req.headers.origin !== publicOrigin &&
      req.headers.origin !== origin
    )
      return json(res, 403, { error: "Same-origin request required" });
    if (path === "/api/login" && req.method === "POST") {
      const address = req.socket.remoteAddress || "local",
        attempt = loginAttempts.get(address);
      if (attempt && attempt.until > Date.now() && attempt.count >= 10)
        return json(res, 429, {
          error: "Too many login attempts; wait one minute",
        });
      const input = await body(req);
      if (typeof input.token !== "string" || !equal(input.token, token)) {
        loginAttempts.set(address, {
          count: attempt && attempt.until > Date.now() ? attempt.count + 1 : 1,
          until: Date.now() + 60000,
        });
        return json(res, 401, { error: "Incorrect access token" });
      }
      loginAttempts.delete(address);
      const id = randomBytes(32).toString("hex");
      sessions.set(id, Date.now() + 12 * 3600000);
      res.setHeader(
        "Set-Cookie",
        `agent_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${publicOrigin.startsWith("https:") ? "; Secure" : ""}`,
      );
      return json(res, 200, { ok: true });
    }
    if (path === "/api/logout" && req.method === "POST") {
      const cookie = req.headers.cookie
        ?.split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith("agent_session="))
        ?.slice(14);
      if (cookie) sessions.delete(cookie);
      res.setHeader(
        "Set-Cookie",
        "agent_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      );
      return json(res, 200, { ok: true });
    }
    if (path.startsWith("/test-portal/")) {
      // Native same-origin form posts need an Origin header for the CSRF check.
      res.setHeader("Referrer-Policy", "same-origin");
      const id = path.split("/")[2];
      const a = store.get(id);
      if (a.adapter !== "test") throw new Error("Not a test application");
      if (req.method === "POST") {
        if (a.status !== "SUBMITTING" || !a.checkpoint.approval)
          throw new Error("No submission approval");
        const receipt = store.getSetting(`receipt:${id}`, null);
        if (!receipt) {
          store.setting(`receipt:${id}`, {
            received: new Date().toISOString(),
          });
          store.audit(id, "test_portal.receipt");
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end("<h1>Test application received</h1>");
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Local test application</title><link rel="stylesheet" href="/style.css"><main class="portal"><h1>Local test application</h1><p>No application is sent to an employer.</p><form method="post"><label>Full name<input name="name" required></label><label>Email<input name="email" type="email" required></label><label>${motivationQuestion}<textarea name="motivation" required></textarea></label><label>Résumé PDF<input name="resume" type="file" accept="application/pdf" required></label><button>Submit test application</button></form></main></html>`,
      );
    }
    if (path.startsWith("/api/") && !authorized(req))
      return json(res, 401, {
        error: "Sign in with the access token printed in your terminal",
      });
    if (path === "/api/state" && req.method === "GET")
      return json(res, 200, {
        ...store.snapshot(),
        template: store.getSetting("template", defaultTemplate),
        origin,
        sources: scout.list(),
      });
    if (path === "/api/export" && req.method === "GET") {
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="internship-agent-export.json"',
      );
      return json(res, 200, {
        ...store.snapshot(),
        template: store.getSetting("template", defaultTemplate),
        answers: store.db.prepare("SELECT * FROM answers").all(),
        events: store.db.prepare("SELECT * FROM events").all(),
        sources: scout.list(),
      });
    }
    if (path === "/api/profile" && req.method === "POST")
      return json(res, 200, store.saveProfile(await body(req)));
    if (path === "/api/evidence" && req.method === "POST")
      return json(res, 200, { id: store.addEvidence(await body(req)) });
    if (path === "/api/jobs" && req.method === "POST")
      return json(res, 200, store.importJob(await body(req)));
    if (path === "/api/sources" && req.method === "POST")
      return json(res, 200, scout.add(await body(req)));
    const sourceAction = path.match(
      /^\/api\/sources\/([\w-]+)\/(sync|toggle)$/,
    );
    if (sourceAction && req.method === "POST") {
      const input = await body(req);
      if (sourceAction[2] === "sync")
        return json(res, 200, await scout.sync(sourceAction[1], true));
      scout.toggle(sourceAction[1], input.enabled);
      return json(res, 200, { ok: true });
    }
    if (path === "/api/template" && req.method === "POST") {
      const { template } = await body(req);
      if (typeof template !== "string")
        throw new Error("Template text required");
      validateTemplate(template);
      store.setting("template", template);
      store.audit(null, "template.saved", {}, "user");
      return json(res, 200, { ok: true });
    }
    if (path === "/api/control" && req.method === "POST") {
      const input = await body(req);
      if (typeof input.paused !== "boolean")
        throw new Error("paused must be boolean");
      store.setting("paused", input.paused);
      store.audit(
        null,
        input.paused ? "worker.paused" : "worker.resumed",
        {},
        "user",
      );
      return json(res, 200, { ok: true });
    }
    if (path === "/api/kill" && req.method === "POST") {
      store.setting("paused", true);
      await worker.browser.close();
      store.audit(null, "browser.stopped", {}, "user");
      return json(res, 200, { ok: true });
    }
    const question = path.match(/^\/api\/questions\/([\w-]+)$/);
    if (question && req.method === "POST") {
      store.resolve(question[1], await body(req));
      return json(res, 200, { ok: true });
    }
    const retry = path.match(/^\/api\/applications\/([\w-]+)\/retry$/);
    if (retry && req.method === "POST") {
      store.retry(retry[1]);
      return json(res, 200, { ok: true });
    }
    const applicationAction = path.match(
      /^\/api\/applications\/([\w-]+)\/(regenerate|reconcile)$/,
    );
    if (applicationAction && req.method === "POST") {
      if (applicationAction[2] === "regenerate") {
        store.regenerate(applicationAction[1]);
        const page = worker.browser.pages.get(applicationAction[1]);
        await page?.close();
        worker.browser.pages.delete(applicationAction[1]);
      } else store.reconcile(applicationAction[1]);
      return json(res, 200, { ok: true });
    }
    const artifact = path.match(
      /^\/api\/artifacts\/([\w-]+)\/(resume\.pdf|resume\.tex|resume_plan\.json|validation\.json)$/,
    );
    if (artifact && req.method === "GET") {
      const a = store.get(artifact[1]);
      if (!a.checkpoint.artifact) throw new Error("No validated artifact");
      const bytes = await readFile(
        join(
          dataDir,
          "artifacts",
          a.id,
          a.checkpoint.artifact.version,
          artifact[2],
        ),
      );
      res.writeHead(200, {
        "Content-Type": artifact[2].endsWith(".pdf")
          ? "application/pdf"
          : "text/plain; charset=utf-8",
        "Content-Disposition": `inline; filename="${artifact[2]}"`,
      });
      return res.end(bytes);
    }
    const files: Record<string, [string, string]> = {
      "/": ["index.html", "text/html"],
      "/app.js": ["app.js", "text/javascript"],
      "/style.css": ["style.css", "text/css"],
    };
    if (files[path] && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": files[path][1] + "; charset=utf-8",
      });
      return res.end(await readFile(join(root, "public", files[path][0])));
    }
    json(res, 404, { error: "Not found" });
  } catch (e) {
    json(res, 400, {
      error: e instanceof Error ? e.message : "Request failed",
    });
  }
});
const timer = setInterval(() => void worker.tick(), 1500);
const scoutTimer = setInterval(() => void scout.tick(), 10000);
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Internship Agent: ${origin}\nAccess token: ${token}\nWorker starts paused. Keep this terminal running.`,
  ),
);
async function shutdown() {
  clearInterval(timer);
  clearInterval(scoutTimer);
  store.setting("paused", true);
  await worker.browser.close();
  server.close(() => process.exit(0));
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
