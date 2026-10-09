import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { t, tn, useI18n } from "../i18n.js";
import { TRAM, nextDepartures, shortStopName } from "../utils/tram.js";
import { fDist, bTag, getHistory, launchNativeArNav } from "../utils.js";
import { fetchWeather, getWeatherAdvice } from "../hooks/useWeather.js";
import { formatDeparturesForAI } from "../hooks/useTransit.js";
import { loadModel, unloadModel, generate, chatModelMB } from "../ai/localModel.js";
import { Icon } from "../ui/icons.jsx";
import { IconButton, ProgressBar, Spinner, Button } from "../ui/primitives.jsx";
import { wmo, bikeScore, scoreTone, reasonLabel } from "../ui/weather.js";
import { fmtDist, stationView, cardinal } from "../ui/format.js";
import { answerLocally as localAnswer, upcoming, approxDist } from "../ai/localAnswers.js";

// ── Détection balise NAV dans la réponse IA ───────────────────────
// L'assistant répond [NAV:lat,lng,nom,mode] pour lancer l'AR navigation.
// Ce chemin ne sert plus qu'à la conversation libre : le guidage courant passe
// par le bouton de la carte station, sans modèle.
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

// Échec du modèle → phrase explicite (cause + quoi faire), suivie du détail technique.
function describeModelError(e) {
  if (!e?.code) return e?.message || String(e);
  const msg = t(`ui.ai.model.fail.${e.code}`, { s: e.seconds, mb: e.mb, need: e.needMB, avail: e.availMB });
  // Refus mémoire : la phrase dit tout, le code interne (insufficient…) n'aide personne
  if (e.code === "memory") return msg;
  return e.detail && !/^timeout /.test(e.detail) ? `${msg} (${e.detail})` : msg;
}

// Taille réelle du modèle conversationnel, annoncée AVANT tout téléchargement :
// rien ne part sans que l'utilisateur l'ait décidé.
// Taille annoncée : celle de la variante que l'appareil sait réellement faire tourner
// (255 Mo avec WebGPU, 294 Mo sinon) — voir chatModelMB().

// ── Composant principal ────────────────────────────────────────────
function AIScreen({ stations, aiHistory, setAiHistory,
                    aiDisplay, setAiDisplay, gpsPos=null,
                    mapsKey="", onLaunchAR=null,
                    weather: weatherProp, transitStops=[], transitDepartures={} }) {
  const { lang } = useI18n();
  const [input,    setInput]    = useState("");
  const [busy,     setBusy]     = useState(false);
  const [localWeather, setLocalWeather] = useState(null);
  // Arrêts + départs Transitous fournis par App (un seul polling partagé, sans clé)
  const busStops = transitStops, busDeps = transitDepartures;
  const weather = weatherProp !== undefined ? weatherProp : localWeather;
  const [forecast, setForecast] = useState(null);        // prévisions 3 h
  const [modelState, setModelState] = useState("off");   // off | loading | ready | error
  const [modelProgress, setModelProgress] = useState(0);
  const [modelError, setModelError] = useState("");   // message réel, affiché en cas d'échec
  const [modelPhase, setModelPhase] = useState(null);  // { phase: download|init, device }
  const [loadSeq, setLoadSeq] = useState(0);             // incrémenté par « Réessayer »
  // La conversation libre est DÉSACTIVÉE par défaut : le modèle pèse ~300 Mo,
  // il n'est téléchargé que sur demande explicite. Sans lui, l'écran reste utile :
  // tout ce qui est factuel est calculé sur l'appareil, exactement.
  const [chatOn, setChatOn] = useState(false);
  const endRef = useRef();
  const inputRef = useRef();

  // Corps à accolades OBLIGATOIRE : en flèche concise, l'effet retourne la valeur de
  // scrollIntoView. Sur la WebView Android celle-ci est une promesse — React la stocke
  // comme fonction de nettoyage, l'appelle au démontage, et lève
  // « TypeError: t is not a function » (constaté en production, composant identifié).
  useEffect(()=>{ endRef.current?.scrollIntoView({behavior:"smooth", block:"end"}); },[aiDisplay, busy]);

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

  // Mémoïsés : sinon ces objets changent à chaque rendu et invalident les callbacks.
  const score  = useMemo(()=>bikeScore(weather), [weather]);
  const advice = useMemo(()=>getWeatherAdvice(weather), [weather]);
  const nearest = useMemo(()=>stations.find(s=>s.bikes>0 && s.status!=="CLOSED") ?? null,[stations]);
  // Pour rendre un vélo il faut des bornes libres : ce n'est pas forcément la même station.
  const nearestReturn = useMemo(()=>stations.find(s=>s.docks>0 && s.status!=="CLOSED") ?? null,[stations]);
  const deps = useMemo(()=>upcoming(busStops, busDeps, 3),[busStops, busDeps]);

  // ── Modèle : chargé UNIQUEMENT si la conversation libre est activée ──
  useEffect(()=>{
    if (!chatOn) return;                 // rien n'est téléchargé sans décision de l'utilisateur
    let dead = false;
    setModelState("loading");
    setModelPhase(null);
    loadModel((pct)=>{ if(!dead) setModelProgress(pct); },
              (p)=>{ if(!dead) setModelPhase(p); })
      .then(()=>{ if(!dead) setModelState("ready"); })
      .catch((e)=>{
        if(!dead && e?.code !== "cancelled"){
          setModelState("error");
          setModelError(describeModelError(e));   // sinon l'utilisateur ne peut que constater l'échec
        }
      });
    // Conversation désactivée, « Réessayer » ou écran quitté : le worker est
    // arrêté et la mémoire rendue (chargement en cours compris). Avant, il
    // survivait à tout — y compris au retour de l'interrupteur sur « arrêté » au
    // remontage de l'écran — avec plus d'1 Go résident.
    return ()=>{ dead = true; unloadModel(); };
  },[chatOn, loadSeq]);
  useEffect(()=>{ if (!chatOn) setModelState("off"); },[chatOn]);

  // ── Message d'accueil proactif (localisé, sans emoji) ─────────────
  const initMsg = useMemo(()=>{
    const lines = [];
    if (weather) {
      lines.push(t("ui.ai.welcome_wx", { label: wmo(weather.code).label, temp: weather.temp, wind: weather.wind, score }));
      const rainSoon = forecast?.find(f=> f.rainProb > 50 || f.rain > 0.5);
      if (rainSoon) lines.push(t("ui.ai.welcome_rain", { h: rainSoon.h, p: rainSoon.rainProb }));
    }
    lines.push(nearest
      ? t("ui.ai.welcome", { avail: stations.filter(s=>s.bikes>0).length, total: stations.length,
          name: nearest.name, dist: fmtDist(nearest.dist),
          bikes: tn("ui.ai.unit.bike", nearest.bikes),
          elec: tn("ui.ai.unit.elec", stationView(nearest).elec) })
      : t("map.loading"));
    return lines.join("\n");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stations, weather, forecast, gpsPos, lang]);

  useEffect(()=>{
    if (aiDisplay.length === 0 && aiHistory.length === 0)
      setAiDisplay([{ role:"ai", text:initMsg, local:true }]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initMsg]);

  // ── Système prompt (uniquement pour la conversation libre) ────────
  const systemPrompt = useMemo(()=>{
    const hist = getHistory().slice(0,5);
    const histTxt = hist.length
      ? `\nStations récemment visitées : ${hist.map(h=>h.name).join(", ")}.`
      : "";

    // Arrêts T1 proches + prochains départs théoriques (horaire GTFS embarqué)
    const nearTram = gpsPos
      ? TRAM.stops.filter(s=>approxDist(s, gpsPos) < 600).map(s=>{
          const d = Math.round(approxDist(s, gpsPos));
          const { dirs } = nextDepartures(s.idx, new Date(), { limit: 2 });
          const deps = [...dirs[0], ...dirs[1]].map(x=>`${shortStopName(x.headsign)} ${x.time}`).join(", ");
          return `${s.name} (${d}m${deps ? ` — ${deps}` : ""})`;
        })
      : [];
    const tramNear = nearTram.length ? `\nArrêts tram T1 proches (départs selon l'horaire) : ${nearTram.join(" ; ")}.` : "";

    const meteoTxt = weather
      ? `\nMÉTÉO ACTUELLE : ${wmo(weather.code).label} | ${weather.temp}°C | Pluie: ${weather.rain}mm/h | Vent: ${weather.wind}km/h ${cardinal(weather.windDir)} | Score vélo: ${score}/10`
      : "\nMétéo : données non disponibles.";

    const fcTxt = forecast?.length
      ? `\nPRÉVISIONS : ${forecast.map(f=>`+${f.h}h: ${f.temp}°C, pluie ${f.rain}mm (${f.rainProb}% proba), vent ${f.wind}km/h`).join(" | ")}`
      : "";

    const gpsTxt = gpsPos
      ? `\nPosition GPS : ${gpsPos.lat.toFixed(5)}, ${gpsPos.lng.toFixed(5)}`
      : "";

    let busTxt = "";
    if (busStops.length > 0) {
      busTxt = busStops.slice(0, 2).map(stop => {
        const d = busDeps[stop.id];
        return d?.length ? formatDeparturesForAI(stop.name, d) : "";
      }).filter(Boolean).join("");
      if (!busTxt) busTxt = `\n(Arrêts proches détectés : ${busStops.slice(0,3).map(s=>s.name).join(", ")} — départs en cours de chargement)`;
    } else {
      busTxt = `\n(Aucun arrêt de bus/tram détecté à proximité pour l'instant.)`;
    }

    return `Tu es VELOH·AI, assistant mobilité VelohNav pour Luxembourg.
${t("ui.ai.sys_lang")}
${meteoTxt}${fcTxt}${gpsTxt}

STATIONS VEL'OH (par distance) :
${stations.map(s=>`• ${s.name} | ${s.bikes}🚲 (⚡${s.elec}élec 🔧${s.meca}méca) | ${s.docks} docks | ${fDist(s.dist)} | ${bTag(s)}`).join("\n")}${histTxt}${tramNear}

TRAM T1 — Findel/Aéroport ↔ Gasperich/Stadion (24 arrêts, 16km, GRATUIT) :
Arrêts : ${TRAM.stops.map(s=>shortStopName(s.name)).join(" · ")}
Correspondances train : Rout Bréck-Pafendall (funiculaire), Gare Centrale, Howald
${busTxt ? `\n🚌 BUS RGTR — départs temps réel aux arrêts proches :${busTxt}\n(Les transports publics au Luxembourg sont GRATUITS depuis 2020 pour tous.)` : ""}

NAVIGATION AR : Si l'utilisateur demande à être guidé vers une destination (station Vel'OH, arrêt tram, lieu),
tu DOIS terminer ta réponse par une balise de navigation :
[NAV:latitude,longitude,NomDestination,mode]
Exemples :
  → guider vers station Hamilius en vélo : [NAV:49.6118,6.1299,Hamilius Vel'OH,bicycling]
  → guider vers Gare Centrale à pied : [NAV:49.5998,6.1340,Gare Centrale,walking]
  → guider vers Luxexpo en vélo : [NAV:49.6354,6.1759,Luxexpo,bicycling]
N'utilise cette balise QUE si l'utilisateur veut explicitement être guidé/naviguer/aller quelque part.
Ne l'utilise pas pour de simples informations ou conseils.`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[stations, weather, forecast, gpsPos, busStops, busDeps, lang]);

  // ── Réponses locales : la logique vit dans src/ai/localAnswers.js (module pur, testé) ──
  const answerLocally = useCallback(
    q => localAnswer(q, { stations, nearest, nearestReturn, deps, weather, forecast, advice, score, gpsPos, t, tn }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stations, nearest, nearestReturn, deps, weather, forecast, advice, score, gpsPos, lang]);

  // ── Envoi : réponse locale d'abord, modèle seulement si activé ────
  const sendText = useCallback(async(text)=>{
    const q = (text||input).trim();
    if (!q || busy) return;
    setInput("");
    setAiDisplay(d=>[...d,{role:"user",text:q}]);

    // Réponse locale d'abord, TOUJOURS : un compteur de vélos ou un horaire de bus
    // ne doit jamais passer par un modèle, même quand la conversation est activée.
    // Le modèle n'est sollicité que pour une question libre, et seulement s'il est prêt.
    const local = answerLocally(q);
    const askModel = chatOn && modelState === "ready" && local.unknown === true;
    if (!askModel) {
      setAiDisplay(d=>[...d,{role:"ai",text:local.text,nav:local.nav,local:true}]);
      return;
    }

    setBusy(true);
    const hist = [...aiHistory,{role:"user",content:q}].slice(-20);
    try {
      const raw   = await generate(systemPrompt, hist); // IA locale, zéro réseau
      const nav   = parseNavCommand(raw);
      const reply = stripNavTag(raw);
      setAiHistory([...hist,{role:"assistant",content:raw}]);
      setAiDisplay(d=>[...d,{role:"ai",text:reply, nav}]);
    } catch(e) {
      if (e?.code === "generate_timeout") {   // worker arrêté : le dire, plutôt qu'un « prêt » mensonger
        setModelState("error");
        setModelError(describeModelError(e));
      }
      const msg = e?.code ? describeModelError(e)
        : modelState==="error"
        ? t("ai.model_error").replace(/^⚠\s*/, "")
        : t("ui.ai.err.gen", { msg: e?.message ?? t("ui.ai.err.unknown") });
      setAiDisplay(d=>[...d,{role:"ai",text:msg, error:true}]);
    }
    setBusy(false);
  },[input,busy,aiHistory,systemPrompt,modelState,chatOn,answerLocally,setAiHistory,setAiDisplay]);

  // ── Lancer la nav AR (bouton de la carte station, sans modèle) ────
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

  // ── Questions rapides : toutes répondables sans modèle ───────────
  const QUICK = useMemo(()=>{
    const out = [{ icon:"bike", text:t("ui.ai.q.can_bike") },
                 { icon:"pin",  text:t("ui.ai.q.nearest") }];
    if (weather && score !== null) out.push(score < 5
      ? { icon:"tram", text:t("ui.ai.q.tram") }
      : { icon:"wind", text:t("ui.ai.q.weather") });
    if (busStops.length) out.push({ icon:"bus", text:t("ui.ai.q.bus") });
    out.push({ icon:"dock", text:t("ui.ai.q.dock") });
    return out.slice(0,5);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[weather, score, busStops.length, lang]);

  const nv = nearest ? stationView(nearest) : null;
  const canSend = !!input.trim() && !busy;
  const verdictOk = advice.mode !== "transit";
  const maxDocks = nearest ? Math.max(1, (nearest.bikes || 0) + (nearest.docks || 0)) : 1;
  const nextRain = forecast?.find(f=> f.rainProb > 50 || f.rain > 0.5);   // même seuil que l'accueil

  // ── Rendu ─────────────────────────────────────────────────────────
  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", minHeight:0 }}>
      <div className="vn-thread vn-scroll" role="log" aria-live="polite" aria-label={t("ui.screen.ai")}>

        {/* Les cartes se rafraîchissent seules (départs, météo) : hors région live,
            sinon un lecteur d'écran annonce chaque mise à jour du polling. */}
        <div className="vn-cards" aria-live="off">

        {/* Verdict immédiat — calculé sur l'appareil */}
        <section className={`vn-dcard ${verdictOk ? "vn-dcard--ok" : "vn-dcard--warn"}`}>
          <div className="vn-dcard__head">
            <span className="vn-dcard__flash"><Icon name={verdictOk ? "bolt" : "tram"} size={17} stroke={2}/></span>
            <strong className="vn-dcard__title">
              {weather ? (verdictOk ? t("ui.ai.verdict.ok") : t("ui.ai.verdict.no")) : t("ui.ai.verdict.unknown")}
            </strong>
          </div>
          <div className="vn-dcard__why">
            {weather && advice.reason
              ? t("ui.ai.verdict.why", { reason: reasonLabel(advice.reason) })
              : t("ui.ai.verdict.local")}
            {nextRain ? " " + t("ui.ai.verdict.rain", { h: nextRain.h }) : ""}
          </div>
          {weather && (
            <div className="vn-metrics">
              <span className="vn-metric vn-num">{weather.temp} °C</span>
              <span className="vn-metric vn-metric--elec vn-num">{weather.rain} mm/h</span>
              <span className="vn-metric vn-num">{weather.wind} km/h{weather.windDir != null ? " " + cardinal(weather.windDir) : ""}</span>
              <span className={`vn-metric vn-num ${scoreTone(score)==="good" ? "vn-metric--good" : scoreTone(score)==="bad" ? "vn-metric--bad" : ""}`}>{score}/10</span>
            </div>
          )}
        </section>

        {/* Station la plus proche + navigation en un geste */}
        <section className="vn-dcard">
          <div className="vn-dcard__label">{t("ui.ai.card.nearest")}</div>
          {nv ? (
            <>
              <div className="vn-dcard__row">
                <div className="vn-ellipsis" style={{ fontSize:14.5, fontWeight:600 }}>{nv.name}</div>
                <div className="vn-num vn-dcard__dist">{fmtDist(nv.dist)}</div>
              </div>
              <div className="vn-counts">
                <div className="vn-count"><span className="vn-num vn-count__n" style={{ color:"var(--vn-elec)" }}>{nv.elec}</span><span className="vn-count__t">{t("ui.ai.card.elec_short")}</span></div>
                <div className="vn-count"><span className="vn-num vn-count__n">{nv.docks}</span><span className="vn-count__t">{t("ui.ai.card.docks_short")}</span></div>
                <div className="vn-count"><span className="vn-num vn-count__n" style={{ color:"var(--vn-good)" }}>{nv.bikes}</span><span className="vn-count__t">{t("ui.ai.card.bikes_short", { total: maxDocks })}</span></div>
              </div>
              <div className="vn-fill" aria-hidden="true">
                <i style={{ background:"var(--vn-elec)", width:`${Math.min(100,(nv.elec/maxDocks*100)).toFixed(1)}%` }}/>
                <i style={{ background:"var(--vn-good)",  width:`${Math.min(100,(Math.max(0,nv.bikes-nv.elec)/maxDocks*100)).toFixed(1)}%` }}/>
              </div>
              <button type="button" className="vn-gobtn" onClick={()=>launchNav({ lat:nearest.lat, lng:nearest.lng, name:nearest.name, mode:"bicycling" })}
                disabled={launching} aria-busy={launching || undefined}>
                {launching ? <Spinner size={15}/> : <Icon name="ar" size={16}/>}
                {launching ? t("ui.ai.nav.opening") : t("ui.ai.nav.button")}
              </button>
              {navError && <div className="vn-dcard__err">{navError}</div>}
            </>
          ) : <div className="vn-dcard__why">{t("ui.ai.ans.no_station")}</div>}
        </section>

        {/* Prochains départs temps réel */}
        <section className="vn-dcard">
          <div className="vn-dcard__label">{t("ui.ai.card.departures")}</div>
          {deps.length ? deps.map((d,i)=>(
            <div key={i} className="vn-dep">
              <span className="vn-dep__line vn-num">{d.line}</span>
              <span style={{ flex:"1 1 auto", minWidth:0 }}>
                <b className="vn-ellipsis" style={{ display:"block", fontSize:12.5, fontWeight:550 }}>{d.dir}</b>
                <span style={{ fontSize:10.5, color:"var(--vn-text3)" }}>{d.stop}{d.dist != null ? ` · ${fmtDist(d.dist)}` : ""}</span>
              </span>
              <span className={`vn-dep__when vn-num ${d.late ? "vn-dep__when--late" : ""}`}>{d.time}</span>
            </div>
          )) : <div className="vn-dcard__why">{t("ui.ai.ans.bus_none")}</div>}
        </section>

        {/* Prévisions */}
        {forecast?.length ? (
          <section className="vn-dcard">
            <div className="vn-dcard__label">{t("ui.ai.card.next_hours")}</div>
            <div className="vn-fc">
              {forecast.map(f=>(
                <div key={f.h}>
                  <div className="vn-fc__h vn-num">+{f.h} h</div>
                  <div className="vn-fc__t vn-num">{f.temp}°</div>
                  <div className="vn-fc__r vn-num">{f.rain} mm</div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        </div>{/* fin des cartes hors région live */}

        {/* Conversation : locale d'abord, modèle seulement si activé */}
        {aiDisplay.map((m,i)=>(
          <div key={i} className={`vn-msg vn-msg--${m.role}`} data-error={m.error || undefined}>
            {m.role==="ai" && <span className="vn-msg__avatar" aria-hidden="true"><Icon name={m.error ? "alert" : "ai"} size={14} stroke={2}/></span>}
            <div className="vn-msg__bubble">
              <span className="vn-sr">{m.role==="user" ? t("ui.ai.you") : "VELOH·AI"} : </span>
              {m.text}
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
            <div className="vn-msg__bubble vn-typing" aria-label={t("ui.ai.thinking")}><span/><span/><span/></div>
          </div>
        )}
        <div ref={endRef}/>
      </div>

      {/* Conversation libre : optionnelle, désactivée par défaut, coût annoncé */}
      <div className="vn-chatopt">
        <button type="button" className="vn-chatopt__switch" role="switch" aria-checked={chatOn}
          aria-label={t("ui.ai.chat.title")} onClick={()=>setChatOn(v=>!v)}>
          <span className="vn-chatopt__knob"/>
        </button>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:12, fontWeight:600 }}>{t("ui.ai.chat.title")}</div>
          <div style={{ fontSize:10.5, color:"var(--vn-text3)", lineHeight:1.45 }}>
            {!chatOn ? t("ui.ai.chat.note", { mb: chatModelMB() })
              : modelState==="loading" && modelPhase?.phase==="init"
                ? t("ui.ai.model.init", { engine: t(`ui.ai.model.engine.${modelPhase.device}`) })
              : modelState==="loading" ? t("ui.ai.model.loading", { pct:modelProgress })
              : modelState==="error"   ? `${t("ui.ai.model.error")}${modelError ? " — " + modelError.slice(0, 220) : ""}`
              : t("ui.ai.model.ready")}
          </div>
        </div>
        {chatOn && modelState==="error" && (
          <Button size="sm" variant="secondary" icon="refresh" onClick={()=>setLoadSeq(n=>n+1)}>{t("ui.ai.model.retry")}</Button>
        )}
        {chatOn && modelState==="loading" && (
          <div style={{ width:64 }}>
            <ProgressBar value={modelProgress} indeterminate={modelProgress===0 || modelPhase?.phase==="init"} label={t("ui.ai.model.loading", { pct:modelProgress })}/>
          </div>
        )}
      </div>

      {/* Suggestions */}
      <div className="vn-suggest vn-scroll" role="group" aria-label={t("ui.ai.suggest")}>
        {QUICK.map(q=>(
          <button key={q.text} type="button" className="vn-chip" disabled={busy} onClick={()=>sendText(q.text)}>
            <Icon name={q.icon} size={15}/>
            <span>{q.text}</span>
          </button>
        ))}
      </div>

      {/* Saisie */}
      <form className="vn-composer" onSubmit={e=>{ e.preventDefault(); sendText(input); }}>
        <input ref={inputRef} className="vn-input" value={input} onChange={e=>setInput(e.target.value)}
          placeholder={chatOn ? t("ui.ai.placeholder") : t("ui.ai.placeholder_local")}
          aria-label={t("ui.ai.placeholder")} enterKeyHint="send" autoComplete="off"/>
        <IconButton type="submit" icon="send" label={t("ui.ai.send")} variant="accent"
          disabled={!canSend} loading={busy}/>
      </form>
    </div>
  );
}

export default AIScreen;
