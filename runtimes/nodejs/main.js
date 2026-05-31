import * as std from "std";
import * as os from "os";

const NODE_COMPAT_VERSION = "20";
const ENGINE = "QuickJS";

// ═══ path module ═════════════════════════════════════════════════════════════

const path = {
    sep: '/',
    delimiter: ':',

    dirname(p) {
        if (typeof p !== 'string' || !p) return '.';
        const i = p.lastIndexOf('/');
        if (i < 0) return '.';
        if (i === 0) return '/';
        return p.slice(0, i);
    },

    basename(p, ext) {
        if (typeof p !== 'string' || !p) return '';
        const i = p.lastIndexOf('/');
        let b = i < 0 ? p : p.slice(i + 1);
        if (ext && b.endsWith(ext) && b !== ext) b = b.slice(0, -ext.length);
        return b;
    },

    extname(p) {
        const b = path.basename(p);
        const i = b.lastIndexOf('.');
        return i <= 0 ? '' : b.slice(i);
    },

    isAbsolute(p) {
        return typeof p === 'string' && p.startsWith('/');
    },

    normalize(p) {
        if (typeof p !== 'string' || !p) return '.';
        const isAbs = p.startsWith('/');
        const trailing = p.length > 1 && p.endsWith('/');
        const parts = p.split('/').filter(x => x && x !== '.');
        const out = [];
        for (const part of parts) {
            if (part === '..') {
                if (out.length && out[out.length - 1] !== '..') out.pop();
                else if (!isAbs) out.push('..');
            } else {
                out.push(part);
            }
        }
        let result = out.join('/');
        if (isAbs) result = '/' + result;
        if (trailing && result && !result.endsWith('/')) result += '/';
        return result || (isAbs ? '/' : '.');
    },

    join(...parts) {
        const filtered = parts.filter(p => typeof p === 'string' && p.length > 0);
        if (!filtered.length) return '.';
        return path.normalize(filtered.join('/'));
    },

    resolve(...parts) {
        let resolved = '';
        let absolute = false;
        for (let i = parts.length - 1; i >= 0 && !absolute; i--) {
            const seg = parts[i];
            if (typeof seg !== 'string' || !seg) continue;
            resolved = seg + (resolved ? '/' + resolved : '');
            absolute = seg.startsWith('/');
        }
        if (!absolute) {
            resolved = currentCwd() + (resolved ? '/' + resolved : '');
        }
        return path.normalize(resolved) || '/';
    },

    relative(from, to) {
        from = path.resolve(from);
        to = path.resolve(to);
        if (from === to) return '';
        const fromParts = from.split('/').filter(Boolean);
        const toParts = to.split('/').filter(Boolean);
        let i = 0;
        while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
        const up = fromParts.slice(i).map(() => '..');
        const down = toParts.slice(i);
        return up.concat(down).join('/') || '.';
    },

    parse(p) {
        return {
            root: p.startsWith('/') ? '/' : '',
            dir: path.dirname(p),
            base: path.basename(p),
            ext: path.extname(p),
            name: path.basename(p, path.extname(p)),
        };
    },
};

// ═══ Encodings (utf8 / hex / base64 / latin1 / ascii / utf16le) ═══════════════
// QuickJS ships no TextEncoder/TextDecoder, so these hand-rolled codecs back
// both the Buffer class and the TextEncoder/TextDecoder globals below.

function utf8ByteLength(str) {
    let len = 0;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        if (c < 0x80) len += 1;
        else if (c < 0x800) len += 2;
        else if (c >= 0xD800 && c <= 0xDBFF) {
            const next = str.charCodeAt(i + 1);
            if (next >= 0xDC00 && next <= 0xDFFF) { len += 4; i++; }
            else len += 3;
        } else len += 3;
    }
    return len;
}

function utf8Write(str, bytes, offset) {
    let pos = offset;
    for (let i = 0; i < str.length; i++) {
        let c = str.charCodeAt(i);
        if (c >= 0xD800 && c <= 0xDBFF) {
            const next = str.charCodeAt(i + 1);
            if (next >= 0xDC00 && next <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (next - 0xDC00); i++; }
            else c = 0xFFFD;
        } else if (c >= 0xDC00 && c <= 0xDFFF) {
            c = 0xFFFD;
        }
        if (c < 0x80) {
            bytes[pos++] = c;
        } else if (c < 0x800) {
            bytes[pos++] = 0xC0 | (c >> 6);
            bytes[pos++] = 0x80 | (c & 0x3F);
        } else if (c < 0x10000) {
            bytes[pos++] = 0xE0 | (c >> 12);
            bytes[pos++] = 0x80 | ((c >> 6) & 0x3F);
            bytes[pos++] = 0x80 | (c & 0x3F);
        } else {
            bytes[pos++] = 0xF0 | (c >> 18);
            bytes[pos++] = 0x80 | ((c >> 12) & 0x3F);
            bytes[pos++] = 0x80 | ((c >> 6) & 0x3F);
            bytes[pos++] = 0x80 | (c & 0x3F);
        }
    }
    return pos - offset;
}

function utf8Encode(str) {
    const bytes = new Uint8Array(utf8ByteLength(str));
    utf8Write(str, bytes, 0);
    return bytes;
}

function utf8Decode(bytes, start, end) {
    let out = "";
    const units = [];
    let i = start;
    while (i < end) {
        const b0 = bytes[i++];
        let cp;
        if (b0 < 0x80) cp = b0;
        else if (b0 < 0xE0) cp = ((b0 & 0x1F) << 6) | (bytes[i++] & 0x3F);
        else if (b0 < 0xF0) cp = ((b0 & 0x0F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F);
        else cp = ((b0 & 0x07) << 18) | ((bytes[i++] & 0x3F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F);
        if (cp > 0xFFFF) {
            cp -= 0x10000;
            units.push(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
        } else units.push(cp);
        if (units.length >= 4096) { out += String.fromCharCode.apply(null, units); units.length = 0; }
    }
    if (units.length) out += String.fromCharCode.apply(null, units);
    return out;
}

const _B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const _B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const _B64REV = (() => {
    const t = new Int16Array(256).fill(-1);
    for (let i = 0; i < _B64.length; i++) t[_B64.charCodeAt(i)] = i;
    t[0x2D] = 62; // '-'
    t[0x5F] = 63; // '_'
    return t;
})();

function base64Encode(bytes, start, end, urlSafe) {
    const tbl = urlSafe ? _B64URL : _B64;
    let s = "";
    let i = start;
    for (; i + 3 <= end; i += 3) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        s += tbl[(n >> 18) & 63] + tbl[(n >> 12) & 63] + tbl[(n >> 6) & 63] + tbl[n & 63];
    }
    const rem = end - i;
    if (rem === 1) {
        const n = bytes[i] << 16;
        s += tbl[(n >> 18) & 63] + tbl[(n >> 12) & 63];
        if (!urlSafe) s += "==";
    } else if (rem === 2) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
        s += tbl[(n >> 18) & 63] + tbl[(n >> 12) & 63] + tbl[(n >> 6) & 63];
        if (!urlSafe) s += "=";
    }
    return s;
}

function base64Decode(str) {
    const sextets = [];
    for (let i = 0; i < str.length; i++) {
        const v = _B64REV[str.charCodeAt(i)];
        if (v >= 0) sextets.push(v);
    }
    const out = new Uint8Array((sextets.length * 6) >> 3);
    let buf = 0, bits = 0, o = 0;
    for (let i = 0; i < sextets.length; i++) {
        buf = (buf << 6) | sextets[i];
        bits += 6;
        if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 0xFF; }
    }
    return out;
}

function hexEncode(bytes, start, end) {
    const HEX = "0123456789abcdef";
    let s = "";
    for (let i = start; i < end; i++) s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0xF];
    return s;
}

function hexDecode(str) {
    const len = str.length >> 1;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        const b = parseInt(str.substr(i * 2, 2), 16);
        if (Number.isNaN(b)) return out.subarray(0, i); // Node stops at the first invalid pair
        out[i] = b;
    }
    return out;
}

function normalizeEncoding(enc) {
    if (!enc) return "utf8";
    switch (String(enc).toLowerCase()) {
        case "utf8": case "utf-8": return "utf8";
        case "hex": return "hex";
        case "base64": return "base64";
        case "base64url": return "base64url";
        case "latin1": case "binary": return "latin1";
        case "ascii": return "ascii";
        case "ucs2": case "ucs-2": case "utf16le": case "utf-16le": return "utf16le";
        default: throw new TypeError(`Unknown encoding: ${enc}`);
    }
}

function bytesFromString(str, encoding) {
    switch (normalizeEncoding(encoding)) {
        case "utf8": return utf8Encode(str);
        case "hex": return hexDecode(str);
        case "base64": case "base64url": return base64Decode(str);
        case "latin1": case "ascii": { // both write the low byte (ascii only masks on decode)
            const out = new Uint8Array(str.length);
            for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
            return out;
        }
        case "utf16le": {
            const out = new Uint8Array(str.length * 2);
            for (let i = 0; i < str.length; i++) {
                const c = str.charCodeAt(i);
                out[i * 2] = c & 0xff;
                out[i * 2 + 1] = c >> 8;
            }
            return out;
        }
    }
}

function bytesToString(bytes, encoding, start, end) {
    const enc = normalizeEncoding(encoding);
    start = start > 0 ? start : 0;
    end = end === undefined ? bytes.length : Math.min(end, bytes.length);
    if (end < start) end = start;
    switch (enc) {
        case "utf8": return utf8Decode(bytes, start, end);
        case "hex": return hexEncode(bytes, start, end);
        case "base64": return base64Encode(bytes, start, end, false);
        case "base64url": return base64Encode(bytes, start, end, true);
        case "latin1": case "ascii": {
            const mask = enc === "ascii" ? 0x7f : 0xff;
            let s = "";
            const units = [];
            for (let i = start; i < end; i++) {
                units.push(bytes[i] & mask);
                if (units.length >= 4096) { s += String.fromCharCode.apply(null, units); units.length = 0; }
            }
            if (units.length) s += String.fromCharCode.apply(null, units);
            return s;
        }
        case "utf16le": {
            let s = "";
            for (let i = start; i + 1 < end; i += 2) s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
            return s;
        }
    }
}

// ═══ Buffer ═══════════════════════════════════════════════════════════════════
// Buffer is a real Uint8Array subclass (QuickJS supports this), so index access,
// .length, and TypedArray methods come for free; we add the Node API on top.

class Buffer extends Uint8Array {
    static alloc(size, fill, encoding) {
        const buf = new Buffer(size >>> 0);
        if (fill !== undefined && !(typeof fill === "number" && fill === 0)) buf.fill(fill, 0, buf.length, encoding);
        return buf;
    }
    static allocUnsafe(size) { return new Buffer(size >>> 0); }
    static allocUnsafeSlow(size) { return new Buffer(size >>> 0); }

    static from(value, encodingOrOffset, length) {
        if (typeof value === "string") {
            const bytes = bytesFromString(value, encodingOrOffset);
            return new Buffer(bytes.buffer, bytes.byteOffset, bytes.length);
        }
        if (value instanceof ArrayBuffer) {
            const offset = encodingOrOffset || 0;
            const len = length === undefined ? value.byteLength - offset : length;
            return new Buffer(value, offset, len); // shares memory, like Node
        }
        if (ArrayBuffer.isView(value)) {
            const src = value instanceof Uint8Array
                ? value
                : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
            const buf = new Buffer(src.length);
            buf.set(src); // copies, like Node
            return buf;
        }
        if (value && typeof value.length === "number") {
            const buf = new Buffer(value.length);
            for (let i = 0; i < value.length; i++) buf[i] = value[i] & 0xff;
            return buf;
        }
        throw new TypeError("Buffer.from(): unsupported first argument");
    }

    static concat(list, totalLength) {
        if (!Array.isArray(list)) throw new TypeError("list argument must be an Array");
        if (totalLength === undefined) {
            totalLength = 0;
            for (const b of list) totalLength += b.length;
        }
        const out = new Buffer(totalLength);
        let pos = 0;
        for (const b of list) {
            if (pos >= totalLength) break;
            const chunk = b.length > totalLength - pos ? b.subarray(0, totalLength - pos) : b;
            out.set(chunk, pos);
            pos += chunk.length;
        }
        return out;
    }

    static isBuffer(obj) { return obj instanceof Buffer; }
    static isEncoding(enc) { try { normalizeEncoding(enc); return true; } catch (_) { return false; } }
    static byteLength(value, encoding) {
        if (typeof value !== "string") {
            if (ArrayBuffer.isView(value)) return value.byteLength;
            if (value instanceof ArrayBuffer) return value.byteLength;
            throw new TypeError("byteLength(): value must be a string, Buffer, or ArrayBuffer");
        }
        switch (normalizeEncoding(encoding)) {
            case "utf8": return utf8ByteLength(value);
            case "hex": return value.length >> 1;
            case "latin1": case "ascii": return value.length;
            case "utf16le": return value.length * 2;
            case "base64": case "base64url": return base64Decode(value).length;
        }
    }
    static compare(a, b) { return Buffer.prototype.compare.call(a, b); }

    toString(encoding, start, end) { return bytesToString(this, encoding, start, end); }
    toJSON() { return { type: "Buffer", data: Array.prototype.slice.call(this) }; }

    equals(other) {
        if (!(other instanceof Uint8Array) || this.length !== other.length) return false;
        for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
        return true;
    }
    compare(other) {
        const len = Math.min(this.length, other.length);
        for (let i = 0; i < len; i++) if (this[i] !== other[i]) return this[i] < other[i] ? -1 : 1;
        return this.length < other.length ? -1 : this.length > other.length ? 1 : 0;
    }
    copy(target, targetStart, sourceStart, sourceEnd) {
        targetStart = targetStart || 0;
        sourceStart = sourceStart || 0;
        sourceEnd = sourceEnd === undefined ? this.length : sourceEnd;
        const src = this.subarray(sourceStart, sourceEnd);
        const n = Math.min(src.length, target.length - targetStart);
        target.set(n < src.length ? src.subarray(0, n) : src, targetStart);
        return n;
    }
    slice(start, end) { return this.subarray(start, end); } // Node slice shares memory
    fill(value, offset, end, encoding) {
        offset = offset || 0;
        end = end === undefined ? this.length : end;
        if (typeof value === "string") {
            const bytes = bytesFromString(value, encoding);
            if (bytes.length === 0) return this;
            for (let i = offset; i < end; i++) this[i] = bytes[(i - offset) % bytes.length];
        } else {
            Uint8Array.prototype.fill.call(this, value & 0xff, offset, end);
        }
        return this;
    }
    write(string, offset, length, encoding) {
        if (typeof offset === "string") { encoding = offset; offset = 0; length = undefined; }
        else if (typeof length === "string") { encoding = length; length = undefined; }
        offset = offset || 0;
        const bytes = bytesFromString(string, encoding);
        const max = length === undefined ? this.length - offset : Math.min(length, this.length - offset);
        const n = Math.min(bytes.length, max);
        for (let i = 0; i < n; i++) this[offset + i] = bytes[i];
        return n;
    }
    indexOf(value, byteOffset, encoding) {
        if (typeof byteOffset === "string") { encoding = byteOffset; byteOffset = 0; }
        byteOffset = byteOffset | 0;
        if (byteOffset < 0) byteOffset = Math.max(0, this.length + byteOffset);
        if (typeof value === "number") {
            const v = value & 0xff;
            for (let i = byteOffset; i < this.length; i++) if (this[i] === v) return i;
            return -1;
        }
        const needle = typeof value === "string"
            ? bytesFromString(value, encoding)
            : (value instanceof Uint8Array ? value : null);
        if (!needle) throw new TypeError("indexOf(): val must be string, number, or Buffer");
        if (needle.length === 0) return byteOffset <= this.length ? byteOffset : this.length;
        for (let i = byteOffset; i <= this.length - needle.length; i++) {
            let match = true;
            for (let j = 0; j < needle.length; j++) if (this[i + j] !== needle[j]) { match = false; break; }
            if (match) return i;
        }
        return -1;
    }
    includes(value, byteOffset, encoding) { return this.indexOf(value, byteOffset, encoding) !== -1; }
}

// Fixed-width integer / float accessors, generated over DataView.
const _bufRead = {
    readUInt8: ["getUint8"], readInt8: ["getInt8"],
    readUInt16LE: ["getUint16", true], readUInt16BE: ["getUint16", false],
    readInt16LE: ["getInt16", true], readInt16BE: ["getInt16", false],
    readUInt32LE: ["getUint32", true], readUInt32BE: ["getUint32", false],
    readInt32LE: ["getInt32", true], readInt32BE: ["getInt32", false],
    readFloatLE: ["getFloat32", true], readFloatBE: ["getFloat32", false],
    readDoubleLE: ["getFloat64", true], readDoubleBE: ["getFloat64", false],
};
for (const name in _bufRead) {
    const [fn, le] = _bufRead[name];
    Buffer.prototype[name] = function (offset) {
        return new DataView(this.buffer, this.byteOffset, this.byteLength)[fn](offset || 0, le);
    };
}
const _bufWrite = {
    writeUInt8: ["setUint8", 1], writeInt8: ["setInt8", 1],
    writeUInt16LE: ["setUint16", 2, true], writeUInt16BE: ["setUint16", 2, false],
    writeInt16LE: ["setInt16", 2, true], writeInt16BE: ["setInt16", 2, false],
    writeUInt32LE: ["setUint32", 4, true], writeUInt32BE: ["setUint32", 4, false],
    writeInt32LE: ["setInt32", 4, true], writeInt32BE: ["setInt32", 4, false],
    writeFloatLE: ["setFloat32", 4, true], writeFloatBE: ["setFloat32", 4, false],
    writeDoubleLE: ["setFloat64", 8, true], writeDoubleBE: ["setFloat64", 8, false],
};
for (const name in _bufWrite) {
    const [fn, size, le] = _bufWrite[name];
    Buffer.prototype[name] = function (value, offset) {
        offset = offset || 0;
        new DataView(this.buffer, this.byteOffset, this.byteLength)[fn](offset, value, le);
        return offset + size;
    };
}
// Node also exposes 'Uint' (lowercase i) aliases.
for (const name of Object.keys(_bufRead).concat(Object.keys(_bufWrite))) {
    if (name.indexOf("UInt") >= 0) Buffer.prototype[name.replace("UInt", "Uint")] = Buffer.prototype[name];
}

// ═══ TextEncoder / TextDecoder (utf-8 only) ═══════════════════════════════════

class TextEncoder {
    get encoding() { return "utf-8"; }
    encode(input) { return utf8Encode(input === undefined ? "" : String(input)); }
}

class TextDecoder {
    constructor(label, options) {
        this.encoding = label ? String(label).toLowerCase() : "utf-8";
        this.fatal = !!(options && options.fatal);
        this.ignoreBOM = !!(options && options.ignoreBOM);
    }
    decode(input) {
        if (input === undefined) return "";
        let bytes;
        if (input instanceof Uint8Array) bytes = input;
        else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
        else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        else throw new TypeError("decode(): input must be a BufferSource");
        return utf8Decode(bytes, 0, bytes.length);
    }
}

const bufferModule = {
    Buffer,
    SlowBuffer: function SlowBuffer(size) { return Buffer.allocUnsafeSlow(size); },
    kMaxLength: 0x7fffffff,
    constants: { MAX_LENGTH: 0x7fffffff, MAX_STRING_LENGTH: 0x1fffffff },
    INSPECT_MAX_BYTES: 50,
    atob: (s) => bytesToString(base64Decode(s), "latin1"),
    btoa: (s) => { const b = bytesFromString(s, "latin1"); return base64Encode(b, 0, b.length, false); },
};

// fs write helper: accepts string (encoded) or Buffer/TypedArray/ArrayBuffer (raw bytes).
function writeData(f, data, enc) {
    if (typeof data === "string") {
        const bytes = bytesFromString(data, enc);
        if (bytes.length) f.write(bytes.buffer, bytes.byteOffset, bytes.length);
    } else if (ArrayBuffer.isView(data)) {
        if (data.byteLength) f.write(data.buffer, data.byteOffset, data.byteLength);
    } else if (data instanceof ArrayBuffer) {
        if (data.byteLength) f.write(data, 0, data.byteLength);
    } else {
        const bytes = bytesFromString(String(data), enc);
        if (bytes.length) f.write(bytes.buffer, bytes.byteOffset, bytes.length);
    }
}

// ═══ fs module ═══════════════════════════════════════════════════════════════

function fsError(code, msg, p) {
    const e = new Error(`${code}: ${msg}, '${p}'`);
    e.code = code;
    e.path = p;
    return e;
}

const fs = {
    existsSync(p) {
        const f = std.open(p, "r");
        if (f) { f.close(); return true; }
        return false;
    },

    readFileSync(p, options) {
        const enc = typeof options === 'string' ? options : (options && options.encoding) || null;
        const [st, serr] = os.stat(p);
        const size = (!serr && st) ? st.size : -1;
        const f = std.open(p, "rb");
        if (!f) throw fsError('ENOENT', 'no such file or directory, open', p);
        try {
            let buf;
            if (size >= 0) {
                const ab = new ArrayBuffer(size);
                let off = 0;
                while (off < size) {
                    const n = f.read(ab, off, size - off);
                    if (n <= 0) break;
                    off += n;
                }
                buf = off === size ? Buffer.from(ab) : Buffer.from(ab, 0, off);
            } else {
                // Size unknown (e.g. a pipe): read in chunks until EOF.
                const chunks = [];
                const tmp = new ArrayBuffer(65536);
                let total = 0;
                for (;;) {
                    const n = f.read(tmp, 0, 65536);
                    if (n <= 0) break;
                    chunks.push(Buffer.from(tmp.slice(0, n)));
                    total += n;
                }
                buf = Buffer.concat(chunks, total);
            }
            // No encoding -> return raw bytes as a Buffer (Node semantics).
            return enc ? buf.toString(enc) : buf;
        } finally {
            f.close();
        }
    },

    writeFileSync(p, data, options) {
        const enc = typeof options === 'string' ? options : (options && options.encoding) || 'utf8';
        const f = std.open(p, "wb");
        if (!f) throw fsError('EACCES', 'cannot write file', p);
        try {
            writeData(f, data, enc);
        } finally {
            f.close();
        }
    },

    appendFileSync(p, data, options) {
        const enc = typeof options === 'string' ? options : (options && options.encoding) || 'utf8';
        const f = std.open(p, "ab");
        if (!f) throw fsError('EACCES', 'cannot append to file', p);
        try {
            writeData(f, data, enc);
        } finally {
            f.close();
        }
    },

    statSync(p) {
        const [st, err] = os.stat(p);
        if (err) throw fsError('ENOENT', 'no such file or directory, stat', p);
        const S_IFMT = 0o170000;
        const S_IFREG = 0o100000;
        const S_IFDIR = 0o040000;
        const S_IFLNK = 0o120000;
        return {
            size: st.size,
            mode: st.mode,
            mtimeMs: st.mtime,
            atimeMs: st.atime,
            ctimeMs: st.ctime,
            isFile: () => (st.mode & S_IFMT) === S_IFREG,
            isDirectory: () => (st.mode & S_IFMT) === S_IFDIR,
            isSymbolicLink: () => (st.mode & S_IFMT) === S_IFLNK,
        };
    },

    readdirSync(p, _options) {
        const [entries, err] = os.readdir(p);
        if (err) throw fsError('ENOENT', 'no such directory, scandir', p);
        return entries.filter(name => name !== '.' && name !== '..');
    },

    mkdirSync(p, options) {
        const mode = (options && typeof options === 'object' && options.mode) || 0o777;
        const ret = os.mkdir(p, mode);
        if (ret < 0) throw fsError('EACCES', 'mkdir failed', p);
    },

    rmSync(p) {
        const ret = os.remove(p);
        if (ret < 0) throw fsError('ENOENT', 'cannot remove', p);
    },

    unlinkSync(p) { fs.rmSync(p); },

    renameSync(from, to) {
        const ret = os.rename(from, to);
        if (ret < 0) throw fsError('EACCES', `cannot rename to '${to}'`, from);
    },

    realpathSync(p) {
        if (!os.realpath) return path.resolve(p);
        const [r, err] = os.realpath(p);
        if (err) throw fsError('ENOENT', 'realpath failed', p);
        return r;
    },
};

// ═══ node:os module ══════════════════════════════════════════════════════════

const nodeOs = {
    EOL: '\n',
    platform: () => 'wasi',
    arch: () => 'wasm32',
    type: () => 'WASI',
    release: () => '1.0.0',
    hostname: () => 'wasi',
    tmpdir: () => '/tmp',
    homedir: () => '/',
    cpus: () => [],
    totalmem: () => 0,
    freemem: () => 0,
    uptime: () => 0,
    userInfo: () => ({ username: 'wasi', uid: -1, gid: -1, shell: null, homedir: '/' }),
};

// ═══ events (EventEmitter) ════════════════════════════════════════════════════

class EventEmitter {
    constructor() {
        this._events = Object.create(null);
        this._eventsCount = 0;
        this._maxListeners = undefined;
    }
    setMaxListeners(n) { this._maxListeners = n; return this; }
    getMaxListeners() { return this._maxListeners === undefined ? EventEmitter.defaultMaxListeners : this._maxListeners; }

    _addListener(type, listener, prepend) {
        if (typeof listener !== "function") throw new TypeError("listener must be a function");
        if (this._events.newListener !== undefined) this.emit("newListener", type, listener.listener || listener);
        const existing = this._events[type];
        if (existing === undefined) { this._events[type] = listener; this._eventsCount++; }
        else if (typeof existing === "function") this._events[type] = prepend ? [listener, existing] : [existing, listener];
        else if (prepend) existing.unshift(listener);
        else existing.push(listener);
        return this;
    }
    on(type, listener) { return this._addListener(type, listener, false); }
    addListener(type, listener) { return this._addListener(type, listener, false); }
    prependListener(type, listener) { return this._addListener(type, listener, true); }

    once(type, listener) { return this._addListener(type, this._onceWrap(type, listener), false); }
    prependOnceListener(type, listener) { return this._addListener(type, this._onceWrap(type, listener), true); }
    _onceWrap(type, listener) {
        if (typeof listener !== "function") throw new TypeError("listener must be a function");
        const self = this;
        const wrapped = function (...args) { self.removeListener(type, wrapped); return listener.apply(self, args); };
        wrapped.listener = listener;
        return wrapped;
    }

    removeListener(type, listener) {
        const list = this._events[type];
        if (list === undefined) return this;
        if (list === listener || list.listener === listener) {
            if (--this._eventsCount === 0) this._events = Object.create(null);
            else delete this._events[type];
            if (this._events.removeListener) this.emit("removeListener", type, listener.listener || listener);
        } else if (typeof list !== "function") {
            for (let i = list.length - 1; i >= 0; i--) {
                if (list[i] === listener || list[i].listener === listener) {
                    const removed = list[i];
                    list.splice(i, 1);
                    if (list.length === 1) this._events[type] = list[0];
                    else if (list.length === 0) { delete this._events[type]; this._eventsCount--; }
                    if (this._events.removeListener) this.emit("removeListener", type, removed.listener || removed);
                    break;
                }
            }
        }
        return this;
    }
    off(type, listener) { return this.removeListener(type, listener); }

    removeAllListeners(type) {
        if (type === undefined) { this._events = Object.create(null); this._eventsCount = 0; }
        else if (this._events[type] !== undefined) { delete this._events[type]; this._eventsCount--; }
        return this;
    }

    emit(type, ...args) {
        const handler = this._events[type];
        if (handler === undefined) {
            if (type === "error") {
                const err = args[0];
                throw (err instanceof Error) ? err : new Error("Unhandled 'error' event" + (err !== undefined ? ": " + err : ""));
            }
            return false;
        }
        if (typeof handler === "function") handler.apply(this, args);
        else { const ls = handler.slice(); for (let i = 0; i < ls.length; i++) ls[i].apply(this, args); }
        return true;
    }

    listeners(type) {
        const h = this._events[type];
        if (h === undefined) return [];
        return typeof h === "function" ? [h.listener || h] : h.map(l => l.listener || l);
    }
    rawListeners(type) {
        const h = this._events[type];
        if (h === undefined) return [];
        return typeof h === "function" ? [h] : h.slice();
    }
    listenerCount(type) {
        const h = this._events[type];
        return h === undefined ? 0 : (typeof h === "function" ? 1 : h.length);
    }
    eventNames() { return Object.keys(this._events); }
}
EventEmitter.defaultMaxListeners = 10;
EventEmitter.EventEmitter = EventEmitter;
EventEmitter.listenerCount = (emitter, type) => emitter.listenerCount(type);
EventEmitter.once = function (emitter, name) {
    return new Promise((resolve, reject) => {
        const onEvent = (...args) => { emitter.removeListener("error", onError); resolve(args); };
        const onError = (err) => { emitter.removeListener(name, onEvent); reject(err); };
        emitter.once(name, onEvent);
        if (name !== "error") emitter.once("error", onError);
    });
};

// ═══ Deep equality (shared by util.isDeepStrictEqual and assert) ══════════════

function isDeepEqual(a, b, strict) {
    if (strict ? Object.is(a, b) : a === b) return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
        return strict ? false : a == b; // eslint-disable-line eqeqeq
    }
    if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
    if (a instanceof RegExp || b instanceof RegExp) return a instanceof RegExp && b instanceof RegExp && a.toString() === b.toString();
    if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
        if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.byteLength !== b.byteLength) return false;
        const ua = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
        const ub = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
        for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
        return true;
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (a instanceof Map || b instanceof Map) {
        if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
        for (const [k, v] of a) { if (!b.has(k) || !isDeepEqual(v, b.get(k), strict)) return false; }
        return true;
    }
    if (a instanceof Set || b instanceof Set) {
        if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
        for (const v of a) if (!b.has(v)) return false;
        return true;
    }
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
        if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
        if (!isDeepEqual(a[k], b[k], strict)) return false;
    }
    return true;
}

// ═══ util ═════════════════════════════════════════════════════════════════════

const _inspectCustom = Symbol.for("nodejs.util.inspect.custom");

function inspect(value, opts) {
    opts = opts || {};
    const depth = opts.depth === undefined ? 2 : opts.depth;
    return _inspect(value, depth, new Set());
}
function _inspectKey(k) { return /^[A-Za-z_$][\w$]*$/.test(k) ? k : "'" + k + "'"; }
function _inspect(v, depth, seen) {
    const t = typeof v;
    if (v === null) return "null";
    if (t === "undefined") return "undefined";
    if (t === "string") return "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n") + "'";
    if (t === "number") return Object.is(v, -0) ? "-0" : String(v);
    if (t === "boolean") return String(v);
    if (t === "bigint") return String(v) + "n";
    if (t === "symbol") return v.toString();
    if (t === "function") return `[Function: ${v.name || "(anonymous)"}]`;
    if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
    if (v instanceof RegExp) return v.toString();
    if (v instanceof Date) return v.toISOString();
    if (typeof v[_inspectCustom] === "function") return String(v[_inspectCustom](depth, opts));
    if (seen.has(v)) return "[Circular *1]";
    if (depth < 0) return Array.isArray(v) ? "[Array]" : "[Object]";
    seen.add(v);
    let out;
    if (Array.isArray(v)) {
        out = v.length === 0 ? "[]" : "[ " + v.map(x => _inspect(x, depth - 1, seen)).join(", ") + " ]";
    } else if (v instanceof Map) {
        const items = []; v.forEach((val, key) => items.push(_inspect(key, depth - 1, seen) + " => " + _inspect(val, depth - 1, seen)));
        out = `Map(${v.size}) {` + (items.length ? " " + items.join(", ") + " " : "") + "}";
    } else if (v instanceof Set) {
        const items = []; v.forEach(val => items.push(_inspect(val, depth - 1, seen)));
        out = `Set(${v.size}) {` + (items.length ? " " + items.join(", ") + " " : "") + "}";
    } else if (v instanceof Uint8Array) {
        out = "<Buffer " + bytesToString(v, "hex").replace(/(..)/g, "$1 ").trim() + ">";
    } else {
        const keys = Object.keys(v);
        const parts = keys.map(k => `${_inspectKey(k)}: ${_inspect(v[k], depth - 1, seen)}`);
        const ctor = v.constructor && v.constructor.name;
        const prefix = ctor && ctor !== "Object" ? ctor + " " : "";
        out = keys.length === 0 ? prefix + "{}" : prefix + "{ " + parts.join(", ") + " }";
    }
    seen.delete(v);
    return out;
}
inspect.custom = _inspectCustom;

function format(f, ...args) {
    if (typeof f !== "string") {
        return [f, ...args].map(a => typeof a === "string" ? a : inspect(a)).join(" ");
    }
    let i = 0;
    let str = f.replace(/%[sdifjoOc%]/g, (m) => {
        if (m === "%%") return "%";
        if (i >= args.length) return m;
        const a = args[i++];
        switch (m) {
            case "%s": return typeof a === "bigint" ? a + "n" : (a !== null && typeof a === "object" ? inspect(a, { depth: 2 }) : String(a));
            case "%d": return typeof a === "bigint" ? a + "n" : (typeof a === "symbol" ? "NaN" : String(Number(a)));
            case "%i": return typeof a === "bigint" ? a + "n" : String(parseInt(a, 10));
            case "%f": return String(parseFloat(a));
            case "%j": try { return JSON.stringify(a); } catch (_) { return "[Circular]"; }
            case "%o": case "%O": return inspect(a);
            case "%c": return "";
            default: return m;
        }
    });
    for (; i < args.length; i++) {
        const a = args[i];
        str += " " + (typeof a === "string" ? a : inspect(a));
    }
    return str;
}

function inherits(ctor, superCtor) {
    if (typeof ctor !== "function" || typeof superCtor !== "function") throw new TypeError("ctor and superCtor must be functions");
    ctor.super_ = superCtor;
    Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}

const _promisifyCustom = Symbol.for("nodejs.util.promisify.custom");
function promisify(original) {
    if (typeof original !== "function") throw new TypeError("original must be a function");
    if (original[_promisifyCustom]) return original[_promisifyCustom];
    function fn(...args) {
        return new Promise((resolve, reject) => {
            original.call(this, ...args, (err, ...values) => {
                if (err) reject(err);
                else resolve(values[0]);
            });
        });
    }
    Object.setPrototypeOf(fn, Object.getPrototypeOf(original));
    return fn;
}
promisify.custom = _promisifyCustom;

function callbackify(original) {
    if (typeof original !== "function") throw new TypeError("original must be a function");
    return function (...args) {
        const cb = args.pop();
        if (typeof cb !== "function") throw new TypeError("last argument must be a callback");
        original.apply(this, args).then(
            (val) => process.nextTick(cb, null, val),
            (err) => process.nextTick(cb, err || new Error("Promise was rejected with a falsy value"))
        );
    };
}

function deprecate(fn, msg) {
    let warned = false;
    return function (...args) {
        if (!warned) { warned = true; process.stderr.write("(node) DeprecationWarning: " + msg + "\n"); }
        return fn.apply(this, args);
    };
}

function debuglog(section) {
    const env = (typeof process !== "undefined" && process.env && process.env.NODE_DEBUG) || "";
    const enabled = env === "*" || env.split(/[\s,]+/).indexOf(section) >= 0;
    if (!enabled) return () => {};
    return (...args) => process.stderr.write(`${section.toUpperCase()} ${process.pid}: ${format(...args)}\n`);
}

const util = {
    format,
    formatWithOptions: (_opts, ...args) => format(...args),
    inspect,
    inherits,
    promisify,
    callbackify,
    deprecate,
    debuglog,
    debug: debuglog,
    isDeepStrictEqual: (a, b) => isDeepEqual(a, b, true),
    _extend: (target, source) => Object.assign(target, source || {}),
    types: {
        isDate: (v) => v instanceof Date,
        isRegExp: (v) => v instanceof RegExp,
        isMap: (v) => v instanceof Map,
        isSet: (v) => v instanceof Set,
        isPromise: (v) => v instanceof Promise,
        isNativeError: (v) => v instanceof Error,
        isArrayBuffer: (v) => v instanceof ArrayBuffer,
        isAnyArrayBuffer: (v) => v instanceof ArrayBuffer,
        isTypedArray: (v) => ArrayBuffer.isView(v) && !(v instanceof DataView),
        isUint8Array: (v) => v instanceof Uint8Array,
        isDataView: (v) => v instanceof DataView,
        isAsyncFunction: (v) => typeof v === "function" && v.constructor && v.constructor.name === "AsyncFunction",
        isGeneratorFunction: (v) => typeof v === "function" && v.constructor && v.constructor.name === "GeneratorFunction",
    },
    TextEncoder,
    TextDecoder,
    // legacy (deprecated in Node, still used by some libs)
    isArray: Array.isArray,
    isBuffer: (v) => Buffer.isBuffer(v),
    isFunction: (v) => typeof v === "function",
    isString: (v) => typeof v === "string",
    isNumber: (v) => typeof v === "number",
    isNullOrUndefined: (v) => v === null || v === undefined,
};

// ═══ assert ═══════════════════════════════════════════════════════════════════

class AssertionError extends Error {
    constructor(options) {
        const generated = !options.message;
        const message = options.message ||
            `${inspect(options.actual)} ${options.operator} ${inspect(options.expected)}`;
        super(message);
        this.name = "AssertionError";
        this.code = "ERR_ASSERTION";
        this.actual = options.actual;
        this.expected = options.expected;
        this.operator = options.operator;
        this.generatedMessage = generated;
    }
}

function assert(value, message) {
    if (!value) throw new AssertionError({ message, actual: value, expected: true, operator: "==" });
}
assert.AssertionError = AssertionError;
assert.ok = assert;
assert.fail = (message) => { throw new AssertionError({ message: (message instanceof Error) ? message.message : (message || "Failed"), operator: "fail" }); };
assert.equal = (a, e, m) => { if (a != e) throw new AssertionError({ actual: a, expected: e, operator: "==", message: m }); }; // eslint-disable-line eqeqeq
assert.notEqual = (a, e, m) => { if (a == e) throw new AssertionError({ actual: a, expected: e, operator: "!=", message: m }); }; // eslint-disable-line eqeqeq
assert.strictEqual = (a, e, m) => { if (!Object.is(a, e)) throw new AssertionError({ actual: a, expected: e, operator: "strictEqual", message: m }); };
assert.notStrictEqual = (a, e, m) => { if (Object.is(a, e)) throw new AssertionError({ actual: a, expected: e, operator: "notStrictEqual", message: m }); };
assert.deepEqual = (a, e, m) => { if (!isDeepEqual(a, e, false)) throw new AssertionError({ actual: a, expected: e, operator: "deepEqual", message: m }); };
assert.notDeepEqual = (a, e, m) => { if (isDeepEqual(a, e, false)) throw new AssertionError({ actual: a, expected: e, operator: "notDeepEqual", message: m }); };
assert.deepStrictEqual = (a, e, m) => { if (!isDeepEqual(a, e, true)) throw new AssertionError({ actual: a, expected: e, operator: "deepStrictEqual", message: m }); };
assert.notDeepStrictEqual = (a, e, m) => { if (isDeepEqual(a, e, true)) throw new AssertionError({ actual: a, expected: e, operator: "notDeepStrictEqual", message: m }); };
assert.ifError = (err) => { if (err !== null && err !== undefined) throw new AssertionError({ message: `ifError got unwanted exception: ${err instanceof Error ? err.message : inspect(err)}`, actual: err, expected: null, operator: "ifError" }); };
assert.match = (str, re, m) => { if (!re.test(str)) throw new AssertionError({ actual: str, expected: re, operator: "match", message: m }); };
assert.doesNotMatch = (str, re, m) => { if (re.test(str)) throw new AssertionError({ actual: str, expected: re, operator: "doesNotMatch", message: m }); };
function _checkError(caught, expected) {
    if (!expected) return true;
    if (expected instanceof RegExp) return expected.test(caught && caught.message);
    if (typeof expected === "function") {
        if (expected === Error || expected.prototype instanceof Error) return caught instanceof expected;
        return expected(caught) === true;
    }
    if (typeof expected === "object") {
        for (const k of Object.keys(expected)) if (!isDeepEqual(caught[k], expected[k], true)) return false;
        return true;
    }
    return true;
}
assert.throws = (fn, expected, message) => {
    if (typeof expected === "string") { message = expected; expected = undefined; }
    let caught, threw = false;
    try { fn(); } catch (e) { threw = true; caught = e; }
    if (!threw) throw new AssertionError({ message: message || "Missing expected exception.", operator: "throws" });
    if (!_checkError(caught, expected)) throw new AssertionError({ message: message || "Got unwanted exception.", actual: caught, expected, operator: "throws" });
};
assert.doesNotThrow = (fn, expected, message) => {
    if (typeof expected === "string") { message = expected; expected = undefined; }
    try { fn(); } catch (e) {
        if (!expected || _checkError(e, expected)) throw new AssertionError({ message: message || `Got unwanted exception: ${e.message}`, actual: e, operator: "doesNotThrow" });
        throw e;
    }
};
assert.rejects = async (fnOrPromise, expected, message) => {
    if (typeof expected === "string") { message = expected; expected = undefined; }
    let caught, threw = false;
    try { await (typeof fnOrPromise === "function" ? fnOrPromise() : fnOrPromise); } catch (e) { threw = true; caught = e; }
    if (!threw) throw new AssertionError({ message: message || "Missing expected rejection.", operator: "rejects" });
    if (!_checkError(caught, expected)) throw new AssertionError({ message: message || "Got unwanted rejection.", actual: caught, expected, operator: "rejects" });
};
assert.doesNotReject = async (fnOrPromise) => {
    try { await (typeof fnOrPromise === "function" ? fnOrPromise() : fnOrPromise); }
    catch (e) { throw new AssertionError({ message: `Got unwanted rejection: ${e.message}`, actual: e, operator: "doesNotReject" }); }
};
assert.strict = Object.assign(function strict(value, message) { return assert.ok(value, message); }, assert, {
    equal: assert.strictEqual,
    notEqual: assert.notStrictEqual,
    deepEqual: assert.deepStrictEqual,
    notDeepEqual: assert.notDeepStrictEqual,
});
assert.strict.strict = assert.strict;

// ═══ stream (pragmatic subset built on EventEmitter + the event loop) ═════════

class Stream extends EventEmitter {}

class Readable extends Stream {
    constructor(options) {
        super();
        options = options || {};
        this._readableState = {
            flowing: null, ended: false, endEmitted: false, reading: false, flowActive: false,
            buffer: [], objectMode: !!options.objectMode, encoding: options.encoding || null,
            highWaterMark: options.highWaterMark || 16,
        };
        if (typeof options.read === "function") this._read = options.read;
        this.readable = true;
    }
    _read() {}
    push(chunk, encoding) {
        const s = this._readableState;
        if (chunk === null) {
            s.ended = true; s.reading = false;
            if (s.flowing) this._flow(); else process.nextTick(() => this._maybeEnd());
            return false;
        }
        if (typeof chunk === "string" && !s.objectMode) chunk = Buffer.from(chunk, encoding || s.encoding || "utf8");
        s.buffer.push(chunk); s.reading = false;
        if (s.flowing) this._flow(); else this.emit("readable");
        return s.buffer.length < s.highWaterMark;
    }
    _flow() {
        const s = this._readableState;
        if (s.flowing !== true || s.flowActive) return;
        s.flowActive = true;
        const step = () => {
            if (s.flowing !== true) { s.flowActive = false; return; }
            if (s.buffer.length > 0) {
                let chunk = s.buffer.shift();
                if (s.encoding && Buffer.isBuffer(chunk)) chunk = chunk.toString(s.encoding);
                this.emit("data", chunk);
                process.nextTick(step);
            } else if (s.ended) {
                s.flowActive = false;
                this._maybeEnd();
            } else if (!s.reading) {
                s.reading = true;
                this._read(s.highWaterMark);
                process.nextTick(step);
            } else {
                process.nextTick(step);
            }
        };
        step();
    }
    _maybeEnd() {
        const s = this._readableState;
        if (s.ended && !s.endEmitted && s.buffer.length === 0) {
            s.endEmitted = true; this.readable = false; this.emit("end");
        }
    }
    read() {
        const s = this._readableState;
        if (s.buffer.length === 0 && !s.ended && !s.reading) { s.reading = true; this._read(s.highWaterMark); }
        if (s.buffer.length === 0) { if (s.ended) process.nextTick(() => this._maybeEnd()); return null; }
        let chunk = s.buffer.shift();
        if (s.encoding && Buffer.isBuffer(chunk)) chunk = chunk.toString(s.encoding);
        return chunk;
    }
    resume() { const s = this._readableState; if (s.flowing !== true) { s.flowing = true; process.nextTick(() => this._flow()); } return this; }
    pause() { if (this._readableState.flowing !== false) this._readableState.flowing = false; return this; }
    isPaused() { return this._readableState.flowing === false; }
    setEncoding(enc) { this._readableState.encoding = enc; return this; }
    on(event, listener) {
        const r = super.on(event, listener);
        if (event === "data" && this._readableState.flowing !== false) this.resume();
        return r;
    }
    pipe(dest, options) {
        const opts = options || {};
        this.on("data", (chunk) => dest.write(chunk));
        this.on("end", () => { if (opts.end !== false && typeof dest.end === "function") dest.end(); });
        this.on("error", (err) => dest.emit("error", err));
        if (typeof dest.emit === "function") dest.emit("pipe", this);
        return dest;
    }
}
Readable.from = function (iterable, options) {
    const r = new Readable(Object.assign({ objectMode: true }, options));
    const it = (iterable && typeof iterable[Symbol.iterator] === "function") ? iterable[Symbol.iterator]() : iterable;
    r._read = function () {
        try {
            const next = it.next();
            if (next && typeof next.then === "function") {
                next.then(res => { if (res.done) r.push(null); else r.push(res.value); }, err => r.emit("error", err));
            } else if (next.done) r.push(null);
            else r.push(next.value);
        } catch (e) { r.emit("error", e); }
    };
    return r;
};

class Writable extends Stream {
    constructor(options) {
        super();
        options = options || {};
        this._writableState = {
            ended: false, finished: false, objectMode: !!options.objectMode,
            decodeStrings: options.decodeStrings !== false, defaultEncoding: options.defaultEncoding || "utf8",
        };
        if (typeof options.write === "function") this._write = options.write;
        if (typeof options.final === "function") this._final = options.final;
        this.writable = true;
    }
    _write(chunk, encoding, callback) { callback(); }
    write(chunk, encoding, callback) {
        if (typeof encoding === "function") { callback = encoding; encoding = null; }
        const s = this._writableState;
        if (s.ended) {
            const err = new Error("write after end");
            process.nextTick(() => { if (callback) callback(err); this.emit("error", err); });
            return false;
        }
        if (typeof chunk === "string" && !s.objectMode && s.decodeStrings) chunk = Buffer.from(chunk, encoding || s.defaultEncoding);
        this._write(chunk, encoding || s.defaultEncoding, (err) => {
            if (err) this.emit("error", err);
            if (callback) callback(err);
        });
        return true;
    }
    end(chunk, encoding, callback) {
        if (typeof chunk === "function") { callback = chunk; chunk = undefined; }
        else if (typeof encoding === "function") { callback = encoding; encoding = undefined; }
        if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
        const s = this._writableState;
        s.ended = true;
        const finish = () => { s.finished = true; if (callback) callback(); this.emit("finish"); };
        if (typeof this._final === "function") this._final((err) => { if (err) this.emit("error", err); else finish(); });
        else process.nextTick(finish);
        return this;
    }
}

class Duplex extends Readable {
    constructor(options) {
        super(options);
        options = options || {};
        this._writableState = {
            ended: false, finished: false, objectMode: !!(options.objectMode || options.writableObjectMode),
            decodeStrings: options.decodeStrings !== false, defaultEncoding: options.defaultEncoding || "utf8",
        };
        if (typeof options.write === "function") this._write = options.write;
        if (typeof options.final === "function") this._final = options.final;
        this.writable = true;
    }
}
Duplex.prototype._write = Writable.prototype._write;
Duplex.prototype.write = Writable.prototype.write;
Duplex.prototype.end = Writable.prototype.end;

class Transform extends Duplex {
    constructor(options) {
        super(options);
        options = options || {};
        if (typeof options.transform === "function") this._transform = options.transform;
        if (typeof options.flush === "function") this._flush = options.flush;
    }
    _transform(chunk, encoding, callback) { callback(null, chunk); }
    _flush(callback) { callback(); }
    _write(chunk, encoding, callback) {
        this._transform(chunk, encoding, (err, data) => {
            if (data !== undefined && data !== null) this.push(data);
            callback(err);
        });
    }
    end(chunk, encoding, callback) {
        if (typeof chunk === "function") { callback = chunk; chunk = undefined; }
        else if (typeof encoding === "function") { callback = encoding; encoding = undefined; }
        const s = this._writableState;
        const doFlush = () => {
            s.ended = true; // set after the final chunk is written, so write() isn't rejected
            this._flush((err, data) => {
                if (err) { this.emit("error", err); return; }
                if (data !== undefined && data !== null) this.push(data);
                this.push(null); // end the readable side
                s.finished = true;
                if (callback) callback();
                this.emit("finish");
            });
        };
        if (chunk !== undefined && chunk !== null) this.write(chunk, encoding, () => doFlush());
        else doFlush();
        return this;
    }
}

class PassThrough extends Transform {
    _transform(chunk, encoding, callback) { callback(null, chunk); }
}

function finished(stream, callback) {
    let called = false;
    const done = (err) => { if (called) return; called = true; process.nextTick(() => callback(err)); };
    stream.on("end", () => done());
    stream.on("finish", () => done());
    stream.on("close", () => done());
    stream.on("error", (err) => done(err));
    return () => { called = true; };
}

function pipeline(...args) {
    const callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
    const streams = args;
    for (let i = 0; i < streams.length - 1; i++) streams[i].pipe(streams[i + 1]);
    const last = streams[streams.length - 1];
    if (callback) {
        let done = false;
        const fail = (err) => { if (!done) { done = true; callback(err); } };
        for (const s of streams) s.on("error", fail);
        finished(last, (err) => { if (!done) { done = true; callback(err); } });
    }
    return last;
}

Stream.Readable = Readable;
Stream.Writable = Writable;
Stream.Duplex = Duplex;
Stream.Transform = Transform;
Stream.PassThrough = PassThrough;
Stream.Stream = Stream;
Stream.EventEmitter = EventEmitter;
Stream.finished = finished;
Stream.pipeline = pipeline;

const eventsModule = EventEmitter;
const assertModule = assert;
const streamModule = Stream;

// ═══ Built-in module registry ════════════════════════════════════════════════

const builtins = {
    'path': path,
    'fs': fs,
    'os': nodeOs,
    'buffer': bufferModule,
    'events': eventsModule,
    'util': util,
    'assert': assertModule,
    'stream': streamModule,
    'node:path': path,
    'node:fs': fs,
    'node:os': nodeOs,
    'node:buffer': bufferModule,
    'node:events': eventsModule,
    'node:util': util,
    'node:assert': assertModule,
    'node:stream': streamModule,
};

// ═══ Module loader (CommonJS require) ════════════════════════════════════════

const moduleCache = new Map();
let entryModule = null;

function currentCwd() {
    if (!os.getcwd) return '/';
    const r = os.getcwd();
    if (Array.isArray(r)) {
        const [c, err] = r;
        return (!err && c) ? c : '/';
    }
    return r || '/';
}

function isFile(p) {
    // Must distinguish a regular file from a directory. std.open(p, "r") is not
    // enough: on WASI a directory opens cleanly, which would make a node_modules
    // package directory look like a requirable file and break resolution.
    const [st, err] = os.stat(p);
    if (err) return false;
    return (st.mode & 0o170000) === 0o100000; // (mode & S_IFMT) === S_IFREG
}

function tryRead(p) {
    // std.loadFile returns null on error
    if (std.loadFile) return std.loadFile(p);
    const f = std.open(p, "r");
    if (!f) return null;
    const s = f.readAsString();
    f.close();
    return s;
}

function resolveAsFile(base) {
    const candidates = [base, base + '.js', base + '.json'];
    for (const c of candidates) {
        if (isFile(c)) return c;
    }
    return null;
}

function resolveAsDirectory(base) {
    const pkgPath = base + '/package.json';
    if (isFile(pkgPath)) {
        try {
            const pkg = JSON.parse(tryRead(pkgPath));
            if (pkg && pkg.main) {
                const mainPath = path.join(base, pkg.main);
                const f = resolveAsFile(mainPath);
                if (f) return f;
                const idx = resolveAsFile(path.join(mainPath, 'index'));
                if (idx) return idx;
            }
        } catch (_) { /* fall through */ }
    }
    return resolveAsFile(base + '/index');
}

function resolveNodeModules(name, fromDir) {
    let dir = fromDir;
    while (true) {
        const last = path.basename(dir);
        if (last !== 'node_modules') {
            const candidate = path.join(dir, 'node_modules', name);
            const asFile = resolveAsFile(candidate);
            if (asFile) return asFile;
            const asDir = resolveAsDirectory(candidate);
            if (asDir) return asDir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

function resolveModule(request, fromDir) {
    if (typeof request !== 'string' || !request) {
        const e = new Error(`require(): request must be a non-empty string`);
        e.code = 'ERR_INVALID_ARG_VALUE';
        throw e;
    }
    if (builtins[request] !== undefined) return { builtin: true, id: request };

    if (request.startsWith('/') || request.startsWith('./') || request.startsWith('../')
        || request === '.' || request === '..') {
        const base = request.startsWith('/') ? request : path.join(fromDir, request);
        const asFile = resolveAsFile(base);
        if (asFile) return { builtin: false, id: asFile };
        const asDir = resolveAsDirectory(base);
        if (asDir) return { builtin: false, id: asDir };
        const e = new Error(`Cannot find module '${request}' (from '${fromDir}')`);
        e.code = 'MODULE_NOT_FOUND';
        throw e;
    }

    const nm = resolveNodeModules(request, fromDir);
    if (nm) return { builtin: false, id: nm };

    const e = new Error(`Cannot find module '${request}' (from '${fromDir}')`);
    e.code = 'MODULE_NOT_FOUND';
    throw e;
}

function loadModule(filename, parentModule) {
    if (moduleCache.has(filename)) return moduleCache.get(filename);

    const mod = {
        id: filename,
        filename,
        exports: {},
        loaded: false,
        children: [],
        parent: parentModule || null,
    };
    moduleCache.set(filename, mod);

    if (filename.endsWith('.json')) {
        const src = tryRead(filename);
        if (src === null) {
            moduleCache.delete(filename);
            throw new Error(`Cannot read '${filename}'`);
        }
        try {
            mod.exports = JSON.parse(src);
        } catch (e) {
            moduleCache.delete(filename);
            throw new Error(`Invalid JSON in '${filename}': ${e.message}`);
        }
        mod.loaded = true;
        return mod;
    }

    const src = tryRead(filename);
    if (src === null) {
        moduleCache.delete(filename);
        throw new Error(`Cannot read '${filename}'`);
    }

    const dir = path.dirname(filename);
    const requireFn = makeRequire(dir, mod);

    let fn;
    try {
        fn = new Function('exports', 'require', 'module', '__filename', '__dirname', src);
    } catch (e) {
        moduleCache.delete(filename);
        throw new Error(`Syntax error in '${filename}': ${e.message}`);
    }

    try {
        fn.call(mod.exports, mod.exports, requireFn, mod, filename, dir);
    } catch (e) {
        moduleCache.delete(filename);
        throw e;
    }
    mod.loaded = true;
    return mod;
}

function makeRequire(fromDir, parentModule) {
    function req(request) {
        const resolved = resolveModule(request, fromDir);
        if (resolved.builtin) return builtins[resolved.id];
        const mod = loadModule(resolved.id, parentModule);
        if (parentModule && !parentModule.children.includes(mod)) {
            parentModule.children.push(mod);
        }
        return mod.exports;
    }
    req.cache = moduleCache;
    req.resolve = (request) => {
        const r = resolveModule(request, fromDir);
        return r.id;
    };
    Object.defineProperty(req, 'main', { get: () => entryModule });
    return req;
}

// ═══ Timers / event loop ══════════════════════════════════════════════════════
// QuickJS exposes os.setTimeout/os.clearTimeout, pumped by the C-level
// js_std_loop() that the qjsc-generated main() runs after the top-level module
// body returns. That same loop drains the Promise job queue, so async/await and
// queueMicrotask resolve once the entry script finishes — provided we never call
// os.exit() on the success path (we don't). We layer the Node/browser timer
// globals on top of those primitives.

const _hasOsTimer = typeof os.setTimeout === "function";
const _intervals = new Map();
let _intervalSeq = 1;

function _deferMicrotask(fn) {
    Promise.resolve().then(fn);
}

function _setTimeout(fn, delay, ...args) {
    if (typeof fn !== "function") {
        throw new TypeError("setTimeout: callback must be a function");
    }
    const ms = delay > 0 ? delay : 0;
    const cb = args.length ? () => fn(...args) : fn;
    if (_hasOsTimer) return os.setTimeout(cb, ms);
    // No native timer in this build: best-effort microtask deferral (the delay
    // cannot be honoured without the os poll loop).
    _deferMicrotask(cb);
    return 0;
}

function _clearTimeout(id) {
    if (_hasOsTimer && id != null) os.clearTimeout(id);
}

function _setInterval(fn, delay, ...args) {
    if (typeof fn !== "function") {
        throw new TypeError("setInterval: callback must be a function");
    }
    // An interval re-arms itself each tick, which is impossible without a real
    // timer. Degrade to a no-op (returning an unusable id) rather than spin.
    if (!_hasOsTimer) return 0;
    const ms = delay > 0 ? delay : 0;
    const id = _intervalSeq++;
    const tick = () => {
        if (!_intervals.has(id)) return; // cleared while the timer was pending
        try {
            fn(...args);
        } finally {
            const rec = _intervals.get(id);
            if (rec) rec.handle = os.setTimeout(tick, ms);
        }
    };
    _intervals.set(id, { handle: os.setTimeout(tick, ms) });
    return id;
}

function _clearInterval(id) {
    const rec = _intervals.get(id);
    if (rec) {
        if (_hasOsTimer) os.clearTimeout(rec.handle);
        _intervals.delete(id);
    }
}

function _queueMicrotask(fn) {
    if (typeof fn !== "function") {
        throw new TypeError("queueMicrotask: callback must be a function");
    }
    _deferMicrotask(fn);
}

function installTimerGlobals() {
    globalThis.setTimeout = _setTimeout;
    globalThis.clearTimeout = _clearTimeout;
    globalThis.setInterval = _setInterval;
    globalThis.clearInterval = _clearInterval;
    globalThis.setImmediate = (fn, ...args) => _setTimeout(fn, 0, ...args);
    globalThis.clearImmediate = _clearTimeout;
    globalThis.queueMicrotask = _queueMicrotask;
}

// ═══ Globals ═════════════════════════════════════════════════════════════════

function setupGlobals(entryPath, extraArgs) {
    const env = std.getenviron ? std.getenviron() : {};
    const argv = entryPath
        ? ['nodejs', entryPath, ...(extraArgs || [])]
        : ['nodejs', ...(extraArgs || [])];

    globalThis.process = {
        argv,
        argv0: 'nodejs',
        env,
        platform: 'wasi',
        arch: 'wasm32',
        version: `v${NODE_COMPAT_VERSION}.0.0`,
        versions: { node: `${NODE_COMPAT_VERSION}.0.0`, quickjs: '2024-01-13' },
        pid: 1,
        ppid: 0,
        exit(code) { os.exit(code | 0); },
        cwd() { return currentCwd(); },
        stdout: {
            write(s) { std.out.puts(String(s)); std.out.flush(); return true; },
            isTTY: false,
        },
        stderr: {
            write(s) { std.err.puts(String(s)); std.err.flush(); return true; },
            isTTY: false,
        },
        stdin: { isTTY: false },
        nextTick(fn, ...args) {
            if (typeof fn !== "function") {
                throw new TypeError("process.nextTick: callback must be a function");
            }
            // Deferred as a microtask: runs after the current stack unwinds and
            // before any timer fires. Not a separate higher-priority queue like
            // real Node, but the ordering relative to timers is preserved.
            Promise.resolve().then(() => fn(...args));
        },
        hrtime: (() => {
            const start = Date.now();
            return () => {
                const ms = Date.now() - start;
                return [Math.floor(ms / 1000), (ms % 1000) * 1e6];
            };
        })(),
    };
    globalThis.global = globalThis;
    globalThis.Buffer = Buffer;
    globalThis.TextEncoder = TextEncoder;
    globalThis.TextDecoder = TextDecoder;
    globalThis.atob = bufferModule.atob;
    globalThis.btoa = bufferModule.btoa;
    installTimerGlobals();

    const fromDir = entryPath ? path.dirname(entryPath) : currentCwd();
    if (entryPath) {
        globalThis.__filename = entryPath;
        globalThis.__dirname = fromDir;
    }
    globalThis.require = makeRequire(fromDir, null);
}

// ═══ Command handlers ════════════════════════════════════════════════════════

function printUsage() {
    std.out.puts("WasmHub Node.js Runtime\n");
    std.out.puts("\n");
    std.out.puts("Usage: nodejs-runtime <command> [args...]\n");
    std.out.puts("\n");
    std.out.puts("Commands:\n");
    std.out.puts("  version              Print runtime version info\n");
    std.out.puts("  eval <code>          Evaluate JavaScript (require() available)\n");
    std.out.puts("  run <file> [args]    Execute a JavaScript file with CommonJS require()\n");
    std.out.puts("  env                  Print environment variables\n");
    std.out.puts("  echo [args...]       Print arguments to stdout\n");
    std.out.flush();
}

function printVersion() {
    std.out.puts(`WasmHub Node.js Runtime\n`);
    std.out.puts(`Node.js compat: v${NODE_COMPAT_VERSION}.x\n`);
    std.out.puts(`Engine: ${ENGINE}\n`);
    std.out.puts(`Target: WASI Preview 1\n`);
    std.out.puts(`Features: eval, run, require, filesystem, env, args, stdio, timers, async, buffer\n`);
    std.out.puts(`Built-ins: path, fs, os, buffer, events, util, assert, stream (and node:* aliases)\n`);
    std.out.puts(`Globals: Buffer, TextEncoder, TextDecoder, atob, btoa\n`);
    std.out.flush();
}

function evalCode(code) {
    try {
        const result = (0, eval)(code);
        if (result !== undefined) {
            std.out.puts(String(result) + "\n");
        }
    } catch (e) {
        std.err.puts(`Error: ${e.message || e}\n`);
        if (e.stack) std.err.puts(e.stack + "\n");
        std.err.flush();
        os.exit(1);
    }
    std.out.flush();
}

function runFile(rawPath, extraArgs) {
    const entryPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(rawPath);

    if (!isFile(entryPath)) {
        std.err.puts(`Error: cannot open '${entryPath}'\n`);
        std.err.flush();
        os.exit(1);
    }

    setupGlobals(entryPath, extraArgs);

    const entryDir = path.dirname(entryPath);
    entryModule = {
        id: entryPath,
        filename: entryPath,
        exports: {},
        loaded: false,
        children: [],
        parent: null,
    };
    moduleCache.set(entryPath, entryModule);

    const src = tryRead(entryPath);
    if (src === null) {
        std.err.puts(`Error: cannot read '${entryPath}'\n`);
        std.err.flush();
        os.exit(1);
    }

    const requireFn = makeRequire(entryDir, entryModule);

    try {
        const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', src);
        fn.call(entryModule.exports, entryModule.exports, requireFn, entryModule, entryPath, entryDir);
        entryModule.loaded = true;
    } catch (e) {
        std.err.puts(`Error: ${e.message || e}\n`);
        if (e.stack) std.err.puts(e.stack + "\n");
        std.err.flush();
        os.exit(1);
    }
}

function printEnv() {
    const env = std.getenviron ? std.getenviron() : {};
    for (const [k, v] of Object.entries(env)) {
        std.out.puts(`${k}=${v}\n`);
    }
    std.out.flush();
}

function echo(args) {
    std.out.puts(args.join(" ") + "\n");
    std.out.flush();
}

// QuickJS runs the module body during LINKING before C module init_funcs are
// called, so std.out/std.err are JS_UNDEFINED at that point. Guard the dispatch
// on std.out being truthy so LINKING succeeds; dispatch runs on the EVALUATION
// pass when std/os are fully initialised.
if (std.out) {
    const argv = scriptArgs;
    if (!argv || argv.length < 2) {
        printUsage();
        os.exit(0);
    }

    switch (argv[1]) {
        case "version":
            printVersion();
            break;
        case "eval":
            if (argv.length < 3) {
                std.err.puts("Error: eval requires a code argument\n");
                std.err.flush();
                os.exit(1);
            }
            setupGlobals(null, argv.slice(2));
            evalCode(argv.slice(2).join(" "));
            break;
        case "run":
            if (argv.length < 3) {
                std.err.puts("Error: run requires a file path\n");
                std.err.flush();
                os.exit(1);
            }
            runFile(argv[2], argv.slice(3));
            break;
        case "env":
            printEnv();
            break;
        case "echo":
            echo(argv.slice(2));
            break;
        default:
            std.err.puts(`Unknown command: ${argv[1]}\n`);
            std.err.flush();
            printUsage();
            os.exit(1);
    }
}
