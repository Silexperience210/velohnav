// Journal des chargements du modèle : la preuve, sur l'appareil, que le GPU sert à chaque
// lancement. Chaque chargement laisse une entrée — voie retenue, GPU annoncé, durée,
// mémoire, sorties BRUTES des deux tours de l'essai à vide et des deux premières réponses,
// voies écartées et pourquoi. Les 10 dernières sont gardées (localStorage), lisibles et
// copiables dans les réglages. Fonctions pures ici ; localModel.js les alimente.

export const JOURNAL_KEY = "velohnav_ai_journal";
export const JOURNAL_MAX = 10;
/** Réponses gardées par lancement : les tours 1 et 2, ceux où une corruption se voit. */
export const JOURNAL_REPLIES = 2;
const RAW_MAX = 200;

const clip = (s, n = RAW_MAX) => String(s ?? "").slice(0, n);

/** La voie retenue calcule-t-elle sur le GPU ? */
export const onGpu = (e) => !!e?.chosen && (e.chosen.engine === "vulkan" || e.chosen.device === "webgpu");

/**
 * Entrée du journal pour un chargement terminé (réussi ou non).
 * @param {object} report modelReport()
 * @param {{ at: number, error?: { code: string, detail?: string } | null }} o
 */
export function journalEntry(report, { at, error = null }) {
  const c = report?.chosen;
  return {
    at,
    chosen: c ? {
      id: c.id, engine: c.engine, device: c.device,
      ...(c.gpuName ? { gpu: clip(c.gpuName, 80) } : {}),
      ...(c.gpuMode && c.gpuMode !== "base" ? { mode: c.gpuMode } : {}),
      ...(c.kv ? { kv: c.kv } : {}),
      ...(Number.isFinite(c.loadMs) ? { loadMs: c.loadMs } : {}),
      ...(c.mem ? { mem: { ...c.mem } } : {}),
      ...(Number.isFinite(c.sysMB) ? { sysMB: c.sysMB } : {}),
      selfTest: (c.selfTestRaw || []).map((x) => clip(x)),
    } : null,
    // GPU WebGPU annoncé (sonde) : sur la voie JavaScript, c'est le seul nom du GPU
    ...(report?.gpu?.adapter ? { webgpu: clip([report.gpu.vendor, report.gpu.architecture, report.gpu.description].filter(Boolean).join(" "), 80) } : {}),
    tried: (report?.tried || []).map((x) => ({ id: x.id, code: x.code, detail: clip(x.detail, 160) })),
    skipped: (report?.skipped || []).map((x) => ({ id: x.id, reason: clip(x.reason, 160) })),
    ...(report?.native ? { native: { kind: report.native.kind, detail: clip(report.native.detail, 160) } } : {}),
    ...(error ? { error: { code: error.code, detail: clip(error.detail, 240) } } : {}),
    replies: [],
  };
}

/** Ajoute une réponse (tours 1 et 2 seulement) ; rend une nouvelle entrée. */
export function withReply(entry, { raw, stats }) {
  if (!entry || entry.replies.length >= JOURNAL_REPLIES) return entry;
  const r = {
    raw: clip(raw),
    ...(Number.isFinite(stats?.tokens) ? { tokens: stats.tokens } : {}),
    ...(Number.isFinite(stats?.tps) ? { tps: stats.tps } : {}),
    ...(Number.isFinite(stats?.ms) ? { ms: stats.ms } : {}),
    ...(stats?.genOnly ? { genOnly: true } : {}),
    ...(stats?.mem ? { mem: { ...stats.mem } } : {}),
  };
  return { ...entry, replies: [...entry.replies, r] };
}

/** Lit le journal stocké (tolère l'absent et le corrompu). */
export function parseJournal(stored) {
  try {
    const j = JSON.parse(stored ?? "[]");
    return Array.isArray(j) ? j.filter((e) => e && Number.isFinite(e.at)).slice(-JOURNAL_MAX) : [];
  } catch { return []; }
}

/** Ajoute une entrée, ne garde que les JOURNAL_MAX dernières. */
export const pushEntry = (entries, e) => [...entries, e].slice(-JOURNAL_MAX);
/** Remplace la dernière entrée (réponses ajoutées au lancement en cours). */
export const replaceLast = (entries, e) => (entries.length ? [...entries.slice(0, -1), e] : [e]);

/**
 * Bilan des `n` derniers lancements : combien sur le GPU. Le critère d'acceptation —
 * 5 lancements consécutifs, GPU à chaque fois — se lit ici.
 * @returns {{ n: number, gpu: number }}
 */
export function gpuStreak(entries, n = 5) {
  const last = entries.slice(-n);
  return { n: last.length, gpu: last.filter(onGpu).length };
}

const mb = (x) => (Number.isFinite(x) ? `${x} Mo` : "?");
const memLine = (m) => [
  Number.isFinite(m.rssMB) ? `rss ${mb(m.rssMB)}` : "",
  Number.isFinite(m.peakMB) ? `pic ${mb(m.peakMB)}` : "",
  Number.isFinite(m.pssMB) ? `pss ${mb(m.pssMB)}` : "",
  Number.isFinite(m.gfxMB) ? `gpu ${mb(m.gfxMB)}` : "",
].filter(Boolean).join(", ");

/**
 * Texte du journal, une entrée par bloc, la plus récente d'abord : ce qui s'affiche et
 * ce qui se copie. Identifiants techniques (q4_0/vulkan…) gardés tels quels : c'est ce
 * qu'on compare d'un lancement à l'autre.
 */
export function formatJournal(entries) {
  return [...entries].reverse().map((e) => {
    const d = new Date(e.at);
    const when = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} `
      + `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
    const c = e.chosen;
    const lines = [];
    if (c) {
      lines.push(`${when} · ${onGpu(e) ? "GPU" : "CPU"} · ${c.id}${c.mode ? ` (${c.mode})` : ""} · ${c.gpu || e.webgpu || "—"}`
        + `${Number.isFinite(c.loadMs) ? ` · prêt ${(c.loadMs / 1000).toFixed(1)} s` : ""}${c.kv ? ` · kv ${c.kv}` : ""}`);
      if (c.mem || Number.isFinite(c.sysMB)) {
        lines.push(`  mém : ${[c.mem ? `:llm ${memLine(c.mem)}` : "", Number.isFinite(c.sysMB) ? `système ${mb(c.sysMB)}` : ""].filter(Boolean).join(" · ")}`);
      }
      c.selfTest.forEach((s, i) => lines.push(`  essai ${i + 1} : ${JSON.stringify(s)}`));
    } else {
      lines.push(`${when} · ÉCHEC · ${e.error?.code || "?"}${e.error?.detail ? ` : ${e.error.detail}` : ""}`);
    }
    e.replies.forEach((r, i) => lines.push(`  tour ${i + 1} : ${r.tokens ?? "?"} j${Number.isFinite(r.tps) ? `, ${r.tps} j/s${r.genOnly ? "" : " (total)"}` : ""}`
      + `${r.mem ? ` · ${memLine(r.mem)}` : ""} · ${JSON.stringify(r.raw)}`));
    if (e.native) lines.push(`  natif écarté : ${e.native.kind}${e.native.detail ? ` (${e.native.detail})` : ""}`);
    e.tried.forEach((x) => lines.push(`  essayé : ${x.id} → ${x.code}${x.detail ? ` (${x.detail})` : ""}`));
    e.skipped.forEach((x) => lines.push(`  écarté : ${x.id} [${x.reason}]`));
    return lines.join("\n");
  }).join("\n\n");
}
