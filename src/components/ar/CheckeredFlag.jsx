// ── CheckeredFlag — drapeau damier flottant au-dessus des pins AR ────
// SVG inline cyberpunk. Taille et opacité pilotées par scale (distance).
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

export default CheckeredFlag;
