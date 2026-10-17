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
    conn.on("open", () => {
      ws = new WebSocket(`ws://${location.host}/net?via=site`);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => { for (const m of early) ws.send(m); early.length = 0; };
      ws.onmessage = (ev) => { try { chunkSend(conn, new Uint8Array(ev.data)); } catch (e) { end(); } };
      ws.onclose = end;
    });
    conn.on("data", chunkReader(buf => { if (ws && ws.readyState === 1) ws.send(buf); else early.push(buf); }));
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
