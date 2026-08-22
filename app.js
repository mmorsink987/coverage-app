/* Coverage PWA — R1b. Spec: automations/app-overlay-pwa.md v0.4
   Data: full-mirror JSON at app-data/search-index.json (built by Action).
   Storage: localStorage (cfg, draft, queue, etag) + IndexedDB (index blob).
   Push lane 1 only: append-only new files into inbox/. No model anywhere. */
"use strict";
const $ = (id) => document.getElementById(id);
const LS = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

/* ---------- IndexedDB (index blob lives here; too big for localStorage) ---------- */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("coverage", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function kvGet(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction("kv").objectStore("kv").get(key);
    t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error);
  });
}
async function kvSet(key, val) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction("kv", "readwrite").objectStore("kv").put(val, key);
    t.onsuccess = () => res(); t.onerror = () => rej(t.error);
  });
}

/* ---------- state ---------- */
let INDEX = null;          // parsed mirror
let cardOpenFor = null;

/* ---------- GitHub API ---------- */
function cfg() { return LS.get("cfg", null); }
function ghHeaders(extra) {
  return Object.assign({
    "Authorization": "Bearer " + cfg().token,
    "X-GitHub-Api-Version": "2022-11-28",
  }, extra || {});
}
async function syncIndex(force) {
  const c = cfg(); if (!c) return;
  setAsof("syncing…");
  try {
    const h = ghHeaders({ "Accept": "application/vnd.github.raw+json" });
    const etag = LS.get("etag", null);
    if (etag && !force) h["If-None-Match"] = etag;
    const r = await fetch(`https://api.github.com/repos/${c.repo}/contents/app-data/search-index.json?ref=main`, { headers: h });
    if (r.status === 304) { setAsofFromIndex(); return; }
    if (!r.ok) throw new Error("HTTP " + r.status);
    const text = await r.text();
    const newEtag = r.headers.get("ETag");
    INDEX = JSON.parse(text);
    await kvSet("index", text);
    if (newEtag) LS.set("etag", newEtag);
    setAsofFromIndex();
  } catch (e) {
    setAsof(INDEX ? asofStamp() + " (offline)" : "no data — connect once");
  }
}
async function loadCachedIndex() {
  const text = await kvGet("index").catch(() => null);
  if (text) { INDEX = JSON.parse(text); setAsofFromIndex(); }
}
function asofStamp() {
  if (!INDEX) return "—";
  const d = new Date(INDEX.generated_at);
  return "as of " + d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function setAsof(t) { $("asof").textContent = t; }
function setAsofFromIndex() { setAsof(asofStamp()); }

/* ---------- search ---------- */
function norm(s) { return (s || "").toLowerCase(); }
function search(q) {
  if (!INDEX || !q) return [];
  q = norm(q.trim());
  const hits = [];
  // 1. entities by name/alias/slug (prefix beats substring)
  for (const e of INDEX.entities) {
    const names = [e.name, e.slug, ...(e.aliases || [])].map(norm);
    let score = -1;
    for (const n of names) {
      if (!n) continue;
      if (n === q) score = Math.max(score, 100);
      else if (n.startsWith(q)) score = Math.max(score, 80);
      else if (n.split(/\s+/).some(w => w.startsWith(q))) score = Math.max(score, 70);
      else if (n.includes(q)) score = Math.max(score, 50);
    }
    if (score > 0) hits.push({ kind: "entity", score, e });
  }
  // 2. rolodex rows
  for (const cnt of INDEX.contacts) {
    const hay = norm(cnt.name + " " + cnt.org + " " + cnt.context);
    if (norm(cnt.name).startsWith(q)) hits.push({ kind: "rolodex", score: 78, c: cnt });
    else if (hay.includes(q)) hits.push({ kind: "rolodex", score: 40, c: cnt });
  }
  // 3. full text (only for queries >2 chars, capped)
  if (q.length > 2) {
    let n = 0;
    for (const f of INDEX.files) {
      if (n > 25) break;
      const i = norm(f.body).indexOf(q);
      if (i >= 0) {
        const snip = f.body.substr(Math.max(0, i - 40), 110).replace(/\s+/g, " ");
        hits.push({ kind: "text", score: 10, f, snip }); n++;
      }
    }
  }
  hits.sort((a, b) => b.score - a.score);
  // dedupe entity + its own text hit
  const seen = new Set(), out = [];
  for (const h of hits) {
    const key = h.kind === "entity" ? "e:" + h.e.slug : h.kind === "rolodex" ? "r:" + h.c.name : "t:" + h.f.path;
    if (!seen.has(key)) { seen.add(key); out.push(h); }
    if (out.length >= 40) break;
  }
  return out;
}
function renderResults(list) {
  const el = $("results"); el.innerHTML = "";
  for (const h of list) {
    const d = document.createElement("div"); d.className = "hit";
    if (h.kind === "entity") {
      d.innerHTML = `<div class="t">${esc(h.e.name)}<span class="badge">${h.e.type}</span></div>
                     <div class="s">${esc(h.e.slug)}</div>`;
      d.onclick = () => openCard(h.e.slug);
    } else if (h.kind === "rolodex") {
      d.innerHTML = `<div class="t">${esc(h.c.name)}<span class="badge rolodex">rolodex</span></div>
                     <div class="s">${esc(h.c.org)} — ${esc(h.c.role || h.c.context)}${h.c.email ? " · " + esc(h.c.email) : ""}</div>`;
      d.onclick = () => openRolodexCard(h.c);
    } else {
      d.innerHTML = `<div class="t">${esc(h.f.path)}</div><div class="s">…${esc(h.snip)}…</div>`;
      d.onclick = () => openFile(h.f.path);
    }
    el.appendChild(d);
  }
}
function esc(s) { const d = document.createElement("div"); d.textContent = s || ""; return d.innerHTML; }

/* ---------- cards ---------- */
function linkify(text) {
  return esc(text).replace(/\[\[([a-z0-9-]+)\]\]/g, '<span class="wl" data-slug="$1">$1</span>');
}
function openCard(slug) {
  const parts = INDEX.files.filter(f => f.slug === slug)
    .sort((a, b) => (a.path.endsWith("index.md") || a.path.includes("/people/") ? -1 : 1));
  if (!parts.length) return;
  const head = parts[0];
  let html = `<button class="backbtn" onclick="closeCard()">✕</button>
    <h1>${esc(head.name || slug)}</h1>
    <div class="meta">${esc(head.type)}${head.sector ? " · " + esc(head.sector) : ""}${head.sponsor && head.sponsor !== "null" ? " · " + esc(head.sponsor) : ""}</div>`;
  for (const p of parts) {
    const label = p.path.endsWith("index.md") ? "" : p.path.split("/").slice(-2).join("/");
    if (label) html += `<h4>${esc(label)}</h4>`;
    html += `<pre>${linkify(p.body)}</pre>`;
  }
  showCard(html, slug);
}
function openRolodexCard(c) {
  showCard(`<button class="backbtn" onclick="closeCard()">✕</button>
    <h1>${esc(c.name)}</h1><div class="meta">rolodex — lookup only</div>
    <pre>${linkify(`org: ${c.org}\nrole: ${c.role}\nemail: ${c.email}\nphone: ${c.phone}\n\n${c.context}`)}</pre>`, null);
}
function openFile(path) {
  const f = INDEX.files.find(x => x.path === path); if (!f) return;
  showCard(`<button class="backbtn" onclick="closeCard()">✕</button>
    <h1>${esc(path)}</h1><pre>${linkify(f.body)}</pre>`, null);
}
function showCard(html, slug) {
  cardOpenFor = slug; const c = $("card");
  c.innerHTML = html; c.classList.remove("hidden");
  c.querySelectorAll(".wl").forEach(el => el.onclick = () => openCard(el.dataset.slug));
  c.scrollTop = 0;
}
function closeCard() { $("card").classList.add("hidden"); cardOpenFor = null; }
window.closeCard = closeCard;

/* ---------- note tab: draft persistence + autocomplete + queue ---------- */
const note = () => $("note");
function saveDraft() { LS.set("draft", note().value); $("note-status").textContent = "draft saved locally"; }
function restoreDraft() { note().value = LS.get("draft", ""); }

function acCandidates(frag) {
  frag = norm(frag);
  const pool = INDEX ? INDEX.entities : [];
  const scored = [];
  for (const e of pool) {
    const names = [e.name, e.slug, ...(e.aliases || [])].map(norm);
    if (names.some(n => n.startsWith(frag) || n.split(/\s+/).some(w => w.startsWith(frag))))
      scored.push(e);
    if (scored.length > 8) break;
  }
  return scored;
}
function acDetect() {
  const t = note(), v = t.value, pos = t.selectionStart;
  const before = v.slice(0, pos);
  const m = before.match(/\/([a-z0-9-]{1,30})$/i);
  if (!m) { $("ac").classList.add("hidden"); return; }
  const frag = m[1];
  const cands = acCandidates(frag);
  const box = $("ac"); box.innerHTML = "";
  for (const e of cands) {
    const d = document.createElement("div"); d.className = "acitem";
    d.innerHTML = `<div class="t">${esc(e.name)}</div><div class="s">${esc(e.type)} · [[${esc(e.slug)}]]</div>`;
    d.onclick = () => acInsert(m[0].length, `[[${e.slug}]]`);
    box.appendChild(d);
  }
  const nu = document.createElement("div"); nu.className = "acitem new";
  nu.innerHTML = `<div class="t">＋ new: “${esc(frag)}”</div><div class="s">mark as deliberate new-entity candidate</div>`;
  nu.onclick = () => acInsert(m[0].length, `[[new:${frag}]]`);
  box.appendChild(nu);
  box.classList.remove("hidden");
}
function acInsert(fragLen, token) {
  const t = note(), pos = t.selectionStart;
  t.value = t.value.slice(0, pos - fragLen) + token + " " + t.value.slice(pos);
  const np = pos - fragLen + token.length + 1;
  t.setSelectionRange(np, np); t.focus();
  $("ac").classList.add("hidden"); saveDraft();
}

/* queue: [{path, content, message}] — append-only inbox writes */
function queue() { return LS.get("queue", []); }
function setQueue(q) { LS.set("queue", q); renderQueueBadge(); }
function renderQueueBadge() {
  const n = queue().length;
  $("queue-badge").textContent = n ? `${n} queued` : "";
}
function b64utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = ""; bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin);
}
function noteFilename(text) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const tag = (text.match(/\[\[([a-z0-9-]+)\]\]/) || [])[1] || "note";
  return `inbox/${stamp}-${tag}.md`;
}
async function saveNote() {
  const text = note().value.trim();
  if (!text) return;
  const d = new Date();
  const content = text + `\n\n<!-- captured: app, ${d.toISOString()} | state: unprocessed -->\n`;
  const path = noteFilename(text);
  const q = queue(); q.push({ path, content, message: `app: note ${path.split("/")[1]}` });
  setQueue(q);
  note().value = ""; LS.set("draft", "");
  $("note-status").textContent = "queued";
  flushQueue();
}
let flushing = false;
async function flushQueue() {
  if (flushing || !navigator.onLine || !cfg()) { renderQueueBadge(); return; }
  flushing = true;
  try {
    let q = queue();
    while (q.length) {
      const item = q[0];
      const r = await fetch(`https://api.github.com/repos/${cfg().repo}/contents/${encodeURIComponent(item.path).replace(/%2F/g, "/")}`, {
        method: "PUT",
        headers: ghHeaders({ "Accept": "application/vnd.github+json", "Content-Type": "application/json" }),
        body: JSON.stringify({ message: item.message, content: b64utf8(item.content), branch: "main" }),
      });
      if (r.status === 201 || r.status === 200) {
        q.shift(); setQueue(q);
        $("note-status").textContent = "saved to inbox ✓";
      } else if (r.status === 422) { // path exists — collision; disambiguate and retry
        item.path = item.path.replace(/\.md$/, "-b.md"); setQueue(q);
      } else { break; } // auth/network problem — leave queued
    }
  } catch (e) { /* offline mid-flush — stays queued */ }
  flushing = false; renderQueueBadge();
}

/* ---------- tabs & boot ---------- */
function showTab(name) {
  for (const s of document.querySelectorAll(".tab")) s.classList.add("hidden");
  $("tab-" + name).classList.remove("hidden");
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("active", b.dataset.tab === name);
  if (name === "note") note().focus();
}
function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
  document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => showTab(b.dataset.tab));
  $("q").oninput = () => { closeCard(); renderResults(search($("q").value)); };
  $("asof").onclick = () => syncIndex(true);
  note().addEventListener("input", () => { saveDraft(); acDetect(); });
  note().addEventListener("keyup", acDetect);
  $("note-save").onclick = saveNote;
  window.addEventListener("online", flushQueue);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { syncIndex(false); flushQueue(); } });

  restoreDraft(); renderQueueBadge();
  if (!cfg()) {
    $("setup").classList.remove("hidden");
    $("cfg-save").onclick = async () => {
      const repo = $("cfg-repo").value.trim(), token = $("cfg-token").value.trim();
      if (!repo || !token) return;
      LS.set("cfg", { repo, token });
      $("cfg-status").textContent = "testing…";
      await syncIndex(true);
      if (INDEX) { $("setup").classList.add("hidden"); $("main").classList.remove("hidden"); }
      else { $("cfg-status").textContent = "Could not sync — check token/repo."; localStorage.removeItem("cfg"); }
    };
  } else {
    $("main").classList.remove("hidden");
    loadCachedIndex().then(() => syncIndex(false)).then(flushQueue);
  }
}
boot();
