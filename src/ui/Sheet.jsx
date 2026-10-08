// ── BottomSheet — panneau ancré en bas, glisser pour fermer ─────────
// Props :
//   open       bool     — monté/démonté (l'animation d'entrée est en CSS)
//   onClose    fn       — fermeture (bouton, Échap, glisser > 80 px, voile)
//   label      string   — nom accessible du dialogue
//   modal      bool     — affiche un voile + aria-modal (défaut : false, la
//                         carte reste manipulable derrière une fiche station)
//   inline     bool     — position relative (aperçus, kit) au lieu d'absolute
import { useEffect, useRef, useState } from "react";

export function BottomSheet({ open, onClose, label, modal = false, inline = false, children, className = "" }) {
  const ref = useRef(null);
  const drag = useRef(null);
  const [dy, setDy] = useState(0);

  useEffect(() => {
    if (!open) return;
    const onKey = e => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    if (modal) ref.current?.focus({ preventScroll: true });
    return () => window.removeEventListener("keydown", onKey);
  }, [open, modal, onClose]);

  if (!open) return null;

  const onDown = e => { drag.current = { y: e.clientY, id: e.pointerId }; e.currentTarget.setPointerCapture?.(e.pointerId); };
  const onMove = e => { if (drag.current) setDy(Math.max(0, e.clientY - drag.current.y)); };
  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    if (dy > 80) onClose?.();
    setDy(0);
  };

  return (
    <>
      {modal && <div className="vn-scrim" onClick={onClose} aria-hidden="true"/>}
      <div ref={ref} role="dialog" aria-label={label} aria-modal={modal || undefined} tabIndex={-1}
        className={`vn-sheet ${inline ? "vn-sheet--inline" : ""} ${className}`}
        style={dy ? { transform: `translateY(${dy}px)`, transition: "none" } : undefined}>
        <div onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          style={{ padding: "4px 0 2px", touchAction: "none", cursor: "grab" }} aria-hidden="true">
          <div className="vn-sheet__grab"/>
        </div>
        <div className="vn-sheet__body">{children}</div>
      </div>
    </>
  );
}
