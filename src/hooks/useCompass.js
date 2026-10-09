import { useState, useEffect, useRef, useCallback } from "react";
import { pitchFromOrientation } from "../components/ar/groundProjection.js";

// ── Fonctions pures (exportées pour tests) ─────────────────────────

const RAD = Math.PI / 180;

/**
 * Cap (0..360) de la direction visée par la caméra arrière, à partir des
 * angles DeviceOrientation (repère W3C : alpha autour de z, beta autour de x,
 * gamma autour de y ; Terre : x = est, y = nord). Formule de la spécification
 * W3C (exemple « compassHeading ») : on projette l'axe −z de l'appareil sur
 * le plan horizontal.
 *
 * Pourquoi pas simplement 360 − alpha : téléphone tenu droit (beta ≈ 90°),
 * alpha et gamma décrivent TOUS DEUX une rotation autour de la verticale
 * (blocage de cardan) ; le navigateur peut répartir le lacet entre les deux,
 * et 360 − alpha ignore la part portée par gamma. En paysage, il se trompait
 * en plus de 90°. Retourne null si la caméra vise presque le sol ou le ciel
 * (cap indéfini) — l'appelant retombe alors sur 360 − alpha.
 */
export function headingFromOrientation(alpha, beta, gamma) {
  if (alpha == null || beta == null || gamma == null) return null;
  const a = alpha * RAD, b = beta * RAD, g = gamma * RAD;
  const east  = -Math.sin(g) * Math.cos(a) - Math.cos(g) * Math.sin(b) * Math.sin(a);
  const north = -Math.sin(g) * Math.sin(a) + Math.cos(g) * Math.sin(b) * Math.cos(a);
  if (Math.hypot(east, north) < 0.3) return null;   // caméra à plus de ~73° de l'horizon
  return ((Math.atan2(east, north) / RAD) % 360 + 360) % 360;
}

/**
 * Un pas de lissage circulaire. `last` = état interne (null au départ).
 * Renvoie le nouvel état, ou `last` inchangé si l'écart est sous la zone morte.
 * L'état est TOUJOURS ramené dans [0, 360) : avant, il pouvait dériver sans
 * borne (−370 après un tour complet vers la gauche) et le cap publié devenait
 * négatif (« −10° », étiquette cardinale « undefined »).
 */
export function emaHeadingStep(last, h, alpha = 0.08, deadzone = 1.5) {
  const hh = ((h % 360) + 360) % 360;
  if (last == null) return hh;
  const diff = ((hh - last + 540) % 360) - 180;
  if (Math.abs(diff) < deadzone) return last;
  return (((last + diff * alpha) % 360) + 360) % 360;
}

/**
 * Un pas de lissage de l'inclinaison (degrés, pas de bouclage à gérer). Plus
 * réactif que le cap (0,25) : l'inclinaison place verticalement tout le tracé.
 */
export function emaPitchStep(last, p, alpha = 0.25) {
  if (p == null || !Number.isFinite(p)) return last;
  return last == null ? p : last + (p - last) * alpha;
}

/** Cap publié : entier dans [0, 359] (Math.round(359,7) donnait 360). */
export function publishHeading(last) {
  return Math.round(last) % 360;
}

// ── Hook ───────────────────────────────────────────────────────────

function useCompass(){
  const [heading,setHeading]=useState(null);
  const [perm,setPerm]=useState("idle");
  // Inclinaison de la caméra (élévation de visée, °) : la valeur lissée vit dans
  // une ref (lue à chaque image par le tracé, sans re-rendu) ; l'état, arrondi
  // au degré, re-rend les pins posés au sol.
  const pitchRef=useRef(null);
  const [pitch,setPitch]=useState(null);
  const cleanup=useRef(null);

  const start=useCallback(async()=>{
    // Un nouvel appel (bouton « Réessayer », relance de la caméra par le
    // watchdog) ne doit pas empiler une deuxième paire d'écouteurs : chacune
    // avait son propre état de lissage et elles se disputaient le cap.
    cleanup.current?.();
    cleanup.current=null;
    setPerm("requesting");

    // `typeof window.X` et non `X?.` : un identifiant global non déclaré lève
    // une ReferenceError même avec le chaînage optionnel.
    const DOE = typeof window !== "undefined" ? window.DeviceOrientationEvent : undefined;
    if(!DOE){setPerm("unavailable");return;}

    // iOS 13+ seulement — DOIT être appelé dans le geste (pas d'await avant)
    if(typeof DOE.requestPermission==="function"){
      try{
        const r=await DOE.requestPermission();
        if(r!=="granted"){setPerm("denied");return;}
      }catch{setPerm("denied");return;}
    }

    let last=null;
    let gotAbsolute=false; // true dès qu'on reçoit un event absolu valide

    const updatePitch=(e)=>{
      pitchRef.current=emaPitchStep(pitchRef.current,pitchFromOrientation(e.beta,e.gamma));
      if(pitchRef.current!=null){
        const r=Math.round(pitchRef.current);
        setPitch(p=>p===r?p:r);
      }
    };

    const update=(h)=>{
      const next=emaHeadingStep(last,h);
      if(next===last) return;
      last=next;
      setHeading(publishHeading(last));
    };

    // Handler absolu (Android Chrome 74+ : référencé au nord magnétique)
    const absHandler=(e)=>{
      if(e.alpha==null) return;
      gotAbsolute=true;
      updatePitch(e);
      update(headingFromOrientation(e.alpha,e.beta,e.gamma) ?? (360-e.alpha+360)%360);
    };

    // Handler relatif — utilisé SEULEMENT si aucun absolu reçu
    // iOS → webkitCompassHeading, Android fallback → alpha relatif
    const relHandler=(e)=>{
      if(gotAbsolute) return;
      updatePitch(e);
      if(e.webkitCompassHeading!=null)      update(e.webkitCompassHeading);
      else if(e.alpha!=null)                update(headingFromOrientation(e.alpha,e.beta,e.gamma) ?? (360-e.alpha+360)%360);
    };

    window.addEventListener("deviceorientationabsolute",absHandler,true);
    window.addEventListener("deviceorientation",relHandler,true);
    setPerm("granted");

    // Timeout : si aucun signal après 4s → diagnostic
    const t=setTimeout(()=>{
      if(last===null) setPerm("nosignal");
    },4000);

    cleanup.current=()=>{
      clearTimeout(t);
      window.removeEventListener("deviceorientationabsolute",absHandler,true);
      window.removeEventListener("deviceorientation",relHandler,true);
    };
  },[]);

  useEffect(()=>()=>cleanup.current?.(),[]);
  return{heading,perm,start,pitch,pitchRef};
}

export { useCompass };
