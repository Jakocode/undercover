'use strict';

/* ============================================================
   Données
   ============================================================ */

const LIST_KEYS = ['r1d1', 'r1d2', 'r1d3', 'r2d1', 'r2d2', 'r2d3', 'r3d1', 'r3d2', 'r3d3'];

const RARITY_OPTS = [
  { v: '1', label: 'Courant' },
  { v: '2', label: 'Intermédiaire' },
  { v: '3', label: 'Rare' },
  { v: 'mix', label: 'Mélangé' },
];
const DISTANCE_OPTS = [
  { v: '1', label: 'Faible' },
  { v: '2', label: 'Moyen' },
  { v: '3', label: 'Élevé' },
  { v: 'mix', label: 'Mélangé' },
];

const ROLE_LABEL = { civil: 'Civil', undercover: 'Undercover', white: 'Mr. White' };

function decodeWords() {
  const key = 'undercover';
  const bin = atob(window.WORDS_DATA);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) ^ key.charCodeAt(i % key.length);
  return JSON.parse(new TextDecoder('utf-8').decode(bytes));
}
const WORDS = decodeWords();

/* ============================================================
   Stockage local (toujours protégé par try/catch)
   ============================================================ */

const store = {
  get(k, fallback) {
    try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const DEFAULT_SETTINGS = {
  players: [],
  rarity: '1',
  distance: '2',
  timer: 120,
  autoRoles: true,
  undercover: 1,
  white: 0,
};

let settings = Object.assign({}, DEFAULT_SETTINGS, store.get('uc_settings', {}));
let game = store.get('uc_game', null);
let ui = {}; // état d'interface non persistant (sélections, etc.)

function saveSettings() { store.set('uc_settings', settings); }
function saveGame() { if (game) store.set('uc_game', game); else store.del('uc_game'); }

/* ============================================================
   Utilitaires
   ============================================================ */

const $app = document.getElementById('app');
const $modal = document.getElementById('modal');

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function rand(n) { return Math.floor(Math.random() * n); }
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function fmtTime(s) {
  s = Math.max(0, Math.ceil(s));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function normalize(w) {
  return w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '').replace(/s$/, '');
}
function levenshtein(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}
function guessMatches(guess, word) {
  const g = normalize(guess), w = normalize(word);
  if (!g) return false;
  if (g === w) return true;
  return w.length >= 5 && levenshtein(g, w) <= 1; // tolère une petite faute de frappe
}
function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p); } catch { /* ignore */ } }

/* ---------- Son de fin de timer ---------- */
let audioCtx = null;
function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* ignore */ }
}
function beep() {
  if (!audioCtx) return;
  try {
    [0, 0.35, 0.7].forEach(t => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'square'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + t + 0.25);
      o.connect(g).connect(audioCtx.destination);
      o.start(audioCtx.currentTime + t); o.stop(audioCtx.currentTime + t + 0.3);
    });
  } catch { /* ignore */ }
}

/* ---------- Garder l'écran allumé pendant la partie ---------- */
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release(); wakeLock = null;
    }
  } catch { /* ignore */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && game) keepAwake(true);
});

/* ============================================================
   Règles de répartition
   ============================================================ */

function defaultRoles(n) {
  const table = { 3: [1, 0], 4: [1, 0], 5: [1, 1], 6: [1, 1], 7: [2, 1], 8: [2, 1], 9: [3, 1], 10: [3, 1] };
  if (n < 3) return { undercover: 1, white: 0 };
  if (table[n]) return { undercover: table[n][0], white: table[n][1] };
  return { undercover: Math.round(n * 0.3), white: n >= 15 ? 2 : 1 };
}

function currentRoles() {
  const n = settings.players.length;
  if (settings.autoRoles) return defaultRoles(n);
  return { undercover: settings.undercover, white: settings.white };
}

function rolesError(n, uc, w) {
  if (n < 3) return 'Il faut au moins 3 joueurs.';
  const civ = n - uc - w;
  if (uc + w < 1) return 'Il faut au moins un Undercover ou un Mr. White.';
  if (civ < 2 || civ <= uc + w) return 'Il doit y avoir plus de Civils que d’infiltrés.';
  return null;
}

/* ============================================================
   Tirage des mots
   ============================================================ */

function pickPair() {
  const rs = settings.rarity === 'mix' ? ['1', '2', '3'] : [settings.rarity];
  const ds = settings.distance === 'mix' ? ['1', '2', '3'] : [settings.distance];
  const keys = [];
  rs.forEach(r => ds.forEach(d => keys.push('r' + r + 'd' + d)));

  const used = store.get('uc_used', {});
  let pool = [];
  keys.forEach(k => WORDS[k].forEach((p, i) => {
    if (!(used[k] || []).includes(i)) pool.push({ k, i, p });
  }));
  if (pool.length === 0) { // tout a été joué : on recommence ces listes
    keys.forEach(k => { used[k] = []; });
    keys.forEach(k => WORDS[k].forEach((p, i) => pool.push({ k, i, p })));
  }
  const choice = pool[rand(pool.length)];
  used[choice.k] = (used[choice.k] || []).concat(choice.i);
  store.set('uc_used', used);

  const pair = choice.p.slice();
  if (Math.random() < 0.5) pair.reverse();
  return { civWord: pair[0], ucWord: pair[1] };
}

/* ============================================================
   Logique de partie
   ============================================================ */

function startGame() {
  const names = settings.players;
  const { undercover, white } = currentRoles();
  const roles = [];
  for (let i = 0; i < undercover; i++) roles.push('undercover');
  for (let i = 0; i < white; i++) roles.push('white');
  while (roles.length < names.length) roles.push('civil');
  shuffle(roles);

  const { civWord, ucWord } = pickPair();
  game = {
    civWord, ucWord,
    players: names.map((name, i) => ({
      name,
      role: roles[i],
      word: roles[i] === 'civil' ? civWord : roles[i] === 'undercover' ? ucWord : null,
      alive: true,
    })),
    phase: 'dist-pass',
    distIndex: 0,
    round: 0,
    order: [],
    eliminatedIdx: null,
    tie: null,
    winner: null,
    whiteGuess: null,
  };
  unlockAudio();
  keepAwake(true);
  saveGame();
  render();
}

function newRound() {
  game.round++;
  const alive = game.players.map((p, i) => i).filter(i => game.players[i].alive);
  const starters = alive.filter(i => game.players[i].role !== 'white');
  const start = starters.length ? starters[rand(starters.length)] : alive[0];
  const pos = alive.indexOf(start);
  game.order = alive.slice(pos).concat(alive.slice(0, pos));
  game.phase = 'round';
  game.tie = null;
  saveGame();
  render();
}

function eliminate(idx) {
  game.players[idx].alive = false;
  game.eliminatedIdx = idx;
  game.whiteGuess = null;
  game.phase = 'reveal';
  saveGame();
  render();
}

function checkWinner() {
  const alive = game.players.filter(p => p.alive);
  const civ = alive.filter(p => p.role === 'civil').length;
  const inf = alive.filter(p => p.role !== 'civil').length;
  if (inf === 0) return 'civil';
  if (civ <= 1) return 'infiltres';
  return null;
}

function afterElimination() {
  const w = checkWinner();
  if (w) endGame(w); else newRound();
}

function endGame(winner) {
  game.winner = winner;
  game.phase = 'end';
  saveGame();
  keepAwake(false);
  render();
}

function quitGame() {
  stopTimer();
  game = null;
  saveGame();
  keepAwake(false);
  render();
}

/* ============================================================
   Rendu
   ============================================================ */

function render() {
  stopTimer();
  ui.cleanup && ui.cleanup();
  ui.cleanup = null;
  // On ne remonte en haut que quand on change d'écran (pas quand on modifie un réglage)
  const screen = game ? game.phase + ':' + game.distIndex + ':' + game.round : 'setup';
  if (screen !== ui.lastScreen) window.scrollTo(0, 0);
  ui.lastScreen = screen;
  if (!game) return renderSetup();
  switch (game.phase) {
    case 'dist-pass': return renderDistPass();
    case 'dist-reveal': return renderDistReveal();
    case 'dist-done': return renderDistDone();
    case 'round': return renderRound();
    case 'timer': return renderTimer();
    case 'vote': return renderVote();
    case 'tie': return renderTie();
    case 'reveal': return renderReveal();
    case 'end': return renderEnd();
  }
}

function gameTopbar(title) {
  return `<div class="topbar">
    <span class="title">${esc(title)}</span>
    <button class="link-btn" id="quit">Quitter</button>
  </div>`;
}
function bindQuit() {
  const q = document.getElementById('quit');
  if (q) q.onclick = () => confirmModal('Quitter la partie en cours ?', 'Quitter', quitGame);
}

/* ---------- Écran de réglages ---------- */

function renderSetup() {
  const n = settings.players.length;
  const roles = currentRoles();
  const civ = n - roles.undercover - roles.white;
  const err = rolesError(n, roles.undercover, roles.white);
  const dupNames = new Set(settings.players.map(p => p.toLowerCase())).size !== n;

  const seg = (opts, cur, name) => `<div class="seg">${opts.map(o =>
    `<button data-seg="${name}" data-v="${o.v}" class="${cur === o.v ? 'on' : ''}">${o.label}</button>`).join('')}</div>`;

  $app.innerHTML = `
    <h1>Under<span>cover</span></h1>

    <section class="card">
      <h3>Joueurs (${n})</h3>
      <p class="hint" style="margin:0 0 10px">Dans l’ordre où vous êtes assis.</p>
      <div class="player-list">
        ${settings.players.map((p, i) => `
          <div class="player-row">
            <span class="num">${i + 1}</span>
            <input type="text" value="${esc(p)}" data-edit="${i}" maxlength="20" autocomplete="off">
            <button class="icon-btn" data-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Monter">↑</button>
            <button class="icon-btn" data-del="${i}" aria-label="Supprimer">✕</button>
          </div>`).join('')}
      </div>
      <form class="add-row" id="add-form">
        <input type="text" id="new-name" placeholder="Nom du joueur" maxlength="20" autocomplete="off">
        <button class="btn" type="submit">Ajouter</button>
      </form>
      ${dupNames ? '<p class="error">Deux joueurs ont le même nom.</p>' : ''}
    </section>

    <section class="card">
      <h3>Rôles ${settings.autoRoles ? '<span class="muted" style="text-transform:none;letter-spacing:0">(auto)</span>' : ''}</h3>
      <div class="stepper-row">
        <span><span class="dot civil"></span>Civils</span>
        <div class="stepper"><span class="val">${n >= 3 ? Math.max(civ, 0) : '–'}</span></div>
      </div>
      <div class="stepper-row">
        <span><span class="dot undercover"></span>Undercover</span>
        <div class="stepper">
          <button class="icon-btn" data-role="undercover" data-d="-1">−</button>
          <span class="val">${roles.undercover}</span>
          <button class="icon-btn" data-role="undercover" data-d="1">+</button>
        </div>
      </div>
      <div class="stepper-row">
        <span><span class="dot white"></span>Mr. White</span>
        <div class="stepper">
          <button class="icon-btn" data-role="white" data-d="-1">−</button>
          <span class="val">${roles.white}</span>
          <button class="icon-btn" data-role="white" data-d="1">+</button>
        </div>
      </div>
      ${!settings.autoRoles ? '<button class="link-btn" id="auto-roles">Revenir à la répartition automatique</button>' : ''}
      ${err && n >= 3 ? `<p class="error">${err}</p>` : ''}
    </section>

    <section class="card">
      <h3>Mots</h3>
      <p class="seg-label">Rareté des mots</p>
      ${seg(RARITY_OPTS, settings.rarity, 'rarity')}
      <p class="seg-label">Éloignement entre les deux mots</p>
      ${seg(DISTANCE_OPTS, settings.distance, 'distance')}
    </section>

    <section class="card">
      <h3>Discussion</h3>
      <div class="stepper-row">
        <span>Timer</span>
        <div class="stepper">
          <button class="icon-btn" data-timer="-1">−</button>
          <span class="val" style="min-width:72px">${settings.timer ? fmtTime(settings.timer) : 'Aucun'}</span>
          <button class="icon-btn" data-timer="1">+</button>
        </div>
      </div>
    </section>

    <button class="btn" id="start" ${err || dupNames ? 'disabled' : ''}>Lancer la partie</button>
    <button class="link-btn" id="rules">Rappel des règles</button>
  `;

  $app.querySelectorAll('[data-edit]').forEach(inp => {
    inp.onchange = () => {
      const v = inp.value.trim();
      const i = +inp.dataset.edit;
      if (v) settings.players[i] = v; else settings.players.splice(i, 1);
      saveSettings(); render();
    };
  });
  $app.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    settings.players.splice(+b.dataset.del, 1); saveSettings(); render();
  });
  $app.querySelectorAll('[data-up]').forEach(b => b.onclick = () => {
    const i = +b.dataset.up; const p = settings.players;
    [p[i - 1], p[i]] = [p[i], p[i - 1]]; saveSettings(); render();
  });
  document.getElementById('add-form').onsubmit = e => {
    e.preventDefault();
    const v = document.getElementById('new-name').value.trim();
    if (!v) return;
    settings.players.push(v); saveSettings(); render();
    document.getElementById('new-name').focus();
  };
  $app.querySelectorAll('[data-role]').forEach(b => b.onclick = () => {
    const cur = currentRoles();
    const next = Object.assign({}, cur);
    next[b.dataset.role] = Math.max(0, cur[b.dataset.role] + +b.dataset.d);
    settings.autoRoles = false;
    settings.undercover = next.undercover;
    settings.white = next.white;
    saveSettings(); render();
  });
  const ar = document.getElementById('auto-roles');
  if (ar) ar.onclick = () => { settings.autoRoles = true; saveSettings(); render(); };
  $app.querySelectorAll('[data-seg]').forEach(b => b.onclick = () => {
    settings[b.dataset.seg] = b.dataset.v; saveSettings(); render();
  });
  $app.querySelectorAll('[data-timer]').forEach(b => b.onclick = () => {
    const steps = [0, 30, 45, 60, 90, 120, 150, 180, 240, 300, 420, 600];
    let i = steps.indexOf(settings.timer); if (i < 0) i = 5;
    i = Math.min(steps.length - 1, Math.max(0, i + +b.dataset.timer));
    settings.timer = steps[i]; saveSettings(); render();
  });
  document.getElementById('start').onclick = startGame;
  document.getElementById('rules').onclick = showRules;
}

/* ---------- Distribution des mots ---------- */

function renderDistPass() {
  const p = game.players[game.distIndex];
  $app.innerHTML = `
    ${gameTopbar('Distribution des mots')}
    <p class="progress-text">Joueur ${game.distIndex + 1} / ${game.players.length}</p>
    <div class="pass-screen">
      <p class="muted">Passe le téléphone à</p>
      <div class="big-name">${esc(p.name)}</div>
      <p class="muted">Vérifie que personne d’autre ne regarde l’écran.</p>
    </div>
    <button class="btn" id="me">Je suis ${esc(p.name)}</button>
  `;
  bindQuit();
  document.getElementById('me').onclick = () => { game.phase = 'dist-reveal'; saveGame(); render(); };
}

function renderDistReveal() {
  const p = game.players[game.distIndex];
  const secret = p.role === 'white'
    ? `<div><div class="mrwhite">Tu es Mr. White</div>
         <p class="muted" style="margin-top:12px">Tu n’as pas de mot. Écoute les autres et bluffe&nbsp;!</p></div>`
    : `<div><div class="secret-label">Ton mot</div><div class="secret-word">${esc(p.word)}</div></div>`;
  const hidden = `<div><div style="font-size:3rem">👆</div>
      <p style="margin-top:12px;font-weight:700">Maintiens appuyé pour voir ton mot</p>
      <p class="muted" style="margin-top:6px">Il disparaît dès que tu relâches.</p></div>`;

  $app.innerHTML = `
    ${gameTopbar(p.name)}
    <div class="reveal-zone" id="zone">${hidden}</div>
    <button class="btn" id="seen" disabled>J’ai vu, passer au suivant</button>
  `;
  bindQuit();

  const zone = document.getElementById('zone');
  const seen = document.getElementById('seen');
  const show = e => {
    e.preventDefault();
    zone.innerHTML = secret; zone.classList.add('held');
    seen.disabled = false;
  };
  const hide = () => { zone.innerHTML = hidden; zone.classList.remove('held'); };
  zone.addEventListener('pointerdown', show);
  zone.addEventListener('pointerup', hide);
  zone.addEventListener('pointerleave', hide);
  zone.addEventListener('pointercancel', hide);
  zone.addEventListener('contextmenu', e => e.preventDefault());
  // Si l'app passe en arrière-plan, on cache immédiatement
  const onHidden = () => { if (document.hidden) hide(); };
  document.addEventListener('visibilitychange', onHidden);
  ui.cleanup = () => document.removeEventListener('visibilitychange', onHidden);

  seen.onclick = () => {
    game.distIndex++;
    game.phase = game.distIndex >= game.players.length ? 'dist-done' : 'dist-pass';
    saveGame(); render();
  };
}

function renderDistDone() {
  $app.innerHTML = `
    ${gameTopbar('Distribution terminée')}
    <div class="pass-screen">
      <div style="font-size:3.5rem">🤫</div>
      <h2>Tout le monde a vu son mot</h2>
      <p class="muted">Posez le téléphone au centre de la table. Les mots ne pourront plus être revus.</p>
    </div>
    <button class="btn" id="go">Commencer la partie</button>
  `;
  bindQuit();
  document.getElementById('go').onclick = newRound;
}

/* ---------- Tour de jeu ---------- */

function eliminatedChips() {
  const dead = game.players.filter(p => !p.alive);
  if (!dead.length) return '';
  return `<section class="card"><h3>Éliminés</h3><div class="eliminated-list">
    ${dead.map(p => `<span class="chip ${p.role}">${esc(p.name)} · ${ROLE_LABEL[p.role]}</span>`).join('')}
  </div></section>`;
}

function renderRound() {
  $app.innerHTML = `
    ${gameTopbar('Tour ' + game.round)}
    <section class="card">
      <h3>Ordre des indices</h3>
      <p class="hint" style="margin:0 0 10px">Chacun donne un mot ou une courte expression, à l’oral.</p>
      <ol class="order-list">
        ${game.order.map((i, k) => `<li><span class="pos">${k + 1}</span>${esc(game.players[i].name)}</li>`).join('')}
      </ol>
    </section>
    ${eliminatedChips()}
    <div class="grow"></div>
    <button class="btn" id="discuss">${settings.timer ? 'Lancer la discussion (' + fmtTime(settings.timer) + ')' : 'Passer au vote'}</button>
  `;
  bindQuit();
  document.getElementById('discuss').onclick = () => {
    unlockAudio();
    if (settings.timer) {
      game.phase = 'timer';
      game.timerEnd = Date.now() + settings.timer * 1000;
      game.timerRemaining = null; // null = en cours
      game.timerTotal = settings.timer;
    } else {
      game.phase = 'vote';
    }
    saveGame(); render();
  };
}

/* ---------- Timer ---------- */

let timerInterval = null;
function stopTimer() { if (timerInterval) { clearInterval(timerInterval); timerInterval = null; } }

function renderTimer() {
  const C = 2 * Math.PI * 45;
  $app.innerHTML = `
    ${gameTopbar('Discussion · Tour ' + game.round)}
    <div class="timer-wrap">
      <div class="ring" id="ring">
        <svg viewBox="0 0 100 100">
          <circle class="track" cx="50" cy="50" r="45"></circle>
          <circle class="bar" id="bar" cx="50" cy="50" r="45" stroke-dasharray="${C}" stroke-dashoffset="0"></circle>
        </svg>
        <div class="time" id="time"></div>
      </div>
      <div class="btn-row">
        <button class="btn secondary" id="pause"></button>
        <button class="btn secondary" id="plus">+30 s</button>
      </div>
    </div>
    <button class="btn" id="tovote">Passer au vote</button>
  `;
  bindQuit();

  const $ring = document.getElementById('ring');
  const $bar = document.getElementById('bar');
  const $time = document.getElementById('time');
  const $pause = document.getElementById('pause');
  let rang = false;

  const remaining = () => game.timerRemaining !== null
    ? game.timerRemaining
    : Math.max(0, (game.timerEnd - Date.now()) / 1000);

  const tick = () => {
    const r = remaining();
    $time.textContent = fmtTime(r);
    $bar.setAttribute('stroke-dashoffset', C * (1 - r / game.timerTotal));
    $ring.classList.toggle('low', r > 0 && r <= 10);
    $ring.classList.toggle('done', r <= 0);
    $pause.textContent = game.timerRemaining !== null ? 'Reprendre' : 'Pause';
    $pause.disabled = r <= 0;
    if (r <= 0 && !rang) {
      rang = true;
      if (game.timerRemaining === null && game.timerEnd > Date.now() - 3000) { beep(); vibrate([400, 150, 400, 150, 400]); }
      $time.textContent = 'Fini !';
      $time.style.fontSize = '3rem';
    }
  };

  $pause.onclick = () => {
    if (game.timerRemaining === null) {
      game.timerRemaining = remaining();
    } else {
      game.timerEnd = Date.now() + game.timerRemaining * 1000;
      game.timerRemaining = null;
    }
    saveGame(); tick();
  };
  document.getElementById('plus').onclick = () => {
    const r = remaining() + 30;
    game.timerTotal = Math.max(game.timerTotal, r);
    if (game.timerRemaining !== null) game.timerRemaining = r;
    else game.timerEnd = Date.now() + r * 1000;
    rang = false;
    $time.style.fontSize = '';
    saveGame(); tick();
  };
  document.getElementById('tovote').onclick = () => { game.phase = 'vote'; saveGame(); render(); };

  tick();
  timerInterval = setInterval(tick, 250);
}

/* ---------- Vote ---------- */

function renderVote() {
  const alive = game.players.map((p, i) => i).filter(i => game.players[i].alive);
  const sel = ui.voteSel;
  $app.innerHTML = `
    ${gameTopbar('Vote · Tour ' + game.round)}
    <section>
      <h2>Qui est éliminé ?</h2>
      <p class="muted" style="margin-top:4px">Votez à main levée, puis touchez le joueur qui a reçu le plus de voix.</p>
    </section>
    <div class="vote-list">
      ${alive.map(i => `<button data-p="${i}" class="${sel === i ? 'on' : ''}">${esc(game.players[i].name)}</button>`).join('')}
    </div>
    <div class="grow"></div>
    <button class="btn danger" id="elim" ${sel === undefined || sel === null ? 'disabled' : ''}>
      ${sel !== undefined && sel !== null ? 'Éliminer ' + esc(game.players[sel].name) : 'Éliminer'}
    </button>
    <button class="btn secondary" id="tie">Égalité entre plusieurs joueurs</button>
  `;
  bindQuit();
  $app.querySelectorAll('[data-p]').forEach(b => b.onclick = () => {
    ui.voteSel = +b.dataset.p === ui.voteSel ? null : +b.dataset.p; renderVote();
  });
  document.getElementById('elim').onclick = () => { const i = ui.voteSel; ui.voteSel = null; eliminate(i); };
  document.getElementById('tie').onclick = () => {
    ui.voteSel = null;
    game.tie = { step: 'select', players: [] };
    game.phase = 'tie'; saveGame(); render();
  };
}

function renderTie() {
  const t = game.tie;
  if (t.step === 'select') {
    const alive = game.players.map((p, i) => i).filter(i => game.players[i].alive);
    $app.innerHTML = `
      ${gameTopbar('Égalité · Tour ' + game.round)}
      <section>
        <h2>Qui est à égalité ?</h2>
        <p class="muted" style="margin-top:4px">Sélectionne les joueurs ex-æquo.</p>
      </section>
      <div class="vote-list">
        ${alive.map(i => `<button data-p="${i}" class="multi ${t.players.includes(i) ? 'on' : ''}">${esc(game.players[i].name)}</button>`).join('')}
      </div>
      <div class="grow"></div>
      <button class="btn" id="revote" ${t.players.length < 2 ? 'disabled' : ''}>Revoter entre ces joueurs</button>
      <button class="btn secondary" id="back">Retour</button>
    `;
    bindQuit();
    $app.querySelectorAll('[data-p]').forEach(b => b.onclick = () => {
      const i = +b.dataset.p;
      t.players = t.players.includes(i) ? t.players.filter(x => x !== i) : t.players.concat(i);
      saveGame(); renderTie();
    });
    document.getElementById('revote').onclick = () => { t.step = 'revote'; saveGame(); render(); };
    document.getElementById('back').onclick = () => { game.tie = null; game.phase = 'vote'; saveGame(); render(); };
    return;
  }

  const sel = ui.voteSel;
  $app.innerHTML = `
    ${gameTopbar('Second vote · Tour ' + game.round)}
    <section>
      <h2>Second vote</h2>
      <p class="muted" style="margin-top:4px">Tout le monde revote, uniquement entre ces joueurs.</p>
    </section>
    <div class="vote-list">
      ${t.players.map(i => `<button data-p="${i}" class="${sel === i ? 'on' : ''}">${esc(game.players[i].name)}</button>`).join('')}
    </div>
    <div class="grow"></div>
    <button class="btn danger" id="elim" ${sel === undefined || sel === null ? 'disabled' : ''}>
      ${sel !== undefined && sel !== null ? 'Éliminer ' + esc(game.players[sel].name) : 'Éliminer'}
    </button>
    <button class="btn secondary" id="random">Encore égalité : tirage au sort</button>
  `;
  bindQuit();
  $app.querySelectorAll('[data-p]').forEach(b => b.onclick = () => {
    ui.voteSel = +b.dataset.p === ui.voteSel ? null : +b.dataset.p; renderTie();
  });
  document.getElementById('elim').onclick = () => { const i = ui.voteSel; ui.voteSel = null; eliminate(i); };
  document.getElementById('random').onclick = () => {
    confirmModal('Tirer au sort un joueur à éliminer parmi les ex-æquo ?', 'Tirer au sort', () => {
      ui.voteSel = null;
      eliminate(t.players[rand(t.players.length)]);
    });
  };
}

/* ---------- Révélation du rôle ---------- */

function renderReveal() {
  const p = game.players[game.eliminatedIdx];

  if (p.role === 'white' && game.whiteGuess === null) {
    $app.innerHTML = `
      ${gameTopbar('Élimination')}
      <div class="role-reveal">
        <div class="name">${esc(p.name)}</div>
        <p class="muted">était</p>
        <span class="role-badge white">Mr. White</span>
        <p style="margin-top:12px">Dernière chance&nbsp;! Si tu trouves le mot des Civils, tu gagnes seul.</p>
        <form id="guess-form" style="display:flex;flex-direction:column;gap:10px">
          <input type="text" id="guess" placeholder="Le mot des Civils" autocomplete="off" autocapitalize="off" spellcheck="false">
          <button class="btn" type="submit">Valider</button>
        </form>
      </div>
    `;
    bindQuit();
    document.getElementById('guess-form').onsubmit = e => {
      e.preventDefault();
      const g = document.getElementById('guess').value.trim();
      if (!g) return;
      game.whiteGuess = g;
      if (guessMatches(g, game.civWord)) { endGame('white'); return; }
      saveGame(); render();
    };
    return;
  }

  const w = checkWinner();
  $app.innerHTML = `
    ${gameTopbar('Élimination')}
    <div class="role-reveal">
      <div class="name">${esc(p.name)}</div>
      <p class="muted">était</p>
      <span class="role-badge ${p.role}">${ROLE_LABEL[p.role]}</span>
      ${p.role === 'white' ? `<p class="muted" style="margin-top:8px">« ${esc(game.whiteGuess)} » : raté&nbsp;!</p>` : ''}
    </div>
    <button class="btn" id="next">${w ? 'Voir le résultat' : 'Tour suivant'}</button>
  `;
  bindQuit();
  document.getElementById('next').onclick = afterElimination;
}

/* ---------- Fin de partie ---------- */

function renderEnd() {
  const hasUc = game.players.some(p => p.role === 'undercover');
  const hasWhite = game.players.some(p => p.role === 'white');
  let cls, emoji, title, sub = '';
  if (game.winner === 'civil') {
    cls = 'civil'; emoji = '🎉'; title = 'Les Civils gagnent !';
  } else if (game.winner === 'white') {
    const w = game.players[game.eliminatedIdx];
    cls = 'white'; emoji = '🕵️'; title = esc(w.name) + ' (Mr. White) gagne !';
    sub = `Mot des Civils trouvé : « ${esc(game.whiteGuess)} ».`;
  } else {
    cls = 'undercover'; emoji = '😈';
    title = hasUc && hasWhite ? 'Les infiltrés gagnent !' : hasUc ? 'Les Undercovers gagnent !' : 'Mr. White gagne !';
    sub = 'Il ne reste plus qu’un seul Civil.';
  }

  $app.innerHTML = `
    <div class="winner ${cls}">
      <div class="emoji">${emoji}</div>
      <h2>${title}</h2>
      ${sub ? `<p class="muted" style="margin-top:6px">${sub}</p>` : ''}
    </div>
    <div class="words-reveal">
      <div><div class="lbl">Mot des Civils</div><div class="w">${esc(game.civWord)}</div></div>
      <div><div class="lbl">Mot Undercover</div><div class="w">${esc(game.ucWord)}</div></div>
    </div>
    <section class="card">
      <table class="recap">
        ${game.players.map(p => `<tr class="${p.alive ? '' : 'dead'}">
          <td>${esc(p.name)}</td>
          <td><span class="chip ${p.role}">${ROLE_LABEL[p.role]}</span></td>
        </tr>`).join('')}
      </table>
    </section>
    <div class="grow"></div>
    <button class="btn" id="again">Rejouer avec les mêmes joueurs</button>
    <button class="btn secondary" id="settings">Modifier les réglages</button>
  `;
  document.getElementById('again').onclick = () => { game = null; startGame(); };
  document.getElementById('settings').onclick = quitGame;
}

/* ============================================================
   Modales
   ============================================================ */

function openModal(html) {
  $modal.innerHTML = `<div class="sheet">${html}</div>`;
  $modal.classList.remove('hidden');
  $modal.onclick = e => { if (e.target === $modal) closeModal(); };
}
function closeModal() { $modal.classList.add('hidden'); $modal.innerHTML = ''; }

function confirmModal(text, okLabel, onOk) {
  openModal(`
    <p style="font-weight:600;font-size:1.1rem">${esc(text)}</p>
    <div class="btn-row">
      <button class="btn secondary" id="m-cancel">Annuler</button>
      <button class="btn danger" id="m-ok">${esc(okLabel)}</button>
    </div>`);
  document.getElementById('m-cancel').onclick = closeModal;
  document.getElementById('m-ok').onclick = () => { closeModal(); onOk(); };
}

function showRules() {
  openModal(`
    <div class="rules">
      <h2>Règles</h2>
      <h4>Les rôles</h4>
      <ul>
        <li><b>Civils</b> : ils reçoivent tous le même mot.</li>
        <li><b>Undercover</b> : il reçoit un mot proche, et <b>ne sait pas</b> qu’il est Undercover.</li>
        <li><b>Mr. White</b> : il ne reçoit aucun mot, et le sait.</li>
      </ul>
      <h4>Un tour</h4>
      <ul>
        <li>Chacun donne à l’oral un mot ou une courte expression en rapport avec son mot, dans l’ordre indiqué. Mr. White ne commence jamais.</li>
        <li>Discussion, limitée par le timer.</li>
        <li>Vote à main levée : le plus voté est éliminé et son rôle est révélé (pas son mot).</li>
        <li>En cas d’égalité, on revote entre les ex-æquo. S’il y a encore égalité, un tirage au sort départage.</li>
        <li>Si Mr. White est éliminé, il peut deviner le mot des Civils. S’il trouve, il gagne seul.</li>
      </ul>
      <h4>Victoire</h4>
      <ul>
        <li><b>Civils</b> : tous les Undercovers et Mr. White sont éliminés.</li>
        <li><b>Infiltrés</b> (Undercovers et Mr. White) : il ne reste plus qu’un seul Civil.</li>
      </ul>
    </div>
    <button class="btn" id="m-close">Compris</button>`);
  document.getElementById('m-close').onclick = closeModal;
}

/* ============================================================
   Démarrage
   ============================================================ */

if (game) keepAwake(true);
render();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* ignore */ });
}
