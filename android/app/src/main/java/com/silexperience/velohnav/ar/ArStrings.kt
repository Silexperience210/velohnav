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

    // ── Encart « AR précise indisponible » (bascule GPS sur erreur ARCore) ──
    val fallbackTitle get() = if (en) "PRECISE AR UNAVAILABLE" else "AR PRÉCISE INDISPONIBLE"
    val fallbackGpsActive get() = if (en) "GPS guidance is active." else "Le guidage GPS est actif."
    val actionWebAr get() = if (en) "Compass AR view" else "Vue AR boussole"
    val actionDismiss get() = if (en) "Got it" else "Compris"

    /** Cause + quoi faire, en deux phrases au plus. Null : pas d'encart (lenteur ou choix). */
    fun fallbackBody(reason: FallbackReason?): String? = when (reason) {
        FallbackReason.NO_API_KEY ->
            if (en) "This build has no Google API key (MAPS_API_KEY), so ARCore cannot localise. Rebuild with the key — see docs/ARCORE.md."
            else "Cette version a été compilée sans clé Google (MAPS_API_KEY) : ARCore ne peut pas se localiser. Recompiler avec la clé — voir docs/ARCORE.md."
        FallbackReason.NOT_AUTHORIZED ->
            if (en) "Google refuses this app's key for the ARCore API. Admin: enable « ARCore API » and allow package com.silexperience.velohnav + the SHA-1 of the certificate that signed this APK."
            else "Google refuse la clé de l'application pour l'API ARCore. Administrateur : activer « ARCore API » et autoriser le paquet com.silexperience.velohnav + l'empreinte SHA-1 du certificat qui a signé cet APK."
        FallbackReason.APK_TOO_OLD ->
            if (en) "Google Play Services for AR is too old. Update it from the Play Store."
            else "Les Services Google Play pour la RA sont trop anciens. Mettez-les à jour depuis le Play Store."
        FallbackReason.QUOTA ->
            if (en) "The ARCore Geospatial quota of the Google Cloud project is used up. Try again later."
            else "Le quota ARCore Geospatial du projet Google Cloud est épuisé. Réessayez plus tard."
        FallbackReason.NO_FRAMES ->
            if (en) "ARCore delivers no camera image (camera busy or sensor unavailable)."
            else "ARCore ne reçoit aucune image de la caméra (caméra occupée ou capteur indisponible)."
        FallbackReason.TIMEOUT, FallbackReason.MANUAL, null -> null
    }

    companion object {
        private val FR = ArStrings(false)
        private val EN = ArStrings(true)
        fun of(lang: String?): ArStrings = if (lang?.startsWith("en") == true) EN else FR
    }
}
