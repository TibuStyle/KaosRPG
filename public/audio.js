/* CRÓNICAS v1.9 — Tramo 1: motor de audio procedural (Web Audio API).
 * Sin archivos de sonido ni dependencias. Script clásico: expone window.CronicasAudio.
 * Política de autoplay: el AudioContext se crea/reanuda en el primer gesto del usuario.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'cronicas.audio.v1';
  const DEFAULTS = Object.freeze({ master: 0.7, music: 0.35, sfx: 0.8, muted: false, musicEnabled: true });
  const MUSIC_MODES = ['off', 'tavern', 'tension'];

  // ---------- Preferencias ----------
  function clamp01(v, fb) { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fb; }
  function loadPrefs() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return {
        master: clamp01(raw.master, DEFAULTS.master),
        music: clamp01(raw.music, DEFAULTS.music),
        sfx: clamp01(raw.sfx, DEFAULTS.sfx),
        muted: typeof raw.muted === 'boolean' ? raw.muted : DEFAULTS.muted,
        musicEnabled: typeof raw.musicEnabled === 'boolean' ? raw.musicEnabled : DEFAULTS.musicEnabled
      };
    } catch { return { ...DEFAULTS }; }
  }
  function savePrefs() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* modo privado/cuota: se ignora */ }
  }
  const prefs = loadPrefs();
  const listeners = new Set();
  function emit() { const snap = getPrefs(); listeners.forEach(fn => { try { fn(snap); } catch {} }); }
  function getPrefs() { return { ...prefs, mode: musicMode, unlocked: !!ctx && ctx.state === 'running' }; }

  // ---------- Grafo de audio ----------
  let ctx = null, masterGain, musicGain, sfxGain, compressor, noiseBuf = null;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  const supported = typeof Ctor === 'function';

  function ensureContext() {
    if (!supported) return null;
    if (!ctx) {
      ctx = new Ctor({ latencyHint: 'interactive' });
      compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -14; compressor.ratio.value = 4;
      masterGain = ctx.createGain(); musicGain = ctx.createGain(); sfxGain = ctx.createGain();
      musicGain.connect(masterGain); sfxGain.connect(masterGain);
      masterGain.connect(compressor); compressor.connect(ctx.destination);
      applyVolumes(true);
    }
    return ctx;
  }
  function ramp(param, value, t = 0.08) {
    const now = ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(value, now + t);
  }
  function applyVolumes(instant) {
    if (!ctx) return;
    const t = instant ? 0.001 : 0.08;
    ramp(masterGain.gain, prefs.muted ? 0 : prefs.master, t);
    ramp(musicGain.gain, prefs.musicEnabled ? prefs.music * 0.6 : 0, t);
    ramp(sfxGain.gain, prefs.sfx, t);
  }
  function noise() {
    if (noiseBuf) return noiseBuf;
    const len = ctx.sampleRate * 1;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  function ready() { return ctx && ctx.state === 'running'; }

  // ---------- Primitivas de síntesis ----------
  function env(gainNode, t, peak, attack, decay) {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
    g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }
  function tone(dest, { t, freq, type = 'sine', peak = 0.3, attack = 0.005, decay = 0.2, glideTo = null, detune = 0 }) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t); o.detune.value = detune;
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + attack + decay);
    env(g, t, peak, attack, decay);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + attack + decay + 0.05);
  }
  function noiseHit(dest, { t, peak = 0.3, decay = 0.08, type = 'bandpass', freq = 2000, q = 1 }) {
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noise(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    env(g, t, peak, 0.002, decay);
    s.connect(f); f.connect(g); g.connect(dest);
    s.start(t, Math.random() * 0.5); s.stop(t + decay + 0.05);
  }
  // Cuerda pulsada tipo laúd: triángulo + cuadrada suave con filtro que se cierra.
  function pluck(dest, t, freq, peak = 0.18, decay = 0.6) {
    const f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'lowpass'; f.Q.value = 2;
    f.frequency.setValueAtTime(Math.min(5000, freq * 8), t);
    f.frequency.exponentialRampToValueAtTime(Math.max(200, freq * 1.5), t + decay);
    env(g, t, peak, 0.004, decay);
    f.connect(g); g.connect(dest);
    [['triangle', 0, 1], ['square', 7, 0.25]].forEach(([type, det, lvl]) => {
      const o = ctx.createOscillator(), og = ctx.createGain();
      o.type = type; o.frequency.value = freq; o.detune.value = det; og.gain.value = lvl;
      o.connect(og); og.connect(f); o.start(t); o.stop(t + decay + 0.05);
    });
  }
  function drum(dest, t, low = true, peak = 0.35) {
    tone(dest, { t, freq: low ? 130 : 220, glideTo: low ? 48 : 110, peak, attack: 0.002, decay: low ? 0.28 : 0.12 });
    noiseHit(dest, { t, peak: peak * 0.4, decay: 0.05, freq: low ? 300 : 1800, q: 0.8 });
  }

  // ---------- SFX ----------
  let lastType = 0, lastHover = 0;
  const SFX = {
    click(t) { tone(sfxGain, { t, freq: 880, type: 'triangle', peak: 0.12, decay: 0.05, glideTo: 620 });
               noiseHit(sfxGain, { t, peak: 0.08, decay: 0.03, freq: 3500 }); },
    hover(t) { const n = performance.now(); if (n - lastHover < 60) return; lastHover = n;
               tone(sfxGain, { t, freq: 1320, type: 'sine', peak: 0.03, decay: 0.04 }); },
    confirm(t) { [0, 0.07].forEach((d, i) => tone(sfxGain, { t: t + d, freq: mtof(74 + i * 5), type: 'triangle', peak: 0.14, decay: 0.18 })); },
    error(t) { tone(sfxGain, { t, freq: 220, type: 'sawtooth', peak: 0.1, decay: 0.22, glideTo: 150 });
               tone(sfxGain, { t: t + 0.12, freq: 160, type: 'sawtooth', peak: 0.1, decay: 0.25, glideTo: 110 }); },
    reject(t) { tone(sfxGain, { t, freq: mtof(57), type: 'triangle', peak: 0.16, decay: 0.5 });
                tone(sfxGain, { t: t + 0.15, freq: mtof(56), type: 'triangle', peak: 0.14, decay: 0.7 }); },
    // Pergamino que se desenrolla / se enrolla.
    open(t) { noiseHit(sfxGain, { t, peak: 0.12, decay: 0.35, type: 'bandpass', freq: 900, q: 0.6 });
              noiseHit(sfxGain, { t: t + 0.05, peak: 0.08, decay: 0.3, type: 'highpass', freq: 3000 }); },
    close(t) { noiseHit(sfxGain, { t, peak: 0.1, decay: 0.18, type: 'bandpass', freq: 600, q: 0.8 });
               tone(sfxGain, { t: t + 0.12, freq: 140, peak: 0.12, decay: 0.08 }); },
    notify(t) { [76, 83].forEach((m, i) => tone(sfxGain, { t: t + i * 0.1, freq: mtof(m), type: 'sine', peak: 0.1, decay: 0.5 })); },
    whisper(t) { noiseHit(sfxGain, { t, peak: 0.07, decay: 0.25, type: 'highpass', freq: 5000 });
                 tone(sfxGain, { t, freq: mtof(81), peak: 0.05, decay: 0.3 }); },
    turn(t) { [62, 69, 74].forEach((m, i) => tone(sfxGain, { t: t + i * 0.12, freq: mtof(m), type: 'triangle', peak: 0.13, decay: 0.6 })); },
    type(t) { const n = performance.now(); if (n - lastType < 35) return; lastType = n;
              noiseHit(sfxGain, { t, peak: 0.05 + Math.random() * 0.03, decay: 0.02, freq: 2500 + Math.random() * 1500, q: 2 }); },
    diceShake(t) { for (let i = 0; i < 6; i++) noiseHit(sfxGain, { t: t + i * 0.05 + Math.random() * 0.02, peak: 0.1, decay: 0.03, freq: 1800 + Math.random() * 2000, q: 3 }); },
    // Golpes sobre madera con separación creciente (rebotes).
    diceRoll(t, count = 2) {
      const n = Math.min(12, Math.max(1, count | 0));
      for (let d = 0; d < n; d++) {
        let tt = t + Math.random() * 0.08, gap = 0.06;
        for (let b = 0; b < 5; b++) {
          noiseHit(sfxGain, { t: tt, peak: 0.22 / (b + 1) / Math.sqrt(n), decay: 0.04, freq: 900 + Math.random() * 1500, q: 4 });
          tone(sfxGain, { t: tt, freq: 180 + Math.random() * 60, peak: 0.08 / (b + 1), decay: 0.05 });
          tt += gap; gap *= 1.6;
        }
      }
    },
    success(t) { [67, 71, 74, 79].forEach((m, i) => pluck(sfxGain, t + i * 0.08, mtof(m), 0.2, 0.9)); },
    failure(t) { [64, 60, 57].forEach((m, i) => pluck(sfxGain, t + i * 0.14, mtof(m), 0.18, 0.9)); },
    critical(t) {
      [60, 64, 67, 72, 76, 79, 84].forEach((m, i) => tone(sfxGain, { t: t + i * 0.05, freq: mtof(m), type: 'triangle', peak: 0.16, decay: 0.8 }));
      for (let i = 0; i < 10; i++) tone(sfxGain, { t: t + 0.35 + i * 0.04, freq: mtof(88 + Math.floor(Math.random() * 8)), peak: 0.04, decay: 0.4 });
      drum(sfxGain, t, true, 0.5);
    },
    fumble(t) {
      [0, 0.28, 0.56].forEach((d, i) => tone(sfxGain, { t: t + d, freq: mtof(58 - i), type: 'sawtooth', peak: 0.12, attack: 0.02, decay: 0.3 }));
      tone(sfxGain, { t: t + 0.84, freq: mtof(55), type: 'sawtooth', peak: 0.12, attack: 0.02, decay: 0.9, glideTo: mtof(50) });
    }
  };
  function play(name, ...args) {
    if (!ready() || prefs.muted || !SFX[name]) return false;
    try { SFX[name](ctx.currentTime + 0.005, ...args); return true; } catch { return false; }
  }

  // ---------- Música procedural ----------
  let musicMode = 'off', bus = null, timer = null, step = 0, nextTime = 0, droneNodes = [];
  const MODES = {
    tavern: {
      bpm: 112,
      // Re dórico: Dm - C - Bb - C (raíces MIDI y tríadas).
      prog: [[50, [62, 65, 69]], [48, [60, 64, 67]], [46, [58, 62, 65]], [48, [60, 64, 67]]],
      scale: [62, 64, 65, 67, 69, 71, 72, 74, 76],
      play(s, t, out) {
        const bar = Math.floor(s / 16) % 4, i = s % 16, [root, tri] = this.prog[bar];
        if (i === 0 || i === 8) pluck(out, t, mtof(root - 12), 0.22, 0.9);
        if (i % 2 === 0) pluck(out, t, mtof(tri[[0, 1, 2, 1, 0, 2, 1, 2][i / 2]]), 0.09, 0.45);
        if (i % 4 === 2 && Math.random() < 0.35) pluck(out, t, mtof(this.scale[Math.floor(Math.random() * this.scale.length)] + 12), 0.07, 0.5);
        if (i === 0 || i === 6 || i === 10) drum(out, t, true, 0.18);
        if (i === 4 || i === 12) drum(out, t, false, 0.1);
      }
    },
    tension: {
      bpm: 72,
      startDrone(out) {
        const f = ctx.createBiquadFilter(), g = ctx.createGain(), lfo = ctx.createOscillator(), lfoG = ctx.createGain();
        f.type = 'lowpass'; f.frequency.value = 320; f.Q.value = 6;
        lfo.frequency.value = 0.08; lfoG.gain.value = 180; lfo.connect(lfoG); lfoG.connect(f.frequency);
        g.gain.value = 0.08; f.connect(g); g.connect(out);
        const oscs = [[mtof(33), 'sawtooth', 0], [mtof(33), 'sawtooth', 9], [mtof(40), 'triangle', 0]].map(([fr, ty, det]) => {
          const o = ctx.createOscillator(); o.type = ty; o.frequency.value = fr; o.detune.value = det; o.connect(f); o.start(); return o;
        });
        lfo.start();
        droneNodes = [...oscs, lfo];
      },
      play(s, t, out) {
        const i = s % 16;
        if (i === 0) drum(out, t, true, 0.28);
        if (i === 3) drum(out, t, true, 0.16);
        if (i === 8 && Math.random() < 0.3) {
          tone(out, { t, freq: mtof(81), peak: 0.05, attack: 0.3, decay: 2.5 });
          tone(out, { t: t + 0.05, freq: mtof(87), peak: 0.035, attack: 0.3, decay: 2.5 }); // tritono
        }
        if (i === 12 && Math.random() < 0.2) noiseHit(out, { t, peak: 0.05, decay: 1.2, type: 'bandpass', freq: 400, q: 8 });
      }
    }
  };
  function stopMusicInternal() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (bus && ctx) {
      const old = bus, nodes = droneNodes;
      ramp(old.gain, 0, 1.2);
      setTimeout(() => { nodes.forEach(n => { try { n.stop(); } catch {} }); try { old.disconnect(); } catch {} }, 1400);
    }
    bus = null; droneNodes = [];
  }
  function scheduler() {
    const m = MODES[musicMode];
    if (!m || !bus) return;
    const sixteenth = 60 / m.bpm / 4;
    while (nextTime < ctx.currentTime + 0.15) {
      try { m.play(step, nextTime, bus); } catch {}
      nextTime += sixteenth; step++;
    }
    timer = setTimeout(scheduler, 30);
  }
  function startMusicInternal() {
    if (!ready() || musicMode === 'off' || bus) return;
    bus = ctx.createGain(); bus.gain.value = 0; bus.connect(musicGain);
    ramp(bus.gain, 1, 1.5);
    const m = MODES[musicMode];
    if (m.startDrone) m.startDrone(bus);
    step = 0; nextTime = ctx.currentTime + 0.1; scheduler();
  }
  function setMusic(mode) {
    if (!MUSIC_MODES.includes(mode)) throw new Error('Modo de música inválido: ' + mode);
    if (mode === musicMode && (bus || mode === 'off')) return;
    stopMusicInternal(); musicMode = mode; startMusicInternal(); emit();
  }

  // ---------- Desbloqueo y ciclo de vida ----------
  let wasRunning = false;
  function unlock() {
    if (!ensureContext()) return Promise.resolve(false);
    return ctx.resume().then(() => { startMusicInternal(); emit(); return true; }).catch(() => false);
  }
  function onFirstGesture() {
    unlock().then(ok => { if (ok) ['pointerdown', 'keydown', 'touchend'].forEach(e => window.removeEventListener(e, onFirstGesture, true)); });
  }
  ['pointerdown', 'keydown', 'touchend'].forEach(e => window.addEventListener(e, onFirstGesture, true));
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) { wasRunning = ctx.state === 'running'; if (timer) { clearTimeout(timer); timer = null; } ctx.suspend().catch(() => {}); }
    else if (wasRunning) ctx.resume().then(() => { if (bus && !timer) { nextTime = ctx.currentTime + 0.1; scheduler(); } }).catch(() => {});
  });

  // ---------- Setters públicos ----------
  function setVolume(channel, value) {
    if (!['master', 'music', 'sfx'].includes(channel)) throw new Error('Canal inválido: ' + channel);
    prefs[channel] = clamp01(value, prefs[channel]); savePrefs(); applyVolumes(); emit();
  }
  function setMuted(v) { prefs.muted = !!v; savePrefs(); applyVolumes(); emit(); }
  function toggleMute() { setMuted(!prefs.muted); return prefs.muted; }
  function setMusicEnabled(v) { prefs.musicEnabled = !!v; savePrefs(); applyVolumes(); emit(); }

  // ---------- Integración DOM opcional ----------
  // Delegación: cualquier <button> suena al pulsar; data-sfx="nombre" lo sustituye; data-sfx="none" lo silencia.
  function bindUISounds(root = document) {
    root.addEventListener('click', e => {
      const el = e.target.closest && e.target.closest('button, [data-sfx]');
      if (!el || el.disabled) return;
      const name = el.dataset.sfx || 'click';
      if (name !== 'none') play(name);
    });
    root.addEventListener('pointerover', e => {
      const el = e.target.closest && e.target.closest('button:not(:disabled)');
      if (el && !el.contains(e.relatedTarget)) play('hover');
    });
  }
  // Conecta controles existentes (inputs range 0..100 y checkboxes) por referencia de elemento.
  function bindControls({ master, music, sfx, mute, musicToggle } = {}) {
    const pairs = { master, music, sfx };
    Object.entries(pairs).forEach(([ch, el]) => {
      if (!el) return;
      el.min = '0'; el.max = '100'; el.step = '1'; el.value = String(Math.round(prefs[ch] * 100));
      el.addEventListener('input', () => setVolume(ch, Number(el.value) / 100));
    });
    if (mute) { mute.checked = prefs.muted; mute.addEventListener('change', () => setMuted(mute.checked)); }
    if (musicToggle) { musicToggle.checked = prefs.musicEnabled; musicToggle.addEventListener('change', () => setMusicEnabled(musicToggle.checked)); }
    listeners.add(p => {
      Object.entries(pairs).forEach(([ch, el]) => { if (el && document.activeElement !== el) el.value = String(Math.round(p[ch] * 100)); });
      if (mute) mute.checked = p.muted;
      if (musicToggle) musicToggle.checked = p.musicEnabled;
    });
  }

  // Clasificación visual de tirada (acordado: solo cliente, no altera Gemini ni el veredicto del servidor).
  // resultados: [{caras, valor}]. Devuelve 'critical' | 'fumble' | 'normal'.
  function classifyRoll(resultados) {
    if (!Array.isArray(resultados) || !resultados.length) return 'normal';
    if (resultados.every(r => r && r.valor === r.caras)) return 'critical';
    if (resultados.every(r => r && r.valor === 1)) return 'fumble';
    return 'normal';
  }

  window.CronicasAudio = Object.freeze({
    supported, unlock, play, setMusic, setVolume, setMuted, toggleMute, setMusicEnabled,
    getPrefs, onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    bindUISounds, bindControls, classifyRoll,
    SFX_NAMES: Object.freeze(Object.keys(SFX)), MUSIC_MODES: Object.freeze(MUSIC_MODES.slice())
  });
})();
