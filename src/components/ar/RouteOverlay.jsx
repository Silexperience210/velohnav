// ── RouteOverlay — tracé OSRM/BRouter/Google projeté sur caméra AR ──────
// Dessine la route en canvas 2D au-dessus de la vue caméra, plus les deux
// alertes plein écran (arrivée, mauvais sens). Le HUD texte vit dans NavHud.
//
// Le dessin tourne dans une boucle requestAnimationFrame (~30 fps) qui lit
// les dernières props par référence : avant, un setState à 30 fps re-rendait
// tout le composant (HUD compris) pour animer les tirets — coûteux en batterie.
import { useEffect, useRef, useMemo } from "react";
import { t } from "../../i18n.js";
import { C } from "../../constants.js";
import { haversine } from "../../utils.js";
import { Icon } from "../../ui/icons.jsx";
import { projectPoint, detectWrongWay, wrongWayHysteresis } from "./projection.js";

// Rotation de la flèche dessinée sur chaque point de manœuvre (degrés).
// Avant : légère gauche/droite et demi-tour dessinés comme « tout droit ».
const ARROW_ROT = {
  "slight left": -20, left: -40, "sharp left": -80,
  "slight right": 20, right: 40, "sharp right": 80, uturn: 180,
};

function RouteOverlay({ route, gpsPos, heading, mode, step = 0, arriving = false, isNight = false, fov }) {
  const cvRef = useRef();

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

  // FIX BUG-1 : détection "destination derrière" — si l'utilisateur regarde dans
  // le mauvais sens, on N'AFFICHE PAS le tracé canvas (qui partirait sur les
  // bords de l'écran et donnerait l'illusion d'un virage). À la place, le rendu
  // affiche un overlay "FAITES DEMI-TOUR" plein écran.
  const wrongWayRaw = useMemo(() => {
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
    // Cap lissé (comme le tracé) plutôt que le cap brut, plus nerveux
    return detectWrongWay(ahead, gpsPos, smoothedHdgRef.current ?? heading, 150);
  }, [
    route?.coords,
    gpsPos ? Math.round(gpsPos.lat * 10000) : null,
    gpsPos ? Math.round(gpsPos.lng * 10000) : null,
    heading != null ? Math.round(heading / 5) : null, // re-eval tous les 5°
  ]);
  // Hystérésis : entrée à 60 % du tracé derrière soi, sortie sous 40 %.
  const wrongWayPrevRef = useRef(false);
  const wrongWay = wrongWayHysteresis(wrongWayPrevRef.current, wrongWayRaw);
  wrongWayPrevRef.current = wrongWay;

  // Dernières valeurs lues par la boucle de dessin (pas de dépendances à gérer :
  // isNight, fov, step… sont toujours à jour)
  const propsRef = useRef(null);
  propsRef.current = { route, gpsPos, heading, mode, step, isNight, fov, wrongWay };

  useEffect(() => {
    let raf, last = 0;
    const loop = (now) => {
      raf = requestAnimationFrame(loop);
      if (now - last < 33) return;   // ~30 fps
      last = now;
      draw(cvRef.current, propsRef.current, smoothedHdgRef.current);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (!route) return null;

  return (
    <>
      {/* Canvas plein écran */}
      <canvas ref={cvRef} style={{
        position:"absolute", inset:0, width:"100%", height:"100%",
        pointerEvents:"none", zIndex:12,
      }}/>

      {/* Arrivée */}
      {arriving && (
        <div style={{
          position:"absolute", top:"42%", left:"50%",
          transform:"translate(-50%,-50%)", zIndex:24, pointerEvents:"none",
          background:"rgba(8,12,15,0.95)", border:`2px solid ${C.good}`,
          borderRadius:16, padding:"20px 32px", textAlign:"center",
          boxShadow:`0 0 40px ${C.good}50`, color:C.good,
        }}>
          <Icon name="flag" size={40} stroke={2}/>
          <div style={{ fontSize:18, fontWeight:700, letterSpacing:1, marginTop:8 }}>
            {t("ui.nav.arrive")}
          </div>
        </div>
      )}

      {/* FIX BUG-1 : Overlay "Mauvais sens" — affiché quand la majorité de la
          polyline ahead est physiquement derrière la caméra. Plus utile qu'un
          tracé tordu projeté sur les bords de l'écran. */}
      {wrongWay && !arriving && (
        <div style={{
          position:"absolute", top:"42%", left:"50%",
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
          `}</style>
          <div style={{ color:C.warn, marginBottom:8 }}><Icon name="uturn" size={44} stroke={2.2}/></div>
          <div style={{ color:C.warn, fontSize:16, fontWeight:700, letterSpacing:3, marginBottom:6 }}>
            {t("nav.wrong_way")}
          </div>
          <div style={{ color:"#fff", fontSize:12, lineHeight:1.6 }}>
            {t("nav.wrong_way_desc")}
          </div>
        </div>
      )}
    </>
  );
}

// ── Dessin du tracé (hors React) ──────────────────────────────────────
function draw(cv, p, smoothedHdg) {
  if (!cv || !p) return;
  const { route, gpsPos, heading, mode, step, isNight, fov, wrongWay } = p;
  const W = cv.offsetWidth || 360, H = cv.offsetHeight || 500;
  // Support DPI (rétine) pour un tracé net — redimensionné seulement si besoin
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  // FIX BUG-1 : si on regarde dans le mauvais sens, on ne dessine pas le tracé
  // (sinon il se replie aux bords et trompe l'utilisateur).
  if (!route || !gpsPos || heading === null || wrongWay) return;

  const col = mode === "walking"
    ? (isNight ? "#FF6B00" : "#A78BFA")
    : (isNight ? "#00F0FF" : "#3B82F6"); // nuit: néon orange/cyan, jour: violet/bleu
  const hdgUsed = smoothedHdg ?? heading;

  // ── 1. Tracer la ligne de route (avec clamp aux bords pour éviter coupures)
  // Échantillonnage : on garde 1 pt sur N pour les routes très denses (perf).
  const STRIDE = Math.max(1, Math.floor(route.coords.length / 80));
  const sampled = route.coords.filter((_, i) => i % STRIDE === 0 || i === route.coords.length - 1);

  const pts = sampled
    .map(q => projectPoint(gpsPos.lat, gpsPos.lng, hdgUsed, q.lat, q.lng, W, H, true, fov))
    .filter(Boolean);

  // Garder uniquement la portion contiguë qui passe par le FOV
  // (évite de dessiner des segments de la fin de route en haut de l'écran)
  const segments = [];
  let cur = [];
  pts.forEach(q => {
    if (q.inFov) {
      cur.push(q);
    } else if (cur.length > 0) {
      cur.push(q); // un seul point hors FOV pour la transition douce
      segments.push(cur);
      cur = [];
    }
  });
  if (cur.length > 0) segments.push(cur);

  const path = seg => { ctx.beginPath(); seg.forEach((q, i) => i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)); };
  segments.forEach(seg => {
    if (seg.length < 2) return;
    // ── HALO externe (glow) — couche 1
    path(seg);
    ctx.strokeStyle = col;
    ctx.lineWidth = 18; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.globalAlpha = isNight ? 0.28 : 0.18; ctx.shadowBlur = isNight ? 22 : 14; ctx.shadowColor = col;
    ctx.setLineDash([]); ctx.stroke();
    ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    // ── Ombre portée — couche 2
    path(seg); ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 11; ctx.stroke();
    // ── Bord blanc (lisibilité sur fonds variés) — couche 3
    path(seg); ctx.strokeStyle = isNight ? "rgba(255,255,255,0.98)" : "rgba(255,255,255,0.95)";
    ctx.lineWidth = isNight ? 9 : 8; ctx.stroke();
    // ── Ligne principale colorée — couche 4
    path(seg); ctx.strokeStyle = col; ctx.lineWidth = isNight ? 6 : 5; ctx.stroke();
    // ── Tirets blancs animés — couche 5 (effet "marche/avance")
    path(seg);
    ctx.strokeStyle = isNight ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.8)";
    ctx.lineWidth = isNight ? 3 : 2;
    ctx.setLineDash([10, 16]);
    ctx.lineDashOffset = -((Date.now() / 60) % 26);
    ctx.stroke();
    ctx.setLineDash([]); ctx.lineDashOffset = 0;
  });

  // ── 2. Dessiner les flèches de virage aux waypoints
  route.waypoints.slice(step, step + 4).forEach((wp, wi) => {
    const q = projectPoint(gpsPos.lat, gpsPos.lng, hdgUsed, wp.lat, wp.lng, W, H, false, fov);
    if (!q) return;
    const isNext = wi === 0;
    const r = isNext ? 16 : 10;
    const alpha = isNext ? 1 : 0.55;
    // Halo pulsant pour le prochain virage
    if (isNext) {
      ctx.beginPath();
      ctx.arc(q.x, q.y, r + 6 + Math.sin(Date.now() / 300) * 3, 0, Math.PI * 2);
      ctx.fillStyle = `${col}33`;
      ctx.fill();
    }
    // Cercle de fond noir
    ctx.beginPath();
    ctx.arc(q.x, q.y, r + 3, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(0,0,0,${alpha * 0.7})`;
    ctx.fill();
    // Cercle coloré
    ctx.beginPath();
    ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
    ctx.fillStyle = isNext ? col : col + "99";
    ctx.shadowBlur = isNext ? 12 : 0;
    ctx.shadowColor = col;
    ctx.fill();
    ctx.shadowBlur = 0;
    // Flèche directionnelle selon modifier
    ctx.save(); ctx.translate(q.x, q.y);
    ctx.rotate((ARROW_ROT[wp.modifier] ?? 0) * Math.PI / 180);
    ctx.fillStyle = "white";
    ctx.font = `bold ${isNext ? 16 : 11}px sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("↑", 0, 0);
    ctx.restore();
  });

  // ── 3. Indicateur "sol" — ligne horizon perspective
  if (segments.length > 0 && segments[0].length > 0) {
    const foot = segments[0][0];
    const footGrad = ctx.createLinearGradient(W / 2, H, W / 2, foot.y);
    footGrad.addColorStop(0, `${col}90`);
    footGrad.addColorStop(1, `${col}00`);
    ctx.beginPath();
    ctx.moveTo(W / 2 - 40, H); ctx.lineTo(foot.x - 5, foot.y);
    ctx.lineTo(foot.x + 5, foot.y); ctx.lineTo(W / 2 + 40, H);
    ctx.fillStyle = footGrad; ctx.fill();
  }
}

export default RouteOverlay;
