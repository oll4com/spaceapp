import { useEffect, useRef, useState, type PointerEvent } from "react";
import { AsteroidsEngine, WEAPONS, emptyControls, type Controls, type WeaponId } from "./engine.js";
import { ArcadeAudio } from "./audio.js";
import { createRenderer } from "./render.js";
import { emptyDirector, updateDirector } from "./director.js";
import { fetchAIModifier } from "./ai-director.js";
import { DIFFICULTY_ORDER, difficultyById, isInfernoFire, readDifficulty, stepDifficulty, writeDifficulty, type DifficultyId } from "./difficulty.js";
import { getSectorDef } from "./sectors.js";
import { Pause, Play, Music2, VolumeX } from "../ui-theme/app-icons.js";
import { FlightDemo } from "./FlightDemo.js";
import { SpaceappMark } from "./SpaceappMark.js";
import { observeArcadePalette } from "./theme.js";
import "./asteroids.css";

const BEST_KEY = "space.asteroids.best.v1";
const AI_KEY = "space.asteroids.ai.v1";
const PROGRESS_KEY = "space.asteroids.progress.v1";
const KEY_MAP: Record<string, keyof Controls> = { ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right", ArrowUp: "thrust", KeyW: "thrust", Space: "fire", ShiftLeft: "dash", ShiftRight: "dash", KeyE: "bomb", KeyQ: "swap" };
const WEAPON_KEYS: Record<string, WeaponId> = { Digit1: "blaster", Digit2: "spread", Digit3: "railgun", Digit4: "missiles", Digit5: "arc", Digit6: "orbitals" };
const readBest = () => { try { return Math.max(0, Number(localStorage.getItem(BEST_KEY)) || 0); } catch { return 0; } };
const readAI = (): "local" | "adaptive" => { try { return localStorage.getItem(AI_KEY) === "adaptive" ? "adaptive" : "local"; } catch { return "local"; } };
const readProgress = () => { try { return Math.max(1, Math.min(999, Number(localStorage.getItem(PROGRESS_KEY)) || 1)); } catch { return 1; } };
type Snapshot = { phase: AsteroidsEngine["phase"]; score: number; lives: number; sector: number; name: string; combo: number; multiplier: number; dash: number; rapid: number; shield: number; shieldLevel: number; banner: boolean; autoUpgrade: string; targets: number; thrustHint: boolean; weapon: string; weaponLevel: number; bombs: number; bossHp: number; taunt: string; ai: string; heat: number; unlocked: number; aiZone: string; aiSpawn: number; aiSpeed: number; aiFire: number; aiElite: number; aiDrops: number; aiEvent: string; aiThreat: number; aiTimer: number; aiLog: { t: number; text: string }[]; difficulty: DifficultyId; difficultyLabel: string; scoreMul: number; infernoFire: boolean };
const snapshot = (g: AsteroidsEngine, ai: string): Snapshot => {
  const boss = g.rocks.find(r => r.boss);
  return { phase: g.phase, score: g.score, lives: g.lives, sector: g.sector, name: g.sectorName, combo: g.combo, multiplier: g.multiplier, dash: Math.ceil(g.ship.dash), rapid: Math.ceil(g.rapid), shield: g.shield, shieldLevel: g.shieldLevel, banner: g.banner > 0, autoUpgrade: g.elapsed < g.autoUpgradeUntil ? g.autoUpgradeText : "", targets: g.rocks.length + g.enemies.length, thrustHint: g.sector === 1 && g.elapsed < 14 && g.manualThrustTime < .7, weapon: WEAPONS[g.weapon]!.name, weaponLevel: g.weaponLevels[g.weapon]!, bombs: g.bombs, bossHp: boss ? boss.hp : 0, taunt: g.taunt, ai, heat: Math.round(g.heat * 100), unlocked: g.unlocked.length, aiZone: g.aiZone, aiSpawn: g.spawnMul, aiSpeed: g.enemySpeedMul, aiFire: g.enemyFireMul, aiElite: g.eliteChance, aiDrops: g.pickupMul, aiEvent: g.llmEvent, aiThreat: g.llmThreat, aiTimer: Math.ceil(g.llmTimer), aiLog: [...g.directives].reverse(), difficulty: g.difficultyId, difficultyLabel: g.difficulty.label, scoreMul: g.difficulty.scoreMul, infernoFire: g.infernoFire };
};

export default function SpaceappAsteroids({ onClose }: { onClose: () => void }) {
  const root = useRef<HTMLElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const runtime = useRef<{ game: AsteroidsEngine; render: () => void; schedule: () => void; stop: () => void; audio: ArcadeAudio } | null>(null);
  const controls = useRef(emptyControls());
  const keys = useRef(new Set<string>()), pointers = useRef(new Map<number, keyof Controls>());
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const pausedRef = useRef(false), musicRef = useRef(false);
  const director = useRef(emptyDirector());
  const aiRef = useRef<"local" | "adaptive">(readAI());
  const lastDirector = useRef(0);
  const baseStats = useRef({ fired: 0, deaths: 0 });
  const [hud, setHud] = useState(() => snapshot(new AsteroidsEngine(800, 600), readAI()));
  const [paused, setPaused] = useState(false), [music, setMusic] = useState(false), [audioUnavailable, setAudioUnavailable] = useState(false);
  const [best, setBest] = useState(readBest), [unsupported, setUnsupported] = useState(false);
  const [aiMode, setAiMode] = useState<"local" | "adaptive">(readAI);
  const [difficultyId, setDifficultyId] = useState<DifficultyId>(readDifficulty);
  const [difficultyNotice, setDifficultyNotice] = useState("");
  const [progress, setProgress] = useState(readProgress);
  const difficultyRef = useRef(difficultyId);
  difficultyRef.current = difficultyId;
  const noticeTimer = useRef(0);
  const bestRef = useRef(best);
  const progressRef = useRef(progress);
  aiRef.current = aiMode;
  const clearInput = () => { keys.current.clear(); pointers.current.clear(); controls.current = emptyControls(); };
  const syncInput = () => {
    const next = emptyControls();
    for (const key of keys.current) { const action = KEY_MAP[key]; if (action) next[action] = true; }
    for (const action of pointers.current.values()) next[action] = true;
    // Momentary actions stay latched for one step.
    next.bomb = controls.current.bomb; next.swap = controls.current.swap;
    controls.current = next;
  };
  const focusGame = () => root.current?.focus({ preventScroll: true });
  const setPause = (next: boolean) => {
    pausedRef.current = next; setPaused(next); clearInput();
    if (next) { runtime.current?.stop(); runtime.current?.audio.pause(); }
    else {
      if (musicRef.current) void runtime.current?.audio.enable();
      runtime.current?.schedule(); focusGame();
    }
  };
  const toggleAI = () => {
    setAiMode(prev => {
      const next = prev === "local" ? "adaptive" : "local";
      try { localStorage.setItem(AI_KEY, next); } catch { /* Storage is optional. */ }
      runtime.current?.game.setInfernoFire(isInfernoFire(difficultyRef.current, next));
      return next;
    });
    focusGame();
  };
  const announceDifficulty = (id: DifficultyId) => {
    const def = difficultyById(id);
    setDifficultyNotice(`Difficulty: ${def.label} · Score x${def.scoreMul}`);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setDifficultyNotice(""), 2200);
  };
  const applyDifficultyStep = (delta: 1 | -1) => {
    const next = stepDifficulty(difficultyRef.current, delta);
    if (next.id === difficultyRef.current) return;
    difficultyRef.current = next.id;
    setDifficultyId(next.id);
    writeDifficulty(next.id);
    const game = runtime.current?.game;
    if (game) {
      game.setDifficulty(next.id);
      game.setInfernoFire(isInfernoFire(next.id, aiRef.current));
    }
    announceDifficulty(next.id);
    runtime.current?.render();
    focusGame();
  };
  const selectLevel = (level: DifficultyId) => {
    const def = difficultyById(level);
    difficultyRef.current = def.id;
    setDifficultyId(def.id);
    writeDifficulty(def.id);
    const game = runtime.current?.game;
    if (game) {
      game.setDifficulty(def.id);
      game.setInfernoFire(isInfernoFire(def.id, aiRef.current));
    }
    runtime.current?.render();
  };

  useEffect(() => {
    const surface = canvas.current;
    if (!surface) return;
    const game = new AsteroidsEngine(surface.clientWidth, surface.clientHeight);
    game.setDifficulty(difficultyRef.current);
    game.setInfernoFire(isInfernoFire(difficultyRef.current, aiRef.current));
    const renderer = createRenderer(surface, game), audio = new ArcadeAudio();
    if (!renderer) { setUnsupported(true); return; }
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0, previous = 0, lastHud = 0, disposed = false;
    const saveBest = () => {
      if (game.score <= bestRef.current) return;
      bestRef.current = game.score; setBest(game.score);
      try { localStorage.setItem(BEST_KEY, String(game.score)); } catch { /* Storage is optional. */ }
    };
    const publish = () => { setHud(snapshot(game, aiRef.current)); if (game.phase === "over") saveBest();
      if (game.sector > progressRef.current) { progressRef.current = game.sector; setProgress(game.sector);
        try { localStorage.setItem(PROGRESS_KEY, String(game.sector)); } catch { /* Storage is optional. */ } } };
    const draw = () => renderer.draw(controls.current, reducedMotion);
    const stopObservingTheme = observeArcadePalette(surface, palette => { renderer.setPalette(palette); draw(); });
    const stop = () => { cancelAnimationFrame(frame); frame = 0; previous = 0; };
    const schedule = () => { if (!disposed && !frame && !pausedRef.current && !document.hidden && game.phase === "playing") frame = requestAnimationFrame(tick); };
    const tick = (time: number) => {
      frame = 0;
      if (disposed || pausedRef.current || document.hidden || game.phase !== "playing") return;
      // Cap rendering to 60 Hz on high-refresh displays.
      if (previous && time - previous < 15) { schedule(); return; }
      const dt = previous ? (time - previous) / 1000 : 1 / 60; previous = time;
      game.step(dt, controls.current);
      controls.current.bomb = false; controls.current.swap = false;
      draw();
      // Local director at 2Hz + optional LLM events.
      if (time - lastDirector.current > 500) {
        lastDirector.current = time;
        const fired = game.shotsFired - baseStats.current.fired;
        const deaths = game.deaths - baseStats.current.deaths;
        baseStats.current = { fired: game.shotsFired, deaths: game.deaths };
        const mod = updateDirector(director.current, { accuracy: game.accuracy, deaths, combo: game.combo, clearTime: game.sectorTime, dashUses: game.dashUses, score: game.score, sector: game.sector });
        void fired;
        game.applyDirector(mod);
        if (aiRef.current === "adaptive") {
          const infernoFire = isInfernoFire(difficultyRef.current, aiRef.current);
          void fetchAIModifier({ score: game.score, sector: game.sector, accuracy: game.accuracy, deaths: game.deaths, combo: game.combo, playstyle: game.combo >= 8 ? "aggressive" : game.dashUses > 4 ? "evasive" : "balanced" }, fetch, { infernoFire }).then(m => { if (m && m.event !== "none") game.applyLLM(m); });
        }
      }
      if (musicRef.current) { audio.tick(game.sector, getSectorDef(game.sector).biome); for (const cue of new Set(game.cues)) audio.cue(cue); }
      game.cues.length = 0;
      if (time - lastHud >= 120 || game.phase !== "playing") { lastHud = time; publish(); }
      if (game.phase !== "playing") { clearInput(); audio.pause(); previous = 0; }
      schedule();
    };
    runtime.current = { game, audio, render: () => { draw(); publish(); }, stop, schedule };
    const resize = () => {
      const bounds = surface.getBoundingClientRect();
      renderer.resize(bounds.width, bounds.height); draw();
    };
    const observer = new ResizeObserver(resize); observer.observe(surface); resize(); focusGame();
    const suspend = () => {
      clearInput();
      if (game.phase === "playing") { pausedRef.current = true; setPaused(true); }
      stop(); audio.pause(); saveBest();
    };
    const visibility = () => { if (document.hidden) suspend(); };
    const pageHide = () => { suspend(); };
    window.addEventListener("blur", suspend);
    window.addEventListener("pagehide", pageHide);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      disposed = true; stop(); saveBest(); observer.disconnect(); stopObservingTheme(); audio.dispose(); clearInput();
      window.clearTimeout(noticeTimer.current);
      window.removeEventListener("blur", suspend); window.removeEventListener("pagehide", pageHide);
      document.removeEventListener("visibilitychange", visibility); runtime.current = null;
    };
  }, []);

  const begin = (startSector?: number) => {
    const rt = runtime.current; if (!rt) return;
    clearInput(); pausedRef.current = false; setPaused(false);
    rt.game.start(startSector ?? 1); director.current = emptyDirector(); baseStats.current = { fired: 0, deaths: 0 };
    rt.game.setDifficulty(difficultyRef.current);
    rt.game.setInfernoFire(isInfernoFire(difficultyRef.current, aiRef.current));
    if (musicRef.current) void rt.audio.enable();
    rt.render(); rt.schedule(); focusGame();
  };
  const toggleMusic = async () => {
    const audio = runtime.current?.audio; if (!audio) return;
    if (musicRef.current) { musicRef.current = false; setMusic(false); audio.pause(); }
    else {
      musicRef.current = true;
      const enabled = await audio.enable();
      if (!runtime.current || !musicRef.current) return;
      musicRef.current = enabled; setMusic(enabled); setAudioUnavailable(!enabled);
      if (pausedRef.current || runtime.current.game.phase !== "playing") audio.pause();
    }
    focusGame();
  };
  const pointerDown = (event: PointerEvent<HTMLButtonElement>, action: keyof Controls) => {
    if (pausedRef.current || runtime.current?.game.phase !== "playing") return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, action); syncInput(); focusGame();
  };
  const pointerUp = (event: PointerEvent<HTMLButtonElement>) => { pointers.current.delete(event.pointerId); syncInput(); };
  const tapMomentary = (action: "bomb" | "swap") => {
    if (pausedRef.current || runtime.current?.game.phase !== "playing") return;
    controls.current[action] = true; focusGame();
  };

  return (
    <section ref={root} className="asteroids-game" tabIndex={-1} aria-label="Spaceapp Asteroids game" data-phase={hud.phase} data-paused={paused} data-music={music} data-difficulty={hud.difficulty} data-inferno={hud.infernoFire}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget) && runtime.current?.game.phase === "playing") setPause(true); }}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); return; }
        if (event.target instanceof HTMLButtonElement) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if ((event.code === "BracketLeft" || event.code === "BracketRight") && !event.repeat && hud.phase === "playing") {
          event.preventDefault(); event.stopPropagation();
          applyDifficultyStep(event.code === "BracketLeft" ? -1 : 1);
          return;
        }
        if (event.code === "KeyP" && !event.repeat && hud.phase === "playing") { event.preventDefault(); event.stopPropagation(); setPause(!pausedRef.current); return; }
        if (WEAPON_KEYS[event.code] && !event.repeat && hud.phase === "playing") {
          event.preventDefault(); event.stopPropagation();
          const w = WEAPON_KEYS[event.code];
          if (w) runtime.current?.game.setWeapon(w);
          return;
        }
        if (KEY_MAP[event.code]) {
          event.preventDefault(); event.stopPropagation();
          if (!pausedRef.current && hud.phase === "playing") {
            const action = KEY_MAP[event.code];
            if (action && (event.code === "KeyE" || event.code === "KeyQ")) controls.current[action] = true;
            else keys.current.add(event.code);
            syncInput();
          }
        }
      }}
      onKeyUp={event => { if (KEY_MAP[event.code]) { event.preventDefault(); event.stopPropagation(); keys.current.delete(event.code); if (event.code !== "KeyE" && event.code !== "KeyQ") syncInput(); } }}>
      <canvas ref={canvas} className="asteroids-canvas" aria-label="Asteroid field" onPointerDown={focusGame} />
      <header className="asteroids-hud">
        <div className="asteroids-brand"><span className="asteroids-orbit-mark"><SpaceappMark /></span><div><strong>SPACEAPP<span>ASTEROIDS</span></strong><small>spaceapp.dev / after hours</small></div></div>
        <div className="asteroids-score"><small>SCORE</small><strong>{hud.score.toLocaleString("en-US").padStart(6, "0")}</strong><span>BEST {best.toLocaleString("en-US")}</span></div>
        <div className="asteroids-actions">
          <button type="button" aria-label={music ? "Turn music off" : "Turn music on"} title={music ? "Music on · click to mute" : "Music off · click to enable"} aria-pressed={music} onClick={() => void toggleMusic()}>{music ? <Music2 aria-hidden="true" /> : <VolumeX aria-hidden="true" />}</button>
          <button type="button" aria-label={`AI director ${aiMode}`} title={`AI director: ${aiMode} · click to switch`} aria-pressed={aiMode === "adaptive"} onClick={toggleAI}>AI</button>
          {hud.phase === "playing" && <button type="button" className="asteroids-pause" aria-label={paused ? "Resume game" : "Pause game"} title={paused ? "Resume game (P)" : "Pause game (P)"} onClick={() => setPause(!pausedRef.current)}>{paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}</button>}
        </div>
      </header>
      {hud.bossHp > 0 && hud.phase === "playing" && <div className="asteroids-boss-bar" role="status" aria-label="Boss integrity"><span>BOSS {hud.bossHp}</span><i style={{ width: `${Math.min(100, hud.bossHp * 2)}%` }} /></div>}
      {audioUnavailable && <p className="asteroids-audio-notice" role="status">Audio is unavailable in this browser.</p>}
      {unsupported ? <div className="asteroids-overlay"><div className="asteroids-panel"><h1>Canvas is unavailable</h1><p>Try a browser with Canvas 2D support.</p></div></div> : hud.phase === "ready" ? (
        <div className="asteroids-overlay"><div className="asteroids-panel asteroids-intro">
          <span className="asteroids-eyebrow">YOU FOUND A LITTLE EXTRA SPACE</span>
          <FlightDemo />
          <h1>Work can wait.<br /><span>Orbit cannot.</span></h1>
          <p>Carve through 12 sectors. Chain your hits. Unlock 6 weapons.<br className="asteroids-wide" /> Weavers, gunships and kamikazes await. A boss guards every fifth sector. Upgrades apply automatically.</p>
          <div className="asteroids-difficulty-picker" role="group" aria-label="Starting difficulty level">
            <small>STARTING LEVEL · <b>LEVEL {difficultyId} · SCORE ×{difficultyById(difficultyId).scoreMul}</b></small>
            <div>{DIFFICULTY_ORDER.map(d => <button key={d.id} type="button" aria-label={`Start at level ${d.id}`} aria-pressed={d.id === difficultyId} className={d.id === difficultyId ? "is-active" : undefined} onClick={() => selectLevel(d.id)}>{d.id}</button>)}</div>
          </div>
          <button className="asteroids-primary" type="button" onClick={() => begin()}>Launch mission <span aria-hidden="true">↗</span></button>
          {progress > 1 && <>
            <button className="asteroids-primary" type="button" onClick={() => begin(progress)}>Continue — Sector {String(Math.min(progress, 99)).padStart(2, "0")} <span aria-hidden="true">↗</span></button>
            <div className="asteroids-sectors" role="group" aria-label="Start from an unlocked sector">
              <small>BEST SECTOR {String(Math.min(progress, 99)).padStart(2, "0")} · START FROM</small>
              <div>{Array.from({ length: Math.min(progress, 12) }, (_, i) => i + 1).map(n => <button key={n} type="button" aria-label={`Start from sector ${n}`} onClick={() => begin(n)}>{String(n).padStart(2, "0")}</button>)}</div>
            </div>
          </>}
          <div className="asteroids-key-guide"><span><kbd>W</kbd> / <kbd>↑</kbd> Thrust</span><span><kbd>A D</kbd> / <kbd>← →</kbd> Turn</span><span><kbd>Space</kbd> Fire</span><span><kbd>Shift</kbd> Dash</span><span><kbd>E</kbd> Bomb</span><span><kbd>Q</kbd> Swap</span><span><kbd>[</kbd> <kbd>]</kbd> Difficulty</span></div>
          <small>Touch controls below · P to pause · [ / ] for difficulty · Esc to return to work</small>
        </div></div>
      ) : hud.phase === "over" ? (
        <div className="asteroids-overlay"><div className="asteroids-panel">
          <span className="asteroids-eyebrow">MISSION LOG / SECTOR {String(hud.sector).padStart(2, "0")}</span><h1>Stardust happens.</h1>
          <p>{hud.score > 0 && hud.score >= best ? "A new personal orbit record." : "Another orbit. A little further."}</p><div className="asteroids-final-score">{hud.score.toLocaleString("en-US")}<small>POINTS</small></div>
          <FlightDemo />
          <button className="asteroids-primary" type="button" onClick={() => begin()}>Fly again <span aria-hidden="true">↗</span></button><button className="asteroids-text-button" type="button" onClick={onClose}>Back to workspace</button>
        </div></div>
      ) : paused ? (
        <div className="asteroids-overlay"><div className="asteroids-panel"><span className="asteroids-eyebrow">HOLDING ORBIT</span><h1>Take your time.</h1><p>Your mission is paused.</p><button type="button" className="asteroids-primary" onClick={() => setPause(false)}>Resume mission <span aria-hidden="true">↗</span></button></div></div>
      ) : null}
      {hud.phase === "playing" && !paused && <>
        {hud.banner && <div className="asteroids-sector-banner"><small>SECTOR {String(hud.sector).padStart(2, "0")}</small><strong>{hud.name}</strong>{hud.autoUpgrade && <small>AUTO-UPGRADE · {hud.autoUpgrade}</small>}</div>}
        {difficultyNotice && <div className="asteroids-difficulty-notice" role="status" aria-live="polite"><span>{difficultyNotice}</span></div>}
        {hud.multiplier > 1 && <div className="asteroids-combo">×{hud.multiplier}<small>{hud.combo} HIT CHAIN</small></div>}
        {hud.taunt && <div className="asteroids-chatter" role="status"><span>{hud.taunt}</span></div>}
        {hud.ai === "adaptive" && <aside className={`asteroids-ai-panel${hud.infernoFire ? " asteroids-ai-inferno" : ""}`} aria-label="AI director orders">
          <strong>{hud.infernoFire ? "AI DIRECTOR · INFERNO FIRE" : `AI DIRECTOR · ${hud.aiZone.toUpperCase()}`}</strong>
          <dl>
            <div><dt>SPAWN</dt><dd>×{hud.aiSpawn.toFixed(2)}</dd></div>
            <div><dt>SPEED</dt><dd>×{hud.aiSpeed.toFixed(2)}</dd></div>
            <div><dt>ENEMY FIRE</dt><dd>×{hud.aiFire.toFixed(2)}</dd></div>
            <div><dt>ELITE</dt><dd>{Math.round(hud.aiElite * 100)}%</dd></div>
            <div><dt>DROPS</dt><dd>×{hud.aiDrops.toFixed(2)}</dd></div>
            <div><dt>LLM EVENT</dt><dd>{hud.aiEvent}{hud.aiTimer > 0 ? ` ${hud.aiTimer}s` : ""}</dd></div>
            <div><dt>THREAT</dt><dd>{hud.aiThreat.toFixed(2)}</dd></div>
          </dl>
          <ol>{hud.aiLog.length ? hud.aiLog.map((d, i) => <li key={`${d.t.toFixed(1)}-${i}`}><span>{Math.floor(d.t / 60)}:{String(Math.floor(d.t % 60)).padStart(2, "0")}</span> {d.text}</li>) : <li><span>--:--</span> waiting for orders…</li>}</ol>
        </aside>}
        {hud.thrustHint && <div className="asteroids-thrust-hint" role="status"><strong>Hold W / ↑ to fly forward</strong><span>A / D turn your ship · hold the ↑ touch button to thrust</span></div>}
      </>}
      <footer className="asteroids-footer"><span>SECTOR <b>{String(hud.sector).padStart(2, "0")}</b><i>/ {hud.name}</i></span><span aria-label={`${hud.lives} hull remaining`}>HULL <b className="asteroids-hull">{"◆".repeat(hud.lives)}{"◇".repeat(Math.max(0, 3 - hud.lives))}</b></span><span>{hud.rapid > 0 ? `RAPID ${hud.rapid}s` : hud.shield ? `SHIELD Lv${hud.shieldLevel} · ×${hud.shield}` : hud.dash ? `DASH ${hud.dash}s` : "DASH READY"}</span><span>WEAPON <b>{hud.weapon} {hud.weaponLevel > 0 ? `Lv${hud.weaponLevel}` : ""}</b><i>/ BOMB ×{hud.bombs}</i></span><span className="asteroids-difficulty">LEVEL <button type="button" aria-label="Easier difficulty" title="Easier difficulty ([)" onClick={() => applyDifficultyStep(-1)}>−</button><b aria-live="polite">{hud.difficulty} ×{hud.scoreMul}</b><button type="button" aria-label="Harder difficulty" title="Harder difficulty (])" onClick={() => applyDifficultyStep(1)}>+</button></span><span>AI <b>{hud.infernoFire ? "INFERNO FIRE" : hud.ai.toUpperCase()}</b></span></footer>
      {hud.phase === "playing" && !paused && <div className="asteroids-touch" aria-label="Flight controls">
        <div>{([["left", "↶", "Turn left"], ["thrust", "↑", "Thrust"], ["right", "↷", "Turn right"]] as const).map(([action, label, name]) => <button key={action} type="button" aria-label={name} onPointerDown={e => pointerDown(e, action)} onPointerUp={pointerUp} onPointerCancel={pointerUp} onLostPointerCapture={pointerUp}>{label}</button>)}</div>
        <div>
          <button type="button" aria-label="Swap weapon" title="Swap weapon (Q)" onPointerDown={() => tapMomentary("swap")}>⇄</button>
          <button type="button" aria-label="Bomb" title="Bomb (E)" onPointerDown={() => tapMomentary("bomb")}>✸</button>
          {([["dash", "»", "Dash"], ["fire", "◎", "Fire"]] as const).map(([action, label, name]) => <button key={action} type="button" aria-label={name} className={action === "fire" ? "asteroids-fire" : undefined} onPointerDown={e => pointerDown(e, action)} onPointerUp={pointerUp} onPointerCancel={pointerUp} onLostPointerCapture={pointerUp}>{label}</button>)}
        </div>
      </div>}
    </section>
  );
}
