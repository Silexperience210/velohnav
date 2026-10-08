#!/usr/bin/env python3
"""Instrumente le bundle construit pour NOMMER le composant dont l'effet renvoie
une valeur non-fonction.

Pourquoi : React appelle la valeur de retour d'un useEffect comme fonction de
nettoyage, sans vérifier son type, et n'émet aucun avertissement — même en version
de développement (vérifié dans le bundle : `function ef(e,t,n){try{n()}catch(a){vt(e,t,a)}}`).
Un useEffect qui retourne par exemple une promesse produit donc
« TypeError: <x> is not a function » sans indiquer le composant.

On accroche cette fonction dans le bundle final : si la valeur appelée n'est pas une
fonction, on journalise le composant concerné et sa chaîne de parents avant que React
ne déclenche l'erreur. La sortie passe par console.error : visible dans logcat
(Android) ET sur l'écran d'erreur de l'application.

La détection se fait sur la FORME de la fonction (expression régulière), jamais sur un
texte figé : les noms de variables changent selon la version de React et le découpage
des bundles. Le script échoue bruyamment s'il ne trouve rien, pour ne jamais produire
un instrument muet en silence.

Usage : python3 tools/diag-patch-bundle-v2.py <répertoire dist>
"""
import pathlib
import re
import sys

# Forme de la fonction de React qui appelle le nettoyage d'un effet :
#   function X(fibre, instance, destroy) { try { destroy() } catch (e) { Y(fibre, instance, e) } }
PATTERN = re.compile(
    r"function (\w+)\(([\w$]+),([\w$]+),([\w$]+)\)\{try\{([\w$]+)\(\)\}catch\(([\w$]+)\)\{([\w$]+)\(\2,[\w$]+,\6\)\}\}"
)


def instrumente(fn, fiber, inst, destroy, _destroy_dans_try, err, rappel):
    """Journalise le composant avant d'appeler la valeur fautive."""
    return (
        "function %s(%s,%s,%s){if(typeof %s!=='function'){try{"
        "var _c=(%s.type&&(%s.type.displayName||%s.type.name))||(%s.elementType&&(%s.elementType.name||%s.elementType.displayName))||'composant inconnu';"
        "var _k=Object.prototype.toString.call(%s);"
        "var _p='',_f=%s,_n=0;"
        "while(_f&&_n<8){var _nm=(_f.type&&(_f.type.displayName||_f.type.name))||'';if(_nm)_p+=(_p?' < ':'')+_nm;_f=_f.return;_n++;}"
        "var _m='[DIAG] nettoyage non-fonction | composant='+_c+' | valeur='+_k+' | chaine='+_p;"
        "console.error(_m);"
        "if(typeof window!=='undefined'){(window.__vnLog=window.__vnLog||[]).push(_m);}"
        "}catch(_){}}try{%s()}catch(%s){%s(%s,%s,%s)}}"
        % (fn, fiber, inst, destroy, destroy, fiber, fiber, fiber, fiber, fiber, fiber,
           destroy, fiber, destroy, err, rappel, fiber, inst, err)
    )


def main():
    if len(sys.argv) < 2:
        print("usage : diag-patch-bundle-v2.py <répertoire dist>")
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
    ok = any("[DIAG] nettoyage non-fonction" in c.read_text(encoding="utf-8", errors="replace")
             for c in cibles)
    print("vérification :", "accroche présente" if ok else "ABSENTE")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
