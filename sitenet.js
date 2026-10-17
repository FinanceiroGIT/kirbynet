"use strict";
// Sala pelo CÓDIGO (sem IP), para quem joga pelo site (https).
// Uma página https não consegue abrir ws:// para o PC do host, então a conexão vai por WebRTC.
// O PeerJS (servidor grátis 0.peerjs.com) só apresenta um navegador ao outro; depois os dados vão
// direto. No PC do host, a página faz a ponte: cada convidado do site vira um WebSocket local em
// /net, e o Python não precisa saber de nada disso (só que ele "veio pelo site").
const SITE_PREFIX = "kirbynet-sala-";
const CHUNK = 60000;   // o canal do WebRTC não aceita mensagens muito grandes (os saves passam disso)

// Cada mensagem vai em pedaços: [1 byte: 1 = último pedaço][dados]
function chunkSend(conn, u8) {
  let i = 0;
  do {
    const part = u8.subarray(i, i + CHUNK), b = new Uint8Array(1 + part.length);
    b[0] = i + CHUNK >= u8.length ? 1 : 0; b.set(part, 1);
    conn.send(b);
    i += CHUNK;
  } while (i < u8.length);
}
function chunkReader(onMsg) {
  let parts = [];
  return (data) => {
    const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    parts.push(u8.slice(1));
    if (u8[0] !== 1) return;
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    parts = [];
    onMsg(out.buffer);
  };
}

// Convidado: um objeto que se comporta como o WebSocket que netJoin espera.
function siteSocket(code) {
  const t = { readyState: 0, binaryType: "arraybuffer", onopen: null, onmessage: null, onclose: null };
  let peer = null, conn = null, done = false;
  const close = (reason) => {
    if (done) return;
    done = true; t.readyState = 3;
    try { if (conn) conn.close(); } catch (e) {}
    setTimeout(() => { try { peer && peer.destroy(); } catch (e) {} }, 500);
    if (t.onclose) t.onclose({ code: 1006, reason: reason || "" });
  };
  t.send = (u8) => { if (t.readyState === 1) chunkSend(conn, u8); };
  t.close = () => close();
  if (typeof Peer === "undefined") { setTimeout(() => close("Não consegui carregar a conexão por código."), 0); return t; }
  peer = new Peer({ debug: 0 });
  peer.on("open", () => {
    conn = peer.connect(SITE_PREFIX + code, { serialization: "raw", reliable: true });
    conn.on("open", () => { t.readyState = 1; if (t.onopen) t.onopen(); });
    conn.on("data", chunkReader(buf => { if (t.onmessage) t.onmessage({ data: buf }); }));
    conn.on("close", () => close());
    conn.on("error", () => close());
  });
  peer.on("error", (e) => {
    if (e.type === "peer-unavailable") close("Sala não encontrada. Confira o código (o host precisa estar com a sala aberta).");
    else if (["network", "server-error", "socket-error", "socket-closed"].includes(e.type)) {
      if (t.readyState !== 1) close("Sem internet para achar a sala.");
    } else close("Não consegui falar com a sala (" + e.type + ").");
  });
  setTimeout(() => { if (t.readyState === 0) close("A sala não respondeu. Confira o código e se o host está com a sala aberta."); }, 20000);
  return t;
}

// PC do host: recebe quem chega pelo site e liga cada um à sala (WebSocket local).
const Bridge = {
  peer: null, code: null, ends: new Set(), retry: 0,
  sync(code) {   // código da sala aberta agora (ou null)
    if (code === this.code) return;
    this.stop();
    this.code = code || null;
    if (this.code && typeof Peer !== "undefined") this.start();
  },
  start() {
    const peer = this.peer = new Peer(SITE_PREFIX + this.code, { debug: 0 });
    peer.on("open", () => console.log("sala pelo site pronta:", this.code));
    peer.on("connection", (conn) => this.link(conn));
    peer.on("disconnected", () => {
      // caiu do "apresentador" (internet piscou): tenta voltar; quem já entrou continua jogando
      setTimeout(() => { if (this.peer === peer && !peer.destroyed) try { peer.reconnect(); } catch (e) {} }, 3000);
    });
    peer.on("error", (e) => {
      if (this.peer !== peer) return;
      if (e.type === "unavailable-id") { toast("⚠ Esse código de sala já está em uso. Crie a sala de novo."); return; }
      if (["network", "server-error", "socket-error", "socket-closed"].includes(e.type) && !this.retry) {
        // sem internet agora: tenta de novo daqui a pouco (a sala pelo IP continua funcionando)
        this.retry = setTimeout(() => { this.retry = 0; if (this.peer === peer) { const c = this.code; this.stop(); this.code = c; this.start(); } }, 10000);
      }
    });
  },
  link(conn) {
    let ws = null;
    const early = [];
    const end = () => {
      if (!this.ends.delete(end)) return;
      // deixa a última mensagem (ex.: "a partida já começou") chegar antes de fechar
      setTimeout(() => { try { conn.close({ flush: true }); } catch (e) {} }, 300);
      if (ws) try { ws.close(); } catch (e) {}
    };
    this.ends.add(end);
    // a sala local só é aberta na 1ª mensagem que não seja "me manda o jogo" (G): o pedido do
    // jogo vem numa conexão só para isso, e é respondido aqui mesmo com a ROM da pasta roms
    const openWs = () => {
      ws = new WebSocket(`ws://${location.host}/net?via=site`);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => { for (const m of early) ws.send(m); early.length = 0; };
      ws.onmessage = (ev) => { try { chunkSend(conn, new Uint8Array(ev.data)); } catch (e) { end(); } };
      ws.onclose = end;
    };
    conn.on("data", chunkReader(buf => {
      const u8 = new Uint8Array(buf);
      if (u8[0] === 71) return pcRom(u8).then(b => chunkSend(conn, b)).catch(() => end());
      if (!ws) openWs();
      if (ws.readyState === 1) ws.send(buf); else early.push(buf);
    }));
    conn.on("close", end);
    conn.on("error", end);
  },
  stop() {
    clearTimeout(this.retry); this.retry = 0;
    for (const end of [...this.ends]) end();
    if (this.peer) { const p = this.peer; setTimeout(() => { try { p.destroy(); } catch (e) {} }, 400); }
    this.peer = null; this.code = null;
  },
};

// ---------------------------------------------------------------- sala no próprio navegador
// Quem cria a sala pelo site é o host, sem Python: esta é a mesma sala do Room do kirbynet.py
// (mesmas mensagens: H W L S I X D E P Q R), rodando aqui. O próprio host entra nela por um
// "fio" interno (localSocket); os outros chegam pelo código.
const enc = (s) => new TextEncoder().encode(s), dec = (u8) => new TextDecoder().decode(u8);
function newCode() {
  const abc = "ABCDEFGHJKMNPQRSTUVWXYZ23456789", r = crypto.getRandomValues(new Uint8Array(5));
  return [...r].map(x => abc[x % abc.length]).join("");
}
function packMsg(kind, payload) {
  const body = payload || new Uint8Array(0), b = new Uint8Array(1 + body.length);
  b[0] = kind.charCodeAt(0); b.set(body, 1);
  return b;
}
// ---------------------------------------------------------------- o jogo vai de quem cria a sala para quem entra
// Como a pasta roms do kirbynet: quem entra não precisa ter a ROM, ela vem direto do host
// (de aparelho para aparelho; não passa por nenhum site). G (pedido) {have: sha1 que já tenho}
// G (resposta) <I tamanho do cabeçalho>{name, sha1} ou {error}<bytes da ROM, só se for diferente>
function romPacket(head, bytes) {
  const h = enc(JSON.stringify(head)), body = bytes && head.sha1 !== head.have ? bytes : new Uint8Array(0);
  const b = new Uint8Array(5 + h.length + body.length);
  b[0] = 71; new DataView(b.buffer).setUint32(1, h.length, true);
  b.set(h, 5); b.set(body, 5 + h.length);
  return b;
}
const romAsk = (u8) => { try { return JSON.parse(dec(u8.subarray(1))).have || ""; } catch (e) { return ""; } };
// host no PC (Python): a ROM da sala aberta
async function pcRom(u8) {
  const have = romAsk(u8);
  try {
    const r = await fetch("/guest-rom");
    if (!r.ok) throw new Error(await r.text());
    const info = await r.json();
    const bytes = info.sha1 === have ? null : await fetchBytes(`/rom?name=${encodeURIComponent(info.name)}`);
    return romPacket({ name: info.name, sha1: info.sha1, have }, bytes);
  } catch (err) { return romPacket({ error: String(err.message || err) }); }
}
// quem entra: pede o jogo à sala (numa conexão só para isso) -> { name, sha1, bytes (null = já tenho) }
function siteGetRom(code, have) {
  return new Promise((ok, bad) => {
    const t = siteSocket(code);
    let done = false;
    t.onopen = () => t.send(packMsg("G", enc(JSON.stringify({ have }))));
    t.onmessage = (ev) => {
      const u8 = new Uint8Array(ev.data);
      if (u8[0] !== 71) return;
      const n = new DataView(u8.buffer).getUint32(1, true), head = JSON.parse(dec(u8.subarray(5, 5 + n)));
      done = true; t.close();
      if (head.error) return bad(new Error(head.error));
      ok({ name: head.name, sha1: head.sha1, bytes: u8.length > 5 + n ? u8.slice(5 + n) : null });
    };
    t.onclose = (ev) => { if (!done) bad(new Error(ev.reason || "Não consegui falar com a sala.")); };
  });
}

const SiteRoom = {
  on: false, peer: null, code: null, sha1: "", rom: null, romName: "", players: [], running: false, hashes: new Map(), onState: null,
  // sha1/rom/romName = jogo do host (vai para quem entra); onState(estado) atualiza a tela da sala
  create(sha1, onState, rom, romName) {
    this.close();
    Object.assign(this, { on: true, sha1, onState, rom, romName, players: [], running: false, hashes: new Map() });
    if (typeof Peer === "undefined") return Promise.reject(new Error("Não consegui carregar a conexão por código."));
    return this.listen(0);
  },
  listen(tries) {
    this.code = newCode();
    const peer = this.peer = new Peer(SITE_PREFIX + this.code, { debug: 0 });
    return new Promise((ok, bad) => {
      peer.on("open", () => { ok(); this.push(); });
      peer.on("connection", (pc) => this.remote(pc));
      peer.on("disconnected", () => {
        // caiu do "apresentador" (internet piscou): quem já entrou continua; tenta voltar para os próximos
        setTimeout(() => { if (this.peer === peer && !peer.destroyed) try { peer.reconnect(); } catch (e) {} }, 3000);
      });
      peer.on("error", (e) => {
        if (this.peer !== peer || peer.open) return;
        if (e.type === "unavailable-id" && tries < 3) { peer.destroy(); this.listen(tries + 1).then(ok, bad); }
        else bad(new Error(["network", "server-error", "socket-error", "socket-closed"].includes(e.type)
          ? "Sem internet para criar a sala." : "Não consegui criar a sala (" + e.type + ")."));
      });
    });
  },
  // um jogador que chegou pelo código
  remote(pc) {
    const c = { closed: false, local: false };
    c.send = (kind, payload) => {
      if (c.closed) return;
      try { chunkSend(pc, packMsg(kind, payload)); } catch (e) {}
    };
    c.close = () => { if (!c.closed) { c.closed = true; setTimeout(() => { try { pc.close({ flush: true }); } catch (e) {} }, 300); } };
    pc.on("data", chunkReader(buf => this.msg(c, new Uint8Array(buf))));
    pc.on("close", () => this.gone(c));
    pc.on("error", () => this.gone(c));
  },
  // o próprio host: um objeto que se comporta como WebSocket, ligado direto na sala
  localSocket() {
    const t = { readyState: 0, binaryType: "arraybuffer", onopen: null, onmessage: null, onclose: null };
    const c = { closed: false, local: true };
    c.send = (kind, payload) => {
      if (c.closed) return;
      const b = packMsg(kind, payload);
      queueMicrotask(() => { if (t.readyState === 1 && t.onmessage) t.onmessage({ data: b.buffer }); });
    };
    c.close = () => {
      if (c.closed) return;
      c.closed = true;
      queueMicrotask(() => { if (t.readyState !== 3) { t.readyState = 3; if (t.onclose) t.onclose({ code: 1000, reason: "" }); } });
    };
    t.send = (u8) => { if (t.readyState === 1) { const b = u8.slice(); queueMicrotask(() => this.msg(c, b)); } };
    t.close = () => { if (t.readyState !== 3) { t.readyState = 3; this.gone(c); } };
    queueMicrotask(() => { t.readyState = 1; if (t.onopen) t.onopen(); });
    return t;
  },
  names() { return this.players.map(p => p.name); },
  broadcast(kind, payload, skip) { for (const p of this.players) if (p.c !== skip) p.c.send(kind, payload); },
  msg(c, u8) {
    if (c.closed || !this.on || !u8.length) return;
    const kind = String.fromCharCode(u8[0]), data = u8.subarray(1);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const slot = this.players.findIndex(p => p.c === c);
    const fail = (msg) => c.send("E", enc(JSON.stringify({ msg })));
    if (kind === "G") {
      const have = romAsk(u8);
      c.send("G", romPacket(this.running ? { error: "A partida já começou." }
        : { name: this.romName, sha1: this.sha1, have }, this.rom).subarray(1));
    } else if (kind === "H") {
      let info; try { info = JSON.parse(dec(data)); } catch (e) { return; }
      if (this.running) fail("A partida já começou.");
      else if (info.rom !== this.sha1) fail("A sua ROM é diferente da do host. Todos precisam da MESMA ROM.");
      else if (this.players.length >= 4) fail("A sala está cheia (4 jogadores).");
      else if (slot < 0) {
        const p = { name: String(info.name || "?").slice(0, 16), c, save: String(info.save || "") };
        if (c.local) this.players.unshift(p); else this.players.push(p);   // o host é sempre o P1
        console.log(`${p.name} entrou na sala`);
        this.lobby();
      }
    } else if (kind === "I" && this.running) this.broadcast("I", data, c);
    else if (kind === "P") c.send("P", data);
    else if (kind === "Q") {
      if (slot < 0) return;
      let q; try { q = JSON.parse(dec(data)); } catch (e) { return; }
      const int = (v, d) => Number.isFinite(+v) ? Math.trunc(+v) : d;
      const out = { slot, med: int(q.med, 0), max: int(q.max, 0), spikes: int(q.spikes, 0), via: q.via === "udp" ? "udp" : "tcp",
                    cpu: int(q.cpu, -1), page: int(q.page, -1), delay: int(q.delay, -1), lost: int(q.lost, 0), gap: int(q.gap, 0), marg: {} };
      for (const [k, v] of Object.entries(q.marg && typeof q.marg === "object" ? q.marg : {}))
        if (v && typeof v === "object") out.marg[String(int(k, 0))] = Object.fromEntries(["min", "late", "tight", "sum", "cnt"].map(f => [f, int(v[f], 0)]));
      this.broadcast("Q", enc(JSON.stringify(out)));
    } else if (kind === "R" && data.length) {
      // só apresenta um navegador ao outro (canal rápido); os botões não passam por aqui
      const to = data[0];
      if (slot >= 0 && to < this.players.length) { const b = data.slice(); b[0] = slot; this.players[to].c.send("R", b); }
    } else if (kind === "X" && this.running && data.length >= 13) {
      const frame = dv.getUint32(1, true), h = dv.getBigUint64(5, true);
      if (!this.hashes.has(frame)) this.hashes.set(frame, h);
      else if (this.hashes.get(frame) !== h) {
        console.warn(`DESSINCRONIZOU no frame ${frame} (P${data[0] + 1})`);
        const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, frame, true);
        this.broadcast("D", b);
      }
      for (const f of this.hashes.keys()) if (f < frame - 3000) this.hashes.delete(f);
    }
  },
  lobby() {
    this.players.forEach((p, i) => p.c.send("W", enc(JSON.stringify({ slot: i }))));
    this.broadcast("L", enc(JSON.stringify({ players: this.names() })));
    this.push();
  },
  gone(c) {
    const slot = this.players.findIndex(p => p.c === c);
    c.closed = true;
    if (slot < 0) return;
    const name = this.players[slot].name;
    this.players.splice(slot, 1);
    if (this.running) this.end(`P${slot + 1} (${name}) saiu. A partida parou — voltem para a sala.`);
    else this.lobby();
  },
  start(delay, rtc) {
    if (this.running || !this.players.length) return;
    this.running = true; this.hashes = new Map();
    const info = { n: this.players.length, delay, names: this.names(), rtc, saves: this.players.map(p => p.save) };
    this.broadcast("S", enc(JSON.stringify(info)));
    this.push();
  },
  // os mesmos comandos que a tela do host mandaria ao Python
  handle(m) {
    if (!this.on) return;
    if (m.t === "start") this.start(Math.max(1, Math.min(12, +m.delay || 3)), m.rtc !== false);
    else if (m.t === "leave") this.end("O host fechou a sala.");
  },
  end(msg) {
    const players = this.players;
    this.players = [];
    for (const p of players) { p.c.send("E", enc(JSON.stringify({ msg }))); p.c.close(); }
    this.close();
  },
  push() { if (this.on && this.onState) this.onState({ screen: this.running ? "playing" : "lobby", players: this.names(), code: this.code }); },
  close() {
    this.on = false; this.running = false;
    if (this.peer) { const p = this.peer; setTimeout(() => { try { p.destroy(); } catch (e) {} }, 400); }
    this.peer = null;
  },
};
