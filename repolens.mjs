#!/usr/bin/env node
/**
 * repolens — zero-dependency repository mapper for humans and LLM agents.
 *
 * Scans a repository and produces:
 *   <out>.json  — full machine-readable map (files, dirs, import graph, catalogs)
 *   <out>.md    — compact human/LLM-readable index with clickable file links
 *   <out>.html  — self-contained interactive dashboard (overview + treemap + catalogs)
 *
 * Philosophy: deterministic extraction, ZERO LLM tokens. The map is generated
 * by code; the model only reads it. Repo-specific knowledge (custom tool
 * definitions, skill catalogs, …) plugs in via a JSON config with regex
 * extractors — the core stays language/framework agnostic.
 *
 * Usage:
 *   node repolens.mjs [rootDir] [--config repolens.config.json] [--out out/repo-map]
 *
 * No dependencies. Node 18+.
 */

import fs from "node:fs";
import path from "node:path";

// ───────────────────────────── CLI ─────────────────────────────

const argv = process.argv.slice(2);
function argOf(flag, dflt) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const ROOT = path.resolve(argv[0] && !argv[0].startsWith("--") ? argv[0] : ".");
const CONFIG_PATH = argOf("--config", null);
const OUT_PREFIX = argOf("--out", "repolens-out/repo-map");
const MAX_READ_BYTES = Number(argOf("--max-file-kb", "2048")) * 1024;

// ─────────────────────────── Config ────────────────────────────

const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", "vendor",
  "__pycache__", ".venv", "venv", "target", ".next", ".cache", ".idea",
  ".vscode", ".wrangler", ".wrangler-check", ".wrangler-typecheck",
  "_archive", "_dump", ".devcontainer", ".turbo", ".parcel-cache",
]);
const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".ico", ".bmp", ".tiff",
  ".mp4", ".mp3", ".wav", ".webm", ".mov", ".zip", ".gz", ".tar", ".7z",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".pdf", ".exe", ".dll", ".so",
  ".dylib", ".bin", ".db", ".sqlite", ".wasm", ".jar", ".class", ".pyc",
]);
const IGNORE_FILES = [/\.min\.(js|css)$/i, /\.map$/i, /package-lock\.json$/i, /yarn\.lock$/i, /pnpm-lock\.yaml$/i];

const LANG_BY_EXT = {
  ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript", ".jsx": "JavaScript",
  ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript",
  ".py": "Python", ".rb": "Ruby", ".go": "Go", ".rs": "Rust", ".java": "Java",
  ".c": "C", ".h": "C", ".cpp": "C++", ".hpp": "C++", ".cs": "C#",
  ".php": "PHP", ".swift": "Swift", ".kt": "Kotlin",
  ".html": "HTML", ".css": "CSS", ".scss": "CSS", ".vue": "Vue", ".svelte": "Svelte",
  ".json": "JSON", ".jsonc": "JSON", ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML",
  ".sql": "SQL", ".md": "Markdown", ".sh": "Shell", ".ps1": "PowerShell",
};

let userConfig = { ignore: [], extractors: [], name: null, lang: "en" };
if (CONFIG_PATH) {
  try {
    userConfig = { ...userConfig, ...JSON.parse(stripJsonc(fs.readFileSync(path.resolve(CONFIG_PATH), "utf8"))) };
  } catch (e) {
    console.error(`[repolens] config load failed (${CONFIG_PATH}): ${e.message}`);
    process.exit(2);
  }
}

function stripJsonc(s) {
  // Strip // and /* */ comments + trailing commas — STRING-AWARE: i glob nei
  // valori (es. "exports/**") contengono sequenze che sembrano commenti.
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { while (i < s.length && s[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += glob[i + 2] === "/" ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "{") {
      // {a,b,c} → (?:a|b|c)
      const end = glob.indexOf("}", i);
      if (end > i) { re += "(?:" + glob.slice(i + 1, end).split(",").join("|") + ")"; i = end; }
      else re += "\\{";
    } else if ("\\^$.|?+()[]}".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp("^" + re + "$");
}
const ignoreGlobs = (userConfig.ignore || []).map(globToRegex);

// ─────────────────────────── Walk ──────────────────────────────

/** @type {{rel:string, ext:string, lang:string, loc:number, bytes:number, binary:boolean}[]} */
const files = [];

function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.isDirectory() && e.name !== ".github") continue;
    const abs = path.join(dir, e.name);
    const rel = path.relative(ROOT, abs).split(path.sep).join("/");
    if (e.isDirectory()) {
      if (DEFAULT_IGNORE_DIRS.has(e.name)) continue;
      if (ignoreGlobs.some((g) => g.test(rel) || g.test(rel + "/"))) continue;
      walk(abs);
    } else if (e.isFile()) {
      if (IGNORE_FILES.some((r) => r.test(e.name))) continue;
      if (ignoreGlobs.some((g) => g.test(rel))) continue;
      const ext = path.extname(e.name).toLowerCase();
      const binary = BINARY_EXTS.has(ext);
      let bytes = 0;
      try { bytes = fs.statSync(abs).size; } catch { /* ignore */ }
      let loc = 0;
      if (!binary && bytes <= MAX_READ_BYTES) {
        try { loc = fs.readFileSync(abs, "utf8").split("\n").length; } catch { /* ignore */ }
      } else if (!binary) {
        loc = Math.round(bytes / 40); // estimate for oversized text files
      }
      files.push({ rel, ext, lang: LANG_BY_EXT[ext] || (binary ? "Binary" : "Other"), loc, bytes, binary });
    }
  }
}
console.error(`[repolens] scanning ${ROOT} …`);
walk(ROOT);

const contentCache = new Map();
function readContent(rel) {
  if (contentCache.has(rel)) return contentCache.get(rel);
  const f = files.find((x) => x.rel === rel);
  let s = null;
  if (f && !f.binary && f.bytes <= MAX_READ_BYTES) {
    try { s = fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { /* ignore */ }
  }
  contentCache.set(rel, s);
  return s;
}

// ─────────────────────── Directory tree ────────────────────────

function buildTree() {
  const root = { name: path.basename(ROOT), path: "", dirs: {}, files: [], loc: 0 };
  for (const f of files) {
    const parts = f.rel.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      node.dirs[p] = node.dirs[p] || { name: p, path: parts.slice(0, i + 1).join("/"), dirs: {}, files: [], loc: 0 };
      node = node.dirs[p];
    }
    node.files.push({ name: parts[parts.length - 1], rel: f.rel, loc: f.loc, lang: f.lang });
  }
  (function sum(n) {
    n.loc = n.files.reduce((a, f) => a + f.loc, 0);
    for (const d of Object.values(n.dirs)) n.loc += sum(d);
    return n.loc;
  })(root);
  return (function toArr(n) {
    return {
      name: n.name, path: n.path, loc: n.loc,
      children: [
        ...Object.values(n.dirs).map(toArr).sort((a, b) => b.loc - a.loc),
        ...n.files.sort((a, b) => b.loc - a.loc).map((f) => ({ name: f.name, path: f.rel, loc: f.loc, lang: f.lang, file: true })),
      ],
    };
  })(root);
}
const tree = buildTree();

// ───────────────────── Import graph (JS/TS/Py) ─────────────────

const fileSet = new Set(files.map((f) => f.rel));
const edges = [];
const JS_EXTS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".jsx", ".tsx"];

function resolveJs(fromRel, spec) {
  if (!spec.startsWith(".")) return null;
  const base = path.posix.join(path.posix.dirname(fromRel), spec).replace(/\?.*$/, "");
  const cand = [base, ...JS_EXTS.map((e) => base + e), ...JS_EXTS.map((e) => base + "/index" + e)];
  return cand.find((c) => fileSet.has(c)) || null;
}
function resolvePy(fromRel, mod) {
  const p = mod.replace(/\./g, "/");
  const cand = [
    p + ".py", p + "/__init__.py",
    path.posix.join(path.posix.dirname(fromRel), p + ".py"),
    path.posix.join(path.posix.dirname(fromRel), p, "__init__.py"),
  ];
  return cand.find((c) => fileSet.has(c)) || null;
}

for (const f of files) {
  const isJs = JS_EXTS.includes(f.ext);
  const isPy = f.ext === ".py";
  if (!isJs && !isPy) continue;
  const src = readContent(f.rel);
  if (!src) continue;
  if (isJs) {
    const re = /(?:import\s+(?:[\w*{}\s,]+\s+from\s+)?|export\s+(?:[\w*{}\s,]+\s+from\s+)?|require\(\s*|import\(\s*)["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(src))) {
      const to = resolveJs(f.rel, m[1]);
      if (to && to !== f.rel) edges.push([f.rel, to]);
    }
  } else {
    const re = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
    let m;
    while ((m = re.exec(src))) {
      const to = resolvePy(f.rel, m[1] || m[2]);
      if (to && to !== f.rel) edges.push([f.rel, to]);
    }
  }
}
const edgeKey = new Set();
const uniqEdges = edges.filter(([a, b]) => {
  const k = a + "→" + b;
  if (edgeKey.has(k)) return false;
  edgeKey.add(k);
  return true;
});
const fanIn = {}, fanOut = {};
for (const [a, b] of uniqEdges) {
  fanOut[a] = (fanOut[a] || 0) + 1;
  fanIn[b] = (fanIn[b] || 0) + 1;
}

// ─────────────────── File links (MD/JSON/HTML) ──────────────────
// Link RELATIVI dalla cartella di output alla root della repo: cliccabili su
// GitHub, in VS Code e nell'HTML aperto da disco. Con riga → #L<line> (GitHub).

const outPrefixAbs = path.resolve(OUT_PREFIX);
const linkPrefix = (path.relative(path.dirname(outPrefixAbs), ROOT).split(path.sep).join("/") || ".") + "/";
function fileLink(rel, line) {
  return linkPrefix + rel + (line ? `#L${line}` : "");
}

// ───────────────────── Built-in extractors ─────────────────────

const catalogs = {};
function addCatalog(name, title, columns) {
  catalogs[name] = catalogs[name] || { title, columns, rows: [] };
  return catalogs[name];
}
function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

// HTTP routes — express/hono/koa style + raw path matching (CF Workers style)
{
  const cat = addCatalog("routes", "HTTP routes", ["method", "route", "auth", "file", "line"]);
  const seen = new Set();
  const AUTH_HINTS = [
    [/requireClienteAccess|requireWorkspaceSession|requireAuth|isAuthenticated|verifyToken|authMiddleware/i, "auth"],
    [/checkExecutorBearer|EXECUTOR_SECRET|bearer/i, "service-bearer"],
    [/public|no.?auth/i, "public?"],
  ];
  function authHint(window) {
    for (const [re, label] of AUTH_HINTS) if (re.test(window)) return label;
    return "";
  }
  // Metodo HTTP nelle vicinanze: copre `request.method ===`, `req.method ===`
  // E la variabile destrutturata `method ===` (stile dispatcher CF Workers).
  function methodNear(src, idx) {
    const win = src.slice(Math.max(0, idx - 160), idx + 300);
    const m = win.match(/(?:\b(?:request|req)\.)?\bmethod\b\s*===?\s*["'`](\w+)/);
    return m ? m[1].toUpperCase() : "?";
  }
  for (const f of files) {
    if (![".js", ".mjs", ".ts", ".py", ".go", ".rb"].includes(f.ext)) continue;
    const src = readContent(f.rel);
    if (!src) continue;
    const push = (method, route, idx) => {
      const k = f.rel + "|" + method + "|" + route;
      if (seen.has(k) || !route.startsWith("/")) return;
      seen.add(k);
      const line = lineOf(src, idx);
      cat.rows.push({ method, route, auth: authHint(src.slice(idx, idx + 400)), file: f.rel, line, link: fileLink(f.rel, line) });
    };
    let m;
    const re1 = /\b\w+\.(get|post|put|delete|patch|options|all|use|GET|POST|PUT|DELETE)\(\s*["'`](\/[^"'`\s]*)/g;
    while ((m = re1.exec(src))) push(m[1].toUpperCase() === "USE" ? "USE" : m[1].toUpperCase(), m[2], m.index);
    const re2 = /path(?:name)?\s*===?\s*["'`](\/[^"'`]+)["'`]/g;
    while ((m = re2.exec(src))) push(methodNear(src, m.index), m[1], m.index);
    const re3 = /path(?:name)?\.startsWith\(\s*["'`](\/[^"'`]{3,})/g;
    while ((m = re3.exec(src))) push(methodNear(src, m.index), m[1] + "*", m.index);
    const re4 = /@\w+\.(get|post|put|delete|patch|route)\(\s*["'](\/[^"']*)/g;
    while ((m = re4.exec(src))) push(m[1].toUpperCase(), m[2], m.index);
  }
  cat.rows.sort((a, b) => a.route.localeCompare(b.route));
}

// SQL tables — CREATE TABLE (+ columns) and ALTER TABLE ADD COLUMN
{
  const cat = addCatalog("tables", "Database tables", ["table", "columns", "file"]);
  const byTable = new Map();
  for (const f of files) {
    if (![".sql", ".ts", ".js", ".mjs", ".py"].includes(f.ext)) continue;
    const src = readContent(f.rel);
    if (!src || !/CREATE TABLE|ALTER TABLE/i.test(src)) continue;
    let m;
    const reC = /CREATE TABLE (?:IF NOT EXISTS )?[`"]?(\w+)[`"]?\s*\(([\s\S]*?)\)\s*;/gi;
    while ((m = reC.exec(src))) {
      const cols = [];
      let depth = 0, cur = "";
      for (const ch of m[2]) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (ch === "," && depth === 0) { cols.push(cur); cur = ""; } else cur += ch;
      }
      cols.push(cur);
      const names = cols
        .map((c) => c.replace(/--.*$/gm, "").trim().split(/\s+/)[0])
        .filter((n) => n && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(n))
        .map((n) => n.replace(/[`"]/g, ""));
      const prev = byTable.get(m[1]) || { table: m[1], cols: [], file: f.rel, line: lineOf(src, m.index) };
      prev.cols = [...new Set([...prev.cols, ...names])];
      byTable.set(m[1], prev);
    }
    const reA = /ALTER TABLE [`"]?(\w+)[`"]?\s+ADD (?:COLUMN )?[`"]?(\w+)/gi;
    while ((m = reA.exec(src))) {
      const prev = byTable.get(m[1]) || { table: m[1], cols: [], file: f.rel, line: lineOf(src, m.index) };
      if (!prev.cols.includes(m[2])) prev.cols.push(m[2]);
      byTable.set(m[1], prev);
    }
  }
  for (const t of [...byTable.values()].sort((a, b) => a.table.localeCompare(b.table))) {
    cat.rows.push({ table: t.table, columns: t.cols.join(", "), file: t.file, line: t.line, link: fileLink(t.file, t.line) });
  }
}

// Env vars
{
  const cat = addCatalog("env", "Environment variables", ["name", "refs", "files"]);
  const acc = new Map();
  for (const f of files) {
    if (![".js", ".mjs", ".ts", ".tsx", ".jsx", ".py", ".sh"].includes(f.ext)) continue;
    const src = readContent(f.rel);
    if (!src) continue;
    const res = [
      /process\.env\.([A-Z][A-Z0-9_]+)/g,
      /import\.meta\.env\.([A-Z][A-Z0-9_]+)/g,
      /\benv\.([A-Z][A-Z0-9_]{2,})\b/g,
      /os\.environ(?:\.get)?\(["']([A-Z][A-Z0-9_]+)["']/g,
    ];
    for (const re of res) {
      let m;
      while ((m = re.exec(src))) {
        const e = acc.get(m[1]) || { name: m[1], refs: 0, files: new Set() };
        e.refs++;
        e.files.add(f.rel);
        acc.set(m[1], e);
      }
    }
  }
  for (const e of [...acc.values()].sort((a, b) => b.refs - a.refs)) {
    const first = [...e.files][0];
    cat.rows.push({
      name: e.name, refs: e.refs,
      files: [...e.files].slice(0, 3).join(", ") + (e.files.size > 3 ? ` (+${e.files.size - 3})` : ""),
      file: first, link: fileLink(first),
    });
  }
}

// HTML pages + the API endpoints each page's JS references
{
  const cat = addCatalog("pages", "Pages (HTML + API calls)", ["page", "title", "js", "api_calls"]);
  const htmls = files.filter((f) => f.ext === ".html" && !f.rel.includes("templates/"));
  for (const h of htmls) {
    const src = readContent(h.rel);
    if (!src) continue;
    const title = (src.match(/<title>([^<]*)<\/title>/i) || [])[1] || "";
    const scripts = [...src.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1]).filter((s) => !s.startsWith("http"));
    const apis = new Set();
    for (const s of scripts) {
      const guess = s.replace(/^\//, "");
      const jf = files.find((f) => f.rel.endsWith(guess));
      const js = jf ? readContent(jf.rel) : null;
      if (!js) continue;
      let m;
      const re = /["'`](\/api\/[a-zA-Z0-9_\-/:.]+)/g;
      while ((m = re.exec(js))) apis.add(m[1]);
    }
    cat.rows.push({
      page: h.rel, title: title.trim(),
      js: scripts.slice(0, 4).join(", "),
      api_calls: [...apis].slice(0, 12).join(", ") + (apis.size > 12 ? ` (+${apis.size - 12})` : ""),
      file: h.rel, link: fileLink(h.rel),
    });
  }
}

// npm scripts
{
  const cat = addCatalog("scripts", "npm scripts", ["package", "script", "command"]);
  for (const f of files.filter((x) => x.rel.endsWith("package.json"))) {
    try {
      const pkg = JSON.parse(readContent(f.rel) || "{}");
      for (const [k, v] of Object.entries(pkg.scripts || {})) {
        cat.rows.push({ package: f.rel, script: k, command: String(v).slice(0, 120), file: f.rel, link: fileLink(f.rel) });
      }
    } catch { /* ignore */ }
  }
}

// Cloudflare wrangler config (bindings, crons) — no-op on other repos
{
  const wranglers = files.filter((f) => /wrangler.*\.(toml|jsonc?|json)$/.test(f.rel) && !f.rel.includes("node_modules"));
  if (wranglers.length) {
    const cat = addCatalog("bindings", "Platform bindings (wrangler)", ["kind", "name", "detail", "file"]);
    for (const w of wranglers) {
      const src = readContent(w.rel);
      if (!src) continue;
      const push = (kind, name, detail) => cat.rows.push({ kind, name, detail, file: w.rel, link: fileLink(w.rel) });
      if (w.ext === ".toml") {
        for (const m of src.matchAll(/\[\[(d1_databases|r2_buckets|kv_namespaces|queues|services)\]\][\s\S]*?binding\s*=\s*"(\w+)"/g)) push(m[1], m[2], "");
        for (const m of src.matchAll(/crons\s*=\s*\[([^\]]*)\]/g)) push("cron", m[1].replace(/["\s]/g, ""), "");
      } else {
        try {
          const cfg = JSON.parse(stripJsonc(src));
          for (const k of ["d1_databases", "r2_buckets", "kv_namespaces", "queues", "services", "workflows"]) {
            for (const b of cfg[k] || []) push(k, b.binding || b.name || "", b.database_name || b.bucket_name || b.service || b.class_name || "");
          }
          for (const c of cfg.triggers?.crons || []) push("cron", c, "");
          if (cfg.vars) push("vars", Object.keys(cfg.vars).join(", ").slice(0, 200), `${Object.keys(cfg.vars).length} vars`);
        } catch { /* ignore */ }
      }
    }
  }
}

// ───────────────── Custom extractors (from config) ─────────────

for (const ex of userConfig.extractors || []) {
  try {
    const cat = addCatalog(ex.name, ex.title || ex.name, [...ex.fields, "file", "line"]);
    const glob = globToRegex(ex.glob);
    const re = new RegExp(ex.pattern, ex.flags ?? "g");
    const seen = new Set();
    const emit = (m, f, src) => {
      const line = lineOf(src, m.index);
      const row = { file: f.rel, line, link: fileLink(f.rel, line) };
      ex.fields.forEach((field, i) => {
        let v = (m[i + 1] || "").trim().replace(/\s+/g, " ");
        if (ex.maxLen) v = v.slice(0, ex.maxLen);
        row[field] = v;
      });
      if (ex.postSplit && row[ex.postSplit.field] != null) {
        const sub = new RegExp(ex.postSplit.pattern, "g");
        const items = [];
        let sm;
        while ((sm = sub.exec(row[ex.postSplit.field]))) items.push(sm[1]);
        row[ex.postSplit.field] = items.join(", ");
        row[ex.postSplit.field + "_count"] = items.length;
        if (!cat.columns.includes(ex.postSplit.field + "_count")) cat.columns.splice(cat.columns.length - 2, 0, ex.postSplit.field + "_count");
      }
      const key = ex.fields.map((x) => row[x]).join("|");
      if (ex.unique && seen.has(key)) return;
      seen.add(key);
      cat.rows.push(row);
    };
    for (const f of files) {
      if (!glob.test(f.rel)) continue;
      const src = readContent(f.rel);
      if (!src) continue;
      let m;
      if (!re.flags.includes("g")) {
        m = re.exec(src);
        if (m) emit(m, f, src);
      } else {
        re.lastIndex = 0;
        while ((m = re.exec(src))) emit(m, f, src);
      }
    }
  } catch (e) {
    console.error(`[repolens] custom extractor "${ex.name}" failed: ${e.message}`);
  }
}

for (const k of Object.keys(catalogs)) if (!catalogs[k].rows.length) delete catalogs[k];

// ─────────────────────────── Stats ─────────────────────────────

const totalLoc = files.reduce((a, f) => a + f.loc, 0);
const byLang = {};
for (const f of files) byLang[f.lang] = (byLang[f.lang] || 0) + f.loc;
const areas = tree.children.filter((c) => !c.file).map((c) => ({ area: c.name, loc: c.loc, files: countFiles(c) }));
function countFiles(n) { return n.file ? 1 : (n.children || []).reduce((a, c) => a + countFiles(c), 0); }
const godFiles = files.filter((f) => f.loc >= 1500 && f.lang !== "JSON" && f.lang !== "Markdown").sort((a, b) => b.loc - a.loc);
const topFanIn = Object.entries(fanIn).sort((a, b) => b[1] - a[1]).slice(0, 15);
const topFanOut = Object.entries(fanOut).sort((a, b) => b[1] - a[1]).slice(0, 15);

const repoName = userConfig.name || path.basename(ROOT);
const generatedAt = new Date().toISOString();

// ─────────────────────────── JSON out ──────────────────────────

fs.mkdirSync(path.dirname(outPrefixAbs), { recursive: true });

const jsonOut = {
  meta: { tool: "repolens", repo: repoName, root: ROOT, generatedAt, linkPrefix },
  stats: { files: files.length, loc: totalLoc, byLang, areas },
  godFiles: godFiles.map((f) => ({ file: f.rel, loc: f.loc, link: fileLink(f.rel) })),
  fan: { topFanIn, topFanOut },
  catalogs,
  tree,
  files: files.map((f) => ({ p: f.rel, loc: f.loc, l: f.lang })),
  edges: uniqEdges,
};
fs.writeFileSync(outPrefixAbs + ".json", JSON.stringify(jsonOut, null, 1));
console.error(`[repolens] wrote ${outPrefixAbs}.json`);

// ─────────────────────────── MD out ────────────────────────────

function mdCell(row, col) {
  const v = String(row[col] ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  if (col === "file" && row.link) {
    const label = row.line ? `${row.file}:${row.line}` : row.file;
    return `[${label}](${row.link})`;
  }
  if (col === "page" && row.link) return `[${v}](${row.link})`;
  return v;
}
function mdTable(columns, rows, max = 400) {
  const cols = columns.filter((c) => c !== "line"); // la riga è già nel link del file
  const head = `| ${cols.join(" | ")} |\n| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.slice(0, max).map((r) => `| ${cols.map((c) => mdCell(r, c)).join(" | ")} |`).join("\n");
  const more = rows.length > max ? `\n\n*(+${rows.length - max} more rows — see JSON)*` : "";
  return head + "\n" + body + more;
}

let md = `# Repo Map — ${repoName}

> Generated by repolens on ${generatedAt}. Do NOT edit by hand — regenerate with \`npm run map\`.
> Machine-readable: \`${path.basename(outPrefixAbs)}.json\` · Visual: \`${path.basename(outPrefixAbs)}.html\`

## Stats

- **Files:** ${files.length} · **LOC:** ${totalLoc.toLocaleString()}
- **Languages:** ${Object.entries(byLang).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([l, n]) => `${l} ${Math.round((n / totalLoc) * 100)}%`).join(" · ")}

### Top-level areas

${mdTable(["area", "loc", "files"], areas)}

### Giant files (≥1500 LOC — refactor candidates)

${godFiles.length ? mdTable(["file", "loc"], godFiles.map((f) => ({ file: f.rel, loc: f.loc, link: fileLink(f.rel) }))) : "_none_"}

### Dependency hubs

**Most imported (fan-in):** ${topFanIn.slice(0, 8).map(([f, n]) => `[\`${f}\`](${fileLink(f)}) (${n})`).join(", ")}

**Most dependent (fan-out):** ${topFanOut.slice(0, 8).map(([f, n]) => `[\`${f}\`](${fileLink(f)}) (${n})`).join(", ")}
`;

for (const [, cat] of Object.entries(catalogs)) {
  md += `\n## ${cat.title} (${cat.rows.length})\n\n${mdTable(cat.columns, cat.rows)}\n`;
}

md += `\n---\n*Generated by ◳ repolens — zero LLM tokens. Built by Maurizio Tarricone · [X Quantum Tech](https://xquantumtech.com)*\n`;

fs.writeFileSync(outPrefixAbs + ".md", md);
console.error(`[repolens] wrote ${outPrefixAbs}.md`);

// ─────────────────────────── HTML out ──────────────────────────

const html = buildHtml(JSON.stringify(jsonOut));
fs.writeFileSync(outPrefixAbs + ".html", html);
console.error(`[repolens] wrote ${outPrefixAbs}.html`);
console.error(`[repolens] done: ${files.length} files, ${totalLoc.toLocaleString()} LOC, ${Object.keys(catalogs).length} catalogs, ${uniqEdges.length} import edges`);

function buildHtml(dataJson) {
  // Dashboard self-contained, leggibile da umani: panoramica con barre,
  // treemap zoomabile con legenda, cataloghi come tabelle ordinabili.
  // Client JS senza template literal (vive dentro una stringa server-side).
  const LANG = (userConfig.lang || "en").toLowerCase().startsWith("it") ? "it" : "en";
  const I18N = {
    it: {
      overview: "Panoramica", map: "Mappa del codice", files: "File", loc: "Righe di codice",
      edges: "Dipendenze (import)", searchPh: "Cerca… (route, tool, tabella, file)",
      areas: "Aree del progetto", langs: "Linguaggi",
      god: "File giganti (≥1500 righe — candidati a refactor)",
      hubsIn: "I file più usati dagli altri (fan-in)", hubsOut: "I file che dipendono da più cose (fan-out)",
      mapHint: "Ogni rettangolo è una cartella o un file: più è grande, più righe di codice contiene. <b>Click su una cartella</b> per entrarci, <b>click su un file</b> per vedere le sue dipendenze (blu = file che importa, rosa = file che lo importano). Usa il percorso in alto per tornare indietro.",
      legend: "Colori per area:", close: "✕ chiudi", imports: "importa", importedBy: "importato da",
      linksToggle: "⛓ Collegamenti import", linksHint: "linee = chi importa chi (spessore = quanti import)",
      generated: "generato il", openFile: "apri", rows: "righe", noResults: "Nessun risultato per",
      refine: "raffina la ricerca per vedere le altre", filesTab: "Tutti i file",
    },
    en: {
      overview: "Overview", map: "Code map", files: "Files", loc: "Lines of code",
      edges: "Import edges", searchPh: "Search… (route, tool, table, file)",
      areas: "Project areas", langs: "Languages",
      god: "Giant files (≥1500 lines — refactor candidates)",
      hubsIn: "Most imported files (fan-in)", hubsOut: "Files depending on most things (fan-out)",
      mapHint: "Each rectangle is a folder or a file: the bigger it is, the more lines of code it contains. <b>Click a folder</b> to zoom in, <b>click a file</b> to see its dependencies (blue = files it imports, pink = files importing it). Use the breadcrumb to go back.",
      legend: "Area colors:", close: "✕ close", imports: "imports", importedBy: "imported by",
      linksToggle: "⛓ Import links", linksHint: "lines = who imports whom (thickness = how many imports)",
      generated: "generated", openFile: "open", rows: "rows", noResults: "No results for",
      refine: "refine your search to see the rest", filesTab: "All files",
    },
  }[LANG];

  const TEMPLATE = `<!DOCTYPE html>
<html lang="${LANG}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>__REPO__ — repo map</title>
<style>
  :root { --bg:#fafafa; --card:#ffffff; --line:#e4e4e7; --txt:#18181b; --dim:#71717a; --soft:#a1a1aa;
          --acc:#65a30d; --accbg:#ecfccb; --dark:#18181b; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--txt); font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; min-height:100vh; }
  a { color:var(--acc); text-decoration:none; }
  a:hover { text-decoration:underline; }
  header { background:var(--card); border-bottom:1px solid var(--line); padding:18px 28px;
           border-top:4px solid; border-image:linear-gradient(90deg,#a3e635,#65a30d,#18181b) 1; }
  header .ttl { font-size:21px; font-weight:800; letter-spacing:-0.02em; }
  header .ttl em { font-style:normal; color:var(--acc); }
  header .sub { color:var(--dim); font-size:12.5px; margin-top:3px; }
  .wrap { max-width:1480px; margin:0 auto; padding:20px 28px 60px; }
  .cards { display:flex; flex-wrap:wrap; gap:12px; margin-bottom:18px; }
  .card-stat { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px 20px; min-width:130px;
               box-shadow:0 1px 3px rgba(0,0,0,0.04); transition:transform .12s, box-shadow .12s; }
  .card-stat:hover { transform:translateY(-1px); box-shadow:0 4px 14px rgba(0,0,0,0.07); }
  .card-stat .n { font-size:24px; font-weight:800; letter-spacing:-0.02em; }
  .card-stat .l { color:var(--dim); font-size:12px; margin-top:2px; }
  #tabs { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:18px; }
  #tabs button { background:var(--card); color:var(--dim); border:1px solid var(--line); border-radius:999px;
                 padding:7px 16px; font:inherit; font-size:13px; cursor:pointer; font-weight:600; }
  #tabs button:hover { border-color:var(--soft); color:var(--txt); }
  #tabs button.on { background:var(--dark); color:#fff; border-color:var(--dark); }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:20px 22px; margin-bottom:16px;
           box-shadow:0 1px 3px rgba(0,0,0,0.04); }
  .panel h2 { font-size:15px; font-weight:700; margin-bottom:14px; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  @media (max-width:980px){ .grid2 { grid-template-columns:1fr; } }
  .bar-row { display:grid; grid-template-columns:170px 1fr 110px; align-items:center; gap:10px; padding:4px 0; font-size:13px; }
  .bar-row .nm { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .bar-track { background:#f4f4f5; border-radius:6px; height:18px; overflow:hidden; }
  .bar-fill { height:100%; border-radius:6px; background:linear-gradient(90deg,#a3e635,#65a30d); }
  .bar-row .val { color:var(--dim); font-size:12px; text-align:right; font-variant-numeric:tabular-nums; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; color:var(--dim); font-size:11.5px; text-transform:uppercase; letter-spacing:0.04em;
       padding:8px 10px; border-bottom:2px solid var(--line); cursor:pointer; user-select:none; white-space:nowrap; }
  th:hover { color:var(--txt); }
  th .arrow { color:var(--acc); }
  td { padding:8px 10px; border-bottom:1px solid #f1f1f3; vertical-align:top; word-break:break-word; }
  tr:hover td { background:#fafaf9; }
  td.first { font-weight:600; }
  td .filelnk { color:var(--soft); font-size:12px; }
  td .filelnk:hover { color:var(--acc); }
  .badge { display:inline-block; background:var(--accbg); color:#3f6212; font-weight:700; font-size:11px;
           border-radius:6px; padding:2px 7px; }
  .badge.warn { background:#fef3c7; color:#92400e; }
  .badge.q { background:#f4f4f5; color:var(--dim); }
  #search { width:100%; max-width:460px; padding:9px 14px; border:1px solid var(--line); border-radius:10px;
            font:inherit; margin-bottom:14px; background:#fff; }
  #search:focus { outline:2px solid #d9f99d; border-color:var(--acc); }
  .hint { color:var(--dim); font-size:13px; margin-bottom:12px; line-height:1.55; }
  .legend { display:flex; flex-wrap:wrap; gap:8px 14px; margin-bottom:12px; font-size:12.5px; color:var(--dim); align-items:center; }
  .chip { display:inline-flex; align-items:center; gap:6px; }
  .chip i { width:12px; height:12px; border-radius:3px; display:inline-block; }
  #crumb { font-size:13px; color:var(--dim); margin-bottom:8px; }
  #crumb span { color:var(--acc); cursor:pointer; font-weight:600; }
  #crumb span:hover { text-decoration:underline; }
  #cv { width:100%; height:62vh; border:1px solid var(--line); border-radius:12px; background:#fff; display:block; }
  #tip { position:fixed; pointer-events:none; background:#18181b; color:#fafafa; padding:7px 11px; border-radius:8px;
         font-size:12.5px; display:none; z-index:10; max-width:440px; box-shadow:0 8px 24px rgba(0,0,0,0.18); }
  #info { margin-top:10px; font-size:13px; display:none; background:#fafaf9; border:1px solid var(--line);
          border-radius:10px; padding:12px 14px; }
  #info b { font-weight:700; }
  #info .lnk { color:#0369a1; cursor:pointer; }
  #info .lnk:hover { text-decoration:underline; }
  .muted { color:var(--dim); }
  ul.plain { list-style:none; }
  ul.plain li { padding:4px 0; border-bottom:1px solid #f1f1f3; font-size:13px; display:flex; justify-content:space-between; gap:10px; }
  ul.plain li .c { color:var(--dim); font-variant-numeric:tabular-nums; }
</style>
</head>
<body>
<header>
  <div class="ttl"><em>◳ repolens</em> · __REPO__</div>
  <div class="sub" id="hsub"></div>
</header>
<div class="wrap">
  <div class="cards" id="cards"></div>
  <div id="tabs"></div>
  <div id="content"></div>
  <footer style="margin-top:28px; padding-top:16px; border-top:1px solid var(--line); color:var(--soft); font-size:12px; display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px;">
    <span>◳ <b>repolens</b> — messy or gigantic repo? Don't waste tokens to map it.</span>
    <span>Built by Maurizio Tarricone · <a href="https://xquantumtech.com" target="_blank" rel="noopener">X Quantum Tech</a></span>
  </footer>
</div>
<div id="tip"></div>
<script>
var DATA = __DATA__;
var T = __I18N__;
var PALETTE = ["#84cc16","#3b82f6","#ec4899","#f59e0b","#10b981","#8b5cf6","#ef4444","#06b6d4","#f97316","#6366f1","#22c55e","#d946ef"];
var areaColor = {};
(DATA.tree.children||[]).filter(function(c){return !c.file;}).forEach(function(c,i){ areaColor[c.name] = PALETTE[i % PALETTE.length]; });
function colorFor(p){ var a = (p||"").split("/")[0]; return areaColor[a] || "#94a3b8"; }
function tint(hex, p){ var n=parseInt(hex.slice(1),16),r=(n>>16)&255,g=(n>>8)&255,b=n&255;
  r=Math.round(r+(255-r)*p); g=Math.round(g+(255-g)*p); b=Math.round(b+(255-b)*p);
  return "rgb("+r+","+g+","+b+")"; }
function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function fmt(n){ return Number(n||0).toLocaleString(); }

document.getElementById("hsub").textContent = T.generated + " " + DATA.meta.generatedAt.slice(0,16).replace("T"," ") + " · " + DATA.meta.root;

// ── stat cards ──
(function(){
  var cards = [[fmt(DATA.stats.files), T.files],[fmt(DATA.stats.loc), T.loc],[fmt(DATA.edges.length), T.edges]];
  Object.keys(DATA.catalogs).slice(0,4).forEach(function(k){
    cards.push([fmt(DATA.catalogs[k].rows.length), DATA.catalogs[k].title]);
  });
  document.getElementById("cards").innerHTML = cards.map(function(c){
    return '<div class="card-stat"><div class="n">'+c[0]+'</div><div class="l">'+esc(c[1])+'</div></div>';
  }).join("");
})();

// ── indexes ──
var nodeByPath = {};
(function idx(n){ nodeByPath[n.path]=n; (n.children||[]).forEach(idx); })(DATA.tree);
var importsOf = {}, importersOf = {};
DATA.edges.forEach(function(e){ (importsOf[e[0]]=importsOf[e[0]]||[]).push(e[1]); (importersOf[e[1]]=importersOf[e[1]]||[]).push(e[0]); });
function flink(p, line){ return DATA.meta.linkPrefix + p + (line ? "#L"+line : ""); }

// ── tabs ──
var TABS = [{k:"overview", t:T.overview},{k:"map", t:T.map}];
Object.keys(DATA.catalogs).forEach(function(k){ TABS.push({k:"cat:"+k, t:DATA.catalogs[k].title+" ("+DATA.catalogs[k].rows.length+")"}); });
TABS.push({k:"cat:__files", t:T.filesTab+" ("+DATA.files.length+")"});
var current = "overview";
function renderTabs(){
  document.getElementById("tabs").innerHTML = TABS.map(function(tb){
    return '<button data-k="'+tb.k+'" class="'+(tb.k===current?"on":"")+'">'+esc(tb.t)+"</button>";
  }).join("");
  document.querySelectorAll("#tabs button").forEach(function(b){
    b.onclick = function(){ current = b.getAttribute("data-k"); renderTabs(); renderContent(); };
  });
}

// ── content render ──
function renderContent(){
  var el = document.getElementById("content");
  if (current === "overview") return renderOverview(el);
  if (current === "map") return renderMap(el);
  renderCatalog(el, current.slice(4));
}

function barRows(items, nameKey, valKey, extra){
  var max = Math.max.apply(null, items.map(function(x){ return x[valKey]; }).concat([1]));
  return items.map(function(x){
    var pct = Math.max(1, Math.round(100*x[valKey]/max));
    return '<div class="bar-row"><div class="nm">'+esc(x[nameKey])+'</div>'
      +'<div class="bar-track"><div class="bar-fill" style="width:'+pct+'%"></div></div>'
      +'<div class="val">'+fmt(x[valKey])+(extra?(' · '+fmt(x[extra])+' file'):'')+"</div></div>";
  }).join("");
}

function renderOverview(el){
  var langs = Object.keys(DATA.stats.byLang).map(function(l){ return {l:l, n:DATA.stats.byLang[l]}; })
    .sort(function(a,b){ return b.n-a.n; }).slice(0,9);
  var god = DATA.godFiles.map(function(g){
    return "<tr><td class='first'><a href='"+esc(g.link||flink(g.file))+"'>"+esc(g.file)+"</a></td><td><span class='badge warn'>"+fmt(g.loc)+" LOC</span></td></tr>";
  }).join("");
  var hubsIn = DATA.fan.topFanIn.slice(0,10).map(function(x){
    return "<li><a href='"+esc(flink(x[0]))+"'>"+esc(x[0])+"</a><span class='c'>"+x[1]+"</span></li>";
  }).join("");
  var hubsOut = DATA.fan.topFanOut.slice(0,10).map(function(x){
    return "<li><a href='"+esc(flink(x[0]))+"'>"+esc(x[0])+"</a><span class='c'>"+x[1]+"</span></li>";
  }).join("");
  el.innerHTML =
    '<div class="grid2">'
    +'<div class="panel"><h2>'+esc(T.areas)+'</h2>'+barRows(DATA.stats.areas,"area","loc","files")+"</div>"
    +'<div class="panel"><h2>'+esc(T.langs)+'</h2>'+barRows(langs,"l","n")+"</div>"
    +"</div>"
    +'<div class="panel"><h2>'+esc(T.god)+"</h2><table><tbody>"+(god||"<tr><td class='muted'>—</td></tr>")+"</tbody></table></div>"
    +'<div class="grid2">'
    +'<div class="panel"><h2>'+esc(T.hubsIn)+'</h2><ul class="plain">'+hubsIn+"</ul></div>"
    +'<div class="panel"><h2>'+esc(T.hubsOut)+'</h2><ul class="plain">'+hubsOut+"</ul></div>"
    +"</div>";
}

// ── treemap ──
var rootNode = DATA.tree, cells = [], highlight = null;
var linksOn = true;       // overlay "circuiti": fasci di import tra i blocchi visibili
var cellByPath = {};      // node.path → cella visibile (le sub-celle sovrascrivono i parent)

function renderMap(el){
  var chips = Object.keys(areaColor).map(function(a){
    return '<span class="chip"><i style="background:'+areaColor[a]+'"></i>'+esc(a)+"</span>";
  }).join("");
  el.innerHTML =
    '<div class="panel">'
    +'<div class="hint">'+T.mapHint+"</div>"
    +'<div class="legend">'+esc(T.legend)+" "+chips
    +'<label style="margin-left:auto; display:inline-flex; align-items:center; gap:6px; cursor:pointer; color:#3f3f46; font-weight:600;">'
    +'<input type="checkbox" id="linkstoggle"'+(linksOn?" checked":"")+'/> '+esc(T.linksToggle)
    +'</label></div>'
    +'<div id="crumb"></div>'
    +'<canvas id="cv"></canvas>'
    +'<div id="info"></div>'
    +"</div>";
  wireCanvas();
  document.getElementById("linkstoggle").onchange = function(){ linksOn = this.checked; draw(); };
  renderCrumb();
  layout();
}

function squarify(items, x, y, w, h, out){
  items = items.filter(function(c){ return c.loc > 0; });
  if (!items.length) return;
  var total = items.reduce(function(a,c){ return a+c.loc; },0);
  var i = 0;
  while (i < items.length){
    var row = [], rowSum = 0;
    var horiz = w >= h;
    var side = horiz ? h : w;
    var best = Infinity;
    for (var j=i; j<items.length; j++){
      var trySum = rowSum + items[j].loc;
      var tryRow = row.concat([items[j]]);
      var rowArea = trySum * ((w*h)/total);
      var thickness = rowArea / side;
      var worst = 0;
      tryRow.forEach(function(it){
        var len = (it.loc * ((w*h)/total)) / thickness;
        var ratio = Math.max(thickness/len, len/thickness);
        if (ratio > worst) worst = ratio;
      });
      if (worst <= best){ best = worst; row = tryRow; rowSum = trySum; }
      else break;
    }
    i += row.length;
    var rowArea2 = rowSum * ((w*h)/total);
    var thick = rowArea2 / side;
    var off = 0;
    row.forEach(function(it){
      var len = (it.loc * ((w*h)/total)) / thick;
      out.push({ node: it, x: horiz?x:x+off, y: horiz?y+off:y, w: horiz?thick:len, h: horiz?len:thick });
      off += len;
    });
    if (horiz){ x += thick; w -= thick; } else { y += thick; h -= thick; }
    total -= rowSum;
  }
}

var cv, ctx, tip;
function wireCanvas(){
  cv = document.getElementById("cv");
  ctx = cv.getContext("2d");
  tip = document.getElementById("tip");
  cv.addEventListener("mousemove", function(ev){
    var c = cellAt(ev);
    if (!c){ tip.style.display = "none"; cv.style.cursor = "default"; return; }
    cv.style.cursor = "pointer";
    tip.style.display = "block";
    tip.style.left = Math.min(window.innerWidth-460, ev.clientX+14)+"px";
    tip.style.top = (ev.clientY+12)+"px";
    var fin = (importersOf[c.node.path]||[]).length, fout = (importsOf[c.node.path]||[]).length;
    tip.innerHTML = "<b>"+esc(c.node.path||c.node.name)+"</b><br>"+fmt(c.node.loc)+" LOC"
      + (c.node.lang ? " · "+esc(c.node.lang) : "")
      + (c.node.file ? "<br>fan-in "+fin+" · fan-out "+fout : "");
  });
  cv.addEventListener("mouseleave", function(){ tip.style.display = "none"; });
  cv.addEventListener("click", function(ev){
    var c = cellAt(ev);
    if (!c) return;
    if (c.node.file){ showFile(c.node.path); }
    else { rootNode = c.node; highlight = null; hideInfo(); renderCrumb(); layout(); }
  });
}

function layout(){
  if (!cv) return;
  var r = cv.getBoundingClientRect();
  cv.width = r.width * devicePixelRatio;
  cv.height = r.height * devicePixelRatio;
  ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
  cells = [];
  squarify(rootNode.children||[], 0, 0, r.width, r.height, cells);
  var sub = [];
  cells.forEach(function(c){
    if (!c.node.file && c.w > 80 && c.h > 52){
      var inner = [];
      squarify(c.node.children||[], c.x+4, c.y+20, c.w-8, c.h-24, inner);
      inner.forEach(function(s){ s.parent = c; });
      sub = sub.concat(inner);
    }
  });
  cells = cells.concat(sub);
  // indice path → cella visibile: i parent prima, le sub-celle dopo (sovrascrivono)
  cellByPath = {};
  cells.forEach(function(c){ cellByPath[c.node.path] = c; });
  draw();
}

// Cella visibile che contiene il path (risale finché trova un antenato renderizzato).
function visibleCellFor(p){
  var parts = p.split("/");
  for (var i = parts.length; i >= 1; i--){
    var c = cellByPath[parts.slice(0, i).join("/")];
    if (c) return c;
  }
  return null;
}
function centerOf(c){ return [c.x + c.w/2, c.y + c.h/2]; }
function darken(hex, f){ var n=parseInt(hex.slice(1),16),r=(n>>16)&255,g=(n>>8)&255,b=n&255;
  return "rgb("+Math.round(r*(1-f))+","+Math.round(g*(1-f))+","+Math.round(b*(1-f))+")"; }

// Fascio curvo con freccia: il "circuito" tra due blocchi.
function drawBeam(a, b, width, color, alpha){
  var ax=a[0], ay=a[1], bx=b[0], by=b[1];
  var mx=(ax+bx)/2, my=(ay+by)/2;
  var dx=bx-ax, dy=by-ay;
  var len=Math.sqrt(dx*dx+dy*dy)||1;
  var bend=Math.min(90, len*0.22);
  var cxp=mx - dy/len*bend, cyp=my + dx/len*bend;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.quadraticCurveTo(cxp, cyp, bx, by);
  ctx.stroke();
  var adx=bx-cxp, ady=by-cyp, al=Math.sqrt(adx*adx+ady*ady)||1;
  adx/=al; ady/=al;
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx - adx*8 - ady*4, by - ady*8 + adx*4);
  ctx.lineTo(bx - adx*8 + ady*4, by - ady*8 - adx*4);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;
}

// Overlay aggregato: gli edge file→file vengono proiettati sulle celle VISIBILI
// al livello di zoom corrente (cartella↔cartella da lontano, file↔file da vicino).
function drawAggregatedLinks(){
  var agg = {};
  DATA.edges.forEach(function(e){
    var ca = visibleCellFor(e[0]), cb = visibleCellFor(e[1]);
    if (!ca || !cb || ca === cb) return;
    var k = (ca.node.path||"·") + "|" + (cb.node.path||"·");
    if (!agg[k]) agg[k] = { a: ca, b: cb, n: 0 };
    agg[k].n++;
  });
  var list = Object.keys(agg).map(function(k){ return agg[k]; })
    .sort(function(x,y){ return y.n-x.n; }).slice(0, 140);
  list.forEach(function(l){
    var col = darken(colorFor(l.a.node.path || l.a.node.name), 0.25);
    drawBeam(centerOf(l.a), centerOf(l.b),
      Math.min(4, 0.6 + Math.log2(l.n+1)*0.7), col,
      Math.min(0.45, 0.10 + 0.05*l.n));
  });
}

// Link del file selezionato: blu = ciò che importa, rosa = chi lo importa.
function drawHighlightLinks(){
  var selfCell = visibleCellFor(highlight.self);
  if (!selfCell) return;
  highlight.imports.forEach(function(p){
    var c = visibleCellFor(p);
    if (c && c !== selfCell) drawBeam(centerOf(selfCell), centerOf(c), 2, "#2563eb", 0.75);
  });
  highlight.importers.forEach(function(p){
    var c = visibleCellFor(p);
    if (c && c !== selfCell) drawBeam(centerOf(c), centerOf(selfCell), 2, "#db2777", 0.75);
  });
}

function draw(){
  var r = cv.getBoundingClientRect();
  ctx.clearRect(0,0,r.width,r.height);
  cells.forEach(function(c){
    var base = colorFor(c.node.path || c.node.name);
    var isFile = !!c.node.file;
    var fill = c.parent ? tint(base, isFile ? 0.55 : 0.72) : tint(base, isFile ? 0.45 : 0.82);
    if (highlight){
      if (highlight.self === c.node.path) fill = "#fde047";
      else if (highlight.imports.indexOf(c.node.path) >= 0) fill = "#93c5fd";
      else if (highlight.importers.indexOf(c.node.path) >= 0) fill = "#f9a8d4";
    }
    ctx.fillStyle = fill;
    ctx.fillRect(c.x+0.5, c.y+0.5, Math.max(0,c.w-1), Math.max(0,c.h-1));
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.strokeRect(c.x+0.5, c.y+0.5, Math.max(0,c.w-1), Math.max(0,c.h-1));
    if (c.w > 58 && c.h > 16){
      ctx.fillStyle = "#3f3f46";
      ctx.font = (c.parent ? "11px" : "600 12px") + " system-ui,sans-serif";
      var label = c.node.name + (c.node.file ? "" : "/");
      ctx.save();
      ctx.beginPath(); ctx.rect(c.x+3, c.y+2, c.w-8, 15); ctx.clip();
      ctx.fillText(label, c.x+6, c.y+13);
      ctx.restore();
    }
  });
  // Overlay "circuiti": file selezionato → solo i suoi link; altrimenti aggregato.
  if (highlight) drawHighlightLinks();
  else if (linksOn) drawAggregatedLinks();
}

function cellAt(ev){
  var r = cv.getBoundingClientRect();
  var x = ev.clientX - r.left, y = ev.clientY - r.top;
  for (var i = cells.length-1; i >= 0; i--){
    var c = cells[i];
    if (x >= c.x && x <= c.x+c.w && y >= c.y && y <= c.y+c.h) return c;
  }
  return null;
}

function renderCrumb(){
  var el = document.getElementById("crumb");
  if (!el) return;
  var parts = (rootNode.path||"").split("/").filter(Boolean);
  var h = '<span data-p="">'+esc(DATA.meta.repo)+"</span>";
  var acc = "";
  parts.forEach(function(p){ acc += (acc?"/":"")+p; h += " / " + '<span data-p="'+esc(acc)+'">'+esc(p)+"</span>"; });
  el.innerHTML = h;
  el.querySelectorAll("span").forEach(function(s){
    s.onclick = function(){ rootNode = nodeByPath[s.getAttribute("data-p")] || DATA.tree; highlight = null; hideInfo(); renderCrumb(); layout(); };
  });
}

function hideInfo(){ var i = document.getElementById("info"); if (i) i.style.display = "none"; }

function showFile(p){
  var info = document.getElementById("info");
  if (!info) return;
  var fin = importersOf[p] || [], fout = importsOf[p] || [];
  highlight = { self: p, imports: fout, importers: fin };
  var h = "<b>"+esc(p)+"</b> — "+ fmt(nodeByPath[p] ? nodeByPath[p].loc : 0) +" LOC"
    + ' · <a href="'+esc(flink(p))+'">'+esc(T.openFile)+"</a>";
  if (fout.length) h += "<br><span class='muted'>"+esc(T.imports)+" ("+fout.length+"):</span> " + fout.slice(0,12).map(function(x){ return '<span class="lnk" data-p="'+esc(x)+'">'+esc(x)+"</span>"; }).join(", ");
  if (fin.length) h += "<br><span class='muted'>"+esc(T.importedBy)+" ("+fin.length+"):</span> " + fin.slice(0,12).map(function(x){ return '<span class="lnk" data-p="'+esc(x)+'">'+esc(x)+"</span>"; }).join(", ");
  h += ' &nbsp; <span class="lnk" id="clearhl">'+esc(T.close)+"</span>";
  info.innerHTML = h;
  info.style.display = "block";
  info.querySelectorAll(".lnk[data-p]").forEach(function(s){ s.onclick = function(){ locate(s.getAttribute("data-p")); }; });
  document.getElementById("clearhl").onclick = function(){ highlight = null; hideInfo(); layout(); };
  renderCrumb();
  layout();
}

function locate(p){
  if (current !== "map"){ current = "map"; renderTabs(); renderContent(); }
  var parent = p.split("/").slice(0,-1).join("/");
  var n = nodeByPath[parent];
  if (n) rootNode = n;
  showFile(p);
}

// ── catalogs ──
var sortState = {};
function renderCatalog(el, key){
  var isFiles = key === "__files";
  var cat = isFiles
    ? { title: T.filesTab, columns: ["file","loc","lang"], rows: DATA.files.map(function(f){ return { file: f.p, loc: f.loc, lang: f.l, link: flink(f.p) }; }) }
    : DATA.catalogs[key];
  if (!cat) return;
  var cols = cat.columns.filter(function(c){ return c !== "line"; });
  el.innerHTML = '<div class="panel">'
    +'<input id="search" placeholder="'+esc(T.searchPh)+'"/>'
    +'<div id="tablebox"></div>'
    +"</div>";
  var st = sortState[key] = sortState[key] || { col: null, asc: true };
  var searchEl = document.getElementById("search");

  function rowsFiltered(){
    var q = (searchEl.value||"").toLowerCase();
    var rows = cat.rows.filter(function(r){
      if (!q) return true;
      return cols.some(function(c){ return String(r[c]||"").toLowerCase().indexOf(q) >= 0; });
    });
    if (st.col){
      rows = rows.slice().sort(function(a,b){
        var x = a[st.col], y = b[st.col];
        if (typeof x === "number" && typeof y === "number") return st.asc ? x-y : y-x;
        return st.asc ? String(x||"").localeCompare(String(y||"")) : String(y||"").localeCompare(String(x||""));
      });
    }
    return rows;
  }

  function renderTable(){
    var rows = rowsFiltered();
    var thead = "<tr>" + cols.map(function(c){
      var arrow = st.col === c ? ' <span class="arrow">'+(st.asc?"▲":"▼")+"</span>" : "";
      return '<th data-c="'+esc(c)+'">'+esc(c.replace(/_/g," "))+arrow+"</th>";
    }).join("") + "</tr>";
    var body = rows.slice(0, 800).map(function(r){
      return "<tr>" + cols.map(function(c, ci){
        var v = r[c];
        if (c === "file" && r.link){
          var label = r.line ? r.file + ":" + r.line : r.file;
          return '<td><a class="filelnk" href="'+esc(r.link)+'">'+esc(label)+"</a></td>";
        }
        if (c === "page" && r.link) return '<td class="first"><a href="'+esc(r.link)+'">'+esc(v)+"</a></td>";
        if (c === "method"){
          var cls = v === "?" ? "badge q" : "badge";
          return '<td><span class="'+cls+'">'+esc(v)+"</span></td>";
        }
        return "<td"+(ci===0?' class="first"':"")+">"+esc(v)+"</td>";
      }).join("") + "</tr>";
    }).join("");
    var foot = "";
    if (!rows.length) foot = '<tr><td colspan="'+cols.length+'" class="muted">'+esc(T.noResults)+' "'+esc(searchEl.value)+'"</td></tr>';
    else if (rows.length > 800) foot = '<tr><td colspan="'+cols.length+'" class="muted">+'+fmt(rows.length-800)+" "+esc(T.rows)+" — "+esc(T.refine)+"</td></tr>";
    document.getElementById("tablebox").innerHTML = "<table><thead>"+thead+"</thead><tbody>"+body+foot+"</tbody></table>";
    document.querySelectorAll("th[data-c]").forEach(function(th){
      th.onclick = function(){
        var c = th.getAttribute("data-c");
        if (st.col === c) st.asc = !st.asc; else { st.col = c; st.asc = true; }
        renderTable();
      };
    });
  }
  searchEl.addEventListener("input", renderTable);
  renderTable();
}

window.addEventListener("resize", function(){ if (current === "map") layout(); });
renderTabs();
renderContent();
</script>
</body>
</html>`;
  return TEMPLATE
    .replace("__DATA__", dataJson)
    .replace("__I18N__", JSON.stringify(I18N))
    .replace(/__REPO__/g, repoName.replace(/[<>&]/g, ""));
}
