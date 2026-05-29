import { Hono } from "hono";
import type { Env, Variables } from "./types.js";
import { verifyAuth } from "./auth.js";
import {
  listOrgs, listProjects, listRegions, listServices, summarize,
  listActivity, getService, recentChecks, upsertService, deleteService,
  runHealthChecks, logActivity, type Filter,
} from "./registry.js";

const ALL = "__all__";
const dash = new Hono<{ Bindings: Env; Variables: Variables }>();

function readFilter(c: { req: { query: (k: string) => string | undefined } }): Filter {
  return {
    org: c.req.query("org") || undefined,
    project: c.req.query("project") || undefined,
    region: c.req.query("region") || undefined,
    status: c.req.query("status") || undefined,
    q: (c.req.query("q") || "").trim() || undefined,
  };
}

// ---- read APIs (public) ------------------------------------------------

dash.get("/api/control/orgs", async (c) => {
  try { return c.json({ orgs: await listOrgs(c.env) }); }
  catch { return c.json({ error: "internal_error" }, 500); }
});

dash.get("/api/control/projects", async (c) => {
  try {
    const org = c.req.query("org") || "";
    return c.json({ projects: org ? await listProjects(c.env, org) : [] });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

dash.get("/api/control/regions", async (c) => {
  try {
    const org = c.req.query("org") || "";
    const project = c.req.query("project") || ALL;
    return c.json({ regions: org ? await listRegions(c.env, org, project) : [] });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

// One-shot payload for the dashboard: filters + all dropdown options + filtered services + summary.
dash.get("/api/control/overview", async (c) => {
  try {
    const orgs = await listOrgs(c.env);
    const f = readFilter(c);
    const org = f.org && orgs.includes(f.org) ? f.org : orgs[0];
    if (!org) return c.json({ orgs, projects: [], regions: [], services: [], summary: summarize([]), filters: { ...f } });

    const projects = await listProjects(c.env, org);
    const project = f.project && (f.project === ALL || projects.includes(f.project)) ? f.project : ALL;
    const regions = await listRegions(c.env, org, project);
    const region = f.region && (f.region === ALL || regions.includes(f.region)) ? f.region : ALL;

    const services = await listServices(c.env, { org, project, region, status: f.status, q: f.q });
    return c.json({
      orgs, projects, regions,
      filters: { org, project, region, status: f.status ?? ALL, q: f.q ?? "" },
      services,
      summary: summarize(services),
    });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

dash.get("/api/control/activity", async (c) => {
  try {
    const f = readFilter(c);
    const limit = parseInt(c.req.query("limit") || "20", 10);
    return c.json({ activity: await listActivity(c.env, f, isNaN(limit) ? 20 : limit) });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

dash.get("/api/control/services/:id", async (c) => {
  try {
    const svc = await getService(c.env, c.req.param("id"));
    if (!svc) return c.json({ error: "not_found" }, 404);
    return c.json({ service: svc, checks: await recentChecks(c.env, svc.id) });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

dash.get("/api/control/export", async (c) => {
  try {
    const f = readFilter(c);
    const services = await listServices(c.env, f);
    if ((c.req.query("format") || "json") === "csv") {
      const cols = ["org", "project", "region", "name", "kind", "status", "latency_ms", "version", "url", "last_check"];
      const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const rows = services.map(s => cols.map(k => esc((s as unknown as Record<string, unknown>)[k])).join(","));
      const csv = [cols.join(","), ...rows].join("\n");
      return new Response(csv, { headers: { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=services.csv" } });
    }
    return c.json({ services });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

dash.get("/api/control/docs", (c) => c.json({
  service: "ai-infrastructure control-plane",
  endpoints: [
    { method: "GET", path: "/api/control/overview", auth: false, query: "org, project, region, status, q", desc: "Filters + dropdown options + filtered services + health summary (one shot)." },
    { method: "GET", path: "/api/control/orgs", auth: false, desc: "Distinct organizations." },
    { method: "GET", path: "/api/control/projects?org=", auth: false, desc: "Projects within an org." },
    { method: "GET", path: "/api/control/regions?org=&project=", auth: false, desc: "Regions within an org/project." },
    { method: "GET", path: "/api/control/activity?org=&project=&limit=", auth: false, desc: "Recent activity / What Changed feed." },
    { method: "GET", path: "/api/control/services/:id", auth: false, desc: "Service detail + recent health-check history." },
    { method: "GET", path: "/api/control/export?format=csv|json", auth: false, desc: "Export the filtered service set." },
    { method: "POST", path: "/api/control/services", auth: true, body: "{org, project, region?, name, kind?, url?, version?, status?}", desc: "Register or update a service." },
    { method: "DELETE", path: "/api/control/services/:id", auth: true, desc: "Remove a service." },
    { method: "POST", path: "/api/control/health-check", auth: true, desc: "Trigger an immediate health sweep of all public endpoints." },
  ],
}));

// ---- write APIs (Bearer GATEWAY_KEY) ----------------------------------

dash.post("/api/control/services", verifyAuth, async (c) => {
  let body: { org?: string; project?: string; region?: string; name?: string; kind?: string; url?: string | null; version?: string | null; status?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!body.org || !body.project || !body.name) return c.json({ error: "org_project_name_required" }, 400);
  const allowed = new Set(["healthy", "degraded", "down", "unknown"]);
  try {
    const svc = await upsertService(c.env, {
      org: body.org, project: body.project, region: body.region, name: body.name,
      kind: body.kind, url: body.url, version: body.version,
      status: body.status && allowed.has(body.status) ? body.status as "healthy" | "degraded" | "down" | "unknown" : undefined,
    });
    return c.json({ service: svc }, 201);
  } catch { return c.json({ error: "internal_error" }, 500); }
});

dash.delete("/api/control/services/:id", verifyAuth, async (c) => {
  try { return (await deleteService(c.env, c.req.param("id") ?? "")) ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404); }
  catch { return c.json({ error: "internal_error" }, 500); }
});

dash.post("/api/control/health-check", verifyAuth, async (c) => {
  try {
    const checked = await runHealthChecks(c.env);
    await logActivity(c.env, { org: "3Sixty Co.", kind: "check", message: `Manual health sweep checked ${checked} services` });
    return c.json({ ok: true, checked });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

// ---- served dashboard --------------------------------------------------

dash.get("/", (c) => c.html(PAGE));
dash.get("/dashboard", (c) => c.html(PAGE));

export default dash;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>3Sixty Co. — Control Plane</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  :root{
    --bg:#0a0a0a; --panel:#121212; --panel2:#161616; --border:#232323; --border2:#2c2c2c;
    --text:#e8e8e8; --muted:#8a8a8a; --accent:#e94560;
    --healthy:#3fb950; --degraded:#d29922; --down:#e94560; --unknown:#6e7681;
    --r:14px;
  }
  *{box-sizing:border-box}
  html,body{margin:0;background:var(--bg);color:var(--text);font-family:'DM Sans',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
  body{padding:18px;max-width:1180px;margin:0 auto}
  a{color:var(--accent);text-decoration:none}
  .mono{font-family:'JetBrains Mono',monospace}
  h1,h2,h3{font-family:'Syne',sans-serif;margin:0}
  .panel{background:var(--panel);border:1px solid var(--border);border-radius:var(--r)}
  .header{padding:20px 22px;position:relative;overflow:hidden}
  .pill{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.12em;color:var(--healthy);background:rgba(63,185,80,.12);border:1px solid rgba(63,185,80,.3);padding:4px 10px;border-radius:999px}
  .header h1{font-size:26px;margin-top:12px;letter-spacing:-.01em}
  .header p{color:var(--muted);margin:6px 0 0;font-size:14px}
  .region-card{position:absolute;top:18px;right:18px;background:var(--panel2);border:1px solid var(--border);border-radius:10px;padding:8px 14px;text-align:right}
  .region-card .lbl{font-size:10px;letter-spacing:.14em;color:var(--muted)}
  .region-card .val{font-size:13px;font-weight:600;margin-top:2px}
  .bar{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-top:18px}
  .field{display:flex;flex-direction:column;gap:5px}
  .field label{font-size:10px;letter-spacing:.14em;color:var(--muted);font-weight:600}
  select,.btn,input[type=text]{background:var(--panel2);color:var(--text);border:1px solid var(--border2);border-radius:9px;padding:9px 12px;font:inherit;font-size:13px;cursor:pointer}
  select{min-width:150px}
  .field.org select{border-color:var(--accent)}
  input[type=text]{cursor:text;min-width:170px}
  .btn:hover,select:hover{border-color:#3a3a3a}
  .btn.ghost{background:transparent}
  .toolbar{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin:14px 0}
  .seg{display:inline-flex;background:var(--panel);border:1px solid var(--border);border-radius:999px;padding:4px;gap:2px}
  .seg button{background:transparent;border:none;color:var(--muted);padding:7px 16px;border-radius:999px;font:inherit;font-size:13px;cursor:pointer}
  .seg button.active{background:rgba(233,69,96,.14);color:var(--accent);border:1px solid rgba(233,69,96,.4)}
  .actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:14px 0}
  .stat{padding:14px 16px}
  .stat .n{font-family:'Syne';font-size:24px;font-weight:800}
  .stat .k{font-size:11px;letter-spacing:.1em;color:var(--muted);text-transform:uppercase;margin-top:2px}
  .stat.score .n{color:var(--accent)}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:middle}
  .dot.healthy{background:var(--healthy)} .dot.degraded{background:var(--degraded)} .dot.down{background:var(--down)} .dot.unknown{background:var(--unknown)}
  .grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}
  .grid.compact{grid-template-columns:repeat(auto-fill,minmax(210px,1fr))}
  .card{padding:16px;cursor:pointer;transition:border-color .15s}
  .card:hover{border-color:var(--border2)}
  .card .top{display:flex;justify-content:space-between;align-items:center;gap:8px}
  .card .name{font-weight:600;font-size:15px}
  .card .meta{color:var(--muted);font-size:12px;margin-top:8px;display:flex;gap:10px;flex-wrap:wrap}
  .badge{font-size:11px;padding:3px 9px;border-radius:999px;font-weight:600;text-transform:capitalize}
  .badge.healthy{color:var(--healthy);background:rgba(63,185,80,.12)} .badge.degraded{color:var(--degraded);background:rgba(210,153,34,.12)} .badge.down{color:var(--down);background:rgba(233,69,96,.12)} .badge.unknown{color:var(--unknown);background:rgba(110,118,129,.14)}
  .compact .card{padding:12px} .compact .card .meta{display:none}
  table.ops{width:100%;border-collapse:collapse;font-family:'JetBrains Mono',monospace;font-size:12.5px}
  table.ops th,table.ops td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--border)}
  table.ops th{color:var(--muted);font-weight:500;letter-spacing:.06em;text-transform:uppercase;font-size:10.5px}
  table.ops tr{cursor:pointer} table.ops tbody tr:hover{background:var(--panel2)}
  .empty{text-align:center;color:var(--muted);padding:80px 20px;font-size:15px}
  .empty .hint{font-size:13px;margin-top:8px;color:#6a6a6a}
  .drawer{position:fixed;top:0;right:0;height:100%;width:min(440px,92vw);background:var(--panel);border-left:1px solid var(--border);transform:translateX(100%);transition:transform .22s ease;z-index:40;overflow-y:auto;padding:22px}
  .drawer.open{transform:translateX(0)}
  .drawer h2{font-size:18px} .drawer .close{position:absolute;top:16px;right:18px;background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer}
  .scrim{position:fixed;inset:0;background:rgba(0,0,0,.55);opacity:0;pointer-events:none;transition:opacity .2s;z-index:30}
  .scrim.open{opacity:1;pointer-events:auto}
  .act{padding:11px 0;border-bottom:1px solid var(--border);font-size:13px}
  .act .when{color:var(--muted);font-size:11px;margin-top:3px}
  .spark{display:flex;align-items:flex-end;gap:2px;height:42px;margin:12px 0}
  .spark span{flex:1;background:var(--accent);min-height:2px;border-radius:2px 2px 0 0;opacity:.8}
  .kv{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px}
  .kv .k{color:var(--muted)}
  .fresh{font-size:12px;color:var(--muted)}
  .row{display:flex;align-items:center;gap:8px}
  @media (max-width:640px){ .region-card{position:static;margin-top:14px;display:inline-block;text-align:left} .header h1{font-size:21px} }
  @media (prefers-reduced-motion: reduce){ .drawer,.scrim{transition:none} }
</style>
</head>
<body>
  <div class="panel header">
    <span class="pill">OVERVIEW</span>
    <div class="region-card"><div class="lbl">REGION</div><div class="val" id="regionVal">All Regions</div></div>
    <h1 id="title">3Sixty Co.</h1>
    <p>Global service health, recent activity, and control-plane freshness.</p>
    <div class="bar">
      <div class="field org"><label>ORG</label><select id="orgSel"></select></div>
      <div class="field"><label>PROJECT</label><select id="projSel"></select></div>
      <div class="field"><label>REGION</label><select id="regionSel"></select></div>
      <div class="field"><label>STATUS</label><select id="statusSel">
        <option value="__all__">All Statuses</option><option value="healthy">Healthy</option>
        <option value="degraded">Degraded</option><option value="down">Down</option><option value="unknown">Unknown</option>
      </select></div>
      <div class="field"><label>SEARCH</label><input type="text" id="search" placeholder="filter services…" /></div>
      <div class="field"><label>&nbsp;</label><button class="btn" id="reset">Reset</button></div>
    </div>
  </div>

  <div class="toolbar">
    <div class="seg" id="viewSeg">
      <button data-v="comfortable" class="active">Comfortable</button>
      <button data-v="compact">Compact</button>
      <button data-v="ops">Ops Mode</button>
    </div>
    <div class="actions">
      <span class="fresh" id="fresh"></span>
      <label class="row fresh"><input type="checkbox" id="auto" checked /> auto</label>
      <button class="btn ghost" id="refresh">Refresh</button>
      <button class="btn ghost" id="exportBtn">Export</button>
      <button class="btn ghost" id="docsBtn">API Docs</button>
      <button class="btn ghost" id="changedBtn">What Changed</button>
    </div>
  </div>

  <div class="summary" id="summary"></div>
  <div id="body"></div>

  <div class="scrim" id="scrim"></div>
  <aside class="drawer" id="drawer"><button class="close" id="drawerClose">&times;</button><div id="drawerBody"></div></aside>

<script>
(function(){
  var ALL="__all__";
  var st={org:"",project:ALL,region:ALL,status:ALL,q:"",view:"comfortable",services:[],summary:{},lastLoad:0};
  var $=function(id){return document.getElementById(id)};
  var api=function(p){return fetch(p).then(function(r){return r.json()})};

  function qsInit(){
    var p=new URLSearchParams(location.search);
    if(p.get("org"))st.org=p.get("org");
    if(p.get("project"))st.project=p.get("project");
    if(p.get("region"))st.region=p.get("region");
    if(p.get("status"))st.status=p.get("status");
    if(p.get("view"))st.view=p.get("view");
  }
  function qsPush(){
    var p=new URLSearchParams();
    if(st.org)p.set("org",st.org);
    if(st.project&&st.project!==ALL)p.set("project",st.project);
    if(st.region&&st.region!==ALL)p.set("region",st.region);
    if(st.status&&st.status!==ALL)p.set("status",st.status);
    if(st.view!=="comfortable")p.set("view",st.view);
    history.replaceState(null,"","?"+p.toString());
  }
  function opt(val,label,sel){var o=document.createElement("option");o.value=val;o.textContent=label;if(val===sel)o.selected=true;return o}
  function txt(el,t){el.textContent=t==null?"":String(t)}
  function ago(ms){if(!ms)return "never";var s=Math.floor((Date.now()-ms)/1000);if(s<60)return s+"s ago";if(s<3600)return Math.floor(s/60)+"m ago";if(s<86400)return Math.floor(s/3600)+"h ago";return Math.floor(s/86400)+"d ago"}

  function fillSelects(d){
    var os=$("orgSel");os.innerHTML="";d.orgs.forEach(function(o){os.appendChild(opt(o,o,d.filters.org))});
    var ps=$("projSel");ps.innerHTML="";ps.appendChild(opt(ALL,"All Projects",d.filters.project));
    d.projects.forEach(function(p){ps.appendChild(opt(p,p,d.filters.project))});
    var rs=$("regionSel");rs.innerHTML="";rs.appendChild(opt(ALL,"All Regions",d.filters.region));
    d.regions.forEach(function(r){rs.appendChild(opt(r,r,d.filters.region))});
    $("statusSel").value=d.filters.status||ALL;
    $("search").value=st.q;
  }

  function renderSummary(s){
    var box=$("summary");box.innerHTML="";
    var grade=s.score>=90?"A":s.score>=75?"B":s.score>=55?"C":s.score>=35?"D":"F";
    var cells=[
      {n:s.score+" "+grade,k:"Health Score",cls:"score"},
      {n:s.total,k:"Services"},
      {n:s.healthy,k:"Healthy",dot:"healthy"},
      {n:s.degraded,k:"Degraded",dot:"degraded"},
      {n:s.down,k:"Down",dot:"down"},
      {n:ago(s.freshest),k:"Last Check"}
    ];
    cells.forEach(function(c){
      var el=document.createElement("div");el.className="panel stat"+(c.cls?" "+c.cls:"");
      var n=document.createElement("div");n.className="n";
      if(c.dot){var d=document.createElement("span");d.className="dot "+c.dot;n.appendChild(d)}
      n.appendChild(document.createTextNode(c.n));
      var k=document.createElement("div");k.className="k";txt(k,c.k);
      el.appendChild(n);el.appendChild(k);box.appendChild(el);
    });
  }

  function renderBody(){
    var b=$("body");b.innerHTML="";
    if(!st.services.length){
      var e=document.createElement("div");e.className="panel empty";
      e.appendChild(document.createTextNode("No services registered for the selected filter."));
      var h=document.createElement("div");h.className="hint";txt(h,"Try resetting filters, or POST /api/control/services to register one.");
      e.appendChild(h);b.appendChild(e);return;
    }
    if(st.view==="ops"){renderOps(b);return}
    var g=document.createElement("div");g.className="grid"+(st.view==="compact"?" compact":"");
    st.services.forEach(function(s){
      var c=document.createElement("div");c.className="panel card";c.onclick=function(){openService(s.id)};
      var top=document.createElement("div");top.className="top";
      var nm=document.createElement("div");nm.className="name";txt(nm,s.name);
      var bd=document.createElement("span");bd.className="badge "+s.status;txt(bd,s.status);
      top.appendChild(nm);top.appendChild(bd);
      var meta=document.createElement("div");meta.className="meta";
      meta.appendChild(span(s.project+" · "+s.kind));
      meta.appendChild(span(s.region));
      if(s.latency_ms!=null)meta.appendChild(span(s.latency_ms+"ms"));
      if(s.version)meta.appendChild(span(s.version));
      c.appendChild(top);c.appendChild(meta);g.appendChild(c);
    });
    b.appendChild(g);
  }
  function span(t){var s=document.createElement("span");txt(s,t);return s}

  function renderOps(b){
    var wrap=document.createElement("div");wrap.className="panel";wrap.style.overflowX="auto";
    var t=document.createElement("table");t.className="ops";
    var head=["Service","Project","Region","Status","Latency","Version","Checked"];
    var thead=document.createElement("thead");var tr=document.createElement("tr");
    head.forEach(function(h){var th=document.createElement("th");txt(th,h);tr.appendChild(th)});
    thead.appendChild(tr);t.appendChild(thead);
    var tb=document.createElement("tbody");
    st.services.forEach(function(s){
      var r=document.createElement("tr");r.onclick=function(){openService(s.id)};
      var cells=[s.name,s.project,s.region,null,s.latency_ms!=null?s.latency_ms+"ms":"—",s.version||"—",ago(s.last_check)];
      cells.forEach(function(v,i){
        var td=document.createElement("td");
        if(i===3){var d=document.createElement("span");d.className="dot "+s.status;td.appendChild(d);td.appendChild(document.createTextNode(s.status))}
        else txt(td,v);
        r.appendChild(td);
      });
      tb.appendChild(r);
    });
    t.appendChild(tb);wrap.appendChild(t);b.appendChild(wrap);
  }

  function load(){
    var p=new URLSearchParams();
    if(st.org)p.set("org",st.org);
    p.set("project",st.project);p.set("region",st.region);p.set("status",st.status);
    if(st.q)p.set("q",st.q);
    return api("/api/control/overview?"+p.toString()).then(function(d){
      if(d.error)return;
      st.org=d.filters.org;st.project=d.filters.project;st.region=d.filters.region;st.status=d.filters.status;
      st.services=d.services;st.summary=d.summary;st.lastLoad=Date.now();
      fillSelects(d);
      txt($("title"),d.filters.org+(d.filters.project!==ALL?" / "+d.filters.project:""));
      txt($("regionVal"),d.filters.region===ALL?"All Regions":d.filters.region);
      renderSummary(d.summary);renderBody();updateFresh();qsPush();
    });
  }
  function updateFresh(){txt($("fresh"),"updated "+ago(st.lastLoad))}

  // drawers
  function openDrawer(){$("drawer").classList.add("open");$("scrim").classList.add("open")}
  function closeDrawer(){$("drawer").classList.remove("open");$("scrim").classList.remove("open")}
  function openService(id){
    openDrawer();var db=$("drawerBody");db.innerHTML="";var h=document.createElement("h2");txt(h,"Loading…");db.appendChild(h);
    api("/api/control/services/"+id).then(function(d){
      if(d.error){txt(h,"Not found");return}
      db.innerHTML="";var s=d.service;
      var t=document.createElement("h2");txt(t,s.name);db.appendChild(t);
      var bd=document.createElement("span");bd.className="badge "+s.status;txt(bd,s.status);bd.style.marginTop="8px";bd.style.display="inline-block";db.appendChild(bd);
      var checks=(d.checks||[]).slice().reverse();
      if(checks.length){
        var sp=document.createElement("div");sp.className="spark";
        var max=Math.max.apply(null,checks.map(function(c){return c.latency_ms||0}).concat([1]));
        checks.forEach(function(c){var bar=document.createElement("span");bar.style.height=Math.max(2,Math.round((c.latency_ms||0)/max*42))+"px";if(c.status!=="healthy")bar.style.background="var(--"+c.status+")";sp.appendChild(bar)});
        db.appendChild(sp);
      }
      [["Project",s.project],["Region",s.region],["Kind",s.kind],["Version",s.version||"—"],["Latency",s.latency_ms!=null?s.latency_ms+"ms":"—"],["Last check",ago(s.last_check)],["URL",s.url||"— (local / no endpoint)"]].forEach(function(kv){
        var row=document.createElement("div");row.className="kv";var k=document.createElement("span");k.className="k";txt(k,kv[0]);var v=document.createElement("span");v.className="mono";txt(v,kv[1]);row.appendChild(k);row.appendChild(v);db.appendChild(row);
      });
    });
  }
  function openChanged(){
    openDrawer();var db=$("drawerBody");db.innerHTML="";var h=document.createElement("h2");txt(h,"What Changed");db.appendChild(h);
    var p=new URLSearchParams();if(st.org)p.set("org",st.org);if(st.project!==ALL)p.set("project",st.project);p.set("limit","30");
    api("/api/control/activity?"+p.toString()).then(function(d){
      (d.activity||[]).forEach(function(a){
        var el=document.createElement("div");el.className="act";
        var m=document.createElement("div");txt(m,"["+a.kind+"] "+a.message);
        var w=document.createElement("div");w.className="when";txt(w,(a.project?a.project+" · ":"")+ago(a.created_at));
        el.appendChild(m);el.appendChild(w);db.appendChild(el);
      });
      if(!(d.activity||[]).length){var e=document.createElement("p");e.style.color="var(--muted)";txt(e,"No recent activity.");db.appendChild(e)}
    });
  }
  function openDocs(){
    openDrawer();var db=$("drawerBody");db.innerHTML="";var h=document.createElement("h2");txt(h,"Control-Plane API");db.appendChild(h);
    api("/api/control/docs").then(function(d){
      d.endpoints.forEach(function(e){
        var el=document.createElement("div");el.className="act";
        var m=document.createElement("div");m.className="mono";txt(m,e.method+" "+e.path+(e.auth?"  🔒":""));
        var w=document.createElement("div");w.className="when";txt(w,e.desc);
        el.appendChild(m);el.appendChild(w);db.appendChild(el);
      });
    });
  }

  // events
  $("orgSel").onchange=function(){st.org=this.value;st.project=ALL;st.region=ALL;load()};
  $("projSel").onchange=function(){st.project=this.value;st.region=ALL;load()};
  $("regionSel").onchange=function(){st.region=this.value;load()};
  $("statusSel").onchange=function(){st.status=this.value;load()};
  var sTimer;$("search").oninput=function(){var v=this.value;clearTimeout(sTimer);sTimer=setTimeout(function(){st.q=v.trim();load()},250)};
  $("reset").onclick=function(){st.project=ALL;st.region=ALL;st.status=ALL;st.q="";load()};
  Array.prototype.forEach.call($("viewSeg").children,function(btn){btn.onclick=function(){
    Array.prototype.forEach.call($("viewSeg").children,function(b){b.classList.remove("active")});
    btn.classList.add("active");st.view=btn.getAttribute("data-v");renderBody();qsPush();
  }});
  $("refresh").onclick=function(){load()};
  $("exportBtn").onclick=function(){
    var p=new URLSearchParams();if(st.org)p.set("org",st.org);if(st.project!==ALL)p.set("project",st.project);if(st.region!==ALL)p.set("region",st.region);if(st.status!==ALL)p.set("status",st.status);if(st.q)p.set("q",st.q);p.set("format","csv");
    location.href="/api/control/export?"+p.toString();
  };
  $("docsBtn").onclick=openDocs;
  $("changedBtn").onclick=openChanged;
  $("drawerClose").onclick=closeDrawer;$("scrim").onclick=closeDrawer;
  document.addEventListener("keydown",function(e){if(e.key==="Escape")closeDrawer();if(e.key==="/"&&document.activeElement!==$("search")){e.preventDefault();$("search").focus()}});

  // view seg initial active
  Array.prototype.forEach.call($("viewSeg").children,function(b){b.classList.toggle("active",b.getAttribute("data-v")===st.view)});

  // auto-refresh
  setInterval(function(){updateFresh();if($("auto").checked)load()},30000);

  qsInit();load();
})();
</script>
</body>
</html>`;
