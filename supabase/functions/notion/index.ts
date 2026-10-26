// 永山工程 App — Notion 同步雲端程式（Supabase Edge Function：notion）
// Notion Token 存在 Supabase 的 Secrets（NOTION_TOKEN），不會出現在網頁裡。
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = "sb_publishable_arAwGnxdI-99frfVb3pMaA_pDGdzi_f";
const OWNER = "thesubconscious7@gmail.com";
const NV = "2025-09-03";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const out = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

class TE extends Error { code: string; constructor(code: string, m: string) { super(m); this.code = code; } }

let TOKEN = "";
async function N(method: string, path: string, body?: unknown, tries = 0): Promise<any> {
  const r = await fetch("https://api.notion.com/v1" + path, {
    method,
    headers: { Authorization: "Bearer " + TOKEN, "Notion-Version": NV, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 429 && tries < 4) {
    await new Promise((z) => setTimeout(z, 1000 * (Number(r.headers.get("retry-after")) || 1)));
    return N(method, path, body, tries + 1);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401) throw new TE("bad_token", "Notion Token 無效，請重新複製整合的 Token 貼到 Supabase Secrets。");
    if (r.status === 404 && /data_sources/.test(path)) throw new TE("not_shared", "整合還沒取得「每日記錄」的權限，請在 Notion 把「每日記錄」分享給整合。");
    throw new TE("tool_error", (j.message || r.statusText || "Notion error") + "");
  }
  return j;
}

// ---------- 資料庫欄位 ----------
let SCHEMA: Record<string, any> | null = null;
async function schema(ds: string) {
  if (SCHEMA) return SCHEMA;
  const d = await N("GET", "/data_sources/" + ds);
  SCHEMA = d.properties || {};
  return SCHEMA!;
}
const titleKey = (s: Record<string, any>) => Object.keys(s).find((k) => s[k].type === "title") || "Name";
const plain = (a: any[]) => (a || []).map((x) => x.plain_text || "").join("");

function rowOf(p: any) {
  const o: Record<string, unknown> = { url: p.url };
  for (const [k, v] of Object.entries<any>(p.properties || {})) {
    if (v.type === "title") o.Name = plain(v.title);
    else if (v.type === "date" && k === "Date") {
      const d = v.date;
      o["date:Date:start"] = d?.start || null;
      o["date:Date:end"] = d?.end || null;
      o["date:Date:is_datetime"] = d?.start && d.start.length > 10 ? 1 : 0;
    } else if (v.type === "status") o[k] = v.status?.name || null;
    else if (v.type === "select") o[k] = v.select?.name || null;
    else if (v.type === "rich_text") o[k] = plain(v.rich_text);
    else if (v.type === "number") o[k] = v.number == null ? null : String(v.number);
  }
  return o;
}

async function propsOf(ds: string, p: Record<string, any>) {
  const s = await schema(ds), o: Record<string, any> = {};
  if ("Name" in p) o[titleKey(s)] = { title: [{ text: { content: String(p.Name || "").slice(0, 2000) } }] };
  if ("date:Date:start" in p) {
    const st = p["date:Date:start"], en = p["date:Date:end"];
    o.Date = { date: st ? { start: String(st).slice(0, 10), end: en ? String(en).slice(0, 10) : null } : null };
  }
  for (const k of Object.keys(p)) {
    if (k === "Name" || k.startsWith("date:")) continue;
    const t = s[k]?.type, v = p[k];
    if (!t) continue;
    if (t === "status") o[k] = { status: v ? { name: v } : null };
    else if (t === "select") o[k] = { select: v ? { name: v } : null };
    else if (t === "rich_text") o[k] = { rich_text: v ? [{ text: { content: String(v) } }] : [] };
    else if (t === "number") o[k] = { number: v == null || v === "" ? null : Number(v) };
    else if (t === "title") o[k] = { title: [{ text: { content: String(v) } }] };
  }
  return o;
}

// ---------- 簡易 Markdown → Notion 區塊 ----------
const unesc = (s: string) => s.replace(/\\([\\*_`#\[\]<>|~])/g, "$1");
function rich(s: string) {
  const r: any[] = [];
  s.split(/(\*\*[^*]+\*\*)/).forEach((seg) => {
    if (!seg) return;
    const b = /^\*\*[^*]+\*\*$/.test(seg);
    const t = unesc(b ? seg.slice(2, -2) : seg);
    for (let i = 0; i < t.length; i += 1900) r.push({ type: "text", text: { content: t.slice(i, i + 1900) }, annotations: { bold: b } });
  });
  return r.length ? r : [{ type: "text", text: { content: "" } }];
}
function blocks(md: string) {
  const out: any[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push({ type: "paragraph", paragraph: { rich_text: rich(para.join("\n")) } }); para = []; } };
  for (const raw of md.split("\n")) {
    const l = raw.replace(/ {2}$/, "");
    let m;
    if (!l.trim()) { flush(); continue; }
    if ((m = l.match(/^## (.*)$/))) { flush(); out.push({ type: "heading_2", heading_2: { rich_text: rich(m[1]) } }); }
    else if ((m = l.match(/^> (.*)$/))) { flush(); out.push({ type: "quote", quote: { rich_text: rich(m[1]) } }); }
    else if ((m = l.match(/^- \[( |x)\] (.*)$/))) { flush(); out.push({ type: "to_do", to_do: { rich_text: rich(m[2]), checked: m[1] === "x" } }); }
    else para.push(l);
  }
  flush();
  return out;
}
async function replaceContent(id: string, md: string) {
  let cur: string | undefined;
  const ids: string[] = [];
  do {
    const r = await N("GET", `/blocks/${id}/children?page_size=100${cur ? "&start_cursor=" + cur : ""}`);
    r.results.forEach((b: any) => ids.push(b.id));
    cur = r.has_more ? r.next_cursor : undefined;
  } while (cur);
  for (const b of ids) await N("DELETE", "/blocks/" + b);
  const bl = blocks(md);
  for (let i = 0; i < bl.length; i += 100) await N("PATCH", `/blocks/${id}/children`, { children: bl.slice(i, i + 100) });
}

// ---------- 對應 App 用到的四個動作 ----------
async function run(tool: string, input: any) {
  if (tool === "notion-query-data-sources") {
    const d = input.data || {};
    const ds = d.data_source_id || input.ds;
    const since = new Date(Date.now() - 150 * 864e5).toISOString().slice(0, 10);
    const r = await N("POST", `/data_sources/${ds}/query`, {
      page_size: Math.min(d.page_size || 100, 100),
      ...(d.start_cursor ? { start_cursor: d.start_cursor } : {}),
      filter: { property: "Date", date: { on_or_after: since } },
    });
    return { results: r.results.map(rowOf), has_more: r.has_more, next_cursor: r.next_cursor };
  }
  if (tool === "notion-create-pages") {
    const ds = input.parent.data_source_id, pages = [];
    for (const p of input.pages) {
      const r = await N("POST", "/pages", { parent: { type: "data_source_id", data_source_id: ds }, properties: await propsOf(ds, p.properties) });
      pages.push({ id: r.id, url: r.url });
    }
    return { pages };
  }
  if (tool === "notion-update-page") {
    if (input.command === "update_properties") {
      await N("PATCH", "/pages/" + input.page_id, { properties: await propsOf(input.ds, input.properties) });
      return { ok: true };
    }
    if (input.command === "replace_content") { await replaceContent(input.page_id, input.new_str || ""); return { ok: true }; }
  }
  if (tool === "notion-delete-pages") {
    for (const id of input.page_ids) {
      try { await N("PATCH", "/pages/" + id, { in_trash: true }); }
      catch (x) { if ((x as TE).code === "tool_error") await N("PATCH", "/pages/" + id, { archived: true }); else throw x; }
    }
    return { ok: true };
  }
  throw new TE("tool_error", "unknown tool " + tool);
}


// ---------- Siri 捷徑：說一句話 → 新增工程任務 ----------
const WD = "日一二三四五六";
const CN: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
const tw = () => new Date(Date.now() + 8 * 3600e3);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addD = (d: Date, n: number) => new Date(d.getTime() + n * 864e5);
function parseDate(t: string): { d: string; rest: string } {
  const now = tw();
  const rules: [RegExp, (m: RegExpMatchArray) => Date | null][] = [
    [/大後天/, () => addD(now, 3)],
    [/後天/, () => addD(now, 2)],
    [/明天|明日/, () => addD(now, 1)],
    [/今天|今日/, () => now],
    [/(下)?(?:個)?(?:週|周|星期|禮拜)([一二三四五六日天])/, (m) => {
      const want = CN[m[2]], cur = now.getUTCDay();
      let diff = (want - cur + 7) % 7;
      if (m[1]) diff = ((want || 7) - (cur || 7)) + 7; // 下週X：下一週的那天（週一為一週開始）
      return addD(now, diff);
    }],
    [/(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*[日號号]?/, (m) => {
      let d = new Date(Date.UTC(now.getUTCFullYear(), +m[1] - 1, +m[2]));
      if (ymd(d) < ymd(addD(now, -60))) d = new Date(Date.UTC(now.getUTCFullYear() + 1, +m[1] - 1, +m[2]));
      return d;
    }],
    [/(\d{1,2})\s*[日號号]/, (m) => {
      let d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), +m[1]));
      if (ymd(d) < ymd(now)) d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, +m[1]));
      return d;
    }],
  ];
  for (const [re, f] of rules) {
    const m = t.match(re);
    if (m) { const d = f(m); if (d) return { d: ymd(d), rest: t.replace(m[0], " ") }; }
  }
  return { d: ymd(now), rest: t };
}
function dbKey() {
  try { const j = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); const v = Object.values(j)[0]; if (v) return String(v); } catch (_) { /* */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
}
async function rest(method: string, path: string, body?: unknown) {
  const k = dbKey();
  const h: Record<string, string> = { apikey: k, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" };
  if (k.startsWith("eyJ")) h.Authorization = "Bearer " + k;
  const r = await fetch(SB_URL + "/rest/v1/" + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new TE("tool_error", "資料庫寫入失敗：" + (await r.text()).slice(0, 200));
  return method === "GET" ? r.json() : null;
}
async function siri(text: string) {
  text = String(text || "").trim();
  if (!text) return "沒有聽到內容，請再說一次。";
  const { d, rest: r0 } = parseDate(text);
  const cases: any[] = (await rest("GET", "docs?col=eq.cases&select=data")).map((x: any) => x.data).filter((c: any) => c.id >= 100);
  const flat = (x: string) => x.replace(/\s+/g, "");
  let hit: any = null, used = "";
  for (const c of cases.sort((a, b) => b.id - a.id)) {
    const full = flat(c.name || "");
    const parts = [full, ...String(c.name || "").split(/\s+/)].filter((p) => p.length >= 2);
    const p = parts.find((p) => flat(r0).includes(p));
    if (p) { hit = c; used = p; break; }
  }
  let name = r0;
  if (used) name = flat(name).replace(used, "");
  name = name.replace(/^[\s,，。、的要去把幫我提醒]+|[\s,，。、]+$/g, "").replace(/\s+/g, " ").trim() || text;
  const id = Date.now();
  const t: Record<string, unknown> = { id, c: hit ? hit.id : 0, n: name, w: "", s: d, e: d, st: "todo", sub: [] };
  // 同步建立 Notion 行事曆頁面
  try {
    TOKEN = Deno.env.get("NOTION_TOKEN") || "";
    if (TOKEN) {
      const ds = "0426695c-9862-45d8-b2df-bd4a2c6e1b09";
      const nn = name + (hit ? "｜" + hit.name : "");
      const r: any = await run("notion-create-pages", { parent: { data_source_id: ds }, pages: [{ properties: { Name: nn, "date:Date:start": d, "date:Date:end": null, "date:Date:is_datetime": 0, "狀態": "未開始", AppID: String(id) } }] });
      const m = String(r.pages[0].url).match(/([0-9a-f]{32})/);
      if (m) { t.np = m[1]; t.nh = JSON.stringify([nn, d, d, "未開始"]); }
    }
  } catch (_) { /* Notion 失敗時，App 打開後會自動補同步 */ }
  await rest("POST", "docs", { col: "tasks", id: String(id), data: t });
  const dd = new Date(d + "T00:00:00Z");
  return `已加入 ${dd.getUTCMonth() + 1}/${dd.getUTCDate()}（${WD[dd.getUTCDay()]}）：${name}${hit ? "，案件 " + hit.name : "，其他行程"}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const sk = req.headers.get("x-siri-key");
  if (sk !== null) {
    const want = Deno.env.get("SIRI_KEY") || "";
    if (!want || sk !== want) return new Response("密碼不正確，請檢查捷徑設定。", { status: 401 });
    try {
      SCHEMA = null;
      const b = await req.json().catch(() => ({}));
      return new Response(await siri(b.text), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    } catch (x) { return new Response("新增失敗：" + String((x as Error).message || x).slice(0, 150), { status: 500 }); }
  }
  try {
    const auth = req.headers.get("Authorization") || "";
    const u = await fetch(SB_URL + "/auth/v1/user", { headers: { Authorization: auth, apikey: SB_KEY } });
    const user = u.ok ? await u.json() : null;
    if (!user || user.email !== OWNER) return out({ ok: false, code: "unauthorized", message: "請重新登入 App。" }, 401);
    TOKEN = Deno.env.get("NOTION_TOKEN") || "";
    if (!TOKEN) return out({ ok: false, code: "no_token", message: "Supabase 還沒設定 NOTION_TOKEN。" });
    SCHEMA = null;
    const { tool, input } = await req.json();
    return out({ ok: true, payload: await run(tool, input || {}) });
  } catch (x) {
    const e = x as TE;
    return out({ ok: false, code: e.code || "tool_error", message: String(e.message || x).slice(0, 300) });
  }
});
