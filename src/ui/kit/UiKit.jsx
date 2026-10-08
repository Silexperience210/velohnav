// ── UiKit — galerie du design system (chunk séparé, ouvert via ?kit[=base|map|ar]) ──
// Sert aux captures de contrôle et à la revue visuelle : aucune logique métier ici,
// uniquement les composants de src/ui/ alimentés par des données d'exemple.
import { useState } from "react";
import { Button, IconButton, Chip, SegmentedControl, Badge, Card, Stat, Skeleton, EmptyState,
         Switch, Field, Input, ProgressBar, StatusDot, Section, Row, Meter, Spinner } from "../primitives.jsx";
import { Icon, ICON_NAMES, LogoMark } from "../icons.jsx";
import { MapSearchBar, MapFilterBar, NetworkSummary, MapLegend, RecenterButton, StationMarker, StationSheet } from "../map.jsx";
import { ArHud } from "../arHud.jsx";
import { LightningBolt, SatsReward } from "../Lightning.jsx";
import { AppHeader, TabBar, OfflineStrip } from "../shell.jsx";

const STATIONS = [
  { id: 1, name: "LEON XIII",        lat: 49.598, lng: 6.137, bikes: 13, elec: 13, docks: 7,  cap: 20, dist: 118,  updatedAt: Date.now() - 40_000 },
  { id: 2, name: "GARE CENTRALE",    lat: 49.600, lng: 6.134, bikes: 2,  elec: 2,  docks: 18, cap: 20, dist: 640,  updatedAt: Date.now() - 90_000 },
  { id: 3, name: "KIRCHBERG EUROPE", lat: 49.627, lng: 6.170, bikes: 0,  elec: 0,  docks: 25, cap: 25, dist: 3100, updatedAt: Date.now() - 20_000 },
  { id: 4, name: "ATELIER",          lat: 49.59,  lng: 6.10,  bikes: 4,  elec: 4,  docks: 0,  cap: 10, dist: 5200, status: "CLOSED" },
];

const wrap = { padding: "12px 12px 40px", display: "flex", flexDirection: "column", gap: 14 };

function Base() {
  const [seg, setSeg] = useState("cycling");
  const [sw, setSw] = useState(true);
  const [pressed, setPressed] = useState("all");
  return (
    <div style={wrap}>
      <Section title="Boutons">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Button variant="primary" icon="route">Y aller</Button>
          <Button variant="secondary" icon="play">Trajet</Button>
          <Button variant="tonal" icon="ar">AR</Button>
          <Button variant="danger" icon="stop" size="sm">Stop</Button>
          <Button variant="primary" loading>Chargement</Button>
          <IconButton icon="locate" label="Recentrer"/>
          <IconButton icon="refresh" label="Rafraîchir"/>
        </div>
      </Section>
      <Section title="Chips & segments">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {["all", "bikes", "docks", "elec"].map(k => (
            <Chip key={k} icon={k === "all" ? "layers" : k === "bikes" ? "bike" : k === "docks" ? "dock" : "bolt"}
                  count={{ all: 143, bikes: 124, docks: 136, elec: 124 }[k]} pressed={pressed === k} onClick={() => setPressed(k)}>
              {{ all: "Tout", bikes: "Vélos", docks: "Bornes", elec: "Élec" }[k]}
            </Chip>
          ))}
        </div>
        <SegmentedControl label="Mode" value={seg} onChange={setSeg}
          options={[{ value: "cycling", label: "Vélo", icon: "bike" }, { value: "walking", label: "À pied", icon: "walk" }]}/>
      </Section>
      <Section title="Badges & états">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <Badge tone="good">Dispo</Badge><Badge tone="warn">Faible</Badge><Badge tone="bad">Vide</Badge>
          <Badge tone="closed">Fermé</Badge><Badge tone="neutral" icon="info">Info</Badge>
          <StatusDot live/><StatusDot/><Spinner/>
        </div>
        <ProgressBar value={0.62} label="Modèle IA — 62 %"/>
        <ProgressBar indeterminate label="Recherche d'itinéraire"/>
      </Section>
      <Section title="Stats & cartes">
        <div className="vn-stgrid">
          <Stat size="lg" value={13} label="Vélos" icon="bike" color="#2ECC8F"/>
          <Stat size="lg" value={13} label="Élec" icon="bolt" color="var(--vn-elec)"/>
          <Stat size="lg" value={0} label="Méca"/>
          <Stat size="lg" value={7} label="Bornes" icon="dock"/>
        </div>
        <Card>
          <Row icon="bus" iconColor="#F2B33D" title="Bus 7 → Kirchberg" sub="Départ dans 4 min · quai B" right={<Badge tone="good">à l'heure</Badge>}/>
          <Row icon="tram" iconColor="#5DADE2" title="Tram T1 → Luxexpo" sub="Départ dans 9 min" right={<Badge tone="warn">+2 min</Badge>}/>
        </Card>
        <Meter label="13 élec · 0 méca · 7 bornes" segments={[
          { key: "e", value: 13, color: "var(--vn-elec)" }, { key: "m", value: 0, color: "#C9D1DC" },
          { key: "d", value: 7, color: "rgba(255,255,255,0.14)" }]}/>
      </Section>
      <Section title="Formulaires">
        <Field label="Adresse Lightning" hint="LNURL-pay · self-custodial">
          {a11y => <Input mono placeholder="toi@wallet.lu" {...a11y}/>}
        </Field>
        <Switch checked={sw} onChange={setSw} label="Audio 3D (HRTF)" id="kit-sw"/>
        <Skeleton h={44}/>
        <EmptyState icon="satellite" title="Aucun signal GPS" desc="Sors à l'air libre ou passe en mode GPS limité."
          action={<Button variant="secondary" icon="gps">Mode GPS</Button>}/>
      </Section>
      <Section title="Lightning">
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <LightningBolt size={48}/>
          <SatsReward amount={21} state="sent" detail="Trajet LEON XIII → GARE"/>
        </div>
      </Section>
      <Section title={`Icônes (${ICON_NAMES.length})`}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 10 }}>
          {ICON_NAMES.map(n => <div key={n} title={n} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, fontSize: 9, color: "var(--vn-text3)" }}>
            <Icon name={n} size={20}/>{n}</div>)}
        </div>
        <LogoMark/>
      </Section>
    </div>
  );
}

function MapKit() {
  const [q, setQ] = useState("");
  const [f, setF] = useState("all");
  const [sel, setSel] = useState(STATIONS[0]);
  const [mode, setMode] = useState("cycling");
  const totals = { stations: 143, bikes: 124, elec: 761, docks: 136, closed: 19 };
  return (
    <div style={wrap}>
      <MapSearchBar value={q} onChange={setQ} resultCount={q ? 3 : null}/>
      <MapFilterBar value={f} onChange={setF} counts={{ all: 143, bikes: 124, docks: 136, elec: 124 }}/>
      <NetworkSummary totals={totals} lastUpdate={Date.now() - 30_000}/>
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        {STATIONS.map(s => <StationMarker key={s.id} station={s} selected={sel?.id === s.id} onClick={() => setSel(s)}/>)}
        <RecenterButton onClick={() => {}} following/>
        <RecenterButton onClick={() => {}}/>
      </div>
      <MapLegend/>
      <StationSheet inline station={sel} mode={mode} onModeChange={setMode} onGo={() => {}} onAR={() => {}}
        onStartTrip={() => {}} prediction={9} externalHref="https://www.openstreetmap.org/"/>
    </div>
  );
}

function ArKit() {
  const [mm, setMm] = useState("bike");
  return (
    <div style={{ ...wrap, minHeight: 720, background: "linear-gradient(180deg,#1b1f26 0%,#0b0d10 100%)", position: "relative" }}>
      <ArHud
        step={{ modifier: "left", distanceToStep: 85, street: "Avenue de la Liberté", step: 3, steps: 9 }}
        stats={{ remainingM: 2340, baseMin: 11, windFactor: 1.12, climbFactor: 1.05 }}
        pos={{ mode: "vps", accuracy: 1.4, onSwitchToGps: () => {} }}
        wind={{ windKmh: 22, windDir: 240, bearing: 60 }}
        multimodal={{ value: mm, onChange: setMm, suggestion: { busLine: "7", busTime: "4 min", busDirection: "Kirchberg", pivotStation: { name: "GARE CENTRALE", docks: 18 }, distFromUser: 640, reason: "Pluie dans 10 min" }, onAccept: () => setMm("bus"), onDismiss: () => {} }}
        destination={{ name: "KIRCHBERG EUROPE", mode: "cycling" }}
        onStop={() => {}}/>
    </div>
  );
}

export default function UiKit({ view = "base" }) {
  const [tab, setTab] = useState(view);
  const tabs = [{ id: "base", label: "Base", icon: "layers" }, { id: "map", label: "Carte", icon: "map" }, { id: "ar", label: "AR", icon: "ar" }];
  return (
    <div className="vn-app">
      <AppHeader screen="map" pos={{ mode: "gps", accuracy: 4 }} data={{ apiLive: tab !== "base", isMock: false, offline: tab === "base", lastUpdate: Date.now() - 20_000 }} onRefresh={() => {}}/>
      {tab === "base" && <OfflineStrip lastUpdate={Date.now() - 600_000}/>}
      <main className="vn-main" style={{ overflow: "auto" }}>
        {tab === "base" && <Base/>}
        {tab === "map" && <MapKit/>}
        {tab === "ar" && <ArKit/>}
      </main>
      <TabBar tabs={tabs} value={tab} onChange={setTab}/>
    </div>
  );
}
