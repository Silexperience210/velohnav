// ── RouteOverlay — tracé OSRM/Google projeté sur caméra AR ──────────
// Dessine la route en canvas 2D au-dessus de la vue caméra.
// Se met à jour à chaque frame (heading, GPS) via requestAnimationFrame.
import { useState, useEffect, useRef, useMemo } from "react";
import { t } from "../../i18n.js";
import { C } from "../../constants.js";
import { haversine, fDist, getBearing } from "../../utils.js";
import { projectPoint } from "./projection.js";
import { windImpact } from "../../hooks/useWeather.js";

function RouteOverlay({ route, gpsPos, heading, mode, onClose, weather=null }) {
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

  // Canvas : dessine le tracé de la route projeté en AR
  useEffect(()=>{
    const cv = cvRef.current; if (!cv || !route || !gpsPos || heading === null) return;
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

  },[route, gpsPos, heading, mode, step, tick]);

  // (tick déclaré plus haut — alimente le redraw à 30 fps)

  if (!route) return null;

  const nextWp   = route.waypoints[step];
  const distNext = nextWp && gpsPos
    ? haversine(gpsPos.lat, gpsPos.lng, nextWp.lat, nextWp.lng) : 0;
  const arriving = distNext < 30 && step === route.waypoints.length - 1;
  const modeIcon = mode === "walking" ? "🚶" : "🚲";
  const modeCol  = mode === "walking" ? "#A78BFA" : "#3B82F6";

  // ── Wind-aware ETA ────────────────────────────────────────────
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
    </>
  );
}

export default RouteOverlay;
