import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { t } from "../i18n.js";
import { C, COMPASS_LABELS, FOV } from "../constants.js";
import { haversine, getBearing, fDist, fWalk, bCol, bTag, pins } from "../utils.js";

import { useCompass } from "../hooks/useCompass.js";
import { useRoute } from "../hooks/useRoute.js";
import { launchNativeArNav } from "../utils.js";

// Projette un point GPS sur le canvas AR via bearing + distance
// Retourne {x, y} dans le repère canvas, ou null si hors champ
function projectPoint(fromLat, fromLng, heading, toLat, toLng, W, H) {
  const dist    = haversine(fromLat, fromLng, toLat, toLng);
  if (dist > 300) return null;                 // limite à 300m — au-delà trop imprécis
  const bear    = getBearing(fromLat, fromLng, toLat, toLng);
  const relBear = ((bear - heading + 540) % 360) - 180; // -180..+180
  const FOV_H   = 45;                          // demi-FOV horizontal ±45°
  if (Math.abs(relBear) > FOV_H) return null;
  const x = W / 2 + (relBear / FOV_H) * (W / 2);
  // Proche = bas de l'écran (y grand), lointain = horizon (y ~30% du haut)
  const t = dist / 300;                        // 0=ici, 1=300m
  const y = H * (0.9 - t * 0.55);             // 90%→35% du haut
  return { x, y };
}

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

// ── BRIDGE CAPACITOR → ArNavigationActivity (Android natif) ──────
// Déclenche ARCore Geospatial si on est dans l'app native, sinon no-op.


// JCDecaux — fetch direct, fallback proxy CORS si bloqué (prototype web)





// ── LNURL-PAY (feature #2) ────────────────────────────────────────
// Envoie des sats via LNURL-pay depuis une Lightning Address (user@domain)
async function payLnAddress(lnAddress, satsAmount, comment="VelohNav trajet") {
  try {
    const [user, domain] = lnAddress.split("@");
    if (!user || !domain) throw new Error("Adresse invalide");
    // 1. Fetch LNURL metadata
    const metaUrl = `https://${domain}/.well-known/lnurlp/${user}`;
    const meta = await fetch(metaUrl).then(r=>r.json());
    if (meta.status === "ERROR") throw new Error(meta.reason);
    const msats = satsAmount * 1000;
    if (msats < meta.minSendable || msats > meta.maxSendable)
      throw new Error(`Montant hors limites (${meta.minSendable/1000}–${meta.maxSendable/1000} sats)`);
    // 2. Request invoice
    const callbackUrl = new URL(meta.callback);
    callbackUrl.searchParams.set("amount", msats);
    if (meta.commentAllowed > 0) callbackUrl.searchParams.set("comment", comment.slice(0, meta.commentAllowed));
    const inv = await fetch(callbackUrl.toString()).then(r=>r.json());
    if (inv.status === "ERROR") throw new Error(inv.reason);
    // 3. Ouvrir dans le wallet via URI lightning:
    window.location.href = `lightning:${inv.pr}`;
    return { ok: true, invoice: inv.pr };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}


// ── COMPASS HOOK ──────────────────────────────────────────────────

function NavOverlay({ relBear, dist, name }) {
  const cvRef = useRef();
  const abs   = Math.abs(relBear ?? 0);
  const arriving = dist < 40;
  const onTrack  = abs < 14;
  const col = arriving ? C.good : onTrack ? "#3B82F6" : C.accent;

  const dirLabel = arriving          ? "ARRIVÉE !"
    : abs < 14                       ? t("nav.straight")
    : abs < 50 && relBear < 0        ? t("nav.turn_left")
    : abs < 50 && relBear > 0        ? t("nav.turn_right")
    : abs < 120 && relBear < 0       ? t("nav.sharp_left")
    : abs < 120 && relBear > 0       ? t("nav.sharp_right")
    :                                  t("nav.uturn");

  // Canvas corridor
  useEffect(()=>{
    const cv=cvRef.current; if(!cv) return;
    const W=cv.offsetWidth||360, H=cv.offsetHeight||220;
    cv.width=W; cv.height=H;
    const ctx=cv.getContext("2d");
    ctx.clearRect(0,0,W,H);
    if(arriving){ return; } // pas de corridor si arrivée
    const clamp=Math.max(-40,Math.min(40,relBear??0));
    const vx=W/2+(clamp/40)*(W*0.26), vy=H*0.28;
    const g=ctx.createLinearGradient(W/2,H,vx,vy);
    g.addColorStop(0,`rgba(59,130,246,0.40)`);
    g.addColorStop(0.6,`rgba(59,130,246,0.10)`);
    g.addColorStop(1,`rgba(59,130,246,0)`);
    ctx.beginPath();
    ctx.moveTo(W/2-52,H); ctx.lineTo(vx-4,vy);
    ctx.lineTo(vx+4,vy);  ctx.lineTo(W/2+52,H);
    ctx.closePath(); ctx.fillStyle=g; ctx.fill();
    ctx.beginPath(); ctx.setLineDash([9,6]);
    ctx.moveTo(W/2,H); ctx.lineTo(vx,vy);
    ctx.strokeStyle="rgba(147,197,253,0.55)";
    ctx.lineWidth=1.5; ctx.stroke(); ctx.setLineDash([]);
    [[-52,-4],[52,4]].forEach(([b,t])=>{
      ctx.beginPath();
      ctx.moveTo(W/2+b,H); ctx.lineTo(vx+t,vy);
      ctx.strokeStyle="rgba(59,130,246,0.42)";
      ctx.lineWidth=1; ctx.stroke();
    });
    for(let i=1;i<=3;i++){
      const t=i/4, px=W/2+(vx-W/2)*t, py=H+(vy-H)*t, hw=52-51*t;
      ctx.beginPath(); ctx.moveTo(px-hw,py); ctx.lineTo(px+hw,py);
      ctx.strokeStyle=`rgba(59,130,246,${0.15*(1-t)})`; ctx.lineWidth=0.8; ctx.stroke();
    }
  },[relBear,arriving]);

  // Rotation flèche clampée visuellement à ±82° max
  const arrowRot = arriving ? 0 : Math.max(-82,Math.min(82, relBear??0));

  return (
    <>
      {/* Corridor canvas */}
      <canvas ref={cvRef} style={{
        position:"absolute",bottom:0,left:0,width:"100%",height:"45%",
        pointerEvents:"none",zIndex:11
      }}/>

      {/* Flèche directionnelle */}
      <div style={{
        position:"absolute", top:"18%", left:"50%",
        transform:"translate(-50%,-50%)",
        zIndex:18, pointerEvents:"none",
        display:"flex", flexDirection:"column", alignItems:"center", gap:6,
      }}>
        {/* SVG arrow + glow */}
        <div style={{
          transform:`rotate(${arrowRot}deg)`,
          transition:"transform 0.13s ease-out",
          filter:`drop-shadow(0 0 10px ${col})`,
        }}>
          <svg width="52" height="66" viewBox="0 0 52 66" fill="none">
            {/* Head */}
            <polygon points="26,2 50,38 35,32 35,64 17,64 17,32 2,38"
              fill={col} opacity="0.92"
              stroke="rgba(255,255,255,0.25)" strokeWidth="1"/>
            {/* Center spine highlight */}
            <line x1="26" y1="8" x2="26" y2="56"
              stroke="rgba(255,255,255,0.3)" strokeWidth="1"/>
          </svg>
        </div>

        {/* Distance */}
        <div style={{
          color:col, fontSize:26, fontFamily:C.fnt, fontWeight:700,
          textShadow:`0 0 16px ${col}80`, lineHeight:1,
        }}>{fDist(dist)}</div>

        {/* Direction label */}
        <div style={{
          background:"rgba(8,12,15,0.75)",
          border:`1px solid ${col}55`,
          borderRadius:4, padding:"4px 12px",
          color:col, fontSize:8, fontFamily:C.fnt,
          letterSpacing:2, fontWeight:700,
          textShadow:`0 0 8px ${col}`,
        }}>{dirLabel}</div>

        {/* Station name */}
        <div style={{
          color:"rgba(255,255,255,0.55)", fontSize:8,
          fontFamily:C.fnt, letterSpacing:1,
        }}>{name}</div>
      </div>

      {/* Cercle d'arrivée pulsant */}
      {arriving&&(
        <div style={{
          position:"absolute", top:"40%", left:"50%",
          transform:"translate(-50%,-50%)",
          zIndex:17, pointerEvents:"none",
          width:120, height:120, borderRadius:"50%",
          border:`2px solid ${C.good}`,
          boxShadow:`0 0 30px ${C.good}40, inset 0 0 30px ${C.good}15`,
          animation:"pulse 1s ease-in-out infinite",
        }}/>
      )}
    </>
  );
}

// ── CITY BG ───────────────────────────────────────────────────────

function CityBG() {
  return (
    <svg style={{ position:"absolute",inset:0,width:"100%",height:"100%" }}
      viewBox="0 0 400 600" preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0d2010"/><stop offset="100%" stopColor="#152a18"/>
        </linearGradient>
        <linearGradient id="rg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0e1a0e"/><stop offset="100%" stopColor="#1a2a1a"/>
        </linearGradient>
      </defs>
      <rect width="400" height="600" fill="#0a1a12"/>
      <rect width="400" height="280" fill="url(#sg)"/>
      <polygon points="80,380 320,380 400,600 0,600" fill="url(#rg)"/>
      {[0,1,2].map(i=><rect key={`l${i}`} x={i*35} y={180-i*20} width={30} height={200+i*20}
        fill={`rgba(10,${25+i*5},12,0.9)`} stroke="rgba(50,100,50,0.15)" strokeWidth="0.5"/>)}
      {[0,1,2].map(i=><rect key={`r${i}`} x={290+i*35} y={160+i*15} width={28} height={220-i*15}
        fill={`rgba(8,${20+i*4},10,0.9)`} stroke="rgba(50,100,50,0.12)" strokeWidth="0.5"/>)}
      {[0,1,2,3].map(i=><rect key={`m${i}`} x={197} y={420+i*50} width={6} height={28}
        fill="rgba(255,140,0,0.2)" rx="1"/>)}
      <rect width="400" height="600" fill="rgba(0,0,0,0.22)"/>
    </svg>
  );
}

// ── STATUS BAR ────────────────────────────────────────────────────

function CheckeredFlag({ scale=1, col="#fff", isSel=false }) {
  const w=22*scale, h=14*scale, mH=28*scale;
  const sq=w/6; // 6 colonnes × 4 lignes
  const bright = isSel ? 1 : 0.82;
  return (
    <div style={{
      position:"absolute",
      // centré horizontalement sur le dot, juste au-dessus
      bottom:"100%", left:"50%",
      transform:"translateX(-50%)",
      pointerEvents:"none",
      display:"flex", flexDirection:"column", alignItems:"flex-start",
      gap:0, marginBottom:2,
      animation:"flagWave 1.8s ease-in-out infinite",
      transformOrigin:"bottom center",
      opacity: isSel ? 1 : 0.75 + scale*0.25,
    }}>
      {/* Drapeau damier SVG */}
      <svg width={w} height={h} viewBox="0 0 36 24"
        style={{ filter: isSel ? `drop-shadow(0 0 5px ${col})` : "none",
          display:"block" }}>
        {/* Fond blanc damier */}
        {[0,1,2,3,4,5].map(cx=>
          [0,1,2,3].map(cy=>{
            const isBlack=(cx+cy)%2===0;
            return <rect key={`${cx}-${cy}`}
              x={cx*6} y={cy*6} width={6} height={6}
              fill={isBlack?"#111":"#eee"} opacity={bright}/>;
          })
        )}
        {/* Bordure fine */}
        <rect x={0} y={0} width={36} height={24}
          fill="none" stroke={isSel?col:"rgba(255,255,255,0.3)"} strokeWidth={0.8}/>
      </svg>
      {/* Mât */}
      <div style={{
        width: Math.max(1,1.5*scale),
        height: mH,
        background:`rgba(255,255,255,${0.5+scale*0.4})`,
        boxShadow: isSel ? `0 0 4px ${col}` : "none",
        borderRadius:1,
        marginLeft: 0,
      }}/>
    </div>
  );
}

// ── AR PIN ────────────────────────────────────────────────────────

function ARPin({ s, sel, setSel, pulse }) {
  const col=bCol(s), isSel=sel===s.id;
  const scale=s.scale??1;
  const isCluster = !!s.cluster;

  // Taille : cluster plus gros, pin normal ou sélectionné encore plus
  const dotSize = isCluster
    ? Math.round(18*scale)
    : Math.round((isSel?14:9)*scale);

  const clusterCol = s.cluster?.bikes > 0 ? C.good : C.bad;

  return (
    <div onPointerDown={()=>{ if (!isCluster) setSel(isSel?null:s.id); }}
      style={{ position:"absolute", left:`${s.x}%`, top:`${s.y}%`,
        transform:"translate(-50%,-50%)", cursor: isCluster?"default":"pointer",
        zIndex:isSel?25:isCluster?10:14, padding:14, margin:-14 }}>

      {/* Drapeau damier au-dessus (seulement sur pins individuels) */}
      {!isCluster&&(
        <div style={{ position:"absolute", bottom:"50%", left:"50%",
          transform:"translateX(-50%)", pointerEvents:"none", zIndex:3 }}>
          <CheckeredFlag scale={scale} col={col} isSel={isSel}/>
        </div>
      )}

      {/* Pulse ring */}
      {!isCluster&&(
        <div style={{ position:"absolute", top:14, left:14, width:dotSize, height:dotSize,
          borderRadius:"50%", boxShadow:`0 0 0 ${pulse?10:3}px ${col}22`,
          transition:"box-shadow 1s", pointerEvents:"none" }}/>
      )}

      {isCluster ? (
        /* ── Cluster badge ── */
        <div style={{
          width:dotSize*2, height:dotSize*2, borderRadius:"50%",
          background:"rgba(8,12,15,0.88)",
          border:`2px solid ${clusterCol}`,
          boxShadow:`0 0 ${12*scale}px ${clusterCol}60`,
          display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
          position:"relative", zIndex:2,
        }}>
          <div style={{ color:clusterCol, fontSize:Math.round(11*scale), fontFamily:C.fnt, fontWeight:700, lineHeight:1 }}>
            {s.cluster.count}
          </div>
          <div style={{ color:C.muted, fontSize:Math.round(6*scale), fontFamily:C.fnt, lineHeight:1 }}>
            stations
          </div>
          {s.cluster.bikes > 0 && (
            <div style={{ color:C.good, fontSize:Math.round(7*scale), fontFamily:C.fnt }}>
              {s.cluster.bikes}🚲
            </div>
          )}
        </div>
      ) : (
        /* ── Dot individuel ── */
        <div style={{ width:dotSize, height:dotSize, borderRadius:"50%", background:col,
          border:`2px solid ${isSel?"#fff":"rgba(0,0,0,0.55)"}`,
          boxShadow:`0 0 ${8*scale}px ${col}`,
          transform:isSel?"scale(1.4)":"scale(1)", transition:"transform 0.15s",
          position:"relative", zIndex:2 }}/>
      )}

      {/* Distance badge (pins individuels uniquement) */}
      {!isCluster&&(
        <div style={{
          position:"absolute", top:"50%", transform:"translateY(-50%)",
          ...(s.labelRight?{left:dotSize+6}:{right:dotSize+6}),
          background:"rgba(6,10,14,0.88)", border:`1px solid ${isSel?col:col+"44"}`,
          borderRadius:4, padding:"3px 7px", whiteSpace:"nowrap", pointerEvents:"none",
          boxShadow:isSel?`0 0 14px ${col}40`:"none", transition:"border-color 0.15s",
        }}>
          <div style={{ color:isSel?col:C.text, fontSize:9, fontFamily:C.fnt, fontWeight:700 }}>{s.name}</div>
          <div style={{ display:"flex", gap:5, marginTop:1, alignItems:"center" }}>
            <span style={{ color:col, fontSize:12, fontFamily:C.fnt, fontWeight:900 }}>{s.bikes}</span>
            {s.elec>0&&<span style={{ color:"#60A5FA", fontSize:7 }}>⚡{s.elec}</span>}
            <span style={{ color:C.muted, fontSize:7 }}>{fDist(s.dist)}</span>
          </div>
        </div>
      )}

      {/* Distance cluster */}
      {isCluster&&(
        <div style={{
          position:"absolute", top:"50%", left:"50%",
          transform:"translate(-50%, calc(-50% - " + (dotSize+8) + "px))",
          background:"rgba(6,10,14,0.75)", border:`1px solid ${clusterCol}33`,
          borderRadius:3, padding:"2px 5px", whiteSpace:"nowrap", pointerEvents:"none",
        }}>
          <span style={{ color:C.muted, fontSize:7, fontFamily:C.fnt }}>{fDist(s.cluster.dist)}</span>
        </div>
      )}
    </div>
  );
}

// ── AR SCREEN ─────────────────────────────────────────────────────


function ARScreen({ stations, sel, setSel, gpsPos, trip, onStartTrip, mapsKey="" }) {
  const vidRef=useRef(null);
  const [cam,   setCam]  =useState("idle");
  const [pulse, setPulse]=useState(false);
  const {heading,perm,start:startCompass}=useCompass();

  // ── Navigation AR ───────────────────────────────────────────────
  const [navMode, setNavMode] = useState(null);   // null | "cycling" | "walking"
  const navStation = stations.find(s=>s.id===sel);
  // mapsKey reçu en prop depuis Root (réactif si l'utilisateur le change dans Settings)
  const { route, loading: routeLoading, error: routeError } =
    useRoute(gpsPos, navMode ? navStation : null, navMode||"cycling", mapsKey);

  const startNav = useCallback(async(mode)=>{
    if (navStation) {
      const native = await launchNativeArNav(
        navStation.lat, navStation.lng, navStation.name,
        mode === "walking" ? "walking" : "bicycling",
        mapsKey   // transmis au module ARCore natif
      );
      if (!native) setNavMode(mode); // fallback web AR
    }
  },[navStation, mapsKey]);

  const stopNav = useCallback(()=>setNavMode(null),[]);

  // Auto-démarrer la nav si l'utilisateur vient de taper AR VÉLO/PIED depuis MAP
  useEffect(()=>{
    const pendingMode = localStorage.getItem("velohnav_pendingNavMode");
    const pendingId   = localStorage.getItem("velohnav_pendingNavId");
    if (pendingMode && pendingId) {
      localStorage.removeItem("velohnav_pendingNavMode");
      localStorage.removeItem("velohnav_pendingNavId");
      // Déclencher la navigation (startNav vérifie navStation via sel)
      // On attend que la caméra soit prête, sinon on démarre la nav silencieusement
      const station = stations.find(s=>String(s.id)===pendingId);
      if (station) {
        setSel(station.id);
        // Petit délai pour que navStation soit bien à jour
        const t = setTimeout(()=>startNav(pendingMode === "walking" ? "walking" : "cycling"), 300);
        return ()=>clearTimeout(t);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  useEffect(()=>{
    const t=setInterval(()=>setPulse(p=>!p),1100);
    return()=>clearInterval(t);
  },[]);

  // ── Activation unique : caméra + boussole dans le même geste ──
  const startAR=useCallback(async()=>{
    setCam("requesting");
    // Boussole en premier (iOS 13 : requestPermission doit être dans le geste)
    await startCompass();
    // Puis caméra
    try{
      const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"}});
      if(vidRef.current){vidRef.current.srcObject=stream; await vidRef.current.play();}
      setCam("active");
    }catch(e){console.warn("Cam:",e);setCam("denied");}
  },[startCompass]);

  useEffect(()=>{
    const vid=vidRef.current;
    return()=>{vid?.srcObject?.getTracks().forEach(t=>t.stop());};
  },[]);

  // ── Projection AR réelle ───────────────────────────────────────
  const arPins=useMemo(()=>{
    if(heading===null||!gpsPos) return null;
    const AR_RADIUS = 800; // m — uniquement les stations proches en AR
    const AR_MAX    = 5;   // max 5 pins à l'écran
    return stations
      .filter(s=>s.lat&&s.lng&&s.dist<=AR_RADIUS)
      .map(s=>{
        const bear=getBearing(gpsPos.lat,gpsPos.lng,s.lat,s.lng);
        const rel=((bear-heading+540)%360)-180;
        if(Math.abs(rel)>FOV/2+8) return null;
        const x=50+(rel/(FOV/2))*50;
        const dc=Math.min(s.dist,AR_RADIUS);
        const y=70-(1-dc/AR_RADIUS)*44;
        const scale=Math.max(0.5,1-dc/(AR_RADIUS*1.5));
        return{...s,x,y,scale,labelRight:rel<0,rel};
      })
      .filter(Boolean)
      .sort((a,b)=>a.dist-b.dist)  // plus proche = devant
      .slice(0,AR_MAX);
  },[heading,gpsPos,stations]);

  const fakePins=useMemo(()=>pins(stations,heading,gpsPos),[stations,heading,gpsPos]);

  // ── Clustering — groupe les stations proches dans le FOV ──────────
  // Évite la surcharge visuelle quand beaucoup de pins se superposent.
  // En dessous de 500m : pins individuels. Au-delà : clusters si ≥2 stations dans un rayon de 6% écran.
  const clusteredPins = useMemo(()=>{
    const raw = arPins ?? fakePins;
    if (!raw.length) return [];

    const CLUSTER_R = 6; // % écran — rayon de regroupement
    const used = new Set();
    const result = [];

    raw.forEach((pin, i) => {
      if (used.has(i)) return;
      // Stations à moins de 200m → toujours individuelles (rayon AR limité à 800m)
      if (pin.dist < 200) { result.push({ ...pin, cluster: null }); return; }
      // Chercher les voisins dans le FOV
      const neighbors = raw.filter((p2, j) => {
        if (j === i || used.has(j)) return false;
        const dx = Math.abs(p2.x - pin.x), dy = Math.abs(p2.y - pin.y);
        return Math.hypot(dx, dy) < CLUSTER_R;
      });
      if (neighbors.length === 0) {
        result.push({ ...pin, cluster: null });
      } else {
        // Créer un cluster centré sur le pin le plus proche
        const all = [pin, ...neighbors];
        neighbors.forEach((_, j) => used.add(raw.indexOf(neighbors[j])));
        used.add(i);
        const cx = all.reduce((s,p)=>s+p.x,0)/all.length;
        const cy = all.reduce((s,p)=>s+p.y,0)/all.length;
        const totalBikes = all.reduce((s,p)=>s+p.bikes,0);
        const minDist = Math.min(...all.map(p=>p.dist));
        result.push({
          ...pin, x:cx, y:cy, scale:pin.scale,
          cluster: { count: all.length, bikes: totalBikes, dist: minDist },
        });
      }
    });
    return result;
  },[arPins, fakePins]);

  const visiblePins = clusteredPins;

  // ── Nav overlay ────────────────────────────────────────────────
  const navRel=useMemo(()=>{
    if(!navStation||!gpsPos||heading===null) return null;
    const bear=getBearing(gpsPos.lat,gpsPos.lng,navStation.lat,navStation.lng);
    return((bear-heading+540)%360)-180;
  },[navStation,gpsPos,heading]);

  const hdg=heading!==null?Math.round(heading):null;
  const cardLabel=hdg!==null?COMPASS_LABELS[Math.round(hdg/45)%8]:"?";

  // ── Status boussole pour l'UI ──────────────────────────────────
  const compassStatus=()=>{
    if(perm==="idle")       return{label:"APPUIE SUR ACTIVER AR",col:C.muted};
    if(perm==="requesting") return{label:t("ar.init"),col:C.warn};
    if(perm==="denied")     return{label:t("ar.compass_denied"),col:C.bad};
    if(perm==="unavailable")return{label:t("ar.compass_unavail"),col:C.bad};
    if(perm==="nosignal")   return{label:t("ar.compass_nosignal"),col:C.bad};
    if(heading===null)      return{label:t("ar.compass_waiting"),col:C.warn};
    return{label:`${t("ar.active")} · ${hdg}° ${cardLabel}`,col:C.good};
  };
  const cs=compassStatus();
  // Afficher l'aide calibration si nosignal et caméra active
  const showCalib = perm==="nosignal" || (perm==="granted" && heading===null && cam==="active");

  return (
    <div style={{position:"relative",flex:1,overflow:"hidden",minHeight:0,background:"#000"}}>

      <video ref={vidRef} muted playsInline autoPlay style={{
        position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover",zIndex:1,
        opacity:cam==="active"?1:0,transition:"opacity 0.5s"}}/>
      {cam!=="active"&&<div style={{position:"absolute",inset:0,zIndex:2}}><CityBG/></div>}

      <div style={{position:"absolute",inset:0,zIndex:5,pointerEvents:"none"}}>
        <div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse at center,transparent 30%,rgba(0,0,0,0.35) 100%)"}}/>
        <div style={{position:"absolute",top:0,left:0,right:0,height:70,background:"linear-gradient(to bottom,rgba(8,12,15,0.65),transparent)"}}/>
        <div style={{position:"absolute",bottom:0,left:0,right:0,height:230,background:"linear-gradient(to top,rgba(8,12,15,0.98),rgba(8,12,15,0.4) 60%,transparent)"}}/>
      </div>

      {navRel!==null&&!navMode&&<NavOverlay relBear={navRel} dist={navStation?.dist??0} name={navStation?.name??""}/>}

      {/* Route AR overlay — tracé OSRM/Google projeté sur caméra */}
      {navMode&&(
        <RouteOverlay
          key={`${navStation?.id}-${navMode}`}
          route={route} gpsPos={gpsPos} heading={heading}
          mode={navMode} onClose={stopNav}
        />
      )}
      {/* Chargement itinéraire */}
      {navMode&&routeLoading&&(
        <div style={{position:"absolute",top:"50%",left:"50%",
          transform:"translate(-50%,-50%)",zIndex:30,
          background:"rgba(8,12,15,0.9)",border:`1px solid ${C.border}`,
          borderRadius:8,padding:"14px 22px",textAlign:"center"}}>
          <div style={{color:C.accent,fontSize:10,fontFamily:C.fnt,letterSpacing:2}}>{t("ar.nav_loading")}</div>
        </div>
      )}
      {navMode&&routeError&&(
        <div style={{position:"absolute",top:"50%",left:"50%",
          transform:"translate(-50%,-50%)",zIndex:30,
          background:"rgba(8,12,15,0.9)",border:`1px solid ${C.bad}`,
          borderRadius:8,padding:"14px 22px",textAlign:"center"}}>
          <div style={{color:C.bad,fontSize:9,fontFamily:C.fnt}}>{routeError}</div>
          <div onPointerDown={stopNav}
            style={{color:C.muted,fontSize:8,fontFamily:C.fnt,marginTop:8,cursor:"pointer"}}>✕ Fermer</div>
        </div>
      )}

      {/* Compass strip */}
      <div style={{position:"absolute",top:10,left:"50%",transform:"translateX(-50%)",zIndex:20,pointerEvents:"none"}}>
        <div style={{background:"rgba(8,12,15,0.82)",border:`1px solid ${C.border}`,borderRadius:3,padding:"3px 14px",width:184,overflow:"hidden"}}>
          {hdg!==null?(
            <div style={{color:C.accent,fontSize:7,fontFamily:C.fnt,letterSpacing:2,whiteSpace:"nowrap",
              transform:`translateX(${-(hdg%60)*2.8}px)`,transition:"transform 0.08s linear"}}>
              {"N···NE···E···SE···S···SO···O···NO···N···NE···E···SE"}
            </div>
          ):(
            <div style={{color:C.muted,fontSize:7,fontFamily:C.fnt,textAlign:"center",letterSpacing:1}}>
              ···
            </div>
          )}
        </div>
        <div style={{color:C.accent,fontSize:8,textAlign:"center",lineHeight:"4px"}}>▾</div>
      </div>

      {/* Horizon + crosshair */}
      <div style={{position:"absolute",top:"46%",left:0,right:0,height:1,zIndex:6,pointerEvents:"none",
        background:`linear-gradient(to right,transparent,${C.accent}45,${C.accent}45,transparent)`}}/>
      <div style={{position:"absolute",top:"46%",left:"50%",transform:"translate(-50%,-50%)",pointerEvents:"none",zIndex:6}}>
        <svg width="26" height="26" viewBox="0 0 26 26">
          <circle cx="13" cy="13" r="4" fill="none" stroke={`${C.accent}45`} strokeWidth="1"/>
          <line x1="13" y1="0" x2="13" y2="7" stroke={`${C.accent}45`} strokeWidth="1"/>
          <line x1="13" y1="19" x2="13" y2="26" stroke={`${C.accent}45`} strokeWidth="1"/>
          <line x1="0" y1="13" x2="7" y2="13" stroke={`${C.accent}45`} strokeWidth="1"/>
          <line x1="19" y1="13" x2="26" y2="13" stroke={`${C.accent}45`} strokeWidth="1"/>
        </svg>
      </div>

      {/* Bouton activation — caméra + boussole en un seul tap */}
      {cam!=="active"&&(
        <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",
          zIndex:30,display:"flex",flexDirection:"column",alignItems:"center",gap:14}}>
          {(cam==="idle")&&(
            <>
              <div style={{color:C.muted,fontSize:9,fontFamily:C.fnt,letterSpacing:3}}>VUE AR VELOHNAV</div>
              <button onPointerDown={startAR} style={{
                background:C.accentBg,border:`1px solid ${C.accent}`,color:C.accent,
                borderRadius:5,padding:"12px 32px",fontSize:12,fontFamily:C.fnt,
                fontWeight:700,cursor:"pointer",letterSpacing:2,boxShadow:`0 0 20px ${C.accent}25`}}>
                {t("ar.activate")}
              </button>
              <div style={{color:C.muted,fontSize:8,fontFamily:C.fnt,textAlign:"center",lineHeight:1.6}}>
                {t("ar.camera_mic")}
              </div>
            </>
          )}
          {cam==="requesting"&&(
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:8}}>
              <div style={{color:C.accent,fontSize:10,fontFamily:C.fnt,letterSpacing:3}}>INITIALISATION…</div>
              <div style={{color:C.muted,fontSize:8,fontFamily:C.fnt}}>{cs.label}</div>
            </div>
          )}
          {cam==="denied"&&(
            <div style={{textAlign:"center",padding:"0 32px"}}>
              <div style={{color:C.bad,fontSize:10,fontFamily:C.fnt,marginBottom:8}}>{t("ar.denied")}</div>
              <div style={{color:C.muted,fontSize:9,fontFamily:C.fnt,lineHeight:1.7}}>
                Paramètres → Apps → VelohNav → Autorisations → Caméra
              </div>
              <button onPointerDown={startAR} style={{
                background:"rgba(224,62,62,0.1)",border:`1px solid ${C.bad}`,color:C.bad,
                borderRadius:4,padding:"8px 20px",fontSize:9,fontFamily:C.fnt,
                cursor:"pointer",marginTop:12}}>{t("ar.retry")}</button>
            </div>
          )}
        </div>
      )}

      {/* Status bar boussole (cam active) */}
      {cam==="active"&&(
        <div style={{position:"absolute",top:44,left:12,zIndex:20,pointerEvents:"none"}}>
          <div style={{background:`rgba(0,0,0,0.55)`,border:`1px solid ${cs.col}30`,
            borderRadius:3,padding:"3px 8px"}}>
            <span style={{color:cs.col,fontSize:7,fontFamily:C.fnt,letterSpacing:1}}>{cs.label}</span>
          </div>
        </div>
      )}

      {/* Overlay calibration boussole — affiché si pas de signal après 4s */}
      {showCalib&&cam==="active"&&(
        <div style={{
          position:"absolute",top:"28%",left:"50%",
          transform:"translate(-50%,-50%)",
          zIndex:32,
          background:"rgba(8,12,15,0.93)",
          border:`1px solid ${C.accent}66`,
          borderRadius:12,padding:"18px 22px",
          textAlign:"center",maxWidth:260,
          boxShadow:`0 0 30px rgba(0,0,0,0.7)`,
        }}>
          {/* Animation figure en 8 SVG */}
          <svg width="60" height="44" viewBox="0 0 60 44" style={{marginBottom:8}}>
            <path d="M30,22 C30,22 10,4 10,14 C10,24 30,22 30,22 C30,22 50,20 50,30 C50,40 30,22 30,22 Z"
              fill="none" stroke={C.accent} strokeWidth="2" strokeLinecap="round" opacity="0.8">
              <animate attributeName="stroke-dashoffset" from="200" to="0" dur="2s" repeatCount="indefinite"/>
              <animate attributeName="stroke-dasharray" from="0 200" to="200 0" dur="2s" repeatCount="indefinite"/>
            </path>
            <text x="30" y="44" textAnchor="middle" fill={C.accent} fontSize="9"
              fontFamily="'Courier New',monospace">∞</text>
          </svg>
          <div style={{color:C.accent,fontSize:10,fontFamily:C.fnt,fontWeight:700,
            letterSpacing:1.5,marginBottom:6}}>
            {t("ar.calib_title")}
          </div>
          <div style={{color:C.muted,fontSize:8,fontFamily:C.fnt,lineHeight:1.7}}>
            {t("ar.calib_desc")}
          </div>
          {perm==="nosignal"&&(
            <div style={{color:"#666",fontSize:7,fontFamily:C.fnt,marginTop:8}}>
              {t("ar.calib_hint")}
            </div>
          )}
        </div>
      )}

      {/* Pins */}
      <div style={{position:"absolute",inset:0,zIndex:15}}>
        {visiblePins.map(s=><ARPin key={s.id} s={s} sel={sel} setSel={setSel} pulse={pulse}/>)}
      </div>

      {/* Bottom panel */}
      <div style={{position:"absolute",bottom:0,left:0,right:0,padding:"0 14px 14px",zIndex:22}}>
        {navStation?(
          <div style={{background:"rgba(8,12,15,0.97)",borderRadius:8,padding:"13px 15px",
            border:`1px solid ${C.border}`,borderTop:`2px solid ${bCol(navStation)}`,
            boxShadow:"0 -4px 24px rgba(0,0,0,0.85)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:11}}>
              <div>
                <div style={{color:C.muted,fontSize:7,fontFamily:C.fnt,letterSpacing:1.5,marginBottom:3}}>
                  {bTag(navStation)} · {fDist(navStation.dist)} · {fWalk(navStation.dist)} à pied
                  {navRel!==null&&` · cap ${Math.round(((heading??0)+navRel+360)%360)}° ${
                    COMPASS_LABELS[Math.round((((heading??0)+navRel+360)%360)/45)%8]}`}
                  {navStation._mock&&" · dispo simulées"}
                </div>
                <div style={{color:C.text,fontSize:15,fontFamily:C.fnt,fontWeight:700}}>{navStation.name}</div>
              </div>
              <div onPointerDown={()=>setSel(null)} style={{padding:"6px 9px",
                background:"rgba(255,255,255,0.04)",border:`1px solid ${C.border}`,
                borderRadius:4,color:C.muted,fontSize:11,cursor:"pointer"}}>✕</div>
            </div>
            <div style={{display:"flex",borderTop:`1px solid ${C.border}`,paddingTop:11}}>
              {[
                {l:t("station.bikes"),v:navStation.bikes,col:bCol(navStation)},
                {l:"⚡ ÉLEC.",v:navStation.elec, col:"#60A5FA"},
                {l:"🔧 MÉCA.",v:navStation.meca, col:C.text},
                {l:t("station.docks"),v:navStation.docks,col:C.good},
                {l:t("station.capacity"),  v:navStation.cap,  col:C.muted},
              ].map((m,i)=>(
                <div key={m.l} style={{flex:1,textAlign:"center",borderRight:i<3?`1px solid ${C.border}`:"none"}}>
                  <div style={{color:m.col,fontSize:20,fontFamily:C.fnt,fontWeight:700}}>{m.v}</div>
                  <div style={{color:C.muted,fontSize:7,fontFamily:C.fnt,letterSpacing:1,marginTop:1}}>{m.l}</div>
                </div>
              ))}
            </div>
            {/* Boutons navigation AR */}
            {!navMode&&(
              <div style={{display:"flex",gap:6,marginTop:10}}>
                <div onPointerDown={()=>startNav("cycling")}
                  style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:5,
                    background:"rgba(59,130,246,0.12)",border:`1px solid #3B82F644`,
                    borderRadius:6,padding:"8px 0",cursor:"pointer"}}>
                  <span style={{fontSize:13}}>🚲</span>
                  <span style={{color:"#3B82F6",fontSize:8,fontFamily:C.fnt,fontWeight:700,letterSpacing:1}}>{t("ar.nav_cycling")}</span>
                </div>
                <div onPointerDown={()=>startNav("walking")}
                  style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:5,
                    background:"rgba(167,139,250,0.12)",border:`1px solid #A78BFA44`,
                    borderRadius:6,padding:"8px 0",cursor:"pointer"}}>
                  <span style={{fontSize:13}}>🚶</span>
                  <span style={{color:"#A78BFA",fontSize:8,fontFamily:C.fnt,fontWeight:700,letterSpacing:1}}>{t("ar.nav_walking")}</span>
                </div>
              </div>
            )}
            {navMode&&(
              <div onPointerDown={stopNav}
                style={{marginTop:10,textAlign:"center",padding:"7px",
                  background:"rgba(224,62,62,0.1)",border:`1px solid ${C.bad}44`,
                  borderRadius:6,cursor:"pointer"}}>
                <span style={{color:C.bad,fontSize:8,fontFamily:C.fnt,fontWeight:700}}>{t("ar.nav_stop")}</span>
              </div>
            )}
          </div>
        ):(
          <div style={{background:"rgba(8,12,15,0.85)",border:`1px solid ${C.border}`,
            borderRadius:8,padding:"11px 15px",textAlign:"center"}}>
            <div style={{color:C.muted,fontSize:8,fontFamily:C.fnt,letterSpacing:2}}>
              {arPins
                ? t("ar.stations_in_view", {n: arPins.length})
                : cam==="active"
                  ? "BOUSSOLE REQUISE · ACTIVE AR POUR VOIR LES PINS"
                  : `${stations.filter(s=>s.bikes>0).length}/${stations.length} DISPO · ACTIVE LA CAMÉRA`}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── LUX MAP SVG SKETCH ───────────────────────────────────────────

export default ARScreen;
