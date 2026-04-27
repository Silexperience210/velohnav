// ── GhostPin — Pin AR du fantôme du meilleur temps ─────────────────
// Projette la position fantôme calculée par useGhostTrail sur le canvas AR.
// Affiche un indicateur de delta (avance/retard) flottant + visuel "vélo
// orange semi-transparent" qui suit le tracé du best run.
import { C, FOV } from "../../constants.js";
import { haversine, getBearing } from "../../utils.js";

function GhostPin({ ghostPos, gpsPos, heading, currentDelta, hasGhost, bestTime }) {
  if (!hasGhost || !ghostPos || !gpsPos || heading === null) return null;
  if (ghostPos.finished) return null;

  // Projection sur AR
  const dist = haversine(gpsPos.lat, gpsPos.lng, ghostPos.lat, ghostPos.lng);
  // Si trop loin, juste afficher un indicateur en haut sans pin
  const showPin = dist <= 300;
  const bear = getBearing(gpsPos.lat, gpsPos.lng, ghostPos.lat, ghostPos.lng);
  const rel  = ((bear - heading + 540) % 360) - 180;
  const inFov = Math.abs(rel) <= FOV / 2 + 8;

  const x = 50 + (Math.max(-FOV/2, Math.min(FOV/2, rel)) / (FOV/2)) * 50;
  const y = 70 - (1 - Math.min(dist, 300) / 300) * 40;

  // Status delta — couleur
  const isAhead = currentDelta < -2;   // on bat le record de >2s
  const isBehind = currentDelta > 5;   // on est en retard de >5s
  const deltaCol = isAhead ? C.good : isBehind ? C.bad : C.warn;
  const deltaSign = currentDelta >= 0 ? "+" : "";

  return (
    <>
      {/* Pin fantôme dans la scène AR (si visible dans le FOV) */}
      {showPin && inFov && (
        <div style={{
          position:"absolute",
          left:`${Math.max(8, Math.min(92, x))}%`,
          top:`${y}%`,
          transform:"translate(-50%, -100%)",
          zIndex:17,
          pointerEvents:"none",
          opacity: 0.7,
          filter: "drop-shadow(0 0 6px #F5820D)",
          animation: "ghostFloat 2s ease-in-out infinite",
        }}>
          <style>{`
            @keyframes ghostFloat {
              0%,100% { transform: translate(-50%,-100%) translateY(0); }
              50%     { transform: translate(-50%,-100%) translateY(-3px); }
            }
            @keyframes ghostPulse {
              0%,100% { opacity: 0.55; }
              50%     { opacity: 0.85; }
            }
          `}</style>
          {/* Vélo emoji + halo */}
          <div style={{
            background: "rgba(245,130,13,0.18)",
            border: `1.5px dashed ${C.accent}`,
            borderRadius: 6, padding: "4px 9px",
            display: "flex", alignItems: "center", gap: 6,
            backdropFilter: "blur(2px)",
            animation: "ghostPulse 1.5s ease-in-out infinite",
          }}>
            <span style={{fontSize:16, filter:"hue-rotate(15deg)"}}>👻</span>
            <div style={{textAlign:"left"}}>
              <div style={{
                color: C.accent, fontSize: 7, fontFamily: C.fnt,
                letterSpacing: 1, fontWeight: 700,
              }}>FANTÔME</div>
              <div style={{
                color: deltaCol, fontSize: 9, fontFamily: C.fnt, fontWeight: 700,
              }}>
                {deltaSign}{currentDelta}s
              </div>
            </div>
          </div>
          {/* Tige vers le sol */}
          <div style={{
            width:1, height:14, margin:"0 auto",
            background:`linear-gradient(${C.accent},transparent)`,
          }}/>
          <div style={{
            width:6, height:6, borderRadius:"50%",
            background:C.accent, margin:"0 auto",
            boxShadow:`0 0 8px ${C.accent}`,
          }}/>
        </div>
      )}

      {/* Indicateur permanent en haut à gauche — toujours visible quand ghost actif */}
      <div style={{
        position:"absolute", top:78, left:12, zIndex:21,
        pointerEvents:"none",
        background:"rgba(8,12,15,0.85)",
        border:`1px solid ${deltaCol}66`,
        borderRadius:5, padding:"4px 8px",
        display:"flex", alignItems:"center", gap:6,
        boxShadow: isAhead ? `0 0 10px ${C.good}55` : "none",
      }}>
        <span style={{fontSize:11}}>👻</span>
        <div style={{display:"flex",flexDirection:"column",gap:1}}>
          <div style={{color:C.muted,fontSize:6,fontFamily:C.fnt,letterSpacing:1}}>
            {isAhead ? "RECORD EN VUE" : isBehind ? "RETARD" : "AU COUDE À COUDE"}
          </div>
          <div style={{color:deltaCol,fontSize:9,fontFamily:C.fnt,fontWeight:700}}>
            {deltaSign}{currentDelta}s {!showPin && "· loin"}
          </div>
        </div>
      </div>
    </>
  );
}

export default GhostPin;
