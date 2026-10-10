/* TSG フレットトレーナー — 画面・音・マイク・進行 */
(() => {
  'use strict';
  const C = window.FretCore;
  const $ = (s) => document.querySelector(s);
  const MUTE = /[?&]mute=1\b/.test(location.search);

  /* ================= 保存（失敗しても動く） ================= */
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 保存できなくても続行 */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* 続行 */ } }
  };

  const DEFAULTS = { tab: 'stage', strs: [6], notes: '7', mode: 'free', count: '10', bpm: 72, view: 'names', sound: true, input: 'tap', stage: 1, board: '' };
  const CHOICES = { tab: ['stage', 'free'], notes: ['7', '12'], mode: ['free', 'beat'], count: ['10', '20'], view: ['names', 'weak', 'none'], input: ['tap', 'mic'] };
  const saved = store.get('tsgft.settings', {}) || {};
  // 旧設定からの引き継ぎ
  if (saved.view == null && saved.map === false) saved.view = 'none';
  if (!Array.isArray(saved.strs) && saved.strings) saved.strs = saved.strings === 'both' ? [6, 5] : [Number(saved.strings)];
  const settings = Object.assign({}, DEFAULTS, saved);
  delete settings.map; delete settings.strings;
  Object.keys(CHOICES).forEach((k) => { if (!CHOICES[k].includes(String(settings[k]))) settings[k] = DEFAULTS[k]; settings[k] = String(settings[k]); });
  settings.strs = normStrings(settings.strs);
  settings.bpm = Math.min(160, Math.max(40, Math.round(Number(settings.bpm) / 2) * 2 || 72));
  settings.sound = settings.sound !== false;
  settings.stage = Math.min(C.STAGES.length, Math.max(1, Number(settings.stage) || 1));
  if (!['', 'open', 'closed'].includes(settings.board)) settings.board = '';
  const saveSettings = () => store.set('tsgft.settings', settings);

  function normStrings(a) {
    const out = Array.isArray(a) ? [...new Set(a.map(Number).filter((n) => n >= 1 && n <= 6))] : [];
    out.sort((x, y) => y - x);
    return out.length ? out : [6];
  }

  // 音ごとの直近の記録（苦手マップ・出題の重み）
  const STATS_KEY = 'tsgft.stats';
  let stats = store.get(STATS_KEY, {});
  if (!stats || typeof stats !== 'object') stats = {};
  const statKey = (s, pc) => `${s}-${pc}`;

  // ステージの進み具合 { s: { id: { stars, guitar } }, all }
  const PROG_KEY = 'tsgft.progress';
  let progress = store.get(PROG_KEY, null);
  if (!progress || typeof progress !== 'object' || typeof progress.s !== 'object') progress = { s: {}, v: 2 };
  const saveProgress = () => store.set(PROG_KEY, progress);
  // 2026-10-08：先頭に「0〜5フレット」のステージを足して全18ステージにしたので、旧記録の番号を1つずらす
  if (progress.v !== 2) {
    const moved = {};
    Object.keys(progress.s).forEach((k) => { moved[Number(k) + 1] = progress.s[k]; });
    progress = { s: moved, v: 2 };
    saveProgress();
    if (saved.stage) settings.stage = Math.min(C.STAGES.length, settings.stage + 1);
    saveSettings();
  }
  const stageById = (id) => C.STAGES.find((st) => st.id === id);
  const starsOf = (id) => (progress.s[id] && progress.s[id].stars) || 0;
  const isUnlocked = () => true; // どのステージも最初から選べる（2026-10-08 ロック撤廃）
  const totalStars = () => C.STAGES.reduce((a, st) => a + starsOf(st.id), 0);
  const clearedCount = () => C.STAGES.filter((st) => starsOf(st.id) >= 1).length;

  /* ================= 音 ================= */
  // ギター音：Karplus-Strong（弦の物理モデル）＋ボディ共鳴のEQ。クリック：短い木魚風の音
  const Sound = (() => {
    let ctx = null, master = null, guitarIn = null, clickIn = null;
    const cache = new Map();
    const level = () => (MUTE || !settings.sound ? 0 : 1);

    function init() {
      if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return ctx; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { return null; }
      master = ctx.createGain();
      master.gain.value = level();
      master.connect(ctx.destination);
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16; comp.ratio.value = 3; comp.attack.value = 0.003; comp.release.value = 0.2;
      comp.connect(master);
      const eq = (type, f, gain, q) => {
        const b = ctx.createBiquadFilter();
        b.type = type; b.frequency.value = f;
        if (gain != null) b.gain.value = gain;
        if (q != null) b.Q.value = q;
        return b;
      };
      // 音色（2026-10-08 改善）：胴鳴りを足し、耳に刺さる2〜3kHzと高域を抑え、小さな部屋の響きを薄く加える
      const body1 = eq('peaking', 100, 5, 1.1);   // 胴鳴り（低）
      const body2 = eq('peaking', 210, 3.5, 1.3); // 胴鳴り（中低）
      const harsh = eq('peaking', 2700, -5, 0.9); // 硬さの原因の帯域を抑える
      const shelf = eq('highshelf', 5000, -7);    // シャリシャリ感を抑える
      const top = eq('lowpass', 5200, null, 0.6);
      guitarIn = ctx.createGain(); guitarIn.gain.value = 0.8;
      guitarIn.connect(body1); body1.connect(body2); body2.connect(harsh); harsh.connect(shelf); shelf.connect(top);
      top.connect(comp);
      // 残響：減衰するノイズで作った短い部屋の響き（約1秒）を2割ほど混ぜる
      try {
        const len = Math.floor(ctx.sampleRate * 1.1);
        const ir = ctx.createBuffer(2, len, ctx.sampleRate);
        for (let ch = 0; ch < 2; ch++) {
          const d = ir.getChannelData(ch);
          let lpv = 0;
          for (let i = 0; i < len; i++) {
            lpv += 0.35 * ((Math.random() * 2 - 1) - lpv);
            d[i] = lpv * Math.pow(1 - i / len, 2.2) * (i < ctx.sampleRate * 0.008 ? i / (ctx.sampleRate * 0.008) : 1);
          }
        }
        const verb = ctx.createConvolver(); verb.buffer = ir;
        const wet = ctx.createGain(); wet.gain.value = 0.22;
        top.connect(verb); verb.connect(wet); wet.connect(comp);
      } catch (e) { /* 響きなしでも鳴らす */ }
      clickIn = ctx.createGain(); clickIn.gain.value = 0.45;
      clickIn.connect(master);
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }

    function setEnabled() {
      if (master) master.gain.setTargetAtTime(level(), ctx.currentTime, 0.01);
    }

    function buffer(midi) {
      if (cache.has(midi)) return cache.get(midi);
      const sr = ctx.sampleRate;
      const f = 440 * Math.pow(2, (midi - 69) / 12);
      const dur = 2.2;
      const len = Math.floor(sr * dur);
      // 遅延長 D = sr/f を「整数N ＋ 平均フィルタ0.5 ＋ オールパスの端数」で作る
      const D = sr / f;
      let N = Math.floor(D - 0.5);
      let frac = D - N - 0.5;
      if (frac < 0.1) { N -= 1; frac += 1; }
      const apC = (1 - frac) / (1 + frac);
      // 励振：やわらかいノイズ＋ピッキング位置（ブリッジ寄り）の櫛形フィルタ
      const raw = new Float32Array(N);
      let lp = 0;
      const soft = 0.24; // 小さいほど弾いた瞬間がやわらかい（0.5→0.24）
      for (let i = 0; i < N; i++) { lp += soft * ((Math.random() * 2 - 1) - lp); raw[i] = lp; }
      const pick = Math.max(1, Math.round(N * 0.2)); // ピッキング位置を少し指板寄りに（鼻にかかった感じを減らす）
      const line = new Float32Array(N);
      let mean = 0;
      for (let i = 0; i < N; i++) { line[i] = raw[i] - (i >= pick ? raw[i - pick] : 0) * 0.92; mean += line[i]; }
      mean /= N;
      let peak = 0;
      for (let i = 0; i < N; i++) { line[i] -= mean; peak = Math.max(peak, Math.abs(line[i])); }
      for (let i = 0; i < N; i++) line[i] /= peak || 1;
      // 減衰：低い音ほど長く響く
      const t60 = Math.max(1.5, 2.8 - (midi - 40) * 0.03);
      const g = Math.pow(10, -3 / (t60 * f));
      const out = new Float32Array(len);
      let idx = 0, last = 0, apX = 0, apY = 0;
      for (let n = 0; n < len; n++) {
        const y = line[idx];
        const v = g * 0.5 * (y + last);
        last = y;
        const ap = apC * v + apX - apC * apY;
        apX = v; apY = ap;
        line[idx] = ap;
        out[n] = ap;
        idx++; if (idx === N) idx = 0;
      }
      // アタックの角を少し丸め、最後はフェードアウト
      const atk = Math.floor(sr * 0.004);
      for (let i = 0; i < atk; i++) out[i] *= i / atk;
      const rel = Math.floor(sr * 0.5);
      for (let i = 0; i < rel; i++) out[len - 1 - i] *= i / rel;
      const buf = ctx.createBuffer(1, len, sr);
      buf.getChannelData(0).set(out);
      cache.set(midi, buf);
      return buf;
    }

    // 再生前の音源（マイク判定の動作確認でも使う）
    function makeSource(midi) {
      const c = init();
      if (!c) return null;
      const src = c.createBufferSource();
      src.buffer = buffer(midi);
      return src;
    }

    let plucks = 0; // 鳴らした回数（動作確認用）
    function pluck(midi, delay, gain) {
      plucks++;
      const c = init();
      if (!c) return;
      try {
        const src = makeSource(midi);
        if (gain != null && gain !== 1) {
          const gn = c.createGain(); gn.gain.value = gain;
          src.connect(gn); gn.connect(guitarIn);
        } else {
          src.connect(guitarIn);
        }
        src.start(c.currentTime + 0.005 + (delay || 0));
      } catch (e) { /* 音が出せない環境でも練習は続ける */ }
    }

    // コードをジャラーンと鳴らす（低い弦から順に）
    function strum(midis, delay) {
      midis.forEach((m, i) => pluck(m, (delay || 0) + i * 0.03, 0.55));
    }

    // ステージクリアのファンファーレ（ギターのアルペジオ）
    function fanfare() {
      [60, 64, 67].forEach((m, i) => pluck(m, i * 0.11, 0.7));
      strum([48, 55, 60, 64, 67, 72], 0.36);
    }

    function click(when, accent) {
      if (!ctx) return;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(accent ? 2000 : 1400, when);
      o.frequency.exponentialRampToValueAtTime(accent ? 1300 : 950, when + 0.04);
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(accent ? 1 : 0.6, when + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);
      o.connect(g); g.connect(clickIn);
      o.start(when); o.stop(when + 0.08);
    }

    async function ready() {
      const c = init();
      if (!c) return false;
      if (c.state !== 'running') {
        try { await Promise.race([c.resume(), new Promise((r) => setTimeout(r, 400))]); } catch (e) { /* 無音で続行 */ }
      }
      return c.state === 'running';
    }

    return { init, pluck, strum, fanfare, click, ready, setEnabled, makeSource, get ctx() { return ctx; }, get plucks() { return plucks; } };
  })();

  // 4拍練習の時計：音が使えるときはオーディオの時計、使えないときは画面の時計
  const Clock = {
    audio: false,
    now() { return this.audio && Sound.ctx ? Sound.ctx.currentTime : performance.now() / 1000; }
  };

  /* ================= マイク（ギターで弾いて答える） =================
     TSGチューナーと同じ考え方：エコー除去などはオフ、ハイパス＋ローパスで整えてから MPM で音程を出す。
     「弾いた瞬間（アタック）」のあとに同じ音が3回続けて聞こえたら判定する。
     アタックは低い帯域（〜700Hz）の音量の跳ね上がりで見るので、高いクリック音には反応しにくい。 */
  const Mic = (() => {
    const TEST = /[?&]mictest=1\b/.test(location.search);
    const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    let ctx = null, input = null, an = null, anLow = null, buf = null, bufLow = null;
    let stream = null, src = null, boost = null, active = false, raf = 0;
    let prevLow = null, noise = null, noiseLow = null, attackAt = -1, attackPeak = 0, attackPeakAll = 0, armedAt = Infinity, cand = null;
    // 判定の条件（2026-10-08 フレットノイズ対策）
    const HOLD_OK = 0.12; // 正解：同じ高さがこの秒数、安定して続いたら判定
    const HOLD_NG = 0.25; // 不正解：さらに長く・はっきり続いたときだけ（ノイズで「不正解」にしない）
    const SKIP = 0.04;    // 弾いた直後の雑音（ピックや指が当たる音）は見ない
    const CONF = 0.9;     // 音程のはっきりさ（0〜1）
    const FADE = 0.15;    // 弾いた直後の大きさの1.5割より小さくなったら「すぐ消えた音」として捨てる（高い音は減り方が速いので緩めに）
    let onDetect = null, onLive = null, expect = [];

    function build() {
      ctx = Sound.init();
      if (!ctx) throw new Error('audio');
      if (input) return;
      const bq = (type, f) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; return b; };
      input = ctx.createGain();
      const hp = bq('highpass', 50), lp = bq('lowpass', 2000);
      an = ctx.createAnalyser(); an.fftSize = 4096;
      input.connect(hp); hp.connect(lp); lp.connect(an);
      const l1 = bq('lowpass', 700), l2 = bq('lowpass', 700);
      anLow = ctx.createAnalyser(); anLow.fftSize = 1024;
      input.connect(l1); l1.connect(l2); l2.connect(anLow);
      buf = new Float32Array(an.fftSize);
      bufLow = new Float32Array(anLow.fftSize);
    }

    async function start() {
      build();
      if (!TEST && !stream) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('nomic');
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false
        });
        src = ctx.createMediaStreamSource(stream);
        boost = ctx.createGain();
        boost.gain.value = isIOS ? 20 : 10; // 生音の小さいギターも拾えるよう底上げ（波形の形は変えない）
        src.connect(boost); boost.connect(input);
        stream.getTracks().forEach((t) => { t.onended = () => { if (active) toast('マイクが止まりました。タップで答えてください'); }; });
      }
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) { /* 続行 */ } }
      active = true;
      prevLow = null; noise = null; noiseLow = null; attackAt = -1; armedAt = Infinity; cand = null;
      cancelAnimationFrame(raf);
      loop();
    }

    function stop() {
      active = false;
      cancelAnimationFrame(raf);
      onDetect = null; onLive = null;
      if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
      try { if (src) src.disconnect(); if (boost) boost.disconnect(); } catch (e) { /* 続行 */ }
      src = null; boost = null;
    }

    const arm = (fn, since, freqs) => { onDetect = fn; armedAt = since; attackAt = -1; cand = null; expect = freqs || []; };
    const disarm = () => { onDetect = null; armedAt = Infinity; };
    const live = (fn) => { onLive = fn; };

    function rmsOf(b) { let s = 0; for (let i = 0; i < b.length; i++) s += b[i] * b[i]; return Math.sqrt(s / b.length); }

    function loop() {
      if (!active) return;
      raf = requestAnimationFrame(loop);
      frame();
    }

    function frame() {
      an.getFloatTimeDomainData(buf);
      anLow.getFloatTimeDomainData(bufLow);
      const rms = rmsOf(buf), low = rmsOf(bufLow);
      const now = Clock.now();
      // 環境ノイズ：静かになると即下がり、鳴っている間はゆっくりしか上がらない
      noise = noise === null || rms < noise ? rms : Math.min(noise * 1.005, rms);
      noiseLow = noiseLow === null || low < noiseLow ? low : Math.min(noiseLow * 1.005, low);
      // 弾いた瞬間（アタック）：低い帯域の音量が急に、しかも環境ノイズよりはっきり大きく跳ね上がったとき
      if (prevLow !== null && low > prevLow * 1.8 && low > Math.max(0.006, noiseLow * 6)) { attackAt = now; attackPeak = low; attackPeakAll = rms; cand = null; }
      else if (attackAt >= 0) { if (low > attackPeak) attackPeak = low; if (rms > attackPeakAll) attackPeakAll = rms; }
      prevLow = low;
      const floor = Math.max(0.006, Math.min(0.05, noise * 5));
      const res = C.detectPitch(buf, ctx.sampleRate, 70, 1400, rms, floor);
      let freq = res && res.confidence >= CONF ? res.freq : null;
      const judging = onDetect && attackAt >= armedAt - 0.05;
      // すぐ消える音（こすれ・キュッ・打撃）は判定に使わない
      // （低い帯域と全体の両方で小さくなったときだけ。高い音は低い帯域では小さく見えるため）
      const fading = attackAt >= 0 && low < attackPeak * FADE && rms < attackPeakAll * FADE;
      // 判定待ちの間だけ、倍音を音程と取り違えていないか確かめて基音を決め直す（計算が重いので常時はしない）
      if (freq && judging && !fading) freq = C.decideFundamental(buf, ctx.sampleRate, freq);
      const mf = freq ? C.freqToMidi(freq) : null;
      if (onLive) onLive(Math.min(1, rms * 8), mf == null ? null : Math.round(mf));
      if (!judging) return;
      if (fading) { cand = null; return; }
      if (mf === null || now - attackAt < SKIP) {
        // 一瞬だけ音程が取れない程度なら続ける。0.06秒以上途切れたら最初から
        if (cand && now - cand.last > 0.06) cand = null;
        return;
      }
      if (cand && Math.abs(cand.mf - mf) < 0.35) { cand.n++; cand.last = now; cand.mf = (cand.mf * 3 + mf) / 4; }
      else cand = { mf, start: now, last: now, n: 1 };
      const held = now - cand.start;
      if (held < HOLD_OK || cand.n < 5) return;
      // 出題の音と照合：半音の0.75以内（チューニングのずれは甘く）／倍音だけ拾った場合も正解。オクターブ違いは不正解
      const hit = expect.some((fe) => C.heardMatches(buf, ctx.sampleRate, freq, fe));
      if (!hit && (held < HOLD_NG || cand.n < 10)) return;
      const fn = onDetect, at = attackAt;
      disarm();
      fn({ midi: Math.round(mf), correct: hit }, at);
    }

    // 動作確認用：合成したギター音をマイクの代わりに入れる（?mictest=1 のときだけ使う）
    function testPlay(midi) {
      build();
      const s = Sound.makeSource(midi);
      if (s) { s.connect(input); s.start(); }
    }

    // 動作確認用：フレットノイズ風の音（キュッ・カチッ・こすれ・スライド）を入れる
    function testNoise(kind) {
      build();
      const sr = ctx.sampleRate;
      const dur = { squeak: 0.07, tap: 0.06, rub: 0.04, slide: 0.12 }[kind] || 0.06;
      const len = Math.floor(sr * dur);
      const b = ctx.createBuffer(1, len, sr);
      const d = b.getChannelData(0);
      let ph = 0, lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len, env = Math.sin(Math.PI * Math.min(1, t * 1.2)) * (1 - t);
        if (kind === 'squeak') { ph += 2 * Math.PI * (900 + 500 * t) / sr; d[i] = 0.35 * env * Math.sin(ph); }
        else if (kind === 'slide') { ph += 2 * Math.PI * (300 + 220 * t) / sr; d[i] = 0.25 * env * Math.sin(ph); }
        else if (kind === 'rub') { lp += 0.3 * ((Math.random() * 2 - 1) - lp); d[i] = 0.6 * env * lp; }
        else { d[i] = 0.5 * Math.exp(-i / (sr * 0.012)) * Math.sin(2 * Math.PI * 196 * i / sr); } // tap：すぐ止まる短い音
      }
      const src = ctx.createBufferSource(); src.buffer = b; src.connect(input); src.start();
    }

    return { start, stop, arm, disarm, live, testPlay, testNoise, TEST, get active() { return active; } };
  })();

  let toastTimer = 0;
  function toast(msg) {
    let t = $('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }

  /* ================= 状態 ================= */
  const S = {
    phase: 'setup',   // setup | quiz | result
    sub: null,        // count | ask | review
    round: null,
    questions: [], qi: 0, results: [],
    marks: [],
    qShownAt: 0, locked: true,
    beat: null, raf: 0, sched: 0, timer: 0, token: 0,
    lastBeatIdx: -2,
    selected: -1
  };

  const STRING_COLOR = { 6: '#2176ae', 5: '#d9822b', 4: '#138d90', 3: '#7d4fb0', 2: '#c2417f', 1: '#8a6d1f' };
  const STRING_LABEL = { 6: '#8fc3ea', 5: '#f0b87a', 4: '#7fd6d0', 3: '#c7a6ec', 2: '#f0a3c6', 1: '#e0c77a' };
  const STRING_NAME = (s) => `${s}弦`;
  const fretText = (frets) => frets.length > 1 ? `開放（0）と ${frets[1]}フレット` : (frets[0] === 0 ? '開放（0）' : `${frets[0]}フレット`);
  const posText = (s, f) => f === 0 ? `${s}弦 開放` : `${s}弦 ${f}フレット`;
  function stringsLabel(a) {
    if (a.length === 6) return '全弦';
    if (a.length === 1) return `${a[0]}弦`;
    const sorted = [...a].sort((x, y) => y - x);
    const consecutive = sorted.every((v, i) => i === 0 || sorted[i - 1] - v === 1);
    if (consecutive && a.length > 2) return `${sorted[0]}〜${sorted[sorted.length - 1]}弦`;
    return sorted.join('・') + '弦';
  }
  const modeLabel = (cfg) => `${cfg.maxFret != null ? `0〜${cfg.maxFret}F・` : ''}${cfg.notes === '12' ? '12音' : '7音'}・${cfg.mode === 'beat' ? '4拍 ♩' + cfg.bpm : 'じっくり'}${cfg.count === 20 ? '・20問' : ''}`;
  const starHTML = (n) => '★'.repeat(n) + `<span class="off">${'★'.repeat(3 - n)}</span>`;

  // その位置の音名表示。出題と同じ音なら出題の表記（♯/♭）に合わせる
  function labelAt(s, f, q) {
    const pc = C.pcOf(s, f);
    if (q && pc === q.pc) return [q.name];
    const n = C.names(pc);
    return n.length > 1 ? n : [n[0]];
  }
  const nameText = (lines) => lines.join('/');
  const midiText = (m) => { const l = C.midiLabel(m); return `${l.name}${l.oct}`; };
  // ♯・♭は数字用フォントだと崩れるので、小さく右上に添える
  const noteHTML = (name) => (name.length > 1 ? `${name[0]}<span class="acc">${name.slice(1)}</span>` : name);
  function noteText(t, name) {
    t.textContent = name[0];
    if (name.length > 1) {
      const sp = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
      sp.setAttribute('font-size', '68%');
      sp.setAttribute('font-family', 'system-ui, sans-serif');
      sp.setAttribute('dy', '-0.28em');
      sp.textContent = name.slice(1);
      t.appendChild(sp);
    }
  }

  /* ================= 指板の描画 ================= */
  const NS = 'http://www.w3.org/2000/svg';
  const svg = $('#board');
  const wrap = $('#boardWrap');
  let G = null;

  function mk(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  const isVertical = () => window.innerWidth < 640 && window.innerHeight >= window.innerWidth;

  // 今の画面で練習する弦と音
  function viewCfg() {
    if (S.round && S.phase !== 'setup') return S.round;
    if (settings.tab === 'stage') return stageById(settings.stage);
    return { strings: settings.strs, notes: settings.notes };
  }
  const activeStrings = () => viewCfg().strings;
  const maxFretNow = () => (viewCfg().maxFret == null ? 12 : viewCfg().maxFret);
  const notePcs = () => (viewCfg().notes === '12' ? C.ALL_PCS : C.NATURAL_PCS);

  function geometry() {
    const vertical = isVertical();
    const W = Math.max(260, Math.floor(wrap.clientWidth));
    const wires = C.fretWirePositions(0.5);
    const d = wires[12] - wires[11];
    const g = { vertical, W, wires };
    if (!vertical) {
      g.H = Math.round(Math.min(330, Math.max(220, W * 0.34)));
      if (S.phase === 'quiz') {
        const avail = window.innerHeight - wrap.getBoundingClientRect().top - 14;
        if (avail < g.H) g.H = Math.round(Math.max(170, avail));
      }
      g.labelZone = 24;
      g.b0 = 4;
      g.gap = (g.H - g.b0 - g.labelZone) / 6;
      g.openStart = 2;
      g.openW = Math.min(58, Math.max(38, W * 0.06));
      g.nut = g.openStart + g.openW;
      g.L = (W - g.nut - 8) / (1 + 0.5 * d);
    } else {
      const top = wrap.getBoundingClientRect().top;
      const avail = window.innerHeight - top - 16;
      g.H = Math.round(Math.min(660, Math.max(S.phase === 'quiz' ? 340 : 400, avail)));
      g.labelZone = 26;
      g.b0 = g.labelZone;
      g.gap = (W - g.b0 - 4) / 6;
      g.openStart = 2;
      g.openW = Math.min(46, Math.max(34, g.H * 0.065));
      g.nut = g.openStart + g.openW;
      g.L = (g.H - g.nut - 6) / (1 + 0.5 * d);
    }
    g.b1 = g.b0 + 6 * g.gap;
    g.end = g.nut + g.L * (1 + 0.5 * d);
    const minCell = d * g.L;
    g.r = Math.min(g.gap * 0.42, minCell * 0.47, 22);
    return g;
  }

  const wireAt = (n) => (n === 0 ? G.nut : G.nut + G.wires[n] * G.L);
  const cellMid = (f) => (f === 0 ? G.openStart + G.openW / 2 - 2 : (wireAt(f - 1) + wireAt(f)) / 2);
  const cellRange = (f) => (f === 0 ? [0, G.nut] : [wireAt(f - 1), wireAt(f)]);
  const stringPos = (s) => G.b0 + G.gap * ((G.vertical ? 6 - s : s - 1) + 0.5);
  const pt = (along, across) => (G.vertical ? [across, along] : [along, across]);
  function rectAttrs(a0, a1, c0, c1) {
    return G.vertical
      ? { x: c0, y: a0, width: c1 - c0, height: a1 - a0 }
      : { x: a0, y: c0, width: a1 - a0, height: c1 - c0 };
  }
  function lineAttrs(a0, a1, c0, c1) {
    const p = pt(a0, c0), q = pt(a1, c1);
    return { x1: p[0], y1: p[1], x2: q[0], y2: q[1] };
  }

  function renderBoard() {
    G = geometry();
    const W = G.W;
    const H = G.H;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.textContent = '';
    const act = activeStrings();

    const defs = mk('defs', {}, svg);
    const wood = mk('linearGradient', G.vertical ? { id: 'wood', x1: 0, y1: 0, x2: 1, y2: 0 } : { id: 'wood', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    mk('stop', { offset: '0', 'stop-color': '#3d2b22' }, wood);
    mk('stop', { offset: '.5', 'stop-color': '#4a3428' }, wood);
    mk('stop', { offset: '1', 'stop-color': '#35251d' }, wood);

    // ヘッド側（開放弦の場所）と指板
    mk('rect', Object.assign(rectAttrs(0, G.nut, G.b0, G.b1), { fill: '#ece7dd', rx: 6 }), svg);
    mk('rect', Object.assign(rectAttrs(G.nut, G.end, G.b0, G.b1), { fill: 'url(#wood)' }), svg);

    // ポジションマーク
    const inlayR = Math.min(G.gap * 0.2, 7);
    [3, 5, 7, 9].forEach((f) => {
      const p = pt(cellMid(f), G.b0 + G.gap * 3);
      mk('circle', { cx: p[0], cy: p[1], r: inlayR, fill: '#e8e0cc', opacity: 0.85 }, svg);
    });
    [2, 4].forEach((k) => {
      const p = pt(cellMid(12), G.b0 + G.gap * k);
      mk('circle', { cx: p[0], cy: p[1], r: inlayR, fill: '#e8e0cc', opacity: 0.85 }, svg);
    });

    // 練習する弦のレーン（弦ごとの色。出題中は聞かれている弦だけ濃く）
    const cur = S.phase === 'quiz' ? S.questions[S.qi] : null;
    act.forEach((s) => {
      const c = stringPos(s);
      const dim = cur && act.length > 1 && cur.string !== s;
      mk('rect', Object.assign(rectAttrs(G.openStart, G.end, c - G.gap * 0.46, c + G.gap * 0.46), { fill: STRING_COLOR[s], opacity: dim ? 0.12 : 0.34, rx: 4 }), svg);
    });

    // フレット・ナット
    for (let n = 1; n <= 12; n++) {
      mk('line', Object.assign(lineAttrs(wireAt(n), wireAt(n), G.b0, G.b1), { stroke: '#c9ccd3', 'stroke-width': n === 12 ? 3.5 : 3 }), svg);
    }
    mk('rect', Object.assign(rectAttrs(G.nut - 6, G.nut, G.b0 - 1, G.b1 + 1), { fill: '#f6efdc', stroke: '#d8cdb2', 'stroke-width': 1 }), svg);

    // 弦
    const widths = { 1: 1.1, 2: 1.4, 3: 1.8, 4: 2.3, 5: 2.8, 6: 3.4 };
    for (let s = 1; s <= 6; s++) {
      const c = stringPos(s);
      const on = act.includes(s);
      mk('line', Object.assign(lineAttrs(G.openStart + 4, G.end, c, c), {
        stroke: s >= 4 ? '#d6c398' : '#e3e6ec',
        'stroke-width': widths[s],
        opacity: on ? 1 : 0.4
      }), svg);
    }

    // 出題範囲の外（例：ST1は6フレットより先）を暗くする
    if (maxFretNow() < 12) {
      mk('rect', Object.assign(rectAttrs(wireAt(maxFretNow()), G.end, G.b0, G.b1), { fill: '#0d0d18', opacity: 0.55 }), svg);
    }

    // 弦番号（12フレットの先）
    act.forEach((s) => {
      const p = pt((wireAt(12) + G.end) / 2, stringPos(s));
      const t = mk('text', { x: p[0], y: p[1], 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'fretnum', style: `font-size:11px;font-weight:600;fill:${STRING_LABEL[s]}` }, svg);
      t.textContent = s;
    });

    // フレット番号
    for (let f = 0; f <= 12; f++) {
      const isMark = [3, 5, 7, 9, 12].includes(f);
      const across = G.vertical ? G.labelZone / 2 : G.b1 + G.labelZone / 2 + 2;
      const p = pt(cellMid(f), across);
      const t = mk('text', { x: p[0], y: p[1], 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'fretnum' + (isMark ? ' mark' : '') }, svg);
      t.textContent = f;
    }

    // タップの当たり判定（練習する弦だけ。となりも練習する弦なら半分ずつ、そうでなければ広めに）
    act.forEach((s) => {
      const c = stringPos(s);
      let lo = c, hi = c;
      [s - 1, s + 1].forEach((n) => {
        const ext = act.includes(n) ? 0.5 : 0.9;
        const side = n >= 1 && n <= 6 ? Math.sign(stringPos(n) - c) : (G.vertical ? (n > 6 ? -1 : 1) : (n < 1 ? -1 : 1));
        if (side < 0) lo = c - G.gap * ext; else hi = c + G.gap * ext;
      });
      for (let f = 0; f <= 12; f++) {
        const [a0, a1] = cellRange(f);
        const r = mk('rect', Object.assign(rectAttrs(a0, a1, lo, hi), {
          class: 'hitbox', 'data-s': s, 'data-f': f, role: 'button', 'aria-label': posText(s, f)
        }), svg);
        r.addEventListener('click', onBoardTap);
      }
    });

    // マーカー
    const layer = mk('g', {}, svg);
    S.marks.forEach((m) => drawMark(layer, m));
  }

  const MARK_STYLE = {
    map:    { fill: '#ffffff', text: '#1a1a2e', stroke: 'none', scale: 0.86 },
    mapacc: { fill: '#d5d9e2', text: '#1a1a2e', stroke: 'none', scale: 0.72 },
    flash:  { fill: '#ffffff', text: '#1a1a2e', stroke: '#1a1a2e', scale: 0.95 },
    hit:    { fill: '#27ae60', text: '#ffffff', stroke: '#ffffff', scale: 1 },
    miss:   { fill: '#c0392b', text: '#ffffff', stroke: '#ffffff', scale: 1 },
    answer: { fill: '#27ae60', text: '#ffffff', stroke: '#ffffff', scale: 1, ring: true },
    alt:    { fill: '#ffffff', text: '#27ae60', stroke: '#27ae60', scale: 0.92 },
    resok:  { fill: '#27ae60', text: '#ffffff', stroke: '#ffffff', scale: 0.9 },
    resng:  { fill: '#c0392b', text: '#ffffff', stroke: '#ffffff', scale: 0.95 },
    focus:  { fill: '#27ae60', text: '#ffffff', stroke: '#ffffff', scale: 1, ring: true },
    shape:  { fill: '#ffffff', text: '#1a1a2e', stroke: '#1a1a2e', scale: 0.62 },
    partner:{ fill: '#ffffff', text: '#1a1a2e', stroke: '#27ae60', scale: 0.86 },
    wgood:  { fill: '#27ae60', text: '#ffffff', stroke: '#ffffff', scale: 0.86 },
    wsoso:  { fill: '#e2a10f', text: '#1a1a2e', stroke: '#ffffff', scale: 0.86 },
    wweak:  { fill: '#c0392b', text: '#ffffff', stroke: '#ffffff', scale: 0.92 },
    wnew:   { fill: '#d5d9e2', text: '#5a6072', stroke: 'none', scale: 0.78 }
  };

  function drawMark(layer, m) {
    const p = pt(cellMid(m.fret), stringPos(m.string));
    const g = mk('g', { class: 'mk mk-' + m.kind, transform: `translate(${p[0].toFixed(1)},${p[1].toFixed(1)})` }, layer);
    if (m.kind === 'mute') {
      const t = mk('text', { y: 0.5, 'text-anchor': 'middle', 'dominant-baseline': 'central', fill: '#c0392b', 'font-size': (G.r * 1.1).toFixed(1) }, g);
      t.textContent = '×';
      return;
    }
    const st = MARK_STYLE[m.kind];
    const r = G.r * st.scale;
    if (st.ring) mk('circle', { r: r, fill: 'none', stroke: '#2ecc71', 'stroke-width': 3, class: 'ring' }, g);
    const pop = mk('g', { class: 'pop' }, g);
    mk('circle', { r: r, fill: st.fill, stroke: st.stroke, 'stroke-width': st.stroke === 'none' ? 0 : 2 }, pop);
    const lines = m.label || [];
    if (lines.length === 1) {
      const fs = r * (lines[0].length > 1 ? 1.0 : 1.12);
      const t = mk('text', { y: 0.5, 'text-anchor': 'middle', 'dominant-baseline': 'central', fill: st.text, 'font-size': fs.toFixed(1) }, pop);
      noteText(t, lines[0]);
    } else if (lines.length > 1) {
      const fs = r * 0.66;
      lines.forEach((ln, i) => {
        const t = mk('text', { y: ((i - 0.5) * fs * 1.05).toFixed(1), 'text-anchor': 'middle', 'dominant-baseline': 'central', fill: st.text, 'font-size': fs.toFixed(1) }, pop);
        noteText(t, ln);
      });
    }
    if (m.kind === 'miss') {
      // ✕印（色覚に頼らない）
      const k = r * 0.32, ox = r * 0.78, oy = -r * 0.78;
      const x = mk('g', { transform: `translate(${ox},${oy})` }, pop);
      mk('circle', { r: k * 1.25, fill: '#fff' }, x);
      mk('path', { d: `M${-k / 1.6},${-k / 1.6}L${k / 1.6},${k / 1.6}M${k / 1.6},${-k / 1.6}L${-k / 1.6},${k / 1.6}`, stroke: '#c0392b', 'stroke-width': 2, 'stroke-linecap': 'round' }, x);
    }
  }

  function mapMarks() {
    const out = [];
    const pcs = notePcs();
    activeStrings().forEach((s) => {
      for (let f = 0; f <= maxFretNow(); f++) {
        const pc = C.pcOf(s, f);
        if (!pcs.includes(pc)) continue;
        out.push({ string: s, fret: f, kind: C.isNatural(pc) ? 'map' : 'mapacc', label: C.names(pc) });
      }
    });
    return out;
  }

  function weakMarks() {
    const out = [];
    const kind = { good: 'wgood', soso: 'wsoso', weak: 'wweak', new: 'wnew' };
    activeStrings().forEach((s) => {
      notePcs().forEach((pc) => {
        const w = C.weakness(stats[statKey(s, pc)]);
        C.answerFrets(s, pc).filter((f) => f <= maxFretNow()).forEach((f) => out.push({ string: s, fret: f, kind: kind[w.level], label: C.names(pc) }));
      });
    });
    return out;
  }

  const poolHasStats = () => activeStrings().some((s) => notePcs().some((pc) => (stats[statKey(s, pc)] || []).length));

  /* ================= 画面の更新 ================= */
  function setPhase(p) {
    S.phase = p;
    document.body.dataset.phase = p;
    if (p !== 'setup') $('.board-card').classList.remove('closed');
  }

  const SPEAKER_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/></svg>';
  const SPEAKER_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none"/><path d="M17 9l5 6M22 9l-5 6"/></svg>';
  function renderSoundBtn() {
    const b = $('#soundBtn');
    b.innerHTML = settings.sound ? SPEAKER_ON : SPEAKER_OFF;
    b.setAttribute('aria-pressed', String(settings.sound));
    b.title = settings.sound ? '音：オン（タップでオフ）' : '音：オフ（タップでオン）';
  }

  function renderSetup() {
    const tab = settings.tab;
    $('#tabStage').setAttribute('aria-selected', String(tab === 'stage'));
    $('#tabFree').setAttribute('aria-selected', String(tab === 'free'));
    $('#stagePane').hidden = tab !== 'stage';
    $('#freePane').hidden = tab !== 'free';
    document.querySelectorAll('.seg').forEach((seg) => {
      const key = seg.dataset.key;
      seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === settings[key])));
    });
    $('#micNote').hidden = settings.input !== 'mic';
    if (tab === 'stage') renderStages(); else renderFree();
    renderBoardView();
  }

  function renderFree() {
    document.querySelectorAll('#strChips .chip').forEach((b) => b.setAttribute('aria-pressed', String(settings.strs.includes(Number(b.dataset.s)))));
    $('#tempoBox').hidden = settings.mode !== 'beat';
    $('#bpmVal').textContent = settings.bpm;
    $('#bpmRange').value = settings.bpm;
    $('#tempoNote').textContent = `1問 ＝ 4拍 ＝ ${(240 / settings.bpm).toFixed(1)}秒以内に答える。答えのあと、次の小節の頭で次の問題。`;
    $('#startSub').textContent = poolHasStats() ? '苦手な音を多めに出題します' : stringsLabel(settings.strs);
    renderBest();
  }

  const CH_SHORT = { 1: '6・5弦', 2: '4弦', 3: '3弦', 4: '2弦', 5: '1弦・全弦' };

  function renderStages() {
    const total = C.STAGES.length;
    $('#stTotal').innerHTML = `<span class="star">★</span> <b>${totalStars()}</b> / ${total * 3}　クリア <b>${clearedCount()}</b> / ${total}`;

    // ステージマップ：章ごとに小さなマスを並べる（PCは1行、スマホは折り返し）
    let html = '';
    Object.keys(C.CHAPTERS).forEach((ch) => {
      html += `<div class="st-group"><div class="st-group-lbl"><b>CH${ch}</b>${CH_SHORT[ch]}</div><div class="st-nodes">`;
      C.STAGES.filter((x) => String(x.ch) === ch).forEach((x) => {
        const open = isUnlocked(x.id);
        const n = starsOf(x.id);
        const cls = ['st-node', open ? '' : 'locked', x.id === settings.stage ? 'sel' : '', n ? 'cleared' : '', x.final ? 'final' : ''].join(' ');
        const tip = `ステージ${x.id}：${stringsLabel(x.strings)}・${modeLabel(x)}${open ? '' : '（未開放）'}`;
        html += `<button type="button" class="${cls}" data-id="${x.id}" title="${tip}" aria-label="${tip}">` +
          (x.mode === 'beat' ? '<span class="b">♩</span>' : '') +
          (progress.s[x.id] && progress.s[x.id].guitar ? '<span class="gt">🎸</span>' : '') +
          `<span class="n">${x.id}</span><span class="s">${open ? starHTML(n) : '🔒'}</span></button>`;
      });
      html += '</div></div>';
    });
    $('#stMap').innerHTML = html;
    $('#stMap').querySelectorAll('.st-node').forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.dataset.id);
      if (!isUnlocked(id)) { toast(`ステージ${id - 1}をクリアすると開きます`); return; }
      settings.stage = id;
      saveSettings();
      renderSetup();
    }));

    // 選んだステージ：説明とスタートを1枚の帯に
    if (!isUnlocked(settings.stage)) settings.stage = 1;
    const st = stageById(settings.stage);
    const chips = st.strings.map((s) => `<i style="background:${STRING_COLOR[s]}">${s}</i>`).join('');
    const guitar = progress.s[st.id] && progress.s[st.id].guitar ? ' ・ 🎸ギターでクリア済み' : '';
    $('#stDetail').innerHTML =
      `<div class="st-d-main">` +
        `<div class="st-d-head"><span class="st-num">STAGE ${st.id}${st.final ? ' FINAL' : ''}</span>` +
        `<span class="st-d-strings">${chips}</span>` +
        `<span class="st-d-title">${stringsLabel(st.strings)} ／ ${modeLabel(st)}</span>` +
        `<span class="st-d-stars" aria-label="星${starsOf(st.id)}つ">${starHTML(starsOf(st.id))}</span></div>` +
        `<p class="st-d-intro">${st.intro}</p>` +
        `<div class="st-d-rule">${st.count}問中${C.clearLine(st.count)}問正解でクリア・全問正解で★3${guitar}</div>` +
      `</div>` +
      `<button class="start" id="stStart" type="button">スタート<small>${settings.input === 'mic' ? '🎸 ギターで弾く' : '👆 タップで答える'}</small></button>`;
    $('#stStart').addEventListener('click', () => { Sound.init(); startRound(cfgForStage(st.id)); });
  }

  // 設定画面の指板は開け閉めできる（PCは開いた状態、スマホは閉じた状態から。選んだ状態は覚える）
  const boardOpen = () => (settings.board === 'open' ? true : settings.board === 'closed' ? false : !isVertical());

  function renderBoardView() {
    const open = boardOpen();
    const card = $('.board-card');
    card.classList.toggle('closed', !open);
    const t = $('#boardToggle');
    t.textContent = open ? '閉じる ▲' : '指板で音名を見る ▼';
    t.setAttribute('aria-expanded', String(open));
    $('#boardTitle').textContent = settings.tab === 'stage' ? `指板（ステージ${settings.stage}の弦）` : '指板';
    if (settings.view === 'names') {
      S.marks = mapMarks();
      $('#legend').innerHTML = '';
      $('#boardCap').textContent = 'さわると音が鳴ります。覚えたら「なし」にして、目印（3・5・7・9・12フレット）から位置を思い出そう。';
    } else if (settings.view === 'weak') {
      S.marks = weakMarks();
      $('#legend').innerHTML = '<span><i style="background:var(--green)"></i>得意</span><span><i style="background:var(--amber)"></i>もう少し</span><span><i style="background:var(--red)"></i>苦手</span><span><i style="background:#d5d9e2"></i>まだ</span>';
      $('#boardCap').textContent = poolHasStats()
        ? '直近の答えから色分けしています。赤い音ほど多めに出題されます。'
        : 'まだ記録がありません。練習すると、音ごとの得意・苦手がここに色で出ます。';
    } else {
      S.marks = [];
      $('#legend').innerHTML = '';
      $('#boardCap').textContent = 'さわると音名と音を確かめられます。';
    }
    if (open) renderBoard();
  }

  const bestKey = () => `tsgft.best.${settings.strs.join('')}.${settings.notes}.${settings.mode}.${settings.count}`;
  function renderBest() {
    const b = store.get(bestKey(), null);
    const box = $('#bestBox');
    if (!b) { box.innerHTML = 'この設定の<br>ベスト記録：まだなし'; return; }
    const extra = b.bpm ? ` ♩=${b.bpm}` : (b.avgTime != null ? ` 平均${b.avgTime.toFixed(1)}秒` : '');
    box.innerHTML = `この設定のベスト<br><b>${b.correct}/${b.total}</b>${extra}`;
  }

  function renderDots() {
    const d = $('#dots');
    d.innerHTML = S.questions.map((q, i) => {
      const r = S.results[i];
      const cls = r ? (r.correct ? 'ok' : 'ng') : (i === S.qi ? 'cur' : '');
      return `<i class="${cls}"></i>`;
    }).join('');
    const st = S.round && S.round.stageId ? `<small>ST${S.round.stageId}　</small>` : '';
    $('#counter').innerHTML = `${st}${Math.min(S.qi + 1, S.questions.length)}<small> / ${S.questions.length}</small>`;
  }

  function renderQuestionCard(q) {
    const el = $('#qMain');
    el.innerHTML =
      `<span class="sbadge s${q.string}">${q.string}<small>弦</small></span>` +
      `<span class="q-of">の</span>` +
      `<span class="q-note"><span class="nm">${noteHTML(q.name)}</span><span class="kn">${q.kana}</span></span>` +
      `<span class="q-ask">はどこ？</span>`;
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  }

  function setFeedback(html, showNext) {
    $('#fbText').innerHTML = html;
    $('#nextBtn').hidden = !showNext;
  }

  const MIC_LIVE = (text) => `<span class="mic-live"><span class="lv"><i id="micLv"></i></span>🎤 ${text} <span class="hz" id="micHz">—</span></span>`;
  function onMicLive(level, midi) {
    const lv = $('#micLv'), hz = $('#micHz');
    if (lv) lv.style.width = `${Math.round(level * 100)}%`;
    if (hz) { const t = midi == null ? '—' : C.names(((midi % 12) + 12) % 12)[0]; if (hz.textContent !== t) hz.textContent = t; }
  }

  /* ================= 進行 ================= */
  function stopEngine() {
    S.token++;
    cancelAnimationFrame(S.raf); S.raf = 0;
    clearInterval(S.sched); S.sched = 0;
    clearTimeout(S.timer); S.timer = 0;
    S.beat = null;
    Mic.disarm();
  }

  function cfgForStage(id) {
    const st = stageById(id);
    return { stageId: id, strings: st.strings, notes: st.notes, mode: st.mode, bpm: st.bpm || 72, count: st.count, maxFret: st.maxFret, focus: null };
  }
  function cfgForFree() {
    return { stageId: null, strings: settings.strs.slice(), notes: settings.notes, mode: settings.mode, bpm: settings.bpm, count: Number(settings.count), focus: null };
  }
  // まちがえた音だけ（練習扱い：ステージの★には数えない）
  function cfgForFocus(base, missed) {
    return Object.assign({}, base, { stageId: null, fromStage: base.stageId || base.fromStage || null, focus: missed, count: Math.min(20, Math.max(4, missed.length * 2)) });
  }

  async function startRound(cfg) {
    stopEngine();
    S.round = Object.assign({}, cfg, { input: settings.input });
    S.questions = C.buildQuestions({
      strings: cfg.strings, noteSet: cfg.notes, count: cfg.count, focus: cfg.focus, maxFret: cfg.maxFret,
      weight: cfg.focus ? null : (it) => C.weightOf(stats[statKey(it.string, it.pc)])
    });
    S.qi = 0; S.results = []; S.marks = []; S.locked = true; S.sub = null; S.selected = -1;
    setPhase('quiz');
    $('#beats').hidden = S.round.mode !== 'beat';
    $('#boardCap').innerHTML = '';
    $('#qMain').innerHTML = `<span class="q-count">${S.round.stageId ? `ステージ${S.round.stageId}　` : ''}準備中…</span>`;
    setFeedback(S.round.input === 'mic' ? '<span class="hint">🎤 マイクを準備しています…（許可を求められたら「許可」を押してください）</span>' : '', false);
    renderDots();
    window.scrollTo(0, 0);
    renderBoard();
    const token = ++S.token;
    if (S.round.input === 'mic') {
      try {
        await Mic.start();
        Mic.live(onMicLive);
      } catch (e) {
        S.round.input = 'tap';
        toast('マイクが使えなかったので、タップで答えるモードにしました');
      }
    }
    const running = await Sound.ready();
    if (token !== S.token || S.phase !== 'quiz') return;
    Clock.audio = running;
    if (S.round.mode === 'beat') beginBeat(); else showQuestion();
  }

  function showQuestion() {
    const q = S.questions[S.qi];
    S.locked = false;
    S.sub = 'ask';
    S.marks = [];
    S.qShownAt = Clock.now();
    renderQuestionCard(q);
    const mic = S.round.input === 'mic';
    if (mic) {
      setFeedback(MIC_LIVE(S.round.mode === 'beat' ? '4拍以内に弾こう' : 'ギターで弾こう'), false);
      Mic.arm(answerMidi, S.qShownAt, q.frets.map((f) => 440 * Math.pow(2, (C.midiOf(q.string, f) - 69) / 12)));
    } else {
      setFeedback(S.round.mode === 'beat'
        ? '<span class="hint">4拍以内にタップ！</span>'
        : `<span class="hint">${STRING_NAME(q.string)}の上をタップ。採点は1回だけです。</span>`, false);
    }
    renderDots();
    renderBoard();
  }

  function onBoardTap(ev) {
    const s = Number(ev.currentTarget.dataset.s);
    const f = Number(ev.currentTarget.dataset.f);
    if (S.phase === 'quiz' && S.sub === 'ask' && !S.locked) { answer(s, f); return; }
    // 答え合わせ中・設定画面・結果画面は「さわって確かめる」
    Sound.pluck(C.midiOf(s, f));
    const q = S.phase === 'quiz' ? S.questions[S.qi] : null;
    const base = S.marks.filter((m) => m.kind !== 'flash');
    S.marks = base.filter((m) => !(m.string === s && m.fret === f && /^(map|mapacc|w)/.test(m.kind)));
    if (!S.marks.some((m) => m.string === s && m.fret === f)) {
      S.marks.push({ string: s, fret: f, kind: 'flash', label: labelAt(s, f, q) });
    }
    renderBoard();
    if (S.phase === 'setup') {
      $('#boardCap').textContent = `${posText(s, f)} ＝ ${nameText(C.names(C.pcOf(s, f)))}`;
      // フラッシュが消えたら元の表示に戻す
      clearTimeout(S.timer);
      S.timer = setTimeout(() => { if (S.phase === 'setup') renderBoardView(); }, 1600);
    }
  }

  function beatOf(t) {
    return S.beat ? Math.min(4, Math.max(1, Math.floor((t - S.beat.qStart) / S.beat.spb) + 1)) : undefined;
  }

  function answer(s, f) {
    S.locked = true;
    Mic.disarm();
    const q = S.questions[S.qi];
    const t = Clock.now();
    const ok = C.judge(q, s, f);
    Sound.pluck(C.midiOf(s, f));
    const r = { q, string: s, fret: f, correct: ok, timeout: false, time: Math.max(0, t - S.qShownAt), via: 'tap' };
    if (S.beat) r.beat = beatOf(t);
    S.results.push(r);
    reveal(r, t);
  }

  // ギターで弾いた音で答える。高さ（オクターブ）まで合えば正解。どの弦で弾いたかは問わない
  function answerMidi(heard, at) {
    if (!(S.phase === 'quiz' && S.sub === 'ask' && !S.locked)) return;
    S.locked = true;
    const q = S.questions[S.qi];
    const t = Math.max(at, S.qShownAt);
    const correct = heard.correct;
    // 正解なら出題の位置、不正解なら聞こえた高さを指定の弦の上で示す（弦の範囲外なら位置は出さない）
    const near = q.frets.map((f) => C.midiOf(q.string, f)).sort((a, b) => Math.abs(a - heard.midi) - Math.abs(b - heard.midi))[0];
    const midi = correct ? near : heard.midi;
    const fret = midi - C.OPEN_MIDI[q.string];
    const onString = fret >= 0 && fret <= 12;
    const r = { q, string: onString ? q.string : null, fret: onString ? fret : null, midi, correct, timeout: false, time: Math.max(0, t - S.qShownAt), via: 'mic' };
    if (S.beat) r.beat = beatOf(t);
    S.results.push(r);
    reveal(r, Clock.now());
  }

  function timeout() {
    S.locked = true;
    Mic.disarm();
    const q = S.questions[S.qi];
    const r = { q, string: null, fret: null, correct: false, timeout: true, time: null };
    S.results.push(r);
    reveal(r, S.beat.deadline);
  }

  // 正解のあとの一言：6・5弦ならそこをルートにしたセーハコード、ほかの弦は「同じ音名の目印」
  function infoLine(q, fret) {
    if (q.frets.length > 1) {
      return `<span class="sub">${noteHTML(q.name)} は 0 と 12 フレットのどちらも正解（12フレットは1オクターブ高い音）</span>`;
    }
    if (q.string >= 5) {
      return `<span class="sub">🎸 ここがルート → <b>${noteHTML(q.name)}</b>・<b>${noteHTML(q.name)}m</b> のセーハコード（${q.string}弦ルート・${fret}フレット）</span>`;
    }
    const p = C.octavePartner(q.string, fret);
    return `<span class="sub">🧭 ${partnerText(p)}</span>`;
  }
  function partnerText(p) {
    if (p.rel === '2oct') return `6弦${p.fret}フレットと同じ音名（2オクターブ上）`;
    if (p.rel === 'oct') return `${p.string}弦${p.fret}フレットと同じ音名（1オクターブ上）`;
    return `${p.string}弦${p.fret}フレットと同じ高さの音`;
  }

  function reveal(r, t) {
    const q = r.q;
    S.sub = 'review';
    S.marks = [];
    if (r.fret != null) S.marks.push({ string: r.string, fret: r.fret, kind: r.correct ? 'hit' : 'miss', label: labelAt(r.string, r.fret, q) });
    q.frets.forEach((f) => {
      if (r.correct && r.string === q.string && r.fret === f) return;
      S.marks.push({ string: q.string, fret: f, kind: r.correct ? 'alt' : 'answer', label: [q.name] });
    });
    if (!r.correct) Sound.pluck(C.midiOf(q.string, q.frets[0]), r.timeout ? 0 : 0.45);
    else if (r.via === 'mic') Sound.pluck(C.midiOf(q.string, r.fret != null ? r.fret : q.frets[0]), 0.3);

    const speed = S.beat ? `${r.beat}拍目` : `${r.time != null ? r.time.toFixed(1) : '-'}秒`;
    const where = `${q.string}弦の ${noteHTML(q.name)} は <b>${fretText(q.frets)}</b>`;
    let html;
    if (r.correct) {
      const how = r.via === 'mic' ? `🎸 ${noteHTML(q.name)} の高さ` : posText(r.string, r.fret);
      html = `<b class="ok">◯ 正解！</b> ${how}・${speed}${infoLine(q, r.fret != null ? r.fret : q.frets[0])}`;
    } else if (r.timeout) {
      html = `<b class="ng">⏱ 時間切れ</b> ${where}`;
    } else if (r.via === 'mic') {
      const samePc = ((r.midi % 12) + 12) % 12 === q.pc;
      const near = q.frets.map((f) => C.midiOf(q.string, f)).sort((a, b) => Math.abs(a - r.midi) - Math.abs(b - r.midi))[0];
      const oct = Math.round((r.midi - near) / 12);
      html = samePc
        ? `<b class="ng">✕ ${Math.abs(oct)}オクターブ${oct > 0 ? '高い' : '低い'}音でした</b>（音名 ${noteHTML(q.name)} は合っています）。${where}`
        : `<b class="ng">✕ 聞こえた音は ${noteHTML(C.names(((r.midi % 12) + 12) % 12)[0])}</b>。${where}`;
    } else if (r.string !== q.string) {
      html = `<b class="ng">✕ そこは${r.string}弦</b>（${nameText(labelAt(r.string, r.fret, q))}）。${where}`;
    } else {
      html = `<b class="ng">✕ そこは ${nameText(labelAt(r.string, r.fret, q))}</b>（${r.fret}フレット）。${q.name} は <b>${fretText(q.frets)}</b>`;
    }

    const isLast = S.qi + 1 >= S.questions.length;
    if (S.beat) {
      const B = S.beat;
      B.nextStart = C.nextDownbeat(B.t0, B.spb, t, 2);
      if (isLast) B.stopAt = B.nextStart;
      // 答えた拍のマスに◯✕
      const cells = document.querySelectorAll('#cells .cell');
      const idx = r.timeout ? 3 : r.beat - 1;
      cells[idx].classList.add(r.correct ? 'ok' : 'ng');
      setFeedback(html, false);
    } else if (r.correct) {
      setFeedback(html, false);
      const token = S.token;
      S.timer = setTimeout(() => { if (token === S.token) advance(); }, q.frets.length > 1 ? 1700 : 1300);
    } else {
      setFeedback(html, true);
      $('#nextBtn').textContent = isLast ? '結果を見る ▶' : '次へ ▶';
    }
    renderDots();
    renderBoard();
  }

  function advance() {
    clearTimeout(S.timer);
    if (S.qi + 1 >= S.questions.length) { finishRound(); return; }
    S.qi++;
    showQuestion();
  }

  /* ---------- 4拍チャレンジ ---------- */
  function beginBeat() {
    const spb = 60 / S.round.bpm;
    const t0 = Clock.now() + 0.3;
    S.beat = { spb, t0, k: 0, nextClick: t0, qStart: t0 + 4 * spb, deadline: t0 + 8 * spb, nextStart: null, stopAt: Infinity };
    S.sub = 'count';
    S.lastBeatIdx = -2;
    $('#qMain').innerHTML = `<span class="q-count">${S.round.stageId ? `ST${S.round.stageId}　` : ''}よーい<span class="big" id="countNum">♩</span></span>`;
    const hint = `♩=${S.round.bpm}。クリックに合わせて、1拍目で問題が出ます`;
    setFeedback(S.round.input === 'mic' ? MIC_LIVE(hint) : `<span class="hint">${hint}</span>`, false);
    S.sched = setInterval(scheduleClicks, 25);
    scheduleClicks();
    S.raf = requestAnimationFrame(loop);
  }

  function scheduleClicks() {
    const B = S.beat;
    if (!B || !Clock.audio) return;
    const horizon = Clock.now() + 0.12;
    while (B.nextClick < horizon && B.nextClick < B.stopAt - 1e-6) {
      Sound.click(B.nextClick, B.k % 4 === 0);
      B.k++;
      B.nextClick = B.t0 + B.k * B.spb;
    }
  }

  function loop() {
    const B = S.beat;
    if (!B) return;
    S.raf = requestAnimationFrame(loop);
    const t = Clock.now();
    if (S.sub === 'count') {
      if (t >= B.qStart) { clearCells(); showQuestion(); S.qShownAt = B.qStart; }
      else {
        const k = Math.floor((t - B.t0) / B.spb);
        const n = $('#countNum');
        if (n && k >= 0) n.textContent = String(k + 1);
      }
    } else if (S.sub === 'ask') {
      if (t >= B.deadline) timeout();
    } else if (S.sub === 'review') {
      if (t >= B.nextStart) {
        if (S.qi + 1 >= S.questions.length) { finishRound(); return; }
        S.qi++;
        B.qStart = B.nextStart;
        B.deadline = B.qStart + 4 * B.spb;
        clearCells();
        showQuestion();
        S.qShownAt = B.qStart;
      }
    }
    updateBeatUI(t);
  }

  function clearCells() {
    document.querySelectorAll('#cells .cell').forEach((c) => c.classList.remove('ok', 'ng', 'past', 'now'));
    S.lastBeatIdx = -2;
  }

  function updateBeatUI(t) {
    const B = S.beat;
    if (!B) return;
    const beats = $('#beats');
    const state = S.sub;
    if (beats.dataset.state !== state) beats.dataset.state = state;
    const label = state === 'count' ? 'よーい' : state === 'ask' ? 'こたえて' : (S.qi + 1 >= S.questions.length ? 'おわり' : 'つぎへ');
    const st = $('#beatState');
    if (st.textContent !== label) st.textContent = label;
    const pos = (t - B.t0) / B.spb;
    const idx = pos < 0 ? -1 : Math.floor(pos) % 4;
    if (idx !== S.lastBeatIdx) {
      S.lastBeatIdx = idx;
      const cells = document.querySelectorAll('#cells .cell');
      const e = Math.floor((t - B.qStart) / B.spb);
      cells.forEach((c, i) => {
        c.classList.toggle('now', i === idx);
        c.classList.toggle('past', state === 'ask' && i < e);
      });
    }
    const bar = $('#timebar');
    if (state === 'ask') {
      const left = Math.max(0, 1 - (t - B.qStart) / (4 * B.spb));
      bar.style.transform = `scaleX(${left.toFixed(4)})`;
      bar.classList.toggle('low', left <= 0.25);
    } else {
      bar.style.transform = 'scaleX(0)';
    }
  }

  /* ---------- 結果 ---------- */
  function recordStats(results) {
    results.forEach((r) => {
      const k = statKey(r.q.string, r.q.pc);
      const h = stats[k] || [];
      h.push({ ok: r.correct ? 1 : 0, t: r.correct && typeof r.time === 'number' ? Math.round(r.time * 100) / 100 : null });
      stats[k] = h.slice(-8);
    });
    store.set(STATS_KEY, stats);
  }

  function finishRound() {
    stopEngine();
    Mic.stop();
    S.sub = null;
    const R = S.round;
    const sum = C.summarize(S.results);
    S.summary = sum;
    recordStats(S.results);
    let badge = '';
    let stage = null;
    if (R.stageId) {
      const id = R.stageId;
      const got = C.starsFor(sum.correct, sum.total);
      const prev = progress.s[id] || { stars: 0, guitar: false };
      progress.s[id] = { stars: Math.max(prev.stars, got), guitar: !!prev.guitar || (got >= 1 && R.input === 'mic') };
      saveProgress();
      stage = {
        id, got, best: progress.s[id].stars, improved: got > prev.stars
      };
      if (got >= 1 && id < C.STAGES.length) settings.stage = id + 1;
      saveSettings();
      if (got >= 1) Sound.fanfare();
    } else if (!R.focus) {
      const rec = { correct: sum.correct, total: sum.total, avgTime: sum.avgTime, bpm: R.mode === 'beat' ? R.bpm : null };
      const prev = store.get(bestKey(), null);
      if (C.isBetter(rec, prev)) {
        store.set(bestKey(), rec);
        badge = prev ? 'ベスト更新' : (sum.correct > 0 ? '初記録' : '');
      }
    }
    setPhase('result');
    S.selected = -1;
    renderResult(sum, badge, stage);
    S.marks = resultMarks();
    $('#boardTitle').textContent = 'きょうの答え';
    $('#legend').innerHTML = '<span><i style="background:var(--green)"></i>できた</span><span><i style="background:var(--red)"></i>まちがえた音の正しい位置</span>';
    $('#boardCap').textContent = '一覧の問題をタップすると、その位置と、覚えるための手がかり（コードの形・同じ音名の位置）が出ます。';
    window.scrollTo(0, 0);
    renderBoard();
  }

  function resultMarks() {
    const map = new Map();
    S.results.forEach((r) => {
      const key = r.q.string + '-' + r.q.pc;
      const cur = map.get(key);
      if (!cur) map.set(key, { q: r.q, ok: r.correct });
      else if (!r.correct) cur.ok = false;
    });
    const out = [];
    map.forEach((v) => v.q.frets.forEach((f) => out.push({ string: v.q.string, fret: f, kind: v.ok ? 'resok' : 'resng', label: [v.q.name] })));
    return out;
  }

  function message(rate) {
    const R = S.round;
    if (rate >= 1) {
      if (R.focus) return ['ばっちり！', 'まちがえた音も覚えられました。元の練習に戻って確認しよう。'];
      return ['パーフェクト！', R.mode === 'beat' ? 'テンポを上げて、もっとすばやく見つけよう。' : '次は「4拍チャレンジ」で、すばやく見つける練習へ。'];
    }
    if (rate >= 0.8) return ['いい調子！', 'まちがえた音だけをもう一度やると、さらに定着します。'];
    if (rate >= 0.5) return ['あと少し！', '赤い位置を、3・5・7・9フレットの目印と一緒に覚えよう。'];
    return ['ここから伸びる！', '指板の「音名」表示で位置を確かめてから、もう一度挑戦しよう。'];
  }

  function stageMessage(stage, sum) {
    const st = stageById(stage.id);
    if (stage.got >= 1) {
      if (st.final) return [`🏆 ファイナル クリア！ 指板制覇！`, stage.got < 3 ? '全問正解で★3をねらおう。' : '全弦・全音名を4拍で。あなたの指板は完全な地図になりました。'];
      return [`ステージ${stage.id} クリア！`, stage.got < 3 ? `次のステージへ進もう。全問正解で★3。` : '★3達成！ 次のステージへ。'];
    }
    const need = C.clearLine(sum.total) - sum.correct;
    return [`ステージ${stage.id} — あと${need}問でクリア`, 'まちがえた音だけを練習してから、もう一度挑戦しよう。'];
  }

  function renderResult(sum, badge, stage) {
    const R = S.round;
    const [title, tip] = stage ? stageMessage(stage, sum) : message(sum.rate);
    const setLabel = `${stringsLabel(R.strings)}${R.maxFret != null ? ` / 0〜${R.maxFret}F` : ''} / ${R.notes === '12' ? '12音' : '7音'} / ${R.mode === 'beat' ? '4拍 ♩=' + R.bpm : 'じっくり'}${R.focus ? ' / まちがえた音' : ''}${R.input === 'mic' ? ' / 🎸' : ''}`;
    const avg = sum.avgTime != null ? `${sum.avgTime.toFixed(1)}<small>秒</small>` : '—';
    const beatsOk = S.results.filter((r) => r.correct && r.beat);
    const avgBeat = beatsOk.length ? (beatsOk.reduce((a, r) => a + r.beat, 0) / beatsOk.length).toFixed(1) : null;
    const missN = sum.missed.length;
    const perfect = sum.rate >= 1 && !R.focus;
    const missBtn = `<button type="button" class="btn-sub" data-act="miss">まちがえた音だけ<small>${missN}音を集中練習</small></button>`;

    let actions;
    if (stage) {
      const hasNext = stage.id < C.STAGES.length;
      if (stage.got >= 1 && hasNext) {
        actions = `<button type="button" class="btn-main" data-act="next">ステージ${stage.id + 1}へ ▶<small>${stringsLabel(stageById(stage.id + 1).strings)}・${modeLabel(stageById(stage.id + 1))}</small></button>` +
          (missN ? missBtn : `<button type="button" class="btn-sub" data-act="again">もう一度<small>${stage.got < 3 ? '★3をねらう' : '同じステージ'}</small></button>`);
      } else if (stage.got >= 1) {
        actions = `<button type="button" class="btn-main" data-act="again">もう一度<small>${stage.got < 3 ? '★3をねらう' : 'ファイナルに再挑戦'}</small></button>` + (missN ? missBtn : '');
      } else {
        actions = `<button type="button" class="btn-main" data-act="again">もう一度<small>ステージ${stage.id}に再挑戦</small></button>` + (missN ? missBtn : '');
        if (stage.id < C.STAGES.length) actions += `<button type="button" class="btn-ghost" data-act="next">ステージ${stage.id + 1}へ ▶</button>`;
      }
      actions += '<button type="button" class="btn-ghost" data-act="setup">ステージ一覧</button>';
    } else if (perfect && R.mode === 'beat' && R.bpm < 160) {
      actions = `<button type="button" class="btn-main" data-act="faster">♩=${Math.min(160, R.bpm + 8)} で挑戦<small>テンポを上げる</small></button>` +
        `<button type="button" class="btn-sub" data-act="again">もう一度<small>同じテンポで</small></button>`;
    } else if (perfect && R.mode === 'free') {
      actions = `<button type="button" class="btn-main" data-act="tobeat">4拍チャレンジへ<small>すばやく見つける練習</small></button>` +
        `<button type="button" class="btn-sub" data-act="again">もう一度<small>同じ設定で</small></button>`;
    } else {
      actions = `<button type="button" class="btn-main" data-act="again">もう一度<small>同じ設定で</small></button>` +
        (missN ? missBtn : `<button type="button" class="btn-sub" data-act="back">元の練習へ<small>${R.fromStage ? 'ステージ' + R.fromStage + 'に挑戦' : '全部の音から出題'}</small></button>`);
    }
    if (!stage) actions += `<button type="button" class="btn-ghost" data-act="setup">${R.fromStage || settings.tab === 'stage' ? 'ステージ一覧' : '設定を変える'}</button>`;

    const items = S.results.map((r, i) => {
      const tm = r.timeout ? '時間切れ' : (r.beat ? `${r.beat}拍目` : `${r.time.toFixed(1)}秒`);
      return `<button type="button" class="ri ${r.correct ? 'ok' : 'ng'}" data-i="${i}">` +
        `<span class="mk">${r.correct ? '◯' : '✕'}</span><span class="s s${r.q.string}">${r.q.string}弦</span>` +
        `<span class="nm">${noteHTML(r.q.name)}</span><span class="tm">${r.via === 'mic' ? '🎸' : ''}${tm}</span></button>`;
    }).join('');
    $('#result').innerHTML =
      `<div class="res-top">` +
        `<div class="score"><span class="n">${sum.correct}</span><span class="d">/ ${sum.total}</span></div>` +
        `<div class="res-msg">` +
          (stage ? `<div class="res-stars" aria-label="星${stage.got}つ">${starHTML(stage.got)}</div>` : '') +
          `<h2>${title}${badge ? `<span class="badge-best">${badge}</span>` : ''}${stage && stage.improved && stage.got > 0 ? '<span class="badge-best">★更新</span>' : ''}</h2><p>${tip}</p>` +
        `</div>` +
      `</div>` +
      `<div class="stats">` +
        `<div class="stat"><div class="k">正解率</div><div class="v">${Math.round(sum.rate * 100)}<small>%</small></div></div>` +
        (avgBeat ? `<div class="stat"><div class="k">平均の反応</div><div class="v">${avgBeat}<small>拍目</small></div></div>` : '') +
        `<div class="stat"><div class="k">正解までの平均</div><div class="v">${avg}</div></div>` +
        `<div class="stat"><div class="k">${stage ? 'ステージ' + stage.id : '設定'}</div><div class="v txt">${setLabel}</div></div>` +
      `</div>` +
      `<div class="res-actions">${actions}</div>` +
      `<div class="res-list-head">問題ごとの結果（タップで位置と手がかりを確認）</div>` +
      `<div class="res-list">${items}</div>`;
    $('#result').querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
      const act = b.dataset.act;
      Sound.init();
      if (act === 'next') { settings.stage = stage.id + 1; saveSettings(); startRound(cfgForStage(stage.id + 1)); }
      else if (act === 'faster') { settings.bpm = Math.min(160, R.bpm + 8); saveSettings(); startRound(Object.assign({}, R, { bpm: settings.bpm })); }
      else if (act === 'tobeat') { settings.mode = 'beat'; saveSettings(); startRound(Object.assign({}, R, { mode: 'beat', bpm: settings.bpm })); }
      else if (act === 'again') startRound(R);
      else if (act === 'miss') startRound(cfgForFocus(R, sum.missed));
      else if (act === 'back') startRound(R.fromStage ? cfgForStage(R.fromStage) : Object.assign({}, R, { focus: null, count: Number(settings.count) }));
      else goSetup();
    }));
    document.querySelectorAll('.ri').forEach((b) => b.addEventListener('click', () => selectResult(Number(b.dataset.i), false, true)));
  }

  function selectResult(i, minor, scroll) {
    const r = S.results[i];
    const q = r.q;
    const root = q.frets[0];
    S.selected = i;
    document.querySelectorAll('.ri').forEach((b) => b.classList.toggle('sel', Number(b.dataset.i) === i));
    const yours = r.timeout ? '時間切れ'
      : r.correct ? '正解'
      : r.via === 'mic' ? `聞こえた音：${C.names(((r.midi % 12) + 12) % 12)[0]}`
      : `あなたの答え：${posText(r.string, r.fret)}（${nameText(labelAt(r.string, r.fret, q))}）`;
    const nm = noteHTML(q.name);
    let extra = '';
    const busy = [];
    S.marks = [];
    if (q.string >= 5) {
      // 6・5弦：そこをルートにしたセーハコードの形
      const shape = C.chordShape(q.string, root, minor);
      const visible = shape.notes.filter((n) => n.fret <= 12);
      visible.forEach((n) => { busy.push([n.string, n.fret]); if (!n.root) S.marks.push({ string: n.string, fret: n.fret, kind: 'shape', label: [] }); });
      shape.muted.forEach((s) => S.marks.push({ string: s, fret: 0, kind: 'mute' }));
      Sound.strum(shape.notes.map((n) => C.midiOf(n.string, n.fret)));
      const kindText = root === 0 ? '開放弦のコード' : `${q.string}弦ルートのセーハ（${root}フレット）`;
      extra = `<div class="chord-row">` +
        `<button type="button" class="chord-btn" data-minor="0" aria-pressed="${!minor}">${nm}</button>` +
        `<button type="button" class="chord-btn" data-minor="1" aria-pressed="${!!minor}">${nm}m</button>` +
        `<span class="note">← ${kindText}の形${shape.beyond ? '（一部は12フレットより先）' : ''}。タップで鳴らせます</span></div>`;
    } else {
      // 4〜1弦：同じ音名の目印になる位置
      const p = C.octavePartner(q.string, root);
      busy.push([p.string, p.fret]);
      S.marks.push({ string: p.string, fret: p.fret, kind: 'partner', label: [q.name] });
      Sound.pluck(C.midiOf(p.string, p.fret));
      Sound.pluck(C.midiOf(q.string, root), 0.35);
      extra = `<div class="chord-row"><span class="note">🧭 手がかり：${partnerText(p)}</span></div>`;
    }
    q.frets.forEach((f) => busy.push([q.string, f]));
    const isBusy = (s, f) => busy.some((b) => b[0] === s && b[1] === f);
    S.marks = resultMarks().filter((m) => !isBusy(m.string, m.fret)).concat(S.marks);
    q.frets.forEach((f) => S.marks.push({ string: q.string, fret: f, kind: 'focus', label: [q.name] }));
    if (!r.correct && r.fret != null && !isBusy(r.string, r.fret)) S.marks.push({ string: r.string, fret: r.fret, kind: 'miss', label: labelAt(r.string, r.fret, q) });

    $('#boardCap').innerHTML = `<b>${i + 1}問目</b>　${q.string}弦の ${nm} は ${fretText(q.frets)}。${yours}` + extra;
    $('#boardCap').querySelectorAll('.chord-btn').forEach((b) => b.addEventListener('click', () => selectResult(i, b.dataset.minor === '1', false)));
    renderBoard();
    if (scroll && isVertical()) $('.board-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function goSetup() {
    stopEngine();
    Mic.stop();
    S.round = null;
    S.sub = null;
    setPhase('setup');
    window.scrollTo(0, 0);
    renderSetup();
  }

  /* ================= 使い方ガイド ================= */
  const modal = $('#helpModal');
  const openHelp = () => { modal.classList.add('open'); $('#helpClose').focus(); };
  const closeHelp = () => { modal.classList.remove('open'); $('#helpBtn').focus(); };
  $('#helpBtn').addEventListener('click', openHelp);
  $('#helpClose').addEventListener('click', closeHelp);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeHelp(); });
  $('#resetStats').addEventListener('click', () => {
    if (!window.confirm('ステージの★・苦手マップ・ベスト記録をすべてリセットします。よろしいですか？')) return;
    stats = {};
    progress = { s: {}, v: 2 };
    store.del(STATS_KEY);
    store.del(PROG_KEY);
    try { Object.keys(localStorage).filter((k) => k.startsWith('tsgft.best.')).forEach((k) => localStorage.removeItem(k)); } catch (e) { /* 続行 */ }
    settings.stage = 1; saveSettings();
    $('#resetStats').textContent = 'リセットしました';
    if (S.phase === 'setup') renderSetup();
  });

  /* ================= 入力 ================= */
  document.querySelectorAll('.seg').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      settings[seg.dataset.key] = b.dataset.v;
      saveSettings();
      if (seg.dataset.key === 'view') renderBoardView(); else renderSetup();
    });
  });
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    settings.tab = b.dataset.tab;
    saveSettings();
    renderSetup();
  }));
  $('#boardToggle').addEventListener('click', () => {
    settings.board = boardOpen() ? 'closed' : 'open';
    saveSettings();
    renderBoardView();
  });
  $('#toFree').addEventListener('click', () => { settings.tab = 'free'; saveSettings(); renderSetup(); window.scrollTo(0, 0); });
  document.querySelectorAll('#strChips .chip').forEach((b) => b.addEventListener('click', () => {
    const s = Number(b.dataset.s);
    const has = settings.strs.includes(s);
    if (has && settings.strs.length === 1) { toast('弦は1本以上えらんでください'); return; }
    settings.strs = normStrings(has ? settings.strs.filter((x) => x !== s) : settings.strs.concat(s));
    saveSettings();
    renderSetup();
  }));
  document.querySelectorAll('#freePane .preset').forEach((b) => b.addEventListener('click', () => {
    settings.strs = normStrings(b.dataset.p.split(','));
    saveSettings();
    renderSetup();
  }));
  const setBpm = (v) => { settings.bpm = Math.min(160, Math.max(40, Math.round(v / 2) * 2)); saveSettings(); renderSetup(); };
  $('#bpmRange').addEventListener('input', (e) => setBpm(Number(e.target.value)));
  $('#bpmDown').addEventListener('click', () => setBpm(settings.bpm - 4));
  $('#bpmUp').addEventListener('click', () => setBpm(settings.bpm + 4));
  $('#soundBtn').addEventListener('click', () => {
    settings.sound = !settings.sound;
    saveSettings();
    Sound.init();
    Sound.setEnabled();
    renderSoundBtn();
  });
  $('#startBtn').addEventListener('click', () => { Sound.init(); startRound(cfgForFree()); });
  $('#quitBtn').addEventListener('click', goSetup);
  $('#nextBtn').addEventListener('click', advance);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) { closeHelp(); return; }
    if (e.target.closest && e.target.closest('button, input')) return;
    if ((e.key === 'Enter' || e.key === ' ') && !$('#nextBtn').hidden && S.phase === 'quiz') { e.preventDefault(); advance(); }
  });
  // 最初のタッチで音の準備（iPhone対策）
  const unlock = () => { Sound.init(); window.removeEventListener('pointerdown', unlock); };
  window.addEventListener('pointerdown', unlock);

  let rz = 0;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (S.phase === 'setup') renderBoardView(); else renderBoard(); }, 120); });

  // オフライン対応（https か手元のサーバーのときだけ）
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('[sw] register failed:', e));
    });
  }

  // 検証用フック（画面の動作には影響しない）
  window.__ft = {
    S, settings, Clock,
    get stats() { return stats; }, get progress() { return progress; },
    micPlay: (midi) => Mic.testPlay(midi), micNoise: (k) => Mic.testNoise(k), get micActive() { return Mic.active; }, get plucks() { return Sound.plucks; }
  };

  renderSoundBtn();
  renderSetup();
})();
