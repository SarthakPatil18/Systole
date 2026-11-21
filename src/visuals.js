// visuals.js — the stage.
//
// Plain 2D canvas, no dependencies. Three things move:
//   * the breathing orb (radius + glow follow the chest trace)
//   * beat rings (one per detected heartbeat in the pressure waveform)
//   * a live trace ribbon along the bottom (pressure wave + breath wave)

'use strict';

const PALETTES = {
  ember: { hot: '#ff8a4c', cool: '#ffd166', core: '#fff3d6', bg: [26, 14, 10] },
  tide: { hot: '#34d399', cool: '#22d3ee', core: '#e6fffb', bg: [6, 20, 24] },
  glass: { hot: '#a78bfa', cool: '#f0abfc', core: '#f5f0ff', bg: [14, 10, 26] },
};

const EXPRESSION_TINT = {
  happy: '#ffd166',
  surprise: '#a5f3fc',
  neutral: null,
  sad: '#93c5fd',
  angry: '#fb7185',
  fear: '#c4b5fd',
  disgust: '#a3e635',
  contempt: '#fbbf24',
};

class Visuals {
  constructor(canvas, { onBeatPulse = null } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.preset = 'ember';
    this.rings = [];
    this.particles = [];
    this.onBeatPulse = onBeatPulse;
    this.dpr = 1;
    this.w = 0;
    this.h = 0;
    this._t = 0;
    this._initParticles();
    this.resize();
  }

  _initParticles() {
    this.particles = [];
    for (let i = 0; i < 96; i += 1) {
      this.particles.push({
        angle: (i / 96) * Math.PI * 2 + Math.random() * 0.2,
        radius: 0.35 + Math.random() * 0.6,
        speed: 0.03 + Math.random() * 0.12,
        size: 0.6 + Math.random() * 1.8,
        jitter: 0,
      });
    }
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, Math.floor(rect.width));
    this.h = Math.max(1, Math.floor(rect.height));
    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  setPreset(name) {
    if (PALETTES[name]) this.preset = name;
  }

  /** Push a ring on every detected beat. */
  pulse(strength = 0.8) {
    this.rings.push({ r: this._baseRadius() * 0.55, alpha: 0.85, strength });
    for (const p of this.particles) p.jitter = (Math.random() - 0.5) * 0.9 * strength;
    if (this.onBeatPulse) this.onBeatPulse(strength);
  }

  _baseRadius() {
    return Math.min(this.w, this.h) * 0.22;
  }

  frame(snapshot, dt = 0.016) {
    const ctx = this.ctx;
    const pal = PALETTES[this.preset];
    const w = this.w;
    const h = this.h;
    const cx = w * 0.5;
    const cy = h * 0.46;
    this._t += dt;

    const quality = snapshot ? snapshot.quality ?? 0 : 0;
    const breath = snapshot ? snapshot.breathPhase ?? 0.5 : 0.5;
    const expression = expressionName(snapshot);

    // Trail instead of a hard clear: everything drifts.
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(${pal.bg[0]}, ${pal.bg[1]}, ${pal.bg[2]}, ${0.24 + 0.1 * (1 - quality)})`;
    ctx.fillRect(0, 0, w, h);

    const radius = this._baseRadius() * (0.82 + 0.34 * breath);

    // Outer aura
    const aura = ctx.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius * 2.4);
    aura.addColorStop(0, hexToRgba(pal.hot, 0.30 * (0.3 + 0.7 * quality)));
    aura.addColorStop(0.45, hexToRgba(pal.cool, 0.10 * (0.3 + 0.7 * quality)));
    aura.addColorStop(1, hexToRgba(pal.cool, 0));
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 2.4, 0, Math.PI * 2);
    ctx.fill();

    // Orb body
    const body = ctx.createRadialGradient(
      cx - radius * 0.25, cy - radius * 0.3, radius * 0.05,
      cx, cy, radius,
    );
    body.addColorStop(0, hexToRgba(pal.core, 0.95));
    body.addColorStop(0.5, hexToRgba(pal.hot, 0.55));
    body.addColorStop(1, hexToRgba(pal.cool, 0.08));
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();

    // Rim
    ctx.strokeStyle = hexToRgba(expression ? (EXPRESSION_TINT[expression] || pal.core) : pal.core, 0.35 + 0.3 * quality);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Beat rings
    for (let i = this.rings.length - 1; i >= 0; i -= 1) {
      const ring = this.rings[i];
      ring.r += (220 + ring.strength * 160) * dt;
      ring.alpha *= 0.965;
      if (ring.alpha < 0.02) {
        this.rings.splice(i, 1);
        continue;
      }
      ctx.strokeStyle = hexToRgba(pal.cool, ring.alpha * 0.55);
      ctx.lineWidth = 1 + ring.strength * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, ring.r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Orbiting particles
    for (const p of this.particles) {
      p.angle += p.speed * dt * (0.6 + breath);
      p.jitter *= 0.9;
      const pr = radius * (1.05 + p.radius * 0.55 + p.jitter);
      const x = cx + Math.cos(p.angle) * pr;
      const y = cy + Math.sin(p.angle * 1.02) * pr * 0.92;
      ctx.fillStyle = hexToRgba(pal.cool, 0.10 + 0.4 * quality);
      ctx.beginPath();
      ctx.arc(x, y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }

    // Trace ribbon
    if (snapshot) {
      if (snapshot.hasPressure) {
        drawTrace(ctx, snapshot.pressure, {
          x: 0, y: h * 0.80, w, h: h * 0.14,
          color: hexToRgba(pal.hot, 0.75), lineWidth: 1.5, window: 420,
        });
      }
      if (snapshot.hasChest) {
        drawTrace(ctx, snapshot.chest, {
          x: 0, y: h * 0.86, w, h: h * 0.10,
          color: hexToRgba(pal.cool, 0.35), lineWidth: 1, window: 420,
        });
      }
    }

    // If the camera can't see us, say so visually: dim the whole stage.
    if (snapshot && quality < 0.15) {
      ctx.fillStyle = 'rgba(4, 5, 10, 0.35)';
      ctx.fillRect(0, 0, w, h);
    }
  }
}

function drawTrace(ctx, values, { x, y, w, h, color, lineWidth, window: windowSamples }) {
  const n = values.length;
  if (n < 4) return;
  const start = Math.max(0, n - windowSamples);
  let min = Infinity;
  let max = -Infinity;
  for (let i = start; i < n; i += 1) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const count = specsCount(n, start);
  for (let k = 0; k < count; k += 1) {
    const i = start + k;
    const px = x + (k / (count - 1 || 1)) * w;
    const py = y + h - ((values[i] - min) / span) * h;
    if (k === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
}

function specsCount(n, start) {
  // Downsample very long windows so the path stays cheap.
  const total = n - start;
  return Math.min(total, 600);
}

function expressionName(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.expression)) return null;
  let best = null;
  for (const s of snapshot.expression) {
    if (!s || !Number.isFinite(s.confidence)) continue;
    if (!best || s.confidence > best.confidence) best = s;
  }
  if (!best || best.confidence < 40) return null;
  const names = { 1: 'angry', 2: 'contempt', 3: 'disgust', 4: 'fear', 5: 'happy', 6: 'neutral', 7: 'sad', 8: 'surprise' };
  return names[best.type] || null;
}

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

module.exports = { Visuals, PALETTES, hexToRgba, expressionName };
