import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { t } from "../i18n.js";
import { C, COMPASS_LABELS, FOV } from "../constants.js";
import { haversine, getBearing, fDist, fWalk, bCol, bTag, pins, nearestStop } from "../utils.js";
import { getWeatherAdvice } from "../hooks/useWeather.js";
import WeatherBanner from "./WeatherBanner.jsx";

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

function MapScreen({ stations, sel, setSel, gpsPos, trip, onStartTrip, mapsKey, onTabChange, weather }) {
  const [filter, setFilter] = useState("all"); // all | bikes | docks | elec
  const [search, setSearch] = useState("");

  // Lancer navigation AR : sélectionner la station + switcher vers l'onglet AR
  // ARScreen lit velohnav_pendingNavMode au montage pour auto-démarrer la nav
  const launchArNav = useCallback((station, mode)=>{
    setSel(station.id);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("velohnav_pendingNavMode", mode);
      localStorage.setItem("velohnav_pendingNavId", String(station.id));
    }
    onTabChange?.("ar");
  },[setSel, onTabChange]);

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
    {id:"all",  label:t("map.filter_all"),    count:stations.length},
    {id:"bikes",label:t("map.filter_bikes"),count:stations.filter(s=>s.bikes>0&&s.status==="OPEN").length},
    {id:"docks",label:t("map.filter_docks"), count:stations.filter(s=>s.docks>0&&s.status==="OPEN").length},
    {id:"elec", label:t("map.filter_elec"),  count:stations.filter(s=>s.elec>0&&s.status==="OPEN").length},
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
            placeholder={t("map.search")}
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
            <span style={{ color:C.accent,fontSize:8,fontFamily:C.fnt,letterSpacing:1 }}>{t("map.reset")}</span>
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
              {l:t("station.bikes"),  v:selStation.bikes, col:bCol(selStation)},
              {l:t("station.elec"), v:selStation.elec,  col:"#60A5FA"},
              {l:t("station.meca"), v:selStation.meca,  col:C.text},
              {l:t("station.docks"),  v:selStation.docks, col:C.good},
              {l:t("station.capacity"),   v:selStation.cap,   col:C.muted},
            ].map((m,i)=>(
              <div key={m.l} style={{ flex:1,textAlign:"center",
                borderRight:i<4?`1px solid ${C.border}`:"none" }}>
                <div style={{ color:m.col,fontSize:18,fontFamily:C.fnt,fontWeight:700 }}>{m.v}</div>
                <div style={{ color:C.muted,fontSize:6,fontFamily:C.fnt,letterSpacing:0.5,marginTop:1 }}>{m.l}</div>
              </div>
            ))}
          </div>
          {/* Boutons navigation */}
          <div style={{ marginTop:10,display:"flex",gap:6,flexWrap:"wrap" }}>
            {/* Primaires : AR nav (lance ARCore ou web AR) */}
            <div onPointerDown={()=>launchArNav(selStation,"cycling")}
              style={{ flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:5,
                background:"rgba(59,130,246,0.15)",border:`1px solid #3B82F655`,
                borderRadius:6,padding:"9px 0",cursor:"pointer",minWidth:80 }}>
              <span style={{ fontSize:14 }}>🚲</span>
              <div>
                <div style={{ color:"#3B82F6",fontSize:9,fontFamily:C.fnt,fontWeight:700 }}>{t("ar.nav_cycling")}</div>
                <div style={{ color:C.muted,fontSize:6,fontFamily:C.fnt }}>itinéraire AR</div>
              </div>
            </div>
            <div onPointerDown={()=>launchArNav(selStation,"walking")}
              style={{ flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:5,
                background:"rgba(167,139,250,0.15)",border:`1px solid #A78BFA55`,
                borderRadius:6,padding:"9px 0",cursor:"pointer",minWidth:80 }}>
              <span style={{ fontSize:14 }}>🚶</span>
              <div>
                <div style={{ color:"#A78BFA",fontSize:9,fontFamily:C.fnt,fontWeight:700 }}>{t("ar.nav_walking")}</div>
                <div style={{ color:C.muted,fontSize:6,fontFamily:C.fnt }}>itinéraire AR</div>
              </div>
            </div>
            {/* Secondaire : Google Maps externe */}
            <a href={`https://www.google.com/maps/dir/?api=1&destination=${selStation.lat},${selStation.lng}&travelmode=walking`}
              target="_blank" rel="noopener noreferrer"
              style={{ display:"flex",alignItems:"center",justifyContent:"center",
                background:"rgba(255,255,255,0.04)",border:`1px solid ${C.border}`,
                borderRadius:6,padding:"9px 12px",textDecoration:"none" }}>
              <span style={{ fontSize:14 }}>🗺</span>
            </a>
            {/* Bouton démarrer trajet */}
            {!trip&&selStation.bikes>0&&onStartTrip&&(
              <div onPointerDown={()=>onStartTrip(selStation)}
                style={{ display:"flex",alignItems:"center",justifyContent:"center",gap:4,
                  background:"rgba(46,204,143,0.12)",border:`1px solid ${C.good}55`,
                  borderRadius:6,padding:"9px 12px",cursor:"pointer" }}>
                <span style={{ fontSize:12 }}>▶</span>
                <span style={{ color:C.good,fontSize:8,fontFamily:C.fnt,fontWeight:700 }}>{t("map.start_trip")}</span>
              </div>
            )}
          </div>

          {/* ── Bandeau météo + recommandation multimodale ── */}
          {(()=>{
            if (!weather) return null;
            const advice  = getWeatherAdvice(weather);
            const near    = selStation
              ? nearestStop(selStation.lat, selStation.lng)
              : null;
            return (
              <WeatherBanner
                weather={weather}
                advice={advice}
                nearStop={near}
                station={selStation}
              />
            );
          })()}
        </div>
      ) : (
        /* ── Légende compacte + météo inline quand rien n'est sélectionné ── */
        <div style={{ display:"flex",gap:10,padding:"5px 14px 10px",flexShrink:0,alignItems:"center",flexWrap:"wrap" }}>
          {[[C.good,"Dispo"],[C.warn,"Faible"],[C.bad,"Vide"],["#444","Fermé"],[C.blue,"Vous"]].map(([c,l])=>(
            <div key={l} style={{ display:"flex",alignItems:"center",gap:3 }}>
              <div style={{ width:6,height:6,borderRadius:"50%",background:c,boxShadow:`0 0 4px ${c}` }}/>
              <span style={{ color:C.muted,fontSize:7,fontFamily:C.fnt }}>{l}</span>
            </div>
          ))}
          {/* Météo mini dans la légende */}
          {weather&&(()=>{
            const advice = getWeatherAdvice(weather);
            const col = advice.mode==="bike"?C.good:advice.mode==="transit"?"#A78BFA":C.warn;
            return (
              <span style={{ color:col, fontSize:8, fontFamily:C.fnt,
                marginLeft:"auto", fontWeight:700 }}>
                {weather.icon} {weather.temp}°C
              </span>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// ── AI SCREEN ─────────────────────────────────────────────────────

export default MapScreen;
