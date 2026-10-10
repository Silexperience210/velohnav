// Cache du début de prompt : la consigne système et les schémas d'outils.
//
// Chaque question repart du même début — consigne + outils, ~730 jetons, contre une
// dizaine pour la question elle-même. Sans cache, le modèle le recalcule à chaque fois :
// mesuré sur le moteur processeur de l'application (WASM, 1 fil, PC de bureau), 28 s
// de calcul avant le premier mot, pour 2 s de question. L'état du modèle après ce début
// (clés/valeurs d'attention, états des convolutions de LFM2) est calculé UNE fois, puis
// copié pour chaque génération.
//
// Les convolutions de LFM2 ont un état récurrent : on ne peut pas tronquer un cache
// après coup pour revenir au début du prompt. L'état est donc pris exactement à la fin
// du préfixe, avant toute génération, et chaque génération en reçoit une copie.

/**
 * Longueur réutilisable : celle du préfixe si `full` commence par lui ET le prolonge
 * (il faut au moins un jeton à calculer), sinon 0.
 * @param {ArrayLike<number|bigint>} full
 * @param {ArrayLike<number|bigint>} prefix
 */
export function reusablePrefix(full, prefix) {
  if (!prefix?.length || full.length <= prefix.length) return 0;
  for (let i = 0; i < prefix.length; i++) if (full[i] !== prefix[i]) return 0;
  return prefix.length;
}

/** Messages du préfixe : la consigne système seule, ou rien. */
export const prefixMessages = (messages) => (messages?.[0]?.role === "system" && messages.length > 1 ? [messages[0]] : null);

/**
 * Le cache peut-il être partagé entre générations ? Seulement si ses tenseurs vivent en
 * mémoire JS (moteur processeur). Sur WebGPU, transformers.js détruit les tampons GPU
 * d'un cache qu'il remplace (DynamicCache.update) : une copie partagée y serait détruite
 * dès la première génération.
 */
export const shareable = (cache) => {
  const tensors = Object.values(cache || {});
  return tensors.length > 0 && tensors.every((t) => t?.location === "cpu");
};

/**
 * Copie superficielle : generate() remplace les entrées de la copie (update), jamais
 * les tenseurs du préfixe eux-mêmes.
 */
export const copyCache = (cache) => new cache.constructor({ ...cache });
