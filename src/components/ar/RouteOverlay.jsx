// ── RouteOverlay — tracé OSRM/Google projeté sur caméra AR ──────────
// Dessine la route en canvas 2D au-dessus de la vue caméra.
// Se met à jour à chaque frame (heading, GPS) via requestAnimationFrame.
import { useState, useEffect, useRef, useMemo } from "react";
import { t } from "../../i18n.js";
import { C } from "../../constants.js";
import { haversine, fDist, getBearing } from "../../utils.js";
import { projectPoint, detectWrongWay } from "./projection.js";
import { windImpact } from "../../hooks/useWeather.js";

function RouteOverlay({ route, gpsPos, heading, mode, onClose, weather=null, spatialAudio=false,
                        offRoute=false, recalculating=false, manualRecalc=null }) {
  const cvRef = useRef();
  const [step, setStep] = useState(0); // index du prochain waypoint

  // Tick d'animation à ~30 fps — alimente les tirets animés et le pulse
  // waypoint. Inclus dans les deps du useEffect canvas pour forcer redraw.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let raf;
    let last = 0;
    const loop = (now) => {
      if (now - last > 33) {  // ~30 fps
        last = now;
        setTick(t => (t + 1) % 1000);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Heading lissé via low-pass filter — évite que le tracé "tremble" à chaque
  // micro-variation de la boussole. Utilise une moyenne exponentielle (alpha=0.25).
  // Géré en ref : pas de re-render à chaque update du heading lissé.
  const smoothedHdgRef = useRef(heading);
  useEffect(() => {
    if (heading === null) return;
    if (smoothedHdgRef.current === null) {
      smoothedHdgRef.current = heading;
      return;
    }
    // Différence shortest-path en degrés (gestion du wrap 0/360)
    const diff = ((heading - smoothedHdgRef.current + 540) % 360) - 180;
    smoothedHdgRef.current = (smoothedHdgRef.current + diff * 0.25 + 360) % 360;
  }, [heading]);

  // Avancer automatiquement vers le prochain waypoint quand on en est à <25m
  useEffect(()=>{
    if (!route || !gpsPos) return;
    const wp = route.waypoints[step];
    if (!wp) return;
    const d = haversine(gpsPos.lat, gpsPos.lng, wp.lat, wp.lng);
    if (d < 25 && step < route.waypoints.length - 1) setStep(s=>s+1);
  },[gpsPos, route, step]);

  // FIX BUG-1 : détection "destination derrière" — si l'utilisateur regarde dans
  // le mauvais sens, on N'AFFICHE PAS le tracé canvas (qui partirait sur les
  // bords de l'écran et donnerait l'illusion d'un virage). À la place, le rendu
  // affiche un overlay "FAITES DEMI-TOUR" plein écran.
  // On échantillonne les coords après le step courant pour que le ré-alignement
  // suive bien la progression (ex : après le u-turn, plus de wrong way).
  const wrongWay = useMemo(() => {
    if (!route?.coords?.length || !gpsPos || heading === null) {
      return { wrongWay: false, ratio: 0, sampleSize: 0 };
    }
    // Filtrer les coords en gardant celles devant nous dans le tracé.
    // Approximation : on commence à partir du sommet le plus proche.
    let nearestIdx = 0, nearestD = Infinity;
    for (let i = 0; i < route.coords.length; i++) {
      const d = haversine(gpsPos.lat, gpsPos.lng, route.coords[i].lat, route.coords[i].lng);
      if (d < nearestD) { nearestD = d; nearestIdx = i; }
    }
    const ahead = route.coords.slice(nearestIdx);
    return detectWrongWay(ahead, gpsPos, heading, 150);
  }, [
    route?.coords,
    gpsPos ? Math.round(gpsPos.lat * 10000) : null,
    gpsPos ? Math.round(gpsPos.lng * 10000) : null,
    heading != null ? Math.round(heading / 5) : null, // re-eval tous les 5°
  ]);

  // Canvas : dessine le tracé de la route projeté en AR
  useEffect(()=>{
    const cv = cvRef.current; if (!cv || !route || !gpsPos || heading === null) return;
    // FIX BUG-1 : si on regarde dans le mauvais sens, on ne dessine pas le tracé
    // (sinon il se replie aux bords et trompe l'utilisateur). L'overlay U-turn
    // pleine page prend le relais.
    if (wrongWay.wrongWay) {
      const ctx0 = cv.getContext("2d");
      ctx0.clearRect(0, 0, cv.width, cv.height);
      return;
    }
    const W = cv.offsetWidth || 360, H = cv.offsetHeight || 500;
    // Support DPI (rétine) pour un tracé net
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const col = mode === "walking" ? "#A78BFA" : "#3B82F6"; // violet=pieds, bleu=vélo
    const hdgUsed = smoothedHdgRef.current ?? heading;

    // ── 1. Tracer la ligne de route (avec clamp aux bords pour éviter coupures)
    // Échantillonnage : on garde 1 pt sur N pour les routes très denses (perf).
    const STRIDE = Math.max(1, Math.floor(route.coords.length / 80));
    const sampled = route.coords.filter((_, i) => i % STRIDE === 0 || i === route.coords.length - 1);

    const pts = sampled
      .map(p => projectPoint(gpsPos.lat, gpsPos.lng, hdgUsed, p.lat, p.lng, W, H, true))
      .filter(Boolean);

    // Garder uniquement la portion contiguë qui passe par le FOV
    // (évite de dessiner des segments de la fin de route en haut de l'écran)
    const segments = [];
    let cur = [];
    pts.forEach(p => {
      if (p.inFov) {
        cur.push(p);
      } else if (cur.length > 0) {
        cur.push(p); // un seul point hors FOV pour la transition douce
        segments.push(cur);
        cur = [];
      }
    });
    if (cur.length > 0) segments.push(cur);

    segments.forEach(seg => {
      if (seg.length < 2) return;

      // ── HALO externe (glow) — couche 1
      ctx.beginPath();
      seg.forEach((p,i) => i===0 ? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y));
      ctx.strokeStyle = col;
      ctx.lineWidth = 18; ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.globalAlpha = 0.18; ctx.shadowBlur = 14; ctx.shadowColor = col;
      ctx.setLineDash([]); ctx.stroke();
      ctx.shadowBlur = 0; ctx.globalAlpha = 1;

      // ── Ombre portée — couche 2
      ctx.beginPath();
      seg.forEach((p,i) => i===0 ? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y));
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.lineWidth = 11; ctx.stroke();

      // ── Bord blanc (lisibilité sur fonds variés) — couche 3
      ctx.beginPath();
      seg.forEach((p,i) => i===0 ? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y));
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.lineWidth = 8; ctx.stroke();

      // ── Ligne principale colorée — couche 4
      ctx.beginPath();
      seg.forEach((p,i) => i===0 ? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y));
      ctx.strokeStyle = col;
      ctx.lineWidth = 5; ctx.stroke();

      // ── Tirets blancs animés — couche 5 (effet "marche/avance")
      ctx.beginPath();
      seg.forEach((p,i) => i===0 ? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y));
      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 16]);
      // Offset basé sur le temps pour l'animation "qui avance"
      ctx.lineDashOffset = -((Date.now() / 60) % 26);
      ctx.stroke();
      ctx.setLineDash([]); ctx.lineDashOffset = 0;
    });

    // ── 2. Dessiner les flèches de virage aux waypoints
    route.waypoints.slice(step, step+4).forEach((wp, wi)=>{
      const p = projectPoint(gpsPos.lat, gpsPos.lng, hdgUsed, wp.lat, wp.lng, W, H);
      if (!p) return;
      const isNext = wi === 0;
      const r = isNext ? 16 : 10;
      const alpha = isNext ? 1 : 0.55;

      // Halo pulsant pour le prochain virage
      if (isNext) {
        const pulseR = r + 6 + Math.sin(Date.now()/300) * 3;
        ctx.beginPath();
        ctx.arc(p.x, p.y, pulseR, 0, Math.PI*2);
        ctx.fillStyle = `${col}33`;
        ctx.fill();
      }

      // Cercle de fond noir
      ctx.beginPath();
      ctx.arc(p.x, p.y, r+3, 0, Math.PI*2);
      ctx.fillStyle = `rgba(0,0,0,${alpha*0.7})`;
      ctx.fill();

      // Cercle coloré
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI*2);
      ctx.fillStyle = isNext ? col : col+"99";
      ctx.shadowBlur = isNext ? 12 : 0;
      ctx.shadowColor = col;
      ctx.fill();
      ctx.shadowBlur = 0;

      // Flèche directionnelle selon modifier
      ctx.save(); ctx.translate(p.x, p.y);
      const rot = wp.modifier==="left" ? -40
                : wp.modifier==="right" ? 40
                : wp.modifier==="sharp left" ? -80
                : wp.modifier==="sharp right" ? 80
                : 0;
      ctx.rotate(rot * Math.PI/180);
      ctx.fillStyle = "white";
      ctx.font = `bold ${isNext?16:11}px sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("↑", 0, 0);
      ctx.restore();
    });

    // ── 3. Indicateur "sol" — ligne horizon perspective
    if (segments.length > 0 && segments[0].length > 0) {
      const foot = segments[0][0];
      const footGrad = ctx.createLinearGradient(W/2, H, W/2, foot.y);
      footGrad.addColorStop(0, `${col}90`);
      footGrad.addColorStop(1, `${col}00`);
      ctx.beginPath();
      ctx.moveTo(W/2-40, H); ctx.lineTo(foot.x-5, foot.y);
      ctx.lineTo(foot.x+5, foot.y); ctx.lineTo(W/2+40, H);
      ctx.fillStyle = footGrad; ctx.fill();
    }

  },[route, gpsPos, heading, mode, step, tick, wrongWay.wrongWay]);

  // (tick déclaré plus haut — alimente le redraw à 30 fps)

  // ── Calculs dérivés (avant early return — règle des hooks React) ──
  const nextWp   = route?.waypoints?.[step];
  const distNext = nextWp && gpsPos
    ? haversine(gpsPos.lat, gpsPos.lng, nextWp.lat, nextWp.lng) : 0;
  const arriving = route && distNext < 30 && step === (route.waypoints.length - 1);
  const modeIcon = mode === "walking" ? "🚶" : "🚲";
  const modeCol  = mode === "walking" ? "#A78BFA" : "#3B82F6";

  // ── Wind-aware ETA — DOIT être avant early return ──────────────
  // Calcule le bearing du segment en cours (depuis la position vers le
  // prochain waypoint) et applique le facteur d'impact vent sur l'ETA.
  // Pas applicable en mode walking (impact négligeable < 5 km/h).
  const wind = useMemo(() => {
    if (!weather || mode === "walking" || !gpsPos || !nextWp) {
      return { factor: 1, label: null, headWindKmh: 0 };
    }
    const bear = getBearing(gpsPos.lat, gpsPos.lng, nextWp.lat, nextWp.lng);
    return windImpact(bear, weather.windDir ?? 0, weather.wind ?? 0);
  }, [weather, mode, gpsPos?.lat, gpsPos?.lng, nextWp?.lat, nextWp?.lng]);

  // Early return APRÈS tous les hooks
  if (!route) return null;

  const correctedTime = Math.round(route.totalTime * wind.factor / 60);
  const baseTime      = Math.round(route.totalTime / 60);

  // Étiquette de direction textuelle
  const dirText = arriving ? t("nav.arrived") : (
    nextWp?.modifier === "left"         ? "◀ TOURNEZ À GAUCHE"
    : nextWp?.modifier === "right"      ? "TOURNEZ À DROITE ▶"
    : nextWp?.modifier === "sharp left" ? "◀◀ VIRAGE SERRÉ GAUCHE"
    : nextWp?.modifier === "sharp right"? "VIRAGE SERRÉ DROITE ▶▶"
    : nextWp?.modifier === "uturn"      ? "DEMI-TOUR"
    :                                     t("nav.continue")
  );

  return (
    <>
      {/* Canvas plein écran */}
      <canvas ref={cvRef} style={{
        position:"absolute", inset:0, width:"100%", height:"100%",
        pointerEvents:"none", zIndex:12,
      }}/>

      {/* HUD navigation haut */}
      <div style={{
        position:"absolute", top:52, left:"50%",
        transform:"translateX(-50%)",
        zIndex:22, pointerEvents:"none",
        display:"flex", flexDirection:"column", alignItems:"center", gap:6,
      }}>
        {/* Distance prochain virage */}
        <div style={{
          background:"rgba(8,12,15,0.88)",
          border:`2px solid ${modeCol}`,
          borderRadius:10, padding:"10px 20px",
          display:"flex", flexDirection:"column", alignItems:"center", gap:4,
          boxShadow:`0 0 20px ${modeCol}40`,
        }}>
          <div style={{ color:modeCol, fontSize:32, fontFamily:C.fnt, fontWeight:700, lineHeight:1 }}>
            {fDist(distNext)}
          </div>
          <div style={{ color:"#fff", fontSize:9, fontFamily:C.fnt, letterSpacing:2 }}>
            {dirText}
          </div>
        </div>

        {/* Total restant + impact vent */}
        <div style={{
          background:"rgba(8,12,15,0.75)", border:`1px solid ${modeCol}44`,
          borderRadius:6, padding:"4px 12px",
          color:C.muted, fontSize:8, fontFamily:C.fnt,
          display:"flex", alignItems:"center", gap:8,
        }}>
          <span>{modeIcon} {fDist(route.totalDist)} · {correctedTime} min total
            · étape {step+1}/{route.waypoints.length}</span>
          {spatialAudio && (
            <span style={{
              color: C.good, fontSize: 9, letterSpacing: 1,
              background: `${C.good}15`, padding: "1px 5px",
              borderRadius: 3, border: `1px solid ${C.good}55`,
            }} title="Audio spatial 3D actif">🎧 3D</span>
          )}
        </div>

        {/* Badge vent — visible uniquement en mode vélo si impact significatif */}
        {wind.label && Math.abs(wind.headWindKmh) >= 5 && (
          <div style={{
            background: wind.headWindKmh > 0 ? "rgba(224,62,62,0.15)" : "rgba(46,204,143,0.15)",
            border: `1px solid ${wind.headWindKmh > 0 ? C.bad : C.good}66`,
            borderRadius: 5, padding: "3px 10px",
            color: wind.headWindKmh > 0 ? C.bad : C.good,
            fontSize: 8, fontFamily: C.fnt, letterSpacing: 1,
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <span>🌬️</span>
            <span style={{fontWeight:700}}>
              {wind.headWindKmh > 0 ? "+" : ""}{Math.round((wind.factor - 1) * 100)}%
            </span>
            <span>· {wind.label} {Math.abs(wind.headWindKmh)}km/h</span>
            {baseTime !== correctedTime && (
              <span style={{color:C.muted}}>· était {baseTime}min</span>
            )}
          </div>
        )}
      </div>

      {/* Bouton fermer la navigation */}
      <div style={{
        position:"absolute", top:52, right:12,
        zIndex:23, cursor:"pointer",
      }} onPointerDown={onClose}>
        <div style={{
          width:36, height:36, borderRadius:18,
          background:"rgba(8,12,15,0.9)", border:`1px solid ${modeCol}55`,
          display:"flex", alignItems:"center", justifyContent:"center",
          fontSize:16,
        }}>✕</div>
      </div>

      {/* Arrivée */}
      {arriving && (
        <div style={{
          position:"absolute", top:"38%", left:"50%",
          transform:"translate(-50%,-50%)", zIndex:24, pointerEvents:"none",
          background:"rgba(8,12,15,0.95)", border:`2px solid ${C.good}`,
          borderRadius:16, padding:"20px 32px", textAlign:"center",
          boxShadow:`0 0 40px ${C.good}50`,
        }}>
          <div style={{ fontSize:36 }}>🎯</div>
          <div style={{ color:C.good, fontSize:18, fontFamily:C.fnt, fontWeight:700, letterSpacing:4, marginTop:8 }}>
            ARRIVÉE !
          </div>
        </div>
      )}

      {/* FIX BUG-1 : Overlay "Mauvais sens" — affiché quand la majorité de la
          polyline ahead est physiquement derrière la caméra. Plus utile qu'un
          tracé tordu projeté sur les bords de l'écran. */}
      {wrongWay.wrongWay && !arriving && (
        <div style={{
          position:"absolute", top:"38%", left:"50%",
          transform:"translate(-50%,-50%)", zIndex:24, pointerEvents:"none",
          background:"rgba(8,12,15,0.96)",
          border:`3px solid ${C.warn}`,
          borderRadius:16, padding:"22px 28px", textAlign:"center",
          boxShadow:`0 0 50px ${C.warn}66`,
          minWidth:260, maxWidth:320,
          animation:"wrongWayPulse 1.4s ease-in-out infinite",
        }}>
          <style>{`
            @keyframes wrongWayPulse {
              0%,100% { transform: translate(-50%,-50%) scale(1);    box-shadow: 0 0 50px ${C.warn}66; }
              50%     { transform: translate(-50%,-50%) scale(1.03); box-shadow: 0 0 70px ${C.warn}99; }
            }
            @keyframes wrongWayArrow {
              0%,100% { transform: translateY(0)  rotate(180deg); }
              50%     { transform: translateY(-6px) rotate(180deg); }
            }
          `}</style>
          <div style={{
            fontSize:48, lineHeight:1, marginBottom:8,
            animation:"wrongWayArrow 1s ease-in-out infinite",
            display:"inline-block",
          }}>↑</div>
          <div style={{
            color:C.warn, fontSize:16, fontFamily:C.fnt, fontWeight:700,
            letterSpacing:3, marginBottom:6,
          }}>
            {t("nav.wrong_way")}
          </div>
          <div style={{ color:"#fff", fontSize:10, fontFamily:C.fnt, lineHeight:1.6 }}>
            {t("nav.wrong_way_desc")}
          </div>
        </div>
      )}

      {/* FIX BUG-3 : Bandeau off-route + bouton recalcul manuel.
          Affiché en bas (au-dessus du panneau station) pour ne pas masquer la vue. */}
      {(offRoute || recalculating) && !arriving && !wrongWay.wrongWay && (
        <div style={{
          position:"absolute", bottom:90, left:14, right:14,
          zIndex:25,
          background: recalculating
            ? "linear-gradient(135deg, rgba(0,16,40,0.96), rgba(8,12,15,0.96))"
            : "linear-gradient(135deg, rgba(40,12,0,0.96), rgba(8,12,15,0.96))",
          border:`2px solid ${recalculating ? "#60A5FA" : C.warn}`,
          borderRadius:10, padding:"10px 13px",
          boxShadow:`0 4px 20px rgba(0,0,0,0.6)`,
          display:"flex", alignItems:"center", gap:10,
        }}>
          <span style={{ fontSize:18 }}>{recalculating ? "🔄" : "⚠️"}</span>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{
              color: recalculating ? "#60A5FA" : C.warn,
              fontSize:9, fontFamily:C.fnt, fontWeight:700, letterSpacing:1.5,
            }}>
              {recalculating ? t("nav.recalculating") : t("nav.off_route")}
            </div>
            {!recalculating && (
              <div style={{ color:C.muted, fontSize:8, fontFamily:C.fnt, marginTop:1 }}>
                {t("nav.off_route_desc")}
              </div>
            )}
          </div>
          {!recalculating && manualRecalc && (
            <div onPointerDown={manualRecalc}
              style={{
                padding:"6px 10px",
                background:`${C.warn}22`, border:`1px solid ${C.warn}`,
                borderRadius:5, cursor:"pointer", whiteSpace:"nowrap",
              }}>
              <span style={{ color:C.warn, fontSize:8, fontFamily:C.fnt, fontWeight:700, letterSpacing:1 }}>
                {t("nav.recalc_btn")}
              </span>
            </div>
          )}
        </div>
      )}
    </>
  );
}

export default RouteOverlay;
