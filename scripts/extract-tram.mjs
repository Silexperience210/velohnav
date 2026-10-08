#!/usr/bin/env node
// ── Extraction minimale du tram T1 depuis le GTFS officiel ─────────────
// Source : « Horaires et arrêts des transports publics (GTFS) »,
// Administration des transports publics, data.public.lu — licence CC BY 4.0.
// Le flux complet pèse ~17 Mo zippé (~75 Mo décompressé) ; on n'embarque que
// la ligne T1 (route_type 0) :
//   - tracé : shape du parcours complet Findel → Stadion, simplifié
//     (Douglas-Peucker, tolérance 2 m), encodé en polyline précision 5 ;
//   - arrêts : nom, position, distance le long du tracé (m) ;
//   - profils de marche : chaque séquence d'arrêts + temps de parcours,
//     une course = [profil, heure de départ en s] (le T1 n'a que quelques profils) ;
//   - calendrier : types de jour (ensemble identique de courses), et pour
//     chaque date de validité l'indice de son type (« - » = aucun service).
//
// Usage : node scripts/extract-tram.mjs <dossier GTFS décompressé> <nom du zip>
//   (ou bash scripts/fetch-tram.sh, qui télécharge et décompresse)
// Sortie : src/data/tramT1.json — déterministe (même GTFS → même fichier).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const [dir, feedName = "gtfs"] = process.argv.slice(2);
if (!dir) {
  console.error("Usage : node scripts/extract-tram.mjs <dossier GTFS> [nom du zip]");
  process.exit(1);
}
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "tramT1.json");

// ── CSV (guillemets RFC 4180, pas de saut de ligne dans les champs GTFS ATP) ──
function parseLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
function* rows(file, keep = () => true) {
  const text = readFileSync(join(dir, file), "utf8").replace(/^﻿/, "");
  let start = text.indexOf("\n");
  const head = parseLine(text.slice(0, start).replace(/\r$/, ""));
  start++;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).replace(/\r$/, "");
    start = end + 1;
    if (!line || !keep(line)) continue;
    const v = parseLine(line);
    const o = {};
    head.forEach((h, i) => { o[h] = v[i]; });
    yield o;
  }
}
const sec = s => { const [h, m, x] = s.split(":").map(Number); return h * 3600 + m * 60 + (x || 0); };

// ── Ligne, courses, horaires ───────────────────────────────────────────
const routeIds = new Set([...rows("routes.txt")]
  .filter(r => r.route_short_name === "T1" && r.route_type === "0").map(r => r.route_id));
if (!routeIds.size) throw new Error("Ligne T1 (route_type 0) introuvable");

const trips = new Map();
for (const r of rows("trips.txt")) if (routeIds.has(r.route_id)) trips.set(r.trip_id, r);

const times = new Map();
for (const r of rows("stop_times.txt", l => trips.has(l.slice(0, l.indexOf(","))))) {
  if (!times.has(r.trip_id)) times.set(r.trip_id, []);
  times.get(r.trip_id).push(r);
}

const stopsById = new Map();
for (const r of rows("stops.txt")) stopsById.set(r.stop_id, r);

// Profils : séquence d'arrêts + décalages (arrivée, départ) depuis le 1er départ
const profiles = [], profileKey = new Map(), tripList = [];
for (const [tid, list] of times) {
  list.sort((a, b) => a.stop_sequence - b.stop_sequence);
  const t0 = sec(list[0].departure_time);
  const key = list.map(r => `${r.stop_id}@${sec(r.arrival_time) - t0}/${sec(r.departure_time) - t0}`).join("|");
  if (!profileKey.has(key)) {
    profileKey.set(key, profiles.length);
    profiles.push({
      dir: Number(trips.get(tid).direction_id),
      headsign: trips.get(tid).trip_headsign,
      stopIds: list.map(r => r.stop_id),
      arr: list.map(r => sec(r.arrival_time) - t0),
      dep: list.map(r => sec(r.departure_time) - t0),
      shapeId: trips.get(tid).shape_id,
    });
  }
  tripList.push({ tid, p: profileKey.get(key), start: t0, service: trips.get(tid).service_id });
}

// Arrêts de référence : le plus long parcours de la direction 0, dans son ordre
const master = profiles.filter(p => p.dir === 0).sort((a, b) => b.stopIds.length - a.stopIds.length)[0];
const stopIndex = new Map(master.stopIds.map((id, i) => [id, i]));
for (const p of profiles) for (const id of p.stopIds) {
  if (!stopIndex.has(id)) throw new Error(`Arrêt ${id} hors du parcours de référence`);
}

// ── Tracé : shape du parcours de référence, simplifié ───────────────────
const shapePts = [...rows("shapes.txt", l => l.startsWith(`${master.shapeId},`) || l.startsWith(`"${master.shapeId}",`))]
  .sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence)
  .map(r => [Number(r.shape_pt_lat), Number(r.shape_pt_lon)]);
if (shapePts.length < 2) throw new Error(`Shape ${master.shapeId} vide`);

const LAT0 = shapePts[0][0] * Math.PI / 180;
const xy = ([lat, lng]) => [lng * 111320 * Math.cos(LAT0), lat * 110574];
function simplify(pts, tol) {
  const P = pts.map(xy), keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = P[a], [bx, by] = P[b];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let worst = -1, wd = 0;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = P[i];
      const u = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
      const d = Math.hypot(px - ax - u * dx, py - ay - u * dy);
      if (d > wd) { wd = d; worst = i; }
    }
    if (wd > tol) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const line = simplify(shapePts, 2).map(([la, ln]) => [Math.round(la * 1e5) / 1e5, Math.round(ln * 1e5) / 1e5]);

function encodePolyline(pts) {
  let out = "", pla = 0, pln = 0;
  const enc = v => { v = v < 0 ? ~(v << 1) : v << 1; let s = ""; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [la, ln] of pts) {
    const a = Math.round(la * 1e5), b = Math.round(ln * 1e5);
    out += enc(a - pla) + enc(b - pln); pla = a; pln = b;
  }
  return out;
}

// Distance de chaque arrêt le long du tracé : projection, en avançant
// (le tracé repasse près de lui-même entre Findel et Héienhaff)
const LP = line.map(xy), cum = [0];
for (let i = 1; i < LP.length; i++) cum.push(cum[i - 1] + Math.hypot(LP[i][0] - LP[i - 1][0], LP[i][1] - LP[i - 1][1]));
let fromSeg = 0;
const stops = master.stopIds.map(id => {
  const s = stopsById.get(id);
  const [px, py] = xy([Number(s.stop_lat), Number(s.stop_lon)]);
  let best = null;
  for (let i = fromSeg; i < LP.length - 1; i++) {
    const [ax, ay] = LP[i], [bx, by] = LP[i + 1];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const u = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
    const d = Math.hypot(px - ax - u * dx, py - ay - u * dy);
    if (!best || d < best.d - 0.01) best = { d, i, along: cum[i] + u * Math.sqrt(L2) };
    if (best && d > best.d + 400 && i > best.i + 5) break; // on s'éloigne : arrêt trouvé
  }
  if (best.d > 60) throw new Error(`Arrêt ${s.stop_name} à ${Math.round(best.d)} m du tracé`);
  fromSeg = best.i;
  return { id, name: s.stop_name, lat: Number(s.stop_lat), lng: Number(s.stop_lon), d: Math.round(best.along) };
});

// ── Calendrier → types de jour ─────────────────────────────────────────
const cal = new Map([...rows("calendar.txt")].map(r => [r.service_id, r]));
const exc = new Map();
for (const r of rows("calendar_dates.txt")) {
  if (!exc.has(r.date)) exc.set(r.date, []);
  exc.get(r.date).push(r);
}
const usedServices = new Set(tripList.map(t => t.service));
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, "");
const parseYmd = s => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
const WD = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const allDates = [...[...cal.values()].flatMap(c => [c.start_date, c.end_date]), ...exc.keys()].sort();
const first = parseYmd(allDates[0]), last = parseYmd(allDates[allDates.length - 1]);

const dayTypes = [], dayTypeKey = new Map();
let days = "";
for (let d = new Date(first); d <= last; d.setUTCDate(d.getUTCDate() + 1)) {
  const date = ymd(d), active = new Set();
  for (const sid of usedServices) {
    const c = cal.get(sid);
    if (c && c.start_date <= date && date <= c.end_date && c[WD[d.getUTCDay()]] === "1") active.add(sid);
  }
  for (const e of exc.get(date) || []) {
    if (!usedServices.has(e.service_id)) continue;
    if (e.exception_type === "1") active.add(e.service_id); else active.delete(e.service_id);
  }
  const list = tripList.filter(t => active.has(t.service))
    .map(t => [t.p, t.start]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (!list.length) { days += "-"; continue; }
  const key = JSON.stringify(list);
  if (!dayTypeKey.has(key)) {
    dayTypeKey.set(key, dayTypes.length);
    // Par profil : heures de départ en delta (compact, lisible)
    const byP = {};
    for (const [p, s] of list) (byP[p] ||= []).push(s);
    for (const p in byP) byP[p] = byP[p].map((s, i, a) => i ? s - a[i - 1] : s);
    dayTypes.push(byP);
  }
  const idx = dayTypeKey.get(key);
  if (idx > 35) throw new Error("Plus de 36 types de jour : encodage à revoir");
  days += idx.toString(36);
}

const out = {
  source: {
    feed: feedName,
    publisher: "Administration des transports publics (ATP) — data.public.lu",
    license: "CC BY 4.0",
    url: "https://data.public.lu/fr/datasets/horaires-et-arrets-des-transport-publics-gtfs/",
  },
  line: "T1",
  geometry: encodePolyline(line),
  stops,
  profiles: profiles.map(p => ({
    dir: p.dir, headsign: p.headsign,
    stops: p.stopIds.map(id => stopIndex.get(id)),
    arr: p.arr, dep: p.dep,
  })),
  firstDate: ymd(first),
  days,
  dayTypes,
};
mkdirSync(dirname(OUT), { recursive: true });
const json = JSON.stringify(out);
writeFileSync(OUT, json + "\n");
console.log(`✓ ${OUT}`);
console.log(`  ${(json.length / 1024).toFixed(1)} Kio — ${line.length}/${shapePts.length} points de tracé, ` +
  `${stops.length} arrêts, ${profiles.length} profils, ${tripList.length} courses, ` +
  `${dayTypes.length} types de jour, ${days.length} jours (${out.firstDate} →)`);
