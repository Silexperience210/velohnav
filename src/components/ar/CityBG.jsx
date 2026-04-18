// ── CityBG — arrière-plan cyberpunk quand caméra inactive ──────────
// SVG stylisé affiché derrière l'écran d'activation AR.
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

export default CityBG;
