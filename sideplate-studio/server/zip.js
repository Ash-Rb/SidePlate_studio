// Minimal ZIP reader/writer using only Node's built-in zlib.
// Enough for job bundles: stored or deflated entries, no encryption, no zip64.
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

const ALREADY_COMPRESSED = /\.(png|jpe?g|webp|mp3|mp4|ogg|m4a|zip|glb|spz)$/i;

// entries: [{ name: 'dir/file.png', data: Buffer }]
export function createZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const { time, day } = dosTime(new Date());
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);
    const store = ALREADY_COMPRESSED.test(entry.name);
    const body = store ? data : zlib.deflateRawSync(data);
    const method = store ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

// Returns Map(name -> Buffer). Reads via the central directory, so it
// handles zips written with data descriptors (e.g. by Python's zipfile).
// Defensive: every offset is bounds-checked, decompression is capped at the
// declared size (a zip bomb cannot expand past it), the real size and CRC-32
// must match, and duplicate or unsafe entry names are refused.
export function readZip(buf, { maxTotalBytes = 1024 ** 3, maxEntries = 10000 } = {}) {
  const fail = (msg) => { throw new Error(msg); };
  const need = (pos, len, what) => { if (pos < 0 || pos + len > buf.length) fail(`Zip is truncated or corrupt (${what})`); };
  if (buf.length < 22) fail('Not a zip file (too short)');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) fail('Not a zip file (no end-of-directory record found)');
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) fail('Multi-part zip files are not supported');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  let ptr = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || ptr === 0xffffffff) fail('zip64 archives are not supported');
  if (count > maxEntries) fail(`Zip has too many entries (${count})`);
  need(ptr, cdSize, 'central directory');
  const out = new Map();
  let total = 0;
  for (let i = 0; i < count; i++) {
    need(ptr, 46, 'directory entry');
    if (buf.readUInt32LE(ptr) !== 0x02014b50) fail('Corrupt zip central directory');
    const flags = buf.readUInt16LE(ptr + 8);
    const method = buf.readUInt16LE(ptr + 10);
    const crc = buf.readUInt32LE(ptr + 16);
    const compSize = buf.readUInt32LE(ptr + 20);
    const size = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    need(ptr + 46, nameLen, 'entry name');
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    ptr += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) fail(`Encrypted zip entries are not supported (${name})`);
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) fail('zip64 archives are not supported');
    if (name.includes('\\') || name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split('/').includes('..') || name.includes('\0')) {
      fail(`Unsafe file name in zip: ${name}`);
    }
    if (name.endsWith('/')) continue;
    if (out.has(name)) fail(`Zip lists ${name} twice`);
    total += size;
    if (total > maxTotalBytes) fail('Zip contents are too large');
    need(localOffset, 30, 'local header');
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) fail(`Corrupt local header for ${name}`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    need(start, compSize, `data of ${name}`);
    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) {
      if (compSize !== size) fail(`Size mismatch in ${name}`);
      data = Buffer.from(raw);
    } else if (method === 8) {
      try {
        // Cap output at the declared size + 1 byte so a lying header is caught
        // without ever inflating more than that into memory.
        data = zlib.inflateRawSync(raw, { maxOutputLength: size + 1 });
      } catch (err) {
        fail(err.code === 'ERR_BUFFER_TOO_LARGE' ? `${name} expands beyond its declared size` : `Cannot decompress ${name}: ${err.message}`);
      }
    } else fail(`Unsupported zip compression method ${method} in ${name}`);
    if (data.length !== size) fail(`${name} is not the size the zip says it is`);
    if (crc32(data) !== crc) fail(`${name} is damaged (checksum mismatch)`);
    out.set(name, data);
  }
  return out;
}
