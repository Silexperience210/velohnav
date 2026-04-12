import { useState, useEffect, useRef, useCallback } from "react";
import { ARScreen } from './components/ARScreen';
import { MapScreen } from './components/MapScreen';
import { SettingsScreen } from './components/SettingsScreen';
import { useDeviceOrientation } from './hooks/useDeviceOrientation';

// ── CAPACITOR DETECTION ───────────────────────────────────────────
const IS_NATIVE = typeof window !== "undefined" &&
  !!(window.Capacitor?.isNativePlatform?.() || window.Capacitor?.platform === "android");

async function getPositionOnce() {
  if (IS_NATIVE) {
    try {
      const { Geolocation } = await import("@capacitor/geolocation");
      await Geolocation.requestPermissions();
      const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy:true, timeout:10000 });
      return { lat:pos.coords.latitude, lng:pos.coords.longitude, acc:Math.round(pos.coords.accuracy) };
    } catch(e) { console.warn("Native GPS:", e); }
  }
  return new Promise((res, rej) => {
    if (!navigator.geolocation) { rej(new Error("GPS indisponible")); return; }
    navigator.geolocation.getCurrentPosition(
      p => res({ lat:p.coords.latitude, lng:p.coords.longitude, acc:Math.round(p.coords.accuracy) }),
      rej, { enableHighAccuracy:true, timeout:10000 }
    );
  });
}

async function startWatchingGPS(cb) {
  if (IS_NATIVE) {
    try {
      const { Geolocation } = await import("@capacitor/geolocation");
      await Geolocation.requestPermissions();
      const id = await Geolocation.watchPosition({ enableHighAccuracy:true }, (pos) => {
        if (pos?.coords) cb({ lat:pos.coords.latitude, lng:pos.coords.longitude, acc:Math.round(pos.coords.accuracy) });
      });
      return () => Geolocation.clearWatch({ id });
    } catch(e) { console.warn("Native GPS watch:", e); }
  }
  if (!navigator.geolocation) return () => {};
  const id = navigator.geolocation.watchPosition(
    p => cb({ lat:p.coords.latitude, lng:p.coords.longitude, acc:Math.round(p.coords.accuracy) }),
    e => console.warn("GPS:", e),
    { enableHighAccuracy:true, maximumAge:5000 }
  );
  return () => navigator.geolocation.clearWatch(id);
}

// JCDecaux — fetch direct en natif, proxy CORS en web prototype
async function fetchJCDecaux(apiKey) {
  const url = `https://api.jcdecaux.com/vls/v3/stations?contract=Luxembourg&apiKey=${apiKey}`;
  try {
    const r = await fetch(url);
    if (r.ok) return await r.json();
  } catch {}
  if (!IS_NATIVE) {
    try {
      const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`);
      if (r.ok) return await r.json();
    } catch {}
  }
  return null;
}

// ── DESIGN ────────────────────────────────────────────────────────
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

function parseStation(raw) {
  const av = raw.totalStands?.availabilities ?? {};
  return {
    id:    raw.number,
    name:  (raw.name||"").replace(/^\d+[\s\-]+/,"").trim(),
    lat:   raw.position?.latitude  ?? raw.position?.lat,
    lng:   raw.position?.longitude ?? raw.position?.lng,
    cap:   raw.totalStands?.capacity ?? raw.bike_stands ?? 0,
    bikes: av.bikes ?? raw.available_bikes ?? 0,
    elec:  av.electricalBikes ?? av.electricalInternalBatteryBikes ?? 0,
    meca:  av.mechanicalBikes ?? 0,
    docks: av.stands ?? raw.available_bike_stands ?? 0,
    status: raw.status==="OPEN" ? "OPEN" : "CLOSED",
    _mock: false,
  };
}

const REF = { lat:49.6080, lng:6.1295 };
const FALLBACK = [
  { id:1,  name:"Gare Centrale",       lat:49.59995, lng:6.13385, cap:20, b:7, e:5 },
  { id:4,  name:"Place d'Armes",        lat:49.61118, lng:6.13091, cap:15, b:5, e:4 },
  { id:2,  name:"Hamilius",             lat:49.61143, lng:6.12975, cap:25, b:2, e:1 },
  { id:7,  name:"Clausen",              lat:49.61021, lng:6.14437, cap:12, b:4, e:3 },
  { id:14, name:"Kirchberg MUDAM",      lat:49.61921, lng:6.15178, cap:22, b:9, e:7 },
  { id:21, name:"Limpertsberg",         lat:49.61571, lng:6.12462, cap:20, b:3, e:2 },
  { id:33, name:"Bonnevoie",            lat:49.59650, lng:6.13750, cap:18, b:0, e:0 },
  { id:45, name:"Belair",               lat:49.60890, lng:6.11940, cap:16, b:6, e:4 },
].map(s=>({ id:s.id, name:s.name, lat:s.lat, lng:s.lng, cap:s.cap,
  bikes:s.b, elec:s.e, meca:s.b-s.e, docks:s.cap-s.b,
  status:s.b===0&&s.id===33?"CLOSED":"OPEN", _mock:true }));

function enrich(list, pos) {
  const ref = pos ?? REF;
  return list.filter(s=>s.lat&&s.lng)
    .map(s=>({ ...s, dist:haversine(ref.lat,ref.lng,s.lat,s.lng) }))
    .sort((a,b)=>a.dist-b.dist);
}
// ── STATUS BAR ────────────────────────────────────────────────────
function StatusBar({ tab, gpsOk, apiLive, isMock }) {
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
        {[
          { l:gpsOk?"GPS ✓":"GPS",  col:gpsOk?C.good:C.warn },
          { l:apiLive?"LIVE":isMock?"DEMO":"ERR", col:apiLive?C.good:isMock?C.warn:C.bad },
        ].map(s=>(
          <div key={s.l} style={{ display:"flex", alignItems:"center", gap:3, padding:"3px 6px",
            background:"rgba(0,0,0,0.4)", border:`1px solid ${C.border}`, borderRadius:3 }}>
            <div style={{ width:5,height:5,borderRadius:"50%",background:s.col,boxShadow:`0 0 4px ${s.col}` }}/>
            <span style={{ color:s.col, fontSize:7, fontFamily:C.fnt }}>{s.l}</span>
          </div>
        ))}
        <div style={{ color:C.text, fontSize:11, fontFamily:C.fnt, fontWeight:700,
          padding:"3px 6px", background:"rgba(0,0,0,0.4)", border:`1px solid ${C.border}`, borderRadius:3 }}>
          {t.toLocaleTimeString("fr",{hour:"2-digit",minute:"2-digit"})}
        </div>
      </div>
    </div>
  );
}


// ── AI SCREEN ─────────────────────────────────────────────────────
function AIScreen({ stations }) {
  const top = stations.find(s=>s.bikes>0);
  const initMsg = top
    ? `${stations.filter(s=>s.bikes>0).length}/${stations.length} stations dispos. Plus proche : ${top.name} (${fDist(top.dist)}, ${top.bikes}🚲 ⚡${top.elec}).`
    : "Chargement des stations…";

  const [history, setHistory] = useState([]);
  const [display, setDisplay] = useState([{ role:"ai", text:initMsg }]);
  const [input,   setInput]   = useState("");
  const [busy,    setBusy]    = useState(false);
  const endRef = useRef();
  useEffect(()=>endRef.current?.scrollIntoView({behavior:"smooth"}),[display]);

  const systemPrompt = `Tu es VELOH·AI, l'assistant de VelohNav pour le réseau Vel'OH! Luxembourg.
Réponds en français, de façon concise (3-4 lignes max).
Données actuelles (triées par distance) :
${stations.map(s=>`• ${s.name} | ${s.bikes} vélos (⚡${s.elec} élec.) | ${s.docks} docks | ${fDist(s.dist)} | ${bTag(s)}`).join("\n")}
Réponds uniquement sur la mobilité Veloh, les itinéraires, ou l'app.`;

  const sendText = useCallback(async(text)=>{
    const q=(text||input).trim();
    if(!q||busy) return;
    setInput(""); setBusy(true);
    setDisplay(d=>[...d,{role:"user",text:q}]);
    const hist=[...history,{role:"user",content:q}];
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:400,
          system:systemPrompt, messages:hist }),
      });
      const data = await r.json();
      const reply = data.content?.[0]?.text ?? "Erreur de réponse.";
      setHistory([...hist,{role:"assistant",content:reply}]);
      setDisplay(d=>[...d,{role:"ai",text:reply}]);
    } catch { setDisplay(d=>[...d,{role:"ai",text:"Erreur réseau."}]); }
    setBusy(false);
  },[input,busy,history,systemPrompt]);

  const QUICK = ["Station la plus proche ?","Vélos électriques dispo ?","Où déposer mon vélo ?","Itinéraire Hamilius → Kirchberg"];

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", background:C.bg, minHeight:0 }}>
      <div style={{ padding:"9px 14px 7px", borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
        <div style={{ color:C.accent, fontSize:10, fontFamily:C.fnt, fontWeight:700, letterSpacing:2 }}>VELOH·AI</div>
        <div style={{ color:C.muted, fontSize:8, fontFamily:C.fnt }}>
          Claude · {stations.length} stations · {stations.some(s=>!s._mock)?"données live":"données simulées"}
        </div>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"11px 14px", display:"flex", flexDirection:"column", gap:9 }}>
        {display.map((m,i)=>(
          <div key={i} style={{ alignSelf:m.role==="user"?"flex-end":"flex-start", maxWidth:"88%" }}>
            {m.role==="ai"&&<div style={{ color:C.accent, fontSize:7, fontFamily:C.fnt, letterSpacing:2, marginBottom:3 }}>VELOH·AI</div>}
            <div style={{ background:m.role==="user"?C.accentBg:"rgba(255,255,255,0.04)",
              border:`1px solid ${m.role==="user"?C.accent+"55":C.border}`,
              borderRadius:m.role==="user"?"10px 10px 2px 10px":"10px 10px 10px 2px", padding:"9px 12px" }}>
              <div style={{ color:m.role==="user"?C.accent:C.text, fontSize:10, fontFamily:C.fnt, lineHeight:1.7, whiteSpace:"pre-wrap" }}>
                {m.text}
              </div>
            </div>
          </div>
        ))}
        {busy&&(
          <div style={{ alignSelf:"flex-start" }}>
            <div style={{ color:C.accent, fontSize:7, fontFamily:C.fnt, letterSpacing:2, marginBottom:3 }}>VELOH·AI</div>
            <div style={{ background:"rgba(255,255,255,0.04)", border:`1px solid ${C.border}`,
              borderRadius:"10px 10px 10px 2px", padding:"10px 14px", display:"flex", gap:6, alignItems:"center" }}>
              {[0,1,2].map(i=><div key={i} style={{ width:6,height:6,borderRadius:"50%",background:C.accent,opacity:0.7,transform:`scale(${i===1?1.2:0.8})` }}/>)}
              <span style={{ color:C.muted, fontSize:8, fontFamily:C.fnt, marginLeft:4 }}>en train de répondre…</span>
            </div>
          </div>
        )}
        <div ref={endRef}/>
      </div>
      <div style={{ display:"flex", gap:6, padding:"5px 14px 7px", overflowX:"auto", flexShrink:0 }}>
        {QUICK.map(q=>(
          <div key={q} onPointerDown={()=>sendText(q)} style={{ flexShrink:0, background:"transparent",
            border:`1px solid ${C.border}`, color:C.muted, borderRadius:14, padding:"4px 10px",
            fontSize:8, fontFamily:C.fnt, cursor:"pointer", whiteSpace:"nowrap" }}>{q}</div>
        ))}
      </div>
      <div style={{ display:"flex", gap:8, padding:"7px 14px 13px", borderTop:`1px solid ${C.border}`, flexShrink:0 }}>
        <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendText(input)}
          placeholder="Pose ta question sur Veloh…"
          style={{ flex:1, background:"rgba(255,255,255,0.03)", border:`1px solid ${C.border}`,
            borderRadius:5, padding:"9px 11px", color:C.text, fontSize:10, fontFamily:C.fnt, outline:"none" }}/>
        <div onPointerDown={()=>sendText(input)} style={{
          background:busy?"rgba(255,255,255,0.04)":C.accentBg,
          border:`1px solid ${busy?C.border:C.accent}`, color:busy?C.muted:C.accent,
          borderRadius:5, padding:"9px 16px", fontSize:11, fontFamily:C.fnt, fontWeight:700, cursor:busy?"not-allowed":"pointer",
        }}>▶</div>
      </div>
    </div>
  );
}

// ── NAV ───────────────────────────────────────────────────────────
function NavBar({ tab, setTab }) {
  return (
    <div style={{ display:"flex",background:"rgba(8,12,15,0.98)",borderTop:`1px solid ${C.border}`,flexShrink:0 }}>
      {[{id:"ar",i:"⬡",l:"AR"},{id:"map",i:"◈",l:"MAP"},{id:"ai",i:"◎",l:"AI"},{id:"settings",i:"≡",l:"OPT"}].map(t=>(
        <div key={t.id} onPointerDown={()=>setTab(t.id)} style={{ flex:1,padding:"11px 0 9px",textAlign:"center",cursor:"pointer",
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
  
  // API Keys
  const [apiKey,setApiKey] = useState("");
  const [claudeKey,setClaudeKey] = useState("");
  const [kimiKey,setKimiKey] = useState("");
  const [aiProvider,setAiProvider] = useState("claude"); // 'claude', 'kimi', 'none'
  
  const [stations,setStations] = useState(()=>enrich(FALLBACK,null));
  const [apiLive,setApiLive] = useState(false);
  const [isMock,setIsMock] = useState(true);
  const [gpsPos,setGpsPos] = useState(null);

  // Orientation pour AR et Map
  const { alpha: heading } = useDeviceOrientation();

  // GPS watch continu
  useEffect(()=>{
    let stop=()=>{};
    startWatchingGPS(pos=>setGpsPos(pos)).then(fn=>{ stop=fn; });
    return ()=>stop();
  },[]);

  // Recalcul distances quand GPS change
  useEffect(()=>{
    setStations(prev=>enrich(prev,gpsPos));
  },[gpsPos]);

  const loadData = useCallback(async()=>{
    const userPos = gpsPos;
    if (apiKey) {
      try {
        const raw = await fetchJCDecaux(apiKey);
        if (raw && Array.isArray(raw)) {
          setStations(enrich(raw.map(parseStation), userPos));
          setApiLive(true); setIsMock(false); return;
        }
      } catch(e) { console.warn("JCDecaux load:", e); }
      setApiLive(false); setIsMock(true);
    }
    setStations(enrich(FALLBACK, userPos));
    setApiLive(false); setIsMock(true);
  },[apiKey,gpsPos]);

  useEffect(()=>{ loadData(); },[loadData]);
  useEffect(()=>{ const t=setInterval(loadData,60000); return()=>clearInterval(t); },[loadData]);

  return (
    <div style={{ width:"100%",height:"100vh",display:"flex",flexDirection:"column",
      background:C.bg,overflow:"hidden",maxWidth:430,margin:"0 auto" }}>
      <StatusBar tab={tab} gpsOk={!!gpsPos} apiLive={apiLive} isMock={isMock}/>
      <div style={{ flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minHeight:0 }}>
        {tab==="ar"       &&<ARScreen  stations={stations} sel={sel} setSel={setSel} gpsPos={gpsPos}/>}
        {tab==="map"      &&<MapScreen stations={stations} sel={sel} setSel={setSel} gpsPos={gpsPos} heading={heading}/>}
        {tab==="ai"       &&<AIScreen  stations={stations}/>}
        {tab==="settings" &&<SettingsScreen 
          apiKey={apiKey} setApiKey={setApiKey}
          claudeKey={claudeKey} setClaudeKey={setClaudeKey}
          kimiKey={kimiKey} setKimiKey={setKimiKey}
          aiProvider={aiProvider} setAiProvider={setAiProvider}
          onRefresh={loadData} apiLive={apiLive} isMock={isMock} gpsPos={gpsPos}/>}
      </div>
      <NavBar tab={tab} setTab={setTab}/>
    </div>
  );
}
