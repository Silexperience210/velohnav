// ── ObstaclePin — affichage AR des obstacles signalés ──────────────
// Projette les obstacles Nostr sur la vue AR, avec halo coloré selon type.
import { useState } from "react";
import { C, FOV } from "../../constants.js";
import { haversine, getBearing } from "../../utils.js";
import { OBSTACLE_TYPES } from "../../hooks/useObstacles.js";

export function ObstaclePins({ obstacles, gpsPos, heading }) {
  if (!obstacles?.length || !gpsPos || heading === null) return null;

  return (
    <>
      {obstacles.map(o => {
        const dist = haversine(gpsPos.lat, gpsPos.lng, o.lat, o.lng);
        if (dist > 500) return null;
        const bear = getBearing(gpsPos.lat, gpsPos.lng, o.lat, o.lng);
        const rel  = ((bear - heading + 540) % 360) - 180;
        if (Math.abs(rel) > FOV/2 + 8) return null;
        const x = 50 + (rel / (FOV/2)) * 50;
        const y = 72 - (1 - Math.min(dist, 500)/500) * 38;
        const meta = OBSTACLE_TYPES[o.type];
        if (!meta) return null;
        const ageMin = Math.round((Date.now() - o.createdAt) / 60000);
        return (
          <div key={o.id} style={{
            position:"absolute",
            left:`${Math.max(6, Math.min(94, x))}%`,
            top:`${y}%`,
            transform:"translate(-50%,-100%)",
            zIndex:14, pointerEvents:"none",
            display:"flex", flexDirection:"column", alignItems:"center",
            filter:`drop-shadow(0 0 8px ${meta.color})`,
          }}>
            <div style={{
              background:"rgba(8,12,15,0.92)",
              border:`2px solid ${meta.color}`,
              borderRadius:6, padding:"4px 7px",
              display:"flex", alignItems:"center", gap:5,
              animation:"obsPulse 1.6s ease-in-out infinite",
            }}>
              <style>{`
                @keyframes obsPulse {
                  0%,100% { box-shadow: 0 0 6px ${meta.color}66; }
                  50%     { box-shadow: 0 0 14px ${meta.color}aa; }
                }
              `}</style>
              <span style={{fontSize:13}}>{meta.icon}</span>
              <div>
                <div style={{color:meta.color,fontSize:7,fontFamily:C.fnt,fontWeight:700,letterSpacing:1}}>
                  {meta.label.toUpperCase()}
                </div>
                <div style={{color:C.muted,fontSize:6,fontFamily:C.fnt}}>
                  {Math.round(dist)}m · il y a {ageMin}min
                </div>
              </div>
            </div>
            <div style={{width:1,height:10,background:`linear-gradient(${meta.color},transparent)`}}/>
            <div style={{width:5,height:5,borderRadius:"50%",background:meta.color,
              boxShadow:`0 0 6px ${meta.color}`}}/>
          </div>
        );
      })}
    </>
  );
}

// ── ObstacleReportMenu — menu radial de signalement ───────────────
// Apparait sur long-press de la zone AR. L'user choisit un type → publish Nostr.
export function ObstacleReportMenu({ visible, onClose, onReport, lat, lng }) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);

  if (!visible) return null;

  const handleReport = async (type) => {
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await onReport({ type, lat, lng, note: "" });
      if (res?.success) {
        setFeedback({ type: "success", msg: `Signalé sur ${res.relaysSent} relais Nostr` });
        setTimeout(onClose, 1400);
      } else {
        setFeedback({ type: "error", msg: "Aucun relais joignable" });
      }
    } catch (e) {
      setFeedback({ type: "error", msg: e.message });
    }
    setBusy(false);
  };

  return (
    <div style={{
      position:"absolute", inset:0, zIndex:50,
      background:"rgba(0,0,0,0.65)",
      display:"flex", alignItems:"center", justifyContent:"center",
      backdropFilter:"blur(3px)",
    }} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background:"rgba(8,12,15,0.97)",
        border:`2px solid ${C.accent}`,
        borderRadius:12, padding:"18px 20px",
        maxWidth:300, width:"calc(100% - 40px)",
        boxShadow:`0 0 32px ${C.accent}66`,
      }}>
        <div style={{
          color:C.accent, fontSize:9, fontFamily:C.fnt,
          letterSpacing:2, fontWeight:700, textAlign:"center", marginBottom:4,
        }}>
          ⚠️ SIGNALER UN OBSTACLE
        </div>
        <div style={{
          color:C.muted, fontSize:8, fontFamily:C.fnt,
          textAlign:"center", marginBottom:14,
        }}>
          Publié anonymement sur Nostr · expire en 24h
        </div>

        <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:8}}>
          {Object.entries(OBSTACLE_TYPES).map(([key, m]) => (
            <div key={key} onPointerDown={() => handleReport(key)}
              style={{
                background:`${m.color}15`,
                border:`1px solid ${m.color}66`,
                borderRadius:6, padding:"12px 8px",
                display:"flex", flexDirection:"column", alignItems:"center", gap:5,
                cursor: busy ? "wait" : "pointer",
                opacity: busy ? 0.5 : 1,
                transition:"all 0.15s",
              }}>
              <span style={{fontSize:22}}>{m.icon}</span>
              <span style={{
                color:m.color, fontSize:9, fontFamily:C.fnt,
                fontWeight:700, letterSpacing:1, textAlign:"center",
              }}>{m.label.toUpperCase()}</span>
            </div>
          ))}
        </div>

        {feedback && (
          <div style={{
            marginTop:11, padding:"6px 9px",
            background: feedback.type === "success" ? `${C.good}22` : `${C.bad}22`,
            border: `1px solid ${feedback.type === "success" ? C.good : C.bad}66`,
            borderRadius:5, textAlign:"center",
          }}>
            <span style={{
              color: feedback.type === "success" ? C.good : C.bad,
              fontSize:9, fontFamily:C.fnt,
            }}>
              {feedback.type === "success" ? "✓" : "✗"} {feedback.msg}
            </span>
          </div>
        )}

        <div onPointerDown={onClose} style={{
          marginTop:11, textAlign:"center", padding:"6px",
          background:"rgba(255,255,255,0.04)",
          border:`1px solid ${C.border}`,
          borderRadius:5, cursor:"pointer",
        }}>
          <span style={{color:C.muted,fontSize:9,fontFamily:C.fnt,letterSpacing:1.5}}>
            ANNULER
          </span>
        </div>
      </div>
    </div>
  );
}
