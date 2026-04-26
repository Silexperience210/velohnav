import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { t } from "../i18n.js";
import { C, COMPASS_LABELS, FOV, FISCHER_STORES } from "../constants.js";
import { haversine, getBearing, fDist, fWalk, bCol, bTag, pins } from "../utils.js";

import { useCompass } from "../hooks/useCompass.js";
import { useRoute } from "../hooks/useRoute.js";
import { usePredictiveRouting } from "../hooks/usePredictiveRouting.js";
import { useGhostTrail } from "../hooks/useGhostTrail.js";
import { launchNativeArNav } from "../utils.js";


// Composants AR extraits (split ARScreen)
import RouteOverlay from "./ar/RouteOverlay.jsx";
import NavOverlay from "./ar/NavOverlay.jsx";
import CityBG from "./ar/CityBG.jsx";
import ARPin from "./ar/ARPin.jsx";
import GhostPin from "./ar/GhostPin.jsx";
import { projectPoint } from "./ar/projection.js";


// ── BRIDGE CAPACITOR → ArNavigationActivity (Android natif) ──────
// Déclenche ARCore Geospatial si on est dans l'app native, sinon no-op.


// JCDecaux — fetch direct, fallback proxy CORS si bloqué (prototype web)





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


// ── COMPASS HOOK ──────────────────────────────────────────────────



// ── AR SCREEN ─────────────────────────────────────────────────────


function ARScreen({ stations, sel, setSel, gpsPos, trip, onStartTrip, mapsKey="", fischerVisible=false, weather=null }) {
  const vidRef=useRef(null);
  const [cam,   setCam]  =useState("idle");
  const [pulse, setPulse]=useState(false);
  const {heading,perm,start:startCompass}=useCompass();
  const [fischerOn, setFischerOn] = useState(false);

  // ── Navigation AR ───────────────────────────────────────────────
  const [navMode, setNavMode] = useState(null);   // null | "cycling" | "walking"
  const navStation = stations.find(s=>s.id===sel);
  // mapsKey reçu en prop depuis Root (réactif si l'utilisateur le change dans Settings)
  const { route, loading: routeLoading, error: routeError } =
    useRoute(gpsPos, navMode ? navStation : null, navMode||"cycling", mapsKey);

  const startNav = useCallback(async(mode)=>{
    if (!navStation) return;
    const navModeVal = mode === "walking" ? "walking" : "cycling";
    try {
      await launchNativeArNav(
        navStation.lat, navStation.lng, navStation.name,
        mode === "walking" ? "walking" : "bicycling",
        mapsKey
      );
      // Native AR lancé — on active aussi le tracé WebView en arrière-plan
      setNavMode(navModeVal);
    } catch {
      // Native indispo — fallback tracé WebView uniquement
      setNavMode(navModeVal);
    }
  },[navStation, mapsKey]);

  const stopNav = useCallback(()=>setNavMode(null),[]);

  // ── Origin station snapshot — figée au lancement de la nav ─────────
  // Sert de clé "départ" pour le Ghost Trail. On prend la station la plus
  // proche de la position GPS au moment du startNav (rayon 100m).
  const [originStation, setOriginStation] = useState(null);
  useEffect(() => {
    if (!navMode || !gpsPos) { setOriginStation(null); return; }
    if (originStation) return;  // déjà figée
    let best = null, bestD = 100;
    for (const s of stations) {
      if (!s.lat || !s.lng) continue;
      const d = haversine(gpsPos.lat, gpsPos.lng, s.lat, s.lng);
      if (d < bestD) { bestD = d; best = s; }
    }
    if (best) setOriginStation(best);
  }, [navMode, gpsPos?.lat, gpsPos?.lng, stations, originStation]);

  // ── Ghost Trail — fantôme du meilleur temps ──────────────────────
  const { ghostPos, hasGhost, bestTime, currentDelta } = useGhostTrail({
    gpsPos, navStation, originStation, navMode,
    active: navMode !== null,
  });

  // ── Predictive Routing — surveille la station de destination en live ────
  // Si elle devient saturée pendant qu'on roule, propose une alternative.
  // Heuristique d'intent : si le user a déjà un vélo (trip actif), c'est un
  // dropoff (besoin de docks). Sinon c'est un pickup (besoin de vélos).
  const navIntent = trip?.active ? "dropoff" : "pickup";
  const { suggestion: predSuggestion, dismiss: predDismiss, accept: predAccept } =
    usePredictiveRouting({
      stations, navStation, gpsPos, navMode,
      intent: navIntent,
      active: navMode !== null,
    });

  // Switch sur la station alternative — relance la nav vers la nouvelle dest
  const acceptPredictiveSwitch = useCallback(() => {
    predAccept((newStation) => {
      setSel(newStation.id);
      // Relance la nav avec la nouvelle station — le useEffect du
      // pendingNavMode dans ARScreen + useRoute s'occupent du reste.
      // Petit délai pour que sel soit propagé et navStation à jour
      setTimeout(() => {
        // navMode est conservé (cycling/walking) — useRoute recalculera
        // automatiquement avec la nouvelle navStation.
      }, 100);
    });
  }, [predAccept, setSel]);

  // Auto-démarrer la nav si l'utilisateur vient de taper AR VÉLO/PIED depuis MAP
  useEffect(()=>{
    const pendingMode = localStorage.getItem("velohnav_pendingNavMode");
    const pendingId   = localStorage.getItem("velohnav_pendingNavId");
    if (pendingMode && pendingId) {
      localStorage.removeItem("velohnav_pendingNavMode");
      localStorage.removeItem("velohnav_pendingNavId");
      // Déclencher la navigation (startNav vérifie navStation via sel)
      // On attend que la caméra soit prête, sinon on démarre la nav silencieusement
      const station = stations.find(s=>String(s.id)===pendingId);
      if (station) {
        setSel(station.id);
        // Petit délai pour que navStation soit bien à jour
        const t = setTimeout(()=>startNav(pendingMode === "walking" ? "walking" : "cycling"), 300);
        return ()=>clearTimeout(t);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const AR_RADIUS = 800; // m — uniquement les stations proches en AR
    const AR_MAX    = 5;   // max 5 pins à l'écran
    return stations
      .filter(s=>s.lat&&s.lng&&s.dist<=AR_RADIUS)
      .map(s=>{
        const bear=getBearing(gpsPos.lat,gpsPos.lng,s.lat,s.lng);
        const rel=((bear-heading+540)%360)-180;
        if(Math.abs(rel)>FOV/2+8) return null;
        const x=50+(rel/(FOV/2))*50;
        const dc=Math.min(s.dist,AR_RADIUS);
        const y=70-(1-dc/AR_RADIUS)*44;
        const scale=Math.max(0.5,1-dc/(AR_RADIUS*1.5));
        return{...s,x,y,scale,labelRight:rel<0,rel};
      })
      .filter(Boolean)
      .sort((a,b)=>a.dist-b.dist)  // plus proche = devant
      .slice(0,AR_MAX);
  },[heading,gpsPos,stations]);

  const fakePins=useMemo(()=>pins(stations,heading,gpsPos),[stations,heading,gpsPos]);

  // ── Clustering — groupe les stations proches dans le FOV ──────────
  // Évite la surcharge visuelle quand beaucoup de pins se superposent.
  // En dessous de 500m : pins individuels. Au-delà : clusters si ≥2 stations dans un rayon de 6% écran.
  const clusteredPins = useMemo(()=>{
    const raw = arPins ?? fakePins;
    if (!raw.length) return [];

    const CLUSTER_R = 6; // % écran — rayon de regroupement
    const used = new Set();
    const result = [];

    raw.forEach((pin, i) => {
      if (used.has(i)) return;
      // Stations à moins de 200m → toujours individuelles (rayon AR limité à 800m)
      if (pin.dist < 200) { result.push({ ...pin, cluster: null }); return; }
      // Chercher les voisins dans le FOV
      const neighbors = raw.filter((p2, j) => {
        if (j === i || used.has(j)) return false;
        const dx = Math.abs(p2.x - pin.x), dy = Math.abs(p2.y - pin.y);
        return Math.hypot(dx, dy) < CLUSTER_R;
      });
      if (neighbors.length === 0) {
        result.push({ ...pin, cluster: null });
      } else {
        // Créer un cluster centré sur le pin le plus proche
        const all = [pin, ...neighbors];
        neighbors.forEach((_, j) => used.add(raw.indexOf(neighbors[j])));
        used.add(i);
        const cx = all.reduce((s,p)=>s+p.x,0)/all.length;
        const cy = all.reduce((s,p)=>s+p.y,0)/all.length;
        const totalBikes = all.reduce((s,p)=>s+p.bikes,0);
        const minDist = Math.min(...all.map(p=>p.dist));
        result.push({
          ...pin, x:cx, y:cy, scale:pin.scale,
          cluster: { count: all.length, bikes: totalBikes, dist: minDist },
        });
      }
    });
    return result;
  },[arPins, fakePins]);

  const visiblePins = clusteredPins;

  // ── Fischer stores AR pins ──────────────────────────────────────
  // Visible uniquement si fischerVisible=true — rayon 600m, max 4
  const fischerPins = useMemo(()=>{
    if (!fischerOn || heading === null || !gpsPos) return [];
    const RADIUS = 600;
    return FISCHER_STORES
      .map(s => {
        const dist = haversine(gpsPos.lat, gpsPos.lng, s.lat, s.lng);
        if (dist > RADIUS) return null;
        const bear = getBearing(gpsPos.lat, gpsPos.lng, s.lat, s.lng);
        const rel  = ((bear - heading + 540) % 360) - 180;
        if (Math.abs(rel) > FOV / 2 + 8) return null;
        const x     = 50 + (rel / (FOV / 2)) * 50;
        const y     = 70 - (1 - Math.min(dist, RADIUS) / RADIUS) * 44;
        const scale = Math.max(0.55, 1 - dist / (RADIUS * 1.8));
        return { ...s, dist, x, y, scale };
      })
      .filter(Boolean)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 4);
  },[fischerOn, heading, gpsPos]);

  // ── Nav overlay ────────────────────────────────────────────────
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
    if(perm==="requesting") return{label:t("ar.init"),col:C.warn};
    if(perm==="denied")     return{label:t("ar.compass_denied"),col:C.bad};
    if(perm==="unavailable")return{label:t("ar.compass_unavail"),col:C.bad};
    if(perm==="nosignal")   return{label:t("ar.compass_nosignal"),col:C.bad};
    if(heading===null)      return{label:t("ar.compass_waiting"),col:C.warn};
    return{label:`${t("ar.active")} · ${hdg}° ${cardLabel}`,col:C.good};
  };
  const cs=compassStatus();
  // Afficher l'aide calibration si nosignal et caméra active
  const showCalib = perm==="nosignal" || (perm==="granted" && heading===null && cam==="active");

  return (
    <div style={{position:"relative",flex:1,overflow:"hidden",minHeight:0,background:"#000"}}>

      <video ref={vidRef} muted playsInline autoPlay style={{
        position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover",zIndex:1,
        opacity:cam==="active"?1:0,transition:"opacity 0.5s"}}/>
      {cam!=="active"&&<div style={{position:"absolute",inset:0,zIndex:2}}><CityBG/></div>}

      <div style={{position:"absolute",inset:0,zIndex:5,pointerEvents:"none"}}>
        <div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse at center,transparent 30%,rgba(0,0,0,0.35) 100%)"}}/>
        <div style={{position:"absolute",top:0,left:0,right:0,height:70,background:"linear-gradient(to bottom,rgba(8,12,15,0.65),transparent)"}}/>
        <div style={{position:"absolute",bottom:0,left:0,right:0,height:230,background:"linear-gradient(to top,rgba(8,12,15,0.98),rgba(8,12,15,0.4) 60%,transparent)"}}/>
      </div>

      {navRel!==null&&!navMode&&<NavOverlay relBear={navRel} dist={navStation?.dist??0} name={navStation?.name??""}/>}

      {/* Route AR overlay — tracé OSRM/Google projeté sur caméra */}
      {navMode&&(
        <RouteOverlay
          key={`${navStation?.id}-${navMode}`}
          route={route} gpsPos={gpsPos} heading={heading}
          mode={navMode} onClose={stopNav} weather={weather}
        />
      )}
      {/* Chargement itinéraire */}
      {navMode&&routeLoading&&(
        <div style={{position:"absolute",top:"50%",left:"50%",
          transform:"translate(-50%,-50%)",zIndex:30,
          background:"rgba(8,12,15,0.9)",border:`1px solid ${C.border}`,
          borderRadius:8,padding:"14px 22px",textAlign:"center"}}>
          <div style={{color:C.accent,fontSize:10,fontFamily:C.fnt,letterSpacing:2}}>{t("ar.nav_loading")}</div>
        </div>
      )}
      {navMode&&routeError&&(
        <div style={{position:"absolute",top:"50%",left:"50%",
          transform:"translate(-50%,-50%)",zIndex:30,
          background:"rgba(8,12,15,0.9)",border:`1px solid ${C.bad}`,
          borderRadius:8,padding:"14px 22px",textAlign:"center"}}>
          <div style={{color:C.bad,fontSize:9,fontFamily:C.fnt}}>{routeError}</div>
          <div onPointerDown={stopNav}
            style={{color:C.muted,fontSize:8,fontFamily:C.fnt,marginTop:8,cursor:"pointer"}}>✕ Fermer</div>
        </div>
      )}

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
                {t("ar.activate")}
              </button>
              <div style={{color:C.muted,fontSize:8,fontFamily:C.fnt,textAlign:"center",lineHeight:1.6}}>
                {t("ar.camera_mic")}
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
              <div style={{color:C.bad,fontSize:10,fontFamily:C.fnt,marginBottom:8}}>{t("ar.denied")}</div>
              <div style={{color:C.muted,fontSize:9,fontFamily:C.fnt,lineHeight:1.7}}>
                Paramètres → Apps → VelohNav → Autorisations → Caméra
              </div>
              <button onPointerDown={startAR} style={{
                background:"rgba(224,62,62,0.1)",border:`1px solid ${C.bad}`,color:C.bad,
                borderRadius:4,padding:"8px 20px",fontSize:9,fontFamily:C.fnt,
                cursor:"pointer",marginTop:12}}>{t("ar.retry")}</button>
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

      {/* Overlay calibration boussole — affiché si pas de signal après 4s */}
      {showCalib&&cam==="active"&&(
        <div style={{
          position:"absolute",top:"28%",left:"50%",
          transform:"translate(-50%,-50%)",
          zIndex:32,
          background:"rgba(8,12,15,0.93)",
          border:`1px solid ${C.accent}66`,
          borderRadius:12,padding:"18px 22px",
          textAlign:"center",maxWidth:260,
          boxShadow:`0 0 30px rgba(0,0,0,0.7)`,
        }}>
          {/* Animation figure en 8 SVG */}
          <svg width="60" height="44" viewBox="0 0 60 44" style={{marginBottom:8}}>
            <path d="M30,22 C30,22 10,4 10,14 C10,24 30,22 30,22 C30,22 50,20 50,30 C50,40 30,22 30,22 Z"
              fill="none" stroke={C.accent} strokeWidth="2" strokeLinecap="round" opacity="0.8">
              <animate attributeName="stroke-dashoffset" from="200" to="0" dur="2s" repeatCount="indefinite"/>
              <animate attributeName="stroke-dasharray" from="0 200" to="200 0" dur="2s" repeatCount="indefinite"/>
            </path>
            <text x="30" y="44" textAnchor="middle" fill={C.accent} fontSize="9"
              fontFamily="'Courier New',monospace">∞</text>
          </svg>
          <div style={{color:C.accent,fontSize:10,fontFamily:C.fnt,fontWeight:700,
            letterSpacing:1.5,marginBottom:6}}>
            {t("ar.calib_title")}
          </div>
          <div style={{color:C.muted,fontSize:8,fontFamily:C.fnt,lineHeight:1.7}}>
            {t("ar.calib_desc")}
          </div>
          {perm==="nosignal"&&(
            <div style={{color:"#666",fontSize:7,fontFamily:C.fnt,marginTop:8}}>
              {t("ar.calib_hint")}
            </div>
          )}
        </div>
      )}

      {/* Pins Vel'OH — masqués pendant la nav active pour focus sur destination */}
      {!navMode && (
        <div style={{position:"absolute",inset:0,zIndex:15}}>
          {visiblePins.map(s=><ARPin key={s.id} s={s} sel={sel} setSel={setSel} pulse={pulse}/>)}
        </div>
      )}

      {/* Pin destination dédié — affiché seulement en mode nav, projeté sur la station cible */}
      {navMode && navStation && navRel !== null && Math.abs(navRel) <= FOV/2 + 10 && (
        (() => {
          const x = 50 + (navRel / (FOV/2)) * 50;
          // Distance projection : proche → bas, loin → horizon
          const dc = Math.min(navStation.dist, 800);
          const y = Math.max(20, 60 - (1 - dc/800) * 35);
          const arriving = navStation.dist < 30;
          return (
            <div style={{
              position:"absolute",
              left:`${Math.max(8, Math.min(92, x))}%`,
              top:`${y}%`,
              transform:"translate(-50%, -100%)",
              zIndex:18,
              pointerEvents:"none",
              display:"flex", flexDirection:"column", alignItems:"center",
              filter: arriving ? "drop-shadow(0 0 12px #2ECC8F)" : `drop-shadow(0 0 8px ${C.accent})`,
              animation: pulse ? "navPinPulse 1.1s ease-in-out" : "none",
            }}>
              {/* Bandeau destination */}
              <div style={{
                background: arriving
                  ? "linear-gradient(135deg, rgba(46,204,143,0.95), rgba(8,30,18,0.95))"
                  : "linear-gradient(135deg, rgba(8,12,15,0.96), rgba(20,12,0,0.94))",
                border: `2px solid ${arriving ? C.good : C.accent}`,
                borderRadius: 8,
                padding: "8px 14px",
                minWidth: 140,
                textAlign: "center",
                boxShadow: `0 0 20px ${arriving ? C.good : C.accent}66`,
              }}>
                <div style={{
                  color: arriving ? C.good : C.accent,
                  fontSize: 7,
                  fontFamily: C.fnt,
                  letterSpacing: 2,
                  marginBottom: 2,
                  fontWeight: 700,
                }}>
                  {arriving ? "🎯 ARRIVÉE" : "🏁 DESTINATION"}
                </div>
                <div style={{
                  color: "#fff", fontSize: 11, fontFamily: C.fnt, fontWeight: 700,
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  maxWidth: 180,
                }}>
                  {navStation.name}
                </div>
                <div style={{
                  color: arriving ? C.good : C.muted,
                  fontSize: 9, fontFamily: C.fnt, marginTop: 3,
                }}>
                  {fDist(navStation.dist)} · {navStation.bikes} 🚲
                </div>
              </div>
              {/* Tige descendante vers le sol */}
              <div style={{
                width: 2, height: 22,
                background: `linear-gradient(${arriving ? C.good : C.accent}, transparent)`,
              }}/>
              {/* Point d'ancrage au sol */}
              <div style={{
                width: 10, height: 10, borderRadius: "50%",
                background: arriving ? C.good : C.accent,
                boxShadow: `0 0 14px ${arriving ? C.good : C.accent}`,
                animation: "navPinDot 1.4s ease-in-out infinite",
              }}/>
              <style>{`
                @keyframes navPinDot {
                  0%,100% { transform: scale(1); opacity: 1; }
                  50%     { transform: scale(1.4); opacity: 0.65; }
                }
              `}</style>
            </div>
          );
        })()
      )}

      {/* Ghost Trail — fantôme du meilleur temps */}
      {navMode && (
        <GhostPin
          ghostPos={ghostPos}
          gpsPos={gpsPos}
          heading={heading}
          currentDelta={currentDelta}
          hasGhost={hasGhost}
          bestTime={bestTime}
        />
      )}

      {/* Pins Fischer 🥐 */}
      {fischerPins.map(s=>(
        <div key={s.name} style={{
          position:"absolute",
          left:`${s.x}%`, top:`${s.y}%`,
          transform:`translate(-50%,-100%) scale(${s.scale})`,
          zIndex:16, pointerEvents:"none",
          display:"flex", flexDirection:"column", alignItems:"center",
        }}>
          {/* Badge cyberpunk Fischer */}
          <div style={{
            background:"linear-gradient(135deg,rgba(8,5,0,0.95),rgba(20,10,0,0.92))",
            border:"1px solid #D4780066",
            borderTop:"2px solid #D47800",
            borderRadius:"6px 6px 2px 6px",
            padding:"4px 7px 3px",
            display:"flex", alignItems:"center", gap:5,
            boxShadow:"0 0 10px #D4780033",
          }}>
            <span style={{fontSize:14}}>🥐</span>
            <div>
              <div style={{
                color:"#D47800", fontSize:7,
                fontFamily:"monospace", fontWeight:700, letterSpacing:1,
                whiteSpace:"nowrap",
              }}>
                {s.name.replace("Fischer ","")}
              </div>
              <div style={{
                color:"#D47800aa", fontSize:6,
                fontFamily:"monospace",
              }}>
                {Math.round(s.dist)}m
              </div>
            </div>
          </div>
          {/* Tige */}
          <div style={{width:1,height:14,background:"linear-gradient(#D47800,transparent)"}}/>
          {/* Point ancrage */}
          <div style={{width:4,height:4,borderRadius:"50%",background:"#D47800",
            boxShadow:"0 0 5px #D47800"}}/>
        </div>
      ))}

      {/* Bannière suggestion prédictive — re-route auto si station saturée */}
      {predSuggestion && navMode && (
        <div style={{
          position:"absolute", bottom:84, left:14, right:14,
          zIndex:25,
          background:"linear-gradient(135deg, rgba(20,12,0,0.97), rgba(8,12,15,0.97))",
          border:`2px solid ${C.warn}`,
          borderRadius:10, padding:"11px 13px",
          boxShadow:`0 0 24px ${C.warn}55, 0 4px 16px rgba(0,0,0,0.6)`,
          animation:"predSlideUp 0.35s ease-out",
        }}>
          <style>{`
            @keyframes predSlideUp {
              from { transform: translateY(20px); opacity: 0; }
              to   { transform: translateY(0); opacity: 1; }
            }
          `}</style>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:7}}>
            <span style={{fontSize:16}}>⚠️</span>
            <div style={{flex:1,minWidth:0}}>
              <div style={{color:C.warn,fontSize:8,fontFamily:C.fnt,letterSpacing:1.5,fontWeight:700}}>
                STATION SATURÉE · ALTERNATIVE TROUVÉE
              </div>
              <div style={{color:C.muted,fontSize:8,fontFamily:C.fnt,marginTop:1}}>
                {predSuggestion.reason}
              </div>
            </div>
          </div>
          <div style={{
            background:"rgba(0,0,0,0.35)", border:`1px solid ${C.border}`,
            borderRadius:6, padding:"7px 10px", marginBottom:7,
          }}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{minWidth:0,flex:1}}>
                <div style={{color:C.text,fontSize:11,fontFamily:C.fnt,fontWeight:700,
                  whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                  {predSuggestion.station.name}
                </div>
                <div style={{color:C.muted,fontSize:8,fontFamily:C.fnt,marginTop:2,letterSpacing:1}}>
                  {predSuggestion.detourMeters > 0 ? "+" : ""}{predSuggestion.detourMeters}m détour ·
                  {" "}{predSuggestion.stockAvailable} {navIntent === "dropoff" ? "docks libres" : "vélos"}
                </div>
              </div>
              <div style={{
                background:`${C.good}22`, border:`1px solid ${C.good}66`,
                borderRadius:4, padding:"3px 7px",
                color:C.good, fontSize:11, fontFamily:C.fnt, fontWeight:700,
              }}>
                ✓ {predSuggestion.stockAvailable}
              </div>
            </div>
          </div>
          <div style={{display:"flex",gap:6}}>
            <div onPointerDown={acceptPredictiveSwitch}
              style={{
                flex:2, textAlign:"center", padding:"8px 0",
                background:`${C.accent}22`, border:`1px solid ${C.accent}`,
                borderRadius:5, cursor:"pointer",
              }}>
              <span style={{color:C.accent,fontSize:9,fontFamily:C.fnt,fontWeight:700,letterSpacing:1.5}}>
                BASCULER
              </span>
            </div>
            <div onPointerDown={predDismiss}
              style={{
                flex:1, textAlign:"center", padding:"8px 0",
                background:"rgba(255,255,255,0.04)", border:`1px solid ${C.border}`,
                borderRadius:5, cursor:"pointer",
              }}>
              <span style={{color:C.muted,fontSize:9,fontFamily:C.fnt,letterSpacing:1.5}}>
                IGNORER
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Bottom panel */}
      <div style={{position:"absolute",bottom:0,left:0,right:0,padding:"0 14px 14px",zIndex:22}}>
        {/* Mode NAV ACTIVE — bandeau ultra-compact pour libérer la vue AR.
            Le détail de la station n'est plus affiché : la nav prend toute la place.
            Seul un bouton "ARRÊTER" reste accessible. */}
        {navMode && navStation ? (
          <div style={{
            background:"rgba(8,12,15,0.85)",
            border:`1px solid ${C.border}`,
            borderTop:`2px solid ${bCol(navStation)}`,
            borderRadius:8,
            padding:"7px 12px",
            display:"flex", alignItems:"center", justifyContent:"space-between",
            gap:10,
            backdropFilter:"blur(4px)",
          }}>
            <div style={{display:"flex",flexDirection:"column",minWidth:0,flex:1}}>
              <div style={{
                color:C.muted, fontSize:7, fontFamily:C.fnt, letterSpacing:1.5,
                marginBottom:1,
              }}>
                {navMode === "walking" ? "🚶 PIED" : "🚲 VÉLO"} · DEST.
              </div>
              <div style={{
                color:C.text, fontSize:11, fontFamily:C.fnt, fontWeight:700,
                whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis",
              }}>{navStation.name}</div>
            </div>
            <div onPointerDown={stopNav}
              style={{
                padding:"6px 12px",
                background:`${C.bad}15`, border:`1px solid ${C.bad}66`,
                borderRadius:5, cursor:"pointer", whiteSpace:"nowrap",
              }}>
              <span style={{color:C.bad,fontSize:8,fontFamily:C.fnt,fontWeight:700,letterSpacing:1}}>
                {t("ar.nav_stop")}
              </span>
            </div>
          </div>
        ) : navStation ? (
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
                {l:t("station.bikes"),v:navStation.bikes,col:bCol(navStation)},
                {l:"⚡ ÉLEC.",v:navStation.elec, col:"#60A5FA"},
                {l:"🔧 MÉCA.",v:navStation.meca, col:C.text},
                {l:t("station.docks"),v:navStation.docks,col:C.good},
                {l:t("station.capacity"),  v:navStation.cap,  col:C.muted},
              ].map((m,i)=>(
                <div key={m.l} style={{flex:1,textAlign:"center",borderRight:i<3?`1px solid ${C.border}`:"none"}}>
                  <div style={{color:m.col,fontSize:20,fontFamily:C.fnt,fontWeight:700}}>{m.v}</div>
                  <div style={{color:C.muted,fontSize:7,fontFamily:C.fnt,letterSpacing:1,marginTop:1}}>{m.l}</div>
                </div>
              ))}
            </div>
            {/* Boutons navigation AR — affichés uniquement hors nav active */}
            <div style={{display:"flex",gap:6,marginTop:10}}>
              <div onPointerDown={()=>startNav("cycling")}
                style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:5,
                  background:"rgba(59,130,246,0.12)",border:`1px solid #3B82F644`,
                  borderRadius:6,padding:"8px 0",cursor:"pointer"}}>
                <span style={{fontSize:13}}>🚲</span>
                <span style={{color:"#3B82F6",fontSize:8,fontFamily:C.fnt,fontWeight:700,letterSpacing:1}}>{t("ar.nav_cycling")}</span>
              </div>
              <div onPointerDown={()=>startNav("walking")}
                style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:5,
                  background:"rgba(167,139,250,0.12)",border:`1px solid #A78BFA44`,
                  borderRadius:6,padding:"8px 0",cursor:"pointer"}}>
                <span style={{fontSize:13}}>🚶</span>
                <span style={{color:"#A78BFA",fontSize:8,fontFamily:C.fnt,fontWeight:700,letterSpacing:1}}>{t("ar.nav_walking")}</span>
              </div>
            </div>
            {/* Toggle Fischer AR — toujours visible quand caméra active */}
            {cam==="active"&&(
              <div onPointerDown={()=>setFischerOn(f=>!f)}
                style={{
                  display:"flex", alignItems:"center", gap:5, padding:"6px 11px",
                  background: fischerOn ? "rgba(212,120,0,0.2)" : "rgba(0,0,0,0.4)",
                  border:`1px solid ${fischerOn ? "#D47800" : C.border}`,
                  borderRadius:5, cursor:"pointer", marginTop:8,
                  boxShadow: fischerOn ? "0 0 8px #D4780044" : "none",
                  width:"fit-content",
                }}>
                <span style={{fontSize:12}}>🥐</span>
                <span style={{color: fischerOn ? "#D47800" : C.muted, fontSize:8, fontFamily:C.fnt, letterSpacing:1}}>
                  FISCHER {fischerOn ? "ON" : "OFF"}
                </span>
              </div>
            )}
          </div>
        ):(
          <div style={{background:"rgba(8,12,15,0.85)",border:`1px solid ${C.border}`,
            borderRadius:8,padding:"11px 15px",textAlign:"center"}}>
            <div style={{color:C.muted,fontSize:8,fontFamily:C.fnt,letterSpacing:2}}>
              {arPins
                ? t("ar.stations_in_view", {n: arPins.length})
                : cam==="active"
                  ? "BOUSSOLE REQUISE · ACTIVE AR POUR VOIR LES PINS"
                  : `${stations.filter(s=>s.bikes>0).length}/${stations.length} DISPO · ACTIVE LA CAMÉRA`}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── LUX MAP SVG SKETCH ───────────────────────────────────────────

export default ARScreen;
