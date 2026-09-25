// Extension: issue-triage
// A Kanban-style triage board for the repo's open GitHub issues. Fetches live
// issue data via `gh issue list`, highlights a curated set of "needs
// attention now" issues with a justification, and lets the user push any
// issue's details into the current session as a new user turn so they can
// start work immediately.

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";

const execFileAsync = promisify(execFile);

const REPO = "saitejagoruganthu/tailspin-toys";

// Curated triage priority. This encodes analysis of *why* an issue needs
// attention right now (scope risk, overlap with other in-flight issues,
// architectural ambiguity) rather than something derivable from GitHub
// metadata alone (this repo's issues carry no labels/assignees to sort by).
// Issues not listed here fall into the general backlog section, in the order
// GitHub returns them.
const PRIORITY = [
    {
        number: 6,
        justification:
            "Pagination changes the game-list data contract (page/limit) that " +
            "search (#1), sort (#2) and filter (#7) will all need to compose " +
            "with. Sequencing this first avoids rework and merge conflicts on " +
            "the same page and data-access helpers.",
    },
    {
        number: 7,
        justification:
            "Filtering, sorting (#2), searching (#1) and pagination (#6) all " +
            "touch the same game-list page and helpers. This is the most " +
            "complex of the four (combinable, multi-value filters) and needs a " +
            "clear query/URL-param contract agreed before parallel work starts.",
    },
    {
        number: 9,
        justification:
            "Largest and most architecturally ambiguous item: it introduces an " +
            "AI assistant into a fully static, prerendered site with no backend " +
            "or client framework, which cuts against the project's current " +
            "architecture. Needs technical scoping/design before implementation " +
            "can safely begin.",
    },
];

function priorityRank(number) {
    const idx = PRIORITY.findIndex((p) => p.number === number);
    return idx === -1 ? null : idx;
}

function justificationFor(number) {
    const entry = PRIORITY.find((p) => p.number === number);
    return entry ? entry.justification : null;
}

// Pull a short human summary and the acceptance-criteria checklist out of an
// issue body written in this repo's standard template.
function summarize(body) {
    const text = (body || "").replace(/\r\n/g, "\n");
    const paragraphs = text
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p && !p.startsWith("#") && !p.startsWith("##"));
    const summary = (paragraphs[0] || "").slice(0, 320);

    const criteria = [...text.matchAll(/^- \[[ xX]\] (.+)$/gm)].map((m) => m[1].trim());
    return { summary, criteria };
}

async function fetchIssues() {
    const { stdout } = await execFileAsync("gh", [
        "issue",
        "list",
        "--repo",
        REPO,
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        "number,title,body,createdAt,url,labels,comments",
    ]);
    const raw = JSON.parse(stdout);
    const issues = raw.map((i) => {
        const { summary, criteria } = summarize(i.body);
        return {
            number: i.number,
            title: i.title,
            url: i.url,
            createdAt: i.createdAt,
            labels: (i.labels || []).map((l) => l.name),
            commentCount: (i.comments || []).length,
            summary,
            criteria,
            justification: justificationFor(i.number),
        };
    });

    const top = issues
        .filter((i) => priorityRank(i.number) !== null)
        .sort((a, b) => priorityRank(a.number) - priorityRank(b.number));
    const rest = issues
        .filter((i) => priorityRank(i.number) === null)
        .sort((a, b) => a.number - b.number);

    return { top, rest };
}

function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    })[c]);
}

function renderCard(issue, { featured }) {
    const criteriaList = issue.criteria
        .slice(0, featured ? 6 : 3)
        .map((c) => `<li>${escapeHtml(c)}</li>`)
        .join("");
    const justificationBlock = featured && issue.justification
        ? `<div class="justification"><strong>Why now:</strong> ${escapeHtml(issue.justification)}</div>`
        : "";

    return `
    <article class="card ${featured ? "featured" : ""}" data-testid="issue-card-${issue.number}">
      <header>
        <span class="issue-number">#${issue.number}</span>
        <a class="issue-title" href="${escapeHtml(issue.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(issue.title)}</a>
      </header>
      ${justificationBlock}
      <p class="summary">${escapeHtml(issue.summary)}</p>
      ${criteriaList ? `<ul class="criteria">${criteriaList}</ul>` : ""}
      <footer>
        <button
          type="button"
          class="add-btn"
          data-testid="add-to-context-${issue.number}"
          data-number="${issue.number}"
          data-title="${escapeHtml(issue.title)}"
        >Add to session context</button>
        <span class="status" data-testid="add-status-${issue.number}" role="status" aria-live="polite"></span>
      </footer>
    </article>`;
}

async function renderBoard() {
    const { top, rest } = await fetchIssues();

    const topHtml = top.map((i) => renderCard(i, { featured: true })).join("\n");
    const restHtml = rest.map((i) => renderCard(i, { featured: false })).join("\n");

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Issue triage board</title>
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 1.25rem;
    background: var(--background-color-default, #0d1117);
    color: var(--text-color-default, #e6edf3);
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    font-size: var(--text-body-medium, 14px);
    line-height: var(--leading-body-medium, 20px);
  }
  h1 {
    font-size: var(--text-title-large, 22px);
    font-weight: var(--font-weight-semibold, 600);
    margin: 0 0 0.25rem;
  }
  h2 {
    font-size: var(--text-title-medium, 16px);
    font-weight: var(--font-weight-semibold, 600);
    margin: 1.75rem 0 0.75rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--border-color-default, #30363d);
  }
  .subtitle {
    color: var(--text-color-muted, #8b949e);
    margin: 0 0 0.5rem;
  }
  .board { display: flex; flex-direction: column; gap: 1rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 0.9rem; }
  .card {
    background: var(--background-color-overlay, #161b22);
    border: 1px solid var(--border-color-default, #30363d);
    border-radius: 10px;
    padding: 0.9rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .card.featured {
    border-color: var(--true-color-red-muted, #f85149);
    box-shadow: 0 0 0 1px var(--true-color-red-muted, #f85149) inset;
  }
  .card header { display: flex; align-items: baseline; gap: 0.5rem; }
  .issue-number { color: var(--text-color-muted, #8b949e); font-family: var(--font-mono, monospace); font-size: var(--text-code-inline, 12px); }
  .issue-title { color: var(--text-color-default, #e6edf3); font-weight: 600; text-decoration: none; }
  .issue-title:hover, .issue-title:focus-visible { text-decoration: underline; }
  .justification {
    background: color-mix(in srgb, var(--true-color-red-muted, #f85149) 12%, transparent);
    border-left: 3px solid var(--true-color-red-muted, #f85149);
    padding: 0.5rem 0.65rem;
    border-radius: 4px;
    font-size: 0.9em;
  }
  .summary { color: var(--text-color-muted, #c9d1d9); margin: 0; }
  .criteria { margin: 0; padding-left: 1.1rem; color: var(--text-color-muted, #8b949e); font-size: 0.9em; }
  .criteria li { margin-bottom: 0.15rem; }
  footer { margin-top: auto; display: flex; align-items: center; gap: 0.6rem; }
  .add-btn {
    background: var(--color-accent-emphasis, #1f6feb);
    color: var(--color-white, #fff);
    border: none;
    border-radius: 6px;
    padding: 0.4rem 0.75rem;
    font-size: 0.85em;
    font-weight: 600;
    cursor: pointer;
  }
  .add-btn:hover { filter: brightness(1.1); }
  .add-btn:focus-visible { outline: 2px solid var(--color-focus-outline, #58a6ff); outline-offset: 2px; }
  .add-btn:disabled { opacity: 0.6; cursor: default; }
  .status { color: var(--text-color-muted, #8b949e); font-size: 0.85em; }
  .empty { color: var(--text-color-muted, #8b949e); font-style: italic; }
</style>
</head>
<body>
  <h1>Issue triage board</h1>
  <p class="subtitle">${escapeHtml(REPO)} &middot; open issues</p>
  <div class="board">
    <section>
      <h2>&#128293; Needs attention now</h2>
      <div class="cards">
        ${topHtml || '<p class="empty">No issues flagged for immediate attention.</p>'}
      </div>
    </section>
    <section>
      <h2>&#128203; Backlog</h2>
      <div class="cards">
        ${restHtml || '<p class="empty">No other open issues.</p>'}
      </div>
    </section>
  </div>
  <script>
    document.addEventListener("click", async (e) => {
      const btn = e.target.closest(".add-btn");
      if (!btn) return;
      const number = btn.dataset.number;
      const statusEl = btn.parentElement.querySelector(".status");
      btn.disabled = true;
      statusEl.textContent = "Adding...";
      try {
        const res = await fetch("/api/add-to-context", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ number }),
        });
        if (!res.ok) throw new Error("request failed");
        statusEl.textContent = "Added to session \u2713";
      } catch (err) {
        statusEl.textContent = "Failed to add";
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

// One local HTTP server per open canvas instance.
const servers = new Map();

async function addIssueToContext(session, number) {
    const { stdout } = await execFileAsync("gh", [
        "issue",
        "view",
        String(number),
        "--repo",
        REPO,
        "--json",
        "number,title,body,url",
    ]);
    const issue = JSON.parse(stdout);
    const prompt =
        `Let's work on issue #${issue.number}: ${issue.title}\n` +
        `${issue.url}\n\n` +
        `${issue.body || ""}\n\n` +
        `Please review this issue and start implementing it, following the project's contribution guidelines.`;
    await session.send({ prompt });
}

async function startServer(session) {
    const server = createServer(async (req, res) => {
        try {
            if (req.method === "GET" && req.url === "/") {
                const html = await renderBoard();
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.end(html);
                return;
            }
            if (req.method === "POST" && req.url === "/api/add-to-context") {
                let body = "";
                for await (const chunk of req) body += chunk;
                const { number } = JSON.parse(body || "{}");
                if (!number) {
                    res.statusCode = 400;
                    res.end(JSON.stringify({ error: "missing issue number" }));
                    return;
                }
                await addIssueToContext(session, Number(number));
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true }));
                return;
            }
            res.statusCode = 404;
            res.end("not found");
        } catch (err) {
            session.log(`issue-triage error: ${err?.stack || err}`, { level: "error" });
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: String(err?.message || err) }));
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/` };
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "issue-triage",
            displayName: "Issue triage board",
            description:
                "A Kanban-style board of this repo's open GitHub issues, highlighting the ones that most need attention now with a justification, plus a backlog section. Each issue has a button to add its full details to the current session so work can start right away.",
            actions: [
                {
                    name: "refresh",
                    description: "Recompute and re-render the triage board from the latest open issues.",
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        if (!entry) {
                            throw new CanvasError("not_open", "Canvas instance is not open.");
                        }
                        // Re-render happens on next GET; nothing to precompute here.
                        return { ok: true };
                    },
                },
                {
                    name: "add_issue_to_context",
                    description: "Send a given issue's details into the current session as a new user turn.",
                    inputSchema: {
                        type: "object",
                        properties: { number: { type: "number" } },
                        required: ["number"],
                    },
                    handler: async (ctx) => {
                        await addIssueToContext(session, ctx.input.number);
                        return { ok: true, number: ctx.input.number };
                    },
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(session);
                    servers.set(ctx.instanceId, entry);
                }
                return {
                    title: "Issue triage board",
                    url: entry.url,
                };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
});
