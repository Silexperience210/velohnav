// ── NavOverlay — corridor directionnel vers destination active ──────
// Affiche une flèche 3D + distance + nom quand une station est sélectionnée
// mais que la nav AR n'est pas encore active (pré-launch).
import { useEffect, useRef } from "react";
import { t } from "../../i18n.js";
import { C } from "../../constants.js";
import { fDist } from "../../utils.js";

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

export default NavOverlay;
