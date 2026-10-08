#!/usr/bin/env python3
"""Instrumente le bundle : nomme le composant dont l'effet renvoie une valeur non-fonction.

Version 3 — leçon de la version 2 : les identifiants du bundle sont renumérotés par le
regroupement des modules (« J1 », « dM »). Un nom seul est donc inutilisable pour
retrouver le fichier source. On journalise donc, en plus du nom :

  - le SOURCE de la fonction du composant (les 400 premiers caractères de son code),
    qui permet de l'identifier sans ambiguïté ;
  - la chaîne des types parents, également sous forme de source ;
  - le TYPE de la valeur retournée (une promesse, un objet, null…).

Sortie via console.error : visible dans logcat (Android) et sur l'écran d'erreur.

Détection par FORME (expression régulière), jamais par texte figé : les noms de
variables changent selon la version de React et le découpage des chunks.

Usage : python3 tools/diag-patch-bundle-v3.py <répertoire dist>
"""
import pathlib
import re
import sys

# Forme de la fonction de React qui appelle le nettoyage d'un effet.
PATTERN = re.compile(
    r"function (\w+)\(([\w$]+),([\w$]+),([\w$]+)\)\{try\{([\w$]+)\(\)\}catch\(([\w$]+)\)\{([\w$]+)\(\2,[\w$]+,\6\)\}\}"
)

JS = (
    "function {fn}({fiber},{inst},{destroy}){{"
    "if(typeof {destroy}!=='function'){{try{{"
    "var _src=function(x){{try{{return (x&&(x.displayName||x.name)||'?')+': '+String(x).replace(/\\s+/g,' ').slice(0,400);}}catch(_){{return '?';}}}};"
    "var _c=_src({fiber}.type||{fiber}.elementType);"
    "var _p='',_a={fiber},_n=0;"
    "while(_a&&_n<6){{_p+=(_p?'  <<  ':'')+_src(_a.type||_a.elementType);_a=_a.return;_n++;}}"
    "var _m='[DIAG2] nettoyage non-fonction | valeur='+Object.prototype.toString.call({destroy})"
    "+' | composant='+_c+' | parents='+_p;"
    "console.error(_m);"
    "if(typeof window!=='undefined'){{(window.__vnLog=window.__vnLog||[]).push(_m);}}"
    "}}catch(_e){{try{{console.error('[DIAG2] erreur instrument: '+_e);}}catch(__){{}}}}}}"
    "try{{{destroy}()}}catch({err}){{{rappel}({fiber},{inst},{err})}}}}"
)

def instrumente(fn, fiber, inst, destroy, _d2, err, rappel):
    return JS.format(fn=fn, fiber=fiber, inst=inst, destroy=destroy, err=err, rappel=rappel)


def main():
    if len(sys.argv) < 2:
        print("usage : diag-patch-bundle-v3.py <répertoire dist>")
        return 1
    dist = pathlib.Path(sys.argv[1])
    cibles = sorted(dist.glob("assets/*.js"))
    if not cibles:
        print("aucun fichier .js dans", dist / "assets")
        return 1
    posees = 0
    for f in cibles:
        s = f.read_text(encoding="utf-8", errors="replace")
        nouveau, n = PATTERN.subn(lambda m: instrumente(*m.groups()), s)
        if n:
            f.write_text(nouveau, encoding="utf-8")
            print("  %s : %d accroche(s)" % (f.name, n))
            posees += n
    if not posees:
        print("ÉCHEC : aucune accroche posée — instrument muet. Fichiers examinés :",
              ", ".join(c.name for c in cibles))
        return 1
    ok = any("[DIAG2] nettoyage non-fonction" in c.read_text(encoding="utf-8", errors="replace")
             for c in cibles)
    print("vérification :", "accroche présente" if ok else "ABSENTE")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
