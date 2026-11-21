// smoke.js — headless smoke test for the renderer.
//
// Electron, a camera and a real speaker don't exist in CI, so this harness
// fakes just enough of the browser (DOM, canvas 2D, Web Audio) to execute the
// REAL bundled renderer in simulated mode. It catches the class of bug that
// unit tests can't: a missing element id, a typo in an event name, an audio
// node graph that throws on the first frame.
//
//   node test/smoke.js        (after `npm run build:smoke`)
//
// It is not a substitute for running the app — it proves the plumbing runs.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BUNDLE = path.join(__dirname, '..', 'dist', 'renderer.smoke.js');
if (!fs.existsSync(BUNDLE)) {
  console.error(`Missing ${BUNDLE}. Run: npm run build:smoke`);
  process.exit(1);
}

// --- tiny DOM --------------------------------------------------------------
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);

class ClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
}

class Element {
  constructor(tag = 'div', id = '') {
    this.tagName = tag;
    this.id = id;
    this.textContent = '';
    this.className = '';
    this.classList = new ClassList();
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.checked = false;
    this.attrs = Object.create(null);
    this.handlers = Object.create(null);
    this.srcObject = null;
    this.children = [];
  }
  addEventListener(type, cb) { (this.handlers[type] ||= []).push(cb); }
  removeEventListener() {}
  dispatch(type, event = {}) {
    for (const cb of this.handlers[type] || []) cb({ target: this, ...event });
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(child) { this.children.push(child); return child; }
  play() { return Promise.resolve(); }
  pause() {}
  getBoundingClientRect() { return { width: 900, height: 620, top: 0, left: 0 }; }
  getContext() { return makeContext2d(); }
  focus() {}
}

const elements = new Map();
for (const id of ids) {
  const tag = id === 'stage-canvas' ? 'canvas' : (id === 'preview' ? 'video' : 'div');
  elements.set(id, new Element(tag, id));
}

const presets = ['ember', 'tide', 'glass'].map((name, i) => {
  const b = new Element('button');
  b.dataset.preset = name;
  if (i === 0) b.classList.add('is-active');
  return b;
});

global.document = {
  getElementById(id) { return elements.get(id) || null; },
  querySelector(sel) {
    if (sel === '.preview') return elements.get('preview-wrap') || new Element();
    return new Element();
  },
  querySelectorAll(sel) { return sel === '.preset' ? presets : []; },
  createElement(tag) { return new Element(tag); },
  addEventListener() {},
  body: new Element('body'),
};

let rafQueue = [];
global.window = {
  devicePixelRatio: 2,
  location: { search: '' },
  addEventListener() {},
  requestAnimationFrame(cb) { rafQueue.push(cb); return rafQueue.length; },
  AudioContext: FakeAudioContext,
};
global.requestAnimationFrame = global.window.requestAnimationFrame;
global.performance = { now: () => Date.now() };

// --- fake canvas -----------------------------------------------------------
function makeGradient() {
  return { addColorStop() {} };
}
function makeContext2d() {
  const noop = () => {};
  return {
    setTransform: noop, fillRect: noop, beginPath: noop, arc: noop, fill: noop,
    stroke: noop, moveTo: noop, lineTo: noop, closePath: noop, save: noop,
    restore: noop, createRadialGradient: makeGradient, createLinearGradient: makeGradient,
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineJoin: '', globalCompositeOperation: '',
  };
}

// --- fake Web Audio --------------------------------------------------------
class Param {
  constructor(v = 0) { this.value = v; }
  setValueAtTime() { return this; }
  exponentialRampToValueAtTime() { return this; }
  linearRampToValueAtTime() { return this; }
  setTargetAtTime() { return this; }
  cancelScheduledValues() { return this; }
}

class Node {
  constructor() { this.gain = new Param(1); this.frequency = new Param(440); this.Q = new Param(1); }
  connect() { return this; }
  disconnect() {}
  start() {}
  stop() {}
}

function FakeAudioContext() {
  this.currentTime = 0;
  this.sampleRate = 48000;
  this.state = 'running';
  this.destination = new Node();
  const mk = () => new Node();
  this._nodes = [];
  this.createGain = () => { const n = new Node(); this._nodes.push(n); return n; };
  this.createOscillator = () => {
    const n = mk();
    n.type = 'sine';
    this._nodes.push(n);
    return n;
  };
  this.createBiquadFilter = () => { const n = mk(); n.type = 'lowpass'; return n; };
  this.createDynamicsCompressor = () => {
    const n = new Node();
    n.threshold = new Param(0); n.knee = new Param(0);
    n.ratio = new Param(0); n.attack = new Param(0); n.release = new Param(0);
    return n;
  };
  this.createConvolver = () => { const n = new Node(); n.buffer = null; return n; };
  this.createBufferSource = () => { const n = new Node(); n.buffer = null; n.playbackRate = new Param(1); return n; };
  this.createBuffer = (ch, len) => ({ getChannelData: () => new Float32Array(len) });
  this.resume = () => Promise.resolve();
  this.close = () => Promise.resolve();
}
global.AudioContext = FakeAudioContext;

// --- run the real bundle ---------------------------------------------------
require(BUNDLE);

function frame(stepMs = 16) {
  const queue = rafQueue;
  rafQueue = [];
  for (const cb of queue) cb(Date.now() + stepMs);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function run() {
  // The consent sheet starts hidden? No: it is the gate. The bundle wired a
  // click handler onto "Try it without a camera".
  const demoBtn = elements.get('btn-demo');
  assert.ok(demoBtn, 'consent sheet must offer a simulated mode');
  demoBtn.dispatch('click');

  // Let the simulated signal run, pumping animation frames like a browser.
  for (let i = 0; i < 60; i += 1) {
    frame();
    await sleep(20);
  }

  const bpm = elements.get('bpm-main').textContent;
  const pulse = elements.get('m-pulse').textContent;
  const quality = elements.get('m-quality').textContent;
  const mode = elements.get('m-mode').textContent;
  const caption = elements.get('tempo-caption').textContent;

  assert.match(String(bpm), /^\d+$/, `tempo readout should show a number, got "${bpm}"`);
  assert.match(String(pulse), /^\d+$/, `pulse readout should show a number, got "${pulse}"`);
  assert.notEqual(quality, '—', 'signal quality should be reported');
  assert.ok(['calm', 'drift', 'charged'].includes(mode), `unexpected mode "${mode}"`);
  assert.ok(caption.length > 0);
  assert.equal(elements.get('sim-badge').hidden, false, 'simulated mode must be labelled in the UI');

  // Preset + volume controls must be wired.
  presets[2].dispatch('click');
  assert.equal(presets[2].getAttribute('aria-checked'), 'true');
  const vol = elements.get('volume');
  vol.value = '30';
  vol.dispatch('input');
  const mute = elements.get('btn-mute');
  mute.dispatch('click');
  assert.equal(mute.textContent, 'Unmute music');

  // Stop returns the UI to idle without throwing.
  elements.get('btn-stop').dispatch('click');
  await sleep(60);
  for (let i = 0; i < 5; i += 1) frame();
  assert.equal(elements.get('btn-start').disabled, false, 'Start must re-enable after Stop');
  assert.equal(elements.get('bpm-main').textContent, '—');

  console.log('\nsmoke: renderer ran in simulated mode');
  console.log(`  tempo ${bpm} bpm · pulse ${pulse} · quality ${quality}% · mode ${mode}`);
  console.log('  start/stop, presets, volume and mute all wired\n');
  process.exit(0);
})().catch((err) => {
  console.error('smoke FAILED:', err);
  process.exit(1);
});
