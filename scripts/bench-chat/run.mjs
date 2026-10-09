#!/usr/bin/env node
// Banc « conversation libre » dans un vrai navigateur (Chrome headless, WebGPU ou WASM),
// avec le worker et le chemin d'affichage de l'application.
//
//   [HEADLESS=0] node scripts/bench-chat/run.mjs [webgpu|wasm] [config,config…|conversation] [dossier-modèle]
//
// « conversation » : la conversation réelle de cases.CONVERSATION, sur plusieurs tours,
// avec les options de l'application (voir bench.js).
//
// Le modèle est lu en local (aucun téléchargement) : dossier contenant
// LFM2.5-350M-ONNX/ (config.json, tokenizer*, chat_template.jinja, onnx/…),
// par défaut ~/.cache/vn-models/onnx-community. Les résultats (JSON) vont dans
// $TMPDIR/vn-bench-<device>.json et un résumé s'affiche.
import { build } from "vite";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [device = "webgpu", configs = "", modelsDir = `${process.env.HOME}/.cache/vn-models/onnx-community`] = process.argv.slice(2);
// Dossier temporaire du système (TMPDIR) : /tmp peut être un tmpfs plein.
const tmp = os.tmpdir();
const out = path.join(tmp, "vn-bench-dist");
await build({ root: here, base: "./", logLevel: "warn", configFile: false,
  worker: { format: "es" }, build: { outDir: out, emptyOutDir: true, target: "es2022" } });

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };
const rows = [];
let meta = null, finish;
const finished = new Promise((r) => { finish = r; });
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (req.method === "POST" && url === "/__bench") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const m = JSON.parse(body);
      if (m.type === "meta") { meta = m; console.log(`[banc] ${m.device}/${m.dtype}`, JSON.stringify(m.probe)); }
      else if (m.type === "row") {
        rows.push(m);
        console.log(`[${m.cfg}] ${m.q}${m.reachesModel ? "" : "  (reconnu sans modèle)"}\n   brut : ${JSON.stringify(m.raw)}`
          + (m.error ? `\n   ERREUR du worker : ${m.error}` : "")
          + (m.read ? `\n   nettoyé : ${JSON.stringify(m.cleaned)}  → lecture ${m.read}` : "")
          + `\n   affiché (${m.source}${m.reason ? ":" + m.reason : ""}) : ${JSON.stringify(m.shown)}  ${m.ms} ms`);
      }
      else if (m.type === "fatal") { console.error("[banc] échec :", m.message); }
      else if (m.type === "done") finish();
      res.end("ok");
    });
    return;
  }
  const file = url.startsWith("/models/") ? path.join(modelsDir, url.slice(8)) : path.join(out, url === "/" ? "index.html" : url);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.statusCode = 404; return res.end(); }
    res.setHeader("content-type", TYPES[path.extname(file)] || "application/octet-stream");
    res.setHeader("content-length", st.size);
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const profile = fs.mkdtempSync(path.join(tmp, "vn-bench-chrome-"));
const chrome = spawn(process.env.CHROME || "google-chrome", [
  // Sans écran, Chrome n'a que SwiftShader (pas de shader-f16) : HEADLESS=0 ouvre une
  // fenêtre pour atteindre le vrai GPU.
  ...(process.env.HEADLESS === "0" ? ["--ozone-platform-hint=auto"] : ["--headless=new"]), `--user-data-dir=${profile}`, "--no-first-run", "--enable-unsafe-webgpu",
  "--enable-features=Vulkan", "--ignore-gpu-blocklist",
  ...(process.env.CHROME_FLAGS ? process.env.CHROME_FLAGS.split(" ") : []),
  `http://127.0.0.1:${port}/index.html?device=${device}${configs === "conversation" ? "&mode=conversation" : configs ? `&configs=${configs}` : ""}`,
], { stdio: "ignore" });
await finished;
chrome.kill();
server.close();
// Profil jetable : il contient une copie du modèle (cache), des centaines de Mo.
setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 1000);
fs.writeFileSync(path.join(tmp, `vn-bench-${device}.json`), JSON.stringify({ meta, rows }, null, 1));
const by = Object.groupBy(rows, (r) => r.cfg);
console.log("\nRésumé (" + device + ") : configuration → montrées / repli (raisons)");
for (const [cfg, list] of Object.entries(by)) {
  const shown = list.filter((r) => r.source === "model").length;
  const reasons = list.filter((r) => r.source !== "model").map((r) => r.reason || r.source || r.error).join(", ");
  console.log(`  ${cfg.padEnd(11)} ${shown}/${list.length} montrées${reasons ? " ; repli : " + reasons : ""}`);
}
