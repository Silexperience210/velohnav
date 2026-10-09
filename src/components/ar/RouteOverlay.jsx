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
import { detectWrongWay, wrongWayHysteresis } from "./projection.js";
import { projectGround, projectGroundPath, routeAhead } from "./groundProjection.js";

// Rotation de la flèche dessinée sur chaque point de manœuvre (degrés).
// Avant : légère gauche/droite et demi-tour dessinés comme « tout droit ».
const ARROW_ROT = {
  "slight left": -20, left: -40, "sharp left": -80,
  "slight right": 20, right: 40, "sharp right": 80, uturn: 180,
};

// `ahead` : portion du tracé à dessiner et origine recalée (groundProjection.routeAhead),
// calculée par ARScreen pour que le pin de destination parte de la MÊME origine.
// `pitchRef` : inclinaison lissée de la caméra (useCompass), lue à chaque image.
function RouteOverlay({ route, gpsPos, heading, mode, step = 0, arriving = false, isNight = false, fov, ahead = null, pitchRef = null }) {
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
  propsRef.current = { route, gpsPos, heading, mode, step, isNight, fov, wrongWay, ahead, pitch: pitchRef?.current ?? 0, pitchRef };

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
// Au-delà, une flèche de virage n'est plus dessinée (bruit GPS dominant)
const ARROW_MAX_M = 500;
// Ancrage de l'indicateur « sol » sur le tracé
const FOOT_M = 6;

/** Point situé à `m` mètres le long de `path` (interpolé), ou null si plus court. */
function pointAlong(path, m) {
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const d = haversine(path[i - 1].lat, path[i - 1].lng, path[i].lat, path[i].lng);
    if (acc + d >= m && d > 0) {
      const t = (m - acc) / d;
      return { lat: path[i - 1].lat + t * (path[i].lat - path[i - 1].lat),
               lng: path[i - 1].lng + t * (path[i].lng - path[i - 1].lng) };
    }
    acc += d;
  }
  return null;
}
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
  // Caméra : cap lissé, inclinaison lue à l'instant (ref), champ réellement affiché
  const cam = { heading: hdgUsed, pitch: p.pitchRef?.current ?? p.pitch ?? 0, hfov: fov, viewW: W, viewH: H };
  const { origin, path } = p.ahead ?? routeAhead(route.coords, gpsPos);

  // ── 1. Tracer la ligne de route — vraie perspective au sol, depuis l'origine
  // recalée, découpée au plan proche (groundProjection). Échantillonnage : 1 pt
  // sur N pour les routes très denses (perf) ; les droites restant droites en
  // perspective, sauter des sommets ne déforme rien.
  const STRIDE = Math.max(1, Math.floor(path.length / 80));
  const sampled = path.filter((_, i) => i % STRIDE === 0 || i === path.length - 1);
  const segments = projectGroundPath(origin, sampled, cam);

  const path2d = seg => { ctx.beginPath(); seg.forEach((q, i) => i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)); };
  segments.forEach(seg => {
    if (seg.length < 2) return;
    // ── HALO externe (glow) — couche 1
    path2d(seg);
    ctx.strokeStyle = col;
    ctx.lineWidth = 18; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.globalAlpha = isNight ? 0.28 : 0.18; ctx.shadowBlur = isNight ? 22 : 14; ctx.shadowColor = col;
    ctx.setLineDash([]); ctx.stroke();
    ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    // ── Ombre portée — couche 2
    path2d(seg); ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 11; ctx.stroke();
    // ── Bord blanc (lisibilité sur fonds variés) — couche 3
    path2d(seg); ctx.strokeStyle = isNight ? "rgba(255,255,255,0.98)" : "rgba(255,255,255,0.95)";
    ctx.lineWidth = isNight ? 9 : 8; ctx.stroke();
    // ── Ligne principale colorée — couche 4
    path2d(seg); ctx.strokeStyle = col; ctx.lineWidth = isNight ? 6 : 5; ctx.stroke();
    // ── Tirets blancs animés — couche 5 (effet "marche/avance")
    path2d(seg);
    ctx.strokeStyle = isNight ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.8)";
    ctx.lineWidth = isNight ? 3 : 2;
    ctx.setLineDash([10, 16]);
    ctx.lineDashOffset = -((Date.now() / 60) % 26);
    ctx.stroke();
    ctx.setLineDash([]); ctx.lineDashOffset = 0;
  });

  // ── 2. Dessiner les flèches de virage aux waypoints
  // Même origine et même projection que la ligne : la flèche est posée SUR le tracé.
  route.waypoints.slice(step, step + 4).forEach((wp, wi) => {
    const q = projectGround(origin, wp, cam);
    if (!q || !q.onScreen || q.depth > ARROW_MAX_M) return;
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

  // ── 3. Indicateur "sol" — dégradé des pieds de l'utilisateur vers le tracé,
  // ancré au point du tracé à FOOT_M devant (le début de la ligne est sous l'écran)
  const footPt = pointAlong(path, FOOT_M);
  const foot = footPt && projectGround(origin, footPt, cam);
  if (foot && foot.onScreen) {
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
