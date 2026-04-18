// ── ARPin — pin station Vel'OH! projeté en réalité augmentée ──────
// Affiche le drapeau + nom + distance + bouton d'interaction.
import { C } from "../../constants.js";
import { bCol, fDist } from "../../utils.js";
import CheckeredFlag from "./CheckeredFlag.jsx";

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

export default ARPin;
