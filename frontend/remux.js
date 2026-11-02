/* =========================================================================
 * remux.js - byte/MP4/EBML utilities, MP4 & WebM demuxers, MP4 & WebM muxers,
 * stream fetch/merge orchestration.
 * Extracted verbatim from yt-media-downloader/content.js; fetchStream patched
 * to route googlevideo through the /api/stream proxy (web app has no CORS perms).
 * Exposes window.YTDU and window.YTD.
 * ========================================================================= */
/* =========================================================================
 * 00-util.js  -  byte helpers, MP4 box writer, EBML writer, misc utilities
 * Part of YT Media Downloader. Loaded first; exposes the `YTDU` namespace.
 * ========================================================================= */
(function (root) {
  'use strict';

  /* ---------------- byte reader (big endian) ---------------- */
  class Reader {
    constructor(u8) { this.u8 = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8); this.p = 0; }
    get left() { return this.u8.length - this.p; }
    eof() { return this.p >= this.u8.length; }
    u(n) { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + this.u8[this.p++]; return v; }
    u8v() { return this.u8[this.p++]; }
    u16() { const v = (this.u8[this.p] << 8) | this.u8[this.p + 1]; this.p += 2; return v >>> 0; }
    u24() { const v = (this.u8[this.p] << 16) | (this.u8[this.p + 1] << 8) | this.u8[this.p + 2]; this.p += 3; return v >>> 0; }
    u32() { const v = ((this.u8[this.p] << 24) | (this.u8[this.p + 1] << 16) | (this.u8[this.p + 2] << 8) | this.u8[this.p + 3]) >>> 0; this.p += 4; return v; }
    u64() { const hi = this.u32(), lo = this.u32(); return hi * 4294967296 + lo; }
    i16() { const v = this.u16(); return v >= 0x8000 ? v - 0x10000 : v; }
    i32() { const v = this.u32(); return v >= 0x80000000 ? v - 0x100000000 : v; }
    f32() { const dv = new DataView(this.u8.buffer, this.u8.byteOffset + this.p, 4); const v = dv.getFloat32(0, false); this.p += 4; return v; }
    f64() { const dv = new DataView(this.u8.buffer, this.u8.byteOffset + this.p, 8); const v = dv.getFloat64(0, false); this.p += 8; return v; }
    str(n) { const s = new TextDecoder('utf-8').decode(this.u8.subarray(this.p, this.p + n)); this.p += n; return s; }
    cstr() { let e = this.p; while (e < this.u8.length && this.u8[e] !== 0) e++; const s = this.str(e - this.p); this.p++; return s; }
    bytes(n) { const s = this.u8.subarray(this.p, this.p + n); this.p += n; return s; }
    skip(n) { this.p += n; }
    seek(p) { this.p = p; }
  }

  /* ---------------- EBML variable-size-integer reader ---------------- */
  function ebmlVint(u8, o, keepMarker) {
    if (o >= u8.length) return null;
    const first = u8[o];
    if (first === 0) return null;
    let len = 1, mask = 0x80;
    while (len <= 8 && !(first & mask)) { mask >>= 1; len++; }
    if (len > 8 || o + len > u8.length) return null;
    let val = keepMarker ? first : (first & (mask - 1));
    for (let i = 1; i < len; i++) val = val * 256 + u8[o + i];
    return { value: val, length: len };
  }

  /* ---------------- growable byte sink ---------------- */
  class ByteSink {
    constructor(chunkSize) { this.chunks = []; this.length = 0; this.chunkSize = chunkSize || (1 << 20); }
    push(u8) { if (!u8 || !u8.length) return; this.chunks.push(u8); this.length += u8.length; }
    u32be(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, false); this.push(b); }
    u16be(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v & 0xffff, false); this.push(b); }
    u8v(v) { this.push(new Uint8Array([v & 0xff])); }
    concat() {
      const out = new Uint8Array(this.length);
      let o = 0;
      for (const c of this.chunks) { out.set(c, o); o += c.length; }
      return out;
    }
    toBlob(type) { return new Blob(this.chunks, type ? { type } : undefined); }
  }

  /* ---------------- MP4 box helpers ---------------- */
  // Builds a box from a list of parts. Parts are Uint8Array, string(ascii), number arrays,
  // or nested {box:true, parts:[...]} objects.
  function mp4Box(type, ...parts) {
    const body = new ByteSink();
    for (const p of parts) mp4Append(body, p);
    const hdr = new Uint8Array(8);
    new DataView(hdr.buffer).setUint32(0, 8 + body.length, false);
    for (let i = 0; i < 4; i++) hdr[4 + i] = type.charCodeAt(i);
    return { box: true, parts: [hdr, body.concat()] };
  }
  function mp4FullBox(type, version, flags, ...parts) {
    const vf = new Uint8Array(4);
    vf[0] = version;
    vf[1] = (flags >> 16) & 0xff; vf[2] = (flags >> 8) & 0xff; vf[3] = flags & 0xff;
    return mp4Box(type, vf, ...parts);
  }
  function mp4Append(sink, p) {
    if (p == null) return;
    if (p.box) { for (const q of p.parts) mp4Append(sink, q); return; }
    if (p instanceof Uint8Array) { sink.push(p); return; }
    if (p instanceof ArrayBuffer) { sink.push(new Uint8Array(p)); return; }
    if (typeof p === 'string') { for (let i = 0; i < p.length; i++) sink.u8v(p.charCodeAt(i)); return; }
    if (Array.isArray(p)) { for (const q of p) mp4Append(sink, q); return; }
    if (typeof p === 'number') { sink.u8v(p); return; }
    throw new Error('mp4Append: unsupported part ' + typeof p);
  }
  function mp4Bytes(...parts) { const s = new ByteSink(); for (const p of parts) mp4Append(s, p); return s.concat(); }
  function mp4Size(...parts) { const s = new ByteSink(); for (const p of parts) mp4Append(s, p); return 8 + s.length; }
  const u8of = (a) => new Uint8Array(a);
  const be32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, false); return b; };
  const be16 = (v) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v & 0xffff, false); return b; };

  /* ---------------- EBML helpers ---------------- */
  function ebmlIdBytes(id) {
    const out = [];
    if (id > 0xffffff) out.push((id >>> 24) & 0xff, (id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff);
    else if (id > 0xffff) out.push((id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff);
    else if (id > 0xff) out.push((id >>> 8) & 0xff, id & 0xff);
    else out.push(id & 0xff);
    return u8of(out);
  }
  function ebmlSizeBytes(n) {
    // shortest VINT_WIDTH that can hold n (data bits), never "unknown size"
    for (let w = 1; w <= 8; w++) {
      const max = Math.pow(2, 7 * w) - 2; // -2 keeps away from the all-ones unknown marker
      if (n <= max) {
        const b = new Uint8Array(w);
        let v = BigInt(n);
        for (let i = w - 1; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
        b[0] |= 0x80 >> (w - 1);
        return b;
      }
    }
    throw new Error('ebml size too large');
  }
  function ebmlUint(id, value, width) {
    let w = width;
    if (!w) { w = 1; while (value >= Math.pow(2, 8 * w) && w < 8) w++; }
    const b = new Uint8Array(w);
    let v = BigInt(value);
    for (let i = w - 1; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
    return [ebmlIdBytes(id), ebmlSizeBytes(w), b];
  }
  function ebmlFloat(id, value) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, value, false);
    return [ebmlIdBytes(id), ebmlSizeBytes(8), b];
  }
  function ebmlStr(id, s) {
    const b = new TextEncoder().encode(s);
    return [ebmlIdBytes(id), ebmlSizeBytes(b.length), b];
  }
  function ebmlRaw(id, u8) {
    return [ebmlIdBytes(id), ebmlSizeBytes(u8.length), u8];
  }
  function ebmlMaster(id, ...children) {
    const s = new ByteSink();
    for (const c of children) mp4Append(s, c);
    const body = s.concat();
    return [ebmlIdBytes(id), ebmlSizeBytes(body.length), body];
  }

  /* ---------------- misc ---------------- */
  function bytesToHex(u8, max) {
    const n = Math.min(u8.length, max || u8.length);
    let s = '';
    for (let i = 0; i < n; i++) s += u8[i].toString(16).padStart(2, '0');
    return s;
  }
  function formatBytes(n) {
    if (n == null || isNaN(n)) return '?';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; n = Number(n);
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n < 10 ? 2 : 1)) + ' ' + u[i];
  }
  function formatDuration(sec) {
    if (sec == null || isNaN(sec) || sec < 0) return '--:--';
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  }
  function sanitizeFilename(s) {
    return String(s || 'video')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 160) || 'video';
  }
  // Split an ArrayBuffer/Uint8Array into <=size chunks (views, no copy)
  function chunkViews(u8, size) {
    const out = [];
    for (let o = 0; o < u8.length; o += size) out.push(u8.subarray(o, Math.min(o + size, u8.length)));
    return out;
  }

  root.YTDU = {
    Reader, ByteSink, ebmlVint,
    mp4Box, mp4FullBox, mp4Bytes, mp4Size, mp4Append,
    u8of, be32, be16,
    ebmlIdBytes, ebmlSizeBytes, ebmlUint, ebmlFloat, ebmlStr, ebmlRaw, ebmlMaster,
    bytesToHex, formatBytes, formatDuration, sanitizeFilename, chunkViews,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);


/* =========================================================================
 * 10-mp4-demux.js - ISO-BMFF (MP4) demuxer.
 * Handles BOTH layouts YouTube ships:
 *   - fragmented : ftyp moov(mvex/trex) sidx [moof mdat]...   (adaptive itags)
 *   - progressive: ftyp moov(full stbl)  mdat                 (itag 18, etc.)
 *
 * YTDU.MP4Demux(u8) -> { tracks: [ {
 *     type:'video'|'audio', trackId, timescale, codecName, codec:{...},
 *     samples:[{offset,size,duration,dts,cts,key}], duration, byteSize,
 *     ctsShift, encoderDelay
 * } ] }
 * `offset` values are absolute byte positions inside the buffer you passed in.
 * ========================================================================= */
(function (root) {
  'use strict';
  const U = root.YTDU;

  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'udta', 'edts', 'dinf', 'moof', 'traf', 'mvra', 'sinf', 'schi']);
  const VISUAL_TYPES = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'vp08', 'vp09', 'av01', 'mp4v', 'encv']);
  const AUDIO_TYPES = new Set(['mp4a', 'ac-3', 'ec-3', 'Opus', 'opus', 'fLaC', 'flac', 'alac', 'enca']);

  function boxHeaderAt(u8, o, end) {
    if (o + 8 > end) return null;
    let size = (u8[o] << 24 | u8[o + 1] << 16 | u8[o + 2] << 8 | u8[o + 3]) >>> 0;
    const type = String.fromCharCode(u8[o + 4], u8[o + 5], u8[o + 6], u8[o + 7]);
    let hdr = 8;
    if (size === 1) {
      if (o + 16 > end) return null;
      const hi = (u8[o + 8] << 24 | u8[o + 9] << 16 | u8[o + 10] << 8 | u8[o + 11]) >>> 0;
      const lo = (u8[o + 12] << 24 | u8[o + 13] << 16 | u8[o + 14] << 8 | u8[o + 15]) >>> 0;
      size = hi * 4294967296 + lo; hdr = 16;
    } else if (size === 0) {
      size = end - o;                       // box runs to end of buffer
    }
    if (size < hdr) return null;
    return { type, size, hdr, payload: o + hdr, end: Math.min(o + size, end) };
  }

  /* Depth-first walk. cb(type, payloadStart, payloadEnd, depth, path, boxOffset) */
  function walkBoxes(u8, start, end, cb, depth, path) {
    depth = depth || 0; path = path || '';
    let o = start;
    while (o + 8 <= end) {
      const b = boxHeaderAt(u8, o, end);
      if (!b) break;
      cb(b.type, b.payload, b.end, depth, path, o);
      if (CONTAINERS.has(b.type)) walkBoxes(u8, b.payload, b.end, cb, depth + 1, path + '/' + b.type);
      o += b.size;
    }
  }

  function findBox(u8, start, end, type) {
    let hit = null;
    walkBoxes(u8, start, end, (t, s, e, d, p, off) => { if (!hit && t === type) hit = { start: s, end: e, offset: off }; });
    return hit;
  }

  /* ---------------- sample entry ---------------- */
  function parseSampleEntry(u8, payload, entryEnd, type) {
    const info = { type, kind: VISUAL_TYPES.has(type) ? 'video' : AUDIO_TYPES.has(type) ? 'audio' : 'unknown' };
    const r = new U.Reader(u8);
    if (info.kind === 'video') {
      r.seek(payload + 24);                    // reserved(6)+dri(2)+pre/reserved(16)
      info.width = r.u16(); info.height = r.u16();
      // hres(4) vres(4) reserved(4) frameCount(2) compressorname(32) = 46
      r.skip(4 + 4 + 4 + 2 + 32);
      info.depth = r.u16();
      r.skip(2);                               // pre_defined = -1
      walkCodecChildren(u8, r.p, entryEnd, info);   // codec children start at payload+78
    } else if (info.kind === 'audio') {
      r.seek(payload + 16);                    // reserved(6)+dri(2)+reserved(8)
      info.channels = r.u16(); info.sampleSize = r.u16();
      r.skip(2 + 2);                           // pre_defined + reserved
      info.sampleRate = r.u32() / 65536;       // 16.16 fixed point
      walkCodecChildren(u8, r.p, entryEnd, info);
    } else {
      walkCodecChildren(u8, payload, entryEnd, info);
    }
    return info;
  }

  function walkCodecChildren(u8, start, end, info) {
    let o = start;
    while (o + 8 <= end) {
      const b = boxHeaderAt(u8, o, end);
      if (!b) break;
      const d = u8.subarray(b.payload, b.end);
      switch (b.type) {
        case 'avcC': case 'hvcC': case 'vpcC': case 'av1C': case 'dvvC': case 'dav1':
          info.codecBoxType = b.type;
          info.codecBox = d.slice();           // verbatim decoder config record
          break;
        case 'esds':
          info.esds = parseEsds(d);
          break;
        case 'pasp': {
          if (d.length >= 8) {
            const rr = new U.Reader(d);
            const h = rr.u32(), v = rr.u32();
            if (h && v && h !== v) info.pixelAspect = h / v;
          }
          break;
        }
        case 'colr':
          if (d.length >= 4) {
            info.colourType = String.fromCharCode(d[0], d[1], d[2], d[3]);
            if (d.length >= 11) {
              info.primaries = (d[4] << 8) | d[5];
              info.transfer = (d[6] << 8) | d[7];
              info.matrix = (d[8] << 8) | d[9];
            }
          }
          break;
        case 'btrt':
          if (d.length >= 12) { const rr = new U.Reader(d); rr.skip(4); info.maxBitrate = rr.u32(); info.avgBitrate = rr.u32(); }
          break;
      }
      o += b.size;
    }
  }

  /* esds payload (starting at version/flags) -> objectType + DecoderSpecificInfo */
  function parseEsds(d) {
    const out = { raw: d.slice() };
    let i = 4;
    function readLen() {
      let len = 0, b, guard = 0;
      do {
        if (i >= d.length) return len;
        b = d[i++];
        len = (len << 7) | (b & 0x7f);
      } while ((b & 0x80) && ++guard < 4);
      return len;
    }
    try {
      if (d[i++] !== 0x03) return out;         // ES_Descriptor
      readLen();
      i += 2;                                  // ES_ID
      const flags = d[i++];
      if (flags & 0x80) i += 2;                // dependsOn_ES_ID
      if (flags & 0x40) { const n = d[i++]; i += n; }
      if (flags & 0x20) i += 2;                // OCR_ES_ID

      if (d[i++] !== 0x04) return out;         // DecoderConfigDescriptor
      readLen();
      out.objectType = d[i++];                 // 0x40 = MPEG-4 Audio
      i += 1 + 3 + 4 + 4;                      // streamType, bufferSizeDB, max/avg bitrate

      if (d[i] === 0x05) {                     // DecoderSpecificInfo
        i++;
        const n = readLen();
        out.decoderConfig = d.subarray(i, i + n).slice();
      }
    } catch (e) { /* keep what we parsed */ }
    return out;
  }

  /* ---------------- main ---------------- */
  function MP4Demux(u8) {
    u8 = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
    const end = u8.length;
    const moov = findBox(u8, 0, end, 'moov');
    if (!moov) throw new Error('MP4 demux: no moov box');

    const tracks = [];

    /* ---- pass 1: traks ---- */
    {
      let o = moov.start;
      while (o + 8 <= moov.end) {
        const b = boxHeaderAt(u8, o, moov.end);
        if (!b) break;
        if (b.type === 'trak') tracks.push(parseTrak(u8, b.payload, b.end));
        o += b.size;
      }
    }

    /* ---- pass 2: mvex/trex marks fragmented tracks ---- */
    const mvex = findBox(u8, moov.start, moov.end, 'mvex');
    if (mvex) {
      const byId = new Map(tracks.map(t => [t.trackId, t]));
      walkBoxes(u8, mvex.start, mvex.end, (type, ds, de) => {
        if (type !== 'trex') return;
        const r = new U.Reader(u8); r.seek(ds); r.skip(4);
        const trackId = r.u32();
        const t = byId.get(trackId);
        if (!t) return;
        t.fragmented = true;
        t.trex = {
          defaultSampleDescriptionIndex: r.u32(),
          defaultSampleDuration: r.u32(),
          defaultSampleSize: r.u32(),
          defaultSampleFlags: r.u32(),
        };
      });
    }

    function parseTrak(u8, s, e) {
      const trk = {
        samples: [], timescale: 90000, trackId: 0, type: 'unknown',
        fragmented: false, editMediaTime: 0, editDuration: -1, codec: null,
      };
      walkBoxes(u8, s, e, (type, ds, de) => {
        const r = new U.Reader(u8);
        switch (type) {
          case 'tkhd': {
            r.seek(ds); const ver = r.u8v(); r.skip(3);
            r.skip(ver === 1 ? 16 : 8);            // creation + modification time
            trk.trackId = r.u32();
            r.skip(4);                             // reserved
            r.skip(ver === 1 ? 8 : 4);             // duration
            r.skip(8);                             // reserved
            r.skip(2 + 2 + 2);                     // layer, alt group, volume
            r.skip(36);                            // matrix
            trk.tkhdWidth = r.u32() / 65536;
            trk.tkhdHeight = r.u32() / 65536;
            break;
          }
          case 'mdhd': {
            r.seek(ds); const ver = r.u8v(); r.skip(3);
            r.skip(ver === 1 ? 16 : 8);
            trk.timescale = r.u32();
            trk.mediaDuration = ver === 1 ? r.u64() : r.u32();
            break;
          }
          case 'hdlr': {
            r.seek(ds + 4 + 4);                    // version/flags + pre_defined
            const ht = r.str(4);
            trk.type = ht === 'vide' ? 'video'
              : ht === 'soun' ? 'audio'
              : (ht === 'text' || ht === 'sbtl' || ht === 'subt') ? 'subtitle' : 'unknown';
            break;
          }
          case 'elst': {
            r.seek(ds); const ver = r.u8v(); r.skip(3);
            const n = r.u32();
            if (n > 0) {
              trk.editDuration = ver === 1 ? r.u64() : r.u32();
              trk.editMediaTime = ver === 1 ? Number(r.u64()) : r.i32();
            }
            break;
          }
          case 'stsd': {
            r.seek(ds); r.skip(4);                 // version/flags
            const entryCount = r.u32();
            let p = ds + 8;
            for (let i = 0; i < entryCount && p + 8 <= de; i++) {
              const eb = boxHeaderAt(u8, p, de);
              if (!eb) break;
              if (!trk.codec) trk.codec = parseSampleEntry(u8, eb.payload, eb.end, eb.type);
              p += eb.size;
            }
            trk.stsdRange = { s: ds, e: de };
            break;
          }
          case 'stbl': trk.stblRange = { s: ds, e: de }; break;
        }
      });

      const c = trk.codec || {};
      if (c.type === 'avc1' || c.type === 'avc3') trk.codecName = 'avc1';
      else if (c.type === 'hvc1' || c.type === 'hev1') trk.codecName = 'hevc';
      else if (c.type === 'vp09') trk.codecName = 'vp9';
      else if (c.type === 'av01') trk.codecName = 'av1';
      else if (c.type === 'mp4a') trk.codecName = (c.esds && c.esds.objectType === 0xA9) ? 'ac-3' : 'aac';
      else if (c.type === 'Opus' || c.type === 'opus') trk.codecName = 'opus';
      else if (c.type === 'fLaC' || c.type === 'flac') trk.codecName = 'flac';
      else trk.codecName = c.type || 'unknown';
      return trk;
    }

    /* ---- progressive stbl expansion ---- */
    function parseStbl(trk) {
      if (!trk.stblRange) return;
      const s = trk.stblRange.s, e = trk.stblRange.e;
      let stts = null, ctts = null, cttsVer = 0, stsc = null, stsz = null, stco = null, stss = null;
      walkBoxes(u8, s, e, (type, ds, de) => {
        const r = new U.Reader(u8); r.seek(ds);
        switch (type) {
          case 'stts': {
            r.skip(4); const n = r.u32(); const out = [];
            for (let i = 0; i < n && r.left >= 8; i++) out.push({ count: r.u32(), delta: r.u32() });
            stts = out; break;
          }
          case 'ctts': {
            cttsVer = r.u8v(); r.skip(3); const n = r.u32(); const out = [];
            for (let i = 0; i < n && r.left >= 8; i++) out.push({ count: r.u32(), offset: cttsVer === 1 ? r.i32() : r.u32() });
            ctts = out; break;
          }
          case 'stsc': {
            r.skip(4); const n = r.u32(); const out = [];
            for (let i = 0; i < n && r.left >= 12; i++) out.push({ first: r.u32(), per: r.u32(), desc: r.u32() });
            stsc = out; break;
          }
          case 'stsz': case 'stz2': {
            r.skip(4);
            const uniform = r.u32(); const n = r.u32();
            if (uniform) stsz = { uniform, count: n };
            else { const arr = []; for (let i = 0; i < n && r.left >= 4; i++) arr.push(r.u32()); stsz = { arr }; }
            break;
          }
          case 'stco': {
            r.skip(4); const n = r.u32(); const out = [];
            for (let i = 0; i < n && r.left >= 4; i++) out.push(r.u32());
            stco = out; break;
          }
          case 'co64': {
            r.skip(4); const n = r.u32(); const out = [];
            for (let i = 0; i < n && r.left >= 8; i++) out.push(r.u64());
            stco = out; break;
          }
          case 'stss': {
            r.skip(4); const n = r.u32(); const set = new Set();
            for (let i = 0; i < n && r.left >= 4; i++) set.add(r.u32());
            stss = set; break;
          }
        }
      });
      if (!stsz || !stco || !stsc) return;

      const durations = [];
      if (stts) for (const run of stts) for (let i = 0; i < run.count; i++) durations.push(run.delta);
      const ctsOffsets = [];
      if (ctts) for (const run of ctts) for (let i = 0; i < run.count; i++) ctsOffsets.push(run.offset);

      const total = stsz.uniform ? stsz.count : stsz.arr.length;
      let si = 0;
      for (let ci = 0; ci < stco.length && si < total; ci++) {
        let per = 0;
        for (const ent of stsc) { if (ent.first <= ci + 1) per = ent.per; else break; }
        let off = stco[ci];
        for (let j = 0; j < per && si < total; j++, si++) {
          const size = stsz.uniform ? stsz.uniform : stsz.arr[si];
          trk.samples.push({
            offset: off, size,
            duration: durations[si] != null ? durations[si] : 0,
            ctsOffset: ctsOffsets[si] || 0,
            key: stss ? stss.has(si + 1) : true,
          });
          off += size;
        }
      }
      trk.progressive = true;
    }

    /* ---- fragmented moof/mdat expansion ---- */
    function parseFragments() {
      const byId = new Map();
      for (const t of tracks) if (t.trackId) byId.set(t.trackId, t);

      let o = 0;
      while (o + 8 <= end) {
        const b = boxHeaderAt(u8, o, end);
        if (!b) break;
        if (b.type === 'moof') parseMoof(u8, b.payload, b.end, o);
        o += b.size;
      }

      function parseMoof(u8, s, e, moofOffset) {
        let oo = s;
        while (oo + 8 <= e) {
          const tb = boxHeaderAt(u8, oo, e);
          if (!tb) break;
          if (tb.type === 'traf') parseTraf(u8, tb.payload, tb.end, moofOffset);
          oo += tb.size;
        }
      }

      function parseTraf(u8, s, e, moofOffset) {
        let tfhd = null, tfdt = 0; const truns = [];
        let o = s;
        while (o + 8 <= e) {
          const b = boxHeaderAt(u8, o, e);
          if (!b) break;
          const r = new U.Reader(u8); r.seek(b.payload);
          if (b.type === 'tfhd') {
            r.skip(1); const flags = r.u24();
            const trackId = r.u32();
            const f = { trackId, flags };
            if (flags & 0x000001) f.baseDataOffset = r.u64();
            if (flags & 0x000002) f.sampleDescriptionIndex = r.u32();
            if (flags & 0x000008) f.defaultSampleDuration = r.u32();
            if (flags & 0x000010) f.defaultSampleSize = r.u32();
            if (flags & 0x000020) f.defaultSampleFlags = r.u32();
            tfhd = f;
          } else if (b.type === 'tfdt') {
            const ver = r.u8v(); r.skip(3);
            tfdt = ver === 1 ? r.u64() : r.u32();
          } else if (b.type === 'trun') {
            const ver = r.u8v(); const flags = r.u24();
            const n = r.u32();
            const t = { ver, flags, samples: [] };
            if (flags & 0x000001) t.dataOffset = r.i32();
            if (flags & 0x000004) t.firstSampleFlags = r.u32();
            for (let i = 0; i < n && r.left > 0; i++) {
              const sp = {};
              if (flags & 0x000100) sp.duration = r.u32();
              if (flags & 0x000200) sp.size = r.u32();
              if (flags & 0x000400) sp.flags = r.u32();
              if (flags & 0x000800) sp.ctsOffset = ver === 1 ? r.i32() : r.u32();
              t.samples.push(sp);
            }
            truns.push(t);
          }
          o += b.size;
        }
        if (!tfhd) return;
        const trk = byId.get(tfhd.trackId);
        if (!trk) return;
        trk.fragmented = true;

        let base;
        if (tfhd.flags & 0x000001) base = tfhd.baseDataOffset;
        else base = moofOffset;                  // default-base-is-moof (or safe fallback)

        let decodeTime = tfdt;
        let cursor = base;
        for (const trun of truns) {
          let off = trun.dataOffset != null ? base + trun.dataOffset : cursor;
          for (let i = 0; i < trun.samples.length; i++) {
            const sp = trun.samples[i];
            const dur = sp.duration != null ? sp.duration : (tfhd.defaultSampleDuration || 0);
            const size = sp.size != null ? sp.size : (tfhd.defaultSampleSize || 0);
            let flags = sp.flags;
            if (flags == null) flags = (i === 0 && trun.firstSampleFlags != null) ? trun.firstSampleFlags : (tfhd.defaultSampleFlags || 0);
            trk.samples.push({
              offset: off, size, duration: dur,
              ctsOffset: sp.ctsOffset || 0,
              key: !((flags >>> 16) & 0x1),      // sample_is_non_sync_sample
              dts: decodeTime,
            });
            off += size;
            decodeTime += dur;
          }
          cursor = off;
        }
      }
    }

    for (const t of tracks) if (!t.fragmented) parseStbl(t);
    if (tracks.some(t => t.fragmented)) parseFragments();

    /* ---- normalise timestamps ---- */
    for (const t of tracks) {
      if (!t.samples.length) continue;
      let dts = 0;
      for (const s of t.samples) {
        if (s.dts != null) dts = s.dts;
        s.dts = dts;
        s.cts = dts + (s.ctsOffset || 0);
        dts += s.duration;
      }
      let minCts = Infinity;
      for (const s of t.samples) if (s.cts < minCts) minCts = s.cts;
      if (!isFinite(minCts)) minCts = 0;
      t.ctsShift = -minCts;
      for (const s of t.samples) { s.cts += t.ctsShift; s.dts += t.ctsShift; }

      const last = t.samples[t.samples.length - 1];
      t.duration = (last.dts + last.duration) / t.timescale;
      t.byteSize = t.samples.reduce((a, s) => a + s.size, 0);
      if (t.type === 'audio' && t.editMediaTime > 0) t.encoderDelay = t.editMediaTime;
    }

    return {
      tracks: tracks.filter(t => t.codec || t.samples.length),
      allTracks: tracks,
      inputSize: end,
    };
  }

  U.MP4Demux = MP4Demux;
  U.mp4WalkBoxes = walkBoxes;
  U.mp4FindBox = findBox;
})(typeof globalThis !== 'undefined' ? globalThis : this);


/* =========================================================================
 * 11-webm-demux.js - Matroska/WebM (EBML) demuxer with an incremental API.
 *
 *   const d = new YTDU.WebmDemux();
 *   d.push(chunk);            // feed bytes as they download
 *   d.header                  // null until Tracks have been seen
 *   d.header.tracks           // [{number,uid,type,codecId,codecPrivate,...}]
 *   d.drainSamples(cb)        // cb(sample) for every complete block so far
 *   d.finish()                // flush anything left
 *
 * sample = { track, key, timecode(ms), duration(ms|null), data:Uint8Array }
 * `data` is the block payload AFTER the track-number vint, i.e. exactly the
 * frame bytes - which is what both the MP4 and WebM muxers want.
 *
 * Internally all parsed chunks are coalesced into one buffer and parsing
 * resumes at a monotone offset, so re-parsing after more pushes never
 * duplicates samples.
 * ========================================================================= */
(function (root) {
  'use strict';
  const U = root.YTDU;

  /* Element IDs we care about */
  const ID = {
    EBML: 0x1A45DFA3, Segment: 0x18538067, SeekHead: 0x114D9B74,
    Info: 0x1549A966, TimecodeScale: 0x2AD7B1, Duration: 0x4489,
    Tracks: 0x1654AE6B, TrackEntry: 0xAE, TrackNumber: 0xD7, TrackUID: 0x73C5,
    TrackType: 0x83, FlagLacing: 0x9C, CodecID: 0x86,
    CodecPrivate: 0x63A2, DefaultDuration: 0x23E383,
    Video: 0xE0, PixelWidth: 0xB0, PixelHeight: 0xBA,
    Audio: 0xE1, SamplingFrequency: 0xB5, Channels: 0x9F,
    Cluster: 0x1F43B675, ClusterTimecode: 0xE7, SimpleBlock: 0xA3,
    BlockGroup: 0xA0, Block: 0xA1, BlockDuration: 0x9B, BlockReference: 0xFB,
    Cues: 0x1C53BB6B, Void: 0xEC,
  };

  function readVint(u8, o, end, keepMarker) {
    if (o >= end) return null;
    const first = u8[o];
    if (first === 0) return null;
    let len = 1, mask = 0x80;
    while (!(first & mask)) { mask >>= 1; len++; if (len > 8) return null; }
    if (o + len > end) return { incomplete: true };
    let val = keepMarker ? first : (first & (mask - 1));
    // unknown-size = EVERY data bit is 1 (all-ones value). Checking only the
    // trailing bytes wrongly flags short elements (e.g. a 1-byte 0x8f size)
    // as unknown, which aborts Segment parsing.
    let allOnes = (first & (mask - 1)) === (mask - 1);
    for (let i = 1; i < len; i++) {
      val = val * 256 + u8[o + i];
      if (u8[o + i] !== 0xff) allOnes = false;
    }
    return { value: val, length: len, unknown: !keepMarker && allOnes };
  }
  function readId(u8, o, end) { return readVint(u8, o, end, true); }

  /* Read one element header at `o`. Returns null when more bytes are needed. */
  function readElement(u8, o, end) {
    const idv = readId(u8, o, end);
    if (!idv) return null;
    if (idv.incomplete) return null;
    const szv = readVint(u8, o + idv.length, end, false);
    if (!szv || szv.incomplete) return null;
    return { id: idv.value, hdrLen: idv.length + szv.length, size: szv.value, unknownSize: szv.unknown };
  }

  class WebmDemux {
    constructor() {
      this.chunks = [];
      this.len = 0;
      this.u8 = null;             // coalesced buffer (this.chunks[0])
      this.header = null;
      this.samples = [];
      this.timecodeScale = 1000000;
      this.clusterTimecode = 0;
      this.error = null;
      this.bytesFed = 0;
      this.clustersSeen = 0;
      // resume offsets (absolute into u8)
      this.segOff = -1;           // next Segment-child to process (-1 = not in segment yet)
      this._eof = false;
    }

    push(chunk) {
      if (!chunk || !chunk.length) return;
      this.chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
      this.len += chunk.length;
      this.bytesFed += chunk.length;
      this._coalesce();
      this._parse();
    }

    finish() { this._eof = true; this._parse(); }

    _coalesce() {
      if (this.chunks.length === 1) { this.u8 = this.chunks[0]; return; }
      const merged = new Uint8Array(this.len);
      let o = 0;
      for (const c of this.chunks) { merged.set(c, o); o += c.length; }
      this.chunks = [merged];
      this.u8 = merged;
    }

    drainSamples(cb) { for (const s of this.samples) cb(s); this.samples.length = 0; }

    _parse() {
      if (this.error || !this.u8) return;
      try { this._walk(); }
      catch (e) { this.error = e; }
    }

    /* Top level: EBML header, then a (possibly unknown-size) Segment. */
    _walk() {
      const u8 = this.u8, end = u8.length;
      let o = 0;
      while (o + 1 < end) {
        const el = readElement(u8, o, end);
        if (!el) return;                                  // need more bytes
        const body = o + el.hdrLen;
        if (el.id === ID.EBML) {
          if (body + el.size > end) return;
          o = body + el.size;
        } else if (el.id === ID.Segment) {
          if (this.segOff < 0) this.segOff = body;
          this._walkSegment(this.segOff, el.unknownSize ? end : Math.min(body + el.size, end));
          if (el.unknownSize) return;                     // segment grows with the stream
          o = body + el.size;
        } else {
          if (el.unknownSize) return;
          if (body + el.size > end) return;
          o = body + el.size;
        }
      }
    }

    _walkSegment(start, end) {
      const u8 = this.u8;
      let o = start;
      while (o + 1 < end) {
        const el = readElement(u8, o, end);
        if (!el) break;                                   // incomplete header
        const body = o + el.hdrLen, bodyEnd = body + el.size;
        if (el.unknownSize && el.id === ID.Cluster) {
          // unknown-size cluster: parse blocks until buffer ends, resume later
          this._cluster(body, end);
          this.segOff = body;
          return;
        }
        if (el.unknownSize || bodyEnd > end) break;       // wait for full element
        if (el.id === ID.Info) this._info(body, bodyEnd);
        else if (el.id === ID.Tracks) this._tracks(body, bodyEnd);
        else if (el.id === ID.Cluster) this._cluster(body, bodyEnd);
        o = bodyEnd;
        this.segOff = o;
      }
    }

    /* ---- scalar readers over this.u8 ---- */
    _uint(s, e) { let x = 0; for (let i = s; i < e && i < this.u8.length; i++) x = x * 256 + this.u8[i]; return x; }
    _float(s, e) {
      const n = e - s;
      if (n === 4 || n === 8) {
        const dv = new DataView(this.u8.buffer, this.u8.byteOffset + s, n);
        return n === 4 ? dv.getFloat32(0, false) : dv.getFloat64(0, false);
      }
      return this._uint(s, e);
    }

    _info(s, e) {
      let o = s;
      while (o + 1 < e) {
        const el = readElement(this.u8, o, e); if (!el || el.unknownSize) break;
        const body = o + el.hdrLen, bodyEnd = body + el.size;
        if (bodyEnd > e) break;
        if (el.id === ID.TimecodeScale) this.timecodeScale = this._uint(body, bodyEnd) || 1000000;
        o = bodyEnd;
      }
    }

    _tracks(s, e) {
      const tracks = [];
      let o = s;
      while (o + 1 < e) {
        const el = readElement(this.u8, o, e); if (!el || el.unknownSize) break;
        const body = o + el.hdrLen, bodyEnd = body + el.size;
        if (bodyEnd > e) break;
        if (el.id === ID.TrackEntry) {
          const t = this._trackEntry(body, bodyEnd);
          if (t) tracks.push(t);
        }
        o = bodyEnd;
      }
      if (tracks.length && !this.header) this.header = { tracks };
    }

    _trackEntry(s, e) {
      const t = { type: 0, number: 0, uid: 0, codecId: '', flagLacing: 1, defaultDurationNs: null };
      let o = s;
      while (o + 1 < e) {
        const el = readElement(this.u8, o, e); if (!el || el.unknownSize) break;
        const body = o + el.hdrLen, bodyEnd = body + el.size;
        if (bodyEnd > e) break;
        switch (el.id) {
          case ID.TrackNumber: t.number = this._uint(body, bodyEnd); break;
          case ID.TrackUID: t.uid = this._uint(body, bodyEnd); break;
          case ID.TrackType: t.type = this._uint(body, bodyEnd); break;
          case ID.FlagLacing: t.flagLacing = this._uint(body, bodyEnd); break;
          case ID.CodecID: t.codecId = new TextDecoder().decode(this.u8.subarray(body, bodyEnd)); break;
          case ID.CodecPrivate: t.codecPrivate = this.u8.slice(body, bodyEnd); break;
          case ID.DefaultDuration: t.defaultDurationNs = this._uint(body, bodyEnd); break;
          case ID.Video: this._video(body, bodyEnd, t); break;
          case ID.Audio: this._audio(body, bodyEnd, t); break;
        }
        o = bodyEnd;
      }
      return t.number ? t : null;
    }

    _video(s, e, t) {
      t.video = { width: 0, height: 0 };
      let o = s;
      while (o + 1 < e) {
        const el = readElement(this.u8, o, e); if (!el || el.unknownSize) break;
        const body = o + el.hdrLen, bodyEnd = body + el.size;
        if (bodyEnd > e) break;
        if (el.id === ID.PixelWidth) t.video.width = this._uint(body, bodyEnd);
        else if (el.id === ID.PixelHeight) t.video.height = this._uint(body, bodyEnd);
        o = bodyEnd;
      }
    }

    _audio(s, e, t) {
      t.audio = { channels: 1, sampleRate: 48000 };
      let o = s;
      while (o + 1 < e) {
        const el = readElement(this.u8, o, e); if (!el || el.unknownSize) break;
        const body = o + el.hdrLen, bodyEnd = body + el.size;
        if (bodyEnd > e) break;
        if (el.id === ID.Channels) t.audio.channels = this._uint(body, bodyEnd);
        else if (el.id === ID.SamplingFrequency) t.audio.sampleRate = this._float(body, bodyEnd) || 48000;
        o = bodyEnd;
      }
    }

    /* ---- clusters / blocks ---- */
    _cluster(s, e) {
      this.clustersSeen++;
      const u8 = this.u8;
      let o = s;
      while (o + 1 < e) {
        const el = readElement(u8, o, e); if (!el) break;
        const body = o + el.hdrLen, bodyEnd = body + el.size;
        if (el.unknownSize || bodyEnd > e) break;
        if (el.id === ID.ClusterTimecode) this.clusterTimecode = this._uint(body, bodyEnd);
        else if (el.id === ID.SimpleBlock) this._block(body, bodyEnd, null, false);
        else if (el.id === ID.BlockGroup) this._blockGroup(body, bodyEnd);
        o = bodyEnd;
        this.segOff = o;
      }
    }

    _blockGroup(s, e) {
      let block = null, duration = null, referenced = false;
      let o = s;
      while (o + 1 < e) {
        const el = readElement(this.u8, o, e); if (!el || el.unknownSize) break;
        const body = o + el.hdrLen, bodyEnd = body + el.size;
        if (bodyEnd > e) break;
        if (el.id === ID.Block) block = [body, bodyEnd];
        else if (el.id === ID.BlockDuration) duration = this._uint(body, bodyEnd);
        else if (el.id === ID.BlockReference) referenced = true;
        o = bodyEnd;
      }
      if (block) this._block(block[0], block[1], duration, referenced);
    }

    _block(s, e, blockDuration, referenced) {
      const v = this.u8;
      const tv = readVint(v, s, e, false);
      if (!tv || tv.incomplete) return;
      let o = s + tv.length;
      if (o + 3 > e) return;
      const track = tv.value;
      const rel = (v[o] << 8) | v[o + 1]; o += 2;
      const flags = v[o]; o += 1;
      const key = !(flags & 0x01) && !referenced;   // bit0 clear = keyframe
      const laced = (flags >> 1) & 0x03;
      const body = v.subarray(o, e);
      const frames = laced === 0 ? [body] : this._unlace(body, laced);
      const timecode = this.clusterTimecode + ((rel << 16) >> 16);   // sign-extend int16
      const defMs = this._trackDefaultMs(track);
      for (const f of frames) {
        this.samples.push({
          track, key, timecode,
          duration: blockDuration != null ? blockDuration : defMs,
          data: f,
        });
      }
    }

    _trackDefaultMs(trackNumber) {
      if (!this.header) return null;
      const t = this.header.tracks.find(t => t.number === trackNumber);
      return t && t.defaultDurationNs != null ? t.defaultDurationNs / 1e6 : null;
    }

    _unlace(body, mode) {
      const out = [];
      try {
        if (mode === 2) {                      // fixed-size lacing
          const n = body[0];
          const sz = Math.floor((body.length - 1) / n);
          for (let i = 0; i < n; i++) out.push(body.subarray(1 + i * sz, 1 + (i + 1) * sz));
          out.push(body.subarray(1 + n * sz));
        } else if (mode === 1) {               // Xiph lacing
          let o = 1; const sizes = [];
          const n = body[0];
          for (let i = 0; i < n; i++) {
            let sz = 0, b;
            do { b = body[o++]; sz += b; } while (b === 255);
            sizes.push(sz);
          }
          for (const sz of sizes) { out.push(body.subarray(o, o + sz)); o += sz; }
          out.push(body.subarray(o));
        } else {                               // EBML lacing
          let o = 1;
          const n = body[0];
          const szs = [];
          let prev = 0;
          for (let i = 0; i < n - 1; i++) {
            const vv = U.ebmlVint(body, o, false);
            if (!vv) return [body];
            const val = i === 0 ? vv.value : prev + vv.value - (1 << (6 * vv.length)) / 2;
            prev = val; szs.push(val); o += vv.length;
          }
          for (const sz of szs) { out.push(body.subarray(o, o + sz)); o += sz; }
          out.push(body.subarray(o));
        }
      } catch (err) { return [body]; }
      return out.length ? out.filter(f => f.length) : [body];
    }
  }

  U.WebmDemux = WebmDemux;
})(typeof globalThis !== 'undefined' ? globalThis : this);


/* =========================================================================
 * 20-mp4-mux.js - progressive MP4 muxer (video + audio).
 * Consumes tracks in the shape produced by YTDU.MP4Demux, with each sample's
 * bytes materialised as `data: Uint8Array` (AVCC / raw AAC frames - i.e. the
 * exact bytes found in the source mdat, which for YouTube MP4s are already
 * length-prefixed NAL units and raw AAC access units).
 *
 *   YTDU.MP4Mux({ tracks: [ { type:'video', timescale, codec, samples }, ... ] })
 *     -> Uint8Array of a self-contained progressive MP4
 * ========================================================================= */
(function (root) {
  'use strict';
  const U = root.YTDU;

  function MP4Mux(opts) {
    const tracks = opts.tracks.filter(t => t.samples && t.samples.length);
    if (!tracks.length) throw new Error('MP4 mux: no tracks');
    for (const t of tracks) if (!t.codec) throw new Error('MP4 mux: track missing codec info');

    /* ---- per-track tables ---- */
    const prepared = tracks.map(t => {
      const samples = t.samples;
      const durations = samples.map(s => s.duration | 0);
      const ctsOffsets = samples.map(s => (s.ctsOffset || 0) | 0);
      // stts run-length
      const stts = [];
      for (let i = 0; i < durations.length; i++) {
        const last = stts[stts.length - 1];
        if (last && last.delta === durations[i]) last.count++;
        else stts.push({ count: 1, delta: durations[i] });
      }
      // ctts (only if any nonzero)
      const hasCts = ctsOffsets.some(v => v !== 0);
      const ctts = [];
      if (hasCts) for (let i = 0; i < ctsOffsets.length; i++) {
        const last = ctts[ctts.length - 1];
        if (last && last.offset === ctsOffsets[i]) last.count++;
        else ctts.push({ count: 1, offset: ctsOffsets[i] });
      }
      const keyframes = [];
      samples.forEach((s, i) => { if (s.key) keyframes.push(i + 1); });
      const totalDuration = durations.reduce((a, b) => a + b, 0);
      return { t, samples, stts, ctts: hasCts ? ctts : null, keyframes, totalDuration };
    });

    /* ---- sample entries (bytes after the 8-byte sample-entry box header) ---- */
    function makeStsd(t) {
      const c = t.codec;
      if (t.type === 'video') {
        // VisualSampleEntry fixed part = 78 bytes
        const b = new Uint8Array(78);
        const dv = new DataView(b.buffer);
        dv.setUint16(6, 1);                            // dataReferenceIndex
        dv.setUint16(24, c.width || 1280);
        dv.setUint16(26, c.height || 720);
        dv.setUint32(28, 0x00480000);                  // horizresolution 72dpi
        dv.setUint32(32, 0x00480000);                  // vertresolution
        dv.setUint16(40, 1);                           // frame count
        dv.setUint16(74, 0x0018);                      // depth
        dv.setUint16(76, 0xffff);                      // pre_defined = -1
        const children = [];
        if (c.codecBox) children.push(U.mp4Box(c.codecBoxType || 'avcC', c.codecBox));
        return U.mp4Box(c.type || 'avc1', b, children);
      } else {
        const sr = (c.sampleRate || 44100) * 65536 | 0;
        const ch = c.channels || 2;
        const fixed = new Uint8Array(6 + 2 + 8 + 2 + 2 + 2 + 2 + 4);
        const dv = new DataView(fixed.buffer);
        let o = 6;
        dv.setUint16(o, 1); o += 2;                    // dataReferenceIndex
        o += 8;                                        // reserved
        dv.setUint16(o, ch); o += 2;                   // channels
        dv.setUint16(o, 16); o += 2;                   // sampleSize
        dv.setUint16(o, 0); o += 2;                    // pre_defined
        dv.setUint16(o, 0); o += 2;                    // reserved
        dv.setUint32(o, sr); o += 4;                   // 16.16 rate
        const children = [];
        if (c.esdsRaw) children.push(U.mp4Box('esds', c.esdsRaw));
        else if (c.esds && c.esds.raw) children.push(U.mp4Box('esds', c.esds.raw));
        // esds.raw already includes its 4-byte version/flags - plain box, not full box
        return U.mp4Box(c.type || 'mp4a', fixed, children);
      }
    }

    /* ---- moov builder with a patchable mdat offset ---- */
    function buildMoov(mdatDataOffset) {
      const nextTrackId = { id: 1 };
      const traks = prepared.map(p => buildTrak(p, mdatDataOffset, nextTrackId));
      const maxMs = Math.max(...prepared.map(p => Math.round(p.totalDuration / p.t.timescale * 1000)));
      const mvhd = U.mp4FullBox('mvhd', 0, 0,
        U.be32(0), U.be32(0), U.be32(1000), U.be32(maxMs),
        new Uint8Array([0, 1, 0, 0]),               // rate 1.0 (16.16)
        new Uint8Array([0x01, 0x00]),               // volume 1.0
        new Uint8Array(10),                         // reserved
        unityMatrix(), new Uint8Array(24),          // matrix + pre_defined
        new Uint8Array(24),                         // reserved (6 x 32)
        U.be32(nextTrackId.id + 1));
      return U.mp4Box('moov', mvhd, traks);
    }

    function unityMatrix() {
      const b = new Uint8Array(36); const dv = new DataView(b.buffer);
      dv.setUint32(0, 0x00010000); dv.setUint32(12, 0x00010000); dv.setUint32(24, 0x40000000);
      return b;
    }

    function buildTrak(p, mdatDataOffset, nextTrackId) {
      const t = p.t, id = nextTrackId.id++;
      const vol = t.type === 'audio' ? 0x0100 : 0;
      const w = Math.round((t.codec.width || 1280) * 65536);
      const h = Math.round((t.codec.height || 720) * 65536);
      const tkhd = U.mp4FullBox('tkhd', 0, 7,
        U.be32(0), U.be32(0), U.be32(id), U.be32(0), U.be32(0),
        new Uint8Array(8), U.be16(0), U.be16(0), U.be16(vol),
        unityMatrix(), U.be32(w), U.be32(h));

      const mdhd = U.mp4FullBox('mdhd', 0, 0,
        U.be32(0), U.be32(0), U.be32(t.timescale), U.be32(p.totalDuration),
        U.be16(0x55C4), U.be16(0));                 // language 'und'

      const hdlrType = t.type === 'video' ? 'vide' : 'soun';
      const hdlr = U.mp4FullBox('hdlr', 0, 0, U.be32(0), hdlrType,
        new Uint8Array(12), [0]);

      const mediaHeader = t.type === 'video'
        ? U.mp4FullBox('vmhd', 0, 1, U.be16(0), U.be16(0), U.be16(0), U.be16(0))
        : U.mp4FullBox('smhd', 0, 0, U.be16(0), U.be16(0));

      const dinf = U.mp4Box('dinf', U.mp4FullBox('dref', 0, 0, U.be32(1),
        U.mp4FullBox('url ', 0, 1)));

      const stsd = U.mp4FullBox('stsd', 0, 0, U.be32(1), makeStsd(t));

      // stts
      const sttsParts = [U.be32(p.stts.length)];
      for (const r of p.stts) sttsParts.push(U.be32(r.count), U.be32(r.delta));
      const stts = U.mp4FullBox('stts', 0, 0, sttsParts);

      // ctts (version 1 = signed offsets)
      let ctts = null;
      if (p.ctts) {
        const parts = [U.be32(p.ctts.length)];
        for (const r of p.ctts) parts.push(U.be32(r.count), r.offset < 0
          ? U.be32(r.offset >>> 0) : U.be32(r.offset));
        ctts = U.mp4FullBox('ctts', 1, 0, parts);
      }

      // stsc: single chunk per track
      const stsc = U.mp4FullBox('stsc', 0, 0, U.be32(1), U.be32(1), U.be32(p.samples.length), U.be32(1));

      // stsz
      const szArr = [U.be32(0), U.be32(p.samples.length)];
      for (const s of p.samples) szArr.push(U.be32(s.data.length));
      const stsz = U.mp4FullBox('stsz', 0, 0, szArr);

      // stco (single 32-bit offset per track, patched per pass)
      const stco = U.mp4FullBox('stco', 0, 0, U.be32(1), U.be32(mdatDataOffset + p.chunkRelOffset));

      const stblChildren = [stsd, stts];
      if (ctts) stblChildren.push(ctts);
      stblChildren.push(stsc, stsz, stco);
      if (p.keyframes.length && p.keyframes.length < p.samples.length) {
        const ssParts = [U.be32(p.keyframes.length)];
        for (const k of p.keyframes) ssParts.push(U.be32(k));
        stblChildren.push(U.mp4FullBox('stss', 0, 0, ssParts));
      }
      const stbl = U.mp4Box('stbl', stblChildren);
      const minf = U.mp4Box('minf', mediaHeader, dinf, stbl);
      const mdia = U.mp4Box('mdia', mdhd, hdlr, minf);
      return U.mp4Box('trak', tkhd, mdia);
    }

    /* ---- mdat layout: one chunk per track, tracks in order ---- */
    let off = 0;
    for (const p of prepared) { p.chunkRelOffset = off; off += p.samples.reduce((a, s) => a + s.data.length, 0); }
    const mdatPayloadSize = off;

    const ftyp = U.mp4Box('ftyp', 'isom', U.be32(512), 'isom', 'iso2', 'avc1', 'mp41');

    /* two-pass: moov size doesn't depend on the stco value, so measure then patch.
     * mp4Size() adds 8 for a box header, but moov/ftyp already carry their own
     * 8-byte header in parts[0] - subtract it back. */
    let moov = buildMoov(0);
    const moovSize = U.mp4Size(moov) - 8;
    const ftypSize = U.mp4Size(ftyp) - 8;
    const mdatDataOffset = ftypSize + moovSize + 8;    // + mdat box header
    moov = buildMoov(mdatDataOffset);

    const mdatHdr = new Uint8Array(8);
    new DataView(mdatHdr.buffer).setUint32(0, 8 + mdatPayloadSize, false);
    mdatHdr.set([0x6d, 0x64, 0x61, 0x74], 4);          // 'mdat'

    const sink = new U.ByteSink();
    U.mp4Append(sink, ftyp);
    U.mp4Append(sink, moov);
    sink.push(mdatHdr);
    for (const p of prepared) for (const s of p.samples) sink.push(s.data);
    return sink.concat();
  }

  root.YTDU.MP4Mux = MP4Mux;
})(typeof globalThis !== 'undefined' ? globalThis : this);


/* =========================================================================
 * 21-webm-mux.js - WebM (Matroska) muxer for VP8/VP9/AV1 video + Opus/Vorbis
 * audio. Takes tracks in the shape produced by YTDU.WebmDemux / MP4Demux with
 * sample bytes materialised as `data`.
 *
 *   YTDU.WebmMux({
 *     durationMs,
 *     tracks: [{ type:'video'|'audio', codecId:'V_VP-9', codecPrivate?,
 *                width?, height?, channels?, sampleRate?, defaultDurationMs?,
 *                samples:[{data, key, timecode(ms), duration(ms|null)}] }]
 *   }) -> Uint8Array
 * ========================================================================= */
(function (root) {
  'use strict';
  const U = root.YTDU;
  const E = {
    EBML: 0x1A45DFA3, EBMLVersion: 0x4286, EBMLReadVersion: 0x42F7,
    EBMLMaxIDLength: 0x42F2, EBMLMaxSizeLength: 0x42F3, DocType: 0x4282,
    DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285,
    Segment: 0x18538067, SeekHead: 0x114D9B74, Seek: 0x4DBB, SeekID: 0x53AB, SeekPosition: 0x53AC,
    Info: 0x1549A966, TimecodeScale: 0x2AD7B1, Duration: 0x4489,
    MuxingApp: 0x4D80, WritingApp: 0x5741,
    Tracks: 0x1654AE6B, TrackEntry: 0xAE, TrackNumber: 0xD7, TrackUID: 0x73C5,
    TrackType: 0x83, FlagLacing: 0x9C, CodecID: 0x86, CodecPrivate: 0x63A2,
    DefaultDuration: 0x23E383,
    Video: 0xE0, PixelWidth: 0xB0, PixelHeight: 0xBA,
    Audio: 0xE1, SamplingFrequency: 0xB5, Channels: 0x9F,
    Cluster: 0x1F43B675, ClusterTimecode: 0xE7, SimpleBlock: 0xA3,
  };

  function blockFlags(sample) {
    // bit 0 = keyframe (SimpleBlock: 1<<0 set means keyframe); lacing = 00
    return sample.key ? 0x80 : 0x00;
  }

  function trackVint(n) { return new Uint8Array([0x80 | n]); }

  function WebmMux(opts) {
    const tracks = (opts.tracks || []).filter(t => t.samples && t.samples.length);
    if (!tracks.length) throw new Error('WebM mux: no tracks');
    const durationMs = opts.durationMs || Math.max(...tracks.map(t => {
      const last = t.samples[t.samples.length - 1];
      return last.timecode + (last.duration || 0);
    }));

    /* ---- EBML header ---- */
    const header = U.ebmlMaster(E.EBML,
      U.ebmlUint(E.EBMLVersion, 1), U.ebmlUint(E.EBMLReadVersion, 1),
      U.ebmlUint(E.EBMLMaxIDLength, 4), U.ebmlUint(E.EBMLMaxSizeLength, 8),
      U.ebmlStr(E.DocType, 'webm'), U.ebmlUint(E.DocTypeVersion, 4),
      U.ebmlUint(E.DocTypeReadVersion, 2));

    /* ---- Info ---- */
    const info = U.ebmlMaster(E.Info,
      U.ebmlUint(E.TimecodeScale, 1000000),            // 1 ms
      U.ebmlFloat(E.Duration, durationMs),
      U.ebmlStr(E.MuxingApp, 'yt-media-downloader'),
      U.ebmlStr(E.WritingApp, 'yt-media-downloader'));

    /* ---- Tracks ---- */
    const trackEntries = tracks.map((t, i) => {
      const isVideo = t.type === 'video';
      const kids = [
        U.ebmlUint(E.TrackNumber, i + 1),
        U.ebmlUint(E.TrackUID, i + 1),
        U.ebmlUint(E.TrackType, isVideo ? 1 : 2),
        U.ebmlUint(E.FlagLacing, 0),
        U.ebmlStr(E.CodecID, t.codecId),
      ];
      if (t.defaultDurationMs) kids.push(U.ebmlUint(E.DefaultDuration, Math.round(t.defaultDurationMs * 1000000)));
      if (t.codecPrivate) kids.push(U.ebmlRaw(E.CodecPrivate, t.codecPrivate));
      if (isVideo) {
        kids.push(U.ebmlMaster(E.Video,
          U.ebmlUint(E.PixelWidth, t.width || 1280),
          U.ebmlUint(E.PixelHeight, t.height || 720)));
      } else {
        kids.push(U.ebmlMaster(E.Audio,
          U.ebmlFloat(E.SamplingFrequency, t.sampleRate || 48000),
          U.ebmlUint(E.Channels, t.channels || 2)));
      }
      return U.ebmlMaster(E.TrackEntry, kids);
    });
    const tracksEl = U.ebmlMaster(E.Tracks, trackEntries);

    /* ---- Clusters: merge all tracks into a single interleaved timeline,
     *       cut a new cluster on a video keyframe or when > 5 s elapsed ---- */
    const CLUSTER_MS = 5000;
    const streams = tracks.map(t => ({ t, i: 0 }));
    const clusters = [];
    let cur = null, curBase = 0;
    for (;;) {
      let best = -1, bestTc = Infinity;
      for (let s = 0; s < streams.length; s++) {
        if (streams[s].i < streams[s].t.samples.length) {
          const tc = streams[s].t.samples[streams[s].i].timecode;
          if (tc < bestTc) { bestTc = tc; best = s; }
        }
      }
      if (best < 0) break;
      const s = streams[best];
      const sample = s.t.samples[s.i++];
      if (!cur || (sample.key && s.t.type === 'video' && sample.timecode - curBase >= CLUSTER_MS)) {
        cur = { base: sample.timecode, blocks: [] };
        clusters.push(cur);
        curBase = sample.timecode;
      }
      if (sample.timecode < curBase) curBase = sample.timecode;  // keep monotone
      cur.blocks.push({ track: best, sample });
    }

    const firstBase = clusters.length ? clusters[0].base : 0;
    const clusterEls = clusters.map(cl => {
      const kids = [U.ebmlUint(E.ClusterTimecode, cl.base - firstBase)];
      // relative timecodes must fit int16
      for (const { track, sample } of cl.blocks) {
        let rel = sample.timecode - cl.base;
        if (rel < 0 || rel > 32767) rel = 0;
        const data = sample.data;
        const block = new Uint8Array(1 + 2 + 1 + data.length);
        block[0] = 0x80 | (track + 1);                 // track vint
        new DataView(block.buffer).setInt16(1, rel, false);
        block[3] = blockFlags(sample);
        block.set(data, 4);
        kids.push(U.ebmlRaw(E.SimpleBlock, block));
      }
      // pass kids as ONE array argument: mp4Append flattens arrays, avoiding
      // a ...spread with possibly tens of thousands of block arguments
      return U.ebmlMaster(E.Cluster, kids);
    });

    /* ---- assemble: Segment with unknown size is simplest and streamable;
     *      we know the total length here, so use a real (8-byte vint) size ---- */
    const body = new U.ByteSink();
    U.mp4Append(body, info);
    U.mp4Append(body, tracksEl);
    for (const c of clusterEls) U.mp4Append(body, c);

    const sink = new U.ByteSink();
    U.mp4Append(sink, header);
    // Segment: ID + size(8-byte vint with marker) + body
    sink.push(U.ebmlIdBytes(E.Segment));
    const sz = new Uint8Array(8);
    { let v = BigInt(body.length); for (let i = 7; i >= 0; i--) { sz[i] = Number(v & 0xffn); v >>= 8n; } sz[0] = 0x01; }
    sink.push(sz);
    sink.push(body.concat());
    return sink.concat();
  }

  root.YTDU.WebmMux = WebmMux;
})(typeof globalThis !== 'undefined' ? globalThis : this);


/* =========================================================================
 * downloader.js - fetch streams, demux, remux video+audio, save.
 * Runs in the content-script world on youtube.com pages.
 * Exposes window.YTD (separate from the YTDU lib namespace).
 * ========================================================================= */
(function (root) {
  'use strict';
  const U = root.YTDU;

  /* ---------------- fetch a full stream with progress ----------------
   * `urlOrList` may be a single URL or a list of candidate URLs (live URLs
   * first, then the raw player-response URL); on 403 the next one is tried. */
  async function fetchStream(urlOrList, onProgress, signal) {
    const candidates = Array.isArray(urlOrList) ? urlOrList.filter(Boolean) : [urlOrList];
    let lastErr = null;
    let retried5xx = false;
    for (const url of candidates) {
      // Web app: googlevideo must go through the server-side proxy (CORS).
      const proxied = /googlevideo\.com/.test(url)
        ? '/api/stream?url=' + encodeURIComponent(url)
        : url;
      let resp;
      try {
        resp = await fetch(proxied, { credentials: 'omit', signal, cache: 'no-store' });
      } catch (e) { lastErr = e; continue; }
      if (!resp.ok) {
        lastErr = new Error('HTTP ' + resp.status + ' fetching stream');
        // エラー本文(理由・ヒント)があれば拾ってメッセージに含める
        try {
          const txt = await resp.text();
          if (txt) {
            try {
              const j = JSON.parse(txt);
              if (j && j.error) lastErr = new Error('HTTP ' + resp.status + ': ' + j.error);
            } catch { /* 本文がJSONでなければ無視 */ }
          }
        } catch {}
        if (resp.status === 403 || resp.status === 429) continue;   // try next candidate
        // 5xx は一時的なことが多い: 1回だけ同じURLを再試行する
        if (resp.status >= 500 && !retried5xx) {
          retried5xx = true;
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        throw lastErr;
      }
      const total = Number(resp.headers.get('content-length')) || 0;
      if (!resp.body) return new Uint8Array(await resp.arrayBuffer());
      const reader = resp.body.getReader();
      const chunks = []; let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.length;
        if (onProgress) onProgress(got, total);
      }
      const out = new Uint8Array(got);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    }
    throw lastErr || new Error('No URL available for this stream');
  }

  /* ---------------- container-aware demux/materialise ---------------- */
  function loadMp4Tracks(u8) {
    const d = U.MP4Demux(u8);
    const out = [];
    for (const t of d.tracks) {
      if (!t.samples.length) continue;
      const codec = Object.assign({}, t.codec);
      if (t.codec && t.codec.esds && t.codec.esds.raw) codec.esdsRaw = t.codec.esds.raw;
      // `type` is what the muxers read; `kind` kept for compatibility
      out.push({
        kind: t.type, type: t.type, codecName: t.codecName, codec,
        timescale: t.timescale,
        samples: t.samples.map(s => ({
          data: u8.subarray(s.offset, s.offset + s.size),
          duration: s.duration, ctsOffset: s.ctsOffset || 0, key: s.key,
        })),
      });
    }
    return out;
  }

  function loadWebmTracks(u8) {
    const d = new U.WebmDemux();
    d.push(u8);
    d.finish();
    if (!d.header) throw new Error('WebM demux: no track header found');
    const byNumber = new Map();
    for (const ht of d.header.tracks) {
      byNumber.set(ht.number, {
        kind: ht.type === 1 ? 'video' : 'audio',
        type: ht.type === 1 ? 'video' : 'audio',
        codecId: ht.codecId,
        codecPrivate: ht.codecPrivate,
        width: ht.video && ht.video.width, height: ht.video && ht.video.height,
        channels: ht.audio && ht.audio.channels,
        sampleRate: ht.audio && ht.audio.sampleRate,
        defaultDurationMs: ht.defaultDurationNs != null ? ht.defaultDurationNs / 1e6 : null,
        samples: [],
      });
    }
    d.drainSamples(s => {
      const t = byNumber.get(s.track);
      if (t) t.samples.push({ data: s.data, key: s.key, timecode: s.timecode, duration: s.duration });
    });
    return [...byNumber.values()].filter(t => t.samples.length);
  }

  /* ---------------- merge: pick container ---------------- */
  function mergeTracks(videoTracks, audioTracks) {
    const v = videoTracks && videoTracks[0];
    const a = audioTracks && audioTracks[0];
    if (v && a) {
      const vMp4 = v.container === 'mp4', aMp4 = a.container === 'mp4';
      if (vMp4 && aMp4) {
        return {
          ext: 'mp4', mime: 'video/mp4',
          data: U.MP4Mux({ tracks: [v.track, a.track] }),
        };
      }
      if (!vMp4 && !aMp4) {
        return {
          ext: 'webm', mime: 'video/webm',
          data: U.WebmMux({ tracks: [v.track, a.track] }),
        };
      }
      throw new Error('Video and audio use different containers (MP4 + WebM). Pick a pair whose codec family matches: avc1+aac (both MP4) or vp9+opus/av1+opus (both WebM).');
    }
    if (v) {
      return v.container === 'mp4'
        ? { ext: 'mp4', mime: 'video/mp4', data: U.MP4Mux({ tracks: [v.track] }) }
        : { ext: 'webm', mime: 'video/webm', data: U.WebmMux({ tracks: [v.track] }) };
    }
    if (a) {
      return a.container === 'mp4'
        ? { ext: 'm4a', mime: 'audio/mp4', data: U.MP4Mux({ tracks: [a.track] }) }
        : { ext: 'webm', mime: 'audio/webm', data: U.WebmMux({ tracks: [a.track] }) };
    }
    throw new Error('Nothing to download');
  }

  /* ---------------- high-level download of a chosen pair ---------------- */
  async function downloadMerged({ video, audio, baseName, onProgress, savePath }) {
    const total = (video && video.contentLength || 0) + (audio && audio.contentLength || 0);
    let done = 0;
    const prog = label => (got, t) => {
      // got は累積バイト(映像→音声で通算)で通知する
      if (onProgress) onProgress(label, done + Math.min(got, t || got), total ? (done + Math.min(got, t || got)) / total : 0);
    };

    const emit = (phase, detail) => {
      try { window.dispatchEvent(new CustomEvent('ytd-phase', { detail: Object.assign({ phase }, detail) })); } catch (e) {}
    };

    let videoTracks = null, audioTracks = null;
    if (video) {
      const u8 = await fetchStream(video.urls || video.url, prog('video'));
      done += u8.length;
      emit('demux', { which: 'video' });
      videoTracks = (video.mime.includes('mp4') ? loadMp4Tracks(u8) : loadWebmTracks(u8))
        .map(t => ({ container: video.mime.includes('mp4') ? 'mp4' : 'webm', track: t }))
        .filter(x => x.track.kind === 'video');
    }
    if (audio) {
      const u8 = await fetchStream(audio.urls || audio.url, prog('audio'));
      done += u8.length;
      emit('demux', { which: 'audio' });
      audioTracks = (audio.mime.includes('mp4') ? loadMp4Tracks(u8) : loadWebmTracks(u8))
        .map(t => ({ container: audio.mime.includes('mp4') ? 'mp4' : 'webm', track: t }))
        .filter(x => x.track.kind === 'audio');
    }
    emit('merge', { bytes: (video && video.contentLength || 0) + (audio && audio.contentLength || 0) });
    const merged = mergeTracks(videoTracks, audioTracks);
    emit('save', { total: merged.data.length });
    await saveBlob(new Blob([merged.data], { type: merged.mime }),
      U.sanitizeFilename(baseName) + '.' + merged.ext, savePath);
    emit('done');
    return merged.data.length;
  }

  /* ---------------- plain passthrough download ---------------- */
  async function downloadDirect(fmt, baseName, onProgress, savePath) {
    const emit = (phase, detail) => {
      try { window.dispatchEvent(new CustomEvent('ytd-phase', { detail: Object.assign({ phase }, detail) })); } catch (e) {}
    };
    const u8 = await fetchStream(fmt.urls || fmt.url, (got, t) => onProgress && onProgress('download', got, t));
    const ext = fmt.mime.includes('mp4') ? 'mp4' : fmt.mime.includes('webm') ? 'webm'
      : fmt.mime.includes('mp4a') || fmt.mime.includes('m4a') ? 'm4a' : 'bin';
    emit('save', { total: u8.length });
    await saveBlob(new Blob([u8], { type: fmt.mime }),
      U.sanitizeFilename(baseName) + '.' + ext, savePath);
    emit('done');
    return u8.length;
  }

  /* Wailsデスクトップ版ではネイティブ保存ダイアログ+チャンク書き込みを
   * 使う(WebViewの<a download>が確実に動かないため)。非Wails環境
   * (ローカルserver.mjs等)では従来どおりブラウザ保存にフォールバック。 */
  async function saveBlob(blob, filename, prePickedPath) {
    const app = window.go && window.go.main && window.go.main.App;
    if (app && app.PickSavePath) {
      // 保存先はダウンロード開始前に選択済み(prePickedPath)。
      // 指定がなければ従来どおりここでダイアログを出す
      const path = prePickedPath || await app.PickSavePath(filename);
      if (!path) throw new Error('保存がキャンセルされました');
      const CHUNK = 2 * 1024 * 1024;
      // Uint8Array→base64(Wails v2のバインディングはバイナリを直接渡せない)。
      // 32KBずつStringに変換してスタックオーバーフローを避ける
      const toB64 = (u8) => {
        let s = "";
        for (let i = 0; i < u8.length; i += 32768) {
          s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
        }
        return btoa(s);
      };
      try {
        let written = 0;
        for (let off = 0; off < blob.size; off += CHUNK) {
          const buf = new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer());
          await app.AppendChunkB64(path, toB64(buf));
          written += buf.length;
          try { window.dispatchEvent(new CustomEvent('ytd-phase', { detail: { phase: 'save-progress', written, total: blob.size } })); } catch (e) {}
        }
        await app.CloseFile(path);
      } catch (e) {
        await app.CloseFile(path).catch(() => {});
        throw e;
      }
      return blob.size;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 30000);
  }

  root.YTD = { fetchStream, loadMp4Tracks, loadWebmTracks, mergeTracks, downloadMerged, downloadDirect, saveBlob };
})(typeof globalThis !== 'undefined' ? globalThis : this);
