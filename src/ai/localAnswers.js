// Réponses locales de l'assistant — AUCUN modèle, aucune requête réseau.
//
// Tout ce qui est factuel (station, vélos, bornes, départs, météo) est résolu ici,
// sur les données déjà présentes dans l'application. Un modèle de langue ne peut pas
// se tromper sur un compteur de vélos s'il ne le lit jamais : c'est le principe.
//
// Module volontairement pur (la traduction `t` est injectée) pour être testable.

import { TRANSIT_STOPS } from "../constants.js";
import { fmtDist, stationView } from "../ui/format.js";
import { wmo, reasonLabel } from "../ui/weather.js";

export const approxDist = (a, b) =>
  Math.sqrt((a.lat - b.lat) ** 2 + (a.lng - b.lng) ** 2) * 111000;

// Normalisation pour comparer une question à des mots-clés, sans dépendre des accents.
export const norm = s =>
  (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// Un départ par arrêt proche : de la variété plutôt que six fois le même arrêt.
export function upcoming(stops, deps, max = 3) {
  const out = [];
  for (const s of stops || []) {
    for (const d of deps?.[s.id] || []) {
      if (d.cancelled) continue;
      out.push({ stop: s.name, dist: s.dist, line: d.line, dir: d.direction,
                 time: d.rtTime || d.time, late: !!d.rtTime && d.rtTime !== d.time });
      break;
    }
  }
  return out.slice(0, max);
}

/**
 * Formule le verdict. Sans raison fournie par le moteur d'avis, on utilise une
 * variante sans parenthèses : « conditions acceptables » plutôt que « ( ) ».
 */
function verdict(t, advice, ok, tail) {
  const reason = advice.reason ? reasonLabel(advice.reason) : "";
  const phrase = reason
    ? (ok ? t("ui.ai.ans.verdict_ok", { reason }) : t("ui.ai.ans.verdict_no", { reason }))
    : (ok ? t("ui.ai.ans.verdict_ok_simple") : t("ui.ai.ans.verdict_no_simple"));
  return phrase + " " + tail;
}

/**
 * Répond à une question à partir des données de l'appareil.
 * @returns {{text: string, nav?: {lat:number,lng:number,name:string,mode:string}}}
 */
export function answerLocally(question, ctx) {
  const { stations = [], nearest = null, deps = [], weather = null, forecast = null,
          advice = { mode: "bike", reason: null }, score = null, gpsPos = null, t } = ctx;
  const q = norm(question);

  // 1. Demande de guidage : le lieu est cherché dans les données, pas par un modèle
  if (/(emmene|amene|conduis|guide|navigue|itineraire|route vers|aller a|va a|direction|mener)/.test(q)) {
    const cible = q.replace(/\b(emmene|amene|conduis|guide|nous|vers|moi|station|arret|jusqu|au|aux|la|le|les|de|du|a)\b/g, " ");
    const words = cible.split(/[^a-z0-9]+/).filter(w => w.length > 3);
    const cands = [
      ...stations.map(s => ({ name: s.name, lat: s.lat, lng: s.lng, dist: s.dist })),
      ...TRANSIT_STOPS.map(s => ({ name: s.name, lat: s.lat, lng: s.lng,
                                   dist: gpsPos ? approxDist(s, gpsPos) : null })),
    ].filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lng) && c.name);
    let best = null, bestScore = 0;
    for (const c of cands) {
      const cn = norm(c.name);
      let sc = 0;
      for (const w of words) if (cn.includes(w)) sc += w.length;
      if (words.length && sc > bestScore) { best = c; bestScore = sc; }
    }
    if (best) {
      return { text: t("ui.ai.ans.nav_found", { name: best.name,
                        dist: best.dist != null ? fmtDist(best.dist) : "—" }),
               nav: { lat: best.lat, lng: best.lng, name: best.name, mode: "bicycling" } };
    }
    return { text: t("ui.ai.ans.nav_unknown", { q: question.trim() }) };
  }

  // 2. Peut-on prendre un vélo maintenant ?
  if (/(velo|bike|rouler|cycl|pedaler)/.test(q) && /(maintenant|puis-je|peux|possible|moment|aujourd|ce soir|partir)/.test(q)
      && !/\b(rendre|deposer|garer|remettre|borne|dock)\b/.test(q)) {
    const ok = advice.mode !== "transit";
    const tail = nearest
      ? t("ui.ai.ans.nearest", { name: nearest.name, dist: fmtDist(nearest.dist), bikes: nearest.bikes,
                                 elec: stationView(nearest).elec, docks: nearest.docks })
      : t("ui.ai.ans.no_station");
    return { text: verdict(t, advice, ok, tail) };
  }

  // 3. Prochains départs
  if (/(bus|tram|depart|prochain|horaire|quand passe)/.test(q)) {
    if (!deps.length) return { text: t("ui.ai.ans.bus_none") };
    return { text: deps.slice(0, 2).map(d => t("ui.ai.ans.bus", { line: d.line, dir: d.dir, time: d.time, stop: d.stop })).join(" ") };
  }

  // 4. Station la plus proche
  if (/(station|proche|plus pres|pres de moi|ou est|ou trouver)/.test(q)) {
    return { text: nearest
      ? t("ui.ai.ans.nearest", { name: nearest.name, dist: fmtDist(nearest.dist), bikes: nearest.bikes,
                                 elec: stationView(nearest).elec, docks: nearest.docks })
      : t("ui.ai.ans.no_station") };
  }

  // 5. Vélos électriques
  if (/(electri|elec\b|ebike)/.test(q)) {
    return { text: nearest ? t("ui.ai.ans.elec", { n: stationView(nearest).elec, name: nearest.name })
                           : t("ui.ai.ans.no_station") };
  }

  // 6. Météo
  if (/(meteo|pluie|vent|temps|temperature|pleut|chaud|froid)/.test(q)) {
    const fc = forecast?.length
      ? forecast.map(f => t("ui.ai.ans.fc", { h: f.h, temp: f.temp, rain: f.rain })).join(" ")
      : "";
    return { text: weather
      ? t("ui.ai.ans.wx", { label: wmo(weather.code).label, temp: weather.temp, wind: weather.wind, score, fc })
      : t("ui.ai.ans.no_wx") };
  }

  // 7. Où rendre le vélo
  if (/\b(borne|bornes|dock|docks|rendre|garer|deposer|remettre|plein)\b/.test(q)) {
    return { text: nearest ? t("ui.ai.ans.docks", { name: nearest.name, docks: nearest.docks })
                           : t("ui.ai.ans.no_station") };
  }

  // 8. Où aller maintenant / conseil
  if (/(ou aller|ou partir|conseil|que faire|recommande|meilleur)/.test(q)) {
    const ok = advice.mode !== "transit";
    const cible = nearest
      ? t("ui.ai.ans.where_station", { name: nearest.name, dist: fmtDist(nearest.dist), bikes: nearest.bikes })
      : t("ui.ai.ans.no_station");
    return { text: verdict(t, advice, ok, cible) };
  }

  // 9. Rien reconnu : on dit ce qui est disponible sans modèle
  return { text: t("ui.ai.ans.help") };
}

/** Motifs de questions rapides proposés sous la conversation. */
export const QUICK_INTENTS = [
  "ui.ai.q.can_bike", "ui.ai.q.nearest", "ui.ai.q.tram", "ui.ai.q.weather",
  "ui.ai.q.bus", "ui.ai.q.elec", "ui.ai.q.dock",
];
