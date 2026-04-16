/**
 * VelohNav — Tests unitaires
 * Couvre : haversine, getBearing, parseStation, decodePolyline,
 *           fDist, fWalk, bCol, bTag, enrich (logique de tri)
 *
 * Lancer : npx vitest run
 */

import { describe, it, expect } from 'vitest';

// ── Fonctions extraites de App.jsx pour les tests ──────────────────
// (Les fonctions pures n'ont pas de dépendance React — testables directement)

function haversine(la1, ln1, la2, ln2) {
  const R = 6371000, dL = (la2 - la1) * Math.PI / 180, dl = (ln2 - ln1) * Math.PI / 180;
  const a = Math.sin(dL / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dl / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function getBearing(la1, ln1, la2, ln2) {
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180, Δλ = (ln2 - ln1) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

const fDist = m => m < 1000 ? `${m}m` : `${(m / 1000).toFixed(1)}km`;
const fWalk = m => m < 40 ? "< 1 min" : `${Math.ceil(m / 80)} min`;

const C = { bad: "#E03E3E", warn: "#F5820D", good: "#2ECC8F" };
const bCol = s => s.status === "CLOSED" ? "#444" : s.bikes === 0 ? C.bad : s.bikes <= 2 ? C.warn : C.good;
const bTag = s => s.status === "CLOSED" ? "FERMÉ" : s.bikes === 0 ? "VIDE" : s.bikes <= 2 ? "FAIBLE" : "DISPO";

function parseStation(raw) {
  const av = raw.totalStands?.availabilities ?? {};
  const elec = av.electricalBikes ?? av.electricalInternalBatteryBikes ?? av.electricalExternalBatteryBikes ?? 0;
  const bikes = av.bikes ?? raw.available_bikes ?? 0;
  const meca = av.mechanicalBikes ?? Math.max(0, bikes - elec);
  return {
    id: raw.number,
    name: (raw.name || "").replace(/^\d+[\s\-]+/, "").trim(),
    lat: raw.position?.latitude ?? raw.position?.lat,
    lng: raw.position?.longitude ?? raw.position?.lng,
    cap: raw.totalStands?.capacity ?? raw.bike_stands ?? 0,
    bikes, elec, meca,
    docks: av.stands ?? raw.available_bike_stands ?? 0,
    status: raw.status === "OPEN" ? "OPEN" : "CLOSED",
    _mock: false,
  };
}

function decodePolyline(encoded) {
  const pts = []; let idx = 0, lat = 0, lng = 0;
  while (idx < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : (result >> 1);
    pts.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return pts;
}

// ── haversine ─────────────────────────────────────────────────────
describe('haversine', () => {
  it('retourne 0 pour des coordonnées identiques', () => {
    expect(haversine(49.611, 6.130, 49.611, 6.130)).toBe(0);
  });

  it('calcule correctement la distance Gare → Place d\'Armes (~1.3km)', () => {
    // Gare Centrale : 49.59995, 6.13385
    // Place d'Armes : 49.61118, 6.13091
    const d = haversine(49.59995, 6.13385, 49.61118, 6.13091);
    expect(d).toBeGreaterThan(1200);
    expect(d).toBeLessThan(1400);
  });

  it('est symétrique (A→B = B→A)', () => {
    const d1 = haversine(49.6, 6.13, 49.62, 6.15);
    const d2 = haversine(49.62, 6.15, 49.6, 6.13);
    expect(d1).toBe(d2);
  });

  it('1 degré de latitude ≈ 111km', () => {
    const d = haversine(0, 0, 1, 0);
    expect(d).toBeGreaterThan(110000);
    expect(d).toBeLessThan(112000);
  });

  it('gère les grandes distances (Luxembourg → Paris ~287km)', () => {
    const d = haversine(49.611, 6.130, 48.856, 2.352);
    expect(d).toBeGreaterThan(280000);
    expect(d).toBeLessThan(295000);
  });
});

// ── getBearing ────────────────────────────────────────────────────
describe('getBearing', () => {
  it('nord pur → bearing ≈ 0 (ou 360)', () => {
    const b = getBearing(49.0, 6.13, 50.0, 6.13);
    expect(b).toBeCloseTo(0, 0);
  });

  it('sud pur → bearing ≈ 180', () => {
    const b = getBearing(50.0, 6.13, 49.0, 6.13);
    expect(b).toBeCloseTo(180, 0);
  });

  it('est pur → bearing ≈ 90', () => {
    const b = getBearing(49.611, 6.0, 49.611, 7.0);
    expect(b).toBeGreaterThan(85);
    expect(b).toBeLessThan(95);
  });

  it('ouest pur → bearing ≈ 270', () => {
    const b = getBearing(49.611, 7.0, 49.611, 6.0);
    expect(b).toBeGreaterThan(265);
    expect(b).toBeLessThan(275);
  });

  it('retourne toujours une valeur entre 0 et 360', () => {
    for (let i = 0; i < 20; i++) {
      const la1 = 40 + Math.random() * 20, ln1 = -10 + Math.random() * 40;
      const la2 = 40 + Math.random() * 20, ln2 = -10 + Math.random() * 40;
      const b = getBearing(la1, ln1, la2, ln2);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(360);
    }
  });
});

// ── fDist ─────────────────────────────────────────────────────────
describe('fDist', () => {
  it('affiche en mètres sous 1km', () => {
    expect(fDist(0)).toBe('0m');
    expect(fDist(150)).toBe('150m');
    expect(fDist(999)).toBe('999m');
  });

  it('affiche en km au-dessus de 1000m', () => {
    expect(fDist(1000)).toBe('1.0km');
    expect(fDist(1500)).toBe('1.5km');
    expect(fDist(15000)).toBe('15.0km');
  });
});

// ── fWalk ─────────────────────────────────────────────────────────
describe('fWalk', () => {
  it('affiche < 1 min pour distances très courtes', () => {
    expect(fWalk(0)).toBe('< 1 min');
    expect(fWalk(39)).toBe('< 1 min');
  });

  it('arrondit au plafond (Math.ceil)', () => {
    // 80m = exactement 1 min
    expect(fWalk(80)).toBe('1 min');
    // 81m → ceil(81/80) = 2 min
    expect(fWalk(81)).toBe('2 min');
    // 400m = 5 min
    expect(fWalk(400)).toBe('5 min');
  });

  it('ne retourne jamais 0 min', () => {
    for (let m = 0; m <= 1000; m += 10) {
      expect(fWalk(m)).not.toBe('0 min');
    }
  });
});

// ── bCol + bTag ───────────────────────────────────────────────────
describe('bCol + bTag', () => {
  const open0  = { status: "OPEN",   bikes: 0  };
  const open1  = { status: "OPEN",   bikes: 1  };
  const open2  = { status: "OPEN",   bikes: 2  };
  const open5  = { status: "OPEN",   bikes: 5  };
  const closed = { status: "CLOSED", bikes: 3  };

  it('station fermée → gris + FERMÉ', () => {
    expect(bCol(closed)).toBe('#444');
    expect(bTag(closed)).toBe('FERMÉ');
  });

  it('0 vélo → rouge + VIDE', () => {
    expect(bCol(open0)).toBe(C.bad);
    expect(bTag(open0)).toBe('VIDE');
  });

  it('1 ou 2 vélos → orange + FAIBLE', () => {
    expect(bCol(open1)).toBe(C.warn);
    expect(bTag(open1)).toBe('FAIBLE');
    expect(bCol(open2)).toBe(C.warn);
    expect(bTag(open2)).toBe('FAIBLE');
  });

  it('3+ vélos → vert + DISPO', () => {
    expect(bCol(open5)).toBe(C.good);
    expect(bTag(open5)).toBe('DISPO');
  });
});

// ── parseStation ──────────────────────────────────────────────────
describe('parseStation', () => {
  const rawFull = {
    number: 14,
    name: "14 - Kirchberg MUDAM",
    position: { latitude: 49.61921, longitude: 6.15178 },
    status: "OPEN",
    bike_stands: 22,
    totalStands: {
      capacity: 22,
      availabilities: {
        bikes: 9,
        electricalBikes: 7,
        mechanicalBikes: 2,
        stands: 13,
      }
    }
  };

  it('parse correctement une station complète JCDecaux v3', () => {
    const s = parseStation(rawFull);
    expect(s.id).toBe(14);
    expect(s.name).toBe('Kirchberg MUDAM');
    expect(s.lat).toBeCloseTo(49.61921);
    expect(s.lng).toBeCloseTo(6.15178);
    expect(s.bikes).toBe(9);
    expect(s.elec).toBe(7);
    expect(s.meca).toBe(2);
    expect(s.docks).toBe(13);
    expect(s.cap).toBe(22);
    expect(s.status).toBe('OPEN');
    expect(s._mock).toBe(false);
  });

  it('supprime le préfixe numérique du nom', () => {
    const s = parseStation({ ...rawFull, name: "42 - Place d'Armes" });
    expect(s.name).toBe("Place d'Armes");
  });

  it('fallback vers champs legacy si totalStands absent', () => {
    const raw = {
      number: 1, name: "1 - Gare",
      position: { latitude: 49.6, longitude: 6.13 },
      status: "OPEN",
      available_bikes: 5,
      available_bike_stands: 10,
      bike_stands: 15,
    };
    const s = parseStation(raw);
    expect(s.bikes).toBe(5);
    expect(s.docks).toBe(10);
    expect(s.cap).toBe(15);
  });

  it('CLOSED si status !== OPEN', () => {
    const s = parseStation({ ...rawFull, status: "CLOSED" });
    expect(s.status).toBe('CLOSED');
  });

  it('meca ne peut pas être négatif', () => {
    // elec > bikes (données corrompues)
    const raw = {
      ...rawFull,
      totalStands: {
        capacity: 22,
        availabilities: { bikes: 3, electricalBikes: 5, stands: 19 }
      }
    };
    const s = parseStation(raw);
    expect(s.meca).toBeGreaterThanOrEqual(0);
  });
});

// ── decodePolyline ────────────────────────────────────────────────
describe('decodePolyline', () => {
  it('décode une polyline Google connue', () => {
    // "_p~iF~ps|U_ulLnnqC_mqNvxq`@" → 3 points connus
    const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(pts).toHaveLength(3);
    expect(pts[0].lat).toBeCloseTo(38.5, 0);
    expect(pts[0].lng).toBeCloseTo(-120.2, 0);
  });

  it('retourne un tableau vide pour une chaîne vide', () => {
    expect(decodePolyline('')).toHaveLength(0);
  });

  it('tous les points ont lat et lng', () => {
    const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    pts.forEach(p => {
      expect(typeof p.lat).toBe('number');
      expect(typeof p.lng).toBe('number');
    });
  });
});

// ── getWeatherAdvice ──────────────────────────────────────────────
// Reproduit la logique de App.jsx pour les tests
const C_bad = "#E03E3E", C_warn = "#F5820D", C_good = "#2ECC8F";
function getWeatherAdvice(weather) {
  if (!weather) return { mode:"bike", reason:null };
  const { rain, wind, code } = weather;
  const isStorm = code >= 95;
  const isSnow  = (code >= 71 && code <= 77) || code === 85 || code === 86;
  const heavyRain = rain > 2.0;
  const lightRain = rain > 0.5;
  const strongWind = wind > 35;
  const mildWind   = wind > 25;
  if (isStorm || isSnow || heavyRain || (strongWind && lightRain))
    return { mode:"transit", reason: isStorm?"orage": isSnow?"neige": heavyRain?"pluie forte":"vent fort + pluie" };
  if (lightRain || mildWind)
    return { mode:"mixed", reason: lightRain?"pluie légère":"vent modéré" };
  return { mode:"bike", reason:null };
}

describe('getWeatherAdvice', () => {
  it('retourne bike pour conditions idéales', () => {
    expect(getWeatherAdvice({ rain:0, wind:10, code:0 }).mode).toBe('bike');
  });
  it('retourne transit pour orage (code 95)', () => {
    const r = getWeatherAdvice({ rain:0.1, wind:20, code:95 });
    expect(r.mode).toBe('transit');
    expect(r.reason).toBe('orage');
  });
  it('retourne transit pour neige (code 71)', () => {
    expect(getWeatherAdvice({ rain:0, wind:5, code:71 }).mode).toBe('transit');
  });
  it('retourne transit pour pluie forte >2mm', () => {
    const r = getWeatherAdvice({ rain:3.5, wind:10, code:63 });
    expect(r.mode).toBe('transit');
    expect(r.reason).toBe('pluie forte');
  });
  it('retourne mixed pour pluie légère 0.5-2mm', () => {
    const r = getWeatherAdvice({ rain:1.0, wind:10, code:61 });
    expect(r.mode).toBe('mixed');
    expect(r.reason).toBe('pluie légère');
  });
  it('retourne mixed pour vent modéré 25-35km/h', () => {
    const r = getWeatherAdvice({ rain:0, wind:30, code:1 });
    expect(r.mode).toBe('mixed');
    expect(r.reason).toBe('vent modéré');
  });
  it('retourne bike quand null', () => {
    expect(getWeatherAdvice(null).mode).toBe('bike');
  });
  it('retourne transit pour vent fort + pluie', () => {
    expect(getWeatherAdvice({ rain:0.8, wind:40, code:61 }).mode).toBe('transit');
  });
});

// ── Historique stations ───────────────────────────────────────────
// Simuler localStorage pour les tests
const mockStorage = {};
const mockLocalStorage = {
  getItem: k => mockStorage[k] ?? null,
  setItem: (k, v) => { mockStorage[k] = v; },
  removeItem: k => { delete mockStorage[k]; },
};
const HIST_KEY = "velohnav_history";

function getHistory() {
  try { return JSON.parse(mockLocalStorage.getItem(HIST_KEY)||"[]"); } catch { return []; }
}
function addToHistory(station) {
  const prev = getHistory().filter(h=>h.id!==station.id);
  const entry = { id:station.id, name:station.name, lat:station.lat, lng:station.lng, visitedAt:1 };
  mockLocalStorage.setItem(HIST_KEY, JSON.stringify([entry,...prev].slice(0,10)));
}

describe('historique stations', () => {
  beforeEach(() => { delete mockStorage[HIST_KEY]; });

  it('commence vide', () => {
    expect(getHistory()).toHaveLength(0);
  });
  it('ajoute une station', () => {
    addToHistory({ id:1, name:"Gare", lat:49.6, lng:6.13 });
    expect(getHistory()).toHaveLength(1);
    expect(getHistory()[0].name).toBe("Gare");
  });
  it('ne duplique pas la même station', () => {
    addToHistory({ id:1, name:"Gare", lat:49.6, lng:6.13 });
    addToHistory({ id:1, name:"Gare", lat:49.6, lng:6.13 });
    expect(getHistory()).toHaveLength(1);
  });
  it('la dernière visitée est en première position', () => {
    addToHistory({ id:1, name:"Gare",    lat:49.6, lng:6.13 });
    addToHistory({ id:2, name:"Hamilius", lat:49.61, lng:6.13 });
    expect(getHistory()[0].name).toBe("Hamilius");
  });
  it('limite à 10 entrées', () => {
    for (let i = 0; i < 15; i++)
      addToHistory({ id:i, name:`Station ${i}`, lat:49.6, lng:6.13 });
    expect(getHistory()).toHaveLength(10);
  });
});

// ── nearestStop ───────────────────────────────────────────────────
// Reproduire la logique de nearestStop
const TRANSIT_STOPS_TEST = [
  { id:"T06", name:"Hamilius", lat:49.6118, lng:6.1299 },
  { id:"T10", name:"Gare Centrale", lat:49.5998, lng:6.1340 },
  { id:"B01", name:"Gare Routière", lat:49.6005, lng:6.1320 },
];
function nearestStop(lat, lng) {
  let best = null, bestDist = Infinity;
  TRANSIT_STOPS_TEST.forEach(s => {
    const d = Math.sqrt((s.lat-lat)**2 + (s.lng-lng)**2) * 111000;
    if (d < bestDist) { bestDist = d; best = { ...s, distM: Math.round(d) }; }
  });
  return best;
}

describe('nearestStop', () => {
  it('trouve Hamilius depuis Ville-Haute', () => {
    const s = nearestStop(49.611, 6.130);
    expect(s.name).toBe('Hamilius');
  });
  it('trouve Gare Centrale depuis Bonnevoie', () => {
    const s = nearestStop(49.596, 6.134);
    expect(s.id).toBe('T10');
  });
  it('retourne une distance en mètres', () => {
    const s = nearestStop(49.611, 6.130);
    expect(s.distM).toBeGreaterThan(0);
    expect(s.distM).toBeLessThan(5000);
  });
});
