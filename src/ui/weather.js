// ── Météo : présentation pure (codes WMO → icône SVG + libellé i18n) ─
// Les objets météo viennent de hooks/useWeather.js (phase 1) :
//   { temp, rain, wind, windDir, code, label, icon }
// On n'utilise ni `label` (FR seul) ni `icon` (emoji) : tout est dérivé du code.
import { t, getCurrentLang } from "../i18n.js";

const GROUPS = [
  { codes: [0], icon: "sun", key: "clear" },
  { codes: [1, 2], icon: "cloudSun", key: "partly" },
  { codes: [3], icon: "cloud", key: "overcast" },
  { codes: [45, 48], icon: "fog", key: "fog" },
  { codes: [51, 53, 55], icon: "rain", key: "drizzle" },
  { codes: [61, 63, 80, 81], icon: "rain", key: "rain" },
  { codes: [65, 82], icon: "rain", key: "heavy_rain" },
  { codes: [71, 73, 75, 77, 85, 86], icon: "snow", key: "snow" },
  { codes: [95, 96, 99], icon: "storm", key: "storm" },
];

/** Code WMO → { icon, label } */
export function wmo(code) {
  const g = GROUPS.find(x => x.codes.includes(code));
  return g ? { icon: g.icon, label: t(`ui.wx.${g.key}`) } : { icon: "cloud", label: t("ui.wx.unknown") };
}

// ── Score « conditions vélo » 0–10 : l'instant présent ET les prochaines heures ──
//
// Avant, seul l'instant présent comptait, et la pluie à peine : 0,13 mm/h valait −0,4.
// Constaté sur téléphone : pluie légère, 92 % de pluie qui se renforce dans l'heure,
// note 9,6/10. Désormais la note est une somme de pénalités, chacune NOMMÉE (raison
// affichable) :
//  - pluie : une seule échelle, maintenant (certaine) et prévue (pondérée par sa
//    probabilité) ; être mouillé coûte d'emblée 2 points, l'intensité ajoute le reste ;
//  - prévisions : une heure proche compte plus qu'une heure lointaine (le trajet
//    commence maintenant) ; l'AGGRAVATION compte en entier, l'ACCALMIE pour 30 %
//    seulement — partir sous une pluie qui cesse reste plus supportable que partir
//    sous une pluie qui s'installe, mais on part quand même sous la pluie ;
//  - vent : même logique, au-delà de 20 km/h.

/** Pénalité pluie pour une intensité (mm/h) : 2 points dès qu'il pleut, 5 au plus. */
export const rainPenalty = (mm) => (mm > 0 ? Math.min(5, 2 + 3 * mm) : 0);
/** Pénalité vent (km/h) : rien jusqu'à 20 km/h, 3 points au plus. */
const windPenalty = (kmh) => (kmh > 20 ? Math.min(3, (kmh - 20) / 10) : 0);
/** Poids d'une heure de prévision : +1 h compte en entier, +3 h pour un tiers. */
export const FORECAST_WEIGHT = Object.freeze({ 1: 1, 2: 0.6, 3: 0.35 });
/** Part de l'accalmie reprise dans la note (l'aggravation compte en entier). */
export const EASING_SHARE = 0.3;
/** En dessous, une probabilité de pluie est du bruit de prévision. */
const MIN_PROB = 20;

/** Pénalité pluie attendue à une heure de prévision : probabilité × intensité. */
export function expectedRain(f) {
  const p = Number.isFinite(f?.rainProb) ? f.rainProb : (f?.rain > 0 ? 100 : 0);
  if (p < MIN_PROB) return 0;
  // Probable mais 0 mm au modèle déterministe : une averse reste possible, au minimum
  return (p / 100) * rainPenalty(Math.max(f.rain || 0, 0.1));
}

const round1 = (x) => Math.round(x * 10) / 10;

/**
 * Évolution d'un facteur (pluie, vent) sur les prochaines heures, par rapport à
 * maintenant : pénalité si ça empire (l'heure la plus défavorable, pondérée), petit
 * bonus si TOUTES les heures prévues sont meilleures (accalmie).
 * @returns {null | { kind: "worse"|"easing", pts: number, h: number, f: object }}
 */
function trend(now, forecast, penaltyAt) {
  let worst = null;
  for (const f of forecast) {
    const w = FORECAST_WEIGHT[f.h];
    if (!w) continue;
    const excess = w * Math.max(0, penaltyAt(f) - now);
    if (excess > 0 && (!worst || excess > worst.pts)) worst = { kind: "worse", pts: excess, h: f.h, f };
  }
  if (worst) return worst;
  if (now > 0 && forecast.length) {
    const ahead = Math.max(...forecast.map(penaltyAt));
    const relief = EASING_SHARE * (now - ahead);
    if (relief > 0) return { kind: "easing", pts: relief, h: forecast[0].h, f: forecast[0] };
  }
  return null;
}

/**
 * Note détaillée : score et raisons, de la plus pénalisante à la moins.
 * Chaque raison : { key, pts (négatif : pénalité, positif : accalmie), h?, prob?, mm?, kmh? }.
 * @param {object|null} w        météo actuelle (useWeather : { temp, rain, wind, code })
 * @param {Array<{h:number, rain:number, rainProb:number|null, wind:number}>|null} [forecast]
 *        prévisions horaires (+1 h, +2 h, +3 h), facultatives
 * @returns {null | { score: number, reasons: object[] }}
 */
export function bikeScoreDetail(w, forecast = null) {
  if (!w) return null;
  const reasons = [];
  const add = (key, pts, extra = {}) => { if (pts) reasons.push({ key, pts: round1(pts), ...extra }); };

  const rainNow = rainPenalty(w.rain);
  const windNow = windPenalty(w.wind);
  add("rain_now", -rainNow, { mm: w.rain });
  add("wind_now", -windNow, { kmh: w.wind });
  if (w.temp < 2)   add(w.temp < -2 ? "frost" : "cold", w.temp < -2 ? -4 : -2, { temp: w.temp });
  if (w.code >= 95) add("storm", -4);
  if (w.code >= 71 && w.code <= 86) add("snow", -3);

  const fc = Array.isArray(forecast) ? forecast.filter((f) => f && FORECAST_WEIGHT[f.h]) : [];
  if (fc.length) {
    const r = trend(rainNow, fc, expectedRain);
    if (r) {
      const key = r.kind === "easing" ? "rain_easing" : rainNow > 0 ? "rain_worse" : "rain_coming";
      add(key, r.kind === "easing" ? r.pts : -r.pts, { h: r.h, prob: r.f.rainProb ?? null, mm: r.f.rain ?? null });
    }
    const v = trend(windNow, fc.filter((f) => Number.isFinite(f.wind)), (f) => windPenalty(f.wind));
    if (v) add(v.kind === "easing" ? "wind_easing" : "wind_rising", v.kind === "easing" ? v.pts : -v.pts, { h: v.h, kmh: v.f.wind });
  }

  reasons.sort((a, b) => a.pts - b.pts);
  const total = 10 + reasons.reduce((s, x) => s + x.pts, 0);
  return { score: Math.max(0, Math.min(10, round1(total))), reasons };
}

/** Score « conditions vélo » 0–10 (voir bikeScoreDetail pour les raisons). */
export function bikeScore(w, forecast = null) {
  return bikeScoreDetail(w, forecast)?.score ?? null;
}

/**
 * Raisons de la note, en clair : « pluie qui se renforce dans 1 h (92 %) −1,2 ».
 * @param {{reasons: object[]}|null} detail  bikeScoreDetail()
 * @returns {string[]}
 */
export function scoreReasons(detail) {
  if (!detail?.reasons?.length) return [];
  const fmt = new Intl.NumberFormat(getCurrentLang() === "en" ? "en-GB" : "fr-FR", { maximumFractionDigits: 1, signDisplay: "always" });
  return detail.reasons.map((r) =>
    `${t(`ui.wx.why.${r.key}`, { h: r.h, prob: r.prob ?? "?", mm: r.mm, kmh: r.kmh, temp: r.temp })} ${fmt.format(r.pts).replace("-", "−")}`);
}
export const scoreTone = s => (s === null ? "neutral" : s >= 7 ? "good" : s >= 4 ? "warn" : "bad");

/** Conseil multimodal (objet de getWeatherAdvice) → { tone, icon, title } */
export function adviceView(advice) {
  const mode = advice?.mode ?? "bike";
  if (mode === "transit") return { mode, tone: "transit", icon: "bus", title: t("ui.wx.adv_transit") };
  if (mode === "mixed")   return { mode, tone: "warn", icon: "route", title: t("ui.wx.adv_mixed") };
  return { mode: "bike", tone: "good", icon: "bike", title: t("ui.wx.adv_bike") };
}

/** Raison FR produite par getWeatherAdvice → libellé localisé. */
const REASONS = { "orage": "storm", "neige": "snow", "pluie forte": "heavy_rain",
  "vent fort + pluie": "wind_rain", "pluie légère": "light_rain", "vent modéré": "wind",
  "pluie forte annoncée": "heavy_rain_coming", "pluie annoncée": "rain_coming",
  "pluie qui se renforce": "rain_worse", "vent qui forcit": "wind_rising" };
export const reasonLabel = r => (r && REASONS[r] ? t(`ui.wx.r_${REASONS[r]}`) : r ?? "");
