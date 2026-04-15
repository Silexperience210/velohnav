/**
 * VelohNav i18n — hook minimaliste sans dépendance externe
 *
 * Langues supportées : fr (défaut), en
 * Détection automatique depuis navigator.language
 * Interpolation basique : t('trip.from', { name:'Hamilius', min:5 })
 *   → "Depuis Hamilius · 5 min"
 */

import fr from './locales/fr.js';
import en from './locales/en.js';

const LOCALES = { fr, en };
const SUPPORTED = Object.keys(LOCALES);

// Détecte la langue du navigateur, avec fallback FR
function detectLang() {
  const nav = navigator.language || 'fr';
  const code = nav.slice(0, 2).toLowerCase();
  return SUPPORTED.includes(code) ? code : 'fr';
}

// Singleton — langue choisie une fois au chargement
// (peut être surchargée via localStorage 'velohnav_lang')
let _lang = null;
function getLang() {
  if (_lang) return _lang;
  const stored = localStorage.getItem('velohnav_lang');
  _lang = (stored && SUPPORTED.includes(stored)) ? stored : detectLang();
  return _lang;
}

export function setLang(lang) {
  if (!SUPPORTED.includes(lang)) return;
  _lang = lang;
  localStorage.setItem('velohnav_lang', lang);
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

  // Interpolation : remplace {var} par la valeur
  Object.entries(vars).forEach(([k, v]) => {
    str = str.replaceAll(`{${k}}`, String(v));
  });

  return str;
}

/**
 * Hook React — force un re-render si la langue change dynamiquement
 * Usage : const { t, lang, setLanguage } = useI18n();
 */
import { useState, useCallback } from 'react';

export function useI18n() {
  const [lang, setLangState] = useState(getLang);

  const setLanguage = useCallback((newLang) => {
    setLang(newLang);
    setLangState(newLang);
  }, []);

  return { t, lang, setLanguage, supported: SUPPORTED };
}

export default t;
