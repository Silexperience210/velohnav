/**
 * VelohNav i18n — minimaliste, sans dépendance externe
 *
 * Langues supportées : fr (défaut), en
 * Détection automatique depuis navigator.language
 * Interpolation basique : t('trip.from', { name:'Hamilius', min:5 })
 *   → "Depuis Hamilius · 5 min"
 *
 * v4 : changement de langue réactif dans toute l'app (useI18n s'abonne via
 * useSyncExternalStore) ; robuste sans localStorage/navigator (tests Node).
 */

import { useCallback, useSyncExternalStore } from 'react';
import fr from './locales/fr.js';
import en from './locales/en.js';

const LOCALES = { fr, en };
const SUPPORTED = Object.keys(LOCALES);
const KEY = 'velohnav_lang';

function storageGet(k) {
  try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; }
}
function storageSet(k, v) {
  try { globalThis.localStorage?.setItem(k, v); } catch { /* mode privé / Node */ }
}

// Détecte la langue du navigateur, avec fallback FR
function detectLang() {
  const nav = (typeof navigator !== 'undefined' && navigator.language) || 'fr';
  const code = nav.slice(0, 2).toLowerCase();
  return SUPPORTED.includes(code) ? code : 'fr';
}

// Singleton — langue choisie une fois au chargement
// (peut être surchargée via localStorage 'velohnav_lang')
let _lang = null;
const listeners = new Set();

function getLang() {
  if (_lang) return _lang;
  const stored = storageGet(KEY);
  _lang = (stored && SUPPORTED.includes(stored)) ? stored : detectLang();
  return _lang;
}

export function setLang(lang) {
  if (!SUPPORTED.includes(lang)) return;
  _lang = lang;
  storageSet(KEY, lang);
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  listeners.forEach(fn => fn());
}

export function getCurrentLang() {
  return getLang();
}

export function getSupportedLangs() {
  return SUPPORTED;
}

/**
 * Fonction de traduction principale
 * @param {string} key   - Clé de traduction ex: 'ar.activate'
 * @param {object} vars  - Variables d'interpolation ex: { n: 5, name: 'Hamilius' }
 * @returns {string}
 */
export function t(key, vars = {}) {
  const locale = LOCALES[getLang()] || fr;
  let str = locale[key] ?? fr[key] ?? key; // fallback FR puis clé brute

  // Interpolation : remplace {var} par la valeur (toutes les occurrences).
  // Découpe/recollage plutôt que replaceAll : certaines WebView Android ne l'ont pas.
  Object.entries(vars).forEach(([k, v]) => {
    str = str.split(`{${k}}`).join(String(v));
  });

  return str;
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Hook React — re-render de tous les composants abonnés quand la langue change
 * Usage : const { t, lang, setLanguage } = useI18n();
 */
/**
 * Pluriel : renvoie « n unité » avec la bonne forme.
 * Le français met 0 et 1 au singulier, l'anglais seulement 1.
 *   tn("ui.ai.unit.bike", 1) → « 1 vélo »   tn("ui.ai.unit.bike", 3) → « 3 vélos »
 */
export function tn(baseKey, n) {
  const singular = n === 1 || (n === 0 && getLang() !== "en");
  return `${n} ${t(`${baseKey}.${singular ? "one" : "many"}`)}`;
}

export function useI18n() {
  const lang = useSyncExternalStore(subscribe, getLang, getLang);
  const setLanguage = useCallback((newLang) => setLang(newLang), []);
  return { t, lang, setLanguage, supported: SUPPORTED };
}

export default t;
