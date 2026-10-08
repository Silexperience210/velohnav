#!/usr/bin/env python3
"""Instrumente le bundle construit pour NOMMER le composant dont l'effet renvoie
une valeur non-fonction.

Pourquoi c'est nécessaire : React appelle la valeur de retour d'un useEffect comme
fonction de nettoyage et ne vérifie pas son type (vérifié dans le bundle de
développement : `function ef(e,t,n){try{n()}catch(a){vt(e,t,a)}}`). Aucun
avertissement n'est donc émis en version de développement — l'instrument précédent
ne pouvait pas parler.

On accroche cette fonction dans le bundle final : si la valeur appelée n'est pas une
fonction, on journalise le composant concerné avant que React ne lance l'erreur.
La sortie passe par console.error, donc elle apparaît à la fois dans logcat (Android)
et dans l'écran d'erreur de l'application.

Usage : python3 patch-bundle-diagnostic.py <répertoire dist>
"""
import pathlib
import re
import sys

# La fonction telle qu'elle apparaît dans le bundle de développement (non minifié).
ORIGINE = "function ef(e,t,n){try{n()}catch(a){vt(e,t,a)}}"

REMPLACEMENT = (
    "function ef(e,t,n){"
    "if(typeof n!=='function'){"
    "try{"
    "var _c=(e&&e.type&&(e.type.displayName||e.type.name))||(e&&e.elementType&&(e.elementType.name||e.elementType.displayName))||'composant inconnu';"
    "var _k=Object.prototype.toString.call(n);"
    "var _p='';"
    "for(var _f=e;_f&&_p.split(' < ').length<8;_f=_f.return){"
    "var _nm=(_f.type&&(_f.type.displayName||_f.type.name))||(_f.elementType&&_f.elementType.name)||'';"
    "if(_nm)_p+=_nm+' < ';}"
    "console.error('[DIAG] nettoyage non-fonction | composant='+_c+' | valeur='+_k+' | chaine='+_p);"
    "if(typeof window!=='undefined'){(window.__vnLog=window.__vnLog||[]).push('[DIAG] nettoyage non-fonction | composant='+_c+' | valeur='+_k+' | chaine='+_p);}"
    "}catch(_){} }"
    "try{n()}catch(a){vt(e,t,a)}}"
)


def main():
    if len(sys.argv) < 2:
        print("usage : patch-bundle-diagnostic.py <répertoire dist>"); return 1
    dist = pathlib.Path(sys.argv[1])
    cibles = sorted(dist.glob("assets/index-*.js"))
    if not cibles:
        print("aucun bundle index-*.js trouvé dans", dist); return 1
    total = 0
    for f in cibles:
        s = f.read_text(encoding="utf-8", errors="replace")
        n = s.count(ORIGINE)
        if n:
            f.write_text(s.replace(ORIGINE, REMPLACEMENT), encoding="utf-8")
            print(f"  {f.name} : {n} accroche(s) posée(s)")
            total += n
        else:
            print(f"  {f.name} : fonction React non trouvée (bundle minifié ?) — ignoré")
    if not total:
        print("ÉCHEC : aucune accroche posée, l'instrument serait muet")
        return 1
    # Vérification : la chaîne caractéristique doit être présente
    ok = any("[DIAG] nettoyage non-fonction" in f.read_text(encoding="utf-8", errors="replace")
             for f in cibles)
    print("vérification :", "accroche bien présente dans le bundle" if ok else "ABSENTE")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
