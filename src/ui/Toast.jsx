// ── Toasts globaux ──────────────────────────────────────────────────
// <ToastProvider> enveloppe l'app ; useToast() renvoie { show, update, dismiss }.
//   show({ tone, icon, title, msg, duration, render }) → id
//   tone : neutral | good | warn | bad | accent ; duration 0 = persistant
//   render : contenu personnalisé (ex. <SatsReward/>) à la place du gabarit
// Région aria-live="polite" : lus par TalkBack sans voler le focus.
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import { t } from "../i18n.js";

const Ctx = createContext({ show: () => 0, update: () => {}, dismiss: () => {} });
export const useToast = () => useContext(Ctx);

const DEFAULT_ICON = { good: "check", bad: "alert", warn: "alert", accent: "info", neutral: "info" };
const MAX = 3;

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const timers = useRef(new Map());
  const seq = useRef(0);

  const remove = useCallback(id => {
    setItems(xs => xs.map(x => x.id === id ? { ...x, leaving: true } : x));
    setTimeout(() => setItems(xs => xs.filter(x => x.id !== id)), 180);
    clearTimeout(timers.current.get(id)); timers.current.delete(id);
  }, []);

  const arm = useCallback((id, duration) => {
    clearTimeout(timers.current.get(id));
    if (duration > 0) timers.current.set(id, setTimeout(() => remove(id), duration));
  }, [remove]);

  const show = useCallback(opts => {
    const id = opts.id ?? ++seq.current;
    const item = { tone: "neutral", duration: 3200, ...opts, id };
    setItems(xs => [...xs.filter(x => x.id !== id), item].slice(-MAX));
    arm(id, item.duration);
    return id;
  }, [arm]);

  const update = useCallback((id, patch) => {
    setItems(xs => xs.map(x => x.id === id ? { ...x, ...patch, leaving: false } : x));
    if (patch.duration !== undefined) arm(id, patch.duration);
  }, [arm]);

  const api = useMemo(() => ({ show, update, dismiss: remove }), [show, update, remove]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="vn-toasts" aria-live="polite" aria-relevant="additions text">
        {items.map(x => (
          <div key={x.id} className="vn-toast" data-tone={x.tone} data-leaving={x.leaving || undefined}
            style={x.render ? { padding: 0, background: "transparent", border: 0, boxShadow: "0 10px 30px rgba(0,0,0,0.55)" } : undefined}>
            {x.render ? <div style={{ width: "100%" }}>{x.render({ close: () => remove(x.id) })}</div> : (
              <>
                <span className="vn-toast__icon"><Icon name={x.icon ?? DEFAULT_ICON[x.tone]} size={16}/></span>
                <div className="vn-toast__body">
                  {x.title && <div className="vn-toast__title">{x.title}</div>}
                  {x.msg && <div className="vn-toast__msg">{x.msg}</div>}
                </div>
                <button type="button" className="vn-iconbtn vn-iconbtn--sm" aria-label={t("ui.close")} onClick={() => remove(x.id)}>
                  <Icon name="x" size={15}/>
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
