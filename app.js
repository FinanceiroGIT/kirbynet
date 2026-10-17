"use strict";
// kirbynet — interface no navegador. Todo mundo joga aqui dentro (WebAssembly);
// o Python só serve a página e repassa os botões entre os jogadores.

const W = 240, H = 160;
const BUTTONS = ["A", "B", "L", "R", "Start", "Select", "Cima", "Baixo", "Esquerda", "Direita"];
const BIT = { A: 1, B: 2, Select: 4, Start: 8, Direita: 16, Esquerda: 32, Cima: 64, Baixo: 128, R: 256, L: 512 };
const COLORS = ["var(--p1)", "var(--p2)", "var(--p3)", "var(--p4)"];

const $ = (id) => document.getElementById(id);
// Abriu pelo IP de outro PC (convidado, sem Python)? Então o jogo roda aqui, em WebAssembly.
const GUEST = !["localhost", "127.0.0.1", "[::1]", "::1"].includes(location.hostname);
let S = {};               // estado da partida (para desenhar)
let HS = {};              // estado da tela de controle vindo do Python (só no PC do host)
let ws = null;
let localN = 2, delay = 3;
const canvases = {};       // idx -> {ctx}

// ------------------------------------------------------------------ controles
const KB_DEFAULT = [
  { A: "KeyZ", B: "KeyX", L: "KeyA", R: "KeyS", Start: "Enter", Select: "Backspace",
    Cima: "ArrowUp", Baixo: "ArrowDown", Esquerda: "ArrowLeft", Direita: "ArrowRight" },
  { A: "Numpad1", B: "Numpad2", L: "Numpad7", R: "Numpad9", Start: "NumpadAdd", Select: "NumpadSubtract",
    Cima: "Numpad8", Baixo: "Numpad5", Esquerda: "Numpad4", Direita: "Numpad6" },
  {}, {},
];
const PAD_DEFAULT = { A: "b1", B: "b0", L: "b4", R: "b5", Select: "b8", Start: "b9",
  Cima: "b12", Baixo: "b13", Esquerda: "b14", Direita: "b15" };

function defaultProfile(i) {
  return { kb: { ...KB_DEFAULT[i] }, pad: i, padMap: { ...PAD_DEFAULT }, stick: true };
}
function loadProfiles() {
  try {
    const p = JSON.parse(localStorage.getItem("kirbynet.profiles"));
    if (Array.isArray(p) && p.length === 4) return p;
  } catch (e) {}
  return [0, 1, 2, 3].map(defaultProfile);
}
function saveProfiles() {
  try { localStorage.setItem("kirbynet.profiles", JSON.stringify(profiles)); } catch (e) {}
}
let profiles = loadProfiles();

const down = new Set();
function typing() { const a = document.activeElement; return a && (a.tagName === "INPUT" || a.tagName === "SELECT"); }
function boundKeys() {
  const s = new Set();
  profiles.forEach(p => Object.values(p.kb).forEach(c => c && s.add(c)));
  return s;
}
addEventListener("keydown", (e) => {
  if (capture) { e.preventDefault(); return finishCapture("kb", e.code); }
  if (e.code === "F2" && Play.run) { e.preventDefault(); toggleRunView(); return; }
  if (e.code === "F3" && Play.run) { e.preventDefault(); Fit.cycle(); return; }
  if (DEBUG_KEYS) toast(`tecla: key=${e.key} code=${e.code || "—"} keyCode=${e.keyCode}`);
  // Xbox: o controle também gera teclas ("GamepadB", "Escape", "Unidentified"…) que o Edge usa para
  // voltar / sair da tela cheia. Na partida, nenhuma tecla vai para o navegador.
  if (Play.run && !typing() && (XBOX || boundKeys().has(e.code) || /^Gamepad/.test(e.key))) {
    e.preventDefault(); e.stopPropagation();
  }
  down.add(e.code);
  if (Play.run) sendKeys(Play.run);   // manda o botão NA HORA (não espera o próximo timer)
});
addEventListener("keyup", (e) => {
  if (Play.run && XBOX && !typing()) e.preventDefault();
  down.delete(e.code); if (Play.run) sendKeys(Play.run);
});
addEventListener("blur", () => down.clear());

function padActive(pad, bind) {
  if (!pad || !bind) return false;
  if (bind[0] === "b") { const b = pad.buttons[+bind.slice(1)]; return !!b && (b.pressed || b.value > 0.5); }
  const i = parseInt(bind.slice(1)), dir = bind.endsWith("-") ? -1 : 1;
  const v = pad.axes[i] || 0;
  return v * dir > 0.5;
}
function maskFor(p) {
  const prof = profiles[p];
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let pad = prof.pad >= 0 ? pads[prof.pad] : null;
  // Jogador 1 sem o controle escolhido (ex.: Xbox, onde o controle pode não ser o nº 1)? usa o primeiro que achar
  if (!pad && p === 0 && prof.pad >= 0) pad = [...pads].find(Boolean) || null;
  let m = 0;
  for (const name of BUTTONS) {
    if ((prof.kb[name] && down.has(prof.kb[name])) || padActive(pad, prof.padMap[name])) m |= BIT[name];
  }
  if (p === 0 && typeof Touch !== "undefined") m |= Touch.mask;   // botões de toque = Jogador 1 deste aparelho
  if (pad && prof.stick) {
    const x = pad.axes[0] || 0, y = pad.axes[1] || 0;
    if (x < -0.5) m |= BIT.Esquerda; if (x > 0.5) m |= BIT.Direita;
    if (y < -0.5) m |= BIT.Cima; if (y > 0.5) m |= BIT.Baixo;
  }
  return m;
}


function pollInputs() {
  if (capture) pollCapture();
  PadMode.poll();
  if (!$("ctl").classList.contains("hidden")) liveView();
}
setInterval(pollInputs, 16);

// ------------------------------------------------------------------ tela de controles
let ctlTab = 0, capture = null, padSnapshot = null;
const KEYNAME = (c) => !c ? "—" : c.replace(/^Key/, "").replace(/^Digit/, "")
  .replace("ArrowUp", "↑").replace("ArrowDown", "↓").replace("ArrowLeft", "←").replace("ArrowRight", "→")
  .replace(/^Numpad/, "Num ").replace("Add", "+").replace("Subtract", "−").replace("Backspace", "⌫ Backspace");
const PADNAME = (b) => !b ? "—" : b[0] === "b" ? `Botão ${b.slice(1)}` : `Eixo ${parseInt(b.slice(1))} ${b.endsWith("-") ? "−" : "+"}`;

function openControls() { $("ctl").classList.remove("hidden"); renderControls(); }
function renderControls() {
  const tabs = $("ctl-tabs");
  tabs.innerHTML = "";
  for (let i = 0; i < 4; i++) {
    const b = document.createElement("button");
    b.textContent = `Jogador ${i + 1}` + (i === 0 ? " / rede" : "");
    b.style.setProperty("--c", COLORS[i]);
    b.className = i === ctlTab ? "on" : "";
    b.onclick = () => { ctlTab = i; capture = null; renderControls(); };
    tabs.appendChild(b);
  }
  const prof = profiles[ctlTab];
  const dev = $("ctl-device");
  dev.innerHTML = `<option value="-1">Só teclado</option>` +
    [0, 1, 2, 3].map(i => `<option value="${i}">Teclado + Controle ${i + 1}</option>`).join("");
  dev.value = String(prof.pad);
  $("ctl-stick").checked = !!prof.stick;
  const pads = navigator.getGamepads ? [...navigator.getGamepads()] : [];
  const pad = prof.pad >= 0 ? pads[prof.pad] : null;
  $("pad-info").textContent = prof.pad < 0 ? "" : pad ? `✔ ${pad.id.slice(0, 48)}` :
    "Controle não detectado — aperte qualquer botão nele.";
  const map = $("ctl-map");
  map.innerHTML = "";
  for (const name of BUTTONS) {
    const row = document.createElement("div");
    row.className = "bind";
    row.dataset.name = name;
    const waitKb = capture && capture.name === name && capture.kind === "kb";
    const waitPad = capture && capture.name === name && capture.kind === "pad";
    if (waitKb || waitPad) row.classList.add("wait");
    row.innerHTML = `<b>${name}</b>
      <span class="val">⌨ ${waitKb ? "aperte uma tecla…" : KEYNAME(prof.kb[name])}</span>
      <button class="ghost" data-k="kb">Mudar</button>
      <span class="val">🎮 ${waitPad ? "aperte no controle…" : PADNAME(prof.padMap[name])}</span>
      <button class="ghost" data-k="pad" ${prof.pad < 0 ? "disabled" : ""}>Mudar</button>`;
    row.querySelectorAll("button").forEach(btn => btn.onclick = () => startCapture(name, btn.dataset.k));
    map.appendChild(row);
  }
}
function startCapture(name, kind) {
  capture = { name, kind };
  padSnapshot = null;
  renderControls();
}
function finishCapture(kind, value) {
  if (!capture || capture.kind !== kind) return;
  const prof = profiles[ctlTab];
  if (kind === "kb") {
    if (value === "Escape") { capture = null; return renderControls(); }
    for (const k in prof.kb) if (prof.kb[k] === value) prof.kb[k] = "";   // tecla não fica em 2 botões
    prof.kb[capture.name] = value;
  } else {
    for (const k in prof.padMap) if (prof.padMap[k] === value) prof.padMap[k] = "";
    prof.padMap[capture.name] = value;
  }
  capture = null;
  saveProfiles();
  renderControls();
}
function pollCapture() {
  if (capture.kind !== "pad") return;
  const prof = profiles[ctlTab];
  const pad = navigator.getGamepads ? navigator.getGamepads()[prof.pad] : null;
  if (!pad) return;
  const snap = { b: pad.buttons.map(b => b.pressed || b.value > 0.5), a: [...pad.axes] };
  if (!padSnapshot) { padSnapshot = snap; return; }
  for (let i = 0; i < snap.b.length; i++) if (snap.b[i] && !padSnapshot.b[i]) return finishCapture("pad", "b" + i);
  for (let i = 0; i < snap.a.length; i++) {
    if (Math.abs(snap.a[i]) > 0.6 && Math.abs(padSnapshot.a[i]) < 0.3) return finishCapture("pad", `a${i}${snap.a[i] < 0 ? "-" : "+"}`);
  }
  padSnapshot.b = snap.b;
}
function liveView() {
  const m = maskFor(ctlTab);
  document.querySelectorAll("#ctl-map .bind").forEach(r => r.classList.toggle("live", !!(m & BIT[r.dataset.name])));
  $("ctl-live").textContent = m ? "Apertando: " + BUTTONS.filter(b => m & BIT[b]).join(" + ") : "Aperte algo para testar";
}
$("ctl-device").onchange = (e) => { profiles[ctlTab].pad = +e.target.value; saveProfiles(); renderControls(); };
$("ctl-stick").onchange = (e) => { profiles[ctlTab].stick = e.target.checked; saveProfiles(); };
$("ctl-reset").onclick = () => { profiles[ctlTab] = defaultProfile(ctlTab); saveProfiles(); renderControls(); };
$("ctl-close").onclick = () => { capture = null; $("ctl").classList.add("hidden"); };
$("btn-controls").onclick = openControls;
$("btn-controls2").onclick = openControls;
addEventListener("gamepadconnected", () => {
  if (!$("ctl").classList.contains("hidden")) renderControls();
  toast("🎮 Controle conectado!");
  // ligou um controle e ninguém escolheu mostrar os botões de toque: esconde (Xbox / celular com controle)
  let pref = null; try { pref = localStorage.getItem("kirbynet.touch"); } catch (e) {}
  if (pref === null && Touch.shown) { Touch.shown = false; Touch.pointers.clear(); touchUpdate(); applyTouch(); }
});

// ------------------------------------------------------------------ Xbox (Edge)
// No navegador do Xbox o botão B do controle = "Voltar" da página. Durante a partida isso
// não pode tirar ninguém do jogo: guardamos uma entrada extra no histórico e a recolocamos.
const XBOX = /Xbox/i.test(navigator.userAgent);
const DEBUG_KEYS = /[?&]teclas/.test(location.search);   // abra com ?teclas para ver o que cada botão manda
// Tela cheia + Keyboard Lock: Esc (e o B do Xbox) deixam de sair da tela cheia; segurar Esc ainda sai.
addEventListener("fullscreenchange", () => {
  const kb = navigator.keyboard;
  if (!kb || !kb.lock) return;
  if (document.fullscreenElement && Play.run) kb.lock().catch(() => {});
  else kb.unlock();
});
history.pushState({ kn: 1 }, "");
addEventListener("popstate", () => {
  if (!Play.run) return;
  history.pushState({ kn: 1 }, "");
  toast("Para sair da partida use o botão Sair.");
});
if (XBOX) setTimeout(() => toast("🎮 No Xbox: entre em ⛶ Tela cheia para o controle ir só para o jogo."), 1500);
// Edge do Xbox: em modo "mouse" o controle vira cursor (B = voltar, Y = teclado, analógico rola a página).
// Em modo "gamepad" tudo vai só para a página. Ligado durante a partida; L3+R3 juntos devolvem o cursor.
// O Edge do Xbox só mostra o controle para a página (Gamepad API) no modo "gamepad"; no modo
// "mouse" a página nem vê o controle. L3+R3 juntos devolvem o cursor; tocar na tela do jogo
// (ou o botão nos Controles) volta ao modo controle.
const PAD_EMU = "gamepadInputEmulation" in Navigator.prototype || "gamepadInputEmulation" in navigator;
const PadMode = {
  on: false, combo: false,
  set(on) {
    this.on = on;
    try { navigator.gamepadInputEmulation = on ? "gamepad" : "mouse"; } catch (e) {}
    document.body.classList.toggle("playing", !!Play.run);
    if (XBOX && on && !PAD_EMU) toast("⚠ Este Edge não aceita o modo controle (gamepadInputEmulation).");
  },
  poll() {
    if (!XBOX || !this.on) return;
    const both = [...(navigator.getGamepads ? navigator.getGamepads() : [])]
      .some(p => p && p.buttons[10] && p.buttons[11] && p.buttons[10].pressed && p.buttons[11].pressed);
    if (both && !this.combo) {
      this.set(false);
      toast("🖱 Cursor ligado. Para voltar ao controle: toque na tela do jogo.");
    }
    this.combo = both;
  },
};
if (XBOX) {
  const b = document.createElement("button");
  b.textContent = "🎮 Usar o controle na página (L3+R3 = cursor)";
  b.onclick = () => { PadMode.set(true); toast("🎮 Modo controle ligado — aperte um botão no controle."); };
  $("ctl-reset").after(b);
  $("stage").addEventListener("click", () => { if (Play.run && !PadMode.on) PadMode.set(true); });
}

// ------------------------------------------------------------------ conexão com o Python (só no PC do host)
function send(obj) {
  if (SiteRoom.on) return SiteRoom.handle(obj);   // sala criada pelo site: ela mesma é o "Python"
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => $("conn").classList.add("hidden");
  ws.onclose = () => { $("conn").classList.remove("hidden"); setTimeout(connect, 1000); };
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.t === "state") applyState(m); };
}

let lastError = null;
const Host = { net: null, joining: false };
function applyState(m) {
  HS = m;
  if (m.error && m.error !== lastError) toast(m.error);
  lastError = m.error;
  Bridge.sync(m.screen !== "menu");   // quem entra pelo site (mesma internet, ou de longe com o código)
  if (Play.run) return;                       // jogando: a tela de jogo manda
  if (m.screen === "menu") { showOnly("menu"); renderMenu(m); }
  else { showOnly("lobby"); renderLobby(m); }
  if (m.screen === "lobby" && !Host.net && !Host.joining) hostAutoJoin();
}

function renderMenu(m) {
  const sel = $("rom");
  sel.innerHTML = m.roms.length ? m.roms.map(r => `<option>${esc(r)}</option>`).join("")
    : `<option value="">Nenhuma ROM — clique em “Enviar ROM”</option>`;
  if (m.rom && m.roms.includes(m.rom)) sel.value = m.rom;
  if (document.activeElement !== $("name")) $("name").value = m.name || "";
}
function badges(el, names, my, total) {
  el.innerHTML = "";
  for (let i = 0; i < total; i++) {
    const b = document.createElement("span");
    if (i < names.length) {
      b.className = "badge";
      b.style.background = COLORS[i];
      b.textContent = `P${i + 1}  ${names[i]}${i === my && S.mode === "net" ? " (você)" : ""}`;
    } else { b.className = "badge free"; b.textContent = `P${i + 1}  livre`; }
    el.appendChild(b);
  }
}
function renderLobby(m) {
  $("lobby-host").classList.remove("hidden");
  $("lobby-wait").classList.add("hidden");
  $("lobby-start").classList.toggle("hidden", m.screen !== "lobby");
  $("ips").textContent = (m.ips || []).join("  ou  ");
  $("guest-urls").textContent = (m.guest_urls || []).join("  ou  ");
  $("room-code").textContent = m.code || Bridge.code || "…";
  S = { mode: "net", my: 0 };
  badges($("players"), m.players, 0, 4);
}
function renderGame(m, fresh) {
  badges($("game-players"), m.players, m.my, m.players.length);
  const show = m.mode === "local" || m.view_all ? [...Array(m.n).keys()] : [m.my];
  const stage = $("stage");
  const key = show.join(",");
  if (fresh || stage.dataset.key !== key) {
    stage.dataset.key = key;
    stage.className = "stage " + (show.length === 1 ? "one" : "many");
    stage.innerHTML = "";
    const bg = document.createElement("canvas");   // fundo desfocado (modo "Bordas desfocadas")
    bg.className = "bgblur"; bg.width = 48; bg.height = 32;
    stage.appendChild(bg);
    Fit.bg = bg.getContext("2d");
    for (const k in canvases) delete canvases[k];
    for (const i of show) {
      const box = document.createElement("div");
      box.className = "screen";
      box.style.setProperty("--c", COLORS[i]);
      const cv = document.createElement("canvas");
      cv.width = W; cv.height = H;
      const ctx = cv.getContext("2d", { alpha: false });
      canvases[i] = { ctx, img: ctx.createImageData(W, H) };
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = `P${i + 1} ${m.players[i] || ""}`;
      box.append(cv, tag);
      stage.appendChild(box);
    }
  }
  Fit.apply();
  $("btn-all").textContent = m.view_all ? "Só a minha" : "Ver todas";
  $("btn-all").classList.toggle("hidden", m.mode === "local");
  $("desync").classList.toggle("hidden", m.desync == null);
  if (m.desync != null) $("desync").textContent = `⚠️ Os PCs dessincronizaram no frame ${m.desync}. Saiam e recomecem.`;
}
function showStatus(st) {
  let t = `${st.fps.toFixed(1)} fps · frame ${st.frame}`;
  if (st.delay != null) t += ` · atraso ${st.delay}`;
  // "Mesmo PC": carga deste aparelho rodando todos os GBAs (serve para testar se ele aguenta 4 em rede)
  else if (st.load != null) {
    const cpu = Math.max(st.load, st.page ?? 0);
    t += ` · CPU ${cpu}%` + (cpu >= 85 ? " ⚠️ no limite" : "");
  }
  // cada jogador (últimos 10 s): rede e carga do aparelho. "P2 6 ms UDP ⚠️ pico 180 ms ×3, CPU 45%"
  // CPU = o maior entre motor e página; 85%+ = o aparelho está no limite e segura todo mundo.
  const q = st.delay != null && Play.run && Play.run.net && Play.run.net.q;
  if (q && Object.keys(q).length) {
    t += " · " + Object.keys(q).sort().map(s => {
      const v = q[s];
      let x = `P${+s + 1} ${v.med} ms` + (v.via === "udp" ? " UDP" : "");
      if (v.max >= 50) x += ` ⚠️ pico ${v.max} ms` + (v.spikes > 1 ? ` ×${v.spikes}` : "");
      if (v.lost) x += ` (${v.lost} perdido${v.lost > 1 ? "s" : ""})`;
      const cpu = Math.max(v.cpu ?? -1, v.page ?? -1);
      if (cpu >= 0) x += `, CPU ${cpu}%` + (cpu >= 85 ? " ⚠️" : "");
      return x;
    }).join(" | ");
  }
  if (st.waiting && st.waiting.length) t = `⏳ esperando os botões de ${st.waiting.map(i => "P" + (i + 1)).join(", ")}… · ` + t;
  const at = Play.run && Play.run.savedAt;
  if (at) t += ` · 💾 salvo às ${at.toLocaleTimeString("pt-BR")}`;
  // convidado em http://IP: o navegador não libera o som rápido (veja "SOM MAIS RÁPIDO" no LEIA-ME)
  if (Sound.on && Sound.ctx && Sound.mode !== "worklet") t += " · 🔈 som em modo compatível";
  $("status").textContent = t;
}

let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 7000);
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// ------------------------------------------------------------------ o host joga pelo navegador também
const stem = (rom) => rom.replace(/\.gba$/i, "");
async function fetchBytes(url) { const r = await fetch(url); if (!r.ok) throw new Error(await r.text()); return new Uint8Array(await r.arrayBuffer()); }
async function postBytes(url, bytes) { if (bytes && bytes.length) await fetch(url, { method: "POST", body: bytes }); }

// Grava saves na pasta "saves" do host. Um envio por vez (na ordem), e o .bak é feito só
// na primeira gravação de cada partida: assim o .bak é sempre o save de ANTES da sessão.
function saveWriter(files) {
  let rotated = false, chain = Promise.resolve(), warned = false;
  return (saves, unload) => {
    const bak = rotated ? "" : "&bak=1";
    rotated = true;
    files.forEach((f, i) => {
      const b = saves[i];
      if (!b || !b.length) return;
      const url = `/save?file=${encodeURIComponent(f)}${bak}`;
      if (unload) {   // a aba está fechando: o navegador entrega mesmo depois de a página sumir
        const ok = navigator.sendBeacon && navigator.sendBeacon(url, new Blob([b], { type: "application/octet-stream" }));
        if (!ok) fetch(url, { method: "POST", body: b, keepalive: true }).catch(() => {});
        return;
      }
      chain = chain.then(() => fetch(url, { method: "POST", body: b }))
        .then(r => { if (!r.ok) throw new Error(r.status); })
        .catch(() => { if (!warned) { warned = true; toast("⚠️ Não consegui salvar no PC. A janela preta do Python está aberta?"); } });
    });
  };
}

async function hostAutoJoin() {
  // Assim que a sala é criada, a página do host entra nela como P1.
  Host.joining = true;
  try {
    const rom = await fetchBytes(`/rom?name=${encodeURIComponent(HS.rom)}`);
    const save = await fetchBytes(`/save?file=${encodeURIComponent(stem(HS.rom) + ".sav")}`);
    await loadEngine();
    const romName = HS.rom;
    Host.net = netJoin(`ws://${location.host}/net`, { name: HS.name || "Host", rom: sha1Hex(rom), save: b64enc(save) }, {
      onLobby() {},
      onStart(info) {
        try {
          startRun({ n: info.n, rom, saves: info.saves.map(b64dec), names: info.names, net: Host.net,
                     slot: Host.net.slot, delay: info.delay,
                     onSave: saveWriter([stem(romName) + ".sav"]) });
        } catch (err) { toast(String(err.message || err)); }
      },
      onError(msg) {
        const wasPlaying = !!Play.run;
        endRun();
        Host.net = null;
        if (!/^O host (fechou|criou)/.test(msg)) toast(msg + (wasPlaying ? " Seu save foi guardado." : ""));
        applyState(HS);
      },
    });
  } catch (err) {
    toast("Não consegui entrar na própria sala: " + (err.message || err));
  }
  Host.joining = false;
}

async function localPlay() {
  if (!HS.rom) return toast("Escolha (ou envie) a ROM primeiro.");
  const romName = HS.rom;
  try {
    const rom = await fetchBytes(`/rom?name=${encodeURIComponent(romName)}`);
    const files = [...Array(localN).keys()].map(i => `${stem(romName)}_P${i + 1}.sav`);
    const saves = await Promise.all(files.map(f => fetchBytes(`/save?file=${encodeURIComponent(f)}`)));
    await loadEngine();
    startRun({ n: localN, rom, saves, names: files.map((_, i) => `Jogador ${i + 1}`), net: null, slot: 0, delay: 0,
               onSave: saveWriter(files), onEnd() { applyState(HS); } });
  } catch (err) { toast("Não deu pra iniciar: " + (err.message || err)); }
}

// ------------------------------------------------------------------ botões da página
$("rom").onchange = (e) => send({ t: "set", rom: e.target.value });
$("name").onchange = (e) => send({ t: "set", name: e.target.value });
$("upload").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  toast(`Enviando ${f.name}…`);
  const r = await fetch(`/upload?name=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
  const j = await r.json();
  toast(j.ok ? `ROM pronta: ${j.rom}` : `Não deu: ${j.msg}`);
  e.target.value = "";
};
document.querySelectorAll("[data-step]").forEach(b => b.onclick = () => {
  localN = Math.max(1, Math.min(4, localN + +b.dataset.step)); $("local-n").textContent = localN; });
document.querySelectorAll("[data-delay]").forEach(b => b.onclick = () => {
  delay = Math.max(1, Math.min(12, delay + +b.dataset.delay)); $("delay").textContent = delay; });
$("btn-local").onclick = () => { send({ t: "set", name: $("name").value }); localPlay(); };
$("btn-host").onclick = () => { send({ t: "set", name: $("name").value }); send({ t: "host" }); };
$("btn-join").onclick = () => {
  let ip = $("ip").value.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!ip) return toast("Digite o IP de quem criou a sala.");
  if (!ip.includes(":")) ip += ":8000";
  location.href = `http://${ip}`;
};
$("btn-start").onclick = () => send({ t: "start", delay, rtc: $("rtc").checked });
$("btn-leave-lobby").onclick = () => send({ t: "leave" });
$("btn-leave").onclick = () => {
  if (GUEST) return guestLeave();
  const local = Play.run && !Play.run.net;
  endRun();
  if (!local) send({ t: "leave" });           // o host saiu: encerra a sala para todos
};
$("btn-all").onclick = () => toggleRunView();
// tela cheia: no celular vai a área de jogo inteira (com os botões de toque)
const goFull = () => {
  if (document.fullscreenElement) return document.exitFullscreen();
  const el = Touch.shown ? $("game") : $("stage");
  (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
};
$("btn-sound").onclick = () => Sound.toggle();
$("btn-touch").onclick = () => toggleTouch();
$("btn-full").onclick = goFull;
$("btn-fit").onclick = () => Fit.cycle();
$("stage").ondblclick = goFull;

if (window.isSecureContext && "serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
