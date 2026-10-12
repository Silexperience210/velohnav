#!/usr/bin/env node
// Télécharge les GGUF candidats (src/ai/modelPolicy.js : NATIVE_CANDIDATES) pour le banc
// compare.mjs : reprise d'un fichier partiel, barre de progression, taille puis SHA-256
// vérifiés — un fichier faux est effacé, jamais gardé.
//
//   node scripts/bench-native/fetch.mjs [clé,clé…|all] [dossier=~/.cache/vn-models/gguf]
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
const { NATIVE_CANDIDATES } = await import("../../src/ai/modelPolicy.js");

const [which = "all", dir = `${process.env.HOME}/.cache/vn-models/gguf`] = process.argv.slice(2);
const keys = which === "all" ? Object.keys(NATIVE_CANDIDATES) : which.split(",");
mkdirSync(dir, { recursive: true });

const sha256 = (path) => new Promise((ok, ko) => {
  const h = createHash("sha256");
  createReadStream(path).on("data", (b) => h.update(b)).on("end", () => ok(h.digest("hex"))).on("error", ko);
});
const mo = (n) => `${(n / 1e6).toFixed(0)} Mo`;

async function fetchOne(m) {
  const dest = join(dir, m.file), part = `${dest}.part`;
  if (existsSync(dest) && statSync(dest).size === m.bytes) { console.log(`✓ ${m.key} déjà là (${mo(m.bytes)})`); return dest; }
  const from = existsSync(part) ? statSync(part).size : 0;
  const url = `https://huggingface.co/${m.id}/resolve/${m.revision}/${m.file}`;
  const res = await fetch(url, { headers: from ? { Range: `bytes=${from}-` } : {} });
  if (!res.ok) throw new Error(`${m.key} : HTTP ${res.status}`);
  const resumed = from > 0 && res.status === 206;
  let got = resumed ? from : 0, last = 0;
  const t0 = Date.now();
  const body = Readable.fromWeb(res.body);
  body.on("data", (b) => {
    got += b.length;
    if (Date.now() - last < 500 && got < m.bytes) return;
    last = Date.now();
    const pct = Math.min(100, (got / m.bytes) * 100), bar = "█".repeat(Math.round(pct / 4)).padEnd(25, "·");
    const rate = (got - (resumed ? from : 0)) / Math.max(1, (Date.now() - t0) / 1000);
    process.stdout.write(`\r  ${m.key.padEnd(18)} ${bar} ${pct.toFixed(1).padStart(5)} % · ${mo(got)}/${mo(m.bytes)} · ${(rate / 1e6).toFixed(1)} Mo/s `);
  });
  await pipeline(body, createWriteStream(part, { flags: resumed ? "a" : "w" }));
  process.stdout.write("\n");
  const size = statSync(part).size;
  if (size !== m.bytes) throw new Error(`${m.key} : taille ${size} != ${m.bytes} (partiel gardé, relancer pour reprendre)`);
  const h = await sha256(part);
  if (h !== m.sha256) { unlinkSync(part); throw new Error(`${m.key} : sha256 ${h.slice(0, 12)}… != ${m.sha256.slice(0, 12)}… (effacé)`); }
  renameSync(part, dest);
  console.log(`✓ ${m.key} : ${mo(size)}, sha256 vérifié`);
  return dest;
}

let ko = 0;
for (const k of keys) {
  const m = NATIVE_CANDIDATES[k];
  if (!m) { console.error(`clé inconnue : ${k} (connues : ${Object.keys(NATIVE_CANDIDATES).join(", ")})`); ko++; continue; }
  try { await fetchOne(m); } catch (e) { console.error(`✗ ${e.message}`); ko++; }
}
process.exit(ko ? 1 : 0);
