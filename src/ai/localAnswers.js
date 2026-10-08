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

/** Détail d'une station, avec compteurs accordés. */
function details(t, tn, st) {
  return t("ui.ai.ans.nearest", {
    name: st.name,
    dist: fmtDist(st.dist),
    bikes: tn("ui.ai.unit.bike", st.bikes),
    elec: tn("ui.ai.unit.elec", stationView(st).elec),
    docks: tn("ui.ai.unit.dock", st.docks),
  });
}

/**
 * Répond à une question à partir des données de l'appareil.
 * @returns {{text: string, nav?: {lat:number,lng:number,name:string,mode:string}}}
 */
export function answerLocally(question, ctx) {
  const { stations = [], nearest = null, nearestReturn = null, deps = [], weather = null, forecast = null,
          advice = { mode: "bike", reason: null }, score = null, gpsPos = null, t } = ctx;
  // Mise au pluriel : injectée par l'application (consciente de la langue), avec un
  // repli neutre pour les appels sans contexte.
  const tn = ctx.tn || ((key, n) => `${n} ${t(key + (n === 1 ? ".one" : ".many"))}`);
  const q = norm(question);

  // 1. Demande de guidage : le lieu est cherché dans les données, pas par un modèle
  if (/\b(emmene|amene|conduis|guide|navigue|itineraire|route vers|aller a|va a|vais|vas|allons|direction|mener)\b/.test(q)
      || /\b(take me|go to|directions|navigate to|route to|bring me)\b/.test(q)) {
    const cible = q.replace(/\b(emmene|amene|conduis|guide|nous|vers|moi|station|arret|jusqu|au|aux|la|le|les|de|du|a|take|me|to|the|go|navigate|bring)\b/g, " ");
    const words = cible.split(/[^a-z0-9]+/).filter(w => w.length > 3);
    const cands = [
      ...stations.map(s => ({ name: s.name, lat: s.lat, lng: s.lng, dist: s.dist, kind: "station" })),
      ...TRANSIT_STOPS.map(s => ({ name: s.name, lat: s.lat, lng: s.lng, kind: "arret",
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
               // Vers un arrêt de transport, on marche ; vers une station, on pédale.
               nav: { lat: best.lat, lng: best.lng, name: best.name,
                      mode: best.kind === "arret" ? "walking" : "bicycling" } };
    }
    return { text: t("ui.ai.ans.nav_unknown", { q: question.trim() }) };
  }

  // 2. Peut-on prendre un vélo maintenant ?
  if (/(velo|bike|rouler|cycl|pedaler)/.test(q)
      && /(maintenant|puis-je|peux|veux|voudrais|possible|moment|aujourd|ce soir|partir|now|today|can i|should i|is it ok)/.test(q)
      && !/\b(rendre|deposer|garer|remettre|borne|dock|return|lock)\b/.test(q)) {
    const ok = advice.mode !== "transit";
    const tail = nearest ? details(t, tn, nearest) : t("ui.ai.ans.no_station");
    return { text: verdict(t, advice, ok, tail) };
  }

  // 3. Prochains départs
  if (/(bus|tram|depart|horaire|quand passe|next (bus|tram|departure)|when (is|does))/.test(q)) {
    if (!deps.length) return { text: t("ui.ai.ans.bus_none") };
    return { text: deps.slice(0, 2).map(d => t("ui.ai.ans.bus", { line: d.line, dir: d.dir, time: d.time, stop: d.stop })).join(" ") };
  }

  // 4. Où rendre le vélo (plus spécifique que la proximité)
  if (/\b(borne|bornes|dock|docks|rendre|garer|deposer|remettre|plein|return|drop off)\b/.test(q)) {
    // Pour rendre un vélo, il faut des bornes LIBRES : la station la plus proche
    // d'un vélo disponible n'est pas forcément celle où l'on peut le déposer.
    const cible = nearestReturn || nearest;
    return { text: cible ? t("ui.ai.ans.docks", { name: cible.name, docks: tn("ui.ai.unit.dock", cible.docks) })
                         : t("ui.ai.ans.no_station") };
  }


  // 5. Station la plus proche
  if (/(station|proche|plus pres|pres de moi|ou est|ou trouver|nearest|closest|where is|where can)/.test(q)) {
    return { text: nearest ? details(t, tn, nearest) : t("ui.ai.ans.no_station") };
  }

  // 6. Vélos électriques
  if (/(electri|elec\b|ebike|electric|e-bike)/.test(q)) {
    const n = nearest ? stationView(nearest).elec : 0;
    return { text: nearest ? t("ui.ai.ans.elec", { n: tn("ui.ai.unit.elec", n), name: nearest.name })
                           : t("ui.ai.ans.no_station") };
  }

  // 7. Météo
  if (/(meteo|pluie|\bvent\b|temps|temperature|pleut|chaud|froid|weather|rain|wind|temperature|cold|hot)/.test(q)) {
    const fc = forecast?.length
      ? forecast.map(f => t("ui.ai.ans.fc", { h: f.h, temp: f.temp, rain: f.rain })).join(" ")
      : "";
    // Les prévisions sont ajoutées après coup : sans elles, pas de point orphelin.
    return { text: weather
      ? t("ui.ai.ans.wx", { label: wmo(weather.code).label, temp: weather.temp, wind: weather.wind, score })
        + (fc ? " " + fc : "")
      : t("ui.ai.ans.no_wx") };
  }

  // 8. Où aller maintenant / conseil
  if (/(ou aller|ou partir|conseil|que faire|recommande|meilleur|what should|advice|recommend|best option)/.test(q)) {
    const ok = advice.mode !== "transit";
    const cible = nearest
      ? t("ui.ai.ans.where_station", { name: nearest.name, dist: fmtDist(nearest.dist),
                                       bikes: tn("ui.ai.unit.bike", nearest.bikes) })
      : t("ui.ai.ans.no_station");
    return { text: verdict(t, advice, ok, cible) };
  }

  // 9. Rien reconnu : on dit ce qui est disponible sans modèle
  return { text: t("ui.ai.ans.help"), unknown: true };
}

