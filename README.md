# ◳ repolens

> **Messy or gigantic repo? Don't waste tokens to map it.**
> Run one command, get the full map — and feed it to your AI.

![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen) ![node](https://img.shields.io/badge/node-%E2%89%A518-blue) ![license](https://img.shields.io/badge/license-MIT-black) ![tokens](https://img.shields.io/badge/LLM%20tokens%20spent-0-lime)

Every time an LLM agent opens a mid-size repository, it burns **100k–500k tokens** re-discovering facts that never change between commits: where the routes are, what tables exist, which env vars matter, which file is the god-file. **repolens extracts all of it deterministically, in seconds, with zero LLM calls** — one self-contained script, no dependencies, Node 18+.

```bash
# one-shot, no install (after npm publish)
npx repo-lens . --config repolens.config.json --out docs/repo-map

# or just grab the single file - it has zero dependencies
node repolens.mjs . --config repolens.config.json --out docs/repo-map
```

Then point your agent's `CLAUDE.md` / `AGENTS.md` at `docs/repo-map.md` and every session starts with the map already in context instead of exploring from scratch.

## What you get

| Output | What it is |
|---|---|
| `repo-map.md` | Compact index for humans **and LLMs** — every entry is a clickable `file#L<line>` link (works on GitHub and VS Code) |
| `repo-map.json` | Pretty-printed structured data: file tree, import graph, every catalog row with `file`, `line`, `link` provenance |
| `repo-map.html` | Self-contained interactive dashboard (no CDN, works offline): stat cards, area/language bars, **zoomable treemap**, dependency highlighting, sortable + searchable catalog tables. UI in English or Italian (`"lang"` in config) |

## What it extracts — out of the box, framework-agnostic

- **File tree + LOC + languages**, rendered as a squarified treemap
- **Import graph** (JS/TS/Python): fan-in/fan-out, dependency hubs, god files (≥1500 LOC)
- **HTTP routes** — Express/Hono/Koa (`app.get("/x")`), raw matching (`path === "/api/x"` + nearby method detection, Cloudflare Workers style), prefix routes, Python decorators — each with an auth heuristic and `file:line`
- **Database tables** — `CREATE TABLE` (with columns) + `ALTER TABLE`, merged per table, from `.sql` and inline SQL
- **Environment variables** with reference counts and locations
- **HTML pages → API calls** — which endpoints each page's JS actually hits
- **npm scripts**, **Cloudflare wrangler bindings** (D1/R2/KV/queues/crons)

## What people use it for

- **LLM agent onboarding** — the map replaces exploration; sessions start informed, tokens go to the actual task
- **Structured data extraction** — any repeated pattern in your codebase becomes a queryable JSON catalog (tool definitions, feature flags, CLI commands, event names…) ready to feed into RAG pipelines, dashboards or scripts
- **Refactor planning** — god files and dependency hubs tell you exactly where the pain is
- **API inventory & audit** — every route, with method, auth hint and source location
- **DB schema overview** — reconstructed from migrations, no DB connection needed
- **Human onboarding** — hand a new dev the HTML dashboard instead of a tour
- **Docs that never rot** — regenerate on demand or pre-commit; the map is code, not prose
- **CI drift checks** — diff `repo-map.json` between commits to catch new routes/tables/env vars in review

## Repo-specific knowledge: custom extractors

The core stays agnostic; your domain plugs in via config. Each extractor is a glob + regex + field names — every match becomes a catalog row with automatic `file:line` provenance, a tab in the HTML and a section in the MD:

```jsonc
{
  "name": "my-repo",
  "lang": "en",
  "ignore": ["**/*.generated.*", "fixtures/**"],
  "extractors": [
    {
      "name": "mcp_tools",
      "title": "MCP tools",
      "glob": "server/agent.js",
      "pattern": "tool\\(\\s*\"([\\w-]+)\",\\s*\"(.*?)\"",
      "flags": "g",
      "fields": ["tool", "description"],
      "maxLen": 260,           // truncate long captures
      "unique": true,          // dedup identical rows
      "postSplit": {           // explode a capture into a list + count
        "field": "tools",
        "pattern": "\"(mcp__\\w+)\""
      }
    }
  ]
}
```

## Philosophy

Deterministic extraction beats model exploration for everything that is *structural*. Architectural sensors like [sentrux](https://github.com/sentrux/sentrux) tell you **how healthy** your structure is; repolens tells you **what's in it and where**. Use both.

## Credits

Built by **Maurizio Tarricone** · [X Quantum Tech](https://xquantumtech.com) — AI innovation for real-world businesses.

## License

MIT
