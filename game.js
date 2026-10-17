"use strict";
// Motor de partida no navegador (host, convidados e "Mesmo PC").
// Os GBAs rodam em WebAssembly (kncore.wasm). Em rede, só os botões viajam
// (lockstep: um frame só anda quando há botões de todos).

const Play = { mod: null, run: null, net: null };

// ------------------------------------------------------------------ utilidades
function sha1Hex(bytes) {
  // SHA-1 próprio: em páginas http:// pelo IP o navegador não libera o crypto.subtle.
  const ml = bytes.length, withPad = ((ml + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(withPad);
  buf.set(bytes); buf[ml] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(withPad - 4, (ml * 8) >>> 0); dv.setUint32(withPad - 8, Math.floor(ml / 0x20000000));
  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
  const w = new Uint32Array(80);
  for (let off = 0; off < withPad; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5A827999 : i < 40 ? 0x6ED9EBA1 : i < 60 ? 0x8F1BBCDC : 0xCA62C1D6;
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map(x => x.toString(16).padStart(8, "0")).join("");
}

async function unzipGba(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Esse .zip parece estar corrompido.");
  let p = dv.getUint32(eocd + 16, true);
  const count = dv.getUint16(eocd + 10, true);
  for (let n = 0; n < count; n++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extra = dv.getUint16(p + 30, true), comment = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extra + comment;
    if (!name.toLowerCase().endsWith(".gba")) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + csize);
    if (method === 0) return { name: name.split("/").pop(), bytes: data.slice() };
    if (method !== 8) throw new Error("Formato de .zip não suportado. Extraia o .gba e escolha ele.");
    const out = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
    return { name: name.split("/").pop(), bytes: new Uint8Array(out) };
  }
  throw new Error("Não achei nenhum .gba dentro do .zip.");
}

function b64enc(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64dec(s) { const b = atob(s || ""); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }

// O motor (WebAssembly) é compilado uma vez aqui e entregue ao worker de cada partida.
async function loadEngine() {
  if (!Play.mod) {
    const bytes = await (await fetch("kncore.wasm")).arrayBuffer();
    await WebAssembly.compile(bytes);          // confere que o navegador aceita o motor
    Play.mod = bytes;
  }
  return Play.mod;
}

// ------------------------------------------------------------------ som
// Toca o áudio do SEU Kirby. Não interfere na partida (o som não entra na sincronia).
//
// v0.8.2 — dois caminhos, escolhidos sozinhos:
//  • AudioWorklet (PC do host em localhost, ou convidado com a flag do Chrome): o motor manda
//    o som DIRETO para a linha de áudio do navegador (MessagePort worker → worklet), sem passar
//    pela página. Engasgo de tela não chega no som e a folga pode ser bem curta (20–30 ms).
//    Lá dentro: filtro "soft" 10 kHz na taxa do jogo, conversão 65.536 Hz → placa de som com
//    interpolação cúbica e ajuste de velocidade de no máx. 0,5% (afinação igual à do jogo).
//  • Blocos agendados (convidado em http://IP, onde o navegador não libera o AudioWorklet):
//    cada quadro vira um bloco agendado no relógio da placa de som, com folga adaptativa.
// Nos dois, a folga começa curta e só cresce se o PC engasgar de verdade (o jogo parado
// esperando a rede não conta), e volta a encurtar depois de um tempo liso.
const WORKLET_SRC = `
class KnOut extends AudioWorkletProcessor {
  constructor() {
    super();
    this.N = 32768; this.M = this.N - 1;
    this.A = new Float32Array(this.N); this.B = new Float32Array(this.N);
    this.wr = 4; this.rd = 4;
    this.src = 65536; this.ratio = this.src / sampleRate; this.adj = 1;
    this.tMin = 0.012; this.tMax = 0.08; this.target = 0.018;
    this.playing = false; this.g = 0; this.lastIn = -1; this.calm = 0; this.under = 0; this.q = 0;
    this.z = new Float64Array(8);
    this.setLP();
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.port) d.port.onmessage = (ev) => this.feed(ev.data);
      else if (d.reset) { this.rd = this.wr; this.playing = false; }
    };
  }
  setLP() {   // passa-baixa 10 kHz, Q 0,5, na taxa do jogo
    const w = 2 * Math.PI * 10000 / this.src, a = Math.sin(w) / (2 * 0.5), c = Math.cos(w), a0 = 1 + a;
    this.b0 = (1 - c) / 2 / a0; this.b1 = (1 - c) / a0; this.b2 = this.b0; this.a1 = -2 * c / a0; this.a2 = (1 - a) / a0;
  }
  feed(m) {
    if (m.rate && m.rate !== this.src) { this.src = m.rate; this.ratio = this.src / sampleRate; this.setLP(); }
    const s = m.samples, n = s.length >> 1, z = this.z, M = this.M;
    const b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2;
    for (let i = 0; i < n; i++) {
      const xl = s[2 * i] / 32768, xr = s[2 * i + 1] / 32768;
      const yl = b0 * xl + b1 * z[0] + b2 * z[1] - a1 * z[2] - a2 * z[3];
      z[1] = z[0]; z[0] = xl; z[3] = z[2]; z[2] = yl;
      const yr = b0 * xr + b1 * z[4] + b2 * z[5] - a1 * z[6] - a2 * z[7];
      z[5] = z[4]; z[4] = xr; z[7] = z[6]; z[6] = yr;
      const k = this.wr & M; this.A[k] = yl; this.B[k] = yr; this.wr++;
    }
    // fila grande demais (aba no fundo / som desligado): volta para a folga normal
    if (this.wr - this.rd > 0.25 * this.src) { this.rd = this.wr - this.target * this.src; }
    this.lastIn = currentTime;
  }
  process(inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length;
    const ts = this.target * this.src;
    const fill = this.wr - this.rd;
    if (!this.playing) {
      if (fill >= ts) { this.playing = true; this.g = 0; }
      else { L.fill(0); if (R !== L) R.fill(0); this.report(); return true; }
    }
    // fila acumulou muito (soluço da saída de áudio do PC)? em vez de ficar atrasado por
    // vários segundos, pula o excesso de uma vez, com fade de ~1,5 ms (sem estalo)
    if (!this.jump && fill > ts + 0.045 * this.src) { this.jump = true; this.jumps = (this.jumps || 0) + 1; }
    const want = 1 + Math.max(-0.005, Math.min(0.005, ((fill - ts) / this.src) * 0.25));
    this.adj += (want - this.adj) * 0.02;
    const step = this.ratio * this.adj, M = this.M, A = this.A, B = this.B;
    for (let i = 0; i < n; i++) {
      if (this.wr - this.rd < 3) {
        for (; i < n; i++) { L[i] = 0; R[i] = 0; }
        this.playing = false;
        // só conta como engasgo do PC se o som vinha chegando normal (último pedaço há < 25 ms).
        // Se o jogo parou (esperando a rede), faltar som é normal e a folga NÃO cresce.
        if (currentTime - this.lastIn < 0.025) {
          this.under++; this.target = Math.min(this.tMax, this.target + 0.004); this.calm = currentTime;
        }
        break;
      }
      const i0 = Math.floor(this.rd), t = this.rd - i0;
      const k0 = (i0 - 1) & M, k1 = i0 & M, k2 = (i0 + 1) & M, k3 = (i0 + 2) & M;
      L[i] = this.g * this.herm(A[k0], A[k1], A[k2], A[k3], t);
      R[i] = this.g * this.herm(B[k0], B[k1], B[k2], B[k3], t);
      if (this.jump) {
        this.g -= 1 / 64;
        if (this.g <= 0) { this.g = 0; this.jump = false; this.rd = this.wr - this.target * this.src; }
      } else if (this.g < 1) this.g = Math.min(1, this.g + 1 / 128);
      this.rd += step;
    }
    if (currentTime - this.calm > 4 && this.target > this.tMin) { this.target = Math.max(this.tMin, this.target - 0.002); this.calm = currentTime; }
    this.report();
    return true;
  }
  herm(x0, x1, x2, x3, t) {
    const c1 = 0.5 * (x2 - x0), c2 = x0 - 2.5 * x1 + 2 * x2 - 0.5 * x3, c3 = 0.5 * (x3 - x0) + 1.5 * (x1 - x2);
    return ((c3 * t + c2) * t + c1) * t + x1;
  }
  report() {
    if (++this.q % 8) return;
    this.port.postMessage({ fill: (this.wr - this.rd) / this.src, target: this.target, under: this.under, jumps: this.jumps || 0, playing: this.playing });
  }
}
registerProcessor("kn-out", KnOut);
`;

const Sound = {
  ctx: null, bus: null, hp: null, rate: 65536,
  mode: "sched",       // "worklet" quando o navegador libera
  wl: null, wlInfo: { fill: 0, target: 0.025, under: 0, playing: false }, wlFill: 0.03, attached: null, worker: null,
  // caminho de blocos agendados
  TARGET: 0.035, T_MIN: 0.025, T_MAX: 0.10,
  next: 0, fadeIn: true, lastPush: 0, stalled: false, calmSince: 0,
  stats: { chunks: 0, underruns: 0, drops: 0 },
  on: (() => { try { return localStorage.getItem("kirbynet.sound") !== "off"; } catch (e) { return true; } })(),
  ensure() {
    if (!this.on) return;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const ctx = this.ctx = new AC({ latencyHint: "interactive" });
        // "soft": passa-baixa 10 kHz (tira o chiado do PCM de 8 bits, como o filtro do próprio
        // GBA) e passa-alta 20 Hz (tira o deslocamento DC que faz "tec" quando o som para/volta).
        const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 10000; lp.Q.value = 0.5;
        const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 20; hp.Q.value = 0.5;
        const vol = ctx.createGain(); vol.gain.value = 0.9;
        lp.connect(hp); hp.connect(vol); vol.connect(ctx.destination);
        this.bus = lp; this.hp = hp;
        if (ctx.audioWorklet && window.MessageChannel) {
          const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "text/javascript" }));
          ctx.audioWorklet.addModule(url).then(() => {
            const node = new AudioWorkletNode(ctx, "kn-out", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
            node.connect(hp);   // o passa-baixa já é feito dentro do worklet
            node.port.onmessage = (e) => {
              this.wlInfo = e.data;
              this.wlFill += (e.data.fill - this.wlFill) * 0.1;
            };
            this.wl = node; this.mode = "worklet";
            if (this.worker) this.attach(this.worker);
          }).catch((err) => console.warn("AudioWorklet indisponível, usando blocos agendados", err));
        }
      }
      if (this.ctx.state === "suspended") this.ctx.resume();
    } catch (e) {}
  },
  // liga o som do motor (worker) direto no worklet
  attach(worker) {
    this.worker = worker;
    if (!this.wl || this.attached === worker) return;
    const ch = new MessageChannel();
    this.wl.port.postMessage({ port: ch.port1 }, [ch.port1]);
    worker.postMessage({ t: "aport", port: ch.port2 }, [ch.port2]);
    this.attached = worker;
  },
  reset() {
    this.next = 0; this.fadeIn = true;
    if (this.wl) this.wl.port.postMessage({ reset: true });
  },
  // Atraso atual entre o motor gerar o som e ele sair da caixa (ms), no caminho worklet.
  latencyMs() {
    if (!this.ctx || this.ctx.state !== "running" || !this.on) return null;
    if (this.mode !== "worklet" || this.attached !== this.worker || !this.wlInfo.playing) return null;
    return (this.wlFill + (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0)) * 1000 + 3;
  },
  // Caminho de blocos: recebe o som de UM quadro, agenda e devolve quando ele vai tocar.
  push(a) {
    if (!a || !this.on || !this.ctx || this.ctx.state !== "running") return null;
    if (a.rate) this.rate = a.rate;
    const now = performance.now();
    if (now - this.lastPush > 30) this.stalled = true;   // o jogo ficou parado (rede): não é culpa do PC
    this.lastPush = now;
    return this.schedule(a.samples);
  },
  schedule(s) {
    const ctx = this.ctx, n = s.length >> 1, t = ctx.currentTime;
    if (!n) return null;
    if (this.next < t + 0.010) {               // fila vazia: refaz a folga
      if (this.next) {
        this.stats.underruns++;
        if (!this.stalled) this.TARGET = Math.min(this.T_MAX, this.TARGET + 0.006);
      }
      this.next = t + this.TARGET;
      this.fadeIn = true;
      this.calmSince = t;
    } else if (t - this.calmSince > 6 && this.TARGET > this.T_MIN) {
      this.TARGET = Math.max(this.T_MIN, this.TARGET - 0.005);
      this.calmSince = t;
    }
    this.stalled = false;
    const ahead = this.next - t;
    if (ahead > this.TARGET + 0.045) { this.stats.drops++; this.fadeIn = true; return null; }   // acumulou: descarta este bloco
    const buf = ctx.createBuffer(2, n, this.rate);
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    for (let i = 0; i < n; i++) { L[i] = s[2 * i] / 32768; R[i] = s[2 * i + 1] / 32768; }
    if (this.fadeIn) {
      const f = Math.min(256, n);
      for (let i = 0; i < f; i++) { const g = i / f; L[i] *= g; R[i] *= g; }
      this.fadeIn = false;
    }
    const pr = 1 + Math.max(-0.005, Math.min(0.005, (ahead - this.TARGET) * 0.1));
    const src = ctx.createBufferSource();
    src.buffer = buf; src.playbackRate.value = pr;
    src.connect(this.bus);
    src.start(this.next);
    const at = this.next;
    this.next += n / this.rate / pr;
    this.stats.chunks++;
    return at;
  },
  toggle() {
    this.on = !this.on;
    try { localStorage.setItem("kirbynet.sound", this.on ? "on" : "off"); } catch (e) {}
    this.reset();
    if (this.on) this.ensure(); else if (this.ctx) this.ctx.suspend();
    updateSoundButton();
  },
};
// ------------------------------------------------------------------ tela cheia: como preencher o monitor
// O GBA é 3:2 e o monitor costuma ser 16:9, por isso sobravam faixas pretas dos lados.
//  Esticar  — ocupa o monitor inteiro (a imagem fica ~18% mais larga; em pixel art quase não se nota)
//  Original — proporção do GBA, com faixas pretas
//  Bordas desfocadas — proporção do GBA, e as laterais mostram o próprio jogo, desfocado
// Troca no botão 🖼️ ou na tecla F3 (funciona dentro da tela cheia). Fica lembrado neste navegador.
const Fit = {
  modes: ["stretch", "keep", "blur"],
  names: { stretch: "Esticar", keep: "Original", blur: "Bordas desfocadas" },
  mode: (() => { try { const v = localStorage.getItem("kirbynet.fit"); return ["stretch", "keep", "blur"].includes(v) ? v : "stretch"; } catch (e) { return "stretch"; } })(),
  bg: null, n: 0,
  apply() {
    const st = $("stage");
    if (st) for (const m of this.modes) st.classList.toggle("fit-" + m, m === this.mode);
    const b = $("btn-fit");
    if (b) b.textContent = "🖼️ " + this.names[this.mode];
  },
  cycle() {
    this.mode = this.modes[(this.modes.indexOf(this.mode) + 1) % this.modes.length];
    try { localStorage.setItem("kirbynet.fit", this.mode); } catch (e) {}
    this.apply();
    toast("Tela cheia: " + this.names[this.mode] + "  (F3 troca)");
  },
  // copia o quadro (bem pequeno) para o fundo desfocado — barato, e só quando esse modo está na tela
  paint(canvas) {
    if (!this.bg || !(document.fullscreenElement || document.body.classList.contains("touchui")) || (this.n++ & 1)) return;
    if (this.mode !== "blur" && !(this.mode === "stretch" && Object.keys(canvases).length > 1)) return;
    this.bg.drawImage(canvas, 0, 0, 48, 32);
  },
};

function updateSoundButton() { const b = $("btn-sound"); if (b) b.textContent = Sound.on ? "🔊 Som" : "🔇 Mudo"; }
for (const ev of ["pointerdown", "keydown", "touchstart"]) addEventListener(ev, () => Sound.ensure(), { passive: true });

// ------------------------------------------------------------------ controles de toque (celular/tablet)
const Touch = {
  mask: 0, pointers: new Map(),
  // o Edge do Xbox diz que é "toque" (o cursor do controle), mas lá é TV + controle
  isTouch: !/Xbox/i.test(navigator.userAgent) && (matchMedia("(pointer: coarse)").matches || "ontouchstart" in window),
  shown: null,
};
function touchKeysAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return 0;
  const pad = el.closest && el.closest("#dpad");
  if (pad) {
    const r = pad.getBoundingClientRect(), dx = (x - r.left - r.width / 2) / (r.width / 2), dy = (y - r.top - r.height / 2) / (r.height / 2);
    let m = 0;
    if (dx < -0.3) m |= BIT.Esquerda; if (dx > 0.3) m |= BIT.Direita;
    if (dy < -0.3) m |= BIT.Cima; if (dy > 0.3) m |= BIT.Baixo;
    return m;
  }
  const b = el.closest && el.closest("[data-k]");
  return b ? keyBits(b.dataset.k) : 0;
}
// "AB" = os dois botões juntos (atalho dos emuladores)
function keyBits(k) { return k === "AB" ? BIT.A | BIT.B : (BIT[k] || 0); }
function toggleMenu(open) {
  document.body.classList.toggle("menuopen", open == null ? !document.body.classList.contains("menuopen") : open);
}
function touchUpdate() {
  let m = 0;
  for (const v of Touch.pointers.values()) m |= v;
  const fresh = m & ~Touch.mask;
  if (fresh && navigator.vibrate) navigator.vibrate(8);
  Touch.mask = m;
  if (Play.run) sendKeys(Play.run);   // toque também vai na hora
  document.querySelectorAll("#touch [data-k]").forEach(b => {
    const bits = keyBits(b.dataset.k);
    b.classList.toggle("on", (m & bits) === bits && bits !== 0);
  });
  const d = $("dpad");
  for (const [dir, cls] of [["Cima", "up"], ["Baixo", "down"], ["Esquerda", "left"], ["Direita", "right"]])
    d.querySelector("." + cls).classList.toggle("on", !!(m & BIT[dir]));
}
function touchInit() {
  const t = $("touch");
  const onPtr = (e) => {
    e.preventDefault();
    // botão ☰: abre/fecha as opções (Som, Tela cheia, Sair…)
    if (e.target.closest && e.target.closest(".tmenu")) return;   // o ☰ abre no "click" (abaixo)
    if (e.type === "pointerdown" && document.body.classList.contains("menuopen")) toggleMenu(false);
    if (e.type === "pointerup" || e.type === "pointercancel") Touch.pointers.delete(e.pointerId);
    else Touch.pointers.set(e.pointerId, touchKeysAt(e.clientX, e.clientY));
    touchUpdate();
  };
  for (const ev of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) t.addEventListener(ev, onPtr);
  t.addEventListener("contextmenu", (e) => e.preventDefault());
  t.querySelector(".tmenu").addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(); });
  // escolheu uma opção do menu ou tocou no jogo: fecha o menu
  document.querySelector("#game .gamebar").addEventListener("click", (e) => { if (e.target.closest("button")) setTimeout(() => toggleMenu(false), 0); });
  $("stage").addEventListener("pointerdown", () => toggleMenu(false));
  try { const v = localStorage.getItem("kirbynet.touch"); Touch.shown = v === null ? Touch.isTouch : v === "on"; } catch (e) { Touch.shown = Touch.isTouch; }
  applyTouch();
}
function applyTouch() {
  document.body.classList.toggle("touchui", !!Touch.shown);
  $("touch").classList.toggle("hidden", !Touch.shown);
  const b = $("btn-touch"); if (b) b.textContent = Touch.shown ? "📱 Esconder toque" : "📱 Botões de toque";
}
function toggleTouch() {
  Touch.shown = !Touch.shown;
  try { localStorage.setItem("kirbynet.touch", Touch.shown ? "on" : "off"); } catch (e) {}
  Touch.pointers.clear(); touchUpdate(); applyTouch();
}

function showOnly(id) {
  for (const s of ["menu", "lobby", "game", "guest"]) $(s).classList.toggle("hidden", s !== id);
}

// ------------------------------------------------------------------ rede
// Entra numa sala. cb: onLobby(names, slot), onStart(info), onError(msg)
// url: endereço ws://, ou um objeto que se comporta como WebSocket (siteSocket: entrar pelo código)
function netJoin(url, hello, cb) {
  const ws = typeof url === "string" ? new WebSocket(url) : url;
  ws.binaryType = "arraybuffer";
  const net = { ws, cb, slot: 0, sink: null, early: [], gotError: false };
  Play.net = net;
  const json = (u8) => JSON.parse(new TextDecoder().decode(u8));
  net.send = (kind, payload) => {
    if (ws.readyState !== 1) return;
    const body = typeof payload === "string" ? new TextEncoder().encode(payload) : (payload || new Uint8Array(0));
    if (kind === "I") rtcInput(body);   // os botões vão também pelo canal rápido
    const out = new Uint8Array(1 + body.length);
    out[0] = kind.charCodeAt(0); out.set(body, 1);
    ws.send(out);
  };
  const stop = () => {
    clearInterval(net.pingIv); clearInterval(net.rtcIv);
    for (const p of Object.values(net.peers)) try { p.pc.close(); } catch (e) {}
  };
  net.close = () => { net.closed = true; stop(); try { ws.close(); } catch (e) {} if (Play.net === net) Play.net = null; };

  // Botões que chegaram (de qualquer canal) -> motor. Repetido não faz mal: o motor só anota.
  const deliver = (slot, frame, keys) => {
    if (net.sink) net.sink(slot, frame, keys); else net.early.push([slot, frame, keys]);
  };

  // ---------------- canal rápido (WebRTC, por UDP), direto de navegador para navegador
  // O WebSocket é TCP: se o Wi-Fi perde um pacote, ele segura todos os botões seguintes até
  // reenviar o perdido. No canal rápido não há reenvio nem fila: cada pacote leva os botões dos
  // últimos RTC_REPEAT quadros, então se um se perde o próximo já traz. O WebSocket continua
  // mandando tudo também (reserva): vale o que chegar primeiro. Se o canal rápido não abrir
  // (rede que bloqueia), o jogo segue só pelo WebSocket, como antes.
  const RTC_REPEAT = 8;
  net.peers = {};    // slot -> { pc, dc, sendDesc }
  const mine = [];   // meus últimos botões: [quadro, botões], em sequência
  const seen = [];   // slot -> maior quadro já entregue
  let lastRtc = 0;
  const signal = (to, obj) => {
    const body = new TextEncoder().encode(JSON.stringify(obj));
    const b = new Uint8Array(1 + body.length);
    b[0] = to; b.set(body, 1);
    net.send("R", b);
  };
  const openDcs = () => Object.values(net.peers).map(p => p.dc).filter(dc => dc.readyState === "open");
  function rtcPacket() {
    const b = new Uint8Array(7 + 2 * mine.length), dv = new DataView(b.buffer);
    b[0] = 73; b[1] = net.slot;   // "I"
    dv.setUint32(2, mine[mine.length - 1][0], true);
    b[6] = mine.length;
    mine.forEach(([, k], i) => dv.setUint16(7 + 2 * i, k, true));
    return b;
  }
  function rtcSend() {
    const dcs = openDcs();
    if (!dcs.length || !mine.length) return;
    const b = rtcPacket();
    for (const dc of dcs) try { dc.send(b); } catch (e) {}
    lastRtc = performance.now();
  }
  function rtcInput(body) {
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    mine.push([dv.getUint32(1, true), dv.getUint16(5, true)]);
    if (mine.length > RTC_REPEAT) mine.shift();
    rtcSend();
  }
  // Parado esperando alguém? Reenvia o último pacote: se ele se perdeu, ninguém fica preso.
  net.rtcIv = setInterval(() => { if (performance.now() - lastRtc > 15) rtcSend(); }, 15);

  function rtcRecv(from, u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (u8[0] === 73) {          // "I": botões dos últimos quadros de um jogador
      const slot = u8[1], last = dv.getUint32(2, true), cnt = u8[6];
      for (let i = 0; i < cnt; i++) {
        const f = last - cnt + 1 + i;
        if (f > (seen[slot] ?? -1)) { seen[slot] = f; deliver(slot, f, dv.getUint16(7 + 2 * i, true)); }
      }
    } else if (u8[0] === 80) {   // "P": ping -> devolve como "p"
      const b = u8.slice(); b[0] = 112;
      const p = net.peers[from];
      if (p && p.dc.readyState === "open") try { p.dc.send(b); } catch (e) {}
    } else if (u8[0] === 112) {  // "p": resposta do meu ping
      gotPong(dv.getUint32(1, true), "udp");
    }
  }
  function makePeer(slot, offer) {
    const pc = new RTCPeerConnection({ iceServers: [] });   // mesma rede: não precisa de servidor STUN
    const dc = pc.createDataChannel("botoes", { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    dc.binaryType = "arraybuffer";
    dc.onmessage = (ev) => rtcRecv(slot, new Uint8Array(ev.data));
    dc.onopen = () => { console.log(`canal rápido aberto com P${slot + 1}`); rtcSend(); };
    // manda a descrição já com os endereços (na rede local isso leva bem menos de 1 s)
    const sendDesc = async () => {
      await new Promise(ok => {
        if (pc.iceGatheringState === "complete") return ok();
        const t = setTimeout(ok, 2000);
        pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); ok(); } };
      });
      signal(slot, { sdp: pc.localDescription });
    };
    const peer = net.peers[slot] = { pc, dc, sendDesc };
    if (offer) pc.createOffer().then(o => pc.setLocalDescription(o)).then(sendDesc)
      .catch(e => console.warn("canal rápido", e));
    return peer;
  }
  async function onSignal(from, msg) {
    try {
      const peer = net.peers[from] || makePeer(from, false);
      await peer.pc.setRemoteDescription(msg.sdp);
      if (msg.sdp.type === "offer") {
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        await peer.sendDesc();
      }
    } catch (e) { console.warn("canal rápido", e); }
  }
  // Na partida: quem tem o número menor chama cada um dos outros
  function rtcStart(n) {
    if (typeof RTCPeerConnection === "undefined") return;
    for (let s = net.slot + 1; s < n; s++) makePeer(s, true);
  }

  // Medidor da rede: ping 4x por segundo até o P1 pelo canal rápido (se aberto), senão até o
  // host pelo WebSocket. A cada 2 s manda um resumo dos últimos 10 s (normal = mediana, pior,
  // picos acima de 50 ms = 3 quadros, canal); o host repassa para todos e cada um vê no rodapé
  // a rede de todo mundo (net.q[slot]). O tempo inclui a página ocupada.
  net.q = {};
  net.load = null;   // { cpu: motor %, page: página % } deste aparelho (vem do status do motor)
  let margAcc = {};  // slot -> folga dos botões dele aqui, desde o último relatório
  // status do motor (1x por segundo): guarda a carga e soma a folga de cada um até o relatório
  net.status = (m) => {
    net.load = { cpu: m.load, page: m.page };
    net.delay = m.delay;
    for (const [s, v] of Object.entries(m.marg || {})) {
      const a = margAcc[s] || (margAcc[s] = { min: 99, late: 0, tight: 0, sum: 0, cnt: 0 });
      a.min = Math.min(a.min, v.min); a.late += v.late; a.tight += v.tight; a.sum += v.sum; a.cnt += v.cnt;
    }
  };
  // Pelo canal rápido (UDP) um ping pode se PERDER (não há reenvio): sem resposta em 1 s ele
  // conta como perdido, não como "ainda esperando" (antes virava um pico falso de vários
  // segundos). Vários perdidos seguidos = a rede ficou muda esse tempo (gap).
  const pings = new Map(), samples = [], losses = [];   // pings: seq -> { t, udp }
  let pingSeq = 0, lastReport = performance.now(), via = "tcp", lostRun = 0;
  function gotPong(seq, how) {
    const p = pings.get(seq);
    if (p == null) return;
    pings.delete(seq);
    via = how; lostRun = 0;
    samples.push({ t: performance.now(), rtt: performance.now() - p.t });
  }
  net.pingIv = setInterval(() => {
    const now = performance.now();
    const b = new Uint8Array(5), dv = new DataView(b.buffer);
    dv.setUint32(1, ++pingSeq, true);
    const p1 = net.slot !== 0 && net.peers[0];
    const udp = !!(p1 && p1.dc.readyState === "open");
    pings.set(pingSeq, { t: now, udp });
    if (udp) { b[0] = 80; try { p1.dc.send(b); } catch (e) {} }
    else net.send("P", b.subarray(1));
    for (const [s, p] of pings) {
      if (p.udp && now - p.t > 1000) { pings.delete(s); losses.push({ t: now, run: ++lostRun }); }
      else if (now - p.t > 10000) pings.delete(s);
    }
    while (samples.length && now - samples[0].t > 10000) samples.shift();
    while (losses.length && now - losses[0].t > 10000) losses.shift();
    if (now - lastReport < 2000 || !samples.length) return;
    lastReport = now;
    const rtts = samples.map(x => x.rtt).sort((a, b) => a - b);
    // ping pelo WebSocket ainda sem resposta também conta: um "cochilo" longo aparece já
    let worst = rtts[rtts.length - 1];
    for (const p of pings.values()) if (!p.udp) worst = Math.max(worst, now - p.t);
    const ld = net.load || {};
    net.send("Q", JSON.stringify({ med: Math.round(rtts[rtts.length >> 1]), max: Math.round(worst),
                                   spikes: rtts.filter(r => r >= 50).length, via,
                                   lost: losses.length, gap: Math.max(0, ...losses.map(l => l.run)) * 250,
                                   cpu: ld.cpu ?? -1, page: ld.page ?? -1, delay: net.delay ?? -1, marg: margAcc }));
    margAcc = {};
  }, 250);

  ws.onopen = () => { net.opened = true; net.send("H", JSON.stringify(hello)); };
  ws.onmessage = (ev) => {
    const u8 = new Uint8Array(ev.data), kind = String.fromCharCode(u8[0]), data = u8.subarray(1);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (kind === "W") net.slot = json(data).slot;
    else if (kind === "L") cb.onLobby(json(data).players, net.slot);
    else if (kind === "S") { const info = json(data); if (info.rtc) rtcStart(info.n); cb.onStart(info); }
    else if (kind === "I") {
      // sempre entrega (mesmo se o canal rápido já trouxe): é a reserva para quando ele perde vários
      const slot = dv.getUint8(0), f = dv.getUint32(1, true);
      if (f > (seen[slot] ?? -1)) seen[slot] = f;
      deliver(slot, f, dv.getUint16(5, true));
    }
    else if (kind === "R") onSignal(data[0], json(data.subarray(1)));
    else if (kind === "P") gotPong(dv.getUint32(0, true), "tcp");
    else if (kind === "Q") {
      const q = json(data);
      net.q[q.slot] = q;
      // o que esse jogador achou dos MEUS botões -> motor (atraso automático)
      const mine = q.slot !== net.slot && q.marg && q.marg[net.slot];
      if (mine && net.onMarg) net.onMarg({ ...mine, from: q.slot, delay: q.delay });
    }
    else if (kind === "D") { if (Play.run) { Play.run.desync = dv.getUint32(0, true); S.desync = Play.run.desync; renderGame(S, false); } }
    else if (kind === "E") { net.gotError = true; cb.onError(json(data).msg); net.close(); }
  };
  ws.onclose = (ev) => {
    console.warn(`conexão com a sala fechou (código ${ev.code}${ev.reason ? ", " + ev.reason : ""})`);
    stop();
    if (net.closed || net.gotError) return;
    net.closed = true;
    if (Play.net === net) Play.net = null;
    cb.onError(Play.run ? "A conexão com o host caiu."
      : net.opened ? "A sala fechou a conexão logo depois de entrar (veja a janela preta do host)."
      : ev.reason || "Não consegui falar com a sala (o host fechou ou a rede caiu).");
  };
  return net;
}

// ------------------------------------------------------------------ partida
// Os GBAs rodam em engine-worker.js (linha separada). Aqui só ficam tela, som e botões.
// opts: { n, rom, saves[], names[], net (ou null), slot, delay,
//         onSave(saves[], fechandoAba) — grava o save; onEnd(saves[]) — partida acabou }
function startRun(opts) {
  const worker = new Worker("engine-worker.js");
  const run = { ...opts, worker, desync: null, raf: 0, lastKeys: "",
                queue: [], base: null, avOff: null, lagS: null, k: null, vsync: 1000 / 60, lastTs: 0,
                stat: { shown: 0, skipped: 0, idle: 0, gaps: 0, lastF: null, audioLag: null },
                pageBusy: 0, pageT: performance.now() };
  Play.run = run;
  PadMode.set(true);
  if (XBOX) toast("🎮 Controle só no jogo. Para usar o cursor (botão Sair): L3+R3 juntos.");
  run.lastMsg = performance.now() + 10000;   // folga para o motor carregar
  worker.onmessage = (ev) => {
    const t = run.lastMsg = performance.now();
    onWorker(run, ev.data);
    run.pageBusy += performance.now() - t;   // carga da página: receber quadros, som, desenhar
  };
  worker.onerror = (ev) => onWorker(run, { t: "err", msg: "O motor parou: " + (ev.message || "erro") });
  const roms = opts.rom.slice();   // cópia: a original continua aqui para uma próxima partida
  worker.postMessage({ t: "start", module: Play.mod, n: run.n, rom: roms, saves: opts.saves,
                       net: !!run.net, slot: run.slot, delay: run.delay || 0 }, [roms.buffer]);
  if (run.net) {
    run.net.sink = (slot, frame, keys) => worker.postMessage({ t: "input", slot, frame, keys });
    run.net.onMarg = (r) => worker.postMessage({ t: "pm", ...r });
    for (const it of run.net.early) run.net.sink(...it);
    run.net.early = [];
  }
  S = { screen: "game", mode: run.net ? "net" : "local", n: run.n, my: run.slot, players: run.names,
        view_all: !run.net, desync: null };
  showOnly("game");
  renderGame(S, true);
  syncView();
  Sound.ensure(); Sound.attach(worker); Sound.reset(); updateSoundButton();
  run.raf = requestAnimationFrame((t) => present(run, t));   // desenha no compasso da tela
  // botões: lidos aqui (teclado/joystick/toque só existem na página) e mandados ao worker
  run.keyIv = setInterval(() => sendKeys(run), 4);
  sendKeys(run);
}

function sendKeys(run) {
  const k = run.net ? [maskFor(0)] : [...Array(run.n).keys()].map(p => maskFor(p));
  const sig = k.join(",");
  if (sig === run.lastKeys) return;
  run.lastKeys = sig;
  run.worker.postMessage({ t: "keys", keys: k });
}

function syncView() {
  const run = Play.run;
  if (run) run.worker.postMessage({ t: "view", view: Object.keys(canvases).map(Number) });
}

// ------------------------------------------------------------------ imagem + som, com o mínimo de atraso
// v0.8.2: a imagem sai O MAIS CEDO POSSÍVEL (resposta rápida ao botão) e só espera o som se
// ele ficar mais de AV_TOL atrás. Com o som rápido (worklet), a imagem quase nunca espera.
// O motor anda no compasso da tela: a cada atualização (vsync) a página pede o quadro que já
// está na hora, junto com os botões mais frescos. Cada quadro chega numerado e entra numa fila
// curta, e nenhum é pulado por causa de timer (só o descompasso natural 59,73 × 60 Hz).
const FRAME_MS = 1000 * 280896 / 16777216;   // 16,74 ms: um quadro do GBA (59,73 por segundo)
const JITTER_MS = 6;                          // folga para a chegada dos quadros variar um pouco
const AV_TOL = 40;                            // ms que a imagem pode ir à frente do som (ITU: só se nota após ~125 ms)
const MAX_WAIT_VS = 3;                        // a imagem nunca espera mais que 3 atualizações (~50 ms): resposta rápida

function audioToPerf(run, at) {
  // relógio da placa de som -> relógio da página (já contando o atraso da saída de áudio)
  const ctx = Sound.ctx;
  let off;
  const ts = ctx.getOutputTimestamp && ctx.getOutputTimestamp();
  if (ts && ts.performanceTime > 0) off = ts.performanceTime - ts.contextTime * 1000;
  else off = performance.now() - (ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0)) * 1000;
  if (run.avOff == null || Math.abs(off - run.avOff) > 40) run.avOff = off;
  else run.avOff += (off - run.avOff) * 0.02;   // suaviza (a medida vem em degraus)
  return at * 1000 + run.avOff;
}

function dueFor(run, f, at) {
  // relógio "ideal" do jogo: quadro f deveria existir em base + f * 16,74 ms
  const now = performance.now(), ideal = f * FRAME_MS;
  const late = run.base == null ? 0 : now - (run.base + ideal);
  if (run.base == null || late < 0 || late > 30) run.base = now - ideal;    // adiantou ou o jogo esperou a rede: reancora
  else run.base += late * 0.01;                                             // acompanha devagar
  const emuDue = run.base + ideal + JITTER_MS;
  // quando o som deste quadro vai sair da caixa
  let aDue = null;
  const lat = Sound.latencyMs();
  if (lat != null) aDue = now + lat;                     // worklet: atraso medido da fila de som
  else if (at != null) aDue = audioToPerf(run, at);      // blocos agendados: instante exato
  const lag = aDue == null ? null : aDue - now;
  run.stat.audioLag = lag;
  if (lag == null || lag < 0 || lag > 400) return emuDue;
  // Quanto a imagem precisa esperar para o som não ficar mais de AV_TOL atrás. Usamos uma média
  // e arredondamos para um número INTEIRO de atualizações de tela, com margem para não ficar
  // trocando: espera que varia um pouquinho a cada quadro faz a imagem tremer (repete/pula).
  run.lagS = run.lagS == null ? lag : run.lagS + (lag - run.lagS) * 0.02;
  const want = Math.max(0, run.lagS - AV_TOL) / run.vsync;
  if (run.k == null || Math.abs(want - run.k) > 0.75) run.k = Math.min(MAX_WAIT_VS, Math.round(want));
  return emuDue + run.k * run.vsync;
}

function recycle(run, fr) {
  const bufs = fr.vids.map(v => v.buf);
  if (bufs.length) run.worker.postMessage({ t: "bufs", bufs }, bufs);
}

// Desenha o quadro mais novo que já está na hora de aparecer até 'showAt'.
function drawDue(run, showAt) {
  let pick = null;
  while (run.queue.length && run.queue[0].due <= showAt) {
    if (pick) { recycle(run, pick); run.stat.skipped++; }
    pick = run.queue.shift();
  }
  if (!pick) return false;
  for (const v of pick.vids) {
    const c = canvases[v.i];
    if (c) c.ctx.putImageData(new ImageData(new Uint8ClampedArray(v.buf), W, H), 0, 0);
  }
  const first = pick.vids.length && canvases[pick.vids[0].i];
  if (first) Fit.paint(first.ctx.canvas);
  run.stat.shown++;
  if (run.stat.lastF != null && pick.f !== run.stat.lastF + 1) run.stat.gaps++;
  run.stat.lastF = pick.f;
  recycle(run, pick);
  return true;
}

function present(run, ts) {
  if (Play.run !== run) return;
  run.raf = requestAnimationFrame((t) => present(run, t));
  const t0 = performance.now();
  try { presentStep(run, ts); } finally { run.pageBusy += performance.now() - t0; }
}
function presentStep(run, ts) {
  if (run.lastTs) { const dt = ts - run.lastTs; if (dt > 4 && dt < 40) run.vsync += (dt - run.vsync) * 0.05; }
  run.lastTs = ts;
  // botões frescos + "roda o quadro que já está na hora" (não depende da precisão dos timers)
  // vigia: o motor manda notícia pelo menos 1x por segundo (mesmo esperando a rede). Se sumir
  // por 6 s, ele travou: encerra com aviso em vez de congelar em silêncio (o save já está guardado).
  if (!run.hung && ts - run.lastMsg > 6000 && !document.hidden) {
    run.hung = true;
    onWorker(run, { t: "err", msg: "O jogo travou (o motor parou de responder)." });
    return;
  }
  sendKeys(run);
  run.worker.postMessage({ t: "vs" });
  if (!drawDue(run, ts + run.vsync)) run.stat.idle++;   // aparece na próxima atualização da tela
}

function onWorker(run, m) {
  if (m.t === "frames") {
    if (Play.run !== run) { for (const fr of m.list) recycle(run, fr); return; }
    for (const fr of m.list) {
      const at = Sound.push(fr.audio);
      run.queue.push({ f: fr.f, vids: fr.vids, due: dueFor(run, fr.f, at) });
    }
    while (run.queue.length > 24) { recycle(run, run.queue.shift()); run.stat.skipped++; }   // aba no fundo
    drawDue(run, performance.now() + run.vsync * 0.5);   // já pronto? desenha agora (entra no próximo vsync)
  }
  else if (m.t === "net") { if (run.net) run.net.send(m.kind, m.bytes); }
  else if (m.t === "status") {
    // carga da página: parte do tempo gasta pelo kirbynet na linha principal (desenho, som, botões)
    const now = performance.now();
    m.page = Math.round(run.pageBusy / Math.max(1, now - run.pageT) * 100);
    run.pageBusy = 0; run.pageT = now;
    if (run.net && run.net.status) run.net.status(m);
    if (Play.run === run) showStatus(m);
  }
  else if (m.t === "err") {
    if (Play.run !== run) return;
    endRun();
    const msg = m.msg + (run.savedAt ? ` O save automático das ${run.savedAt.toLocaleTimeString("pt-BR")} está guardado.` : "");
    if (run.net) { run.net.close(); run.net.cb.onError(msg); } else toast(msg);
  }
  else if (m.t === "snap") persistSaves(run, m.saves, false);   // o jogo gravou algo novo
  else if (m.t === "saves") finishRun(run, m.saves);
}

// Guarda o save (convidado: neste navegador; host / "Mesmo PC": na pasta saves do PC).
// É chamado sozinho sempre que o jogo grava, ao sair, se der erro e ao fechar a aba.
function persistSaves(run, saves, unload) {
  if (!saves || !saves.length || !saves.some(b => b && b.length)) return;
  run.lastSaves = saves;
  try { if (run.onSave) run.onSave(saves, !!unload); run.savedAt = new Date(); }
  catch (e) { console.warn("save", e); }
}

// Termina a partida e entrega os saves (todos no "Mesmo PC"; só o seu em rede)
function endRun() {
  const run = Play.run;
  if (!run) return;
  Play.run = null;
  PadMode.set(false);
  clearInterval(run.keyIv);
  if (run.raf) cancelAnimationFrame(run.raf);
  if (document.fullscreenElement) document.exitFullscreen();
  run.worker.postMessage({ t: "end" });
  run.endTimer = setTimeout(() => finishRun(run, []), 3000);   // se o motor não responder
}
function finishRun(run, saves) {
  if (run.finished) return;
  run.finished = true;
  clearTimeout(run.endTimer);
  run.worker.terminate();
  persistSaves(run, saves, false);   // vazio (motor não respondeu)? fica valendo o último salvo automático
  if (run.onEnd) run.onEnd(saves || []);
}

// Fechou a aba / o navegador / recarregou no meio da partida:
// 1) o navegador pergunta "Sair do site?" (dá tempo de o save mais novo chegar);
// 2) ao sair de fato, o último save é gravado mais uma vez, por garantia.
addEventListener("beforeunload", (e) => {
  const run = Play.run;
  if (!run) return;
  run.worker.postMessage({ t: "snap" });
  e.preventDefault();
  e.returnValue = "";
});
addEventListener("pagehide", () => {
  const run = Play.run;
  if (run && run.lastSaves) persistSaves(run, run.lastSaves, true);
});
// celular trocando de app / aba indo para o fundo: salva já, antes que o sistema feche a página
document.addEventListener("visibilitychange", () => {
  if (document.hidden && Play.run) Play.run.worker.postMessage({ t: "snap" });
});

function toggleRunView() {
  if (!Play.run) return;
  S.view_all = !S.view_all;
  renderGame(S, false);
  syncView();
}
