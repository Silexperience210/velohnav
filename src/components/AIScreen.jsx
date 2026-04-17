import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { t } from "../i18n.js";
import { C, COMPASS_LABELS, FOV, TRANSIT_STOPS } from "../constants.js";
import { haversine, getBearing, fDist, fWalk, bCol, bTag, pins,
         getHistory, launchNativeArNav } from "../utils.js";
import { fetchWeather, getWeatherAdvice } from "../hooks/useWeather.js";

// ── Score conditions vélo 0-10 ─────────────────────────────────────
function bikeScore(weather) {
  if (!weather) return null;
  let score = 10;
  if (weather.rain > 0)   score -= Math.min(4, weather.rain * 3);
  if (weather.wind > 20)  score -= Math.min(3, (weather.wind - 20) / 10);
  if (weather.temp < 2)   score -= 2;
  if (weather.temp < -2)  score -= 2;
  if (weather.code >= 95) score -= 4;
  if (weather.code >= 71 && weather.code <= 86) score -= 3;
  return Math.max(0, Math.round(score * 10) / 10);
}
function scoreColor(s) {
  if (s === null) return C.muted;
  if (s >= 7) return "#2ECC8F";
  if (s >= 4) return "#F5820D";
  return "#E03E3E";
}
function scoreLabel(s) {
  if (s === null) return "";
  if (s >= 8) return "Parfait 🚴";
  if (s >= 6) return "Correct ⚡";
  if (s >= 4) return "Mitigé 🌂";
  return "Éviter 🚊";
}

// ── Détection balise NAV dans la réponse Claude ───────────────────
// Claude répond [NAV:lat,lng,nom,mode] pour lancer l'AR navigation
const NAV_RE = /\[NAV:([\d.]+),([\d.]+),([^,\]]+)(?:,(bicycling|walking))?\]/i;

function parseNavCommand(text) {
  const m = text.match(NAV_RE);
  if (!m) return null;
  return { lat: parseFloat(m[1]), lng: parseFloat(m[2]),
           name: m[3].trim(), mode: m[4] || "bicycling" };
}

function stripNavTag(text) {
  return text.replace(NAV_RE, "").trim();
}

// ── Composant principal ────────────────────────────────────────────
function AIScreen({ stations, claudeKey, aiHistory, setAiHistory,
                    aiDisplay, setAiDisplay, gpsPos=null,
                    mapsKey="", onLaunchAR=null }) {

  const [input,    setInput]    = useState("");
  const [busy,     setBusy]     = useState(false);
  const [weather,  setWeather]  = useState(null);
  const [forecast, setForecast] = useState(null); // prévisions 3h
  const [navCmd,   setNavCmd]   = useState(null); // commande AR en attente
  const endRef = useRef();

  useEffect(()=>endRef.current?.scrollIntoView({behavior:"smooth"}),[aiDisplay]);

  // ── Fetch météo + prévisions 3h ──────────────────────────────────
  useEffect(()=>{
    if (!gpsPos) return;
    let dead = false;
    (async()=>{
      // Météo actuelle
      const w = await fetchWeather(gpsPos.lat, gpsPos.lng);
      if (!dead) setWeather(w);

      // Prévisions horaires 3h (via OpenMeteo hourly)
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${gpsPos.lat}&longitude=${gpsPos.lng}`
          + `&hourly=temperature_2m,precipitation_probability,precipitation,wind_speed_10m,weather_code`
          + `&wind_speed_unit=kmh&precipitation_unit=mm&timezone=Europe/Luxembourg&forecast_days=1&forecast_hours=4`;
        const r = await fetch(url);
        const d = await r.json();
        if (!dead && d.hourly) {
          const now = new Date();
          const h = d.hourly;
          const fc = [1,2,3].map(delta=>{
            const target = new Date(now.getTime() + delta*3600000);
            const idx = h.time.findIndex(t=> new Date(t) > target) - 1;
            if (idx < 0) return null;
            return {
              h: delta,
              temp: Math.round(h.temperature_2m[idx]),
              rain: h.precipitation[idx],
              rainProb: h.precipitation_probability[idx],
              wind: Math.round(h.wind_speed_10m[idx]),
              code: h.weather_code[idx],
            };
          }).filter(Boolean);
          setForecast(fc);
        }
      } catch { /* forecast optionnel */ }
    })();
    return ()=>{ dead = true; };
  }, [gpsPos?.lat ? Math.round(gpsPos.lat*100) : null,
      gpsPos?.lng ? Math.round(gpsPos.lng*100) : null]);

  // ── Score + conseil météo ─────────────────────────────────────────
  const score   = bikeScore(weather);
  const advice  = getWeatherAdvice(weather);

  // ── Message d'accueil proactif ────────────────────────────────────
  const initMsg = useMemo(()=>{
    const top   = stations.find(s=>s.bikes>0);
    const veloh = top
      ? `${stations.filter(s=>s.bikes>0).length}/${stations.length} stations dispo. ` +
        `Plus proche : ${top.name} (${fDist(top.dist)}, ${top.bikes}🚲 ⚡${top.elec}).`
      : t("map.loading");

    if (!weather) return veloh;

    const sc = bikeScore(weather);
    const adv = getWeatherAdvice(weather);

    // Prévision pluie dans les 3h
    const rainSoon = forecast?.find(f=> f.rainProb > 50 || f.rain > 0.5);
    const rainWarn = rainSoon
      ? ` ⚠️ Pluie dans ~${rainSoon.h}h (${rainSoon.rainProb}%).`
      : "";

    if (adv.mode === "transit") {
      const nearTram = gpsPos
        ? TRANSIT_STOPS.filter(t=>{
            const d = Math.sqrt((t.lat-gpsPos.lat)**2+(t.lng-gpsPos.lng)**2)*111000;
            return d < 800;
          }).slice(0,2).map(t=> t.name).join(", ")
        : "";
      return `${weather.icon} ${weather.label} · ${weather.temp}°C · 💨${weather.wind}km/h\n`
           + `⚠️ Conditions difficiles (${adv.reason}) — Tram conseillé.${nearTram ? ` Arrêts proches : ${nearTram}.` : ""}\n`
           + veloh;
    }

    return `${weather.icon} ${weather.label} · ${weather.temp}°C · Score vélo : ${sc}/10 (${scoreLabel(sc)})${rainWarn}\n` + veloh;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stations, weather, forecast, gpsPos]);

  useEffect(()=>{
    if (aiHistory.length === 0)
      setAiDisplay([{ role:"ai", text:initMsg }]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initMsg]);

  // ── Système prompt ────────────────────────────────────────────────
  const systemPrompt = useMemo(()=>{
    const hist = getHistory().slice(0,5);
    const histTxt = hist.length
      ? `\nStations récemment visitées : ${hist.map(h=>h.name).join(", ")}.`
      : "";

    // Tram proches
    const nearTram = gpsPos
      ? TRANSIT_STOPS.filter(t=>{
          const d = Math.sqrt((t.lat-gpsPos.lat)**2+(t.lng-gpsPos.lng)**2)*111000;
          return d < 600;
        }).map(t=>{
          const d = Math.round(Math.sqrt((t.lat-gpsPos.lat)**2+(t.lng-gpsPos.lng)**2)*111000);
          return `${t.name} (${d}m${t.hub?" — hub":""}${t.veloh?" 🚲":""})`;
        })
      : [];
    const tramNear = nearTram.length ? `\nArrêts tram T1 proches : ${nearTram.join(", ")}.` : "";

    // Météo
    const sc = bikeScore(weather);
    const meteoTxt = weather
      ? `\nMÉTÉO ACTUELLE : ${weather.icon} ${weather.label} | ${weather.temp}°C | Pluie: ${weather.rain}mm/h | Vent: ${weather.wind}km/h | Score vélo: ${sc}/10 (${scoreLabel(sc)})`
      : "\nMétéo : données non disponibles.";

    const fcTxt = forecast?.length
      ? `\nPRÉVISIONS : ${forecast.map(f=>`+${f.h}h: ${f.temp}°C, pluie ${f.rain}mm (${f.rainProb}% proba), vent ${f.wind}km/h`).join(" | ")}`
      : "";

    // Position GPS
    const gpsTxt = gpsPos
      ? `\nPosition GPS : ${gpsPos.lat.toFixed(5)}, ${gpsPos.lng.toFixed(5)}`
      : "";

    return `Tu es VELOH·AI, assistant mobilité VelohNav pour Luxembourg.
Réponds en français, concis (4-5 lignes). Sois direct et utile.
${meteoTxt}${fcTxt}${gpsTxt}

STATIONS VEL'OH (par distance) :
${stations.map(s=>`• ${s.name} | ${s.bikes}🚲 (⚡${s.elec}élec 🔧${s.meca}méca) | ${s.docks} docks | ${fDist(s.dist)} | ${bTag(s)}`).join("\n")}${histTxt}${tramNear}

TRAM T1 — Findel/Aéroport ↔ Gasperich/Stadion (24 arrêts, 16km, GRATUIT) :
Horaires : 04h20→00h06 tous les jours
Fréquence : 3-4 min (LuxExpo↔Bouneweg) | 8 min (extrémités) | 15 min heures creuses
Hubs : Luxexpo, Rout Bréck/Pafendall (funiculaire+CFL), Place de l'Étoile, Hamilius, Gare Centrale (CFL), Howald (CFL), Cloche d'Or, Gasperich/Stadion

NAVIGATION AR : Si l'utilisateur demande à être guidé vers une destination (station Vel'OH, arrêt tram, lieu),
tu DOIS terminer ta réponse par une balise de navigation :
[NAV:latitude,longitude,NomDestination,mode]
Exemples :
  → guider vers station Hamilius en vélo : [NAV:49.6118,6.1299,Hamilius Vel'OH,bicycling]
  → guider vers Gare Centrale à pied : [NAV:49.5998,6.1340,Gare Centrale,walking]
  → guider vers Luxexpo en vélo : [NAV:49.6267,6.1651,Luxexpo,bicycling]
N'utilise cette balise QUE si l'utilisateur veut explicitement être guidé/naviguer/aller quelque part.
Ne l'utilise pas pour de simples informations ou conseils.`;
  },[stations, weather, forecast, gpsPos]);

  // ── Envoi message + parsing réponse AR ───────────────────────────
  const sendText = useCallback(async(text)=>{
    const q = (text||input).trim();
    if (!q || busy) return;
    if (!claudeKey) {
      setAiDisplay(d=>[...d,{role:"user",text:q},{role:"ai",text:t("ai.missing_key")}]);
      setInput(""); return;
    }
    setInput(""); setBusy(true); setNavCmd(null);
    setAiDisplay(d=>[...d,{role:"user",text:q}]);
    const hist = [...aiHistory,{role:"user",content:q}].slice(-20);
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "x-api-key": claudeKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body:JSON.stringify({ model:"claude-haiku-4-5-20251001", max_tokens:800,
          system:systemPrompt, messages:hist }),
      });
      const data = await r.json();
      if (!r.ok) {
        const errMsg = r.status===401 ? t("ai.invalid_key")
          : data?.error?.message ?? `Erreur API (${r.status})`;
        setAiDisplay(d=>[...d,{role:"ai",text:`⚠ ${errMsg}`}]);
      } else {
        const raw   = data.content?.[0]?.text ?? "Erreur de réponse.";
        const nav   = parseNavCommand(raw);
        const reply = stripNavTag(raw);
        setAiHistory([...hist,{role:"assistant",content:raw}]);
        setAiDisplay(d=>[...d,{role:"ai",text:reply, nav}]);
        if (nav) setNavCmd(nav); // préparer le bouton AR
      }
    } catch(e) {
      setAiDisplay(d=>[...d,{role:"ai",text:`Erreur réseau : ${e.message ?? "connexion impossible"}.`}]);
    }
    setBusy(false);
  },[input,busy,aiHistory,claudeKey,systemPrompt,setAiHistory,setAiDisplay]);

  const [launching, setLaunching] = useState(false);

  // ── Lancer la nav AR depuis le bouton ─────────────────────────────
  const [navError, setNavError] = useState(null);

  const launchNav = useCallback(async(nav)=>{
    if (!nav || launching) return;
    setLaunching(true);
    setNavError(null);
    try {
      let ok;
      if (onLaunchAR) ok = await onLaunchAR(nav);
      else ok = await launchNativeArNav(nav.lat, nav.lng, nav.name, nav.mode, mapsKey);
      if (ok === false) {
        // launchNativeArNav a échoué — voir console pour détails
        setNavError("Échec lancement AR — vérifiez les logs console");
      }
    } catch(e) {
      const msg = e?.message || String(e);
      console.error("[AIScreen] launchNav error:", msg);
      setNavError(msg);
    }
    setLaunching(false);
  },[mapsKey, onLaunchAR, launching]);

  // ── Questions rapides contextuelles ──────────────────────────────
  const QUICK = useMemo(()=>{
    const base = [t("ai.q1"), t("ai.q2"), t("ai.q3")];
    // Boutons météo contextuels
    if (weather && score !== null) {
      if (score < 5) base.push("🚊 Itinéraire tram pour aller en ville ?");
      else           base.push("🌡 Conditions vélo maintenant ?");
    }
    // Bouton AR direct si une station est proche
    const near = stations.find(s=>s.bikes>0 && s.dist < 500);
    if (near) base.push(`🗺 Guide-moi vers ${near.name}`);
    return base.slice(0,5);
  },[weather, score, stations]);

  // ── Rendu ─────────────────────────────────────────────────────────
  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", background:C.bg, minHeight:0 }}>

      {/* Header avec score météo */}
      <div style={{ padding:"9px 14px 7px", borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ color:C.accent, fontSize:10, fontFamily:C.fnt, fontWeight:700, letterSpacing:2 }}>{t("ai.title")}</div>
            <div style={{ color:C.muted, fontSize:8, fontFamily:C.fnt }}>
              Claude · {stations.length} stations · {stations.some(s=>!s._mock)?t("ai.live"):t("station.simulated")}
            </div>
          </div>
          {/* Badge météo + score */}
          {weather && score !== null && (
            <div style={{ display:"flex", alignItems:"center", gap:6,
              background:"rgba(0,0,0,0.4)", border:`1px solid ${C.border}`,
              borderRadius:6, padding:"4px 8px" }}>
              <span style={{ fontSize:14 }}>{weather.icon}</span>
              <div>
                <div style={{ color:scoreColor(score), fontSize:9, fontFamily:C.fnt, fontWeight:700 }}>
                  {score}/10 · {scoreLabel(score)}
                </div>
                <div style={{ color:C.muted, fontSize:7, fontFamily:C.fnt }}>
                  {weather.temp}°C · 💨{weather.wind}km/h{weather.rain>0?` · 🌧${weather.rain}mm`:""}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Barre prévisions 3h */}
        {forecast && forecast.length > 0 && (
          <div style={{ display:"flex", gap:6, marginTop:6, paddingTop:5,
            borderTop:`1px solid ${C.border}30` }}>
            {forecast.map(f=>(
              <div key={f.h} style={{ flex:1, textAlign:"center",
                background:"rgba(0,0,0,0.3)", borderRadius:4, padding:"3px 0",
                border:`1px solid ${f.rain>0.5?"#F5820D33":C.border+"22"}` }}>
                <div style={{ color:C.muted, fontSize:7, fontFamily:C.fnt }}>+{f.h}h</div>
                <div style={{ color:f.rain>0.5?"#F5820D":C.text, fontSize:8, fontFamily:C.fnt, fontWeight:700 }}>
                  {f.temp}°C{f.rain>0?` 🌧`:` ☀`}
                </div>
                {f.rainProb > 20 && (
                  <div style={{ color:"#F5820D88", fontSize:6, fontFamily:C.fnt }}>{f.rainProb}%</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Messages */}
      <div style={{ flex:1, overflowY:"auto", padding:"11px 14px",
        display:"flex", flexDirection:"column", gap:9 }}>
        {aiDisplay.map((m,i)=>(
          <div key={i} style={{ alignSelf:m.role==="user"?"flex-end":"flex-start", maxWidth:"88%" }}>
            {m.role==="ai" && (
              <div style={{ color:C.accent, fontSize:7, fontFamily:C.fnt, letterSpacing:2, marginBottom:3 }}>
                {t("ai.title")}
              </div>
            )}
            <div style={{ background:m.role==="user"?C.accentBg:"rgba(255,255,255,0.04)",
              border:`1px solid ${m.role==="user"?C.accent+"55":C.border}`,
              borderRadius:m.role==="user"?"10px 10px 2px 10px":"10px 10px 10px 2px",
              padding:"9px 12px" }}>
              <div style={{ color:m.role==="user"?C.accent:C.text,
                fontSize:10, fontFamily:C.fnt, lineHeight:1.7, whiteSpace:"pre-wrap" }}>
                {m.text}
              </div>
              {/* Bouton AR inline dans le message */}
              {m.nav && (
                <div onPointerDown={()=>launchNav(m.nav)}
                  style={{ marginTop:8, display:"flex", alignItems:"center", gap:6,
                    background: launching
                      ? "rgba(245,130,13,0.08)"
                      : "linear-gradient(135deg,#F5820D22,#F5820D11)",
                    border:`1px solid ${C.accent}`,
                    borderRadius:6, padding:"7px 10px",
                    cursor: launching ? "wait" : "pointer",
                    opacity: launching ? 0.7 : 1 }}>
                  <span style={{ fontSize:16 }}>{launching ? "⏳" : "🗺"}</span>
                  <div>
                    <div style={{ color: navError ? "#E03E3E" : C.accent, fontSize:9, fontFamily:C.fnt, fontWeight:700 }}>
                      {launching ? "OUVERTURE AR…" : navError ? "ERREUR ↓" : "NAVIGUER EN AR"}
                    </div>
                    <div style={{ color:C.muted, fontSize:7, fontFamily:C.fnt }}>
                      {navError ? navError : `→ ${m.nav.name} · ${m.nav.mode==="walking"?"à pied":"vélo"}`}
                    </div>
                  </div>
                  <div style={{ marginLeft:"auto", color:C.accent, fontSize:12 }}>▶</div>
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div style={{ alignSelf:"flex-start" }}>
            <div style={{ color:C.accent, fontSize:7, fontFamily:C.fnt, letterSpacing:2, marginBottom:3 }}>
              {t("ai.title")}
            </div>
            <div style={{ background:"rgba(255,255,255,0.04)", border:`1px solid ${C.border}`,
              borderRadius:"10px 10px 10px 2px", padding:"10px 14px",
              display:"flex", gap:6, alignItems:"center" }}>
              {[0,1,2].map(i=>(
                <div key={i} style={{ width:6, height:6, borderRadius:"50%", background:C.accent,
                  opacity:0.7, transform:`scale(${i===1?1.2:0.8})` }}/>
              ))}
              <span style={{ color:C.muted, fontSize:8, fontFamily:C.fnt, marginLeft:4 }}>
                en train de répondre…
              </span>
            </div>
          </div>
        )}
        <div ref={endRef}/>
      </div>

      {/* Questions rapides contextuelles */}
      <div style={{ display:"flex", gap:6, padding:"5px 14px 7px",
        overflowX:"auto", flexShrink:0 }}>
        {QUICK.map(q=>(
          <div key={q} onPointerDown={()=>sendText(q)}
            style={{ flexShrink:0, background:"transparent",
              border:`1px solid ${q.startsWith("🗺")?"#F5820D55":C.border}`,
              color:q.startsWith("🗺")?C.accent:C.muted,
              borderRadius:14, padding:"4px 10px",
              fontSize:8, fontFamily:C.fnt, cursor:"pointer", whiteSpace:"nowrap" }}>
            {q}
          </div>
        ))}
      </div>

      {/* Zone de saisie */}
      <div style={{ display:"flex", gap:8, padding:"7px 14px 13px",
        borderTop:`1px solid ${C.border}`, flexShrink:0 }}>
        <input value={input} onChange={e=>setInput(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&sendText(input)}
          placeholder={t("ai.placeholder")}
          style={{ flex:1, background:"rgba(255,255,255,0.03)",
            border:`1px solid ${C.border}`, borderRadius:5,
            padding:"9px 11px", color:C.text, fontSize:10,
            fontFamily:C.fnt, outline:"none" }}/>
        <div onPointerDown={()=>sendText(input)} style={{
          background:busy?"rgba(255,255,255,0.04)":C.accentBg,
          border:`1px solid ${busy?C.border:C.accent}`,
          color:busy?C.muted:C.accent,
          borderRadius:5, padding:"9px 16px",
          fontSize:11, fontFamily:C.fnt, fontWeight:700,
          cursor:busy?"not-allowed":"pointer" }}>▶</div>
      </div>
    </div>
  );
}

export default AIScreen;
