// Motor kirbynet em WebAssembly (mGBA compilado). Funciona no navegador e no Node.
// Uso:  const eng = await KnCore.load(bytesDoWasm);  const s = eng.create(n, romBytes, [saves]);

(function (root) {
  "use strict";
  const W = 240, H = 160;

  // Mini "sistema operacional" (WASI) só com o que o mGBA pede. Não há arquivos:
  // ROM e saves vão pela memória. O relógio é fixo para o jogo não depender da hora.
  function makeWasi(getMem) {
    const ENOSYS = 52, EBADF = 8;
    const view = () => new DataView(getMem().buffer);
    let logLine = "";
    return {
      environ_get: () => 0,
      environ_sizes_get: (pc, ps) => { const v = view(); v.setUint32(pc, 0, true); v.setUint32(ps, 0, true); return 0; },
      clock_time_get: (id, prec, out) => { view().setBigUint64(out, 0n, true); return 0; },
      fd_close: () => 0,
      fd_fdstat_get: () => EBADF,
      fd_filestat_get: () => EBADF,
      fd_filestat_set_size: () => EBADF,
      fd_prestat_get: () => EBADF,
      fd_prestat_dir_name: () => EBADF,
      fd_read: () => EBADF,
      fd_seek: () => EBADF,
      fd_sync: () => 0,
      fd_tell: () => EBADF,
      fd_write: (fd, iovs, n, written) => {
        const v = view(), mem = new Uint8Array(getMem().buffer);
        let total = 0;
        for (let i = 0; i < n; i++) {
          const p = v.getUint32(iovs + i * 8, true), len = v.getUint32(iovs + i * 8 + 4, true);
          logLine += new TextDecoder().decode(mem.subarray(p, p + len));
          total += len;
        }
        let k;
        while ((k = logLine.indexOf("\n")) >= 0) { console.log("[motor]", logLine.slice(0, k)); logLine = logLine.slice(k + 1); }
        v.setUint32(written, total, true);
        return 0;
      },
      path_create_directory: () => ENOSYS,
      path_open: () => ENOSYS,
      proc_exit: (code) => { throw new Error("motor saiu com código " + code); },
    };
  }

  async function load(wasmBytes) {
    let inst;
    const wasi = makeWasi(() => inst.exports.memory);
    const res = await WebAssembly.instantiate(wasmBytes, { wasi_snapshot_preview1: wasi });
    inst = res.instance || res;
    const x = inst.exports;
    if (x._initialize) x._initialize();
    const u8 = () => new Uint8Array(x.memory.buffer);

    function put(bytes) {
      const p = x.kn_malloc(bytes.length || 1);
      u8().set(bytes, p);
      return p;
    }

    function create(n, rom, saves) {
      const romPtr = put(rom);  // fica na memória durante a partida (os GBAs leem dela)
      const savePtrs = [], saveLens = [];
      for (let i = 0; i < n; i++) {
        const s = (saves && saves[i]) || new Uint8Array(0);
        savePtrs.push(put(s));
        saveLens.push(s.length);
      }
      const arrP = x.kn_malloc(4 * n), arrL = x.kn_malloc(4 * n);
      const dv = new DataView(x.memory.buffer);
      for (let i = 0; i < n; i++) { dv.setUint32(arrP + 4 * i, savePtrs[i], true); dv.setUint32(arrL + 4 * i, saveLens[i], true); }
      const ptr = x.kn_create_mem(n, romPtr, rom.length, arrP, arrL);
      savePtrs.forEach(p => x.kn_free(p));
      x.kn_free(arrP); x.kn_free(arrL);
      if (!ptr) { x.kn_free(romPtr); throw new Error("O motor não conseguiu abrir a ROM."); }
      const keysPtr = x.kn_malloc(2 * n);
      const vidPtr = x.kn_malloc(W * H * 4);
      const outPtr = x.kn_malloc(4);
      const AUD_MAX = 4096;
      const audPtr = x.kn_malloc(AUD_MAX * 4);
      return {
        n,
        runFrame(keys) {
          const dv = new DataView(x.memory.buffer);
          for (let i = 0; i < n; i++) dv.setUint16(keysPtr + 2 * i, keys[i] & 0x3FF, true);
          if (x.kn_run_frame(ptr, keysPtr) !== 0) throw new Error("O motor travou ao rodar o frame.");
        },
        // Copia a tela i (RGBA pronto para o canvas) para dentro de 'dst' (Uint8ClampedArray de 240*160*4)
        video(i, dst) {
          x.kn_video_rgba(ptr, i, vidPtr);
          dst.set(new Uint8Array(x.memory.buffer, vidPtr, W * H * 4));
        },
        hash() { return BigInt.asUintN(64, x.kn_game_hash(ptr)); },  // igual ao nativo
        // Som do GBA i: { rate, samples: Int16Array estéreo intercalado } (não mexe na emulação)
        audio(i) {
          const frames = x.kn_audio_read(ptr, i, audPtr, AUD_MAX);
          return { rate: x.kn_audio_rate(ptr, i), samples: new Int16Array(x.memory.buffer, audPtr, frames * 2).slice() };
        },
        save(i) {
          const len = x.kn_savedata(ptr, i, outPtr);
          if (!len) return new Uint8Array(0);
          const p = new DataView(x.memory.buffer).getUint32(outPtr, true);
          const copy = new Uint8Array(x.memory.buffer, p, len).slice();
          x.kn_free(p);
          return copy;
        },
        destroy() {
          x.kn_destroy(ptr);
          [romPtr, keysPtr, vidPtr, outPtr, audPtr].forEach(p => x.kn_free(p));
        },
      };
    }
    return { create };
  }

  const api = { load, W, H };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KnCore = api;
})(typeof self !== "undefined" ? self : this);
