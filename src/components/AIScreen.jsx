import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { t, useI18n } from "../i18n.js";
import { TRANSIT_STOPS } from "../constants.js";
import { fDist, bTag, getHistory, launchNativeArNav } from "../utils.js";
import { fetchWeather, getWeatherAdvice } from "../hooks/useWeather.js";
import { useTransit, formatDeparturesForAI } from "../hooks/useTransit.js";
import { loadModel, generate } from "../ai/localModel.js";
import { Icon } from "../ui/icons.jsx";
import { Badge, IconButton, ProgressBar, Spinner, Button } from "../ui/primitives.jsx";
import { wmo, bikeScore, scoreTone, reasonLabel } from "../ui/weather.js";
import { fmtDist, stationView, cardinal } from "../ui/format.js";

// ── Détection balise NAV dans la réponse IA ───────────────────────
// L'assistant répond [NAV:lat,lng,nom,mode] pour lancer l'AR navigation
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

const approxDist = (a, b) => Math.sqrt((a.lat - b.lat) ** 2 + (a.lng - b.lng) ** 2) * 111000;

// Prochain départ de bus parmi les arrêts proches (données useTransit)
function nextBus(stops, deps) {
  for (const s of stops || []) {
    const d = deps?.[s.id]?.find(x => !x.cancelled);
    if (d) return { stop: s.name, line: d.line, dir: d.direction, time: d.rtTime || d.time, late: !!d.rtTime && d.rtTime !== d.time };
  }
  return null;
}

// ── Carte de contexte (météo / station / bus) ──────────────────────
function Ctx({ icon, iconColor, label, children }) {
  return (
    <div className="vn-ctx">
      <div className="vn-ctx__label"><span style={{ color: iconColor, display: "flex" }}><Icon name={icon} size={13} stroke={2}/></span>{label}</div>
      {children}
    </div>
  );
}

// ── Composant principal ────────────────────────────────────────────
function AIScreen({ stations, aiHistory, setAiHistory,
                    aiDisplay, setAiDisplay, gpsPos=null,
                    mapsKey="", hafasKey="", onLaunchAR=null,
                    weather: weatherProp, transitStops, transitDepartures }) {
  const { lang } = useI18n();
  const [input,    setInput]    = useState("");
  const [busy,     setBusy]     = useState(false);
  const [localWeather, setLocalWeather] = useState(null);
  // Transit : partagé par App si fourni (évite un 2e polling HAFAS), sinon hook local
  const local = useTransit(gpsPos, transitStops ? "" : hafasKey);
  const busStops = transitStops ?? local.stops;
  const busDeps  = transitDepartures ?? local.departures;
  const weather = weatherProp !== undefined ? weatherProp : localWeather;
  const [forecast, setForecast] = useState(null); // prévisions 3h
  const [modelState, setModelState] = useState("loading"); // loading | ready | error
  const [modelProgress, setModelProgress] = useState(0);
  const [loadSeq, setLoadSeq] = useState(0); // incrémenté par « Réessayer »
  const endRef = useRef();
  const inputRef = useRef();

  useEffect(()=>endRef.current?.scrollIntoView({behavior:"smooth", block:"end"}),[aiDisplay, busy]);

  // ── Préchargement du modèle IA local (en arrière-plan, relançable) ──
  useEffect(()=>{
    let dead = false;
    setModelState("loading");
    loadModel((pct)=>{ if(!dead) setModelProgress(pct); })
      .then(()=>{ if(!dead) setModelState("ready"); })
      .catch(()=>{ if(!dead) setModelState("error"); });
    return ()=>{ dead = true; };
  },[loadSeq]);

  // ── Fetch météo (si non fournie par App) + prévisions 3h ─────────
  useEffect(()=>{
    if (!gpsPos) return;
    let dead = false;
    (async()=>{
      if (weatherProp === undefined) {
        const w = await fetchWeather(gpsPos.lat, gpsPos.lng);
        if (!dead) setLocalWeather(w);
      }
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpsPos?.lat ? Math.round(gpsPos.lat*100) : null,
      gpsPos?.lng ? Math.round(gpsPos.lng*100) : null]);

  const score  = bikeScore(weather);
  const advice = getWeatherAdvice(weather);
  const nearest = useMemo(()=>stations.find(s=>s.bikes>0 && s.status!=="CLOSED") ?? null,[stations]);
  const bus = useMemo(()=>nextBus(busStops, busDeps),[busStops, busDeps]);

  // ── Message d'accueil proactif (localisé, sans emoji) ─────────────
  const initMsg = useMemo(()=>{
    const avail = stations.filter(s=>s.bikes>0).length;
    const lines = [];
    if (weather) {
      lines.push(t("ui.ai.welcome_wx", { label: wmo(weather.code).label, temp: weather.temp, wind: weather.wind, score }));
      const rainSoon = forecast?.find(f=> f.rainProb > 50 || f.rain > 0.5);
      if (rainSoon) lines.push(t("ui.ai.welcome_rain", { h: rainSoon.h, p: rainSoon.rainProb }));
      if (advice.mode === "transit") {
        lines.push(t("ui.ai.welcome_transit", { reason: reasonLabel(advice.reason) }));
        const near = gpsPos ? TRANSIT_STOPS.filter(s=>approxDist(s, gpsPos) < 800).slice(0,2).map(s=>s.name) : [];
        if (near.length) lines.push(t("ui.ai.welcome_stops", { stops: near.join(", ") }));
      }
    }
    lines.push(nearest
      ? t("ui.ai.welcome", { avail, total: stations.length, name: nearest.name, dist: fmtDist(nearest.dist),
          bikes: nearest.bikes, elec: stationView(nearest).elec })
      : t("map.loading"));
    return lines.join("\n");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stations, weather, forecast, gpsPos, lang]);

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
      ? TRANSIT_STOPS.filter(s=>approxDist(s, gpsPos) < 600).map(s=>{
          const d = Math.round(approxDist(s, gpsPos));
          return `${s.name} (${d}m${s.hub?" — hub":""}${s.veloh?" 🚲":""})`;
        })
      : [];
    const tramNear = nearTram.length ? `\nArrêts tram T1 proches : ${nearTram.join(", ")}.` : "";

    // Météo
    const meteoTxt = weather
      ? `\nMÉTÉO ACTUELLE : ${wmo(weather.code).label} | ${weather.temp}°C | Pluie: ${weather.rain}mm/h | Vent: ${weather.wind}km/h ${cardinal(weather.windDir)} | Score vélo: ${score}/10`
      : "\nMétéo : données non disponibles.";

    const fcTxt = forecast?.length
      ? `\nPRÉVISIONS : ${forecast.map(f=>`+${f.h}h: ${f.temp}°C, pluie ${f.rain}mm (${f.rainProb}% proba), vent ${f.wind}km/h`).join(" | ")}`
      : "";

    // Position GPS
    const gpsTxt = gpsPos
      ? `\nPosition GPS : ${gpsPos.lat.toFixed(5)}, ${gpsPos.lng.toFixed(5)}`
      : "";

    // Bus RGTR temps réel — arrêts proches avec départs live
    let busTxt = "";
    if (hafasKey && busStops.length > 0) {
      busTxt = busStops.slice(0, 2).map(stop => {
        const deps = busDeps[stop.id];
        return deps?.length ? formatDeparturesForAI(stop.name, deps) : "";
      }).filter(Boolean).join("");
      if (!busTxt) busTxt = `\n(Arrêts proches détectés : ${busStops.slice(0,3).map(s=>s.name).join(", ")} — départs en cours de chargement)`;
    } else if (!hafasKey) {
      busTxt = `\n(Aucune clé HAFAS ATP configurée — l'utilisateur peut en demander une gratuitement à opendata-api@verkeiersverbond.lu et l'ajouter dans Réglages pour voir les bus RGTR temps réel.)`;
    }

    return `Tu es VELOH·AI, assistant mobilité VelohNav pour Luxembourg.
${t("ui.ai.sys_lang")}
${meteoTxt}${fcTxt}${gpsTxt}

STATIONS VEL'OH (par distance) :
${stations.map(s=>`• ${s.name} | ${s.bikes}🚲 (⚡${s.elec}élec 🔧${s.meca}méca) | ${s.docks} docks | ${fDist(s.dist)} | ${bTag(s)}`).join("\n")}${histTxt}${tramNear}

TRAM T1 — Findel/Aéroport ↔ Gasperich/Stadion (24 arrêts, 16km, GRATUIT) :
Horaires : 04h20→00h06 tous les jours
Fréquence : 3-4 min (LuxExpo↔Bouneweg) | 8 min (extrémités) | 15 min heures creuses
Hubs : Luxexpo, Rout Bréck/Pafendall (funiculaire+CFL), Place de l'Étoile, Hamilius, Gare Centrale (CFL), Howald (CFL), Cloche d'Or, Gasperich/Stadion
${busTxt ? `\n🚌 BUS RGTR — départs temps réel aux arrêts proches :${busTxt}\n(Les transports publics au Luxembourg sont GRATUITS depuis 2020 pour tous.)` : ""}

NAVIGATION AR : Si l'utilisateur demande à être guidé vers une destination (station Vel'OH, arrêt tram, lieu),
tu DOIS terminer ta réponse par une balise de navigation :
[NAV:latitude,longitude,NomDestination,mode]
Exemples :
  → guider vers station Hamilius en vélo : [NAV:49.6118,6.1299,Hamilius Vel'OH,bicycling]
  → guider vers Gare Centrale à pied : [NAV:49.5998,6.1340,Gare Centrale,walking]
  → guider vers Luxexpo en vélo : [NAV:49.6267,6.1651,Luxexpo,bicycling]
N'utilise cette balise QUE si l'utilisateur veut explicitement être guidé/naviguer/aller quelque part.
Ne l'utilise pas pour de simples informations ou conseils.`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[stations, weather, forecast, gpsPos, busStops, busDeps, hafasKey, lang]);

  // ── Envoi message + parsing réponse AR ───────────────────────────
  const sendText = useCallback(async(text)=>{
    const q = (text||input).trim();
    if (!q || busy) return;
    setInput(""); setBusy(true);
    setAiDisplay(d=>[...d,{role:"user",text:q}]);
    const hist = [...aiHistory,{role:"user",content:q}].slice(-20);
    try {
      const raw   = await generate(systemPrompt, hist); // IA locale, zéro réseau
      const nav   = parseNavCommand(raw);
      const reply = stripNavTag(raw);
      setAiHistory([...hist,{role:"assistant",content:raw}]);
      setAiDisplay(d=>[...d,{role:"ai",text:reply, nav}]);
    } catch(e) {
      const msg = modelState==="error"
        ? t("ai.model_error").replace(/^⚠\s*/, "")
        : t("ui.ai.err.gen", { msg: e?.message ?? t("ui.ai.err.unknown") });
      setAiDisplay(d=>[...d,{role:"ai",text:msg, error:true}]);
    }
    setBusy(false);
  },[input,busy,aiHistory,systemPrompt,modelState,setAiHistory,setAiDisplay]);

  // ── Lancer la nav AR depuis le bouton ─────────────────────────────
  const [launching, setLaunching] = useState(false);
  const [navError, setNavError] = useState(null);

  const launchNav = useCallback(async(nav)=>{
    if (!nav || launching) return;
    setLaunching(true);
    setNavError(null);
    try {
      let ok;
      if (onLaunchAR) ok = await onLaunchAR(nav);
      else ok = await launchNativeArNav(nav.lat, nav.lng, nav.name, nav.mode, mapsKey);
      if (ok === false) setNavError(t("ui.ai.nav.error"));
    } catch(e) {
      const msg = e?.message || String(e);
      console.error("[AIScreen] launchNav error:", msg);
      setNavError(msg);
    }
    setLaunching(false);
  },[mapsKey, onLaunchAR, launching]);

  // ── Questions rapides contextuelles ──────────────────────────────
  const QUICK = useMemo(()=>{
    const out = [];
    const near = stations.find(s=>s.bikes>0 && s.dist < 500);
    if (near) out.push({ icon:"ar", text:t("ui.ai.q.guide", { name:near.name }), accent:true });
    out.push({ icon:"pin", text:t("ui.ai.q.nearest") });
    out.push({ icon:"ebike", text:t("ui.ai.q.elec") });
    if (weather && score !== null) out.push(score < 5
      ? { icon:"tram", text:t("ui.ai.q.tram") }
      : { icon:"wind", text:t("ui.ai.q.weather") });
    if (hafasKey) out.push({ icon:"bus", text:t("ui.ai.q.bus") });
    out.push({ icon:"dock", text:t("ui.ai.q.dock") });
    return out.slice(0,5);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[weather, score, stations, hafasKey, lang]);

  const w = weather ? wmo(weather.code) : null;
  const nv = nearest ? stationView(nearest) : null;
  const canSend = !!input.trim() && !busy;

  // ── Rendu ─────────────────────────────────────────────────────────
  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", minHeight:0 }}>

      {/* État du modèle */}
      <div className="vn-model" data-state={modelState} role="status">
        <span className="vn-model__icon">
          {modelState==="loading" ? <Spinner size={14}/> : <Icon name={modelState==="error" ? "alert" : "cpu"} size={14} stroke={2}/>}
        </span>
        <span className="vn-model__text">
          {modelState==="loading" ? t("ui.ai.model.loading", { pct:modelProgress })
            : modelState==="error" ? t("ui.ai.model.error")
            : t("ui.ai.model.ready")}
        </span>
        {modelState==="ready" && <span className="vn-model__aside">{t("ui.ai.model.private")}</span>}
        {modelState==="error" && (
          <Button size="sm" variant="secondary" icon="refresh" style={{ marginLeft:"auto" }}
            onClick={()=>setLoadSeq(n=>n+1)}>{t("ui.ai.model.retry")}</Button>
        )}
        {modelState==="loading" && (
          <div style={{ position:"absolute", left:0, right:0, bottom:-1 }}>
            <ProgressBar value={modelProgress} indeterminate={modelProgress===0} label={t("ui.ai.model.loading", { pct:modelProgress })}/>
          </div>
        )}
      </div>

      {/* Contexte : météo · station la plus proche · prochain bus */}
      <div className="vn-ctxrow">
        <Ctx icon={w?.icon ?? "cloud"} label={t("ui.ai.ctx.weather")}>
          {weather ? (
            <>
              <div className="vn-ctx__value vn-num">{weather.temp}°
                <Badge tone={scoreTone(score)} style={{ marginLeft:6 }}>{score}/10</Badge></div>
              <div className="vn-ctx__sub vn-num">
                <Icon name="navigation" size={11} stroke={2} style={{ transform:`rotate(${((weather.windDir ?? 0)+180)%360}deg)`, display:"inline", verticalAlign:"-1px" }}/>
                {" "}{weather.wind} km/h{forecast?.some(f=>f.rainProb>50) ? ` · ${Math.max(...forecast.map(f=>f.rainProb))} %` : ""}
              </div>
            </>
          ) : <div className="vn-ctx__sub">—</div>}
        </Ctx>
        <Ctx icon="bike" iconColor="var(--vn-good)" label={t("ui.ai.ctx.nearest")}>
          {nv ? (
            <>
              <div className="vn-ctx__value vn-num">{nv.bikes}
                <span style={{ color:"var(--vn-elec)", fontSize:13, marginLeft:6 }}><Icon name="bolt" size={12} stroke={2} style={{ display:"inline", verticalAlign:"-1px" }}/>{nv.elec}</span>
              </div>
              <div className="vn-ctx__sub" title={nv.name}>{nv.name} · {fmtDist(nv.dist)}</div>
            </>
          ) : <div className="vn-ctx__sub">—</div>}
        </Ctx>
        <Ctx icon="bus" iconColor="var(--vn-transit)" label={t("ui.ai.ctx.bus")}>
          {bus ? (
            <>
              <div className="vn-ctx__value vn-num">{bus.time}
                <span style={{ fontSize:12, color:"var(--vn-transit)", marginLeft:6, fontWeight:700 }}>{bus.line}</span></div>
              <div className="vn-ctx__sub" title={bus.dir}>{bus.dir}</div>
            </>
          ) : <div className="vn-ctx__sub" style={{ marginTop:4 }}>{hafasKey ? "—" : t("ui.ai.ctx.no_bus")}</div>}
        </Ctx>
      </div>

      {/* Conversation */}
      <div className="vn-thread vn-scroll" role="log" aria-live="polite" aria-label={t("ui.screen.ai")}>
        {aiDisplay.map((m,i)=>(
          <div key={i} className={`vn-msg vn-msg--${m.role}`} data-error={m.error || undefined}>
            {m.role==="ai" && <span className="vn-msg__avatar" aria-hidden="true"><Icon name={m.error ? "alert" : "ai"} size={14} stroke={2}/></span>}
            <div className="vn-msg__bubble">
              <span className="vn-sr">{m.role==="user" ? t("ui.ai.you") : "VELOH·AI"} : </span>
              {m.text}
              {/* Action AR inline dans le message */}
              {m.nav && (
                <button type="button" className="vn-navcard" onClick={()=>launchNav(m.nav)}
                  aria-busy={launching || undefined} disabled={launching}>
                  <span className="vn-navcard__icon">{launching ? <Spinner size={16}/> : <Icon name="ar" size={18}/>}</span>
                  <span style={{ flex:1, minWidth:0, textAlign:"left" }}>
                    <span style={{ display:"block", fontWeight:600, color: navError ? "var(--vn-bad)" : "var(--vn-text)" }}>
                      {launching ? t("ui.ai.nav.opening") : navError ? t("ui.ai.nav.error") : t("ui.ai.nav.open")}
                    </span>
                    <span style={{ display:"block", fontSize:12, color:"var(--vn-text2)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                      {navError ? navError : `${m.nav.name} · ${m.nav.mode==="walking" ? t("ui.ai.nav.mode_walk") : t("ui.ai.nav.mode_bike")}`}
                    </span>
                  </span>
                  <Icon name="arrowRight" size={16}/>
                </button>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="vn-msg vn-msg--ai">
            <span className="vn-msg__avatar" aria-hidden="true"><Icon name="ai" size={14} stroke={2}/></span>
            <div className="vn-msg__bubble vn-typing" aria-label={t("ui.ai.thinking")}>
              <span/><span/><span/>
            </div>
          </div>
        )}
        <div ref={endRef}/>
      </div>

      {/* Questions suggérées */}
      <div className="vn-suggest vn-scroll" role="group" aria-label={t("ui.ai.suggest")}>
        {QUICK.map(q=>(
          <button key={q.text} type="button" className="vn-chip" disabled={busy}
            style={q.accent ? { borderColor:"rgba(245,130,13,0.45)", color:"var(--vn-text)" } : undefined}
            onClick={()=>sendText(q.text)}>
            <Icon name={q.icon} size={15} style={q.accent ? { color:"var(--vn-accent)" } : undefined}/>
            <span>{q.text}</span>
          </button>
        ))}
      </div>

      {/* Saisie fixée en bas */}
      <form className="vn-composer" onSubmit={e=>{ e.preventDefault(); sendText(input); }}>
        <input ref={inputRef} className="vn-input" value={input} onChange={e=>setInput(e.target.value)}
          placeholder={t("ui.ai.placeholder")} aria-label={t("ui.ai.placeholder")}
          enterKeyHint="send" autoComplete="off"/>
        <IconButton type="submit" icon="send" label={t("ui.ai.send")} variant="accent"
          disabled={!canSend} loading={busy}/>
      </form>
    </div>
  );
}

export default AIScreen;
