// Lance vh_llm_bench sur ce PC, ou sur le téléphone branché (ADB=1) : le binaire arm64 de
// android.sh, le modèle et les cas sont envoyés dans /data/local/tmp/vh (le modèle une
// seule fois : même nom, même taille → pas renvoyé). Rend les lignes JSON du banc.
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { basename } from "node:path";

const REMOTE = "/data/local/tmp/vh";
const adb = (args, opts = {}) => execFileSync(process.env.ADB_BIN || "adb", args, { encoding: "utf8", maxBuffer: 1 << 26, ...opts });
const sent = new Set();

function push(local) {
  const remote = `${REMOTE}/${basename(local)}`;
  if (sent.has(local)) return remote;
  const size = String(statSync(local).size);
  const there = adb(["shell", `stat -c %s ${remote} 2>/dev/null || echo 0`]).trim();
  if (there !== size) adb(["push", local, remote], { stdio: ["ignore", "ignore", "inherit"] });
  sent.add(local);
  return remote;
}

export function benchRun({ bin, model, backend, cases, max, threads }) {
  let out;
  if (process.env.ADB) {
    adb(["shell", `mkdir -p ${REMOTE}`]);
    const b = push(new URL("./android-arm64/vh_llm_bench", import.meta.url).pathname);
    const m = push(model);
    sent.delete(cases);
    const c = push(cases);
    out = adb(["shell", `chmod 755 ${b} && ${process.env.VH_NCTX ? `VH_NCTX=${process.env.VH_NCTX} ` : ""}${b} ${m} ${backend} ${c} ${max} ${threads} 2>/dev/null`]);
  } else {
    out = execFileSync(bin, [model, backend, cases, max, threads], { encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] });
  }
  return out.trim().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
}
