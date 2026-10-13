// Collects the Nostr Builders Directory data and writes site/data.json.
//
// Sources:
//   1. Git repos announced on Nostr (NIP-34 kind 30617) plus their recent activity (patches, issues, status, state).
//   2. The most-starred GitHub repos tagged "nostr" whose README names an npub/nprofile.
// For every profile found it fetches kind 0 (profile), kind 1 (posts in the last 30 days) and kind 3 (follows), and
// ranks people by how many *other builders* follow them. Visitors can re-rank by their own network in the browser.
//
// Run: bun collect.ts   (GITHUB_TOKEN in the environment raises GitHub's rate limits; optional locally)

const RELAYS = ["wss://relay.ngit.dev", "wss://gitnostr.com", "wss://relay.gittr.space", "wss://relay.damus.io",
  "wss://nos.lol", "wss://relay.primal.net", "wss://relay.ditto.pub"];
const PROFILE_RELAYS = ["wss://purplepag.es", "wss://relay.primal.net", "wss://relay.damus.io", "wss://nos.lol", "wss://relay.ditto.pub"];
const DAY = 86400, NOW = Math.floor(Date.now() / 1000);
const RECENT_S = 120 * DAY, POSTS_S = 30 * DAY;
const GITHUB_PAGES = 10; // x100 repos, by stars
const MIN_ENTRIES = 50; // fewer than this means relays were down: fail instead of publishing a gutted page
const log = (...a: unknown[]) => console.error(new Date().toISOString().slice(11, 19), ...a);

// ------------------------------------------------------------------ relay access

function query(url: string, filter: object, ms = 25_000): Promise<any[]> {
  return new Promise((res) => {
    const out: any[] = [];
    let ws: WebSocket;
    const done = () => { try { ws.close(); } catch {} res(out); };
    const t = setTimeout(done, ms);
    try { ws = new WebSocket(url); } catch { clearTimeout(t); return res(out); }
    ws.onopen = () => ws.send(JSON.stringify(["REQ", "q", filter]));
    ws.onmessage = (m) => {
      let d: any;
      try { d = JSON.parse(String(m.data)); } catch { return; }
      if (d[0] === "EVENT") out.push(d[2]);
      if (d[0] === "EOSE" || d[0] === "CLOSED") { clearTimeout(t); done(); }
    };
    ws.onerror = () => { clearTimeout(t); done(); };
  });
}

/** Pages backwards with `until` until a relay returns nothing new (relays cap results per REQ). */
async function queryAll(url: string, filter: object, maxPages = 40): Promise<any[]> {
  const out = new Map<string, any>();
  let until: number | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await query(url, { ...filter, ...(until ? { until } : {}) });
    let fresh = 0;
    for (const e of page) if (!out.has(e.id)) { out.set(e.id, e); fresh++; }
    if (!fresh || page.length < 50) break;
    until = Math.min(...page.map((e) => e.created_at));
  }
  return [...out.values()];
}

const tag = (e: any, n: string) => e.tags.find((t: string[]) => t[0] === n)?.[1];

// ------------------------------------------------------------------ bech32 (npub / nprofile)

const CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(v: number[]) {
  const g = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let c = 1;
  for (const x of v) { const b = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c ^= g[i]; }
  return c >>> 0;
}
function npubOf(hex: string) {
  const bytes = hex.match(/../g)!.map((h) => parseInt(h, 16));
  const out: number[] = [];
  let acc = 0, bits = 0;
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out.push((acc >>> bits) & 31); } acc &= 0xff; }
  if (bits) out.push((acc << (5 - bits)) & 31);
  const hrp = "npub", hx = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat(0, [...hrp].map((c) => c.charCodeAt(0) & 31));
  const p = polymod(hx.concat(out, [0, 0, 0, 0, 0, 0])) ^ 1;
  return hrp + "1" + out.concat([0, 1, 2, 3, 4, 5].map((i) => (p >>> (5 * (5 - i))) & 31)).map((x) => CH[x]).join("");
}
/** npub1… or nprofile1… -> hex pubkey (checksum verified), else null. */
function pubkeyOf(s: string): string | null {
  s = s.toLowerCase();
  const i = s.lastIndexOf("1"), hrp = s.slice(0, i), data = [...s.slice(i + 1)].map((c) => CH.indexOf(c));
  if (data.some((x) => x < 0) || data.length < 7) return null;
  const hx = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat(0, [...hrp].map((c) => c.charCodeAt(0) & 31));
  if (polymod(hx.concat(data)) !== 1) return null;
  const bytes: number[] = [];
  let acc = 0, bits = 0;
  for (const x of data.slice(0, -6)) { acc = (acc << 5) | x; bits += 5; if (bits >= 8) { bits -= 8; bytes.push((acc >>> bits) & 255); } acc &= 0xfff; }
  const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, "0")).join("");
  if (hrp === "npub") return bytes.length >= 32 ? hex(bytes.slice(0, 32)) : null;
  for (let j = 0; j + 2 <= bytes.length; j += 2 + bytes[j + 1]) // nprofile TLV: type 0 = pubkey
    if (bytes[j] === 0 && bytes[j + 1] === 32) return hex(bytes.slice(j + 2, j + 34));
  return null;
}

// ------------------------------------------------------------------ 1. git on Nostr (NIP-34)

log("NIP-34 repo announcements…");
const announcements = new Map<string, any>(); // "pubkey:d" -> newest announcement
for (const evs of await Promise.all(RELAYS.map((u) => queryAll(u, { kinds: [30617], limit: 500 })))) {
  for (const e of evs) {
    const d = tag(e, "d");
    if (!d) continue;
    const k = e.pubkey + ":" + d;
    if (!(announcements.get(k)?.created_at >= e.created_at)) announcements.set(k, e);
  }
}
log("  repos:", announcements.size);

log("NIP-34 activity (last 120 days)…");
const activity = new Map<string, { n: number; last: number; people: Set<string> }>();
const seenAct = new Set<string>();
for (const evs of await Promise.all(RELAYS.map((u) =>
  queryAll(u, { kinds: [1617, 1618, 1619, 1621, 1630, 1631, 1632, 1633, 30618], since: NOW - RECENT_S, limit: 500 }, 20)))) {
  for (const e of evs) {
    if (seenAct.has(e.id)) continue;
    seenAct.add(e.id);
    const keys = e.kind === 30618 ? [e.pubkey + ":" + tag(e, "d")]
      : e.tags.filter((t: string[]) => t[0] === "a" && t[1]?.startsWith("30617:")).map((t: string[]) => t[1].slice(6));
    for (const k of keys) {
      const a = activity.get(k) ?? { n: 0, last: 0, people: new Set<string>() };
      a.n++; a.last = Math.max(a.last, e.created_at); a.people.add(e.pubkey);
      activity.set(k, a);
    }
  }
}
log("  activity events:", seenAct.size);

type Project = { src: "nostr" | "github"; name: string; desc: string; link: string; act: number; recent: boolean; stars: number };
const projects = new Map<string, Project[]>();
const addProject = (pk: string, p: Project) => projects.set(pk, [...(projects.get(pk) ?? []), p]);
for (const [k, e] of announcements) {
  const a = activity.get(k), d = tag(e, "d")!;
  const recent = Math.max(a?.last ?? 0, e.created_at) > NOW - RECENT_S;
  const web = e.tags.find((t: string[]) => t[0] === "web")?.[1];
  addProject(e.pubkey, {
    src: "nostr", name: (tag(e, "name") || d).slice(0, 80), desc: (tag(e, "description") || "").replace(/\s+/g, " ").slice(0, 180),
    link: /^https?:\/\//.test(web ?? "") ? web : `https://gitworkshop.dev/${npubOf(e.pubkey)}/${encodeURIComponent(d)}`,
    act: a?.n ?? 0, recent, stars: 0,
  });
}

// ------------------------------------------------------------------ 2. GitHub repos tagged "nostr"

log("GitHub search…");
const ghHeaders: Record<string, string> = { "User-Agent": "nostr-builders-directory", Accept: "application/vnd.github+json" };
if (process.env.GITHUB_TOKEN) ghHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
const ghRepos: any[] = [];
for (let page = 1, tries = 0; page <= GITHUB_PAGES && tries < 5; ) {
  const r = await fetch(`https://api.github.com/search/repositories?q=topic:nostr&sort=stars&order=desc&per_page=100&page=${page}`, { headers: ghHeaders });
  if (r.status === 403 || r.status === 429) { tries++; log("  rate limited, waiting"); await Bun.sleep(65_000); continue; }
  if (!r.ok) { log("  search failed", r.status); break; }
  const j: any = await r.json();
  ghRepos.push(...j.items.map((x: any) => ({ full: x.full_name, stars: x.stargazers_count, desc: (x.description || "").slice(0, 180),
    pushed: x.pushed_at, branch: x.default_branch, archived: x.archived })));
  if (j.items.length < 100) break;
  page++;
  await Bun.sleep(process.env.GITHUB_TOKEN ? 2500 : 7000);
}
log("  repos:", ghRepos.length);

const MAX_README_NPUBS = 3;
const NPUB_RE =/\b(npub1[02-9ac-hj-np-z]{58}|nprofile1[02-9ac-hj-np-z]{20,})\b/gi;
const recentIso = new Date((NOW - RECENT_S) * 1000).toISOString();
async function readme(r: any) {
  for (const f of ["README.md", "readme.md", "README", "README.markdown"]) {
    const res = await fetch(`https://raw.githubusercontent.com/${r.full}/${r.branch}/${f}`).catch(() => null);
    if (res?.ok) return res.text();
  }
  return "";
}
for (let i = 0; i < ghRepos.length; i += 16) {
  await Promise.all(ghRepos.slice(i, i + 16).map(async (r) => {
    const pks = new Set<string>();
    for (const m of (await readme(r)).matchAll(NPUB_RE)) { const pk = pubkeyOf(m[1]); if (pk) pks.add(pk); }
    // A README naming many npubs is a list or a credits section, not a sign of who runs the project.
    if (pks.size > MAX_README_NPUBS) return;
    for (const pk of pks)
      addProject(pk, { src: "github", name: r.full, desc: r.desc.replace(/\s+/g, " "), link: `https://github.com/${r.full}`,
        act: 0, recent: !r.archived && r.pushed > recentIso, stars: r.stars });
  }));
}

// ------------------------------------------------------------------ 3. profiles, posts, follows

// Candidates: anyone with a recently active repo on Nostr, or named in a GitHub README.
const candidates = [...projects].filter(([, ps]) => ps.some((p) => p.recent || p.src === "github")).map(([pk]) => pk);
log("profiles to check:", candidates.length);
const profile = new Map<string, any>(), contacts = new Map<string, any>(), posts = new Map<string, Set<string>>();
for (let i = 0; i < candidates.length; i += 100) {
  const authors = candidates.slice(i, i + 100);
  const got = await Promise.all(PROFILE_RELAYS.map((u) => Promise.all([
    query(u, { kinds: [0, 3], authors }),
    query(u, { kinds: [1], authors, since: NOW - POSTS_S, limit: 3000 }),
  ])));
  for (const [meta, notes] of got) {
    for (const e of meta) {
      const m = e.kind === 0 ? profile : contacts;
      if (!(m.get(e.pubkey)?.created_at >= e.created_at)) m.set(e.pubkey, e);
    }
    for (const e of notes) { const s = posts.get(e.pubkey) ?? new Set(); s.add(e.id); posts.set(e.pubkey, s); }
  }
  log("  ", Math.min(i + 100, candidates.length), "/", candidates.length);
}

// "Followed by N builders": how many other candidates list this person in their follows.
// The directory's own author never counts: their follows must not shape the public ranking, even if they qualify.
const OWNER = pubkeyOf("npub175rnagjgxtvwvfrdytkqkkn4h062zf2cuwkx0jc8xc9nga895s8qgsef5g");
const candSet = new Set(candidates), builderFollowers = new Map<string, number>();
for (const [pk, e] of contacts) if (pk !== OWNER)
  for (const p of new Set<string>(e.tags.filter((t: string[]) => t[0] === "p").map((t: string[]) => t[1])))
    if (p !== pk && candSet.has(p)) builderFollowers.set(p, (builderFollowers.get(p) ?? 0) + 1);

// ------------------------------------------------------------------ 4. filter, score, write

const NOSTRY = /nostr|nip-?\d|relay|zap|blossom|ngit|npub|lightning|bitcoin|cashu|nwc|ecash/i;
const entries: any[] = [];
for (const pk of candidates) {
  let c: any = {};
  try { c = JSON.parse(profile.get(pk)?.content ?? "{}"); } catch {}
  const name = String(c.display_name || c.name || "").trim().slice(0, 40);
  if (!name) continue;
  const seen = new Set<string>();
  // Most clearly theirs first: GitHub repos whose owner matches their name/NIP-05/website, then repos they announced
  // on Nostr themselves, then GitHub repos that merely mention their npub.
  const ids = [c.name, c.display_name, c.nip05, c.website, c.lud16].map((x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "")).filter((x) => x.length >= 3);
  const owned = (p: Project) => { const o = p.name.split("/")[0].toLowerCase().replace(/[^a-z0-9]/g, ""); return o.length >= 3 && ids.some((x) => x.includes(o) || o.includes(x)); };
  const rank = (p: Project) => (p.src === "github" ? (owned(p) ? 0 : 2) : 1);
  const ps = (projects.get(pk) ?? []).sort((a, b) => rank(a) - rank(b) || b.stars - a.stars || b.act - a.act || Number(b.recent) - Number(a.recent))
    .filter((p) => !seen.has(p.name.toLowerCase()) && seen.add(p.name.toLowerCase()));
  const bf = builderFollowers.get(pk) ?? 0, n30 = posts.get(pk)?.size ?? 0;
  const stars = Math.max(0, ...ps.map((p) => p.stars)), act = ps.reduce((s, p) => s + p.act, 0);
  const nostry = ps.filter((p) => NOSTRY.test(p.name + " " + p.desc)).length, recent = ps.filter((p) => p.recent).length;
  if (!(n30 || bf >= 3 || act >= 5 || stars >= 50)) continue; // no sign of life or of anyone caring
  if (!nostry && stars < 50) continue; // not visibly about Nostr
  const site = String(c.website || "");
  entries.push({
    pk, npub: npubOf(pk), name, about: String(c.about || "").replace(/\s+/g, " ").slice(0, 160), nip05: String(c.nip05 || "").slice(0, 60),
    site: /^https?:\/\//.test(site) ? site.slice(0, 100) : "", posts: n30, bf, stars,
    // Activity part of the score; the client adds a network term (builders' follows, or the visitor's own).
    base: Math.round((Math.min(act, 60) / 4 + Math.sqrt(Math.min(stars, 3000)) / 3 + (n30 ? 8 : 0) + Math.min(nostry, 4) * 2 + Math.min(recent, 4)) * 10) / 10,
    projects: ps.slice(0, 6).map(({ src, name, desc, link, stars }) => ({ src, name, desc, link, stars })), more: Math.max(0, ps.length - 6),
  });
}
log("entries:", entries.length);
if (entries.length < MIN_ENTRIES) { log(`only ${entries.length} entries; relays probably failed. Not writing.`); process.exit(1); }
await Bun.write(new URL("./site/data.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  JSON.stringify({ generated: new Date().toISOString(), sources: { nostrRepos: announcements.size, githubRepos: ghRepos.length }, entries }));
log("wrote site/data.json");
process.exit(0);
