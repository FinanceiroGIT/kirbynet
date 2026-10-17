"use strict";
// Página do CONVIDADO: aberta pelo IP do host (http://IP:8000), sem Python.
// A ROM e o save ficam guardados neste navegador.

const Guest = { rom: null, romName: "", romSha1: "" };
// Aberta pelo site (https, ex.: GitHub Pages) e não pelo PC do host: só dá para jogar sozinho.
// O kirbynet do host é sempre http; uma página https nem consegue falar com ele.
const SITE = location.protocol === "https:";

function idb() {
  return new Promise((ok, bad) => {
    const r = indexedDB.open("kirbynet", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("roms");
    r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error);
  });
}
async function romStore(v) { try { const db = await idb(); db.transaction("roms", "readwrite").objectStore("roms").put(v, "last"); } catch (e) {} }
async function romLoad() {
  try {
    const db = await idb();
    return await new Promise(ok => { const r = db.transaction("roms").objectStore("roms").get("last"); r.onsuccess = () => ok(r.result); r.onerror = () => ok(null); });
  } catch (e) { return null; }
}
const saveKey = () => "kirbynet.save." + Guest.romSha1;
function loadMySave() { try { return b64dec(localStorage.getItem(saveKey()) || ""); } catch (e) { return new Uint8Array(0); } }
// rotate = true só na 1ª gravação da partida: o .bak fica sendo o save de antes da sessão.
function storeMySave(bytes, rotate) {
  if (!bytes || !bytes.length) return;
  try {
    const old = localStorage.getItem(saveKey());
    if (rotate && old) localStorage.setItem(saveKey() + ".bak", old);
    localStorage.setItem(saveKey(), b64enc(bytes));
  } catch (e) { toast("Não consegui guardar o save neste navegador."); }
}
function guestSaveWriter() {
  let rotated = false;
  return (saves) => { storeMySave(saves[0], !rotated); rotated = true; };
}

function showGuestPage(msg) {
  showOnly("guest");
  $("g-join").disabled = false;
  $("g-msg").textContent = msg || "";
}
function setRom(name, bytes) {
  Guest.rom = bytes; Guest.romName = name; Guest.romSha1 = sha1Hex(bytes);
  $("g-rom").textContent = `${name}  ·  ${(bytes.length / 1048576).toFixed(1)} MB`;
}

async function guestInit() {
  $("g-host").textContent = location.host;
  try { $("g-name").value = localStorage.getItem("kirbynet.name") || ""; } catch (e) {}
  showGuestPage();
  const saved = await romLoad();
  if (saved && saved.bytes) setRom(saved.name, saved.bytes);
  $("g-controls").onclick = openControls;
  $("g-file").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      let bytes = new Uint8Array(await f.arrayBuffer()), name = f.name;
      if (name.toLowerCase().endsWith(".zip")) ({ name, bytes } = await unzipGba(bytes));
      if (!name.toLowerCase().endsWith(".gba")) throw new Error("Escolha um .gba ou .zip.");
      setRom(name, bytes);
      romStore({ name, bytes });
      toast(`ROM pronta: ${name}`);
    } catch (err) { toast(String(err.message || err)); }
    e.target.value = "";
  };
  $("g-join").onclick = guestJoin;
  $("g-solo").onclick = guestSolo;
  $("g-create").onclick = guestCreate;
  if (SITE) {
    $("g-code-row").classList.remove("hidden");
    $("g-create").classList.remove("hidden");
    document.querySelectorAll(".pc-only").forEach(el => el.classList.add("hidden"));
    $("code-label").textContent = "Código da sala (os outros digitam no site):";
    try { $("g-code").value = localStorage.getItem("kirbynet.code") || ""; } catch (e) {}
    $("g-sub").textContent = "A ROM e o save ficam guardados neste navegador, sozinho ou junto. "
      + "Para jogar junto: um cria a sala e passa o código; os outros digitam o código e entram.";
    if (!Guest.rom) $("g-rom").textContent = "Escolha a ROM uma vez; ela fica guardada aqui";
  }
}

// Sozinho: 1 GBA aqui mesmo, sem sala e sem o PC do host. Usa o mesmo save da rede deste navegador.
async function guestSolo() {
  if (!Guest.rom) return toast("Escolha a ROM primeiro.");
  $("g-solo").disabled = true;
  $("g-msg").textContent = "Carregando o motor…";
  try { await loadEngine(); } catch (err) { $("g-solo").disabled = false; return showGuestPage("Não consegui carregar o motor: " + err); }
  $("g-solo").disabled = false;
  $("g-msg").textContent = "";
  const name = ($("g-name").value || "").trim() || "Jogador";
  try { localStorage.setItem("kirbynet.name", name); } catch (e) {}
  try {
    startRun({ n: 1, rom: Guest.rom, saves: [loadMySave()], names: [name], net: null, slot: 0, delay: 0,
               onSave: guestSaveWriter() });
  } catch (err) { showGuestPage("Não deu pra iniciar: " + (err.message || err)); }
}

async function guestJoin() {
  // pelo site: entra com o código; a ROM é a escolhida aqui (o host confere se é a mesma)
  const code = SITE ? ($("g-code").value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
  if (SITE && !code) return toast("Digite o código da sala (quem criou a sala vê o código na tela).");
  if (SITE && !Guest.rom) return toast("Escolha a ROM primeiro (a mesma do host).");
  if (SITE) try { localStorage.setItem("kirbynet.code", code); } catch (e) {}
  $("g-join").disabled = true;
  $("g-msg").textContent = "Carregando o jogo do host…";
  if (!SITE) try {
    const response = await fetch("/guest-rom");
    if (!response.ok) throw new Error(await response.text());
    const info = await response.json();
    if (!Guest.rom || Guest.romSha1 !== info.sha1) {
      const download = await fetch(`/rom?name=${encodeURIComponent(info.name)}`);
      if (!download.ok) throw new Error(await download.text());
      const bytes = new Uint8Array(await download.arrayBuffer());
      if (sha1Hex(bytes) !== info.sha1) throw new Error("O jogo mudou. Tente entrar novamente.");
      setRom(info.name, bytes);
      await romStore({ name: info.name, bytes });
    }
  } catch (err) {
    return showGuestPage("Não consegui carregar o jogo: " + (err.message || err));
  }
  const name = ($("g-name").value || "").trim() || "Convidado";
  try { localStorage.setItem("kirbynet.name", name); } catch (e) {}
  $("g-join").disabled = true;
  $("g-msg").textContent = "Carregando o motor…";
  try { await loadEngine(); } catch (err) { return showGuestPage("Não consegui carregar o motor: " + err); }
  $("g-msg").textContent = "Conectando à sala…";
  netJoin(SITE ? siteSocket(code) : `ws://${location.host}/net`,
    { name, rom: Guest.romSha1, save: b64enc(loadMySave()) }, roomCallbacks());
}

// O que fazer na sala (igual para quem entra e para quem cria pelo site)
function roomCallbacks() {
  return {
    onLobby(names, slot) {
      S = { mode: "net", my: slot };
      badges($("g-players"), names, slot, 4);
      $("g-msg").textContent = "Conectado! Esperando o host começar a partida…";
    },
    onStart(info) {
      const net = Play.net;
      try {
        startRun({ n: info.n, rom: Guest.rom, saves: info.saves.map(b64dec), names: info.names,
                   net, slot: net.slot, delay: info.delay,
                   onSave: guestSaveWriter() });
      } catch (err) { toast(String(err.message || err)); net.close(); showGuestPage(String(err)); }
    },
    onError(msg) {
      const wasPlaying = !!Play.run;
      endRun();
      SiteRoom.close();
      toast(msg);
      showGuestPage(wasPlaying ? msg + " Seu save ficou guardado neste navegador." : msg);
      $("g-players").innerHTML = "";
    },
  };
}

// Criar a sala pelo site: este navegador vira o host (sem Python) e entra nela como P1.
async function guestCreate() {
  if (!Guest.rom) return toast("Escolha a ROM primeiro.");
  $("g-create").disabled = true;
  $("g-msg").textContent = "Criando a sala…";
  try {
    await loadEngine();
    await SiteRoom.create(Guest.romSha1, siteLobby);
  } catch (err) {
    SiteRoom.close();
    $("g-create").disabled = false;
    return showGuestPage(String(err.message || err));
  }
  $("g-create").disabled = false;
  $("g-msg").textContent = "";
  const name = ($("g-name").value || "").trim() || "Host";
  try { localStorage.setItem("kirbynet.name", name); } catch (e) {}
  netJoin(SiteRoom.localSocket(), { name, rom: Guest.romSha1, save: b64enc(loadMySave()) }, roomCallbacks());
}
// tela da sala de espera de quem criou pelo site (a mesma do host no PC)
function siteLobby(m) {
  if (!SiteRoom.on || Play.run) return;
  showOnly("lobby");
  renderLobby(m);
}

function guestLeave() {
  endRun();
  if (Play.net) Play.net.close();
  showGuestPage("Você saiu da partida. O seu save ficou guardado neste navegador.");
  $("g-players").innerHTML = "";
}

if (GUEST) guestInit();
