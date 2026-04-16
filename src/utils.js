// VelohNav — fonctions utilitaires pures (math, formatage, données)
import { REF, FALLBACK } from "./constants.js";

// ── Géodésie ───────────────────────────────────────────────────────
export function haversine(la1,ln1,la2,ln2) {
  const R=6371000,dL=(la2-la1)*Math.PI/180,dl=(ln2-ln1)*Math.PI/180;
  const a=Math.sin(dL/2)**2+Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dl/2)**2;
  return Math.round(R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)));
}
export function getBearing(la1,ln1,la2,ln2){
  const φ1=la1*Math.PI/180,φ2=la2*Math.PI/180,Δλ=(ln2-ln1)*Math.PI/180;
  const y=Math.sin(Δλ)*Math.cos(φ2);
  const x=Math.cos(φ1)*Math.sin(φ2)-Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  return(Math.atan2(y,x)*180/Math.PI+360)%360;
}

// ── Formatage ──────────────────────────────────────────────────────
export const fDist = m => m<1000 ? `${m}m` : `${(m/1000).toFixed(1)}km`;
export const fWalk = m => m < 40 ? "< 1 min" : `${Math.ceil(m/80)} min`;

// ── Couleurs / labels station ──────────────────────────────────────
import { C } from "./constants.js";
export const bCol = s => s.status==="CLOSED"?"#444":s.bikes===0?C.bad:s.bikes<=2?C.warn:C.good;
export const bTag = s => s.status==="CLOSED"?"FERMÉ":s.bikes===0?"VIDE":s.bikes<=2?"FAIBLE":"DISPO";

// ── Parsing JCDecaux v3 ────────────────────────────────────────────
export function parseStation(raw) {
  const av = raw.totalStands?.availabilities ?? {};
  const elec  = av.electricalBikes ?? av.electricalInternalBatteryBikes ?? av.electricalExternalBatteryBikes ?? 0;
  const bikes = av.bikes ?? raw.available_bikes ?? 0;
  const meca  = av.mechanicalBikes ?? Math.max(0, bikes - elec);
  return {
    id:    raw.number,
    name:  (raw.name||"").replace(/^\d+[\s\-]+/,"").trim(),
    lat:   raw.position?.latitude  ?? raw.position?.lat,
    lng:   raw.position?.longitude ?? raw.position?.lng,
    cap:   raw.totalStands?.capacity ?? raw.bike_stands ?? 0,
    bikes, elec, meca,
    docks: av.stands ?? raw.available_bike_stands ?? 0,
    status: raw.status==="OPEN" ? "OPEN" : "CLOSED",
    _mock: false,
  };
}

// ── Enrichissement et tri ──────────────────────────────────────────
export function enrich(list, pos) {
  const ref = pos ?? REF;
  return list.filter(s=>s.lat&&s.lng)
    .map(s=>({ ...s, dist:haversine(ref.lat,ref.lng,s.lat,s.lng) }))
    .sort((a,b)=>a.dist-b.dist);
}

// pins() — projette les stations réelles dans le FOV via bearing+heading.
export function pins(stations, heading=null, gpsPos=null) {
  if (heading === null || !gpsPos) return [];
  const FOV_   = 68;
  const RADIUS = 800; // m — cohérent avec ARScreen
  const MAX    = 5;
  return stations
    .filter(s=>s.lat&&s.lng&&s.dist<=RADIUS)
    .map(s=>{
      const bear=getBearing(gpsPos.lat,gpsPos.lng,s.lat,s.lng);
      const rel=((bear-heading+540)%360)-180;
      if(Math.abs(rel)>FOV_/2+8) return null;
      const x=50+(rel/(FOV_/2))*50;
      const dc=Math.min(s.dist,RADIUS);
      const y=70-(1-dc/RADIUS)*44;
      const scale=Math.max(0.5,1-dc/(RADIUS*1.5));
      return{...s,x,y,scale,labelRight:rel<0,rel};
    })
    .filter(Boolean)
    .sort((a,b)=>a.dist-b.dist)
    .slice(0,MAX);
}

// ── Historique stations ────────────────────────────────────────────
const HIST_KEY = "velohnav_history";
export function getHistory() {
  try { return JSON.parse(localStorage.getItem(HIST_KEY)||"[]"); } catch { return []; }
}
export function addToHistory(station) {
  const prev = getHistory().filter(h=>h.id!==station.id);
  const entry = { id:station.id, name:station.name, lat:station.lat, lng:station.lng, visitedAt: Date.now() };
  localStorage.setItem(HIST_KEY, JSON.stringify([entry,...prev].slice(0,10)));
}

// ── Arrêt TC le plus proche ────────────────────────────────────────
import { TRANSIT_STOPS } from "./constants.js";
export function nearestStop(lat, lng) {
  let best = null, bestDist = Infinity;
  TRANSIT_STOPS.forEach(s => {
    const d = Math.sqrt((s.lat-lat)**2 + (s.lng-lng)**2) * 111000;
    if (d < bestDist) { bestDist = d; best = { ...s, distM: Math.round(d) }; }
  });
  return best;
}

// ── LNURL-pay ─────────────────────────────────────────────────────
export async function payLnAddress(lnAddress, satsAmount, comment="VelohNav trajet") {
  try {
    const [user, domain] = lnAddress.split("@");
    if (!user || !domain) throw new Error("Adresse invalide");
    const metaUrl = `https://${domain}/.well-known/lnurlp/${user}`;
    const meta = await fetch(metaUrl).then(r=>r.json());
    if (meta.status === "ERROR") throw new Error(meta.reason);
    const msats = satsAmount * 1000;
    if (msats < meta.minSendable || msats > meta.maxSendable)
      throw new Error(`Montant hors limites (${meta.minSendable/1000}–${meta.maxSendable/1000} sats)`);
    const callbackUrl = new URL(meta.callback);
    callbackUrl.searchParams.set("amount", msats);
    if (meta.commentAllowed > 0) callbackUrl.searchParams.set("comment", comment.slice(0, meta.commentAllowed));
    const inv = await fetch(callbackUrl.toString()).then(r=>r.json());
    if (inv.status === "ERROR") throw new Error(inv.reason);
    window.location.href = `lightning:${inv.pr}`;
    return { ok: true, invoice: inv.pr };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

// ── Notifications push ────────────────────────────────────────────
export async function requestNotifPerm() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  return (await Notification.requestPermission()) === "granted";
}
export function notifyStation(station, prevBikes) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (station.bikes === 0 && prevBikes > 0) {
    new Notification(`🚲 ${station.name} est vide`, {
      body: "Plus aucun vélo disponible.", icon: "./icon-192.png",
      tag: `empty-${station.id}`, silent: false,
    });
  } else if (station.bikes <= 2 && prevBikes > 2) {
    new Notification(`⚠️ ${station.name} presque vide`, {
      body: `Plus que ${station.bikes} vélo${station.bikes>1?"s":""} disponible${station.bikes>1?"s":""}.`,
      icon: "./icon-192.png", tag: `low-${station.id}`, silent: true,
    });
  }
}

// ── Fetch JCDecaux ─────────────────────────────────────────────────
export async function fetchJCDecaux(apiKey) {
  const url = `https://api.jcdecaux.com/vls/v3/stations?contract=Luxembourg&apiKey=${apiKey}`;
  try {
    const r = await fetch(url);
    if (r.ok) return await r.json();
  } catch {}
  try {
    const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`);
    if (r.ok) return await r.json();
  } catch {}
  return null;
}

// ── Bridge Capacitor → ArNavigationActivity ─────────────────────
let _ArNav = null; // singleton — registerPlugin ne doit être appelé qu'une fois

export async function launchNativeArNav(destLat, destLng, destName, mode="bicycling", mapsKey="") {
  try {
    // Initialiser le plugin — si Capacitor n'est pas disponible l'import échouera
    if (!_ArNav) {
      const { registerPlugin } = await import(/* @vite-ignore */ "@capacitor/core");
      _ArNav = registerPlugin("ArNavigation");
    }

    console.log("[ArNav] Lancement navigation →", destName, destLat, destLng, mode);
    await _ArNav.startNavigation({
      destLat:    Number(destLat),
      destLng:    Number(destLng),
      destName:   String(destName),
      travelMode: String(mode),
      mapsKey:    String(mapsKey || ""),
    });
    console.log("[ArNav] startNavigation OK");
    return true;
  } catch(e) {
    console.error("[ArNav] Erreur lancement:", e);
    return false;
  }
}

// ── GPS watcher ────────────────────────────────────────────────────
const IS_NATIVE = typeof window !== "undefined" &&
  !!(window.Capacitor?.isNativePlatform?.() || window.Capacitor?.platform === "android");

export async function startWatchingGPS(cb) {
  if (IS_NATIVE) {
    try {
      const cap = await import(/* @vite-ignore */ "@capacitor/geolocation");
      const { Geolocation } = cap;
      await Geolocation.requestPermissions();
      const id = await Geolocation.watchPosition({ enableHighAccuracy:true }, (pos) => {
        if (pos?.coords) cb({ lat:pos.coords.latitude, lng:pos.coords.longitude, acc:Math.round(pos.coords.accuracy) });
      });
      return () => Geolocation.clearWatch({ id });
    } catch(e) { console.warn("Native GPS watch:", e); }
  }
  if (!navigator.geolocation) return () => {};
  const id = navigator.geolocation.watchPosition(
    p => cb({ lat:p.coords.latitude, lng:p.coords.longitude, acc:Math.round(p.coords.accuracy) }),
    e => console.warn("GPS:", e),
    { enableHighAccuracy:true, maximumAge:5000 }
  );
  return () => navigator.geolocation.clearWatch(id);
}
