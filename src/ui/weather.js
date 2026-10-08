// ── Météo : présentation pure (codes WMO → icône SVG + libellé i18n) ─
// Les objets météo viennent de hooks/useWeather.js (phase 1) :
//   { temp, rain, wind, windDir, code, label, icon }
// On n'utilise ni `label` (FR seul) ni `icon` (emoji) : tout est dérivé du code.
import { t } from "../i18n.js";

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

/** Score « conditions vélo » 0–10 (repris d'AIScreen v3, désormais testé). */
export function bikeScore(w) {
  if (!w) return null;
  let s = 10;
  if (w.rain > 0)   s -= Math.min(4, w.rain * 3);
  if (w.wind > 20)  s -= Math.min(3, (w.wind - 20) / 10);
  if (w.temp < 2)   s -= 2;
  if (w.temp < -2)  s -= 2;
  if (w.code >= 95) s -= 4;
  if (w.code >= 71 && w.code <= 86) s -= 3;
  return Math.max(0, Math.round(s * 10) / 10);
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
  "vent fort + pluie": "wind_rain", "pluie légère": "light_rain", "vent modéré": "wind" };
export const reasonLabel = r => (r && REASONS[r] ? t(`ui.wx.r_${REASONS[r]}`) : r ?? "");
