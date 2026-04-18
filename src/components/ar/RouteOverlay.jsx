// ── RouteOverlay — tracé OSRM/Google projeté sur caméra AR ──────────
// Dessine la route en canvas 2D au-dessus de la vue caméra.
// Se met à jour à chaque frame (heading, GPS) via requestAnimationFrame.
import { useState, useEffect, useRef } from "react";
import { t } from "../../i18n.js";
import { C } from "../../constants.js";
import { haversine, fDist } from "../../utils.js";
import { projectPoint } from "./projection.js";

function RouteOverlay({ route, gpsPos, heading, mode, onClose }) {
  const cvRef = useRef();
  const [step, setStep] = useState(0); // index du prochain waypoint

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
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, W, H);

    const col = mode === "walking" ? "#A78BFA" : "#3B82F6"; // violet=pieds, bleu=vélo

    // ── 1. Tracer la ligne de route (coords complètes)
    const pts = route.coords
      .map(p => projectPoint(gpsPos.lat, gpsPos.lng, heading, p.lat, p.lng, W, H))
      .filter(Boolean);

    if (pts.length >= 2) {
      // Ombre portée
      ctx.beginPath();
      pts.forEach((p,i) => i===0 ? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y));
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = 9; ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.setLineDash([]); ctx.stroke();

      // Ligne principale
      ctx.beginPath();
      pts.forEach((p,i) => i===0 ? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y));
      ctx.strokeStyle = col;
      ctx.lineWidth = 5; ctx.globalAlpha = 0.85; ctx.stroke();
      ctx.globalAlpha = 1;

      // Tirets blancs par-dessus (effet route)
      ctx.beginPath();
      pts.forEach((p,i) => i===0 ? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y));
      ctx.strokeStyle = "rgba(255,255,255,0.3)";
      ctx.lineWidth = 2; ctx.setLineDash([12, 18]); ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── 2. Dessiner les flèches de virage aux waypoints
    route.waypoints.slice(step, step+4).forEach((wp, wi)=>{
      const p = projectPoint(gpsPos.lat, gpsPos.lng, heading, wp.lat, wp.lng, W, H);
      if (!p) return;
      const isNext = wi === 0;
      const r = isNext ? 14 : 9;
      const alpha = isNext ? 1 : 0.55;

      // Cercle de fond
      ctx.beginPath();
      ctx.arc(p.x, p.y, r+3, 0, Math.PI*2);
      ctx.fillStyle = `rgba(0,0,0,${alpha*0.6})`;
      ctx.fill();

      // Cercle coloré
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI*2);
      ctx.fillStyle = isNext ? col : col+"88";
      ctx.fill();

      // Flèche directionnelle selon modifier
      ctx.save(); ctx.translate(p.x, p.y);
      const rot = wp.modifier==="left" ? -40
                : wp.modifier==="right" ? 40
                : wp.modifier==="sharp left" ? -80
                : wp.modifier==="sharp right" ? 80
                : 0;
      ctx.rotate(rot * Math.PI/180);
      ctx.fillStyle = "white";
      ctx.font = `bold ${isNext?14:10}px sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("↑", 0, 0);
      ctx.restore();
    });

    // ── 3. Indicateur "sol" — ligne horizon perspective
    if (pts.length > 0) {
      const foot = pts[0];
      const footGrad = ctx.createLinearGradient(W/2, H, W/2, foot.y);
      footGrad.addColorStop(0, `${col}50`);
      footGrad.addColorStop(1, `${col}00`);
      ctx.beginPath();
      ctx.moveTo(W/2-30, H); ctx.lineTo(foot.x-4, foot.y);
      ctx.lineTo(foot.x+4, foot.y); ctx.lineTo(W/2+30, H);
      ctx.fillStyle = footGrad; ctx.fill();
    }

  },[route, gpsPos, heading, mode, step]);

  if (!route) return null;

  const nextWp   = route.waypoints[step];
  const distNext = nextWp && gpsPos
    ? haversine(gpsPos.lat, gpsPos.lng, nextWp.lat, nextWp.lng) : 0;
  const arriving = distNext < 30 && step === route.waypoints.length - 1;
  const modeIcon = mode === "walking" ? "🚶" : "🚲";
  const modeCol  = mode === "walking" ? "#A78BFA" : "#3B82F6";

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

        {/* Total restant */}
        <div style={{
          background:"rgba(8,12,15,0.75)", border:`1px solid ${modeCol}44`,
          borderRadius:6, padding:"4px 12px",
          color:C.muted, fontSize:8, fontFamily:C.fnt,
        }}>
          {modeIcon} {fDist(route.totalDist)} · {Math.round(route.totalTime/60)} min total
          · étape {step+1}/{route.waypoints.length}
        </div>
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
