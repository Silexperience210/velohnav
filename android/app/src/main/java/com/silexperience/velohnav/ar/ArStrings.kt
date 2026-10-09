package com.silexperience.velohnav.ar

/**
 * Textes de l'activité AR native, dans la langue de l'interface web (fr/en),
 * transmise par l'intent (`lang`) — l'équivalent natif de t() (src/i18n.js).
 */
class ArStrings private constructor(private val en: Boolean) {

    val permissionsRequired get() =
        if (en) "Camera and location are required for AR" else "Caméra et localisation requises pour l'AR"
    val arcoreMissing get() =
        if (en) "ARCore (Google Play Services for AR) is required for AR navigation"
        else "ARCore (Services Google Play pour la RA) est requis pour la navigation AR"
    fun arcoreUnsupported(detail: String) =
        if (en) "ARCore not supported on this device ($detail)" else "ARCore non pris en charge par cet appareil ($detail)"
    fun sessionFailed(detail: String) =
        if (en) "ARCore unavailable: $detail" else "ARCore indisponible : $detail"

    // ── Chargement / ancrage ─────────────────────────────────────────
    val statusLocating get() = "GPS…"
    val statusRouting get() = if (en) "Computing route…" else "Calcul itinéraire…"
    val statusAnchoring get() = if (en) "Anchoring to the ground…" else "Ancrage au sol…"
    val aimFloor get() = if (en) "Point at the ground one or two steps ahead" else "Visez le sol à un ou deux pas devant vous"
    val aimFloorWhy get() = if (en) "The route will start at your feet." else "Le tracé partira de vos pieds."
    val compassUnsteady get() = if (en) "Hold the phone still for a second" else "Tenez le téléphone immobile une seconde"
    fun accuracy(m: Double) = if (en) "Accuracy: ±${"%.1f".format(m)}m" else "Précision : ±${"%.1f".format(m)}m"
    fun bestAccuracy(m: Double) = if (en) "Best: ±${"%.1f".format(m)}m" else "Meilleure : ±${"%.1f".format(m)}m"
    val actionGpsOnly get() = if (en) "Switch to GPS mode" else "Passer en mode GPS"
    val actionRealign get() = if (en) "Realign" else "Recaler"

    // ── Badges ───────────────────────────────────────────────────────
    val groundBadge get() = if (en) "GROUND AR" else "AR SOL"
    val gpsBadge get() = if (en) "GPS MODE · LIMITED AR" else "MODE GPS · AR LIMITÉE"

    // ── Encart « AR ancrée au sol » : un mode à part entière ──────────
    val localTitle get() = if (en) "GROUND-ANCHORED AR" else "AR ANCRÉE AU SOL"
    val localBody get() =
        if (en) "The route starts at your feet and stays on the road thanks to the phone's motion tracking. Works offline, with no account or key."
        else "Le tracé part de vos pieds et reste posé sur la chaussée grâce au suivi du téléphone. Fonctionne hors ligne, sans compte ni clé."
    val floorEstimatedNote get() =
        if (en) "Ground not detected: height estimated. Point at the road, then « Realign » for more precision."
        else "Sol non détecté : hauteur estimée. Visez la chaussée puis « Recaler » pour plus de précision."

    /** Localisation Google : un bonus. Null quand il n'y a rien d'utile à dire (pas de clé = choix normal). */
    fun geoBonusNote(reason: FallbackReason?): String? = when (reason) {
        FallbackReason.NOT_AUTHORIZED ->
            if (en) "Google localisation (bonus): key refused — admin: see docs/ARCORE.md."
            else "Localisation Google (bonus) : clé refusée — administrateur : voir docs/ARCORE.md."
        FallbackReason.APK_TOO_OLD ->
            if (en) "Google localisation (bonus): update Google Play Services for AR."
            else "Localisation Google (bonus) : mettez à jour les Services Google Play pour la RA."
        FallbackReason.QUOTA ->
            if (en) "Google localisation (bonus): project quota used up."
            else "Localisation Google (bonus) : quota du projet épuisé."
        else -> null
    }

    // ── Encart « AR au sol indisponible » (GPS seul) ──────────────────
    val fallbackTitle get() = if (en) "GROUND AR UNAVAILABLE" else "AR AU SOL INDISPONIBLE"
    val fallbackGpsActive get() = if (en) "GPS guidance is active." else "Le guidage GPS est actif."
    val actionWebAr get() = if (en) "Compass AR view" else "Vue AR boussole"
    val actionDismiss get() = if (en) "Got it" else "Compris"

    /** Cause + quoi faire, en deux phrases au plus. Null : pas d'encart (choix de l'utilisateur). */
    fun fallbackBody(reason: FallbackReason?): String? = when (reason) {
        FallbackReason.NO_FRAMES ->
            if (en) "ARCore delivers no camera image (camera busy or sensor unavailable)."
            else "ARCore ne reçoit aucune image de la caméra (caméra occupée ou capteur indisponible)."
        FallbackReason.NO_TRACKING ->
            if (en) "ARCore cannot track the scene (too dark, or camera covered?)."
            else "ARCore n'arrive pas à suivre la scène (trop sombre, ou caméra masquée ?)."
        FallbackReason.NO_COMPASS ->
            if (en) "No compass available: the route cannot be oriented."
            else "Aucune boussole disponible : impossible d'orienter le tracé."
        else -> null
    }

    // ── Fin de parcours / erreur ─────────────────────────────────────
    val arrived get() = if (en) "ARRIVED" else "ARRIVÉ"
    val finish get() = if (en) "FINISH" else "TERMINER"
    val errorTitle get() = if (en) "Navigation error" else "Erreur navigation"
    val errorUnknown get() = if (en) "Unknown error" else "Erreur inconnue"
    val back get() = if (en) "Back" else "Retour"

    companion object {
        private val FR = ArStrings(false)
        private val EN = ArStrings(true)
        fun of(lang: String?): ArStrings = if (lang?.startsWith("en") == true) EN else FR
    }
}
