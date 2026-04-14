import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// ── GPS ───────────────────────────────────────────────────────────
// @capacitor/geolocation supprimé : son Kotlin 1.9 interne est incompatible
// avec stdlib 2.1.0 tirée en transitif → build impossible.
// navigator.geolocation fonctionne nativement dans le WebView Capacitor Android
// (permissions ACCESS_FINE_LOCATION déjà dans AndroidManifest.xml).

async function startWatchingGPS(cb) {
  if (!navigator.geolocation) return () => {};
  const id = navigator.geolocation.watchPosition(
    p => cb({ lat:p.coords.latitude, lng:p.coords.longitude, acc:Math.round(p.coords.accuracy) }),
    e => console.warn("GPS:", e),
    { enableHighAccuracy:true, maximumAge:5000 }
  );
  return () => navigator.geolocation.clearWatch(id);
}

// JCDecaux — fetch direct, fallback proxy CORS si bloqué (prototype web)
async function fetchJCDecaux(apiKey) {
  const url = `https://api.jcdecaux.com/vls/v3/stations?contract=Luxembourg&apiKey=${apiKey}`;
  try {
    const r = await fetch(url);
    if (r.ok) return await r.json();
  } catch {}
  // Fallback proxy CORS pour prototype web (ne pas utiliser en prod — expose la clé)
  try {
    const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`);
    if (r.ok) return await r.json();
  } catch {}
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
// FIX : Math.round(0/80) = 0 → affichait "0 min". Math.ceil + seuil < 1 min.
const fWalk = m => m < 40 ? "< 1 min" : `${Math.ceil(m/80)} min`;
const bCol  = s => s.status==="CLOSED"?"#444":s.bikes===0?C.bad:s.bikes<=2?C.warn:C.good;
const bTag  = s => s.status==="CLOSED"?"FERMÉ":s.bikes===0?"VIDE":s.bikes<=2?"FAIBLE":"DISPO";

function parseStation(raw) {
  const av = raw.totalStands?.availabilities ?? {};
  // FIX : meca était toujours 0. JCDecaux v3 expose bien mechanicalBikes.
  const elec  = av.electricalBikes ?? av.electricalInternalBatteryBikes ?? av.electricalExternalBatteryBikes ?? 0;
  const bikes = av.bikes ?? raw.available_bikes ?? 0;
  const meca  = av.mechanicalBikes ?? Math.max(0, bikes - elec);
  return {
    id:    raw.number,
    name:  (raw.name||"").replace(/^\d+[\s\-]+/,"").trim(),
    lat:   raw.position?.latitude  ?? raw.position?.lat,
    lng:   raw.position?.longitude ?? raw.position?.lng,
    cap:   raw.totalStands?.capacity ?? raw.bike_stands ?? 0,
    bikes,
    elec,
    meca,
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
  bikes:s.b, elec:s.e, meca:0, docks:s.cap-s.b,
  status:s.b===0&&s.id===33?"CLOSED":"OPEN", _mock:true }));

function enrich(list, pos) {
  const ref = pos ?? REF;
  return list.filter(s=>s.lat&&s.lng)
    .map(s=>({ ...s, dist:haversine(ref.lat,ref.lng,s.lat,s.lng) }))
    .sort((a,b)=>a.dist-b.dist);
}

// FIX #10 : fakePins orientés — si heading connu, projette les stations réelles
// dans le FOV de la caméra; sinon fallback positions fixes nord-sud
function pins(stations, heading=null, gpsPos=null) {
  if (heading !== null && gpsPos) {
    const FOV_=68;
    return stations
      .filter(s=>s.lat&&s.lng&&s.dist<15000)
      .map(s=>{
        const bear=getBearing(gpsPos.lat,gpsPos.lng,s.lat,s.lng);
        const rel=((bear-heading+540)%360)-180;
        if(Math.abs(rel)>FOV_/2+8) return null;
        const x=50+(rel/(FOV_/2))*50;
        const dc=Math.min(s.dist,12000);
        const y=70-(1-dc/12000)*44;
        const scale=Math.max(0.3,1-dc/14000);
        return{...s,x,y,scale,labelRight:rel<0,rel};
      })
      .filter(Boolean)
      .sort((a,b)=>b.dist-a.dist)
      .slice(0,8);
  }
  // Fallback statique : 6 stations les plus proches en grille 3×2
  return stations.slice(0,6).map((s,i)=>({
    ...s, x:13+(i%3)*34, y:28+Math.floor(i/3)*38, labelRight:(i%3)<2, scale:1,
  }));
}

// ── HISTORIQUE STATIONS (feature #13) ────────────────────────────
const HIST_KEY = "velohnav_history";
function getHistory() {
  try { return JSON.parse(localStorage.getItem(HIST_KEY)||"[]"); } catch { return []; }
}
function addToHistory(station) {
  const prev = getHistory().filter(h=>h.id!==station.id);
  const entry = { id:station.id, name:station.name, lat:station.lat, lng:station.lng,
    visitedAt: Date.now() };
  localStorage.setItem(HIST_KEY, JSON.stringify([entry,...prev].slice(0,10)));
}

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

// ── NOTIFICATIONS (feature #14) ──────────────────────────────────
async function requestNotifPerm() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  const p = await Notification.requestPermission();
  return p === "granted";
}
function notifyStation(station, prevBikes) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (station.bikes === 0 && prevBikes > 0) {
    new Notification(`🚲 ${station.name} est vide`, {
      body: `Plus aucun vélo disponible.`,
      icon: "./icon-192.png", tag: `empty-${station.id}`, silent: false,
    });
  } else if (station.bikes <= 2 && prevBikes > 2) {
    new Notification(`⚠️ ${station.name} presque vide`, {
      body: `Plus que ${station.bikes} vélo${station.bikes>1?"s":""} disponible${station.bikes>1?"s":""}.`,
      icon: "./icon-192.png", tag: `low-${station.id}`, silent: true,
    });
  }
}

// ── COMPASS HOOK ──────────────────────────────────────────────────
function useCompass(){
  const [heading,setHeading]=useState(null);
  const [perm,setPerm]=useState("idle");
  const cleanup=useRef(null);

  const start=useCallback(async()=>{
    setPerm("requesting");

    // iOS 13+ seulement
    if(typeof DeviceOrientationEvent?.requestPermission==="function"){
      try{
        const r=await DeviceOrientationEvent.requestPermission();
        if(r!=="granted"){setPerm("denied");return;}
      }catch{setPerm("denied");return;}
    }
    if(!window.DeviceOrientationEvent){setPerm("unavailable");return;}

    let last=null;
    let gotAbsolute=false; // true dès qu'on reçoit un event absolu valide

    const update=(h)=>{
      last=last===null?h:last+((h-last+540)%360-180)*0.2;
      setHeading(Math.round((last+360)%360));
    };

    // Handler absolu (Android Chrome 74+ : alpha = cap magnétique réel)
    const absHandler=(e)=>{
      if(e.alpha==null) return;
      gotAbsolute=true;
      update((360-e.alpha+360)%360);
    };

    // Handler relatif — utilisé SEULEMENT si aucun absolu reçu
    // iOS → webkitCompassHeading, Android fallback → alpha relatif
    const relHandler=(e)=>{
      if(gotAbsolute) return;
      if(e.webkitCompassHeading!=null)      update(e.webkitCompassHeading);
      else if(e.alpha!=null)                update((360-e.alpha+360)%360);
    };

    window.addEventListener("deviceorientationabsolute",absHandler,true);
    window.addEventListener("deviceorientation",relHandler,true);
    setPerm("granted");

    // Timeout : si aucun signal après 4s → diagnostic
    const t=setTimeout(()=>{
      setHeading(h=>{
        if(h===null) setPerm("nosignal");
        return h;
      });
    },4000);

    cleanup.current=()=>{
      clearTimeout(t);
      window.removeEventListener("deviceorientationabsolute",absHandler,true);
      window.removeEventListener("deviceorientation",relHandler,true);
    };
  },[]);

  useEffect(()=>()=>cleanup.current?.(),[]);
  return{heading,perm,start};
}

// ── NAV OVERLAY — flèche AR + corridor bleu ───────────────────────
function NavOverlay({ relBear, dist, name }) {
  const cvRef = useRef();
  const abs   = Math.abs(relBear ?? 0);
  const arriving = dist < 40;
  const onTrack  = abs < 14;
  const col = arriving ? C.good : onTrack ? "#3B82F6" : C.accent;

  const dirLabel = arriving          ? "ARRIVÉE !"
    : abs < 14                       ? "TOUT DROIT"
    : abs < 50 && relBear < 0        ? "◀  TOURNE À GAUCHE"
    : abs < 50 && relBear > 0        ? "TOURNE À DROITE  ▶"
    : abs < 120 && relBear < 0       ? "◀◀  DEMI-TOUR GAUCHE"
    : abs < 120 && relBear > 0       ? "DEMI-TOUR DROITE  ▶▶"
    :                                  "FAIS DEMI-TOUR";

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
function StatusBar({ tab, gpsOk, apiLive, isMock, onRefresh, refreshing }) {
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
        {/* Bouton refresh manuel (#8) */}
        <div onPointerDown={onRefresh}
          style={{ padding:"3px 6px", background:"rgba(0,0,0,0.4)",
            border:`1px solid ${C.border}`, borderRadius:3, cursor:"pointer",
            fontSize:10, transform:refreshing?"rotate(180deg)":"rotate(0deg)",
            transition:"transform 0.5s", userSelect:"none" }}>
          🔄
        </div>
        <div style={{ color:C.text, fontSize:11, fontFamily:C.fnt, fontWeight:700,
          padding:"3px 6px", background:"rgba(0,0,0,0.4)", border:`1px solid ${C.border}`, borderRadius:3 }}>
          {t.toLocaleTimeString("fr",{hour:"2-digit",minute:"2-digit"})}
        </div>
      </div>
    </div>
  );
}

// ── DRAPEAU DAMIER (SVG inline) ───────────────────────────────────
// Drapeau de ligne d'arrivée flottant au-dessus de chaque pin AR.
// Taille et opacité pilotées par scale (distance).
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
  const dotSize=Math.round((isSel?14:9)*scale);
  return (
    <div onPointerDown={()=>setSel(isSel?null:s.id)}
      style={{ position:"absolute", left:`${s.x}%`, top:`${s.y}%`,
        transform:"translate(-50%,-50%)", cursor:"pointer",
        zIndex:isSel?25:14, padding:14, margin:-14 }}>

      {/* Drapeau damier au-dessus du dot */}
      <div style={{ position:"absolute", bottom:"50%", left:"50%",
        transform:"translateX(-50%)", pointerEvents:"none", zIndex:3 }}>
        <CheckeredFlag scale={scale} col={col} isSel={isSel}/>
      </div>

      {/* Pulse ring */}
      <div style={{ position:"absolute", top:14, left:14, width:dotSize, height:dotSize, borderRadius:"50%",
        boxShadow:`0 0 0 ${pulse?10:3}px ${col}22`, transition:"box-shadow 1s", pointerEvents:"none" }}/>
      {/* Dot */}
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
const FOV=68;

function ARScreen({ stations, sel, setSel, gpsPos, trip, onStartTrip }) {
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
    return stations
      .filter(s=>s.lat&&s.lng&&s.dist<15000)   // FIX : 1600m → 15km
      .map(s=>{
        const bear=getBearing(gpsPos.lat,gpsPos.lng,s.lat,s.lng);
        const rel=((bear-heading+540)%360)-180;
        if(Math.abs(rel)>FOV/2+8) return null;
        const x=50+(rel/(FOV/2))*50;
        // Projection verticale adaptée à 15km : stations proches haut, lointaines bas
        const dc=Math.min(s.dist,12000);
        const y=70-(1-dc/12000)*44;
        const scale=Math.max(0.3,1-dc/14000);
        return{...s,x,y,scale,labelRight:rel<0,rel};
      })
      .filter(Boolean)
      .sort((a,b)=>b.dist-a.dist);
  },[heading,gpsPos,stations]);

  const fakePins=useMemo(()=>pins(stations,heading,gpsPos),[stations,heading,gpsPos]);
  const visiblePins=arPins??fakePins;

  // ── Nav overlay ────────────────────────────────────────────────
  const navStation=stations.find(s=>s.id===sel);
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
    if(perm==="requesting") return{label:"INITIALISATION…",col:C.warn};
    if(perm==="denied")     return{label:"BOUSSOLE REFUSÉE",col:C.bad};
    if(perm==="unavailable")return{label:"CAPTEUR INDISPONIBLE",col:C.bad};
    if(perm==="nosignal")   return{label:"AUCUN SIGNAL — PAGE EN HTTPS ?",col:C.bad};
    if(heading===null)      return{label:"ATTENTE CAPTEUR…",col:C.warn};
    return{label:`AR ACTIF · ${hdg}° ${cardLabel}`,col:C.good};
  };
  const cs=compassStatus();

  return (
    <div style={{position:"relative",flex:1,overflow:"hidden",minHeight:0,background:"#000"}}>

      <video ref={vidRef} muted playsInline autoPlay style={{
        position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover",zIndex:1,
        opacity:cam==="active"?1:0,transition:"opacity 0.5s"}}/>
      {cam!=="active"&&<div style={{position:"absolute",inset:0,zIndex:2}}><CityBG off={bgOff}/></div>}

      <div style={{position:"absolute",inset:0,zIndex:5,pointerEvents:"none"}}>
        <div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse at center,transparent 30%,rgba(0,0,0,0.35) 100%)"}}/>
        <div style={{position:"absolute",top:0,left:0,right:0,height:70,background:"linear-gradient(to bottom,rgba(8,12,15,0.65),transparent)"}}/>
        <div style={{position:"absolute",bottom:0,left:0,right:0,height:230,background:"linear-gradient(to top,rgba(8,12,15,0.98),rgba(8,12,15,0.4) 60%,transparent)"}}/>
      </div>

      {navRel!==null&&<NavOverlay relBear={navRel} dist={navStation?.dist??0} name={navStation?.name??""}/>}

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
                ▶ ACTIVER AR
              </button>
              <div style={{color:C.muted,fontSize:8,fontFamily:C.fnt,textAlign:"center",lineHeight:1.6}}>
                Caméra + boussole
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
              <div style={{color:C.bad,fontSize:10,fontFamily:C.fnt,marginBottom:8}}>CAMÉRA REFUSÉE</div>
              <div style={{color:C.muted,fontSize:9,fontFamily:C.fnt,lineHeight:1.7}}>
                Paramètres → Apps → VelohNav → Autorisations → Caméra
              </div>
              <button onPointerDown={startAR} style={{
                background:"rgba(224,62,62,0.1)",border:`1px solid ${C.bad}`,color:C.bad,
                borderRadius:4,padding:"8px 20px",fontSize:9,fontFamily:C.fnt,
                cursor:"pointer",marginTop:12}}>RÉESSAYER</button>
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
                {l:"⚡ ÉLEC.",v:navStation.elec, col:"#60A5FA"},
                {l:"🔧 MÉCA.",v:navStation.meca, col:C.text},
                {l:"DOCKS",v:navStation.docks,col:C.good},
                {l:"CAP.",  v:navStation.cap,  col:C.muted},
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
                :`${stations.filter(s=>s.bikes>0).length}/${stations.length} DISPO · TOUCHE UN PIN`}
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

  const rCol  = `rgba(255,255,255,0.30)`;   // routes — blanc
  const rivCol = `rgba(100,210,255,0.70)`;   // Alzette — bleu vif
  const petCol = `rgba(100,200,255,0.45)`;   // Pétrusse — bleu moyen
  const kEdge  = `rgba(255,190,80,0.30)`;    // Kirchberg edge — orange doux
  const kBridg = `rgba(255,255,255,0.42)`;   // pont Kirchberg — blanc
  const lblCol = `rgba(255,255,255,0.52)`;   // labels — blanc lisible

  return (
    <svg style={{ position:"absolute",inset:0,width:"100%",height:"100%",pointerEvents:"none" }}
      viewBox="0 0 100 100" preserveAspectRatio="none">

      {/* Kirchberg plateau edge */}
      <polyline points={pts(kirchbergEdge)}
        fill="none" stroke={kEdge} strokeWidth="2.5"
        strokeDasharray="1,2.5"/>

      {/* Rivers */}
      <polyline points={pts(alzette)}
        fill="none" stroke={rivCol} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
      <polyline points={pts(petrusse)}
        fill="none" stroke={petCol} strokeWidth="0.9" strokeLinecap="round"/>

      {/* Roads */}
      <path d={road(bvdRoyal)}    fill="none" stroke={rCol} strokeWidth="1.1" strokeLinecap="round"/>
      <path d={road(avGare)}      fill="none" stroke={rCol} strokeWidth="0.8" strokeLinecap="round"/>
      <path d={road(routeArlon)}  fill="none" stroke={rCol} strokeWidth="0.8" strokeLinecap="round"/>
      <path d={road(kirchbergBridge)} fill="none" stroke={kBridg} strokeWidth="1.1" strokeLinecap="round"/>
      <path d={road(routeEsch)}   fill="none" stroke={rCol} strokeWidth="0.8" strokeLinecap="round"/>
      <path d={road(avgJFK)}      fill="none" stroke={rCol} strokeWidth="0.8" strokeLinecap="round"/>

      {/* District labels */}
      {labels.map(([la,ln,txt])=>{
        const {x,y}=toXY(la,ln);
        return (
          <text key={txt} x={x} y={y}
            fill={lblCol} fontSize="3.5"
            fontFamily="'Courier New',monospace" textAnchor="middle" letterSpacing="1">
            {txt}
          </text>
        );
      })}
    </svg>
  );
}

// ── MAP SCREEN ────────────────────────────────────────────────────
function MapScreen({ stations, sel, setSel, gpsPos, trip, onStartTrip }) {
  const [filter, setFilter] = useState("all"); // all | bikes | docks | elec
  const [search, setSearch] = useState("");

  // Stations filtrées pour affichage
  const displayed = useMemo(()=>{
    let s = stations;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      s = s.filter(st=>st.name.toLowerCase().includes(q));
    }
    if (filter==="bikes") s = s.filter(st=>st.bikes>0&&st.status==="OPEN");
    if (filter==="docks") s = s.filter(st=>st.docks>0&&st.status==="OPEN");
    if (filter==="elec")  s = s.filter(st=>st.elec>0&&st.status==="OPEN");
    return s;
  },[stations, filter, search]);

  if (!stations.length) return (
    <div style={{ flex:1,display:"flex",alignItems:"center",justifyContent:"center",background:C.bg }}>
      <div style={{ color:C.muted,fontSize:10,fontFamily:C.fnt }}>Chargement des stations…</div>
    </div>
  );

  // ── Bounding box sur TOUTES les stations (stable même si filtre actif)
  const margin=0.012;
  const lats=stations.map(s=>s.lat), lngs=stations.map(s=>s.lng);
  const ltMin=Math.min(...lats)-margin, ltMax=Math.max(...lats)+margin;
  const lnMin=Math.min(...lngs)-margin, lnMax=Math.max(...lngs)+margin;
  const toXY=(la,ln)=>({ x:(ln-lnMin)/(lnMax-lnMin)*90+5, y:(1-(la-ltMin)/(ltMax-ltMin))*90+5 });
  const ux=toXY(gpsPos?.lat??REF.lat, gpsPos?.lng??REF.lng);

  // ── Pan / Zoom state ────────────────────────────────────────────
  const [view,setView]=useState({x:0,y:0,s:1});
  const viewRef=useRef({x:0,y:0,s:1});
  const containerRef=useRef(null);
  const ptrs=useRef(new Map());
  const gesture=useRef(null);
  const didMove=useRef(false);

  const applyView=useCallback(v=>{
    viewRef.current=v;
    setView({...v});
  },[]);

  const onPtrDown=useCallback(e=>{
    e.currentTarget.setPointerCapture(e.pointerId);
    ptrs.current.set(e.pointerId,[e.clientX,e.clientY]);
    didMove.current=false;
    if(ptrs.current.size===1){
      gesture.current={ type:"pan", ox:e.clientX, oy:e.clientY, vx:viewRef.current.x, vy:viewRef.current.y };
    } else if(ptrs.current.size===2){
      const [[x1,y1],[x2,y2]]=[...ptrs.current.values()];
      gesture.current={ type:"pinch", d0:Math.hypot(x2-x1,y2-y1), s0:viewRef.current.s,
        vx:viewRef.current.x, vy:viewRef.current.y, cx:(x1+x2)/2, cy:(y1+y2)/2 };
    }
  },[]);

  const onPtrMove=useCallback(e=>{
    ptrs.current.set(e.pointerId,[e.clientX,e.clientY]);
    const g=gesture.current; if(!g) return;
    if(g.type==="pan"){
      const dx=e.clientX-g.ox, dy=e.clientY-g.oy;
      if(Math.hypot(dx,dy)>5) didMove.current=true;
      if(didMove.current) applyView({...viewRef.current, x:g.vx+dx, y:g.vy+dy});
    } else if(g.type==="pinch"){
      didMove.current=true;
      const [[x1,y1],[x2,y2]]=[...ptrs.current.values()];
      const d=Math.hypot(x2-x1,y2-y1);
      const ns=Math.max(1,Math.min(8,g.s0*d/g.d0)); // min 1 = pas de dézoom sous vue totale
      const rect=containerRef.current?.getBoundingClientRect();
      if(!rect) return;
      const lx=g.cx-rect.left, ly=g.cy-rect.top;
      const cx_c=(lx-g.vx)/g.s0, cy_c=(ly-g.vy)/g.s0;
      applyView({ s:ns, x:lx-cx_c*ns, y:ly-cy_c*ns });
    }
  },[applyView]);

  const onPtrUp=useCallback(e=>{
    ptrs.current.delete(e.pointerId);
    if(ptrs.current.size===0) gesture.current=null;
    else if(ptrs.current.size===1){
      const [,[cx,cy]]=[...ptrs.current.entries()][0];
      gesture.current={ type:"pan", ox:cx, oy:cy, vx:viewRef.current.x, vy:viewRef.current.y };
    }
  },[]);

  // Zoom buttons
  const zoomIn  = useCallback(()=>{
    const v=viewRef.current; const ns=Math.min(8,v.s*1.5);
    const rect=containerRef.current?.getBoundingClientRect(); if(!rect) return;
    const cx=rect.width/2, cy=rect.height/2;
    applyView({ s:ns, x:cx-(cx-v.x)/v.s*ns, y:cy-(cy-v.y)/v.s*ns });
  },[applyView]);
  const zoomOut = useCallback(()=>{
    const v=viewRef.current; const ns=Math.max(1,v.s/1.5);
    if(ns===1){ applyView({x:0,y:0,s:1}); return; }
    const rect=containerRef.current?.getBoundingClientRect(); if(!rect) return;
    const cx=rect.width/2, cy=rect.height/2;
    applyView({ s:ns, x:cx-(cx-v.x)/v.s*ns, y:cy-(cy-v.y)/v.s*ns });
  },[applyView]);
  const resetView=useCallback(()=>applyView({x:0,y:0,s:1}),[applyView]);

  // Centre sur la position utilisateur
  const centerOnUser=useCallback(()=>{
    const rect=containerRef.current?.getBoundingClientRect(); if(!rect) return;
    const ns=3;
    const px=ux.x/100*rect.width, py=ux.y/100*rect.height;
    applyView({ s:ns, x:rect.width/2-px*ns, y:rect.height/2-py*ns });
  },[applyView,ux]);

  const isPanned=Math.abs(view.x)>4||Math.abs(view.y)>4||view.s>1.05;
  const selStation=displayed.find(s=>s.id===sel) ?? stations.find(s=>s.id===sel);

  // Stats résumées (sur toutes les stations, pas juste filtrées)
  const nDispo=stations.filter(s=>s.bikes>0&&s.status==="OPEN").length;
  const nVide=stations.filter(s=>s.bikes===0&&s.status==="OPEN").length;

  // Filtres
  const FILTERS=[
    {id:"all",  label:"Tout",    count:stations.length},
    {id:"bikes",label:"🚲 Vélos",count:stations.filter(s=>s.bikes>0&&s.status==="OPEN").length},
    {id:"docks",label:"🅿 Docks", count:stations.filter(s=>s.docks>0&&s.status==="OPEN").length},
    {id:"elec", label:"⚡ Élec",  count:stations.filter(s=>s.elec>0&&s.status==="OPEN").length},
  ];

  return (
    <div style={{ flex:1,display:"flex",flexDirection:"column",background:C.bg,minHeight:0,position:"relative" }}>

      {/* ── Barre recherche ───────────────────────────────── */}
      <div style={{ padding:"8px 10px 0",flexShrink:0 }}>
        <div style={{ display:"flex",alignItems:"center",gap:6,
          background:"rgba(255,255,255,0.04)", border:`1px solid ${C.border}`,
          borderRadius:8, padding:"6px 10px" }}>
          <span style={{ color:C.muted, fontSize:12 }}>🔍</span>
          <input value={search} onChange={e=>setSearch(e.target.value)}
            placeholder="Rechercher une station…"
            style={{ flex:1, background:"transparent", border:"none", outline:"none",
              color:C.text, fontSize:11, fontFamily:C.fnt }}/>
          {search&&<span onPointerDown={()=>setSearch("")}
            style={{ color:C.muted, fontSize:12, cursor:"pointer" }}>✕</span>}
        </div>
      </div>

      {/* ── Filtres pills ─────────────────────────────────── */}
      <div style={{ display:"flex",gap:5,padding:"6px 10px 4px",flexShrink:0,overflowX:"auto" }}>
        {FILTERS.map(f=>(
          <div key={f.id} onPointerDown={()=>setFilter(f.id)}
            style={{ flexShrink:0, padding:"4px 10px",
              background: filter===f.id ? C.accentBg : "rgba(255,255,255,0.03)",
              border:`1px solid ${filter===f.id ? C.accent : C.border}`,
              borderRadius:12, cursor:"pointer",
              display:"flex", alignItems:"center", gap:4 }}>
            <span style={{ color:filter===f.id?C.accent:C.muted, fontSize:9, fontFamily:C.fnt }}>
              {f.label}
            </span>
            <span style={{ color:filter===f.id?C.accent:"#444", fontSize:8, fontFamily:C.fnt }}>
              {f.count}
            </span>
          </div>
        ))}
        {/* Stats inline */}
        <div style={{ marginLeft:"auto",flexShrink:0,display:"flex",alignItems:"center" }}>
          <span style={{ color:C.muted,fontSize:7,fontFamily:C.fnt }}>
            <span style={{ color:C.good }}>{nDispo}</span>✓{" "}
            <span style={{ color:C.bad }}>{nVide}</span>✗
          </span>
        </div>
      </div>

      {/* ── Carte ────────────────────────────────────────── */}
      <div ref={containerRef}
        style={{ flex:1,position:"relative",margin:"0 10px 6px",
          background:"rgba(4,8,12,0.95)",border:`1px solid ${C.border}`,borderRadius:10,
          overflow:"hidden",touchAction:"none",userSelect:"none" }}
        onPointerDown={onPtrDown}
        onPointerMove={onPtrMove}
        onPointerUp={onPtrUp}
        onPointerCancel={onPtrUp}>

        {/* Contenu transformable */}
        <div style={{
          position:"absolute",inset:0,
          transform:`translate(${view.x}px,${view.y}px) scale(${view.s})`,
          transformOrigin:"0 0", willChange:"transform",
        }}>
          {/* Grille subtile */}
          <svg style={{ position:"absolute",inset:0,width:"100%",height:"100%",opacity:0.025,pointerEvents:"none" }}>
            <defs><pattern id="mg" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M40 0L0 0 0 40" fill="none" stroke={C.accent} strokeWidth="0.4"/>
            </pattern></defs>
            <rect width="100%" height="100%" fill="url(#mg)"/>
          </svg>

          {/* Croquis SVG Luxembourg */}
          <LuxMap toXY={toXY}/>

          {/* Stations filtrées — dot adaptatif selon zoom */}
          {displayed.map(s=>{
            const {x,y}=toXY(s.lat,s.lng);
            const col=bCol(s);
            const act=sel===s.id;
            // Taille inversement proportionnelle au zoom — reste lisible à toute échelle
            const dotR = act ? 7 : Math.max(4, 7/view.s);
            return (
              <div key={s.id}
                onPointerDown={e=>e.stopPropagation()}
                onClick={()=>{ if(!didMove.current) setSel(act?null:s.id); }}
                style={{ position:"absolute", left:`${x}%`, top:`${y}%`,
                  transform:"translate(-50%,-50%)",
                  width:Math.max(28,dotR*4), height:Math.max(28,dotR*4),
                  display:"flex",alignItems:"center",justifyContent:"center",
                  cursor:"pointer", zIndex:act?20:8 }}>
                {/* Pulse ring si sélectionné */}
                {act&&<div style={{ position:"absolute", width:dotR*4, height:dotR*4,
                  borderRadius:"50%", border:`1.5px solid ${col}`,
                  animation:"pulse 1.2s ease-in-out infinite", opacity:0.6 }}/>}
                {/* Dot principal */}
                <div style={{
                  width:dotR*2, height:dotR*2, borderRadius:"50%",
                  background: act ? col : s.status==="CLOSED" ? "#333" : col,
                  boxShadow: act ? `0 0 10px ${col}, 0 0 3px ${col}` : `0 0 ${dotR}px ${col}60`,
                  border:`${act?2:1}px solid ${act?"#fff":col+"80"}`,
                  transition:"all 0.15s",
                }}/>
                {/* Label au zoom ×3+ */}
                {(view.s>=3||act)&&(
                  <div style={{ position:"absolute", top:"100%", left:"50%",
                    transform:"translateX(-50%)", marginTop:2,
                    background:"rgba(6,10,14,0.92)", border:`1px solid ${col}44`,
                    borderRadius:3, padding:"2px 5px", whiteSpace:"nowrap",
                    pointerEvents:"none", zIndex:30 }}>
                    <div style={{ color:act?col:C.text, fontSize:Math.max(7,9/view.s),
                      fontFamily:C.fnt, fontWeight:700, lineHeight:1 }}>
                      {s.name.length>18?s.name.slice(0,17)+"…":s.name}
                    </div>
                    <div style={{ color:col, fontSize:Math.max(6,8/view.s),
                      fontFamily:C.fnt, lineHeight:1.2 }}>
                      {s.bikes}🚲 {s.elec>0?`⚡${s.elec} `:""}{fDist(s.dist)}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Position utilisateur */}
          <div style={{ position:"absolute",left:`${ux.x}%`,top:`${ux.y}%`,
            transform:"translate(-50%,-50%)",zIndex:25,pointerEvents:"none" }}>
            <div style={{ position:"absolute",width:20,height:20,borderRadius:"50%",
              top:-5,left:-5,border:`1.5px solid ${C.blue}55`}}/>
            <div style={{ width:10,height:10,borderRadius:"50%",background:C.blue,
              boxShadow:`0 0 12px ${C.blue}` }}/>
          </div>
        </div>

        {/* ── Boutons zoom (fixe) ─────────────────── */}
        <div style={{ position:"absolute",right:10,bottom:isPanned?50:14,zIndex:30,
          display:"flex",flexDirection:"column",gap:4 }}>
          {[["＋",zoomIn],["－",zoomOut]].map(([icon,fn])=>(
            <div key={icon} onPointerDown={e=>{e.stopPropagation();fn();}}
              style={{ width:32,height:32,background:"rgba(8,12,15,0.92)",
                border:`1px solid ${C.border}`,borderRadius:6,cursor:"pointer",
                display:"flex",alignItems:"center",justifyContent:"center",
                color:C.text,fontSize:16,fontFamily:C.fnt,
                boxShadow:"0 2px 8px rgba(0,0,0,0.5)" }}>
              {icon}
            </div>
          ))}
          {/* Centrer sur moi */}
          {gpsPos&&<div onPointerDown={e=>{e.stopPropagation();centerOnUser();}}
            style={{ width:32,height:32,background:"rgba(8,12,15,0.92)",
              border:`1px solid ${C.blue}55`,borderRadius:6,cursor:"pointer",
              display:"flex",alignItems:"center",justifyContent:"center",
              fontSize:14, boxShadow:"0 2px 8px rgba(0,0,0,0.5)" }}>
            📍
          </div>}
        </div>

        {/* Bouton reset */}
        {isPanned&&(
          <div onPointerDown={e=>{e.stopPropagation();resetView();}}
            style={{ position:"absolute",bottom:14,right:10,zIndex:30,
              background:"rgba(8,12,15,0.92)",border:`1px solid ${C.accent}55`,
              borderRadius:5,padding:"5px 10px",cursor:"pointer",
              display:"flex",alignItems:"center",gap:4 }}>
            <span style={{ color:C.accent,fontSize:8,fontFamily:C.fnt,letterSpacing:1 }}>⊙ TOUT</span>
          </div>
        )}

        {/* Zoom level */}
        {view.s>1.2&&(
          <div style={{ position:"absolute",top:8,left:8,zIndex:30,pointerEvents:"none",
            background:"rgba(8,12,15,0.80)",border:`1px solid ${C.border}`,
            borderRadius:4,padding:"2px 6px" }}>
            <span style={{ color:C.muted,fontSize:7,fontFamily:C.fnt }}>×{view.s.toFixed(1)}</span>
          </div>
        )}
      </div>

      {/* ── Panel station sélectionnée (bas) ─────── */}
      {selStation ? (
        <div style={{ flexShrink:0, margin:"0 10px 10px",
          background:"rgba(8,12,15,0.97)", border:`1px solid ${C.border}`,
          borderTop:`2px solid ${bCol(selStation)}`, borderRadius:8,
          padding:"11px 14px" }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8 }}>
            <div>
              <div style={{ color:C.muted,fontSize:7,fontFamily:C.fnt,letterSpacing:1.5,marginBottom:2 }}>
                {bTag(selStation)} · {fDist(selStation.dist)} · {fWalk(selStation.dist)} à pied
                {selStation._mock&&" · données simulées"}
              </div>
              <div style={{ color:C.text,fontSize:14,fontFamily:C.fnt,fontWeight:700 }}>{selStation.name}</div>
            </div>
            <div onPointerDown={()=>setSel(null)}
              style={{ padding:"5px 8px",background:"rgba(255,255,255,0.04)",
                border:`1px solid ${C.border}`,borderRadius:4,color:C.muted,
                fontSize:11,cursor:"pointer",flexShrink:0 }}>✕</div>
          </div>
          <div style={{ display:"flex",borderTop:`1px solid ${C.border}`,paddingTop:9 }}>
            {[
              {l:"VÉLOS",  v:selStation.bikes, col:bCol(selStation)},
              {l:"⚡ÉLEC", v:selStation.elec,  col:"#60A5FA"},
              {l:"🔧MÉCA", v:selStation.meca,  col:C.text},
              {l:"DOCKS",  v:selStation.docks, col:C.good},
              {l:"CAP.",   v:selStation.cap,   col:C.muted},
            ].map((m,i)=>(
              <div key={m.l} style={{ flex:1,textAlign:"center",
                borderRight:i<4?`1px solid ${C.border}`:"none" }}>
                <div style={{ color:m.col,fontSize:18,fontFamily:C.fnt,fontWeight:700 }}>{m.v}</div>
                <div style={{ color:C.muted,fontSize:6,fontFamily:C.fnt,letterSpacing:0.5,marginTop:1 }}>{m.l}</div>
              </div>
            ))}
          </div>
          {/* Bouton Y aller → Google Maps pied (#12) */}
          <div style={{ marginTop:10,display:"flex",gap:6 }}>
            <a href={`https://www.google.com/maps/dir/?api=1&destination=${selStation.lat},${selStation.lng}&travelmode=walking`}
              target="_blank" rel="noopener noreferrer"
              style={{ flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6,
                background:"rgba(59,130,246,0.12)",border:`1px solid ${C.blue}55`,
                borderRadius:6,padding:"8px 0",textDecoration:"none" }}>
              <span style={{ fontSize:13 }}>🗺</span>
              <span style={{ color:C.blue,fontSize:9,fontFamily:C.fnt,fontWeight:700,letterSpacing:1 }}>À PIED</span>
            </a>
            <a href={`https://www.google.com/maps/dir/?api=1&destination=${selStation.lat},${selStation.lng}&travelmode=bicycling`}
              target="_blank" rel="noopener noreferrer"
              style={{ flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6,
                background:C.accentBg,border:`1px solid ${C.accent}55`,
                borderRadius:6,padding:"8px 0",textDecoration:"none" }}>
              <span style={{ fontSize:13 }}>🚲</span>
              <span style={{ color:C.accent,fontSize:9,fontFamily:C.fnt,fontWeight:700,letterSpacing:1 }}>EN VÉLO</span>
            </a>
            {/* Bouton démarrer trajet (#3) — si pas déjà en cours */}
            {!trip&&selStation.bikes>0&&onStartTrip&&(
              <div onPointerDown={()=>onStartTrip(selStation)}
                style={{ flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:4,
                  background:"rgba(46,204,143,0.12)",border:`1px solid ${C.good}55`,
                  borderRadius:6,padding:"8px 0",cursor:"pointer" }}>
                <span style={{ fontSize:11 }}>▶</span>
                <span style={{ color:C.good,fontSize:9,fontFamily:C.fnt,fontWeight:700 }}>TRAJET</span>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* ── Légende compacte quand rien n'est sélectionné ── */
        <div style={{ display:"flex",gap:10,padding:"5px 14px 10px",flexShrink:0,alignItems:"center" }}>
          {[[C.good,"Dispo"],[C.warn,"Faible"],[C.bad,"Vide"],["#444","Fermé"],[C.blue,"Vous"]].map(([c,l])=>(
            <div key={l} style={{ display:"flex",alignItems:"center",gap:3 }}>
              <div style={{ width:6,height:6,borderRadius:"50%",background:c,boxShadow:`0 0 4px ${c}` }}/>
              <span style={{ color:C.muted,fontSize:7,fontFamily:C.fnt }}>{l}</span>
            </div>
          ))}
          <span style={{ color:C.muted,fontSize:7,fontFamily:C.fnt,marginLeft:"auto" }}>
            Zoom ×3 → labels
          </span>
        </div>
      )}
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

  // Mise à jour du message d'accueil quand les données passent de mock → live
  useEffect(()=>{
    if (aiHistory.length === 0) {
      setAiDisplay([{ role:"ai", text:initMsg }]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[stations]);

  // FIX : systemPrompt dans useMemo — évite de recréer sendText à chaque render
  // et élimine le risque de closure stale sur une const recalculée inline.
  const systemPrompt = useMemo(()=>{
    // Historique des 5 dernières stations visitées (#13)
    const hist = getHistory().slice(0,5);
    const histTxt = hist.length
      ? `\nStations récemment visitées par l'utilisateur : ${hist.map(h=>h.name).join(", ")}.`
      : "";
    return `Tu es VELOH·AI, l'assistant de VelohNav pour le réseau Vel'OH! Luxembourg.
Réponds en français, de façon concise (3-4 lignes max).
Données actuelles (triées par distance) :
${stations.map(s=>`• ${s.name} | ${s.bikes} vélos (⚡${s.elec} élec., 🔧${s.meca} méca.) | ${s.docks} docks | ${fDist(s.dist)} | ${bTag(s)}`).join("\n")}${histTxt}
Réponds uniquement sur la mobilité Veloh, les itinéraires, ou l'app.`;
  },[stations]);

  const sendText = useCallback(async(text)=>{
    const q=(text||input).trim();
    if(!q||busy) return;
    if (!claudeKey) {
      setAiDisplay(d=>[...d,{role:"user",text:q},{role:"ai",text:"⚠ Clé API Claude manquante — entre-la dans OPT pour activer l'assistant."}]);
      setInput(""); return;
    }
    setInput(""); setBusy(true);
    setAiDisplay(d=>[...d,{role:"user",text:q}]);
    // FIX : historique borné à 20 messages max → évite de dépasser le context window Claude
    const hist = [...aiHistory,{role:"user",content:q}].slice(-20);
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
        // FIX : cas spécial 401 → message clair pour l'utilisateur
        const errMsg = r.status === 401
          ? "Clé Claude invalide — vérifie-la dans OPT."
          : data?.error?.message ?? `Erreur API (${r.status})`;
        setAiDisplay(d=>[...d,{role:"ai",text:`⚠ ${errMsg}`}]);
      } else {
        const reply = data.content?.[0]?.text ?? "Erreur de réponse.";
        setAiHistory([...hist,{role:"assistant",content:reply}]);
        setAiDisplay(d=>[...d,{role:"ai",text:reply}]);
      }
    } catch(e) {
      setAiDisplay(d=>[...d,{role:"ai",text:`Erreur réseau : ${e.message ?? "connexion impossible"}.`}]);
    }
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
  // FIX : validation format Lightning Address (user@domain) avant sauvegarde
  const [lnError, setLnError] = useState("");
  const saveLn=()=>{
    const addr = lnAddr.trim();
    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr);
    if (addr && !valid) { setLnError("Format invalide — ex: toi@getalby.com"); return; }
    setLnError(""); setLnSaved(true); setTimeout(()=>setLnSaved(false),1500);
  };

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
            available_bikes · electrical_bikes{"\n"}
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
              <input value={lnAddr} onChange={e=>{setLnAddr(e.target.value);setLnError("");}} placeholder="toi@getalby.com"
                style={{ flex:1,background:"rgba(0,0,0,0.4)",
                  border:`1px solid ${lnError?C.bad:C.border}`,
                  borderRadius:4,padding:"8px 10px",color:"#FCD34D",fontSize:11,fontFamily:C.fnt,outline:"none" }}/>
              <div onPointerDown={saveLn} style={{
                background:lnSaved?"rgba(46,204,143,0.15)":C.accentBg,border:`1px solid ${lnSaved?C.good:C.accent}`,
                color:lnSaved?C.good:C.accent,borderRadius:4,padding:"8px 12px",
                fontSize:9,fontFamily:C.fnt,cursor:"pointer",fontWeight:700,whiteSpace:"nowrap" }}>
                {lnSaved?"✓ OK":"SAVE"}
              </div>
            </div>
            {lnError&&<div style={{ color:C.bad,fontSize:8,fontFamily:C.fnt,marginTop:4 }}>⚠ {lnError}</div>}
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
  // FIX #9 : ads=false par défaut (toggle était à true par défaut sans logique derrière)
  const [ads,setAds]           = useState(()=>localStorage.getItem("velohnav_ads")==="true");
  const [stations,setStations] = useState(()=>enrich(FALLBACK,null));
  const [apiLive,setApiLive]   = useState(false);
  const [isMock,setIsMock]     = useState(true);
  const [gpsPos,setGpsPos]     = useState(null);
  const [refreshing,setRefreshing] = useState(false);

  // FIX #3 : Système de trajet — départ/arrivée pour Sats Rewards
  const [trip,setTrip] = useState(null); // null | { stationId, name, startAt }
  const [satsResult,setSatsResult] = useState(null); // null | { ok, msg }

  // Lifted AI conversation state
  const top0 = FALLBACK.find(s=>s.bikes>0);
  const [aiHistory, setAiHistory] = useState([]);
  const [aiDisplay, setAiDisplay] = useState([{ role:"ai",
    text: top0 ? `${FALLBACK.filter(s=>s.bikes>0).length}/${FALLBACK.length} stations dispos. Plus proche : ${top0.name} (${fDist(haversine(REF.lat,REF.lng,top0.lat,top0.lng))}, ${top0.bikes}🚲 ⚡${top0.elec}).` : "Chargement…"
  }]);

  // Persist settings
  useEffect(()=>{ localStorage.setItem("velohnav_jcdKey",   apiKey);    },[apiKey]);
  useEffect(()=>{ localStorage.setItem("velohnav_claudeKey",claudeKey); },[claudeKey]);
  useEffect(()=>{ localStorage.setItem("velohnav_lnAddr",   lnAddr);    },[lnAddr]);
  useEffect(()=>{ localStorage.setItem("velohnav_lnOn",     lnOn);      },[lnOn]);
  useEffect(()=>{ localStorage.setItem("velohnav_ads",      ads);       },[ads]);

  // GPS
  useEffect(()=>{
    let stop=()=>{};
    startWatchingGPS(pos=>setGpsPos(pos)).then(fn=>{ if(fn) stop=fn; });
    return ()=>stop();
  },[]);
  useEffect(()=>{ setStations(prev=>enrich(prev,gpsPos)); },[gpsPos]);
  const gpsRef = useRef(null);
  useEffect(()=>{ gpsRef.current = gpsPos; },[gpsPos]);

  // Ref pour comparer stations prev/next → notifications (#14)
  const prevStationsRef = useRef({});

  const loadData = useCallback(async()=>{
    const userPos = gpsRef.current;
    let newStations = null;
    if (apiKey) {
      try {
        const raw = await fetchJCDecaux(apiKey);
        if (raw && Array.isArray(raw)) {
          newStations = enrich(raw.map(parseStation), userPos);
          setApiLive(true); setIsMock(false);
        }
      } catch(e) { console.warn("JCDecaux load:", e); }
    }
    if (!newStations) {
      newStations = enrich(FALLBACK, userPos);
      setApiLive(false); setIsMock(true);
    }
    // FIX #14 : Comparer avec les stations précédentes → notifier si vide/faible
    newStations.forEach(s=>{
      const prev = prevStationsRef.current[s.id];
      if (prev !== undefined) notifyStation(s, prev);
      prevStationsRef.current[s.id] = s.bikes;
    });
    setStations(newStations);
  },[apiKey]);

  useEffect(()=>{ loadData(); },[loadData]);
  // Refresh auto toutes les 60s
  useEffect(()=>{ const t=setInterval(loadData,60000); return()=>clearInterval(t); },[loadData]);
  // FIX #8 : Refresh quand l'app revient au premier plan
  useEffect(()=>{
    const onFocus = ()=>loadData();
    const onVisible = ()=>{ if(document.visibilityState==="visible") loadData(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return ()=>{
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  },[loadData]);

  // FIX #8 : Refresh manuel avec feedback visuel
  const handleRefresh = useCallback(async()=>{
    setRefreshing(true);
    await loadData();
    setTimeout(()=>setRefreshing(false), 600);
  },[loadData]);

  // FIX #13 : Ajouter à l'historique quand on sélectionne une station
  useEffect(()=>{
    if (sel) {
      const s = stations.find(st=>st.id===sel);
      if (s) addToHistory(s);
    }
  },[sel, stations]);

  // FIX #3 : Démarrer un trajet
  const startTrip = useCallback((station)=>{
    setTrip({ stationId:station.id, name:station.name, startAt:Date.now() });
    setSatsResult(null);
  },[]);

  // FIX #2 : Terminer un trajet → envoyer sats via LNURL-pay
  const endTrip = useCallback(async()=>{
    if (!trip) return;
    const durMin = Math.round((Date.now()-trip.startAt)/60000);
    const sats = Math.max(10, durMin * 2); // 2 sats/min, min 10 sats
    setTrip(null);
    if (lnOn && lnAddr) {
      setSatsResult({ok:null, msg:"Envoi en cours…"});
      const res = await payLnAddress(lnAddr, sats, `VelohNav trajet ${durMin}min depuis ${trip.name}`);
      setSatsResult(res.ok
        ? {ok:true,  msg:`⚡ ${sats} sats envoyés !`}
        : {ok:false, msg:`⚠ ${res.error}`});
      setTimeout(()=>setSatsResult(null), 4000);
    }
  },[trip, lnOn, lnAddr]);

  // FIX #14 : Demander permission notifications au premier lancement
  useEffect(()=>{ requestNotifPerm(); },[]);

  return (
    <div style={{ width:"100%",height:"100vh",display:"flex",flexDirection:"column",
      background:C.bg,overflow:"hidden",maxWidth:430,margin:"0 auto" }}>
      <StatusBar tab={tab} gpsOk={!!gpsPos} apiLive={apiLive} isMock={isMock}
        onRefresh={handleRefresh} refreshing={refreshing}/>

      {/* Banner trajet en cours (#3) */}
      {trip&&(
        <div style={{ background:"rgba(245,130,13,0.12)",borderBottom:`1px solid ${C.accent}44`,
          padding:"7px 14px",display:"flex",alignItems:"center",gap:10,flexShrink:0 }}>
          <span style={{ fontSize:14 }}>🚲</span>
          <div style={{ flex:1 }}>
            <div style={{ color:C.accent,fontSize:9,fontFamily:C.fnt,fontWeight:700 }}>TRAJET EN COURS</div>
            <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt }}>
              Depuis {trip.name} · {Math.round((Date.now()-trip.startAt)/60000)} min
            </div>
          </div>
          <div onPointerDown={endTrip}
            style={{ background:C.accentBg,border:`1px solid ${C.accent}`,borderRadius:5,
              padding:"5px 12px",color:C.accent,fontSize:8,fontFamily:C.fnt,
              fontWeight:700,cursor:"pointer" }}>
            ARRIVER ✓
          </div>
        </div>
      )}

      {/* Toast résultat sats (#2) */}
      {satsResult&&(
        <div style={{ background:satsResult.ok===true?"rgba(46,204,143,0.15)":satsResult.ok===false?"rgba(224,62,62,0.12)":"rgba(245,130,13,0.1)",
          borderBottom:`1px solid ${satsResult.ok===true?C.good:satsResult.ok===false?C.bad:C.accent}44`,
          padding:"7px 14px",textAlign:"center",flexShrink:0 }}>
          <span style={{ color:satsResult.ok===true?C.good:satsResult.ok===false?C.bad:C.warn,
            fontSize:10,fontFamily:C.fnt }}>{satsResult.msg}</span>
        </div>
      )}

      <div style={{ flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minHeight:0 }}>
        {tab==="ar"       &&<ARScreen  stations={stations} sel={sel} setSel={setSel} gpsPos={gpsPos}
          trip={trip} onStartTrip={startTrip}/>}
        {tab==="map"      &&<MapScreen stations={stations} sel={sel} setSel={setSel} gpsPos={gpsPos}
          trip={trip} onStartTrip={startTrip}/>}
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
