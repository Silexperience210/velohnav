import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { t, tn, useI18n } from "../i18n.js";
import { launchNativeArNav } from "../utils.js";
import { fetchWeather, getWeatherAdvice } from "../hooks/useWeather.js";
import { loadModel, unloadModel, generateDetailed, warmUp, chatModelMB, modelReport, forgetFailures } from "../ai/localModel.js";
import { gpuSetAside, attemptById } from "../ai/modelPolicy.js";
import { systemPrompt, resolveModelOutput, explainFallback } from "../ai/assistant.js";
import { Icon } from "../ui/icons.jsx";
import { IconButton, ProgressBar, Spinner, Button } from "../ui/primitives.jsx";
import { wmo, bikeScoreDetail, scoreReasons, scoreTone, reasonLabel } from "../ui/weather.js";
import { fmtDist, stationView, cardinal } from "../ui/format.js";
import { answerLocally as localAnswer, upcoming, distLabel } from "../ai/localAnswers.js";

// Conversation libre : le modèle ne voit AUCUNE donnée et n'en rédige aucune. Il
// choisit un outil (tools.js) ; l'application valide l'appel, l'exécute sur ses
// données et écrit la réponse (assistant.js). Le guidage passe par l'outil
// start_navigation (l'ancienne balise [NAV:lat,lng,…] obligeait le modèle à recopier
// des coordonnées). Historique limité aux derniers échanges en texte libre.
const CHAT_TURNS = 6;

// Échec du modèle → phrase explicite (cause + quoi faire), suivie du détail technique.
function describeModelError(e) {
  if (!e?.code) return e?.message || String(e);
  const msg = t(`ui.ai.model.fail.${e.code}`, { s: e.seconds, mb: e.mb, need: e.needMB, avail: e.availMB });
  // Refus mémoire : la phrase dit tout, le code interne (insufficient…) n'aide personne
  if (e.code === "memory") return msg;
  return e.detail && !/^timeout /.test(e.detail) ? `${msg} (${e.detail})` : msg;
}

// « GPU · q4f16, calcul 16 bits » : ce qui tourne, en clair — « · mode compatible » quand le
// GPU tourne sur le device sans subgroups (GPU_PROFILES, modelPolicy.js).
const whereLabel = (engine, dtype, profile = null) => {
  const base = t("ui.ai.model.where", { engine: t(`ui.ai.model.engine.${engine}`), dtype: t(`ui.ai.model.dtype.${dtype}`) });
  return profile === "compat" ? `${base} · ${t("ui.ai.model.profile.compat")}` : base;
};
const attemptLabel = (id) => {
  const a = attemptById(id);
  if (!a) { const [dtype, engine] = String(id).split("/"); return whereLabel(engine, dtype); }
  return whereLabel(a.engine.id, a.variant.dtype, a.profile?.id);
};
// Nom court d'une tentative dans une raison : « q4f16 », « q4 compatible »
const attemptShort = (id) => {
  const a = attemptById(id);
  return a ? t(`ui.ai.model.attempt.${a.profile?.custom ? "compat" : "native"}`, { dtype: a.variant.dtype }) : String(id);
};

// Pourquoi le GPU ne sert pas, en clair (gpuSetAside, modelPolicy.js). Version du
// navigateur jointe à « WebGPU absent » : c'est elle qui décide (WebView du système).
const browserVersion = () => (/(Chrome|Firefox|Version)\/[\d.]+/.exec(globalThis.navigator?.userAgent || "")?.[0] || "?");
const gpuAsideLabel = (aside) => aside.reasons.map(r => t(`ui.ai.model.gpu.${r.kind}`, {
  what: r.ids.map(attemptShort).join(", "),
  detail: r.detail, ua: browserVersion(), mb: aside.downloadMB,
})).join(" ; ");
// Le GPU tel qu'il s'annonce : sans son nom, impossible de relier un échec à un pilote.
const gpuDescribe = (g) => !g.adapter ? t("ui.ai.model.gpu_none") : [
  [g.vendor, g.architecture, g.description].filter(Boolean).join(" ") || "?",
  `f16 ${g.f16 ? "✓" : "✗"}`,
  g.subgroups ? `subgroups ${g.subgroupMin ?? "?"}–${g.subgroupMax ?? "?"}` : t("ui.ai.model.gpu_no_subgroups"),
].join(" · ");

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
  const [modelPhase, setModelPhase] = useState(null);  // { phase: download|init, device, engine, attempt, mb }
  const [modelInfo, setModelInfo] = useState(null);    // modelReport() : tentatives faites
  const gpuAside = useMemo(() => gpuSetAside(modelInfo), [modelInfo]);
  const [modelErrCode, setModelErrCode] = useState(null);
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
      // Prévisions horaires 3h (via OpenMeteo hourly). 5 heures à partir de l'heure en
      // cours : avec 4, « +3 h » (l'heure qui SUIT maintenant + 3 h) manquait presque toujours.
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${gpsPos.lat}&longitude=${gpsPos.lng}`
          + `&hourly=temperature_2m,precipitation_probability,precipitation,wind_speed_10m,weather_code`
          + `&wind_speed_unit=kmh&precipitation_unit=mm&timezone=Europe/Luxembourg&forecast_days=1&forecast_hours=5`;
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
  // La note et le conseil tiennent compte des prévisions : 9,6/10 sous une pluie
  // légère annoncée à 92 % en renforcement dans l'heure était un mauvais conseil.
  const scoreDetail = useMemo(()=>bikeScoreDetail(weather, forecast), [weather, forecast]);
  const score  = scoreDetail?.score ?? null;
  const advice = useMemo(()=>getWeatherAdvice(weather, forecast), [weather, forecast]);
  // Le tri se fait sur la distance : `find` renvoyait la première station de la liste ayant
  // un vélo, donc n'importe laquelle (une station à 19 km au lieu de celle à 150 m).
  const nearest = useMemo(()=>{
    const ok = stations.filter(s=>s.bikes>0 && s.status!=="CLOSED");
    return ok.length ? ok.reduce((a,b)=>((a.dist ?? Infinity)<=(b.dist ?? Infinity)?a:b)) : null;
  },[stations]);
  // Pour rendre un vélo il faut des bornes libres : ce n'est pas forcément la même station.
  // Même correction que `nearest` : la plus proche ayant des bornes libres, pas la première venue.
  const nearestReturn = useMemo(()=>{
    const ok = stations.filter(s=>s.docks>0 && s.status!=="CLOSED");
    return ok.length ? ok.reduce((a,b)=>((a.dist ?? Infinity)<=(b.dist ?? Infinity)?a:b)) : null;
  },[stations]);
  const deps = useMemo(()=>upcoming(busStops, busDeps, 3),[busStops, busDeps]);
  // Journal (logcat) : la station retenue et la position d'où sa distance est calculée,
  // pour vérifier sur l'appareil que la fiche et les départs partent du même point.
  useEffect(()=>{
    if (!nearest) return;
    console.info("[IA] station la plus proche :", nearest.name, fmtDist(nearest.dist), "depuis",
      gpsPos ? `${gpsPos.lat.toFixed(5)},${gpsPos.lng.toFixed(5)} ±${gpsPos.acc ?? "?"} m` : "le centre-ville (pas de GPS)");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[nearest?.id, nearest ? Math.round(nearest.dist / 100) : null, !!gpsPos]);

  // ── Modèle : chargé UNIQUEMENT si la conversation libre est activée ──
  useEffect(()=>{
    if (!chatOn) return;                 // rien n'est téléchargé sans décision de l'utilisateur
    let dead = false;
    setModelState("loading");
    setModelPhase(null);
    setModelErrCode(null);
    // Le passage d'une tentative à la suivante (GPU → processeur) se fait dans
    // loadModel, sans rien demander : seul un échec de TOUTES les voies arrive ici.
    loadModel((pct)=>{ if(!dead) setModelProgress(pct); },
              (p)=>{ if(!dead){ setModelPhase(p); setModelInfo(modelReport()); } })
      .then(()=>{ if(!dead){ setModelState("ready"); setModelInfo(modelReport()); } })
      .catch((e)=>{
        if(!dead && e?.code !== "cancelled"){
          setModelState("error");
          setModelError(describeModelError(e));   // sinon l'utilisateur ne peut que constater l'échec
          setModelErrCode(e?.code || null);
          setModelInfo(modelReport());
        }
      });
    // Conversation désactivée, « Réessayer » ou écran quitté : le worker est
    // arrêté et la mémoire rendue (chargement en cours compris). Avant, il
    // survivait à tout — y compris au retour de l'interrupteur sur « arrêté » au
    // remontage de l'écran — avec plus d'1 Go résident.
    return ()=>{ dead = true; unloadModel(); };
  },[chatOn, loadSeq]);
  useEffect(()=>{ if (!chatOn) setModelState("off"); },[chatOn]);
  // Consigne calculée d'avance (processeur) : la première question ne paie plus ce calcul.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{ if (modelState === "ready") warmUp(systemPrompt(t)); },[modelState, lang]);

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
          name: nearest.name, dist: distLabel({ t, located: !!gpsPos }, nearest.dist),
          bikes: tn("ui.ai.unit.bike", nearest.bikes),
          elec: tn("ui.ai.unit.elec", stationView(nearest).elec) })
      : t("map.loading"));
    return lines.join("\n");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stations, weather, forecast, gpsPos, lang]);

  // L'accueil n'est pas figé : son texte est celui de initMsg au moment du rendu. Figé,
  // il gardait la station calculée au premier affichage — souvent avant le GPS, depuis
  // le point de référence du centre-ville (« METZER PLAZ, 150 m ») — et contredisait les
  // réponses suivantes, calculées depuis la vraie position (« EDELECK, 19 km »).
  useEffect(()=>{
    if (aiDisplay.length === 0 && aiHistory.length === 0)
      setAiDisplay([{ role:"ai", welcome:true, local:true }]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initMsg]);

  // ── Réponses locales : la logique vit dans src/ai/localAnswers.js (module pur, testé) ──
  // Mêmes données pour les outils du modèle, plus les départs bruts (filtrage par arrêt/mode).
  const answerCtx = useMemo(
    () => ({ stations, nearest, nearestReturn, deps, weather, forecast, advice, score, gpsPos, located: !!gpsPos,
             transitStops: busStops, transitDeps: busDeps, t, tn, lang }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stations, nearest, nearestReturn, deps, weather, forecast, advice, score, gpsPos, busStops, busDeps, lang]);
  const answerLocally = useCallback(q => localAnswer(q, answerCtx), [answerCtx]);

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
    const hist = [...aiHistory,{role:"user",content:q}].slice(-CHAT_TURNS);
    let reply, raw = "", failed = null;
    try {
      // IA locale, zéro réseau. 96 jetons : un appel d'outil en prend une vingtaine.
      const out = await generateDetailed(systemPrompt(t), hist, { maxNewTokens: 96 });
      raw = out.raw;
      reply = resolveModelOutput(out.text, { ...answerCtx, now: new Date() }, local);
    } catch(e) {
      // Tentative écartée en pleine génération (erreur du moteur GPU) : la suivante se
      // charge d'elle-même, rien à demander. Délai dépassé (worker arrêté) : le dire,
      // plutôt qu'un « prêt » mensonger.
      if (e?.recover) {
        setLoadSeq(n=>n+1);
      } else if (e?.code === "generate_timeout") {
        setModelState("error");
        setModelError(describeModelError(e));
        setModelErrCode(e.code);
        setModelInfo(modelReport());
      }
      failed = e;
      reply = { ...local, source: "fallback", reason: e?.code || "generate" };
    }
    if (reply.source === "fallback") console.info(`[IA] repli sur l'assistant local (${reply.reason})`, failed?.detail || raw);
    // Seul le texte libre du modèle nourrit l'historique : les réponses d'outils
    // contiennent des valeurs qu'il pourrait recopier de travers au tour suivant.
    if (reply.source === "model") setAiHistory([...hist,{role:"assistant",content:reply.text}]);
    // Repli alors que le modèle est prêt : ne plus le taire. La bulle dit que le modèle a
    // échoué ou répondu quelque chose d'inutilisable, pourquoi, et montre ce qu'il a produit.
    // Le texte d'aide « Sans modèle… » mentirait (le modèle est chargé) : il est remplacé.
    const diag = reply.source === "fallback"
      ? { ...explainFallback(reply.reason), failed: !!failed,
          output: failed ? (failed.detail || failed.message || String(failed)) : raw }
      : null;
    const shown = diag && local.unknown ? t("ui.ai.ans.help_model") : reply.text;
    setAiDisplay(d=>[...d,{role:"ai",text:shown,nav:reply.nav,local:reply.source!=="model",error:!!diag,diag}]);
    setBusy(false);
  },[input,busy,aiHistory,answerCtx,modelState,chatOn,answerLocally,setAiHistory,setAiDisplay]);

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
          {/* Ce qui fait la note : chaque pénalité (ou accalmie) nommée, maintenant et prévue */}
          {weather && scoreDetail?.reasons.length > 0 && (
            <div style={{ fontSize:10.5, color:"var(--vn-text3)", lineHeight:1.45, marginTop:6 }}>
              {t("ui.wx.why.title", { score })} : {scoreReasons(scoreDetail).join(" · ")}
            </div>
          )}
        </section>

        {/* Station la plus proche + navigation en un geste */}
        <section className="vn-dcard">
          <div className="vn-dcard__label">{t(gpsPos ? "ui.ai.card.nearest" : "ui.ai.card.nearest_center")}</div>
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
              {m.diag && (
                <div className="vn-diag">
                  <strong className="vn-diag__title">{t(m.diag.failed ? "ui.ai.diag.title_error" : "ui.ai.diag.title_rejected")}</strong>
                  <span className="vn-diag__why">
                    {t(m.diag.key, { tool: m.diag.tool })} <code className="vn-diag__code">{m.diag.code}</code>
                  </span>
                  <details className="vn-diag__raw" open={!m.diag.hideRaw || undefined}>
                    <summary>{t(m.diag.failed ? "ui.ai.diag.detail" : m.diag.hideRaw ? "ui.ai.diag.raw_hidden" : "ui.ai.diag.raw")}</summary>
                    <pre>{m.diag.output || t("ui.ai.diag.raw_empty")}</pre>
                  </details>
                </div>
              )}
              {m.welcome ? initMsg : m.text}
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
                ? t("ui.ai.model.init", { where: attemptLabel(modelPhase.attempt) })
              : modelState==="loading" ? t("ui.ai.model.loading", { pct:modelProgress })
              : modelState==="error"   ? `${t("ui.ai.model.error")}${modelError ? " — " + modelError.slice(0, 220) : ""}`
              : modelInfo?.chosen
                ? t("ui.ai.model.ready_on", { where: whereLabel(modelInfo.chosen.engine, modelInfo.chosen.dtype, modelInfo.chosen.profile) })
                : t("ui.ai.model.ready")}
          </div>
          {/* Prêt hors du GPU : pourquoi, lisible à l'écran (sans cela, impossible de le savoir sur l'appareil) */}
          {chatOn && modelState==="ready" && gpuAside?.reasons.length > 0 && (
            <div style={{ fontSize:10.5, color:"var(--vn-text3)", lineHeight:1.45, overflowWrap:"anywhere" }}>
              {t("ui.ai.model.gpu_aside", { why: gpuAsideLabel(gpuAside) })}
            </div>
          )}
          {/* Le GPU tel qu'il s'annonce (fabricant, fp16, tailles de subgroup) : quand il n'est pas utilisé ou que tout a échoué */}
          {chatOn && modelInfo?.gpu && ((modelState==="ready" && gpuAside?.reasons.length > 0) || modelState==="error") && (
            <div style={{ fontSize:10.5, color:"var(--vn-text3)", lineHeight:1.45, overflowWrap:"anywhere" }}>
              {t("ui.ai.model.gpu_info", { gpu: gpuDescribe(modelInfo.gpu) })}
            </div>
          )}
          {/* Bascule interne (GPU → tentative suivante) : dite comme une information, pas comme une erreur */}
          {chatOn && modelState==="loading" && modelInfo?.tried?.length > 0 && modelPhase?.attempt && (
            <div style={{ fontSize:10.5, color:"var(--vn-text3)", lineHeight:1.45 }}>
              {t("ui.ai.model.next", { from: attemptLabel(modelInfo.tried.at(-1).id), to: attemptLabel(modelPhase.attempt) })}
            </div>
          )}
        </div>
        {chatOn && modelState==="error" && (
          <Button size="sm" variant="secondary" icon="refresh"
            onClick={()=>{ if (modelErrCode === "all_failed") forgetFailures(); setLoadSeq(n=>n+1); }}>{t("ui.ai.model.retry")}</Button>
        )}
        {chatOn && modelState==="ready" && gpuAside?.retry && (
          <Button size="sm" variant="secondary" icon="refresh"
            onClick={()=>{ forgetFailures(); setLoadSeq(n=>n+1); }}>
            {gpuAside.downloadMB > 0 ? t("ui.ai.model.gpu_retry_dl", { mb: gpuAside.downloadMB }) : t("ui.ai.model.gpu_retry")}
          </Button>
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
