import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Un useEffect écrit en flèche concise retourne la valeur de son expression. Si ce n'est
// pas une fonction, React la stocke comme fonction de nettoyage, l'appelle au démontage
// et lève « TypeError: <x> is not a function » — erreur attrapée par l'écran d'erreur,
// qui l'affiche avec le titre « Erreur au démarrage » et fait croire à un défaut de
// lancement alors qu'il survient au démontage.
//
// Constaté en production : dans AIScreen, `useEffect(()=>ref.current?.scrollIntoView(…))`
// retournait une promesse dans la WebView Android, et `undefined` dans Chrome de bureau —
// d'où un défaut invisible en test navigateur et en émulateur. Un instrument posé sur le
// bundle (accroche de la fonction de nettoyage de React) a nommé le composant.
//
// Règle : un effet doit utiliser un corps à accolades, sauf s'il retourne explicitement
// une fonction de nettoyage ou `undefined`.

const RACINE = path.resolve(__dirname, "..");
const EXT = new Set([".js", ".jsx"]);

const EXCLUS = new Set(["node_modules", "dist", ".git", "android", "ios", "__fixtures__"]);

function fichiers(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) fichiers(p, out);
    else if (EXT.has(path.extname(e.name)) && !e.name.includes(".test.")) out.push(p);
  }
  return out;
}

describe("effets React — corps à accolades obligatoire", () => {
  const fautifs = [];
  for (const f of fichiers(RACINE)) {
    const src = fs.readFileSync(f, "utf8");
    const re = /use(?:Layout|Insertion)?Effect\(\s*(?:async\s*)?\(\s*\)\s*=>\s*(?![\s{])/g;
    let m;
    while ((m = re.exec(src))) {
      const reste = src.slice(m.index + m[0].length);
      const ligne = src.slice(0, m.index).split("\n").length;
      if (/^\(\s*\)?\s*=>/.test(reste)) continue;   // retourne une fonction de nettoyage
      if (/^function\b/.test(reste)) continue;      // idem
      if (/^undefined\b/.test(reste)) continue;     // explicitement rien
      fautifs.push(`${path.relative(RACINE, f)}:${ligne} → ${reste.split("\n")[0].slice(0, 90)}`);
    }
  }

  it("aucun effet ne retourne une valeur non-fonction", () => {
    expect(fautifs, "Effets à corriger (ajouter des accolades) :\n" + fautifs.join("\n")).toEqual([]);
  });

});
