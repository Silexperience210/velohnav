import { useState, useEffect, useRef } from "react";

const C = {
  bg:"#080c0f", border:"rgba(255,255,255,0.07)",
  accent:"#F5820D", accentBg:"rgba(245,130,13,0.12)",
  good:"#2ECC8F", warn:"#F5820D", bad:"#E03E3E",
  blue:"#3B82F6", text:"#E2E6EE", muted:"#4A5568",
  fnt:"'Courier New', monospace",
};

// ── UTILS ─────────────────────────────────────────────────────────
function haversine(la1,ln1,la2,ln2) {
  const R=6371000,dL=(la2-la1)*Math.PI/180,dl=(ln2-ln1)*Math.PI/180;
  const a=Math.sin(dL/2)**2+Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dl/2)**2;
  return Math.round(R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)));
}
const fDist = m => m<1000 ? `${m}m` : `${(m/1000).toFixed(1)}km`;
const fWalk = m => `${Math.round(m/80)} min`;
const bCol  = s => s.status==="CLOSED"?"#444":s.bikes===0?C.bad:s.bikes<=2?C.warn:C.good;
const bTag  = s => s.status==="CLOSED"?"FERMÉ":s.bikes===0?"VIDE":s.bikes<=2?"FAIBLE":"DISPO";

// ── DONNÉES — GPS réels Luxembourg ────────────────────────────────
const USER = { lat:49.6080, lng:6.1295 }; // Ville-Haute

const RAW = [
  { id:1,  name:"Gare Centrale",       lat:49.59995, lng:6.13385, cap:20, b:7,  e:5 },
  { id:4,  name:"Place d'Armes",       lat:49.61118, lng:6.13091, cap:15, b:5,  e:4 },
  { id:2,  name:"Hamilius",            lat:49.61143, lng:6.12975, cap:25, b:2,  e:1 },
  { id:7,  name:"Clausen",             lat:49.61021, lng:6.14437, cap:12, b:4,  e:3 },
  { id:14, name:"Kirchberg MUDAM",     lat:49.61921, lng:6.15178, cap:22, b:9,  e:7 },
  { id:21, name:"Limpertsberg",        lat:49.61571, lng:6.12462, cap:20, b:3,  e:2 },
  { id:33, name:"Bonnevoie",           lat:49.59650, lng:6.13750, cap:18, b:0,  e:0 },
  { id:45, name:"Belair",              lat:49.60890, lng:6.11940, cap:16, b:6,  e:4 },
];

const STATIONS = RAW.map(s => ({
  id:s.id, name:s.name, lat:s.lat, lng:s.lng,
  cap:s.cap, bikes:s.b, elec:s.e, meca:s.b-s.e,
  docks:s.cap-s.b, status:s.b===0&&s.id===33?"CLOSED":"OPEN",
  dist: haversine(USER.lat,USER.lng,s.lat,s.lng),
})).sort((a,b)=>a.dist-b.dist);

// ── PIN POSITIONS — grille 3 cols, sans collision ─────────────────
const PIN_GRID = STATIONS.slice(0,6).map((s,i) => ({
  ...s,
  px: 13 + (i%3) * 34,
  py: 28 + Math.floor(i/3) * 38,
  right: (i%3) < 2,
}));

// ── ANIMATED CITY BG ──────────────────────────────────────────────
function CityBackground({ offset }) {
  // Faux décor de rue animé — lignes de fuite qui bougent
  const s = offset % 80;
  return (
    <svg style={{ position:"absolute",inset:0,width:"100%",height:"100%" }}
      viewBox="0 0 400 600" preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0d2010"/>
          <stop offset="100%" stopColor="#152a18"/>
        </linearGradient>
        <linearGradient id="road" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0e1a0e"/>
          <stop offset="100%" stopColor="#1a2a1a"/>
        </linearGradient>
      </defs>
      {/* Ciel */}
      <rect width="400" height="600" fill="#0a1a12"/>
      {/* Nuances de ciel */}
      <rect width="400" height="280" fill="url(#sky)"/>
      {/* Route */}
      <polygon points="80,380 320,380 400,600 0,600" fill="url(#road)"/>
      {/* Bâtiments gauche */}
      {[0,1,2].map(i=>(
        <rect key={i} x={i*35} y={180-i*20} width={30} height={200+i*20}
          fill={`rgba(10,${25+i*5},12,0.9)`} stroke="rgba(50,100,50,0.15)" strokeWidth="0.5"/>
      ))}
      {/* Bâtiments droite */}
      {[0,1,2].map(i=>(
        <rect key={i} x={290+i*35} y={160+i*15} width={28} height={220-i*15}
          fill={`rgba(8,${20+i*4},10,0.9)`} stroke="rgba(50,100,50,0.12)" strokeWidth="0.5"/>
      ))}
      {/* Marquage route animé */}
      {[0,1,2,3].map(i=>(
        <rect key={i} x={197} y={420+i*50-(s*0.6)%50} width={6} height={28}
          fill="rgba(255,140,0,0.2)" rx="1"/>
      ))}
      {/* Reflets sol */}
      <ellipse cx="200" cy="580" rx="120" ry="20" fill="rgba(255,140,0,0.04)"/>
      {/* Overlay grain */}
      <rect width="400" height="600" fill="rgba(0,0,0,0.25)"/>
    </svg>
  );
}

// ── STATUS BAR ────────────────────────────────────────────────────
function StatusBar({ tab }) {
  const [t,setT] = useState(new Date());
  useEffect(()=>{ const i=setInterval(()=>setT(new Date()),1000); return()=>clearInterval(i); },[]);
  const LABELS = { ar:"AUGMENTED REALITY", map:"CARTE", ai:"ASSISTANT", settings:"PARAMÈTRES" };
  return (
    <div style={{ padding:"9px 14px", display:"flex", justifyContent:"space-between", alignItems:"center",
      background:"rgba(8,12,15,0.97)", borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
        <div style={{ width:4, height:20, background:C.accent, boxShadow:`0 0 6px ${C.accent}` }}/>
        <div>
          <div style={{ color:C.text, fontSize:13, fontWeight:700, fontFamily:C.fnt, letterSpacing:3 }}>
            VELOH<span style={{ color:C.accent }}>NAV</span>
          </div>
          <div style={{ color:C.muted, fontSize:7, fontFamily:C.fnt, letterSpacing:1 }}>{LABELS[tab]}</div>
        </div>
      </div>
      <div style={{ display:"flex", gap:5, alignItems:"center" }}>
        <div style={{ display:"flex", alignItems:"center", gap:3, padding:"3px 7px",
          background:"rgba(0,0,0,0.4)", border:`1px solid ${C.border}`, borderRadius:3 }}>
          <div style={{ width:5, height:5, borderRadius:"50%", background:C.good, boxShadow:`0 0 4px ${C.good}` }}/>
          <span style={{ color:C.good, fontSize:7, fontFamily:C.fnt }}>VILLE-HAUTE</span>
        </div>
        <div style={{ color:C.text, fontSize:11, fontFamily:C.fnt, fontWeight:700,
          padding:"3px 7px", background:"rgba(0,0,0,0.4)", border:`1px solid ${C.border}`, borderRadius:3 }}>
          {t.toLocaleTimeString("fr",{hour:"2-digit",minute:"2-digit"})}
        </div>
      </div>
    </div>
  );
}

// ── AR PIN ────────────────────────────────────────────────────────
function ARPin({ s, sel, setSel, pulse }) {
  const col  = bCol(s);
  const isSel = sel === s.id;
  return (
    <div onPointerDown={() => setSel(isSel ? null : s.id)}
      style={{ position:"absolute", left:`${s.px}%`, top:`${s.py}%`,
        transform:"translate(-50%,-50%)", cursor:"pointer", zIndex:isSel?25:14,
        padding:14, margin:-14 /* zone de tap large */ }}>
      {/* Ring pulsé */}
      <div style={{ position:"absolute", top:14, left:14, width:13, height:13, borderRadius:"50%",
        boxShadow:`0 0 0 ${pulse?10:3}px ${col}22`, transition:"box-shadow 1s", pointerEvents:"none" }}/>
      {/* Point central */}
      <div style={{ width:13, height:13, borderRadius:"50%", background:col,
        border:`2px solid ${isSel?"#fff":"rgba(0,0,0,0.55)"}`,
        boxShadow:`0 0 10px ${col}`,
        transform:isSel?"scale(1.45)":"scale(1)", transition:"transform 0.15s",
        position:"relative", zIndex:2 }}/>
      {/* Étiquette */}
      <div style={{
        position:"absolute", top:"50%", transform:"translateY(-50%)",
        ...(s.right ? { left:22 } : { right:22 }),
        background:"rgba(6,10,14,0.94)",
        border:`1px solid ${isSel ? col : col+"55"}`,
        borderRadius:5, padding:"5px 9px", whiteSpace:"nowrap",
        boxShadow: isSel ? `0 0 16px ${col}40` : "none",
        pointerEvents:"none", transition:"border-color 0.15s, box-shadow 0.15s",
      }}>
        <div style={{ color:isSel?col:C.text, fontSize:10, fontFamily:C.fnt, fontWeight:700 }}>
          {s.name}
        </div>
        <div style={{ display:"flex", gap:7, marginTop:2, alignItems:"center" }}>
          <span style={{ color:col, fontSize:13, fontFamily:C.fnt, fontWeight:900 }}>{s.bikes}</span>
          {s.elec>0 && <span style={{ color:"#60A5FA", fontSize:8 }}>⚡{s.elec}</span>}
          <span style={{ color:C.muted, fontSize:8 }}>{fDist(s.dist)}</span>
        </div>
      </div>
    </div>
  );
}

// ── AR SCREEN ─────────────────────────────────────────────────────
function ARScreen({ sel, setSel }) {
  const [hdg,  setHdg]  = useState(0);
  const [bgOff,setBgOff] = useState(0);
  const [pulse,setPulse] = useState(false);

  useEffect(()=>{
    const t = setInterval(()=>{
      setHdg(h=>(h+0.08)%360);
      setBgOff(o=>o+0.5);
    }, 50);
    return ()=>clearInterval(t);
  },[]);
  useEffect(()=>{ const t=setInterval(()=>setPulse(p=>!p),1100); return()=>clearInterval(t); },[]);

  const station = STATIONS.find(s=>s.id===sel);

  return (
    <div style={{ position:"relative", flex:1, overflow:"hidden", minHeight:0 }}>
      {/* Fond animé simulant une rue */}
      <CityBackground offset={bgOff}/>

      {/* Vignette + fades HUD */}
      <div style={{ position:"absolute", inset:0, zIndex:4, pointerEvents:"none" }}>
        <div style={{ position:"absolute", inset:0,
          background:"radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,0.45) 100%)"}}/>
        <div style={{ position:"absolute", top:0, left:0, right:0, height:70,
          background:"linear-gradient(to bottom, rgba(8,12,15,0.7), transparent)"}}/>
        <div style={{ position:"absolute", bottom:0, left:0, right:0, height:230,
          background:"linear-gradient(to top, rgba(8,12,15,0.98), rgba(8,12,15,0.4) 60%, transparent)"}}/>
      </div>

      {/* Boussole */}
      <div style={{ position:"absolute", top:10, left:"50%", transform:"translateX(-50%)", zIndex:20, pointerEvents:"none" }}>
        <div style={{ background:"rgba(8,12,15,0.82)", border:`1px solid ${C.border}`,
          borderRadius:3, padding:"3px 14px", width:184, overflow:"hidden" }}>
          <div style={{ color:C.accent, fontSize:7, fontFamily:C.fnt, letterSpacing:3, whiteSpace:"nowrap",
            transform:`translateX(${-(hdg%60)*2.8}px)`, transition:"transform 0.05s linear" }}>
            {"N···NE···E···SE···S···SW···W···NW···N···NE···E···SE···S···SW"}
          </div>
        </div>
        <div style={{ color:C.accent, fontSize:8, textAlign:"center", lineHeight:"4px" }}>▾</div>
      </div>

      {/* Horizon */}
      <div style={{ position:"absolute", top:"46%", left:0, right:0, height:1, zIndex:5, pointerEvents:"none",
        background:`linear-gradient(to right, transparent, ${C.accent}45, ${C.accent}45, transparent)` }}/>

      {/* Réticule */}
      <div style={{ position:"absolute", top:"46%", left:"50%", transform:"translate(-50%,-50%)",
        pointerEvents:"none", zIndex:5 }}>
        <svg width="26" height="26" viewBox="0 0 26 26">
          <circle cx="13" cy="13" r="4" fill="none" stroke={`${C.accent}45`} strokeWidth="1"/>
          <line x1="13" y1="0" x2="13" y2="7" stroke={`${C.accent}45`} strokeWidth="1"/>
          <line x1="13" y1="19" x2="13" y2="26" stroke={`${C.accent}45`} strokeWidth="1"/>
          <line x1="0" y1="13" x2="7" y2="13" stroke={`${C.accent}45`} strokeWidth="1"/>
          <line x1="19" y1="13" x2="26" y2="13" stroke={`${C.accent}45`} strokeWidth="1"/>
        </svg>
      </div>

      {/* AR Pins */}
      <div style={{ position:"absolute", inset:0, zIndex:15 }}>
        {PIN_GRID.map(s => <ARPin key={s.id} s={s} sel={sel} setSel={setSel} pulse={pulse}/>)}
      </div>

      {/* Badge PROTOTYPE */}
      <div style={{ position:"absolute", top:12, right:12, zIndex:20, pointerEvents:"none",
        background:"rgba(0,0,0,0.6)", border:`1px solid ${C.border}`,
        borderRadius:3, padding:"3px 7px" }}>
        <span style={{ color:C.muted, fontSize:7, fontFamily:C.fnt, letterSpacing:2 }}>PROTOTYPE</span>
      </div>

      {/* Carte info bottom */}
      <div style={{ position:"absolute", bottom:0, left:0, right:0, padding:"0 14px 14px", zIndex:22 }}>
        {station ? (
          <div style={{ background:"rgba(8,12,15,0.97)", borderRadius:8, padding:"13px 15px",
            border:`1px solid ${C.border}`, borderTop:`2px solid ${bCol(station)}`,
            boxShadow:"0 -4px 24px rgba(0,0,0,0.85)" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:11 }}>
              <div>
                <div style={{ color:C.muted, fontSize:7, fontFamily:C.fnt, letterSpacing:1.5, marginBottom:3 }}>
                  {bTag(station)} · {fDist(station.dist)} · {fWalk(station.dist)} à pied
                </div>
                <div style={{ color:C.text, fontSize:15, fontFamily:C.fnt, fontWeight:700 }}>{station.name}</div>
              </div>
              <div onPointerDown={()=>setSel(null)} style={{ padding:"6px 9px",
                background:"rgba(255,255,255,0.04)", border:`1px solid ${C.border}`,
                borderRadius:4, color:C.muted, fontSize:11, cursor:"pointer" }}>✕</div>
            </div>
            <div style={{ display:"flex", borderTop:`1px solid ${C.border}`, paddingTop:11 }}>
              {[
                { l:"VÉLOS",  v:station.bikes, col:bCol(station) },
                { l:"ÉLEC.",  v:station.elec,  col:"#60A5FA"     },
                { l:"MÉCA.",  v:station.meca,  col:C.text        },
                { l:"DOCKS",  v:station.docks, col:C.text        },
              ].map((m,i)=>(
                <div key={m.l} style={{ flex:1, textAlign:"center",
                  borderRight:i<3?`1px solid ${C.border}`:"none" }}>
                  <div style={{ color:m.col, fontSize:20, fontFamily:C.fnt, fontWeight:700 }}>{m.v}</div>
                  <div style={{ color:C.muted, fontSize:7, fontFamily:C.fnt, letterSpacing:1, marginTop:1 }}>{m.l}</div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ background:"rgba(8,12,15,0.85)", border:`1px solid ${C.border}`,
            borderRadius:8, padding:"11px 15px", textAlign:"center" }}>
            <div style={{ color:C.muted, fontSize:8, fontFamily:C.fnt, letterSpacing:2 }}>
              {STATIONS.filter(s=>s.bikes>0).length}/{STATIONS.length} DISPONIBLES · TOUCHE UN PIN AR
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── MAP SCREEN ────────────────────────────────────────────────────
function MapScreen({ sel, setSel }) {
  const margin=0.006;
  const lats=STATIONS.map(s=>s.lat), lngs=STATIONS.map(s=>s.lng);
  const ltMin=Math.min(...lats)-margin, ltMax=Math.max(...lats)+margin;
  const lnMin=Math.min(...lngs)-margin, lnMax=Math.max(...lngs)+margin;
  const toXY=(la,ln)=>({
    x:(ln-lnMin)/(lnMax-lnMin)*88+6,
    y:(1-(la-ltMin)/(ltMax-ltMin))*86+5,
  });
  const ux=toXY(USER.lat,USER.lng);

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", background:C.bg, minHeight:0 }}>
      <div style={{ flex:1, position:"relative", margin:"8px 14px",
        background:"rgba(0,0,0,0.5)", border:`1px solid ${C.border}`,
        borderRadius:8, overflow:"hidden" }}>
        <svg style={{ position:"absolute",inset:0,width:"100%",height:"100%",opacity:0.04 }}>
          <defs><pattern id="mg" width="44" height="44" patternUnits="userSpaceOnUse">
            <path d="M44 0L0 0 0 44" fill="none" stroke={C.accent} strokeWidth="0.5"/>
          </pattern></defs>
          <rect width="100%" height="100%" fill="url(#mg)"/>
        </svg>
        <div style={{ position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",
          color:`${C.accent}04`,fontSize:32,fontFamily:C.fnt,fontWeight:700,
          userSelect:"none",whiteSpace:"nowrap" }}>LUXEMBOURG</div>

        {STATIONS.map(s=>{
          const {x,y}=toXY(s.lat,s.lng); const col=bCol(s); const act=sel===s.id;
          return (
            <div key={s.id} onPointerDown={()=>setSel(act?null:s.id)}
              style={{ position:"absolute",left:`${x}%`,top:`${y}%`,
                transform:"translate(-50%,-50%)",width:44,height:44,
                display:"flex",alignItems:"center",justifyContent:"center",
                cursor:"pointer",zIndex:act?15:8 }}>
              {act&&<div style={{ position:"absolute",inset:2,borderRadius:"50%",
                border:`1.5px solid ${col}`,opacity:0.5 }}/>}
              <div style={{ width:act?14:10,height:act?14:10,borderRadius:"50%",
                background:col,boxShadow:`0 0 7px ${col}`,
                border:`2px solid ${act?"#fff":"rgba(0,0,0,0.5)"}`,transition:"all 0.18s" }}/>
              <div style={{ position:"absolute",
                left:x>55?"auto":42,right:x>55?42:"auto",
                top:"50%",transform:"translateY(-50%)",
                background:"rgba(8,12,15,0.94)",
                border:`1px solid ${act?col:C.border}`,borderRadius:3,
                padding:"3px 7px",whiteSpace:"nowrap",
                boxShadow:act?`0 0 8px ${col}25`:"none",pointerEvents:"none" }}>
                <div style={{ color:act?col:C.muted,fontSize:9,fontFamily:C.fnt,fontWeight:act?700:400 }}>
                  {s.name}
                </div>
                <div style={{ color:C.muted,fontSize:7,fontFamily:C.fnt }}>
                  {s.bikes}🚲 ⚡{s.elec} · {fDist(s.dist)}
                </div>
              </div>
            </div>
          );
        })}

        {/* Position utilisateur */}
        <div style={{ position:"absolute",left:`${ux.x}%`,top:`${ux.y}%`,
          transform:"translate(-50%,-50%)",zIndex:20,pointerEvents:"none" }}>
          <div style={{ position:"absolute",inset:-8,borderRadius:"50%",
            border:"2px solid rgba(59,130,246,0.5)"}}/>
          <div style={{ width:10,height:10,borderRadius:"50%",
            background:C.blue,boxShadow:`0 0 10px ${C.blue}` }}/>
        </div>
      </div>

      <div style={{ display:"flex",gap:12,padding:"7px 14px 10px",borderTop:`1px solid ${C.border}` }}>
        {[[C.good,"Dispo"],[C.warn,"Faible"],[C.bad,"Vide"],["#444","Fermé"],[C.blue,"Vous"]].map(([c,l])=>(
          <div key={l} style={{ display:"flex",alignItems:"center",gap:4 }}>
            <div style={{ width:7,height:7,borderRadius:"50%",background:c,boxShadow:`0 0 4px ${c}` }}/>
            <span style={{ color:C.muted,fontSize:7,fontFamily:C.fnt }}>{l}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── AI SCREEN — vrai appel Claude API ────────────────────────────
const SYSTEM_PROMPT = `Tu es VELOH·AI, l'assistant de l'app VelohNav pour le réseau Vel'OH! de Luxembourg.
Tu réponds en français, de façon concise et utile (3-4 lignes max).
Tu connais les données temps réel des stations :

${STATIONS.map(s =>
  `• ${s.name} | ${s.bikes} vélos (⚡${s.elec} élec.) | ${s.docks} docks libres | ${fDist(s.dist)} | ${bTag(s)}`
).join("\n")}

Position utilisateur : Ville-Haute, Luxembourg.
Réponds uniquement sur la mobilité, les stations Veloh, les itinéraires, ou l'app.`;

function AIScreen() {
  const [history, setHistory] = useState([]);
  const [display, setDisplay] = useState([{
    role:"ai",
    text:`${STATIONS.filter(s=>s.bikes>0).length}/${STATIONS.length} stations disponibles. Plus proche avec vélos : ${STATIONS.find(s=>s.bikes>0)?.name} (${fDist(STATIONS.find(s=>s.bikes>0)?.dist||0)}, ${STATIONS.find(s=>s.bikes>0)?.bikes}🚲 ⚡${STATIONS.find(s=>s.bikes>0)?.elec}).`
  }]);
  const [input, setInput] = useState("");
  const [busy,  setBusy]  = useState(false);
  const endRef = useRef();
  useEffect(()=>endRef.current?.scrollIntoView({behavior:"smooth"}),[display]);

  const sendText = async (text) => {
    const userText = (text || input).trim();
    if (!userText || busy) return;
    setInput("");
    setBusy(true);
    setDisplay(d => [...d, { role:"user", text:userText }]);
    const newHistory = [...history, { role:"user", content:userText }];
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({
          model:"claude-sonnet-4-20250514",
          max_tokens:300,
          system: SYSTEM_PROMPT,
          messages: newHistory,
        }),
      });
      const data = await res.json();
      const reply = data.content?.[0]?.text ?? "Erreur de réponse.";
      setHistory([...newHistory, { role:"assistant", content:reply }]);
      setDisplay(d => [...d, { role:"ai", text:reply }]);
    } catch {
      setDisplay(d => [...d, { role:"ai", text:"Erreur réseau. Vérifie ta connexion." }]);
    }
    setBusy(false);
  };

  const send = () => sendText(input);

  const QUICK = [
    "Quelle station est la plus proche ?",
    "Combien de vélos électriques dispo ?",
    "Où déposer mon vélo ?",
    "Suggestion d'itinéraire Hamilius → Kirchberg",
  ];

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", background:C.bg, minHeight:0 }}>
      <div style={{ padding:"9px 14px 7px", borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
        <div style={{ color:C.accent, fontSize:10, fontFamily:C.fnt, fontWeight:700, letterSpacing:2 }}>VELOH·AI</div>
        <div style={{ color:C.muted, fontSize:8, fontFamily:C.fnt }}>
          Claude · {STATIONS.length} stations · Luxembourg Vel'OH!
        </div>
      </div>

      <div style={{ flex:1, overflowY:"auto", padding:"11px 14px", display:"flex", flexDirection:"column", gap:9 }}>
        {display.map((m,i) => (
          <div key={i} style={{ alignSelf:m.role==="user"?"flex-end":"flex-start", maxWidth:"88%" }}>
            {m.role==="ai" && (
              <div style={{ color:C.accent, fontSize:7, fontFamily:C.fnt, letterSpacing:2, marginBottom:3 }}>VELOH·AI</div>
            )}
            <div style={{
              background:m.role==="user" ? C.accentBg : "rgba(255,255,255,0.04)",
              border:`1px solid ${m.role==="user" ? C.accent+"55" : C.border}`,
              borderRadius:m.role==="user" ? "10px 10px 2px 10px" : "10px 10px 10px 2px",
              padding:"9px 12px",
            }}>
              <div style={{ color:m.role==="user"?C.accent:C.text, fontSize:10,
                fontFamily:C.fnt, lineHeight:1.7, whiteSpace:"pre-wrap" }}>
                {m.text}
              </div>
            </div>
          </div>
        ))}

        {busy && (
          <div style={{ alignSelf:"flex-start" }}>
            <div style={{ color:C.accent, fontSize:7, fontFamily:C.fnt, letterSpacing:2, marginBottom:3 }}>VELOH·AI</div>
            <div style={{ background:"rgba(255,255,255,0.04)", border:`1px solid ${C.border}`,
              borderRadius:"10px 10px 10px 2px", padding:"10px 14px", display:"flex", gap:6, alignItems:"center" }}>
              {[0,1,2].map(i => (
                <div key={i} style={{ width:6, height:6, borderRadius:"50%", background:C.accent,
                  opacity:0.7, transform:`scale(${i===1?1.2:0.8})` }}/>
              ))}
              <span style={{ color:C.muted, fontSize:8, fontFamily:C.fnt, marginLeft:4 }}>en train de répondre…</span>
            </div>
          </div>
        )}
        <div ref={endRef}/>
      </div>

      {/* Suggestions rapides */}
      <div style={{ display:"flex", gap:6, padding:"5px 14px 7px", overflowX:"auto", flexShrink:0 }}>
        {QUICK.map(q => (
          <div key={q} onPointerDown={()=>{ setInput(q); setTimeout(()=>{ sendText(q); },0); }}
            style={{ flexShrink:0, background:"transparent",
              border:`1px solid ${C.border}`, color:C.muted,
              borderRadius:14, padding:"4px 10px",
              fontSize:8, fontFamily:C.fnt, cursor:"pointer", whiteSpace:"nowrap" }}>
            {q}
          </div>
        ))}
      </div>

      <div style={{ display:"flex", gap:8, padding:"7px 14px 13px",
        borderTop:`1px solid ${C.border}`, flexShrink:0 }}>
        <input
          value={input}
          onChange={e=>setInput(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&send()}
          placeholder="Pose n'importe quelle question sur Veloh…"
          style={{ flex:1, background:"rgba(255,255,255,0.03)",
            border:`1px solid ${C.border}`, borderRadius:5,
            padding:"9px 11px", color:C.text, fontSize:10,
            fontFamily:C.fnt, outline:"none" }}
        />
        <div onPointerDown={send} style={{
          background: busy ? "rgba(255,255,255,0.04)" : C.accentBg,
          border:`1px solid ${busy ? C.border : C.accent}`,
          color:busy ? C.muted : C.accent,
          borderRadius:5, padding:"9px 16px",
          fontSize:11, fontFamily:C.fnt, fontWeight:700, cursor:busy?"not-allowed":"pointer",
        }}>▶</div>
      </div>
    </div>
  );
}

// ── SETTINGS ──────────────────────────────────────────────────────
function SettingsScreen() {
  const [lnAddr,setLnAddr] = useState(""); const [lnOn,setLnOn] = useState(false);
  const [lnSaved,setLnSaved] = useState(false); const [ads,setAds] = useState(true);

  const Toggle=({label,sub,val,set})=>(
    <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",
      padding:"11px 0",borderBottom:`1px solid ${C.border}` }}>
      <div style={{ flex:1,marginRight:12 }}>
        <div style={{ color:C.text,fontSize:11,fontFamily:C.fnt }}>{label}</div>
        {sub&&<div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,marginTop:2,lineHeight:1.5 }}>{sub}</div>}
      </div>
      <div onPointerDown={()=>set(v=>!v)} style={{ width:38,height:20,borderRadius:10,cursor:"pointer",
        position:"relative",flexShrink:0,
        background:val?C.accentBg:"rgba(255,255,255,0.04)",
        border:`1px solid ${val?C.accent:C.border}`,
        boxShadow:val?`0 0 8px ${C.accent}30`:"none",transition:"all 0.2s" }}>
        <div style={{ position:"absolute",top:3,width:14,height:14,borderRadius:"50%",
          background:val?C.accent:C.muted,left:val?21:3,transition:"left 0.2s,background 0.2s" }}/>
      </div>
    </div>
  );

  return (
    <div style={{ flex:1,overflowY:"auto",background:C.bg,minHeight:0 }}>
      {/* Note prototype */}
      <div style={{ margin:"14px 14px 0",background:"rgba(59,130,246,0.08)",
        border:`1px solid rgba(59,130,246,0.3)`,borderRadius:7,padding:"11px 13px" }}>
        <div style={{ color:C.blue,fontSize:9,fontFamily:C.fnt,fontWeight:700,marginBottom:4 }}>
          ℹ PROTOTYPE WEB
        </div>
        <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,lineHeight:1.8 }}>
          GPS et caméra réels non disponibles dans ce sandbox.{"\n"}
          En app Android native : ARCore + FusedLocationProvider.{"\n"}
          API JCDecaux : CORS bloqué navigateur → natif OK.
        </div>
      </div>

      {/* LN Rewards */}
      <div style={{ padding:"14px 14px 0" }}>
        <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,letterSpacing:2,marginBottom:10 }}>⚡ SATS REWARDS</div>
        <div style={{ background:"rgba(255,255,255,0.02)",border:`1px solid ${C.border}`,
          borderRadius:8,padding:"0 14px" }}>
          <Toggle label="Activer les récompenses" sub="Sats envoyés sur ta LN Address après chaque trajet validé" val={lnOn} set={setLnOn}/>
          {lnOn&&(
            <div style={{ paddingBottom:14 }}>
              <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,letterSpacing:2,margin:"10px 0 6px" }}>LIGHTNING ADDRESS</div>
              <div style={{ display:"flex",gap:8 }}>
                <input value={lnAddr} onChange={e=>setLnAddr(e.target.value)} placeholder="toi@getalby.com"
                  style={{ flex:1,background:"rgba(0,0,0,0.4)",border:`1px solid ${C.border}`,
                    borderRadius:4,padding:"8px 10px",color:"#FCD34D",fontSize:11,fontFamily:C.fnt,outline:"none" }}/>
                <div onPointerDown={()=>{setLnSaved(true);setTimeout(()=>setLnSaved(false),2000);}} style={{
                  background:lnSaved?"rgba(46,204,143,0.15)":C.accentBg,
                  border:`1px solid ${lnSaved?C.good:C.accent}`,color:lnSaved?C.good:C.accent,
                  borderRadius:4,padding:"8px 12px",fontSize:9,fontFamily:C.fnt,cursor:"pointer",fontWeight:700,whiteSpace:"nowrap" }}>
                  {lnSaved?"✓ OK":"SAVE"}
                </div>
              </div>
              <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,marginTop:7,lineHeight:1.8 }}>
                Alby · WoS · Phoenix · Blink · Zeus{"\n"}LNURL-pay · self-custodial · zéro serveur
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={{ padding:"14px" }}>
        <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,letterSpacing:2,marginBottom:10 }}>APPLICATION</div>
        <div style={{ background:"rgba(255,255,255,0.02)",border:`1px solid ${C.border}`,borderRadius:8,padding:"0 14px" }}>
          <Toggle label="Publicités AR" sub="Overlays sponsors dans la vue caméra" val={ads} set={setAds}/>
        </div>
      </div>

      <div style={{ padding:"0 14px 20px" }}>
        <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,lineHeight:2,borderTop:`1px solid ${C.border}`,paddingTop:12 }}>
          API cible : GET /vls/v3/stations?contract=Luxembourg{"\n"}
          available_bikes · electrical_bikes · mechanical_bikes{"\n"}
          available_bike_stands · status · position.lat/lng · last_update{"\n"}
          {STATIONS.length} stations mockées · 116 réelles dans le réseau Veloh
        </div>
      </div>
    </div>
  );
}

// ── NAV ───────────────────────────────────────────────────────────
function NavBar({ tab, setTab }) {
  return (
    <div style={{ display:"flex",background:"rgba(8,12,15,0.98)",borderTop:`1px solid ${C.border}`,flexShrink:0 }}>
      {[{id:"ar",i:"⬡",l:"AR"},{id:"map",i:"◈",l:"MAP"},{id:"ai",i:"◎",l:"AI"},{id:"settings",i:"≡",l:"OPT"}].map(t=>(
        <div key={t.id} onPointerDown={()=>setTab(t.id)} style={{ flex:1,padding:"11px 0 9px",
          textAlign:"center",cursor:"pointer",
          borderTop:`2px solid ${tab===t.id?C.accent:"transparent"}`,transition:"border-color 0.15s" }}>
          <div style={{ fontSize:15,color:tab===t.id?C.accent:C.muted }}>{t.i}</div>
          <div style={{ fontSize:7,fontFamily:C.fnt,letterSpacing:2,marginTop:2,color:tab===t.id?C.accent:C.muted }}>{t.l}</div>
        </div>
      ))}
    </div>
  );
}

// ── ROOT ──────────────────────────────────────────────────────────
export default function App() {
  const [tab,setTab] = useState("ar");
  const [sel,setSel] = useState(null);
  return (
    <div style={{ width:"100%",height:"100vh",display:"flex",flexDirection:"column",
      background:C.bg,overflow:"hidden",maxWidth:430,margin:"0 auto" }}>
      <StatusBar tab={tab}/>
      <div style={{ flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minHeight:0 }}>
        {tab==="ar"       && <ARScreen  sel={sel} setSel={setSel}/>}
        {tab==="map"      && <MapScreen sel={sel} setSel={setSel}/>}
        {tab==="ai"       && <AIScreen/>}
        {tab==="settings" && <SettingsScreen/>}
      </div>
      <NavBar tab={tab} setTab={setTab}/>
    </div>
  );
}
