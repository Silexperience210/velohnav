package com.silexperience.velohnav.ar.ui

import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.silexperience.velohnav.ar.*

// Palette = design tokens du web (src/ui/tokens.js) — mêmes valeurs
private val Orange     = Color(0xFFF5820D)   // color.accent
private val DarkBg     = Color(0xDD07090B)   // color.bg
private val DarkCard   = Color(0xEE0D1014)   // color.surface1
private val OrangeDim  = Color(0x66F5820D)
private val OrangeGlow = Color(0x24F5820D)   // color.accentSoft (0.14)
private val GrayText   = Color(0xFFA9B1BD)   // color.text2 (avant #AAAAAA)
private val GreenOK    = Color(0xFF2ECC8F)   // color.good
private val WarnYellow = Color(0xFFF2B33D)   // color.warn (distinct de l'accent)
private val RedBad     = Color(0xFFF0524A)   // color.bad (avant #E03E3E)

@Composable
fun VelohNavArTheme(content: @Composable () -> Unit) =
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary    = Orange,
            background = Color.Black,
            surface    = DarkCard
        ),
        content = content
    )

@Composable
fun NavigationHud(
    state: NavState,
    strings: ArStrings = ArStrings.of("fr"),
    webGuidance: Boolean = false,
    onClose: () -> Unit,
    onFallbackToGps: () -> Unit = {},
    onRealign: () -> Unit = {}
) {
    Box(Modifier.fillMaxSize()) {

        // Barre supérieure
        TopBar(state, strings, onClose, onRealign, Modifier.align(Alignment.TopStart))

        // Encart « AR au sol indisponible » (GPS seul) : cause + quoi faire, sans
        // bloquer la nav GPS qui tourne déjà dessous. Fermable.
        val body = if (state.trackingMode == TrackingMode.GPS_FALLBACK) strings.fallbackBody(state.fallbackReason) else null
        var dismissed by remember(state.fallbackReason) { mutableStateOf(false) }
        AnimatedVisibility(
            visible = body != null && !dismissed && state.status == NavStatus.NAVIGATING,
            enter = fadeIn() + slideInVertically { -it / 3 },
            exit = fadeOut(),
            modifier = Modifier.align(Alignment.TopCenter).padding(top = 64.dp)
        ) {
            FallbackNotice(
                body = body ?: "",
                strings = strings,
                webGuidance = webGuidance,
                onWebAr = onClose,
                onDismiss = { dismissed = true }
            )
        }

        // Encart « AR ancrée au sol » : le mode principal, présenté comme tel (sans
        // clé Google, ce n'est pas un échec). Une fois par navigation, puis il s'efface.
        val showLocal = state.status == NavStatus.NAVIGATING && state.groundAnchored &&
                        state.trackingMode == TrackingMode.LOCAL
        var localSeen by remember { mutableStateOf(false) }
        LaunchedEffect(showLocal) {
            if (showLocal && !localSeen) { kotlinx.coroutines.delay(9_000); localSeen = true }
        }
        AnimatedVisibility(
            visible = showLocal && !localSeen,
            enter = fadeIn() + slideInVertically { -it / 3 },
            exit = fadeOut(),
            modifier = Modifier.align(Alignment.TopCenter).padding(top = 64.dp)
        ) {
            LocalModeNotice(
                strings = strings,
                note = listOfNotNull(
                    if (state.floorEstimated) strings.floorEstimatedNote else null,
                    strings.geoBonusNote(state.geoBonusOff)
                ),
                onDismiss = { localSeen = true }
            )
        }

        // Badge du mode : AR SOL, VPS ±x m, ou GPS
        if (state.status == NavStatus.NAVIGATING || state.vpsAccuracy != null) {
            ModeBadge(state, strings, Modifier
                .align(Alignment.TopEnd)
                .padding(top = 72.dp, end = 12.dp))
        }

        // Overlay chargement / ancrage au sol
        AnimatedVisibility(
            visible = state.status in listOf(
                NavStatus.LOCATING, NavStatus.ROUTING, NavStatus.LOCALIZING
            ),
            enter = fadeIn(), exit = fadeOut(),
            modifier = Modifier.align(Alignment.Center)
        ) {
            LocalizingOverlay(
                status          = state.status,
                strings         = strings,
                vpsAccuracy     = state.vpsAccuracy,
                bestAccuracy    = state.bestHorizontalAccuracy,
                compassUnsteady = state.compassUnsteady,
                onFallback      = onFallbackToGps
            )
        }

        // Recalage en cours pendant la nav : aide discrète, le tracé reste affiché
        AnimatedVisibility(
            visible = state.status == NavStatus.NAVIGATING && state.aimFloor,
            enter = fadeIn(), exit = fadeOut(),
            modifier = Modifier.align(Alignment.Center)
        ) {
            AimFloorChip(if (state.compassUnsteady) strings.compassUnsteady else strings.aimFloor)
        }

        // Panneau instruction navigation
        AnimatedVisibility(
            visible = state.status == NavStatus.NAVIGATING && state.currentStep != null,
            enter   = slideInVertically { it / 2 } + fadeIn(),
            exit    = slideOutVertically { it / 2 } + fadeOut(),
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 24.dp)
        ) {
            state.currentStep?.let {
                InstructionPanel(it, state.distanceToNextTurnMeters, state.trackingMode, strings)
            }
        }

        // Carte arrivée
        AnimatedVisibility(
            visible = state.status == NavStatus.ARRIVED,
            enter   = scaleIn() + fadeIn(),
            modifier = Modifier.align(Alignment.Center)
        ) { ArrivedCard(state.destName, strings, onClose) }

        // Carte erreur
        AnimatedVisibility(
            visible = state.status == NavStatus.ERROR,
            modifier = Modifier.align(Alignment.Center)
        ) { ErrorCard(state.errorMessage ?: strings.errorUnknown, strings, onClose) }
    }
}

// ── Barre supérieure ──────────────────────────────────────────────
@Composable
private fun TopBar(state: NavState, strings: ArStrings, onClose: () -> Unit, onRealign: () -> Unit, modifier: Modifier) {
    Row(
        modifier
            .fillMaxWidth()
            .background(Brush.verticalGradient(listOf(DarkBg, Color.Transparent)))
            .padding(8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        IconButton(
            onClick = onClose,
            modifier = Modifier
                .size(40.dp)
                .background(DarkCard, CircleShape)
                .border(1.dp, OrangeDim, CircleShape)
        ) { Icon(Icons.Filled.Close, null, tint = Orange) }

        Spacer(Modifier.width(8.dp))

        Column(Modifier.weight(1f)) {
            Text(
                state.destName,
                color = Orange, fontSize = 15.sp,
                fontWeight = FontWeight.ExtraBold,
                fontFamily = FontFamily.Monospace,
                maxLines = 1, overflow = TextOverflow.Ellipsis
            )
            if (state.totalRemainingMeters > 0)
                Text(
                    "${RouteManager.formatDistance(state.totalRemainingMeters)}  ·  ${RouteManager.formatDuration(state.etaSeconds)}",
                    color = GrayText, fontSize = 12.sp
                )
        }

        // Recaler : nouvel ancrage au sol (si le tracé a dérivé ou a été posé de travers)
        if (state.status == NavStatus.NAVIGATING && state.trackingMode != TrackingMode.GPS_FALLBACK) {
            IconButton(
                onClick = onRealign,
                modifier = Modifier
                    .size(40.dp)
                    .background(DarkCard, CircleShape)
                    .border(1.dp, OrangeDim, CircleShape)
            ) { Icon(Icons.Filled.CenterFocusStrong, strings.actionRealign, tint = Orange) }
            Spacer(Modifier.width(8.dp))
        }

        if (state.totalSteps > 0 && state.status == NavStatus.NAVIGATING)
            Box(
                Modifier
                    .background(OrangeGlow, RoundedCornerShape(8.dp))
                    .border(1.dp, OrangeDim, RoundedCornerShape(8.dp))
                    .padding(horizontal = 8.dp, vertical = 4.dp)
            ) {
                Text(
                    "${state.stepIndex + 1}/${state.totalSteps}",
                    color = Orange, fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold
                )
            }
    }
}

// ── Encart bascule GPS sur erreur ARCore ──────────────────────────
@Composable
private fun FallbackNotice(
    body: String,
    strings: ArStrings,
    webGuidance: Boolean,
    onWebAr: () -> Unit,
    onDismiss: () -> Unit
) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .background(DarkCard, RoundedCornerShape(16.dp))
            .border(1.dp, WarnYellow.copy(alpha = 0.6f), RoundedCornerShape(16.dp))
            .padding(14.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.Warning, null, tint = WarnYellow, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text(
                strings.fallbackTitle,
                color = WarnYellow, fontSize = 11.sp, letterSpacing = 1.sp,
                fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold
            )
        }
        Spacer(Modifier.height(6.dp))
        Text("$body ${strings.fallbackGpsActive}", color = Color.White, fontSize = 12.sp, lineHeight = 16.sp)
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (webGuidance) {
                OutlinedButton(
                    onClick = onWebAr,
                    border = androidx.compose.foundation.BorderStroke(1.dp, Orange),
                    shape = RoundedCornerShape(8.dp)
                ) {
                    Text(strings.actionWebAr, color = Orange, fontSize = 12.sp,
                        fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
                }
            }
            TextButton(onClick = onDismiss) {
                Text(strings.actionDismiss, color = GrayText, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
            }
        }
    }
}

// ── Encart « AR ancrée au sol » ───────────────────────────────────
@Composable
private fun LocalModeNotice(strings: ArStrings, note: List<String>, onDismiss: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .background(DarkCard, RoundedCornerShape(16.dp))
            .border(1.dp, GreenOK.copy(alpha = 0.6f), RoundedCornerShape(16.dp))
            .padding(14.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.CheckCircle, null, tint = GreenOK, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text(
                strings.localTitle,
                color = GreenOK, fontSize = 11.sp, letterSpacing = 1.sp,
                fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold
            )
        }
        Spacer(Modifier.height(6.dp))
        Text(strings.localBody, color = Color.White, fontSize = 12.sp, lineHeight = 16.sp)
        note.forEach {
            Spacer(Modifier.height(4.dp))
            Text(it, color = GrayText, fontSize = 11.sp, lineHeight = 14.sp)
        }
        Spacer(Modifier.height(6.dp))
        TextButton(onClick = onDismiss) {
            Text(strings.actionDismiss, color = GrayText, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
        }
    }
}

@Composable
private fun AimFloorChip(text: String) {
    Row(
        Modifier
            .background(DarkCard, RoundedCornerShape(20.dp))
            .border(1.dp, OrangeDim, RoundedCornerShape(20.dp))
            .padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(Icons.Filled.CenterFocusStrong, null, tint = Orange, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(8.dp))
        Text(text, color = Color.White, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
    }
}

// ── Panneau instruction ───────────────────────────────────────────
@Composable
private fun InstructionPanel(step: NavigationStep, dist: Double, mode: TrackingMode, strings: ArStrings) {
    Box(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .background(DarkCard, RoundedCornerShape(16.dp))
            .border(
                1.dp,
                Brush.horizontalGradient(listOf(Orange, OrangeDim, Color.Transparent)),
                RoundedCornerShape(16.dp)
            )
            .padding(16.dp)
    ) {
        Column {
            // Badge "Mode GPS" — visible uniquement en fallback
            if (mode == TrackingMode.GPS_FALLBACK) {
                Box(
                    Modifier
                        .background(OrangeGlow, RoundedCornerShape(4.dp))
                        .border(1.dp, OrangeDim, RoundedCornerShape(4.dp))
                        .padding(horizontal = 6.dp, vertical = 2.dp)
                ) {
                    Text(
                        strings.gpsBadge,
                        color = Orange, fontSize = 9.sp,
                        fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold,
                        letterSpacing = 1.sp
                    )
                }
                Spacer(Modifier.height(8.dp))
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .size(56.dp)
                        .background(OrangeGlow, CircleShape)
                        .border(2.dp, Orange, CircleShape),
                    Alignment.Center
                ) { Icon(maneuverIcon(step.maneuver), null, tint = Orange, modifier = Modifier.size(28.dp)) }

                Spacer(Modifier.width(14.dp))

                Column(Modifier.weight(1f)) {
                    Text(
                        RouteManager.formatDistance(dist.toInt()),
                        color = Orange, fontSize = 32.sp,
                        fontWeight = FontWeight.ExtraBold,
                        fontFamily = FontFamily.Monospace
                    )
                    Text(step.instruction, color = Color.White, fontSize = 14.sp, maxLines = 2)
                    if (step.streetName.isNotEmpty())
                        Text(
                            step.streetName, color = GrayText, fontSize = 12.sp,
                            maxLines = 1, overflow = TextOverflow.Ellipsis
                        )
                }
            }
        }
    }
}

// ── Badge du mode ─────────────────────────────────────────────────
@Composable
private fun ModeBadge(state: NavState, strings: ArStrings, modifier: Modifier) {
    val acc = state.vpsAccuracy
    val (label, c) = when {
        state.trackingMode == TrackingMode.GPS_FALLBACK -> Pair("GPS", Orange)
        state.trackingMode == TrackingMode.VPS && acc != null ->
            // Mêmes seuils que le web (src/ui/format.js, positioning) : ≤ 1,5 m bon, ≤ 5 m moyen
            Pair("VPS ${acc.label}", when {
                acc.horizontalMeters <= 1.5 -> GreenOK
                acc.horizontalMeters <= 5   -> WarnYellow
                else                        -> RedBad
            })
        // AR au sol : vert quand le sol a été détecté, orange s'il est estimé
        else -> Pair(strings.groundBadge, if (state.floorEstimated) Orange else GreenOK)
    }
    Box(
        modifier
            .background(DarkCard, RoundedCornerShape(6.dp))
            .border(1.dp, c.copy(alpha = 0.5f), RoundedCornerShape(6.dp))
            .padding(horizontal = 7.dp, vertical = 3.dp)
    ) {
        Text(label, color = c, fontSize = 10.sp,
            fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
    }
}

// ── Overlay chargement / ancrage au sol ───────────────────────────
@Composable
private fun LocalizingOverlay(
    status: NavStatus,
    strings: ArStrings,
    vpsAccuracy: VpsAccuracy? = null,
    bestAccuracy: Double = Double.MAX_VALUE,
    compassUnsteady: Boolean = false,
    onFallback: () -> Unit = {}
) {
    val label = when (status) {
        NavStatus.LOCATING    -> strings.statusLocating
        NavStatus.ROUTING     -> strings.statusRouting
        else                   -> strings.statusAnchoring
    }
    val inf = rememberInfiniteTransition(label = "pulse")
    val a by inf.animateFloat(
        0.4f, 1f,
        infiniteRepeatable(tween(800), RepeatMode.Reverse),
        label = "alpha"
    )
    Column(
        Modifier
            .background(DarkCard, RoundedCornerShape(20.dp))
            .border(1.dp, OrangeDim, RoundedCornerShape(20.dp))
            .padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        CircularProgressIndicator(
            color = Orange,
            modifier = Modifier.size(44.dp).alpha(a),
            strokeWidth = 3.dp
        )
        Spacer(Modifier.height(14.dp))
        Text(label, color = Orange, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
        if (status == NavStatus.LOCALIZING) {
            Spacer(Modifier.height(4.dp))
            Text(if (compassUnsteady) strings.compassUnsteady else strings.aimFloor,
                color = Color.White, fontSize = 13.sp, textAlign = TextAlign.Center)
            Spacer(Modifier.height(4.dp))
            Text(strings.aimFloorWhy, color = GrayText, fontSize = 11.sp, textAlign = TextAlign.Center)

            // Localisation Google (bonus) : affichée seulement si elle progresse
            val currentAcc = vpsAccuracy?.horizontalMeters
            if (currentAcc != null) {
                Spacer(Modifier.height(8.dp))
                Text(
                    strings.accuracy(currentAcc),
                    color = if (currentAcc < 8) GreenOK else if (currentAcc < 15) Orange else RedBad,
                    fontSize = 12.sp, fontFamily = FontFamily.Monospace
                )
                if (bestAccuracy < Double.MAX_VALUE && bestAccuracy < currentAcc) {
                    Text(
                        strings.bestAccuracy(bestAccuracy),
                        color = GrayText, fontSize = 10.sp, fontFamily = FontFamily.Monospace
                    )
                }
            }

            // Bouton manuel « passer en GPS » : toujours possible
            Spacer(Modifier.height(12.dp))
            OutlinedButton(
                onClick = onFallback,
                border = androidx.compose.foundation.BorderStroke(1.dp, Orange),
                shape = RoundedCornerShape(8.dp)
            ) {
                Text(
                    strings.actionGpsOnly,
                    color = Orange, fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold
                )
            }
        }
    }
}

// ── Carte arrivée ─────────────────────────────────────────────────
@Composable
private fun ArrivedCard(dest: String, strings: ArStrings, onClose: () -> Unit) {
    Column(
        Modifier
            .background(DarkCard, RoundedCornerShape(24.dp))
            .border(2.dp, Orange, RoundedCornerShape(24.dp))
            .padding(horizontal = 32.dp, vertical = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text("🎯", fontSize = 52.sp)
        Spacer(Modifier.height(8.dp))
        Text(strings.arrived, color = Orange, fontWeight = FontWeight.ExtraBold,
            fontFamily = FontFamily.Monospace, fontSize = 26.sp, letterSpacing = 6.sp)
        Text(dest, color = Color.White, fontSize = 16.sp, textAlign = TextAlign.Center)
        Spacer(Modifier.height(20.dp))
        Button(
            onClick = onClose,
            colors = ButtonDefaults.buttonColors(containerColor = Orange),
            shape = RoundedCornerShape(10.dp)
        ) {
            Text(strings.finish, color = Color.Black,
                fontWeight = FontWeight.ExtraBold, fontFamily = FontFamily.Monospace)
        }
    }
}

// ── Carte erreur ──────────────────────────────────────────────────
@Composable
private fun ErrorCard(msg: String, strings: ArStrings, onClose: () -> Unit) {
    Column(
        Modifier
            .padding(24.dp)
            .background(DarkCard, RoundedCornerShape(16.dp))
            .border(1.dp, RedBad, RoundedCornerShape(16.dp))
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Icon(Icons.Filled.Warning, null, tint = RedBad, modifier = Modifier.size(40.dp))
        Spacer(Modifier.height(8.dp))
        Text(strings.errorTitle, color = RedBad, fontWeight = FontWeight.Bold)
        Text(msg, color = GrayText, fontSize = 13.sp, textAlign = TextAlign.Center)
        Spacer(Modifier.height(16.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = onClose,
                border = androidx.compose.foundation.BorderStroke(1.dp, Orange)
            ) { Text(strings.back, color = Orange) }
        }
    }
}

// ── Icône de manœuvre ─────────────────────────────────────────────
// Ordre : du plus spécifique au plus général. Avant, `contains("left")` passait
// en premier : « slight-left », « uturn-left » et « roundabout-left » tombaient
// tous sur TurnLeft (branches suivantes mortes), et « slight left » (BRouter,
// avec une espace) n'était jamais reconnu.
@Composable
private fun maneuverIcon(m: String?): ImageVector {
    val k = m?.replace('-', ' ') ?: return Icons.Filled.ArrowUpward
    return when {
        k.contains("uturn")                               -> Icons.Filled.UTurnLeft
        k.contains("roundabout")                          -> Icons.Filled.RotateRight
        k.contains("slight left") || k.contains("keep left")   -> Icons.Filled.TurnSlightLeft
        k.contains("slight right") || k.contains("keep right") -> Icons.Filled.TurnSlightRight
        k.contains("left")                                -> Icons.Filled.TurnLeft
        k.contains("right")                               -> Icons.Filled.TurnRight
        k == "arrive"                                     -> Icons.Filled.Flag
        else                                              -> Icons.Filled.ArrowUpward
    }
}
