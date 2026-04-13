import { useState, useEffect, useRef, useCallback, useMemo } from "react";

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
function getBearing(la1,ln1,la2,ln2){
  const φ1=la1*Math.PI/180,φ2=la2*Math.PI/180,Δλ=(ln2-ln1)*Math.PI/180;
  const y=Math.sin(Δλ)*Math.cos(φ2);
  const x=Math.cos(φ1)*Math.sin(φ2)-Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  return(Math.atan2(y,x)*180/Math.PI+360)%360;
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
function pins(stations) {
  return stations.slice(0,6).map((s,i)=>({
    ...s, x:13+(i%3)*34, y:28+Math.floor(i/3)*38, labelRight:(i%3)<2,
  }));
}

// ── COMPASS HOOK ──────────────────────────────────────────────────
function useCompass(){
  const [heading,setHeading]=useState(null);
  const [perm,setPerm]=useState("idle"); // idle|requesting|granted|denied|unavailable
  const cleanup=useRef(null);

  const start=useCallback(async()=>{
    setPerm("requesting");
    if(typeof DeviceOrientationEvent?.requestPermission==="function"){
      try{
        const r=await DeviceOrientationEvent.requestPermission();
        if(r!=="granted"){setPerm("denied");return;}
      }catch{setPerm("denied");return;}
    }
    if(!window.DeviceOrientationEvent){setPerm("unavailable");return;}
    let last=null;
    const handler=e=>{
      let h=null;
      if(e.webkitCompassHeading!=null) h=e.webkitCompassHeading;         // iOS
      else if(e.alpha!=null) h=(360-e.alpha+360)%360;                    // Android
      if(h===null) return;
      // Smooth lerp to avoid jitter
      last=last===null?h:last+((h-last+540)%360-180)*0.25;
      setHeading((last+360)%360);
    };
    window.addEventListener("deviceorientationabsolute",handler,true);
    window.addEventListener("deviceorientation",handler,true);
    setPerm("granted");
    cleanup.current=()=>{
      window.removeEventListener("deviceorientationabsolute",handler,true);
      window.removeEventListener("deviceorientation",handler,true);
    };
  },[]);

  useEffect(()=>()=>cleanup.current?.(),[]);
  return{heading,perm,start};
}

// ── NAV CANVAS — blue path overlay ────────────────────────────────
function NavCanvas({relBear}){
  const ref=useRef();
  useEffect(()=>{
    const cv=ref.current; if(!cv) return;
    const W=cv.offsetWidth||360,H=cv.offsetHeight||260;
    cv.width=W; cv.height=H;
    const ctx=cv.getContext("2d");
    ctx.clearRect(0,0,W,H);
    const clamp=Math.max(-38,Math.min(38,relBear??0));
    const vx=W/2+(clamp/38)*(W*0.28), vy=H*0.38;

    // Filled corridor
    const g=ctx.createLinearGradient(W/2,H,vx,vy);
    g.addColorStop(0,"rgba(59,130,246,0.48)");
    g.addColorStop(0.55,"rgba(59,130,246,0.14)");
    g.addColorStop(1,"rgba(59,130,246,0)");
    ctx.beginPath();
    ctx.moveTo(W/2-58,H); ctx.lineTo(vx-5,vy);
    ctx.lineTo(vx+5,vy); ctx.lineTo(W/2+58,H);
    ctx.closePath(); ctx.fillStyle=g; ctx.fill();

    // Dashed center line
    ctx.beginPath(); ctx.setLineDash([10,7]);
    ctx.moveTo(W/2,H); ctx.lineTo(vx,vy);
    ctx.strokeStyle="rgba(147,197,253,0.6)";
    ctx.lineWidth=1.5; ctx.stroke(); ctx.setLineDash([]);

    // Edge lines
    [[-58,-5],[58,5]].forEach(([base,tip])=>{
      ctx.beginPath();
      ctx.moveTo(W/2+base,H); ctx.lineTo(vx+tip,vy);
      ctx.strokeStyle="rgba(59,130,246,0.5)";
      ctx.lineWidth=1; ctx.stroke();
    });

    // Perspective cross-hatch
    for(let i=1;i<=4;i++){
      const t=i/5;
      const px=W/2+(vx-W/2)*t, py=H+(vy-H)*t, hw=(58-57*t);
      ctx.beginPath(); ctx.moveTo(px-hw,py); ctx.lineTo(px+hw,py);
      ctx.strokeStyle=`rgba(59,130,246,${0.18*(1-t)})`;
      ctx.lineWidth=0.8; ctx.stroke();
    }
  },[relBear]);

  return <canvas ref={ref} style={{
    position:"absolute",bottom:0,left:0,width:"100%",height:"52%",
    pointerEvents:"none",zIndex:11
  }}/>;
}

// ── CITY BG ───────────────────────────────────────────────────────
function CityBG({ off }) {
  const s = off % 80;
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
      {[0,1,2,3].map(i=><rect key={`m${i}`} x={197} y={420+i*50-(s*0.6)%50} width={6} height={28}
        fill="rgba(255,140,0,0.2)" rx="1"/>)}
      <rect width="400" height="600" fill="rgba(0,0,0,0.22)"/>
    </svg>
  );
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

// ── AR PIN ────────────────────────────────────────────────────────
function ARPin({ s, sel, setSel, pulse }) {
  const col=bCol(s), isSel=sel===s.id;
  const scale=s.scale??1;
  const dotSize=Math.round((isSel?14:9)*scale);
  return (
    <div onPointerDown={()=>setSel(isSel?null:s.id)}
      style={{ position:"absolute", left:`${s.x}%`, top:`${s.y}%`,
        transform:"translate(-50%,-50%)", cursor:"pointer",
        zIndex:isSel?25:14, padding:14, margin:-14 }}>
      <div style={{ position:"absolute", top:14, left:14, width:dotSize, height:dotSize, borderRadius:"50%",
        boxShadow:`0 0 0 ${pulse?10:3}px ${col}22`, transition:"box-shadow 1s", pointerEvents:"none" }}/>
      <div style={{ width:dotSize, height:dotSize, borderRadius:"50%", background:col,
        border:`2px solid ${isSel?"#fff":"rgba(0,0,0,0.55)"}`, boxShadow:`0 0 ${8*scale}px ${col}`,
        transform:isSel?"scale(1.4)":"scale(1)", transition:"transform 0.15s",
        position:"relative", zIndex:2 }}/>
      {/* Distance badge */}
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
    </div>
  );
}

// ── AR SCREEN ─────────────────────────────────────────────────────
const COMPASS_LABELS=["N","NE","E","SE","S","SO","O","NO"];
const FOV=68; // horizontal camera FOV in degrees

function ARScreen({ stations, sel, setSel, gpsPos }) {
  const vidRef=useRef(null);
  const [cam,   setCam]  =useState("idle");
  const [bgOff, setBgOff]=useState(0);
  const [pulse, setPulse]=useState(false);
  const {heading,perm,start:startCompass}=useCompass();

  useEffect(()=>{
    const t=setInterval(()=>setBgOff(o=>o+0.5),50);
    return()=>clearInterval(t);
  },[]);
  useEffect(()=>{
    const t=setInterval(()=>setPulse(p=>!p),1100);
    return()=>clearInterval(t);
  },[]);

  const startCam=useCallback(async()=>{
    setCam("requesting");
    try{
      const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"}});
      if(vidRef.current){vidRef.current.srcObject=stream; await vidRef.current.play();}
      setCam("active");
    }catch(e){console.warn("Cam:",e);setCam("denied");}
  },[]);

  useEffect(()=>{
    const vid=vidRef.current;
    return()=>{vid?.srcObject?.getTracks().forEach(t=>t.stop());};
  },[]);

  // ── Real AR projection ──────────────────────────────────────────
  const arPins=useMemo(()=>{
    if(heading===null||!gpsPos) return null; // null = use fake grid
    return stations
      .filter(s=>s.lat&&s.lng&&s.dist<1600)
      .map(s=>{
        const bear=getBearing(gpsPos.lat,gpsPos.lng,s.lat,s.lng);
        const rel=((bear-heading+540)%360)-180;
        if(Math.abs(rel)>FOV/2+8) return null;
        const x=50+(rel/(FOV/2))*50;
        const dc=Math.min(s.dist,1200);
        const y=70-(1-dc/1200)*44;          // far=26% near=70%
        const scale=Math.max(0.55,1-dc/1500);
        return{...s, x, y, scale, labelRight:rel<0, rel};
      })
      .filter(Boolean)
      .sort((a,b)=>b.dist-a.dist);          // back-to-front
  },[heading,gpsPos,stations]);

  const fakePins=useMemo(()=>pins(stations),[stations]);
  const visiblePins=arPins??fakePins;

  // ── Nav overlay (selected station) ────────────────────────────
  const navStation=stations.find(s=>s.id===sel);
  const navRel=useMemo(()=>{
    if(!navStation||!gpsPos||heading===null) return null;
    const bear=getBearing(gpsPos.lat,gpsPos.lng,navStation.lat,navStation.lng);
    return((bear-heading+540)%360)-180;
  },[navStation,gpsPos,heading]);

  const hdg=heading!==null?Math.round(heading):null;
  const cardLabel=hdg!==null?COMPASS_LABELS[Math.round(hdg/45)%8]:"?";

  return (
    <div style={{position:"relative",flex:1,overflow:"hidden",minHeight:0,background:"#000"}}>

      {/* Camera feed */}
      <video ref={vidRef} muted playsInline autoPlay style={{
        position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover",zIndex:1,
        opacity:cam==="active"?1:0,transition:"opacity 0.5s"}}/>
      {cam!=="active"&&<div style={{position:"absolute",inset:0,zIndex:2}}><CityBG off={bgOff}/></div>}

      {/* Gradient vignette */}
      <div style={{position:"absolute",inset:0,zIndex:5,pointerEvents:"none"}}>
        <div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse at center,transparent 30%,rgba(0,0,0,0.35) 100%)"}}/>
        <div style={{position:"absolute",top:0,left:0,right:0,height:70,background:"linear-gradient(to bottom,rgba(8,12,15,0.65),transparent)"}}/>
        <div style={{position:"absolute",bottom:0,left:0,right:0,height:230,background:"linear-gradient(to top,rgba(8,12,15,0.98),rgba(8,12,15,0.4) 60%,transparent)"}}/>
      </div>

      {/* Blue nav path */}
      {navRel!==null&&<NavCanvas relBear={navRel}/>}

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
              {perm==="denied"?"⊗ BOUSSOLE REFUSÉE":"⊕ BOUSSOLE INACTIVE"}
            </div>
          )}
        </div>
        <div style={{color:C.accent,fontSize:8,textAlign:"center",lineHeight:"4px"}}>▾</div>
      </div>

      {/* Horizon line + crosshair */}
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

      {/* Cam activation */}
      {cam!=="active"&&(
        <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",
          zIndex:30,display:"flex",flexDirection:"column",alignItems:"center",gap:14}}>
          {cam==="idle"&&(
            <>
              <div style={{color:C.muted,fontSize:9,fontFamily:C.fnt,letterSpacing:3}}>VUE AR VELOHNAV</div>
              <button onPointerDown={startCam} style={{
                background:C.accentBg,border:`1px solid ${C.accent}`,color:C.accent,
                borderRadius:5,padding:"12px 32px",fontSize:12,fontFamily:C.fnt,
                fontWeight:700,cursor:"pointer",letterSpacing:2,boxShadow:`0 0 20px ${C.accent}25`}}>
                ▶ ACTIVER CAMÉRA
              </button>
            </>
          )}
          {cam==="requesting"&&<div style={{color:C.accent,fontSize:10,fontFamily:C.fnt,letterSpacing:3}}>ACCÈS CAMÉRA…</div>}
          {cam==="denied"&&(
            <div style={{textAlign:"center",padding:"0 32px"}}>
              <div style={{color:C.bad,fontSize:10,fontFamily:C.fnt,marginBottom:8}}>CAMÉRA REFUSÉE</div>
              <div style={{color:C.muted,fontSize:9,fontFamily:C.fnt,lineHeight:1.7}}>
                Paramètres → Apps → VelohNav → Autorisations → Caméra
              </div>
              <button onPointerDown={startCam} style={{
                background:"rgba(224,62,62,0.1)",border:`1px solid ${C.bad}`,color:C.bad,
                borderRadius:4,padding:"8px 20px",fontSize:9,fontFamily:C.fnt,
                cursor:"pointer",marginTop:12}}>RÉESSAYER</button>
            </div>
          )}
        </div>
      )}

      {/* Boussole activation (cam active, compass idle) */}
      {cam==="active"&&perm==="idle"&&(
        <div style={{position:"absolute",top:44,right:12,zIndex:30}}>
          <button onPointerDown={startCompass} style={{
            background:C.accentBg,border:`1px solid ${C.accent}55`,color:C.accent,
            borderRadius:4,padding:"6px 11px",fontSize:8,fontFamily:C.fnt,
            cursor:"pointer",letterSpacing:1,boxShadow:`0 0 8px ${C.accent}20`}}>
            ⊕ AR RÉEL
          </button>
        </div>
      )}

      {/* AR mode badge */}
      {arPins&&(
        <div style={{position:"absolute",top:44,left:12,zIndex:20,pointerEvents:"none"}}>
          <div style={{background:"rgba(46,204,143,0.08)",border:`1px solid ${C.good}30`,
            borderRadius:3,padding:"3px 8px"}}>
            <span style={{color:C.good,fontSize:7,fontFamily:C.fnt,letterSpacing:1}}>AR RÉEL · {hdg}° {cardLabel}</span>
          </div>
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
                {l:"VÉLOS",v:navStation.bikes,col:bCol(navStation)},
                {l:"ÉLEC.",v:navStation.elec, col:"#60A5FA"},
                {l:"MÉCA.",v:navStation.meca, col:C.text},
                {l:"DOCKS",v:navStation.docks,col:C.text},
              ].map((m,i)=>(
                <div key={m.l} style={{flex:1,textAlign:"center",borderRight:i<3?`1px solid ${C.border}`:"none"}}>
                  <div style={{color:m.col,fontSize:20,fontFamily:C.fnt,fontWeight:700}}>{m.v}</div>
                  <div style={{color:C.muted,fontSize:7,fontFamily:C.fnt,letterSpacing:1,marginTop:1}}>{m.l}</div>
                </div>
              ))}
            </div>
          </div>
        ):(
          <div style={{background:"rgba(8,12,15,0.85)",border:`1px solid ${C.border}`,
            borderRadius:8,padding:"11px 15px",textAlign:"center"}}>
            <div style={{color:C.muted,fontSize:8,fontFamily:C.fnt,letterSpacing:2}}>
              {arPins
                ?`${arPins.length} STATIONS EN VUE · TOURNE-TOI POUR SCANNER`
                :`${stations.filter(s=>s.bikes>0).length}/${stations.length} DISPO · TOUCHE UN PIN AR`}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── LUX MAP SVG SKETCH ───────────────────────────────────────────
function LuxMap({ toXY }) {
  // Converts [lat,lng] array → "x,y x,y …" for polyline/polygon
  const pts = coords => coords.map(([la,ln])=>{ const {x,y}=toXY(la,ln); return `${x},${y}`; }).join(" ");
  // Converts [lat,lng] array → SVG path string
  const road = coords => {
    const segs = coords.map(([la,ln])=>{ const {x,y}=toXY(la,ln); return [x,y]; });
    return segs.map(([x,y],i)=>`${i===0?"M":"L"}${x} ${y}`).join(" ");
  };

  /* ── Rivers ── */
  const alzette = [
    [49.5945,6.1340],[49.5975,6.1350],[49.6000,6.1358],
    [49.6030,6.1372],[49.6055,6.1382],[49.6075,6.1395],
    [49.6100,6.1435],[49.6120,6.1480],[49.6145,6.1510],
  ];
  const petrusse = [
    [49.6040,6.1090],[49.6025,6.1140],[49.6020,6.1200],
    [49.6030,6.1260],[49.6045,6.1300],[49.6070,6.1360],
  ];

  /* ── Major roads ── */
  const bvdRoyal = [
    [49.5985,6.1305],[49.6040,6.1305],[49.6080,6.1300],
    [49.6110,6.1295],[49.6150,6.1265],
  ];
  const avGare = [
    [49.5960,6.1310],[49.5995,6.1330],[49.6020,6.1338],
  ];
  const routeArlon = [
    [49.6120,6.1268],[49.6155,6.1205],[49.6180,6.1150],
  ];
  const kirchbergBridge = [
    [49.6110,6.1295],[49.6140,6.1360],[49.6170,6.1440],
    [49.6200,6.1510],[49.6220,6.1560],
  ];
  const routeEsch = [
    [49.5985,6.1305],[49.5970,6.1230],[49.5960,6.1150],
  ];
  const avgJFK = [
    [49.6220,6.1560],[49.6230,6.1630],[49.6235,6.1700],
  ];

  /* ── Kirchberg plateau boundary (escarpment) ── */
  const kirchbergEdge = [
    [49.6145,6.1355],[49.6160,6.1400],[49.6180,6.1450],
    [49.6210,6.1500],[49.6250,6.1560],[49.6265,6.1640],
    [49.6265,6.1730],[49.6250,6.1810],
  ];

  /* ── District labels [lat, lng, text] ── */
  const labels = [
    [49.6225,6.1620,"KIRCHBERG"],
    [49.6170,6.1185,"LIMPERTSBERG"],
    [49.6108,6.1295,"VILLE-HAUTE"],
    [49.6000,6.1290,"GARE"],
    [49.5958,6.1370,"BONNEVOIE"],
    [49.6095,6.1455,"CLAUSEN"],
    [49.6085,6.1165,"BELAIR"],
    [49.6000,6.1190,"HOLLERICH"],
    [49.6065,6.1360,"GRUND"],
  ];

  const rCol = `rgba(245,130,13,0.13)`;
  const rivCol = `rgba(96,165,250,0.22)`;

  return (
    <svg style={{ position:"absolute",inset:0,width:"100%",height:"100%",pointerEvents:"none" }}
      viewBox="0 0 100 100" preserveAspectRatio="none">

      {/* Kirchberg plateau edge */}
      <polyline points={pts(kirchbergEdge)}
        fill="none" stroke={`rgba(245,130,13,0.08)`} strokeWidth="3"
        strokeDasharray="0.8,2.2"/>

      {/* Rivers */}
      <polyline points={pts(alzette)}
        fill="none" stroke={rivCol} strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
      <polyline points={pts(petrusse)}
        fill="none" stroke={`rgba(96,165,250,0.15)`} strokeWidth="0.7" strokeLinecap="round"/>

      {/* Roads */}
      <path d={road(bvdRoyal)}  fill="none" stroke={rCol} strokeWidth="0.9" strokeLinecap="round"/>
      <path d={road(avGare)}    fill="none" stroke={rCol} strokeWidth="0.7" strokeLinecap="round"/>
      <path d={road(routeArlon)} fill="none" stroke={rCol} strokeWidth="0.7" strokeLinecap="round"/>
      <path d={road(kirchbergBridge)} fill="none" stroke={`rgba(245,130,13,0.18)`} strokeWidth="0.9" strokeLinecap="round"/>
      <path d={road(routeEsch)} fill="none" stroke={rCol} strokeWidth="0.7" strokeLinecap="round"/>
      <path d={road(avgJFK)}    fill="none" stroke={rCol} strokeWidth="0.7" strokeLinecap="round"/>

      {/* District labels */}
      {labels.map(([la,ln,txt])=>{
        const {x,y}=toXY(la,ln);
        return (
          <text key={txt} x={x} y={y}
            fill="rgba(255,255,255,0.11)" fontSize="3.2"
            fontFamily="'Courier New',monospace" textAnchor="middle" letterSpacing="0.8">
            {txt}
          </text>
        );
      })}
    </svg>
  );
}

// ── MAP SCREEN ────────────────────────────────────────────────────
function MapScreen({ stations, sel, setSel, gpsPos }) {
  if (!stations.length) return (
    <div style={{ flex:1,display:"flex",alignItems:"center",justifyContent:"center",background:C.bg }}>
      <div style={{ color:C.muted,fontSize:10,fontFamily:C.fnt }}>Chargement des stations…</div>
    </div>
  );
  const margin=0.006;
  const lats=stations.map(s=>s.lat), lngs=stations.map(s=>s.lng);
  const ltMin=Math.min(...lats)-margin, ltMax=Math.max(...lats)+margin;
  const lnMin=Math.min(...lngs)-margin, lnMax=Math.max(...lngs)+margin;
  const toXY=(la,ln)=>({ x:(ln-lnMin)/(lnMax-lnMin)*88+6, y:(1-(la-ltMin)/(ltMax-ltMin))*86+5 });
  const ux=toXY(gpsPos?.lat??REF.lat, gpsPos?.lng??REF.lng);

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", background:C.bg, minHeight:0 }}>
      <div style={{ flex:1, position:"relative", margin:"8px 14px",
        background:"rgba(0,0,0,0.5)", border:`1px solid ${C.border}`, borderRadius:8, overflow:"hidden" }}>

        {/* Grille de fond */}
        <svg style={{ position:"absolute",inset:0,width:"100%",height:"100%",opacity:0.03 }}>
          <defs><pattern id="mg" width="44" height="44" patternUnits="userSpaceOnUse">
            <path d="M44 0L0 0 0 44" fill="none" stroke={C.accent} strokeWidth="0.5"/>
          </pattern></defs>
          <rect width="100%" height="100%" fill="url(#mg)"/>
        </svg>

        {/* Croquis SVG Luxembourg */}
        <LuxMap toXY={toXY}/>

        {/* Stations — points only, no labels */}
        {stations.map(s=>{
          const {x,y}=toXY(s.lat,s.lng); const col=bCol(s); const act=sel===s.id;
          return (
            <div key={s.id} onPointerDown={()=>setSel(act?null:s.id)}
              style={{ position:"absolute",left:`${x}%`,top:`${y}%`,
                transform:"translate(-50%,-50%)",width:36,height:36,
                display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",zIndex:act?15:8 }}>
              {act&&<div style={{ position:"absolute",inset:4,borderRadius:"50%",border:`1.5px solid ${col}`,opacity:0.5 }}/>}
              <div style={{ width:act?13:8,height:act?13:8,borderRadius:"50%",background:col,
                boxShadow:`0 0 6px ${col}`,border:`2px solid ${act?"#fff":"rgba(0,0,0,0.5)"}`,transition:"all 0.18s" }}/>
            </div>
          );
        })}

        {/* Position utilisateur */}
        <div style={{ position:"absolute",left:`${ux.x}%`,top:`${ux.y}%`,
          transform:"translate(-50%,-50%)",zIndex:20,pointerEvents:"none" }}>
          <div style={{ position:"absolute",inset:-8,borderRadius:"50%",border:"2px solid rgba(59,130,246,0.5)"}}/>
          <div style={{ width:10,height:10,borderRadius:"50%",background:C.blue,boxShadow:`0 0 10px ${C.blue}` }}/>
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

// ── AI SCREEN ─────────────────────────────────────────────────────
function AIScreen({ stations, claudeKey, aiHistory, setAiHistory, aiDisplay, setAiDisplay }) {
  const top = stations.find(s=>s.bikes>0);
  const initMsg = top
    ? `${stations.filter(s=>s.bikes>0).length}/${stations.length} stations dispos. Plus proche : ${top.name} (${fDist(top.dist)}, ${top.bikes}🚲 ⚡${top.elec}).`
    : "Chargement des stations…";

  const [input,   setInput]   = useState("");
  const [busy,    setBusy]    = useState(false);
  const endRef = useRef();
  useEffect(()=>endRef.current?.scrollIntoView({behavior:"smooth"}),[aiDisplay]);

  // Update greeting when stations switch from mock to live
  useEffect(()=>{
    if (aiHistory.length === 0) {
      setAiDisplay([{ role:"ai", text:initMsg }]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[stations]);

  const systemPrompt = `Tu es VELOH·AI, l'assistant de VelohNav pour le réseau Vel'OH! Luxembourg.
Réponds en français, de façon concise (3-4 lignes max).
Données actuelles (triées par distance) :
${stations.map(s=>`• ${s.name} | ${s.bikes} vélos (⚡${s.elec} élec.) | ${s.docks} docks | ${fDist(s.dist)} | ${bTag(s)}`).join("\n")}
Réponds uniquement sur la mobilité Veloh, les itinéraires, ou l'app.`;

  const sendText = useCallback(async(text)=>{
    const q=(text||input).trim();
    if(!q||busy) return;
    if (!claudeKey) {
      setAiDisplay(d=>[...d,{role:"user",text:q},{role:"ai",text:"⚠ Clé API Claude manquante — entre-la dans OPT pour activer l'assistant."}]);
      setInput(""); return;
    }
    setInput(""); setBusy(true);
    setAiDisplay(d=>[...d,{role:"user",text:q}]);
    const hist=[...aiHistory,{role:"user",content:q}];
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "x-api-key": claudeKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body:JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:400,
          system:systemPrompt, messages:hist }),
      });
      const data = await r.json();
      if (!r.ok) {
        const errMsg = data?.error?.message ?? `Erreur API (${r.status})`;
        setAiDisplay(d=>[...d,{role:"ai",text:`⚠ ${errMsg}`}]);
      } else {
        const reply = data.content?.[0]?.text ?? "Erreur de réponse.";
        setAiHistory([...hist,{role:"assistant",content:reply}]);
        setAiDisplay(d=>[...d,{role:"ai",text:reply}]);
      }
    } catch { setAiDisplay(d=>[...d,{role:"ai",text:"Erreur réseau."}]); }
    setBusy(false);
  },[input,busy,aiHistory,claudeKey,systemPrompt,setAiHistory,setAiDisplay]);

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
        {aiDisplay.map((m,i)=>(
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

// ── SETTINGS ──────────────────────────────────────────────────────
function SettingsScreen({ apiKey, setApiKey, claudeKey, setClaudeKey, onRefresh, apiLive, isMock, gpsPos, lnAddr, setLnAddr, lnOn, setLnOn, ads, setAds }) {
  const [draft,setDraft]=useState(apiKey);
  const [saved,setSaved]=useState(false);
  const [claudeDraft,setClaudeDraft]=useState(claudeKey);
  const [claudeSaved,setClaudeSaved]=useState(false);
  const [lnSaved,setLnSaved]=useState(false);

  // Keep draft in sync if apiKey is loaded externally (e.g. from localStorage)
  useEffect(()=>{ setDraft(apiKey); },[apiKey]);
  useEffect(()=>{ setClaudeDraft(claudeKey); },[claudeKey]);

  const saveKey=()=>{ setApiKey(draft.trim()); setSaved(true); setTimeout(()=>{ setSaved(false); onRefresh(); },1200); };
  const saveClaudeKey=()=>{ setClaudeKey(claudeDraft.trim()); setClaudeSaved(true); setTimeout(()=>setClaudeSaved(false),1500); };
  const saveLn=()=>{ setLnSaved(true); setTimeout(()=>setLnSaved(false),1500); };

  const Toggle=({label,sub,val,set})=>(
    <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",
      padding:"11px 0",borderBottom:`1px solid ${C.border}` }}>
      <div style={{ flex:1,marginRight:12 }}>
        <div style={{ color:C.text,fontSize:11,fontFamily:C.fnt }}>{label}</div>
        {sub&&<div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,marginTop:2,lineHeight:1.5 }}>{sub}</div>}
      </div>
      <div onPointerDown={()=>set(v=>!v)} style={{ width:38,height:20,borderRadius:10,cursor:"pointer",position:"relative",flexShrink:0,
        background:val?C.accentBg:"rgba(255,255,255,0.04)",border:`1px solid ${val?C.accent:C.border}`,
        boxShadow:val?`0 0 8px ${C.accent}30`:"none",transition:"all 0.2s" }}>
        <div style={{ position:"absolute",top:3,width:14,height:14,borderRadius:"50%",
          background:val?C.accent:C.muted,left:val?21:3,transition:"left 0.2s,background 0.2s" }}/>
      </div>
    </div>
  );

  return (
    <div style={{ flex:1,overflowY:"auto",background:C.bg,minHeight:0 }}>
      <div style={{ margin:"14px 14px 0",background:"rgba(255,255,255,0.02)",
        border:`1px solid ${gpsPos?C.good+"40":C.border}`,borderRadius:7,padding:"11px 13px" }}>
        <div style={{ color:C.text,fontSize:11,fontFamily:C.fnt }}>📍 GPS</div>
        <div style={{ color:gpsPos?C.good:C.muted,fontSize:8,fontFamily:C.fnt,marginTop:2 }}>
          {gpsPos?`✓ ${gpsPos.lat.toFixed(5)}, ${gpsPos.lng.toFixed(5)} ±${gpsPos.acc}m`:"En attente de l'autorisation…"}
        </div>
      </div>

      <div style={{ padding:"14px 14px 0" }}>
        <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,letterSpacing:2,marginBottom:10 }}>🔑 CLÉ API JCDECAUX</div>
        <div style={{ background:"rgba(255,255,255,0.02)",border:`1px solid ${C.border}`,borderRadius:8,padding:"14px" }}>
          <div style={{ background:apiLive?"rgba(46,204,143,0.08)":"rgba(245,130,13,0.08)",
            border:`1px solid ${apiLive?C.good+"40":C.accent+"40"}`,borderRadius:4,padding:"7px 10px",marginBottom:10 }}>
            <div style={{ color:apiLive?C.good:C.accent,fontSize:9,fontFamily:C.fnt }}>
              {apiLive?"✓ LIVE — données JCDecaux temps réel":isMock?"⚠ DÉMO — GPS réels, dispos simulées":"⚠ Clé invalide"}
            </div>
            {isMock&&<div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,marginTop:2 }}>developer.jcdecaux.com (gratuit)</div>}
          </div>
          <div style={{ display:"flex",gap:8 }}>
            <input value={draft} onChange={e=>setDraft(e.target.value)} placeholder="Clé API JCDecaux…" type="password"
              style={{ flex:1,background:"rgba(0,0,0,0.4)",border:`1px solid ${C.border}`,
                borderRadius:4,padding:"8px 10px",color:C.text,fontSize:11,fontFamily:C.fnt,outline:"none" }}/>
            <div onPointerDown={saveKey} style={{ background:saved?"rgba(46,204,143,0.15)":C.accentBg,
              border:`1px solid ${saved?C.good:C.accent}`,color:saved?C.good:C.accent,
              borderRadius:4,padding:"8px 12px",fontSize:9,fontFamily:C.fnt,cursor:"pointer",fontWeight:700,whiteSpace:"nowrap" }}>
              {saved?"✓ OK":"APPLIQUER"}
            </div>
          </div>
          <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,marginTop:8,lineHeight:1.8 }}>
            GET /vls/v3/stations?contract=Luxembourg{"\n"}
            available_bikes · electrical_bikes · mechanical_bikes{"\n"}
            available_bike_stands · status · position · last_update
          </div>
        </div>
      </div>

      <div style={{ padding:"14px 14px 0" }}>
        <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,letterSpacing:2,marginBottom:10 }}>🤖 CLÉ API CLAUDE</div>
        <div style={{ background:"rgba(255,255,255,0.02)",border:`1px solid ${C.border}`,borderRadius:8,padding:"14px" }}>
          <div style={{ background:claudeKey?"rgba(46,204,143,0.08)":"rgba(245,130,13,0.08)",
            border:`1px solid ${claudeKey?C.good+"40":C.accent+"40"}`,borderRadius:4,padding:"7px 10px",marginBottom:10 }}>
            <div style={{ color:claudeKey?C.good:C.accent,fontSize:9,fontFamily:C.fnt }}>
              {claudeKey?"✓ Clé Claude configurée — assistant IA actif":"⚠ Clé Claude requise pour l'onglet AI"}
            </div>
            {!claudeKey&&<div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,marginTop:2 }}>console.anthropic.com → API Keys</div>}
          </div>
          <div style={{ display:"flex",gap:8 }}>
            <input value={claudeDraft} onChange={e=>setClaudeDraft(e.target.value)} placeholder="sk-ant-..." type="password"
              style={{ flex:1,background:"rgba(0,0,0,0.4)",border:`1px solid ${C.border}`,
                borderRadius:4,padding:"8px 10px",color:C.text,fontSize:11,fontFamily:C.fnt,outline:"none" }}/>
            <div onPointerDown={saveClaudeKey} style={{ background:claudeSaved?"rgba(46,204,143,0.15)":C.accentBg,
              border:`1px solid ${claudeSaved?C.good:C.accent}`,color:claudeSaved?C.good:C.accent,
              borderRadius:4,padding:"8px 12px",fontSize:9,fontFamily:C.fnt,cursor:"pointer",fontWeight:700,whiteSpace:"nowrap" }}>
              {claudeSaved?"✓ OK":"APPLIQUER"}
            </div>
          </div>
          <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,marginTop:8,lineHeight:1.8 }}>
            Clé stockée localement uniquement · jamais transmise à un tiers
          </div>
        </div>
      </div>

      <div style={{ padding:"14px 14px 0" }}>
        <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,letterSpacing:2,marginBottom:10 }}>⚡ SATS REWARDS</div>
        <div style={{ background:"rgba(255,255,255,0.02)",border:`1px solid ${C.border}`,borderRadius:8,padding:"0 14px" }}>
          <Toggle label="Activer" sub="Sats après chaque trajet via LNURL-pay self-custodial" val={lnOn} set={setLnOn}/>
          {lnOn&&<div style={{ paddingBottom:14 }}>
            <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,letterSpacing:2,margin:"10px 0 6px" }}>LIGHTNING ADDRESS</div>
            <div style={{ display:"flex",gap:8 }}>
              <input value={lnAddr} onChange={e=>setLnAddr(e.target.value)} placeholder="toi@getalby.com"
                style={{ flex:1,background:"rgba(0,0,0,0.4)",border:`1px solid ${C.border}`,
                  borderRadius:4,padding:"8px 10px",color:"#FCD34D",fontSize:11,fontFamily:C.fnt,outline:"none" }}/>
              <div onPointerDown={saveLn} style={{
                background:lnSaved?"rgba(46,204,143,0.15)":C.accentBg,border:`1px solid ${lnSaved?C.good:C.accent}`,
                color:lnSaved?C.good:C.accent,borderRadius:4,padding:"8px 12px",
                fontSize:9,fontFamily:C.fnt,cursor:"pointer",fontWeight:700,whiteSpace:"nowrap" }}>
                {lnSaved?"✓ OK":"SAVE"}
              </div>
            </div>
            <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,marginTop:7,lineHeight:1.8 }}>
              Alby · WoS · Phoenix · Blink · Zeus{"\n"}LNURL-pay · self-custodial · zéro serveur
            </div>
          </div>}
        </div>
      </div>

      <div style={{ padding:"14px" }}>
        <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,letterSpacing:2,marginBottom:10 }}>APPLICATION</div>
        <div style={{ background:"rgba(255,255,255,0.02)",border:`1px solid ${C.border}`,borderRadius:8,padding:"0 14px" }}>
          <Toggle label="Publicités AR" sub="Overlays sponsors dans la vue caméra" val={ads} set={setAds}/>
        </div>
      </div>
      <div style={{ height:20 }}/>
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
  const [apiKey,setApiKey]     = useState(()=>localStorage.getItem("velohnav_jcdKey")||"");
  const [claudeKey,setClaudeKey] = useState(()=>localStorage.getItem("velohnav_claudeKey")||"");
  const [lnAddr,setLnAddr]     = useState(()=>localStorage.getItem("velohnav_lnAddr")||"");
  const [lnOn,setLnOn]         = useState(()=>localStorage.getItem("velohnav_lnOn")==="true");
  const [ads,setAds]           = useState(()=>localStorage.getItem("velohnav_ads")!=="false");
  const [stations,setStations] = useState(()=>enrich(FALLBACK,null));
  const [apiLive,setApiLive]   = useState(false);
  const [isMock,setIsMock]     = useState(true);
  const [gpsPos,setGpsPos]     = useState(null);

  // Lifted AI conversation state — survives tab switches
  const top0 = FALLBACK.find(s=>s.bikes>0);
  const [aiHistory, setAiHistory] = useState([]);
  const [aiDisplay, setAiDisplay] = useState([{ role:"ai",
    text: top0 ? `${FALLBACK.filter(s=>s.bikes>0).length}/${FALLBACK.length} stations dispos. Plus proche : ${top0.name} (${fDist(haversine(REF.lat,REF.lng,top0.lat,top0.lng))}, ${top0.bikes}🚲 ⚡${top0.elec}).` : "Chargement…"
  }]);

  // Persist settings to localStorage
  useEffect(()=>{ localStorage.setItem("velohnav_jcdKey",   apiKey);    },[apiKey]);
  useEffect(()=>{ localStorage.setItem("velohnav_claudeKey",claudeKey); },[claudeKey]);
  useEffect(()=>{ localStorage.setItem("velohnav_lnAddr",   lnAddr);    },[lnAddr]);
  useEffect(()=>{ localStorage.setItem("velohnav_lnOn",     lnOn);      },[lnOn]);
  useEffect(()=>{ localStorage.setItem("velohnav_ads",      ads);       },[ads]);

  // GPS watch continu
  useEffect(()=>{
    let stop=()=>{};
    startWatchingGPS(pos=>setGpsPos(pos)).then(fn=>{ if(fn) stop=fn; });
    return ()=>stop();
  },[]);

  // Recalcul distances quand GPS change (sans re-fetch API)
  useEffect(()=>{
    setStations(prev=>enrich(prev,gpsPos));
  },[gpsPos]);

  // Ref pour que loadData lise la position GPS sans en dépendre
  const gpsRef = useRef(null);
  useEffect(()=>{ gpsRef.current = gpsPos; },[gpsPos]);

  const loadData = useCallback(async()=>{
    const userPos = gpsRef.current;
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
  },[apiKey]); // ← gpsPos retiré : évite le re-fetch à chaque update GPS

  useEffect(()=>{ loadData(); },[loadData]);
  useEffect(()=>{ const t=setInterval(loadData,60000); return()=>clearInterval(t); },[loadData]);

  return (
    <div style={{ width:"100%",height:"100vh",display:"flex",flexDirection:"column",
      background:C.bg,overflow:"hidden",maxWidth:430,margin:"0 auto" }}>
      <StatusBar tab={tab} gpsOk={!!gpsPos} apiLive={apiLive} isMock={isMock}/>
      <div style={{ flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minHeight:0 }}>
        {tab==="ar"       &&<ARScreen  stations={stations} sel={sel} setSel={setSel} gpsPos={gpsPos}/>}
        {tab==="map"      &&<MapScreen stations={stations} sel={sel} setSel={setSel} gpsPos={gpsPos}/>}
        {tab==="ai"       &&<AIScreen  stations={stations} claudeKey={claudeKey}
          aiHistory={aiHistory} setAiHistory={setAiHistory}
          aiDisplay={aiDisplay} setAiDisplay={setAiDisplay}/>}
        {tab==="settings" &&<SettingsScreen
          apiKey={apiKey}    setApiKey={setApiKey}
          claudeKey={claudeKey} setClaudeKey={setClaudeKey}
          lnAddr={lnAddr}    setLnAddr={setLnAddr}
          lnOn={lnOn}        setLnOn={setLnOn}
          ads={ads}          setAds={setAds}
          onRefresh={loadData} apiLive={apiLive} isMock={isMock} gpsPos={gpsPos}/>}
      </div>
      <NavBar tab={tab} setTab={setTab}/>
    </div>
  );
}
