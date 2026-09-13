import { AsteroidsEngine, type Controls } from "./engine.js";
import { SPACE_LOGO_TILES } from "./SpaceappMark.js";
import type { ArcadePalette } from "./theme.js";

export function createRenderer(canvas: HTMLCanvasElement, game: AsteroidsEngine) {
  // Transparency preserves the exact workspace background, including gradients.
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return null;
  let ratio = 1;
  let palette: ArcadePalette;
  // Fixed star positions, no allocations or gradients in the animation loop.
  const stars = Array.from({ length: 110 }, (_, i) => ({ x: ((i * 137.508) % 997) / 997, y: ((i * 271.79) % 991) / 991, r: i % 5 === 0 ? 1.5 : .7, layer: i % 3 }));
  const resize = (width: number, height: number) => {
    game.resize(width, height);
    ratio = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(2_500_000 / (game.width * game.height)));
    canvas.width = Math.round(game.width * ratio); canvas.height = Math.round(game.height * ratio);
  };
  const draw = (controls: Controls, reducedMotion: boolean) => {
    if (!palette) return;
    const { width: w, height: h } = game;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // Parallax stars drift slightly with ship velocity.
    const px = game.ship.vx * 0.008, py = game.ship.vy * 0.008;
    ctx.fillStyle = palette.muted;
    for (const star of stars) {
      ctx.globalAlpha = star.r > 1 ? .7 : .36;
      const sx = (((star.x * w - px * (star.layer + 1)) % w) + w) % w;
      const sy = (((star.y * h - py * (star.layer + 1)) % h) + h) % h;
      ctx.fillRect(sx, sy, star.r, star.r);
    }
    ctx.globalAlpha = 1;
    // Storm streaks for gust sectors.
    if ((game.gust.x || game.gust.y) && !reducedMotion) {
      ctx.strokeStyle = palette.muted; ctx.globalAlpha = .25; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < 14; i++) {
        const sx = (i * 197.3) % w, sy = (i * 311.7) % h;
        ctx.moveTo(sx, sy); ctx.lineTo(sx + game.gust.x * .4, sy + game.gust.y * .4);
      }
      ctx.stroke(); ctx.globalAlpha = 1;
    }
    // The actual Space mark replaces the orbital circle; four bounded strokes.
    const logoScale = Math.min(w, h) * .9 / 512;
    ctx.save(); ctx.translate(w * .5, h * .5); ctx.scale(logoScale, logoScale); ctx.translate(-256, -256);
    ctx.strokeStyle = palette.watermark; ctx.lineWidth = 2.5;
    for (const tile of SPACE_LOGO_TILES) {
      ctx.beginPath(); ctx.roundRect(tile.x, tile.y, tile.size, tile.size, tile.radius); ctx.stroke();
    }
    ctx.restore();
    ctx.save();
    if (!reducedMotion && game.shake) ctx.translate(Math.sin(game.elapsed * 80) * game.shake, Math.cos(game.elapsed * 65) * game.shake);
    for (const rock of game.rocks) {
      // Duplicate only at an edge so the wrap remains visually continuous.
      const xs = rock.x < rock.radius ? [0, w] : rock.x > w - rock.radius ? [0, -w] : [0];
      const ys = rock.y < rock.radius ? [0, h] : rock.y > h - rock.radius ? [0, -h] : [0];
      for (const dx of xs) for (const dy of ys) {
        ctx.save(); ctx.translate(rock.x + dx, rock.y + dy); ctx.rotate(rock.angle);
        ctx.strokeStyle = rock.boss ? palette.warning : palette.muted; ctx.fillStyle = palette.surface;
        ctx.lineWidth = rock.boss ? 2 : 1.5; ctx.beginPath();
        rock.shape.forEach((r, i) => { const a = i / rock.shape.length * Math.PI * 2; const x = Math.cos(a) * r * rock.radius, y = Math.sin(a) * r * rock.radius; if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
        ctx.closePath(); ctx.fill(); ctx.stroke();
        if (rock.boss) { ctx.beginPath(); ctx.arc(0, 0, 23, 0, Math.PI * 2); ctx.stroke(); ctx.fillStyle = palette.warning; ctx.font = "bold 13px monospace"; ctx.textAlign = "center"; ctx.fillText(String(rock.hp), 0, 5); }
        ctx.restore();
      }
    }
    // Enemies by kind, palette-only.
    for (const e of game.enemies) {
      ctx.save(); ctx.translate(e.x, e.y);
      const blink = e.kind === "kamikaze" && e.blink > 0 && Math.sin(game.elapsed * 30) > 0;
      ctx.strokeStyle = blink ? palette.danger : e.elite ? palette.warning : e.kind === "gunship" ? palette.danger : e.kind === "kamikaze" ? palette.warning : palette.accent;
      ctx.fillStyle = palette.surface; ctx.lineWidth = e.elite ? 2.5 : 1.5;
      ctx.beginPath();
      if (e.kind === "weaver") { ctx.moveTo(12, 0); ctx.lineTo(-9, -8); ctx.lineTo(-5, 0); ctx.lineTo(-9, 8); }
      else if (e.kind === "gunship") { ctx.rect(-11, -7, 22, 14); }
      else if (e.kind === "kamikaze") { ctx.moveTo(10, 0); ctx.lineTo(-8, -9); ctx.lineTo(-8, 9); }
      else if (e.kind === "splitter") { ctx.arc(0, 0, e.radius, 0, Math.PI * 2); }
      else if (e.kind === "shielder") { ctx.arc(0, 0, e.radius, 0, Math.PI * 2); }
      else { ctx.moveTo(0, -11); ctx.lineTo(10, 8); ctx.lineTo(-10, 8); }
      ctx.closePath(); ctx.fill(); ctx.stroke();
      if (e.kind === "shielder") {
        const fa = Math.atan2(game.ship.y - e.y, game.ship.x - e.x);
        ctx.beginPath(); ctx.arc(0, 0, e.radius + 5, fa - .8, fa + .8); ctx.stroke();
      }
      if (e.elite) { ctx.fillStyle = palette.warning; ctx.font = "bold 9px monospace"; ctx.textAlign = "center"; ctx.fillText("ELITE", 0, -e.radius - 6); }
      ctx.restore();
    }
    // Mines with warning blink in last second.
    for (const m of game.mines) {
      const urgent = m.timer < 1 && Math.sin(game.elapsed * 25) > 0;
      ctx.save(); ctx.translate(m.x, m.y);
      ctx.strokeStyle = urgent ? palette.danger : palette.warning; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, m.radius, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = palette.warning; ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    for (const shot of game.shots) {
      if (shot.weapon === "railgun") { ctx.strokeStyle = palette.warning; ctx.lineWidth = 4; }
      else if (shot.weapon === "missiles") { ctx.strokeStyle = palette.accent; ctx.lineWidth = 3; }
      else { ctx.strokeStyle = shot.enemy ? palette.danger : palette.accent; ctx.lineWidth = shot.enemy ? 4 : 2; }
      ctx.beginPath(); ctx.moveTo(shot.x, shot.y); ctx.lineTo(shot.x - shot.vx * .02, shot.y - shot.vy * .02); ctx.stroke();
    }
    for (const pickup of game.pickups) {
      ctx.save(); ctx.translate(pickup.x, pickup.y); ctx.strokeStyle = palette.accent; ctx.lineWidth = 1.5;
      ctx.rotate(pickup.angle); ctx.strokeRect(-11, -11, 22, 22); ctx.rotate(-pickup.angle);
      ctx.fillStyle = palette.text; ctx.font = "bold 12px monospace"; ctx.textAlign = "center";
      ctx.fillText(pickup.kind === "rapid" ? "R" : pickup.kind === "shield" ? "S" : pickup.kind === "nova" ? "N" : pickup.kind === "bomb" ? "B" : "W", 0, 4); ctx.restore();
    }
    // Radar blips for offscreen hostiles.
    ctx.fillStyle = palette.danger;
    const radar = [...game.enemies.map(e => ({ x: e.x, y: e.y })), ...game.rocks.filter(r => r.boss).map(r => ({ x: r.x, y: r.y }))];
    for (const t of radar) {
      if (t.x < 0 || t.x > w || t.y < 0 || t.y > h) {
        const rx = Math.max(8, Math.min(w - 8, t.x)), ry = Math.max(8, Math.min(h - 8, t.y));
        ctx.fillRect(rx - 2, ry - 2, 4, 4);
      }
    }
    if (!reducedMotion) for (const p of game.particles) {
      ctx.globalAlpha = p.life / p.max; ctx.fillStyle = palette[p.color]; ctx.fillRect(p.x, p.y, 2, 2);
    }
    ctx.globalAlpha = 1;
    if (game.phase !== "over") {
      // Orbitals ring.
      if (game.unlocked.includes("orbitals")) {
        ctx.save(); ctx.translate(game.ship.x, game.ship.y);
        ctx.strokeStyle = palette.accent; ctx.globalAlpha = .8; ctx.lineWidth = 1.5;
        for (let i = 0; i < 2; i++) {
          const a = game.orbitalsAngle + (i * Math.PI * 2) / 2;
          ctx.beginPath(); ctx.arc(Math.cos(a) * 46, Math.sin(a) * 46, 5, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.restore(); ctx.globalAlpha = 1;
      }
      ctx.save(); ctx.translate(game.ship.x, game.ship.y); ctx.rotate(game.ship.angle);
      if (game.shield || game.ship.immunity > 0) {
        ctx.strokeStyle = game.shield ? palette.accent : palette.muted; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(0, 0, 22, 0, Math.PI * 2); ctx.stroke();
      }
      if ((controls.thrust || game.launchThrust > 0) && game.phase === "playing") {
        ctx.fillStyle = palette.warning; ctx.beginPath(); ctx.moveTo(-9, -5); ctx.lineTo(-23 - (reducedMotion ? 0 : Math.sin(game.elapsed * 40) * 5), 0); ctx.lineTo(-9, 5); ctx.fill();
      }
      ctx.fillStyle = palette.surface; ctx.strokeStyle = palette.accent; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(17, 0); ctx.lineTo(-11, -10); ctx.lineTo(-6, 0); ctx.lineTo(-11, 10); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = palette.text; ctx.fillRect(-2, -2, 4, 4); ctx.restore();
    }
    ctx.restore();
  };
  return { resize, draw, setPalette: (next: ArcadePalette) => { palette = next; } };
}
