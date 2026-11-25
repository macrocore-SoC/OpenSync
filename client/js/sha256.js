/**
 * Incremental streaming SHA-256 for the browser.
 * Web Crypto's subtle.digest has no streaming mode, so multi-GB files cannot be
 * hashed via crypto.subtle without buffering the whole file into memory.
 * This module implements SHA-256 incrementally (RFC 6234 / FIPS 180-4).
 */

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const H0 = new Int32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const textEncoder = new TextEncoder();
const SUBTLE_MAX_BYTES = 32 * 1024 * 1024;

export class Sha256 {
  constructor() {
    this._h = H0.slice();
    this._w = new Int32Array(64);
    this._buf = new Uint8Array(64);
    this._bufLen = 0;
    this._total = 0;
    this._finalized = false;
  }

  update(input) {
    if (this._finalized) throw new Error('Sha256 already finalized');
    const data = typeof input === 'string' ? textEncoder.encode(input) : input;
    const len = data.length;
    this._total += len;
    let offset = 0;
    if (this._bufLen > 0) {
      const need = 64 - this._bufLen;
      const take = need < len ? need : len;
      this._buf.set(take === len ? data : data.subarray(0, take), this._bufLen);
      this._bufLen += take;
      offset += take;
      if (this._bufLen === 64) {
        this._block(this._buf, 0);
        this._bufLen = 0;
      }
    }
    while (offset + 64 <= len) {
      this._block(data, offset);
      offset += 64;
    }
    const rem = len - offset;
    if (rem > 0) {
      this._buf.set(offset === 0 ? data : data.subarray(offset), 0);
      this._bufLen = rem;
    }
    return this;
  }

  _block(data, offset) {
    const w = this._w;
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = (data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15];
      const w2 = w[i - 2];
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let a = this._h[0];
    let b = this._h[1];
    let c = this._h[2];
    let d = this._h[3];
    let e = this._h[4];
    let f = this._h[5];
    let g = this._h[6];
    let h = this._h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    this._h[0] = (this._h[0] + a) | 0;
    this._h[1] = (this._h[1] + b) | 0;
    this._h[2] = (this._h[2] + c) | 0;
    this._h[3] = (this._h[3] + d) | 0;
    this._h[4] = (this._h[4] + e) | 0;
    this._h[5] = (this._h[5] + f) | 0;
    this._h[6] = (this._h[6] + g) | 0;
    this._h[7] = (this._h[7] + h) | 0;
  }

  digest() {
    if (this._finalized) return this._out;
    const bitLen = this._total * 8;
    const pad = [0x80];
    const zeroBytes = (56 - ((this._bufLen + 1) % 64) + 64) % 64;
    for (let i = 0; i < zeroBytes; i++) pad.push(0);
    const lenBytes = new Uint8Array(8);
    // write 64-bit big-endian length (safe up to 2^53-1 bytes)
    let v = bitLen;
    for (let i = 7; i >= 0; i--) {
      lenBytes[i] = v & 0xff;
      v = Math.floor(v / 256);
    }
    this.update(new Uint8Array(pad));
    this.update(lenBytes);
    this._finalized = true;
    this._out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      this._out[i * 4] = (this._h[i] >>> 24) & 0xff;
      this._out[i * 4 + 1] = (this._h[i] >>> 16) & 0xff;
      this._out[i * 4 + 2] = (this._h[i] >>> 8) & 0xff;
      this._out[i * 4 + 3] = this._h[i] & 0xff;
    }
    return this._out;
  }

  digestHex() {
    const out = this.digest();
    let hex = '';
    for (let i = 0; i < out.length; i++) hex += out[i].toString(16).padStart(2, '0');
    return hex;
  }
}

/** Hash a File object in a streaming fashion (memory-bounded), using hardware-accelerated Web Crypto for <=32 MB files. */
export async function hashFile(file) {
  if (globalThis.crypto?.subtle && typeof file.arrayBuffer === 'function' && file.size <= SUBTLE_MAX_BYTES) {
    const buf = await file.arrayBuffer();
    const digest = await globalThis.crypto.subtle.digest('SHA-256', buf);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex;
  }
  const hasher = new Sha256();
  const reader = file.stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  return hasher.digestHex();
}
