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

private val Orange  = Color(0xFFFF6600)
private val DarkBg  = Color(0xDD0A0A0A)
private val DarkCard = Color(0xEE111111)
private val OrangeDim = Color(0x66FF6600)
private val OrangeGlow = Color(0x22FF6600)
private val GrayText = Color(0xFFAAAAAA)
private val GreenVPS = Color(0xFF00FF88)
private val RedBad  = Color(0xFFFF3333)

@Composable
fun VelohNavArTheme(content: @Composable () -> Unit) =
    MaterialTheme(colorScheme = darkColorScheme(primary = Orange, background = Color.Black, surface = DarkCard), content = content)

@Composable
fun NavigationHud(state: NavState, onClose: () -> Unit) {
    Box(Modifier.fillMaxSize()) {
        TopBar(state, onClose, Modifier.align(Alignment.TopStart))
        state.vpsAccuracy?.let { VpsBadge(it, Modifier.align(Alignment.TopEnd).padding(top=72.dp, end=12.dp)) }
        AnimatedVisibility(visible = state.status in listOf(NavStatus.LOCALIZING, NavStatus.ROUTING, NavStatus.LOCATING),
            enter=fadeIn(), exit=fadeOut(), modifier=Modifier.align(Alignment.Center)) {
            LocalizingOverlay(state.status)
        }
        AnimatedVisibility(visible = state.status == NavStatus.NAVIGATING && state.currentStep != null,
            enter=slideInVertically { it/2 }+fadeIn(), exit=slideOutVertically { it/2 }+fadeOut(),
            modifier=Modifier.align(Alignment.BottomCenter).padding(bottom=24.dp)) {
            state.currentStep?.let { InstructionPanel(it, state.distanceToNextTurnMeters) }
        }
        AnimatedVisibility(visible=state.status==NavStatus.ARRIVED, enter=scaleIn()+fadeIn(), modifier=Modifier.align(Alignment.Center)) {
            ArrivedCard(state.destName, onClose)
        }
        AnimatedVisibility(visible=state.status==NavStatus.ERROR, modifier=Modifier.align(Alignment.Center)) {
            ErrorCard(state.errorMessage ?: "Erreur", onClose)
        }
    }
}

@Composable
private fun TopBar(state: NavState, onClose: () -> Unit, modifier: Modifier) {
    Row(modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(DarkBg, Color.Transparent))).padding(8.dp), Alignment.CenterVertically) {
        IconButton(onClick=onClose, modifier=Modifier.size(40.dp).background(DarkCard,CircleShape).border(1.dp,OrangeDim,CircleShape)) {
            Icon(Icons.Filled.Close, null, tint=Orange)
        }
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            Text(state.destName, color=Orange, fontSize=15.sp, fontWeight=FontWeight.ExtraBold, fontFamily=FontFamily.Monospace, maxLines=1, overflow=TextOverflow.Ellipsis)
            if (state.totalRemainingMeters > 0)
                Text("${RouteManager.formatDistance(state.totalRemainingMeters)}  ·  ${RouteManager.formatDuration(state.etaSeconds)}", color=GrayText, fontSize=12.sp)
        }
        if (state.totalSteps > 0 && state.status == NavStatus.NAVIGATING)
            Box(Modifier.background(OrangeGlow,RoundedCornerShape(8.dp)).border(1.dp,OrangeDim,RoundedCornerShape(8.dp)).padding(horizontal=8.dp,vertical=4.dp)) {
                Text("${state.stepIndex+1}/${state.totalSteps}", color=Orange, fontSize=12.sp, fontFamily=FontFamily.Monospace, fontWeight=FontWeight.Bold)
            }
    }
}

@Composable
private fun InstructionPanel(step: NavigationStep, dist: Double) {
    Box(Modifier.fillMaxWidth().padding(horizontal=16.dp)
        .background(DarkCard, RoundedCornerShape(16.dp))
        .border(1.dp, Brush.horizontalGradient(listOf(Orange, OrangeDim, Color.Transparent)), RoundedCornerShape(16.dp))
        .padding(16.dp)) {
        Row(verticalAlignment=Alignment.CenterVertically) {
            Box(Modifier.size(56.dp).background(OrangeGlow,CircleShape).border(2.dp,Orange,CircleShape), Alignment.Center) {
                Icon(maneuverIcon(step.maneuver), null, tint=Orange, modifier=Modifier.size(28.dp))
            }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(RouteManager.formatDistance(dist.toInt()), color=Orange, fontSize=32.sp, fontWeight=FontWeight.ExtraBold, fontFamily=FontFamily.Monospace)
                Text(step.instruction, color=Color.White, fontSize=14.sp, maxLines=2)
                if (step.streetName.isNotEmpty())
                    Text(step.streetName, color=GrayText, fontSize=12.sp, maxLines=1, overflow=TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun VpsBadge(acc: VpsAccuracy, modifier: Modifier) {
    val c = when { acc.horizontalMeters < 2 -> GreenVPS; acc.horizontalMeters < 5 -> Orange; else -> RedBad }
    Box(modifier.background(DarkCard,RoundedCornerShape(6.dp)).border(1.dp,c.copy(.4f),RoundedCornerShape(6.dp)).padding(horizontal=7.dp,vertical=3.dp)) {
        Text("VPS ${acc.label}", color=c, fontSize=10.sp, fontFamily=FontFamily.Monospace, fontWeight=FontWeight.Bold)
    }
}

@Composable
private fun LocalizingOverlay(status: NavStatus) {
    val label = when(status) { NavStatus.LOCATING -> "GPS…"; NavStatus.ROUTING -> "Calcul itinéraire…"; else -> "Localisation VPS…" }
    val inf = rememberInfiniteTransition(label="p")
    val a by inf.animateFloat(0.4f,1f, infiniteRepeatable(tween(800),RepeatMode.Reverse), label="a")
    Column(Modifier.background(DarkCard,RoundedCornerShape(20.dp)).border(1.dp,OrangeDim,RoundedCornerShape(20.dp)).padding(32.dp), Alignment.CenterHorizontally) {
        CircularProgressIndicator(color=Orange, modifier=Modifier.size(44.dp).alpha(a), strokeWidth=3.dp)
        Spacer(Modifier.height(14.dp))
        Text(label, color=Orange, fontWeight=FontWeight.Bold, fontFamily=FontFamily.Monospace)
        if (status == NavStatus.LOCALIZING) { Spacer(Modifier.height(4.dp)); Text("Pointez vers les bâtiments", color=GrayText, fontSize=13.sp, textAlign=TextAlign.Center) }
    }
}

@Composable
private fun ArrivedCard(dest: String, onClose: () -> Unit) {
    Column(Modifier.background(DarkCard,RoundedCornerShape(24.dp)).border(2.dp,Orange,RoundedCornerShape(24.dp)).padding(horizontal=32.dp,vertical=28.dp), Alignment.CenterHorizontally) {
        Text("🎯", fontSize=52.sp); Spacer(Modifier.height(8.dp))
        Text("ARRIVÉ", color=Orange, fontWeight=FontWeight.ExtraBold, fontFamily=FontFamily.Monospace, fontSize=26.sp, letterSpacing=6.sp)
        Text(dest, color=Color.White, fontSize=16.sp, textAlign=TextAlign.Center); Spacer(Modifier.height(20.dp))
        Button(onClick=onClose, colors=ButtonDefaults.buttonColors(containerColor=Orange), shape=RoundedCornerShape(10.dp)) {
            Text("TERMINER", color=Color.Black, fontWeight=FontWeight.ExtraBold, fontFamily=FontFamily.Monospace)
        }
    }
}

@Composable
private fun ErrorCard(msg: String, onClose: () -> Unit) {
    Column(Modifier.padding(24.dp).background(DarkCard,RoundedCornerShape(16.dp)).border(1.dp,RedBad,RoundedCornerShape(16.dp)).padding(24.dp), Alignment.CenterHorizontally) {
        Icon(Icons.Filled.Warning, null, tint=RedBad, modifier=Modifier.size(40.dp)); Spacer(Modifier.height(8.dp))
        Text("Erreur navigation", color=RedBad, fontWeight=FontWeight.Bold)
        Text(msg, color=GrayText, fontSize=13.sp, textAlign=TextAlign.Center); Spacer(Modifier.height(16.dp))
        OutlinedButton(onClick=onClose, border=androidx.compose.foundation.BorderStroke(1.dp,Orange)) { Text("Retour", color=Orange) }
    }
}

@Composable
private fun maneuverIcon(m: String?): ImageVector = when {
    m==null -> Icons.Filled.ArrowUpward
    m.contains("turn-left") -> Icons.Filled.TurnLeft
    m.contains("turn-right") -> Icons.Filled.TurnRight
    m.contains("slight-left") -> Icons.Filled.TurnSlightLeft
    m.contains("slight-right") -> Icons.Filled.TurnSlightRight
    m.contains("uturn") -> Icons.Filled.UTurnLeft
    m.contains("roundabout") -> Icons.Filled.RotateRight
    else -> Icons.Filled.ArrowUpward
}
