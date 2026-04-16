import { useState, useEffect, useRef, useCallback } from "react";

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
      if(last===null){ last=h; setHeading(Math.round((h+360)%360)); return; }
      const diff=((h-last+540)%360)-180;
      if(Math.abs(diff)<1.5) return;           // deadzone : ignore le bruit < 1.5°
      last=last+diff*0.08;                     // EMA lent → boussole stable
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

export { useCompass };
