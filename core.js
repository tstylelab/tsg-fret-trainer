/* TSG フレットトレーナー — 音名・出題・採点・タイミングの純粋ロジック
   ブラウザでは window.FretCore、Node では require() で読める */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FretCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 標準チューニングの開放弦（MIDIノート番号）
  const OPEN_MIDI = { 1: 64, 2: 59, 3: 55, 4: 50, 5: 45, 6: 40 };
  const MAX_FRET = 12;

  // ピッチクラスごとの表記（♯と♭の両方を持つ）
  const PITCH = [
    { natural: true,  names: ['C'],         kana: ['ド'] },
    { natural: false, names: ['C♯', 'D♭'], kana: ['ド♯', 'レ♭'] },
    { natural: true,  names: ['D'],         kana: ['レ'] },
    { natural: false, names: ['D♯', 'E♭'], kana: ['レ♯', 'ミ♭'] },
    { natural: true,  names: ['E'],         kana: ['ミ'] },
    { natural: true,  names: ['F'],         kana: ['ファ'] },
    { natural: false, names: ['F♯', 'G♭'], kana: ['ファ♯', 'ソ♭'] },
    { natural: true,  names: ['G'],         kana: ['ソ'] },
    { natural: false, names: ['G♯', 'A♭'], kana: ['ソ♯', 'ラ♭'] },
    { natural: true,  names: ['A'],         kana: ['ラ'] },
    { natural: false, names: ['A♯', 'B♭'], kana: ['ラ♯', 'シ♭'] },
    { natural: true,  names: ['B'],         kana: ['シ'] }
  ];

  const NATURAL_PCS = [0, 2, 4, 5, 7, 9, 11];
  const ALL_PCS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

  function midiOf(string, fret) { return OPEN_MIDI[string] + fret; }
  function pcOf(string, fret) { return midiOf(string, fret) % 12; }
  function isNatural(pc) { return PITCH[pc].natural; }
  function names(pc) { return PITCH[pc].names.slice(); }

  // 指定弦で pc になるフレット（0〜12）。開放弦の音名なら [0, 12]
  function answerFrets(string, pc) {
    const out = [];
    for (let f = 0; f <= MAX_FRET; f++) if (pcOf(string, f) === pc) out.push(f);
    return out;
  }

  // 1問の採点：指定弦で、同じ音名のフレットなら正解（0と12はどちらも正解）
  function judge(q, string, fret) {
    return string === q.string && pcOf(string, fret) === q.pc;
  }

  function spell(pc, rng) {
    const p = PITCH[pc];
    const i = p.names.length > 1 && rng() >= 0.5 ? 1 : 0;
    return { name: p.names[i], kana: p.kana[i] };
  }

  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // 重みつきで k 個を重複なしに選ぶ（重いものほど選ばれやすい）
  function weightedPick(pool, k, weight, rng) {
    return pool
      .map(function (item) { return { item: item, key: Math.pow(rng() || 1e-9, 1 / Math.max(0.01, weight(item))) }; })
      .sort(function (a, b) { return b.key - a.key; })
      .slice(0, k)
      .map(function (x) { return x.item; });
  }

  // 出題リスト。弦×音名の組をシャッフルして順に出し、足りなければ次の一巡へ
  // （同じ組は一巡の中で重複しない／巡の継ぎ目でも直前と同じ問題を避ける）
  // opts.weight があれば、一巡に満たない残りの枠を「重い＝苦手な組」から多めに選ぶ
  function buildQuestions(opts) {
    const rng = opts.rng || Math.random;
    const pcs = opts.noteSet === '12' ? ALL_PCS : NATURAL_PCS;
    let pool;
    if (opts.focus && opts.focus.length) {
      pool = opts.focus.map(function (x) { return { string: x.string, pc: x.pc }; });
    } else {
      pool = [];
      const maxF = opts.maxFret == null ? MAX_FRET : opts.maxFret;
      opts.strings.forEach(function (s) { pcs.forEach(function (pc) { if (answerFrets(s, pc)[0] <= maxF) pool.push({ string: s, pc: pc }); }); });
    }
    const out = [];
    while (out.length < opts.count) {
      const remaining = opts.count - out.length;
      const batch = opts.weight && remaining < pool.length
        ? shuffle(weightedPick(pool, remaining, opts.weight, rng), rng)
        : shuffle(pool.slice(), rng);
      const last = out[out.length - 1];
      if (last && batch.length > 1 && batch[0].string === last.string && batch[0].pc === last.pc) {
        const j = 1 + Math.floor(rng() * (batch.length - 1));
        const t = batch[0]; batch[0] = batch[j]; batch[j] = t;
      }
      for (let i = 0; i < batch.length && out.length < opts.count; i++) out.push(batch[i]);
    }
    return out.map(function (b) {
      const s = spell(b.pc, rng);
      return { string: b.string, pc: b.pc, name: s.name, kana: s.kana, frets: answerFrets(b.string, b.pc) };
    });
  }

  // 4拍練習の進行：小節頭は t0 + 4m拍。回答時刻 t から minGapBeats 拍以上あとの最初の小節頭
  function nextDownbeat(t0, spb, t, minGapBeats) {
    const bar = 4 * spb;
    const m = Math.ceil((t + minGapBeats * spb - t0) / bar - 1e-9);
    return t0 + m * bar;
  }

  // フレット線の位置（0〜12 → 0〜1）。実物の間隔と等間隔を taper の比率で混ぜる
  function fretWirePositions(taper) {
    const a = [];
    for (let n = 0; n <= MAX_FRET; n++) {
      const real = (1 - Math.pow(2, -n / 12)) / 0.5;
      a.push(taper * real + (1 - taper) * (n / MAX_FRET));
    }
    return a;
  }

  function summarize(results) {
    const ok = results.filter(function (r) { return r.correct; });
    const times = ok.map(function (r) { return r.time; }).filter(function (t) { return typeof t === 'number'; });
    const missed = {};
    results.forEach(function (r) {
      if (!r.correct) missed[r.q.string + '-' + r.q.pc] = { string: r.q.string, pc: r.q.pc };
    });
    return {
      total: results.length,
      correct: ok.length,
      rate: results.length ? ok.length / results.length : 0,
      avgTime: times.length ? times.reduce(function (a, b) { return a + b; }, 0) / times.length : null,
      missed: Object.keys(missed).map(function (k) { return missed[k]; })
    };
  }

  // 記録の比較：正解数 → テンポ（4拍）→ 平均時間
  function isBetter(a, b) {
    if (!b) return true;
    if (a.correct !== b.correct) return a.correct > b.correct;
    if ((a.bpm || 0) !== (b.bpm || 0)) return (a.bpm || 0) > (b.bpm || 0);
    if (a.avgTime == null) return false;
    if (b.avgTime == null) return true;
    return a.avgTime < b.avgTime - 1e-9;
  }

  // そのフレットをルートにしたセーハコードの形（0フレットなら開放のE・Em／A・Am）
  // 6弦ルート：メジャー 0-2-2-1-0-0 ／ マイナー 0-2-2-0-0-0
  // 5弦ルート：メジャー ×-0-2-2-2-0 ／ マイナー ×-0-2-2-1-0
  const SHAPES = {
    6: { major: { 6: 0, 5: 2, 4: 2, 3: 1, 2: 0, 1: 0 }, minor: { 6: 0, 5: 2, 4: 2, 3: 0, 2: 0, 1: 0 } },
    5: { major: { 5: 0, 4: 2, 3: 2, 2: 2, 1: 0 }, minor: { 5: 0, 4: 2, 3: 2, 2: 1, 1: 0 } }
  };
  function chordShape(rootString, rootFret, minor) {
    const sh = SHAPES[rootString][minor ? 'minor' : 'major'];
    const notes = [];
    for (let s = 6; s >= 1; s--) {
      if (sh[s] == null) continue;
      notes.push({ string: s, fret: rootFret + sh[s], root: s === rootString });
    }
    return {
      notes: notes,
      muted: rootString === 5 ? [6] : [],
      beyond: notes.some(function (n) { return n.fret > MAX_FRET; })
    };
  }

  // 苦手度：直近の記録（{ok, t} の配列）から判定
  function weakness(hist) {
    if (!hist || !hist.length) return { level: 'new', miss: 0, n: 0 };
    const miss = hist.filter(function (h) { return !h.ok; }).length / hist.length;
    const okTimes = hist.filter(function (h) { return h.ok && typeof h.t === 'number'; }).map(function (h) { return h.t; });
    const slow = okTimes.length ? okTimes.reduce(function (a, b) { return a + b; }, 0) / okTimes.length > 3 : false;
    const level = miss >= 0.34 ? 'weak' : (miss > 0 || slow ? 'soso' : 'good');
    return { level: level, miss: miss, slow: slow, n: hist.length };
  }
  // 出題の重み：まちがいが多い・遅い音ほど重く、まだ出ていない音もやや重く
  function weightOf(hist) {
    const w = weakness(hist);
    if (w.level === 'new') return 1.6;
    return 1 + 4 * w.miss + (w.slow ? 0.6 : 0);
  }

  /* ---------- ステージ ---------- */
  const ALL6 = [6, 5, 4, 3, 2, 1];
  const CHAPTERS = {
    1: 'ルート弦（6・5弦）',
    2: '4弦',
    3: '3弦',
    4: '2弦',
    5: '1弦と全弦制覇'
  };
  const STAGES = [
    { id: 1,  ch: 1, strings: [6, 5],            notes: '7',  mode: 'free', maxFret: 5, count: 10, intro: 'まずはローポジション（0〜5フレット）で、6弦・5弦の幹音から。' },
    { id: 2,  ch: 1, strings: [6, 5],            notes: '7',  mode: 'free', count: 10, intro: '12フレットまで全部。3・5・7・9フレットの目印を手がかりに。' },
    { id: 3,  ch: 1, strings: [6, 5],            notes: '12', mode: 'free', count: 10, intro: '♯・♭も登場。EとF、BとCの間には♯♭がないことを思い出そう。' },
    { id: 4,  ch: 1, strings: [6, 5],            notes: '7',  mode: 'beat', bpm: 60, count: 10, intro: 'クリックに合わせて4拍以内に。考えるより先に指が向かう速さへ。' },
    { id: 5,  ch: 1, strings: [6, 5],            notes: '12', mode: 'beat', bpm: 72, count: 10, intro: '12音を4拍で。ここをクリアすればルート探しはもう怖くない。' },
    { id: 6,  ch: 2, strings: [4],               notes: '7',  mode: 'free', count: 10, intro: '4弦は6弦の「2フレット先」と同じ音名。6弦の知識がそのまま使えます。' },
    { id: 7,  ch: 2, strings: [6, 5, 4],         notes: '12', mode: 'free', count: 10, intro: '6・5・4弦をまぜて12音。どの弦を聞かれても慌てずに。' },
    { id: 8,  ch: 2, strings: [6, 5, 4],         notes: '12', mode: 'beat', bpm: 72, count: 10, intro: '3本の弦を4拍で。弦が変わっても目印から一瞬で。' },
    { id: 9,  ch: 3, strings: [3],               notes: '7',  mode: 'free', count: 10, intro: '3弦は5弦の「2フレット先」と同じ音名。5弦の地図を借りよう。' },
    { id: 10, ch: 3, strings: [6, 5, 4, 3],      notes: '12', mode: 'free', count: 10, intro: '6〜3弦の12音。指板の半分以上が見えてきました。' },
    { id: 11, ch: 3, strings: [6, 5, 4, 3],      notes: '12', mode: 'beat', bpm: 72, count: 10, intro: '6〜3弦を4拍で。' },
    { id: 12, ch: 4, strings: [2],               notes: '7',  mode: 'free', count: 10, intro: '2弦は4弦の「3フレット先」。ここだけずれ方が1つ多いので注意。' },
    { id: 13, ch: 4, strings: [6, 5, 4, 3, 2],   notes: '12', mode: 'free', count: 10, intro: '6〜2弦の12音。あと1本で全弦制覇。' },
    { id: 14, ch: 4, strings: [6, 5, 4, 3, 2],   notes: '12', mode: 'beat', bpm: 76, count: 10, intro: '6〜2弦を4拍で。' },
    { id: 15, ch: 5, strings: [1],               notes: '7',  mode: 'free', count: 10, intro: '1弦は6弦とまったく同じ音名の並び（2オクターブ上）。' },
    { id: 16, ch: 5, strings: ALL6,              notes: '12', mode: 'free', count: 10, intro: '全6弦の12音。指板のすべてがあなたの地図に。' },
    { id: 17, ch: 5, strings: ALL6,              notes: '12', mode: 'beat', bpm: 80, count: 10, intro: '全弦を4拍で。' },
    { id: 18, ch: 5, strings: ALL6,              notes: '12', mode: 'beat', bpm: 96, count: 20, final: true, intro: 'ファイナル。全弦・12音・20問を♩=96で。指板制覇！' }
  ];
  // 星：8割でクリア（★1）、9割で★2、全問で★3
  function starsFor(correct, total) {
    if (correct >= total) return 3;
    if (correct >= Math.ceil(total * 0.9)) return 2;
    if (correct >= Math.ceil(total * 0.8)) return 1;
    return 0;
  }
  const clearLine = (total) => Math.ceil(total * 0.8);

  // 同じ音名の「目印になる」位置（4・3・2弦は低い弦のオクターブ、1弦は6弦の2オクターブ上）
  const OCT_PARTNER = { 4: { s: 6, d: 2 }, 3: { s: 5, d: 2 }, 2: { s: 4, d: 3 } };
  function octavePartner(string, fret) {
    if (string === 1) return { string: 6, fret: fret, rel: '2oct' };
    const o = OCT_PARTNER[string];
    if (!o) return null;
    if (fret - o.d >= 0) return { string: o.s, fret: fret - o.d, rel: 'oct' };
    return { string: o.s, fret: fret + 12 - o.d, rel: 'unison' };
  }

  function midiLabel(midi) {
    const pc = ((midi % 12) + 12) % 12;
    return { name: PITCH[pc].names[0], oct: Math.floor(midi / 12) - 1 };
  }

  /* ---------- 音程判定（MPM：TSGチューナーと同じ考え方） ----------
     NSDF（正規化した自己相関）の山のうち、最大の山の90%以上ある「最初の山」を基音とする。
     倍音の山は基音より低くなるので、オクターブの取り違えが起きにくい。
     戻り値 { freq, confidence } か null */
  function detectPitch(buf, sampleRate, floorHz, ceilHz, rms, rmsFloor) {
    if (rms < rmsFloor) return null;
    const SIZE = buf.length;
    const WIN = Math.min(SIZE, Math.max(2048, Math.ceil(4 * sampleRate / floorHz)));
    const minLag = Math.max(2, Math.floor(sampleRate / ceilHz));
    const maxLag = Math.min(WIN - 1, Math.ceil(sampleRate / floorHz));
    const sq = new Float64Array(WIN + 1);
    for (let i = 0; i < WIN; i++) sq[i + 1] = sq[i] + buf[i] * buf[i];
    const nsdf = new Float32Array(maxLag + 2);
    for (let tau = minLag; tau <= maxLag; tau++) {
      let ac = 0;
      const n = WIN - tau;
      for (let j = 0; j < n; j++) ac += buf[j] * buf[j + tau];
      const m = sq[n] + (sq[tau + n] - sq[tau]);
      nsdf[tau] = m > 0 ? (2 * ac / m) : 0;
    }
    const peaks = [];
    let tau = minLag;
    while (tau <= maxLag && nsdf[tau] > 0) tau++;
    while (tau <= maxLag) {
      while (tau <= maxLag && nsdf[tau] <= 0) tau++;
      let pTau = -1, pVal = -Infinity;
      while (tau <= maxLag && nsdf[tau] > 0) {
        if (nsdf[tau] > pVal) { pVal = nsdf[tau]; pTau = tau; }
        tau++;
      }
      if (pTau > 0) peaks.push([pTau, pVal]);
    }
    if (!peaks.length) return null;
    let maxVal = 0;
    peaks.forEach(function (p) { if (p[1] > maxVal) maxVal = p[1]; });
    if (maxVal < 0.5) return null;
    let best = null;
    for (let i = 0; i < peaks.length; i++) if (peaks[i][1] >= maxVal * 0.9) { best = peaks[i]; break; }
    let T0 = best[0];
    if (T0 > minLag && T0 < maxLag) {
      const y1 = nsdf[T0 - 1], y2 = nsdf[T0], y3 = nsdf[T0 + 1];
      const den = y1 - 2 * y2 + y3;
      if (den < 0) T0 = T0 + 0.5 * (y1 - y3) / den;
    }
    return { freq: sampleRate / T0, confidence: Math.max(0, Math.min(1, best[1])) };
  }
  const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);

  /* ---------- 基音の決め直し（倍音の拾い間違い対策） ----------
     マイクによっては基音が小さく、MPM が 2倍・3倍…の倍音を音程として返すことがある。
     候補（MPMの結果の 1/8〜2倍）ごとに「倍音の位置の強さ − 倍音と倍音の中間の強さ」を合計し、
     MPMの結果を基本にし、別の候補のほうが「はっきり（1.3倍以上）」倍音の並びに合うときだけ基音を置き換える
     （本当に1オクターブ上を弾いたときに、低いほうへ誤って下げないため）。 */
  function makeMag(buf, sampleRate) {
    const N = buf.length;
    const w = new Float32Array(N);
    for (let i = 0; i < N; i++) w[i] = buf[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
    const cache = new Map();
    return function mag(f) {
      const key = Math.round(f * 4);
      if (cache.has(key)) return cache.get(key);
      const k = 2 * Math.cos(2 * Math.PI * f / sampleRate);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < N; i++) { const s0 = w[i] + k * s1 - s2; s2 = s1; s1 = s0; }
      const m = Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2));
      cache.set(key, m);
      return m;
    };
  }
  // 出題の音 fe を「本当に弾いたか」の裏付け：fe の奇数倍音（1・3・5倍）の強さ ÷ 偶数倍音（2・4・6倍）の強さ。
  // 1オクターブ上（2fe）を弾いた音には奇数倍音が無いので、この値がほぼ0になる。
  function oddSupport(buf, sampleRate, fe, top) {
    const mag = makeMag(buf, sampleRate);
    const lim = top || 2000;
    let odd = 0, even = 0;
    [1, 3, 5].forEach(function (k) { if (k * fe <= lim) odd += mag(k * fe) - mag((k + 0.5) * fe) * 0.5; });
    [2, 4, 6].forEach(function (k) { if (k * fe <= lim) even += mag(k * fe); });
    return even > 0 ? Math.max(0, odd) / even : (odd > 0 ? 9 : 0);
  }
  // 聞こえた音（fHeard）と出題の音（fe）から「出題の音を弾いた」と判断できるか
  // ・半音の0.75以内で一致 → 正解（チューニングの多少のずれは許す）
  // ・fe のちょうど整数倍（2〜8倍）で、fe の奇数倍音の裏付けがある → 倍音を拾っただけなので正解
  function heardMatches(buf, sampleRate, fHeard, fe) {
    const d = Math.abs(freqToMidi(fHeard) - freqToMidi(fe));
    if (d <= 0.75) return true;
    const n = Math.round(fHeard / fe);
    if (n < 2 || n > 8) return false;
    const cents = Math.abs(1200 * Math.log2(fHeard / (n * fe)));
    if (cents > 60) return false;
    return oddSupport(buf, sampleRate, fe) >= 0.25;
  }

  function decideFundamental(buf, sampleRate, fGuess, opts) {
    const lo = (opts && opts.lo) || 70, hi = (opts && opts.hi) || 1100, top = (opts && opts.top) || 2000;
    const mag = makeMag(buf, sampleRate);
    const ratios = [1 / 8, 1 / 6, 1 / 5, 1 / 4, 1 / 3, 1 / 2, 1, 2];
    const cands = [];
    ratios.forEach(function (r) {
      const f = fGuess * r;
      if (f < lo || f > hi) return;
      let score = 0;
      for (let k = 1; k <= 8 && k * f <= top; k++) score += mag(k * f) - mag((k - 0.5) * f);
      cands.push({ f: f, score: score });
    });
    if (!cands.length) return fGuess;
    // 元の結果（倍率1）を基本にし、ほかの候補はスコアがはっきり上回るときだけ採用する
    const base = cands.find(function (c) { return c.f === fGuess; });
    let pick = base || cands[0];
    cands.forEach(function (c) {
      if (c === pick) return;
      const margin = pick === base ? 1.3 : 1.0;
      if (c.score > pick.score * margin || (c !== base && Math.abs(c.score - pick.score) < 1e-9 && c.f > pick.f)) pick = c;
    });
    return pick.f;
  }

  return {
    OPEN_MIDI: OPEN_MIDI, MAX_FRET: MAX_FRET, NATURAL_PCS: NATURAL_PCS, ALL_PCS: ALL_PCS,
    STAGES: STAGES, CHAPTERS: CHAPTERS, starsFor: starsFor, clearLine: clearLine,
    octavePartner: octavePartner, midiLabel: midiLabel, detectPitch: detectPitch, freqToMidi: freqToMidi, decideFundamental: decideFundamental, heardMatches: heardMatches, oddSupport: oddSupport,
    chordShape: chordShape, weakness: weakness, weightOf: weightOf,
    midiOf: midiOf, pcOf: pcOf, isNatural: isNatural, names: names,
    answerFrets: answerFrets, judge: judge, buildQuestions: buildQuestions,
    nextDownbeat: nextDownbeat, fretWirePositions: fretWirePositions,
    summarize: summarize, isBetter: isBetter
  };
});
