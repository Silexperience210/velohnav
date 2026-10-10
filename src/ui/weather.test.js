import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setLang, getCurrentLang } from "../i18n.js";
import { bikeScore, bikeScoreDetail, scoreReasons, reasonLabel } from "./weather.js";
import { getWeatherAdvice } from "../hooks/useWeather.js";

// Météo actuelle (useWeather) et prévisions horaires (AIScreen : +1 h, +2 h, +3 h).
const now = (o = {}) => ({ temp: 14, rain: 0, wind: 10, code: 1, ...o });
const fc = (...hours) => hours.map((o, i) => ({ h: i + 1, temp: 14, rain: 0, rainProb: 5, wind: 10, ...o }));
const keys = (d) => d.reasons.map((r) => r.key);

describe("note vélo : les prévisions comptent", () => {
  // Les libellés attendus sont français : on fixe la langue au lieu de dépendre de
  // celle de la machine (anglaise dans la CI, française en local).
  let ambient;
  beforeAll(() => { ambient = getCurrentLang(); setLang("fr"); });
  afterAll(() => setLang(ambient));

  it("cas constaté sur téléphone : pluie légère qui se renforce à 92 % dans l'heure — plus 9,6/10", () => {
    const w = now({ rain: 0.13, code: 61 });
    const f = fc({ rain: 0.8, rainProb: 92 }, { rain: 1.2, rainProb: 85 }, { rain: 0.6, rainProb: 70 });
    const d = bikeScoreDetail(w, f);
    expect(d.score).toBeLessThanOrEqual(6);
    expect(keys(d)).toContain("rain_worse");
    // Le conseil change aussi : ce n'est plus « bon moment pour un vélo » sans réserve
    expect(getWeatherAdvice(w, f)).toEqual({ mode: "mixed", reason: "pluie qui se renforce" });
    expect(reasonLabel("pluie qui se renforce")).toBe("La pluie va se renforcer");
  });

  it("pluie qui cesse : meilleure note que la même pluie qui s'installe, moins bonne qu'un temps sec", () => {
    const w = now({ rain: 0.8, code: 61 });
    const stops = bikeScoreDetail(w, fc({ rain: 0, rainProb: 10 }, { rain: 0, rainProb: 5 }, { rain: 0, rainProb: 5 }));
    const sets = bikeScoreDetail(w, fc({ rain: 1.5, rainProb: 90 }, { rain: 1.5, rainProb: 90 }, { rain: 1.5, rainProb: 90 }));
    const alone = bikeScore(w);
    expect(keys(stops)).toContain("rain_easing");
    expect(stops.score).toBeGreaterThan(alone);          // l'accalmie compte…
    expect(stops.score).toBeLessThan(bikeScore(now()));  // … mais on part sous la pluie
    expect(sets.score).toBeLessThan(alone);
    // Asymétrie, à écart égal : maintenant 0,5 mm/h (pénalité 3,5) ; ensuite 1 mm/h
    // certain (5 : +1,5) ou 1 mm/h à 40 % (2 : −1,5)
    const base = now({ rain: 0.5, code: 61 });
    const up = bikeScoreDetail(base, fc({ rain: 1, rainProb: 100 }, { rain: 1, rainProb: 100 }, { rain: 1, rainProb: 100 }));
    const down = bikeScoreDetail(base, fc({ rain: 1, rainProb: 40 }, { rain: 1, rainProb: 40 }, { rain: 1, rainProb: 40 }));
    const worse = -up.reasons.find((r) => r.key === "rain_worse").pts;
    const easing = down.reasons.find((r) => r.key === "rain_easing").pts;
    expect(worse).toBeCloseTo(1.5, 5);
    expect(easing).toBeCloseTo(0.5, 5);   // 30 % de 1,5, arrondi au dixième
    expect(bikeScore(base) - up.score).toBeGreaterThan(down.score - bikeScore(base));
    // Une pluie qui cesse ne durcit pas le conseil
    expect(getWeatherAdvice(w, fc({ rain: 0, rainProb: 10 }))).toEqual(getWeatherAdvice(w));
  });

  it("temps stable : les prévisions ne changent ni la note ni le conseil", () => {
    const w = now({ wind: 12 });
    const f = fc({ rainProb: 5, wind: 12 }, { rainProb: 10, wind: 13 }, { rainProb: 0, wind: 11 });
    const d = bikeScoreDetail(w, f);
    expect(d.score).toBe(bikeScore(w));
    expect(d.score).toBe(10);
    expect(d.reasons).toEqual([]);
    expect(getWeatherAdvice(w, f)).toEqual({ mode: "bike", reason: null });
  });

  it("vent qui forcit : pénalité nommée, et conseil durci au-delà de 35 km/h", () => {
    const w = now({ wind: 15 });
    const f = fc({ wind: 42 }, { wind: 48 }, { wind: 45 });
    const d = bikeScoreDetail(w, f);
    expect(d.score).toBeLessThan(bikeScore(w));
    expect(d.reasons[0]).toMatchObject({ key: "wind_rising", h: 1, kmh: 42 });
    expect(getWeatherAdvice(w, f)).toEqual({ mode: "mixed", reason: "vent qui forcit" });
    // Le vent qui faiblit : un petit mieux seulement
    const easing = bikeScoreDetail(now({ wind: 45 }), fc({ wind: 20 }, { wind: 18 }, { wind: 15 }));
    expect(keys(easing)).toContain("wind_easing");
    expect(easing.score).toBeLessThan(bikeScore(now()));
  });

  it("une pluie annoncée dans 1 h pèse plus que la même dans 3 h", () => {
    const soon = bikeScore(now(), fc({ rain: 1, rainProb: 90 }, {}, {}));
    const later = bikeScore(now(), fc({}, {}, { rain: 1, rainProb: 90 }));
    expect(soon).toBeLessThan(later);
    expect(later).toBeLessThan(10);
  });

  it("pluie forte probable dans l'heure : conseil transports en commun", () => {
    expect(getWeatherAdvice(now(), fc({ rain: 3, rainProb: 80 }))).toEqual({ mode: "transit", reason: "pluie forte annoncée" });
    // Probabilité faible : rien ne change
    expect(getWeatherAdvice(now(), fc({ rain: 3, rainProb: 30 })).mode).toBe("bike");
  });

  it("explicable : la note est 10 plus la somme des raisons, et chaque raison se lit", () => {
    const w = now({ rain: 0.13, wind: 28, code: 61 });
    const d = bikeScoreDetail(w, fc({ rain: 0.8, rainProb: 92 }, {}, {}));
    const sum = 10 + d.reasons.reduce((s, r) => s + r.pts, 0);
    expect(Math.abs(d.score - sum)).toBeLessThanOrEqual(0.15);   // arrondis au dixième
    // Triées de la plus pénalisante à la moins
    for (let i = 1; i < d.reasons.length; i++) expect(d.reasons[i].pts).toBeGreaterThanOrEqual(d.reasons[i - 1].pts);
    const lines = scoreReasons(d);
    expect(lines.length).toBe(d.reasons.length);
    expect(lines.join(" · ")).toMatch(/pluie qui se renforce dans 1 h \(92 %, 0.8 mm\) −\d/);
    expect(lines.join(" · ")).toMatch(/vent 28 km\/h −0,8/);
  });

  it("sans prévisions : la note et le conseil de l'instant présent", () => {
    expect(bikeScore(null)).toBeNull();
    expect(bikeScore(now({ rain: 3, code: 63 }))).toBe(5);
    expect(getWeatherAdvice(now({ rain: 1, code: 61 }), null)).toEqual({ mode: "mixed", reason: "pluie légère" });
    // Une probabilité absente : la quantité prévue décide
    expect(bikeScore(now(), [{ h: 1, rain: 0.5, rainProb: null, wind: 10 }])).toBeLessThan(10);
  });
});
