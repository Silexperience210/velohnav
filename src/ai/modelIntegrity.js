// Intégrité des fichiers du modèle dans le cache de transformers.js.
//
// transformers.js relit un fichier en cache dans un tampon de Content-Length octets et
// laisse à zéro ce que le corps ne fournit pas (readResponse, 4.3.1) : un fichier de poids
// incomplet ne lève AUCUNE erreur, le modèle se charge et calcule faux (modelPolicy.js,
// FILE_SHA256). Ici, chaque fichier attendu est relu en flux et haché UNE fois ; vérifié,
// il est marqué dans le cache (verifiedKey) et n'est plus relu aux lancements suivants.
// Faux : il est retiré du cache, retéléchargé, revérifié ; faux encore : erreur.
import { sha256 } from "@noble/hashes/sha256";
import { hubFileUrl, verifiedKey, integrityVerdict } from "./modelPolicy.js";

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Un fichier en cache est-il complet et exact ?
 * @param {Cache} cache
 * @param {string} file chemin dans le dépôt (onnx/model_q4.onnx_data)
 * @param {{ bytes?: number, sha256: string }} want
 * @param {() => void} [onActivity] appelé pendant la lecture : signe de vie pour le chien de garde
 * @returns {Promise<{ ok: boolean, reason: string }>} reason « verified » (déjà vérifié),
 *   « absent » (rien en cache : transformers.js le téléchargera), « ok », ou la différence
 */
export async function checkCached(cache, file, want, onActivity) {
  const url = hubFileUrl(file);
  if (await cache.match(verifiedKey(url, want.sha256))) return { ok: true, reason: "verified" };
  const res = await cache.match(url);
  if (!res?.body) return { ok: true, reason: "absent" };
  const h = sha256.create();
  let n = 0, lastSign = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    h.update(value);
    n += value.byteLength;
    if (n - lastSign >= 8 * 2 ** 20) { lastSign = n; onActivity?.(); }
  }
  const v = integrityVerdict({ bytes: n, sha256: hex(h.digest()) }, want);
  if (v.ok) await cache.put(verifiedKey(url, want.sha256), new Response(String(n)));
  else await cache.delete(url);
  return v;
}

/**
 * Tous les fichiers d'une variante : vérifiés, ou retéléchargés (`refetch`) puis revérifiés.
 * Lève une erreur `stage: "integrity"` si un fichier reste faux après retéléchargement.
 * @param {Cache} cache
 * @param {{ files: string[], bytes?: Record<string,number>, sha256?: Record<string,string> }} variant
 * @param {(file: string, bytes?: number) => Promise<void>} refetch
 * @param {(file: string) => void} [onActivity]
 * @returns {Promise<{ file: string, reason: string }[]>} ce qui a été constaté, fichier par fichier
 */
export async function ensureIntact(cache, variant, refetch, onActivity) {
  const seen = [];
  for (const file of variant.files) {
    const want = { bytes: variant.bytes?.[file], sha256: variant.sha256?.[file] };
    if (!want.sha256) continue;
    let v = await checkCached(cache, file, want, () => onActivity?.(file));
    if (!v.ok) {
      console.warn(`[IA] ${file} en cache est faux (${v.reason}) : retéléchargé`);
      seen.push({ file, reason: `refetched: ${v.reason}` });
      await refetch(file, want.bytes);
      v = await checkCached(cache, file, want, () => onActivity?.(file));
      if (!v.ok) throw Object.assign(new Error(`integrity ${file}: ${v.reason}`), { stage: "integrity" });
    }
    seen.push({ file, reason: v.reason });
  }
  return seen;
}
