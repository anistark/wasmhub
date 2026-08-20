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
        if (isStdinPath(p)) {
            const input = readStdinBytes();
            return enc ? input.toString(enc) : Buffer.from(input);
        }
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
    // `for await (const chunk of stream)`. Reads in flowing mode and pauses
    // between chunks, so a slow consumer does not buffer the whole source.
    [Symbol.asyncIterator]() {
        const self = this;
        const queue = [];
        let ended = false, failed = null, waiting = null;
        const settle = () => {
            if (!waiting) return;
            if (queue.length > 0) { const w = waiting; waiting = null; w.resolve({ value: queue.shift(), done: false }); }
            else if (failed) { const w = waiting; waiting = null; w.reject(failed); }
            else if (ended) { const w = waiting; waiting = null; w.resolve({ value: undefined, done: true }); }
        };
        this.on("data", (chunk) => { queue.push(chunk); self.pause(); settle(); });
        this.on("end", () => { ended = true; settle(); });
        this.on("error", (err) => { failed = err; settle(); });
        return {
            next() {
                if (queue.length > 0) { self.resume(); return Promise.resolve({ value: queue.shift(), done: false }); }
                if (failed) return Promise.reject(failed);
                if (ended) return Promise.resolve({ value: undefined, done: true });
                self.resume();
                return new Promise((resolve, reject) => { waiting = { resolve, reject }; });
            },
            return() { self.pause(); return Promise.resolve({ value: undefined, done: true }); },
            [Symbol.asyncIterator]() { return this; },
        };
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

// ═══ Standard input ═══════════════════════════════════════════════════════════
// fd 0 can only be drained once, so the bytes are read on first use and kept.
// process.stdin, fs.readFileSync('/dev/stdin') and fs.readFileSync(0) then all
// see the same input whichever one the program reaches for first.

const STDIN_CHUNK = 65536;
let _stdinBytes = null;

function readStdinBytes() {
    if (_stdinBytes) return _stdinBytes;

    const chunks = [];
    let total = 0;
    if (std.in && typeof std.in.read === "function") {
        const tmp = new ArrayBuffer(STDIN_CHUNK);
        for (;;) {
            let n;
            try {
                n = std.in.read(tmp, 0, STDIN_CHUNK);
            } catch (_) {
                break; // an unreadable fd 0 reads as no input, never as a throw
            }
            if (!n || n <= 0) break;
            chunks.push(Buffer.from(tmp.slice(0, n)));
            total += n;
        }
    }
    _stdinBytes = Buffer.concat(chunks, total);
    return _stdinBytes;
}

function isStdinPath(p) {
    return p === 0 || p === "/dev/stdin" || p === "/proc/self/fd/0";
}

/// A Readable over fd 0. The read is deferred to the first consumer, so a
/// program that never touches stdin never blocks on it.
function makeStdinStream() {
    let drained = false;
    const stream = new Readable({
        read() {
            if (drained) return;
            drained = true;
            const data = readStdinBytes();
            if (data.length > 0) this.push(data);
            this.push(null);
        },
    });
    stream.fd = 0;
    stream.isTTY = false;
    return stream;
}

// ═══ Web platform globals (URL, URLSearchParams, crypto, structuredClone) ════

// application/x-www-form-urlencoded serialization (URLSearchParams).
function formEncode(s) {
    return encodeURIComponent(String(s))
        .replace(/[!'()~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
        .replace(/%20/g, '+');
}

function formDecode(s) {
    try {
        return decodeURIComponent(String(s).replace(/\+/g, ' '));
    } catch (_) {
        return String(s).replace(/\+/g, ' ');
    }
}

class URLSearchParams {
    constructor(init) {
        this._pairs = [];
        this._url = null;
        if (init == null) return;
        if (typeof init === 'string') {
            this._parseQuery(init.startsWith('?') ? init.slice(1) : init);
        } else if (init instanceof URLSearchParams) {
            this._pairs = init._pairs.map(p => [p[0], p[1]]);
        } else if (typeof init[Symbol.iterator] === 'function') {
            for (const pair of init) {
                if (pair == null || pair.length !== 2) {
                    throw new TypeError('URLSearchParams: each init pair must have exactly two elements');
                }
                this._pairs.push([String(pair[0]), String(pair[1])]);
            }
        } else if (typeof init === 'object') {
            for (const k of Object.keys(init)) {
                this._pairs.push([k, String(init[k])]);
            }
        } else {
            throw new TypeError('URLSearchParams: unsupported init value');
        }
    }

    _parseQuery(qs) {
        for (const part of String(qs).split('&')) {
            if (!part) continue;
            const i = part.indexOf('=');
            if (i < 0) this._pairs.push([formDecode(part), '']);
            else this._pairs.push([formDecode(part.slice(0, i)), formDecode(part.slice(i + 1))]);
        }
    }

    // Write the serialized form back into the owning URL's query (if any).
    _sync() {
        if (this._url) this._url._query = this._pairs.length ? this.toString() : null;
    }

    append(name, value) {
        this._pairs.push([String(name), String(value)]);
        this._sync();
    }

    delete(name, value) {
        name = String(name);
        this._pairs = this._pairs.filter(p =>
            p[0] !== name || (value !== undefined && p[1] !== String(value)));
        this._sync();
    }

    get(name) {
        name = String(name);
        const p = this._pairs.find(p => p[0] === name);
        return p ? p[1] : null;
    }

    getAll(name) {
        name = String(name);
        return this._pairs.filter(p => p[0] === name).map(p => p[1]);
    }

    has(name, value) {
        name = String(name);
        return this._pairs.some(p =>
            p[0] === name && (value === undefined || p[1] === String(value)));
    }

    set(name, value) {
        name = String(name);
        value = String(value);
        const idx = this._pairs.findIndex(p => p[0] === name);
        if (idx < 0) {
            this._pairs.push([name, value]);
        } else {
            this._pairs[idx] = [name, value];
            this._pairs = this._pairs.filter((p, i) => i <= idx || p[0] !== name);
        }
        this._sync();
    }

    sort() {
        // Stable sort by name only, preserving relative value order per name.
        this._pairs = this._pairs
            .map((p, i) => [p, i])
            .sort((a, b) => (a[0][0] < b[0][0] ? -1 : a[0][0] > b[0][0] ? 1 : a[1] - b[1]))
            .map(x => x[0]);
        this._sync();
    }

    forEach(fn, thisArg) {
        for (const [k, v] of this._pairs.slice()) fn.call(thisArg, v, k, this);
    }

    get size() {
        return this._pairs.length;
    }

    *keys() { for (const p of this._pairs.slice()) yield p[0]; }
    *values() { for (const p of this._pairs.slice()) yield p[1]; }
    *entries() { for (const p of this._pairs.slice()) yield [p[0], p[1]]; }
    [Symbol.iterator]() { return this.entries(); }

    toString() {
        return this._pairs.map(p => formEncode(p[0]) + '=' + formEncode(p[1])).join('&');
    }
}

const SPECIAL_PORTS = { http: '80', https: '443', ws: '80', wss: '443', ftp: '21' };

// RFC 3986 §5.2.4 remove_dot_segments.
function removeDotSegments(p) {
    let input = p;
    const output = [];
    while (input.length) {
        if (input.startsWith('../')) input = input.slice(3);
        else if (input.startsWith('./')) input = input.slice(2);
        else if (input.startsWith('/./')) input = '/' + input.slice(3);
        else if (input === '/.') input = '/';
        else if (input.startsWith('/../')) { input = '/' + input.slice(4); output.pop(); }
        else if (input === '/..') { input = '/'; output.pop(); }
        else if (input === '.' || input === '..') input = '';
        else {
            let i = input.indexOf('/', 1);
            if (i < 0) { output.push(input); input = ''; }
            else { output.push(input.slice(0, i)); input = input.slice(i); }
        }
    }
    return output.join('');
}

function parseAuthority(url, authority) {
    const atIdx = authority.lastIndexOf('@');
    if (atIdx >= 0) {
        const userinfo = authority.slice(0, atIdx);
        const colonIdx = userinfo.indexOf(':');
        if (colonIdx >= 0) {
            url._username = userinfo.slice(0, colonIdx);
            url._password = userinfo.slice(colonIdx + 1);
        } else {
            url._username = userinfo;
        }
        authority = authority.slice(atIdx + 1);
    }
    if (authority.startsWith('[')) {
        const close = authority.indexOf(']');
        if (close < 0) return false;
        url._host = authority.slice(0, close + 1).toLowerCase();
        const after = authority.slice(close + 1);
        if (after) {
            if (!after.startsWith(':')) return false;
            url._port = after.slice(1);
        }
    } else {
        const colonIdx = authority.lastIndexOf(':');
        if (colonIdx >= 0) {
            url._host = authority.slice(0, colonIdx).toLowerCase();
            url._port = authority.slice(colonIdx + 1);
        } else {
            url._host = authority.toLowerCase();
        }
    }
    if (url._port) {
        if (!/^\d+$/.test(url._port) || Number(url._port) > 65535) return false;
        if (SPECIAL_PORTS[url._scheme] === url._port) url._port = '';
    }
    return true;
}

class URL {
    constructor(input, base) {
        input = String(input).trim();
        this._scheme = '';
        this._username = '';
        this._password = '';
        this._host = '';
        this._port = '';
        this._path = '';
        this._query = null;
        this._fragment = null;
        this._hasAuthority = false;

        if (!this._parseAbsolute(input)) {
            if (base === undefined) {
                throw new TypeError(`Invalid URL: ${input}`);
            }
            const b = base instanceof URL ? base : new URL(String(base));
            this._resolveRelative(input, b);
        }
        this._params = null;
    }

    _parseAbsolute(input) {
        const m = /^([a-zA-Z][a-zA-Z0-9+.\-]*):([\s\S]*)$/.exec(input);
        if (!m) return false;
        this._scheme = m[1].toLowerCase();
        let rest = m[2];

        const hashIdx = rest.indexOf('#');
        if (hashIdx >= 0) { this._fragment = rest.slice(hashIdx + 1); rest = rest.slice(0, hashIdx); }
        const qIdx = rest.indexOf('?');
        if (qIdx >= 0) { this._query = rest.slice(qIdx + 1); rest = rest.slice(0, qIdx); }

        const special = SPECIAL_PORTS[this._scheme] !== undefined || this._scheme === 'file';
        if (rest.startsWith('//')) {
            rest = rest.slice(2);
            const slashIdx = rest.indexOf('/');
            const authority = slashIdx < 0 ? rest : rest.slice(0, slashIdx);
            const path = slashIdx < 0 ? '' : rest.slice(slashIdx);
            if (!parseAuthority(this, authority)) throw new TypeError(`Invalid URL: ${input}`);
            if (special && this._scheme !== 'file' && !this._host) {
                throw new TypeError(`Invalid URL: ${input}`);
            }
            this._hasAuthority = true;
            this._path = removeDotSegments(path.replace(/ /g, '%20')) || '/';
        } else {
            this._path = special
                ? removeDotSegments(rest.replace(/ /g, '%20'))
                : rest.replace(/ /g, '%20');
        }
        return true;
    }

    _resolveRelative(input, base) {
        this._scheme = base._scheme;
        this._username = base._username;
        this._password = base._password;
        this._host = base._host;
        this._port = base._port;
        this._hasAuthority = base._hasAuthority;

        let rest = input;
        const hashIdx = rest.indexOf('#');
        if (hashIdx >= 0) { this._fragment = rest.slice(hashIdx + 1); rest = rest.slice(0, hashIdx); }

        if (!rest) {
            this._path = base._path;
            this._query = base._query;
            return;
        }

        const qIdx = rest.indexOf('?');
        if (qIdx >= 0) { this._query = rest.slice(qIdx + 1); rest = rest.slice(0, qIdx); }

        if (!rest) {
            this._path = base._path;
            if (qIdx < 0) this._query = base._query;
            return;
        }

        rest = rest.replace(/ /g, '%20');
        if (rest.startsWith('//')) {
            rest = rest.slice(2);
            const slashIdx = rest.indexOf('/');
            const authority = slashIdx < 0 ? rest : rest.slice(0, slashIdx);
            const path = slashIdx < 0 ? '' : rest.slice(slashIdx);
            this._username = '';
            this._password = '';
            this._host = '';
            this._port = '';
            if (!parseAuthority(this, authority)) throw new TypeError(`Invalid URL: ${input}`);
            this._hasAuthority = true;
            this._path = removeDotSegments(path) || '/';
        } else if (rest.startsWith('/')) {
            this._path = removeDotSegments(rest);
        } else {
            const basePath = base._path;
            const lastSlash = basePath.lastIndexOf('/');
            const merged = lastSlash < 0 ? rest : basePath.slice(0, lastSlash + 1) + rest;
            this._path = removeDotSegments(merged);
        }
        if (this._hasAuthority && !this._path) this._path = '/';
    }

    _serialize() {
        let s = this._scheme + ':';
        if (this._hasAuthority) {
            s += '//';
            if (this._username || this._password) {
                s += this._username;
                if (this._password) s += ':' + this._password;
                s += '@';
            }
            s += this._host;
            if (this._port) s += ':' + this._port;
        }
        s += this._path;
        if (this._query != null && this._query !== '') s += '?' + this._query;
        if (this._fragment != null && this._fragment !== '') s += '#' + this._fragment;
        return s;
    }

    get href() { return this._serialize(); }
    set href(v) {
        const u = new URL(String(v));
        this._scheme = u._scheme;
        this._username = u._username;
        this._password = u._password;
        this._host = u._host;
        this._port = u._port;
        this._path = u._path;
        this._query = u._query;
        this._fragment = u._fragment;
        this._hasAuthority = u._hasAuthority;
        this._refreshParams();
    }

    get protocol() { return this._scheme + ':'; }
    set protocol(v) {
        const m = /^([a-zA-Z][a-zA-Z0-9+.\-]*):?$/.exec(String(v));
        if (m) this._scheme = m[1].toLowerCase();
    }

    get origin() {
        if (SPECIAL_PORTS[this._scheme] !== undefined) {
            return `${this._scheme}://${this._host}${this._port ? ':' + this._port : ''}`;
        }
        return 'null';
    }

    get username() { return this._username; }
    set username(v) { if (this._hasAuthority) this._username = String(v); }

    get password() { return this._password; }
    set password(v) { if (this._hasAuthority) this._password = String(v); }

    get host() { return this._port ? `${this._host}:${this._port}` : this._host; }
    set host(v) {
        v = String(v);
        if (!this._hasAuthority || !v) return;
        parseAuthority(this, v);
    }

    get hostname() { return this._host; }
    set hostname(v) {
        v = String(v).toLowerCase();
        if (this._hasAuthority && v) this._host = v;
    }

    get port() { return this._port; }
    set port(v) {
        v = String(v);
        if (v === '') { this._port = ''; return; }
        if (/^\d+$/.test(v) && Number(v) <= 65535) {
            this._port = SPECIAL_PORTS[this._scheme] === v ? '' : v;
        }
    }

    get pathname() { return this._path; }
    set pathname(v) {
        v = String(v).replace(/ /g, '%20');
        if (!v.startsWith('/') && this._hasAuthority) v = '/' + v;
        this._path = removeDotSegments(v);
    }

    get search() { return this._query ? '?' + this._query : ''; }
    set search(v) {
        v = String(v);
        if (v.startsWith('?')) v = v.slice(1);
        this._query = v === '' ? null : v.replace(/ /g, '%20');
        this._refreshParams();
    }

    get searchParams() {
        if (!this._params) {
            this._params = new URLSearchParams(this._query || '');
            this._params._url = this;
        }
        return this._params;
    }

    _refreshParams() {
        if (this._params) {
            this._params._pairs = [];
            if (this._query) this._params._parseQuery(this._query);
        }
    }

    get hash() { return this._fragment ? '#' + this._fragment : ''; }
    set hash(v) {
        v = String(v);
        if (v.startsWith('#')) v = v.slice(1);
        this._fragment = v === '' ? null : v;
    }

    toString() { return this._serialize(); }
    toJSON() { return this._serialize(); }

    static canParse(input, base) {
        try { new URL(input, base); return true; } catch (_) { return false; }
    }
}

// ═══ crypto (getRandomValues / randomUUID) ═══════════════════════════════════
// Entropy comes from os.getentropy — a wasmhub build patch that wires
// quickjs-libc to wasi-libc getentropy(), i.e. the WASI random_get syscall.
// Interpreter-only builds without the patch fall back to Math.random.

function fillRandomBytes(bytes) {
    if (typeof os.getentropy === 'function') {
        bytes.set(new Uint8Array(os.getentropy(bytes.length)));
        return;
    }
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
}

function namedError(name, message) {
    const e = new Error(message);
    e.name = name;
    return e;
}

const webCrypto = {
    getRandomValues(view) {
        if (!ArrayBuffer.isView(view)) {
            throw new TypeError('crypto.getRandomValues: argument must be an integer TypedArray');
        }
        if (view instanceof Float32Array || view instanceof Float64Array) {
            throw namedError('TypeMismatchError', 'crypto.getRandomValues: float arrays are not supported');
        }
        if (view.byteLength > 65536) {
            throw namedError('QuotaExceededError', 'crypto.getRandomValues: byteLength must not exceed 65536');
        }
        fillRandomBytes(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
        return view;
    },

    randomUUID() {
        const b = new Uint8Array(16);
        fillRandomBytes(b);
        b[6] = (b[6] & 0x0f) | 0x40; // version 4
        b[8] = (b[8] & 0x3f) | 0x80; // variant 10
        const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    },
};

// ═══ structuredClone ══════════════════════════════════════════════════════════

function structuredCloneImpl(value, options) {
    if (options && options.transfer && options.transfer.length) {
        throw namedError('DataCloneError', 'structuredClone: transfer is not supported in this runtime');
    }
    const seen = new Map();

    function clone(v) {
        if (v === null || (typeof v !== 'object' && typeof v !== 'function' && typeof v !== 'symbol')) {
            return v;
        }
        if (typeof v === 'function') {
            throw namedError('DataCloneError', 'structuredClone: function could not be cloned');
        }
        if (typeof v === 'symbol') {
            throw namedError('DataCloneError', 'structuredClone: symbol could not be cloned');
        }
        if (seen.has(v)) return seen.get(v);

        if (v instanceof Date) { const c = new Date(v.getTime()); seen.set(v, c); return c; }
        if (v instanceof RegExp) { const c = new RegExp(v.source, v.flags); seen.set(v, c); return c; }
        if (v instanceof ArrayBuffer) { const c = v.slice(0); seen.set(v, c); return c; }
        if (ArrayBuffer.isView(v)) {
            const buf = clone(v.buffer);
            const c = v instanceof DataView
                ? new DataView(buf, v.byteOffset, v.byteLength)
                : new v.constructor(buf, v.byteOffset, v.length);
            seen.set(v, c);
            return c;
        }
        if (v instanceof Map) {
            const c = new Map();
            seen.set(v, c);
            for (const [k, val] of v) c.set(clone(k), clone(val));
            return c;
        }
        if (v instanceof Set) {
            const c = new Set();
            seen.set(v, c);
            for (const val of v) c.add(clone(val));
            return c;
        }
        if (v instanceof Error) {
            const Ctor = typeof v.constructor === 'function' ? v.constructor : Error;
            let c;
            try { c = new Ctor(v.message); } catch (_) { c = new Error(v.message); }
            c.name = v.name;
            if (typeof v.stack === 'string') c.stack = v.stack;
            seen.set(v, c);
            return c;
        }
        if (v instanceof Promise) {
            throw namedError('DataCloneError', 'structuredClone: Promise could not be cloned');
        }
        if (v instanceof Boolean || v instanceof Number || v instanceof String) {
            const c = Object(v.valueOf());
            seen.set(v, c);
            return c;
        }
        if (Array.isArray(v)) {
            const c = [];
            seen.set(v, c);
            for (let i = 0; i < v.length; i++) {
                if (i in v) c[i] = clone(v[i]);
            }
            return c;
        }
        // Everything else clones as a plain object of its own enumerable
        // string-keyed properties (prototypes are not preserved, per spec).
        const c = {};
        seen.set(v, c);
        for (const k of Object.keys(v)) c[k] = clone(v[k]);
        return c;
    }

    return clone(value);
}

// ═══ fetch (unsupported — clear error instead of ReferenceError) ══════════════

function fetchUnsupported() {
    const e = new TypeError(
        'fetch: network access is not supported in this WASI runtime yet — ' +
        'the sandbox has no socket syscalls. HTTP requests from sandboxed code ' +
        'arrive with the wasmnet networking milestone.'
    );
    e.code = 'ERR_NETWORK_UNSUPPORTED';
    return Promise.reject(e);
}

function installWebGlobals() {
    globalThis.URL = URL;
    globalThis.URLSearchParams = URLSearchParams;
    globalThis.crypto = webCrypto;
    globalThis.structuredClone = structuredCloneImpl;
    globalThis.fetch = fetchUnsupported;
}

// ═══ querystring ══════════════════════════════════════════════════════════════

function qsStringifyPrimitive(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && isFinite(v)) return String(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'bigint') return String(v);
    return '';
}

// encodeURIComponent leaves !'()* alone; node's querystring escapes them.
function qsEscape(str) {
    return encodeURIComponent(String(str)).replace(
        /[!'()*]/g,
        c => '%' + c.charCodeAt(0).toString(16).toUpperCase()
    );
}

function qsUnescape(str) {
    // node falls back to the raw text rather than throwing.
    try { return decodeURIComponent(String(str).replace(/\+/g, ' ')); }
    catch (e) { return String(str).replace(/\+/g, ' '); }
}

const querystring = {
    escape: qsEscape,
    unescape: qsUnescape,

    stringify(obj, sep, eq) {
        sep = sep || '&';
        eq = eq || '=';
        if (!obj || typeof obj !== 'object') return '';
        const parts = [];
        for (const key of Object.keys(obj)) {
            const k = qsEscape(key);
            const v = obj[key];
            if (Array.isArray(v)) {
                for (const item of v) parts.push(k + eq + qsEscape(qsStringifyPrimitive(item)));
            } else {
                parts.push(k + eq + qsEscape(qsStringifyPrimitive(v)));
            }
        }
        return parts.join(sep);
    },

    parse(str, sep, eq) {
        sep = sep || '&';
        eq = eq || '=';
        // Null-prototype, like node: "__proto__" must not poison the result.
        const out = Object.create(null);
        if (typeof str !== 'string' || str.length === 0) return out;
        for (const pair of str.split(sep)) {
            if (!pair) continue;
            const idx = pair.indexOf(eq);
            const k = qsUnescape(idx === -1 ? pair : pair.slice(0, idx));
            const v = idx === -1 ? '' : qsUnescape(pair.slice(idx + eq.length));
            if (out[k] === undefined) out[k] = v;
            else if (Array.isArray(out[k])) out[k].push(v);
            else out[k] = [out[k], v];
        }
        return out;
    },
};
querystring.encode = querystring.stringify;
querystring.decode = querystring.parse;

// ═══ string_decoder ═══════════════════════════════════════════════════════════
// Decodes byte chunks without splitting a character across a chunk boundary:
// incomplete trailing bytes are held back until the rest arrives.

/// Longest prefix of `bytes` ending on a complete UTF-8 character.
function utf8CompleteLength(bytes) {
    let i = bytes.length;
    let trailing = 0;
    while (i > 0 && trailing < 4) {
        i--;
        trailing++;
        const b = bytes[i];
        if ((b & 0xC0) === 0x80) continue; // continuation byte, keep scanning back
        let need = 1;
        if ((b & 0xE0) === 0xC0) need = 2;
        else if ((b & 0xF0) === 0xE0) need = 3;
        else if ((b & 0xF8) === 0xF0) need = 4;
        return trailing >= need ? bytes.length : i;
    }
    return bytes.length;
}

class StringDecoder {
    constructor(encoding) {
        this.encoding = String(encoding || 'utf8').toLowerCase().replace(/[-_]/g, '');
        if (this.encoding === 'utf8' || this.encoding === 'utf-8') this.encoding = 'utf8';
        this._held = new Uint8Array(0);
    }

    write(chunk) {
        if (typeof chunk === 'string') return chunk;
        let bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        if (this._held.length > 0) {
            const joined = new Uint8Array(this._held.length + bytes.length);
            joined.set(this._held, 0);
            joined.set(bytes, this._held.length);
            bytes = joined;
            this._held = new Uint8Array(0);
        }
        let take = bytes.length;
        if (this.encoding === 'utf8') {
            take = utf8CompleteLength(bytes);
        } else if (this.encoding === 'base64') {
            // A partial group would encode padding the next chunk invalidates.
            take = bytes.length - (bytes.length % 3);
        } else if (this.encoding === 'utf16le' || this.encoding === 'ucs2') {
            take = bytes.length - (bytes.length % 2);
        }
        if (take < bytes.length) this._held = bytes.slice(take);
        return Buffer.from(bytes.slice(0, take)).toString(this.encoding);
    }

    end(chunk) {
        let out = chunk !== undefined && chunk !== null ? this.write(chunk) : '';
        if (this._held.length > 0) {
            // Emit the incomplete tail rather than dropping input, like node.
            out += Buffer.from(this._held).toString(this.encoding);
            this._held = new Uint8Array(0);
        }
        return out;
    }
}

const stringDecoderModule = { StringDecoder };

// ═══ url module ═══════════════════════════════════════════════════════════════
// Exposes the WHATWG globals under the module name, plus the legacy API.

function fileURLToPath(input) {
    const u = typeof input === 'string' ? new URL(input) : input;
    if (u.protocol !== 'file:') {
        const e = new TypeError('The URL must be of scheme file');
        e.code = 'ERR_INVALID_URL_SCHEME';
        throw e;
    }
    return decodeURIComponent(u.pathname);
}

function pathToFileURL(p) {
    const encoded = String(p).split('/').map(encodeURIComponent).join('/');
    return new URL('file://' + (encoded.startsWith('/') ? '' : '/') + encoded);
}

const urlModule = {
    URL,
    URLSearchParams,
    fileURLToPath,
    pathToFileURL,

    /// Legacy flat shape, built from the WHATWG parser so the two agree.
    parse(input, parseQueryString) {
        let u;
        try {
            u = new URL(input);
        } catch (e) {
            // Legacy parse accepts relative URLs; the WHATWG one does not.
            u = new URL(input, 'http://localhost');
            u = { protocol: null, host: null, hostname: null, port: '', username: '', password: '',
                  pathname: u.pathname, search: u.search, hash: u.hash };
        }
        const search = u.search || null;
        const query = parseQueryString
            ? querystring.parse((search || '').replace(/^\?/, ''))
            : (search ? search.replace(/^\?/, '') : null);
        const auth = u.username ? (u.password ? `${u.username}:${u.password}` : u.username) : null;
        return {
            protocol: u.protocol || null,
            slashes: u.protocol ? true : null,
            auth,
            host: u.host || null,
            port: u.port || null,
            hostname: u.hostname || null,
            hash: u.hash || null,
            search,
            query,
            pathname: u.pathname || null,
            path: (u.pathname || '') + (search || '') || null,
            href: u.href !== undefined ? u.href : null,
        };
    },

    format(input) {
        if (typeof input === 'string') return input;
        if (input instanceof URL) return input.href;
        const protocol = input.protocol ? (input.protocol.endsWith(':') ? input.protocol : input.protocol + ':') : '';
        const host = input.host || (input.hostname ? input.hostname + (input.port ? ':' + input.port : '') : '');
        const auth = input.auth ? input.auth + '@' : '';
        const pathname = input.pathname || '';
        let search = input.search || '';
        if (!search && input.query) {
            search = typeof input.query === 'string' ? '?' + input.query : '?' + querystring.stringify(input.query);
        }
        const hash = input.hash ? (input.hash.startsWith('#') ? input.hash : '#' + input.hash) : '';
        const slashes = protocol && host ? '//' : '';
        return protocol + slashes + auth + host + pathname + search + hash;
    },

    resolve(from, to) {
        return new URL(to, from).href;
    },

    // No IDNA table here; nothing reachable from the sandbox needs one.
    domainToASCII(d) { return String(d).toLowerCase(); },
    domainToUnicode(d) { return String(d); },
};

// ═══ Hashes (sha256 / sha1 / md5) ═════════════════════════════════════════════
// Self-contained: there is no libcrypto, and createHash is too common to omit.

const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/// The 0x80 marker and 64-bit length shared by all three hashes here.
/// `bigEndian` is false only for md5.
function padMessage(bytes, bigEndian) {
    const bitLen = bytes.length * 8;
    const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
    padded.set(bytes, 0);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    if (bigEndian) view.setUint32(padded.length - 4, bitLen >>> 0, false);
    else view.setUint32(padded.length - 8, bitLen >>> 0, true);
    return padded;
}

function sha256(bytes) {
    const h = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const padded = padMessage(bytes, true);
    const view = new DataView(padded.buffer);
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));

    for (let off = 0; off < padded.length; off += 64) {
        for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, hh] = h;
        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            hh = g; g = f; f = e;
            e = (d + t1) >>> 0;
            d = c; c = b; b = a;
            a = (t1 + t2) >>> 0;
        }
        h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
        h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    const out = new Uint8Array(32);
    const ov = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i], false);
    return out;
}

function sha1(bytes) {
    const h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
    const padded = padMessage(bytes, true);
    const view = new DataView(padded.buffer);
    const w = new Uint32Array(80);
    const rotl = (x, n) => (x << n) | (x >>> (32 - n));

    for (let off = 0; off < padded.length; off += 64) {
        for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
        for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
        let [a, b, c, d, e] = h;
        for (let i = 0; i < 80; i++) {
            let f, k;
            if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
            else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
            else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
            else { f = b ^ c ^ d; k = 0xca62c1d6; }
            const t = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
            e = d; d = c; c = rotl(b, 30) >>> 0; b = a; a = t;
        }
        h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0;
        h[3] = (h[3] + d) >>> 0; h[4] = (h[4] + e) >>> 0;
    }
    const out = new Uint8Array(20);
    const ov = new DataView(out.buffer);
    for (let i = 0; i < 5; i++) ov.setUint32(i * 4, h[i], false);
    return out;
}

const MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = new Uint32Array(
    Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296))
);

function md5(bytes) {
    let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
    const padded = padMessage(bytes, false);
    const view = new DataView(padded.buffer);
    const m = new Uint32Array(16);
    const rotl = (x, n) => (x << n) | (x >>> (32 - n));

    for (let off = 0; off < padded.length; off += 64) {
        for (let i = 0; i < 16; i++) m[i] = view.getUint32(off + i * 4, true);
        let [a, b, c, d] = [a0, b0, c0, d0];
        for (let i = 0; i < 64; i++) {
            let f, g;
            if (i < 16) { f = (b & c) | (~b & d); g = i; }
            else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
            else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
            else { f = c ^ (b | ~d); g = (7 * i) % 16; }
            f = (f + a + MD5_K[i] + m[g]) >>> 0;
            a = d; d = c; c = b;
            b = (b + rotl(f, MD5_S[i])) >>> 0;
        }
        a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
    }
    const out = new Uint8Array(16);
    const ov = new DataView(out.buffer);
    ov.setUint32(0, a0, true); ov.setUint32(4, b0, true);
    ov.setUint32(8, c0, true); ov.setUint32(12, d0, true);
    return out;
}

const HASH_ALGORITHMS = {
    sha256: { fn: sha256, blockSize: 64 },
    sha1: { fn: sha1, blockSize: 64 },
    md5: { fn: md5, blockSize: 64 },
};

// ═══ crypto module ════════════════════════════════════════════════════════════

function toBytes(data, encoding) {
    if (typeof data === 'string') return new Uint8Array(Buffer.from(data, encoding || 'utf8'));
    if (data instanceof Uint8Array) return data;
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    throw new TypeError('data must be a string, Buffer, or TypedArray');
}

function digestTo(bytes, encoding) {
    const buf = Buffer.from(bytes);
    return encoding ? buf.toString(encoding) : buf;
}

function resolveAlgorithm(algorithm) {
    const key = String(algorithm).toLowerCase().replace(/-/g, '');
    const spec = HASH_ALGORITHMS[key];
    if (!spec) {
        const e = new Error(
            `Digest method '${algorithm}' is not supported; available: ${Object.keys(HASH_ALGORITHMS).join(', ')}`
        );
        e.code = 'ERR_CRYPTO_INVALID_DIGEST';
        throw e;
    }
    return spec;
}

class Hash {
    constructor(algorithm) {
        this._spec = resolveAlgorithm(algorithm);
        this._chunks = [];
    }
    update(data, encoding) {
        this._chunks.push(toBytes(data, encoding));
        return this;
    }
    digest(encoding) {
        let total = 0;
        for (const c of this._chunks) total += c.length;
        const all = new Uint8Array(total);
        let at = 0;
        for (const c of this._chunks) { all.set(c, at); at += c.length; }
        return digestTo(this._spec.fn(all), encoding);
    }
}

class Hmac {
    constructor(algorithm, key) {
        this._spec = resolveAlgorithm(algorithm);
        const block = this._spec.blockSize;
        let k = toBytes(key);
        if (k.length > block) k = this._spec.fn(k);
        const padded = new Uint8Array(block);
        padded.set(k, 0);
        this._outer = new Uint8Array(block);
        this._inner = new Uint8Array(block);
        for (let i = 0; i < block; i++) {
            this._outer[i] = padded[i] ^ 0x5c;
            this._inner[i] = padded[i] ^ 0x36;
        }
        this._chunks = [this._inner];
    }
    update(data, encoding) {
        this._chunks.push(toBytes(data, encoding));
        return this;
    }
    digest(encoding) {
        let total = 0;
        for (const c of this._chunks) total += c.length;
        const all = new Uint8Array(total);
        let at = 0;
        for (const c of this._chunks) { all.set(c, at); at += c.length; }
        const innerDigest = this._spec.fn(all);
        const outer = new Uint8Array(this._outer.length + innerDigest.length);
        outer.set(this._outer, 0);
        outer.set(innerDigest, this._outer.length);
        return digestTo(this._spec.fn(outer), encoding);
    }
}

const nodeCrypto = {
    webcrypto: webCrypto,
    getRandomValues: view => webCrypto.getRandomValues(view),
    randomUUID: () => webCrypto.randomUUID(),

    randomBytes(size, callback) {
        const b = new Uint8Array(size);
        fillRandomBytes(b);
        const buf = Buffer.from(b);
        if (typeof callback === 'function') {
            // node defers the callback; match its ordering.
            queueMicrotask(() => callback(null, buf));
            return undefined;
        }
        return buf;
    },

    randomFillSync(view) {
        return webCrypto.getRandomValues(view);
    },

    randomInt(min, max) {
        if (max === undefined) { max = min; min = 0; }
        const range = max - min;
        if (range <= 0) throw new RangeError('max must be greater than min');
        // Rejection sampling: a plain modulus would skew toward the low end.
        const bytes = new Uint8Array(6);
        const limit = Math.floor(281474976710655 / range) * range;
        let value;
        do {
            fillRandomBytes(bytes);
            value = 0;
            for (let i = 0; i < 6; i++) value = value * 256 + bytes[i];
        } while (value >= limit);
        return min + (value % range);
    },

    createHash(algorithm) { return new Hash(algorithm); },
    createHmac(algorithm, key) { return new Hmac(algorithm, key); },

    timingSafeEqual(a, b) {
        const x = toBytes(a);
        const y = toBytes(b);
        if (x.length !== y.length) throw new RangeError('Input buffers must have the same byte length');
        let diff = 0;
        for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
        return diff === 0;
    },

    getHashes() { return Object.keys(HASH_ALGORITHMS); },

    Hash,
    Hmac,
};

// ═══ fs/promises ══════════════════════════════════════════════════════════════
// Wrappers over the sync calls: WASI Preview 1 has no async I/O, but the
// promise API is what modern code reaches for.

function asPromise(fn) {
    return function (...args) {
        try { return Promise.resolve(fn(...args)); }
        catch (e) { return Promise.reject(e); }
    };
}

const fsPromises = {
    readFile: asPromise((p, o) => fs.readFileSync(p, o)),
    writeFile: asPromise((p, d, o) => fs.writeFileSync(p, d, o)),
    appendFile: asPromise((p, d, o) => fs.appendFileSync(p, d, o)),
    mkdir: asPromise((p, o) => fs.mkdirSync(p, o)),
    readdir: asPromise((p, o) => fs.readdirSync(p, o)),
    stat: asPromise(p => fs.statSync(p)),
    lstat: asPromise(p => fs.statSync(p)),
    unlink: asPromise(p => fs.unlinkSync(p)),
    rm: asPromise((p, o) => fs.rmSync(p, o)),
    rmdir: asPromise(p => fs.rmSync(p)),
    rename: asPromise((a, b) => fs.renameSync(a, b)),
    realpath: asPromise(p => fs.realpathSync(p)),
    copyFile: asPromise((a, b) => fs.writeFileSync(b, fs.readFileSync(a))),

    access(p) {
        return fs.existsSync(p)
            ? Promise.resolve()
            : Promise.reject(fsError('ENOENT', 'no such file or directory', p));
    },
};

fs.promises = fsPromises;

// ═══ timers / timers/promises ═════════════════════════════════════════════════

const timersModule = {
    setTimeout: (...a) => setTimeout(...a),
    clearTimeout: (...a) => clearTimeout(...a),
    setInterval: (...a) => setInterval(...a),
    clearInterval: (...a) => clearInterval(...a),
    setImmediate: (...a) => setImmediate(...a),
    clearImmediate: (...a) => clearImmediate(...a),
};

const timersPromises = {
    setTimeout(ms, value) {
        return new Promise(resolve => setTimeout(() => resolve(value), ms));
    },
    setImmediate(value) {
        return new Promise(resolve => setImmediate(() => resolve(value)));
    },
    async *setInterval(ms, value) {
        // Yields forever; breaking out of the for-await clears the timer.
        while (true) {
            await new Promise(resolve => setTimeout(resolve, ms));
            yield value;
        }
    },
    scheduler: {
        wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); },
    },
};

// ═══ node:test ════════════════════════════════════════════════════════════════
// Registration is synchronous, the run starts once the entry module's body has
// returned, and the report is TAP 13 shaped like Node's own so existing parsers
// read it.

const _testRun = {
    stack: [],
    scheduled: false,
    counts: { tests: 0, suites: 0, pass: 0, fail: 0, skipped: 0, todo: 0 },
};

function _newSuite(name) {
    return {
        kind: 'suite',
        name,
        children: [],
        hooks: { before: [], after: [], beforeEach: [], afterEach: [] },
        skip: false,
        todo: false,
    };
}

_testRun.root = _newSuite('');

function _currentSuite() {
    return _testRun.stack.length ? _testRun.stack[_testRun.stack.length - 1] : _testRun.root;
}

function _testWrite(text) {
    if (globalThis.process && process.stdout && typeof process.stdout.write === 'function') {
        process.stdout.write(text);
        return;
    }
    std.out.puts(text);
    std.out.flush();
}

function _indent(depth) { return '    '.repeat(depth); }

function _parseTestArgs(args) {
    let name, options = {}, fn;
    for (const arg of args) {
        if (typeof arg === 'string') name = arg;
        else if (typeof arg === 'function') fn = arg;
        else if (arg && typeof arg === 'object') options = arg;
    }
    return { name: name || (fn && fn.name) || '<anonymous>', options, fn };
}

/// Run a test body or hook. A second parameter means the callback style, which
/// finishes when `done` is called rather than when the function returns.
function _callTestFn(fn, ctx) {
    if (fn.length >= 2) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const done = (err) => {
                if (settled) return;
                settled = true;
                err ? reject(err) : resolve();
            };
            try {
                const r = fn(ctx, done);
                if (r && typeof r.then === 'function') r.then(() => done(), done);
            } catch (e) {
                done(e);
            }
        });
    }
    return Promise.resolve(fn(ctx));
}

function _yamlQuote(value) {
    return `'${String(value).split('\n')[0].replace(/'/g, "''")}'`;
}

function _reportBlock(pad, fields) {
    let out = `${pad}  ---\n`;
    for (const [key, value] of fields) {
        if (value === undefined || value === null) continue;
        if (key === 'stack') {
            out += `${pad}  stack: |-\n`;
            for (const line of String(value).split('\n')) out += `${pad}    ${line}\n`;
        } else {
            out += `${pad}  ${key}: ${value}\n`;
        }
    }
    return out + `${pad}  ...\n`;
}

function _registerTest(args, defaults) {
    const { name, options, fn } = _parseTestArgs(args);
    const node = {
        kind: 'test',
        name,
        fn,
        skip: !!(options.skip || defaults.skip) || !fn,
        todo: !!(options.todo || defaults.todo),
        skipMessage: typeof options.skip === 'string' ? options.skip : undefined,
        todoMessage: typeof options.todo === 'string' ? options.todo : undefined,
    };
    _currentSuite().children.push(node);
    _scheduleRun();
    return node.promise = new Promise((resolve) => { node.resolve = resolve; });
}

function _registerSuite(args, defaults) {
    const { name, options, fn } = _parseTestArgs(args);
    const suite = _newSuite(name);
    suite.skip = !!(options.skip || defaults.skip);
    suite.todo = !!(options.todo || defaults.todo);

    _currentSuite().children.push(suite);
    if (fn && !suite.skip && !suite.todo) {
        _testRun.stack.push(suite);
        try {
            fn();
        } finally {
            _testRun.stack.pop();
        }
    }
    _scheduleRun();
    return Promise.resolve();
}

async function _runTestNode(node, depth, eachHooks) {
    const pad = _indent(depth);
    _testWrite(`${pad}# Subtest: ${node.name}\n`);

    const started = Date.now();
    const ctx = {
        name: node.name,
        skip(message) { node.skip = true; if (message) node.skipMessage = message; },
        todo(message) { node.todo = true; if (message) node.todoMessage = message; },
        diagnostic(message) { _testWrite(`${pad}# ${message}\n`); },
    };

    let error = null;
    // A todo body still runs, as it does in node: that is how a todo that has
    // started working shows up. Only skip suppresses the body.
    if (!node.skip && node.fn) {
        try {
            for (const hook of eachHooks.beforeEach) await _callTestFn(hook, ctx);
            await _callTestFn(node.fn, ctx);
        } catch (e) {
            error = e;
        }
        // afterEach runs even when the body threw, so a failing test still
        // releases whatever it set up.
        for (const hook of eachHooks.afterEach) {
            try {
                await _callTestFn(hook, ctx);
            } catch (e) {
                if (!error) error = e;
            }
        }
    }

    const duration = Date.now() - started;
    _testRun.counts.tests += 1;

    let directive = '';
    if (node.todo) {
        directive = ' # TODO' + (node.todoMessage ? ` ${node.todoMessage}` : '');
        _testRun.counts.todo += 1;
    } else if (node.skip) {
        directive = ' # SKIP' + (node.skipMessage ? ` ${node.skipMessage}` : '');
        _testRun.counts.skipped += 1;
    }

    // A failing todo is reported as `not ok`, but it never fails the run:
    // that is the whole point of marking it todo.
    const failed = !!error && !node.todo;
    if (failed) _testRun.counts.fail += 1;
    else if (!node.skip && !node.todo && !error) _testRun.counts.pass += 1;

    const fields = [['duration_ms', duration]];
    if (error) {
        fields.push(['failureType', "'testCodeFailure'"]);
        fields.push(['error', _yamlQuote(error && error.message ? error.message : error)]);
        fields.push(['code', _yamlQuote((error && error.code) || 'ERR_TEST_FAILURE')]);
        if (error && error.stack) fields.push(['stack', error.stack]);
    }

    if (node.resolve) node.resolve();
    return { ok: !error, failed, directive, block: _reportBlock(pad, fields) };
}

async function _runSuiteNode(suite, depth, inherited) {
    const pad = _indent(depth);
    _testWrite(`${pad}# Subtest: ${suite.name}\n`);

    const started = Date.now();
    _testRun.counts.suites += 1;

    let directive = '';
    if (suite.todo) directive = ' # TODO';
    else if (suite.skip) directive = ' # SKIP';

    let error = null;
    let failedChildren = 0;
    if (!suite.skip && !suite.todo) {
        const eachHooks = {
            beforeEach: inherited.beforeEach.concat(suite.hooks.beforeEach),
            // Inner afterEach hooks run before outer ones, unwinding the way
            // they were set up.
            afterEach: suite.hooks.afterEach.concat(inherited.afterEach),
        };
        try {
            for (const hook of suite.hooks.before) await _callTestFn(hook, {});
            failedChildren = await _runChildren(suite.children, depth + 1, eachHooks);
        } catch (e) {
            error = e;
        }
        for (const hook of suite.hooks.after) {
            try {
                await _callTestFn(hook, {});
            } catch (e) {
                if (!error) error = e;
            }
        }
    }

    const fields = [['duration_ms', Date.now() - started], ['type', "'suite'"]];
    if (error) {
        _testRun.counts.fail += 1;
        fields.push(['failureType', "'hookFailed'"]);
        fields.push(['error', _yamlQuote(error.message || error)]);
        fields.push(['code', _yamlQuote(error.code || 'ERR_TEST_FAILURE')]);
        if (error.stack) fields.push(['stack', error.stack]);
    } else if (failedChildren > 0) {
        // The children already counted themselves; the suite reports their
        // failure without being counted again.
        fields.push(['failureType', "'subtestsFailed'"]);
        fields.push(['error', _yamlQuote(`${failedChildren} subtest${failedChildren === 1 ? '' : 's'} failed`)]);
        fields.push(['code', "'ERR_TEST_FAILURE'"]);
    }

    const ok = !error && failedChildren === 0;
    return { ok, failed: !ok, directive, block: _reportBlock(pad, fields) };
}

/// Run one level of children, print its TAP plan, and return how many failed.
/// Numbering restarts at every level, as it does in Node.
async function _runChildren(children, depth, eachHooks) {
    const pad = _indent(depth);
    let index = 0;
    let failed = 0;

    for (const child of children) {
        index += 1;
        const result = child.kind === 'suite'
            ? await _runSuiteNode(child, depth, eachHooks)
            : await _runTestNode(child, depth, eachHooks);
        _testWrite(`${pad}${result.ok ? 'ok' : 'not ok'} ${index} - ${child.name}${result.directive}\n`);
        _testWrite(result.block);
            if (result.failed) failed += 1;
    }

    _testWrite(`${pad}1..${index}\n`);
    return failed;
}

async function _runAllTests() {
    const started = Date.now();
    _testWrite('TAP version 13\n');

    const root = _testRun.root;
    const eachHooks = {
        beforeEach: root.hooks.beforeEach.slice(),
        afterEach: root.hooks.afterEach.slice(),
    };

    try {
        for (const hook of root.hooks.before) await _callTestFn(hook, {});
        await _runChildren(root.children, 0, eachHooks);
        for (const hook of root.hooks.after) await _callTestFn(hook, {});
    } catch (e) {
        _testRun.counts.fail += 1;
        _testWrite(`# ${e && e.message ? e.message : e}\n`);
    }

    const c = _testRun.counts;
    _testWrite(`# tests ${c.tests}\n`);
    _testWrite(`# suites ${c.suites}\n`);
    _testWrite(`# pass ${c.pass}\n`);
    _testWrite(`# fail ${c.fail}\n`);
    _testWrite(`# cancelled 0\n`);
    _testWrite(`# skipped ${c.skipped}\n`);
    _testWrite(`# todo ${c.todo}\n`);
    _testWrite(`# duration_ms ${Date.now() - started}\n`);

    if (c.fail > 0) {
        // The exit code is how wasmrun surfaces a failing test run, so it has
        // to be set here rather than left to the caller.
        if (globalThis.process) {
            process.exitCode = 1;
            if (typeof process.exit === 'function') process.exit(1);
        }
    }
}

function _scheduleRun() {
    if (_testRun.scheduled) return;
    _testRun.scheduled = true;
    // A microtask, so registration finishes first: the entry module's body has
    // returned by the time the queue is drained.
    Promise.resolve().then(() => _runAllTests());
}

function test(...args) { return _registerTest(args, {}); }
test.skip = (...args) => _registerTest(args, { skip: true });
test.todo = (...args) => _registerTest(args, { todo: true });

function describe(...args) { return _registerSuite(args, {}); }
describe.skip = (...args) => _registerSuite(args, { skip: true });
describe.todo = (...args) => _registerSuite(args, { todo: true });

const it = test;
const suite = describe;

const nodeTest = Object.assign(test, {
    test,
    it,
    describe,
    suite,
    before(fn) { _currentSuite().hooks.before.push(fn); },
    after(fn) { _currentSuite().hooks.after.push(fn); },
    beforeEach(fn) { _currentSuite().hooks.beforeEach.push(fn); },
    afterEach(fn) { _currentSuite().hooks.afterEach.push(fn); },
});

// ═══ Modules the sandbox cannot provide ═══════════════════════════════════════
// Present but throwing, deliberately: absent, they fail at require() time with
// "Cannot find module", which reads as a broken runtime. This way a package
// that merely imports one keeps working.

function unsupportedModule(moduleName, reason, members) {
    const mod = {};
    for (const name of members) {
        mod[name] = function () {
            const e = new Error(`${moduleName}.${name}() is not supported in this sandbox: ${reason}`);
            e.code = 'ERR_NOT_SUPPORTED';
            throw e;
        };
    }
    return mod;
}

const zlib = unsupportedModule(
    'zlib',
    'no compression library is linked into the runtime',
    ['deflate', 'deflateSync', 'inflate', 'inflateSync', 'gzip', 'gzipSync', 'gunzip', 'gunzipSync',
     'brotliCompress', 'brotliCompressSync', 'brotliDecompress', 'brotliDecompressSync',
     'createGzip', 'createGunzip', 'createDeflate', 'createInflate']
);

const childProcess = unsupportedModule(
    'child_process',
    'the sandbox has no process table and no executables to run',
    ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']
);

class Worker {
    constructor() {
        const e = new Error('worker_threads.Worker is not supported in this sandbox: the runtime is single-threaded');
        e.code = 'ERR_NOT_SUPPORTED';
        throw e;
    }
}

const workerThreads = {
    isMainThread: true,
    threadId: 0,
    workerData: null,
    parentPort: null,
    Worker,
};

// ═══ tty ══════════════════════════════════════════════════════════════════════
// Nothing in the sandbox is a terminal, so isatty is honest rather than
// stubbed and the stream classes throw instead of opening a device.

function ttyUnavailable(name) {
    return class {
        constructor() {
            const e = new Error(`tty.${name} is not supported in this sandbox: there is no terminal device`);
            e.code = 'ERR_NOT_SUPPORTED';
            throw e;
        }
    };
}

const tty = {
    isatty(fd) {
        if (typeof fd !== 'number' || !Number.isInteger(fd)) {
            const e = new TypeError('The "fd" argument must be of type number');
            e.code = 'ERR_INVALID_ARG_TYPE';
            throw e;
        }
        return false;
    },
    ReadStream: ttyUnavailable('ReadStream'),
    WriteStream: ttyUnavailable('WriteStream'),
};

// ═══ Built-in module registry ════════════════════════════════════════════════

const builtins = {
    'path': path,
    'fs': fs,
    'fs/promises': fsPromises,
    'os': nodeOs,
    'buffer': bufferModule,
    'events': eventsModule,
    'util': util,
    'assert': assertModule,
    'stream': streamModule,
    'crypto': nodeCrypto,
    'url': urlModule,
    'querystring': querystring,
    'string_decoder': stringDecoderModule,
    'timers': timersModule,
    'timers/promises': timersPromises,
    'zlib': zlib,
    'worker_threads': workerThreads,
    'child_process': childProcess,
    'tty': tty,
};

// `require('process')` must hand back the same object as the global, which
// setupGlobals builds later: an accessor keeps the two identical instead of
// snapshotting an undefined value at load time.
Object.defineProperty(builtins, 'process', {
    get() { return globalThis.process; },
    enumerable: true,
    configurable: true,
});

// Derived rather than listed twice, so the two cannot drift. Descriptors are
// copied rather than values, so an accessor entry stays live under its alias.
for (const name of Object.keys(builtins)) {
    Object.defineProperty(
        builtins,
        `node:${name}`,
        Object.getOwnPropertyDescriptor(builtins, name),
    );
}

// The test runner is prefix-only, as in Node: bare `require('test')` resolves
// to a package named "test", not to the runner.
builtins['node:test'] = nodeTest;

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

// ── package.json "exports" ────────────────────────────────────────────────────
// A package with "exports" is sealed: only what it lists is reachable.
// Conditions are matched in the order the package wrote them, which is what the
// spec says and what decides `{"import": …, "require": …}` correctly. "import"
// is not in the set: the module wrapper is CommonJS, and ES module packages are
// lowered before they get here.

const EXPORTS_CONDITIONS = ['require', 'node'];

function splitPackageRequest(request) {
    const parts = request.split('/');
    const name = request.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const rest = request.slice(name.length);
    return { name, subpath: rest ? '.' + rest : '.' };
}

/// Resolve one exports target to a path.
///
/// Returns the path, `undefined` when no condition matched, or `null` when the
/// package blocked the subpath outright (a `null` target).
function resolveExportsTarget(pkgDir, target, patternMatch) {
    if (target === null) return null;

    if (typeof target === 'string') {
        // Only relative targets are addressable; anything else (a bare
        // specifier, an absolute path) is not ours to resolve.
        if (!target.startsWith('./')) return undefined;
        const sub = patternMatch === null ? target : target.split('*').join(patternMatch);
        return path.join(pkgDir, sub);
    }

    if (Array.isArray(target)) {
        for (const alt of target) {
            const resolved = resolveExportsTarget(pkgDir, alt, patternMatch);
            if (resolved !== undefined) return resolved;
        }
        return undefined;
    }

    if (target && typeof target === 'object') {
        for (const key of Object.keys(target)) {
            if (key !== 'default' && !EXPORTS_CONDITIONS.includes(key)) continue;
            const resolved = resolveExportsTarget(pkgDir, target[key], patternMatch);
            if (resolved !== undefined) return resolved;
        }
        return undefined;
    }

    return undefined;
}

function resolveExports(pkgDir, exportsField, subpath) {
    let map = exportsField;
    const isSubpathMap = exportsField && typeof exportsField === 'object'
        && !Array.isArray(exportsField)
        && Object.keys(exportsField).some(k => k === '.' || k.startsWith('./'));

    if (!isSubpathMap) {
        // Shorthand: a string, an array, or a bare condition object is the
        // root export and nothing else.
        if (subpath !== '.') return undefined;
        map = { '.': exportsField };
    }

    if (Object.prototype.hasOwnProperty.call(map, subpath)) {
        return resolveExportsTarget(pkgDir, map[subpath], null);
    }

    // Subpath patterns ("./*": "./dist/*.js"). The longest matching prefix
    // wins, so a specific key beats a catch-all.
    let best = null;
    for (const key of Object.keys(map)) {
        const star = key.indexOf('*');
        if (star < 0) continue;
        const prefix = key.slice(0, star);
        const suffix = key.slice(star + 1);
        if (subpath.length < prefix.length + suffix.length) continue;
        if (!subpath.startsWith(prefix)) continue;
        if (suffix && !subpath.endsWith(suffix)) continue;
        if (!best || prefix.length > best.prefix.length) best = { key, prefix, suffix };
    }
    if (best) {
        const match = subpath.slice(best.prefix.length, subpath.length - best.suffix.length);
        return resolveExportsTarget(pkgDir, map[best.key], match);
    }

    return undefined;
}

function notExportedError(request, pkgDir) {
    const e = new Error(`Package subpath is not exported: '${request}' (from '${pkgDir}')`);
    e.code = 'ERR_PACKAGE_PATH_NOT_EXPORTED';
    return e;
}

/// Resolve a request inside one package directory. Throws rather than
/// returning null once the package itself exists: a package that is present
/// but does not export the subpath is an error, not a reason to keep searching
/// further up the tree.
function resolvePackage(pkgDir, subpath, request) {
    let pkg = null;
    try {
        pkg = JSON.parse(tryRead(pkgDir + '/package.json'));
    } catch (_) {
        pkg = null;
    }

    if (pkg && pkg.exports !== undefined && pkg.exports !== null) {
        const target = resolveExports(pkgDir, pkg.exports, subpath);
        if (target === null) throw notExportedError(request, pkgDir);
        if (typeof target === 'string') {
            const asFile = resolveAsFile(target);
            if (asFile) return asFile;
            const asIndex = resolveAsFile(path.join(target, 'index'));
            if (asIndex) return asIndex;
            const e = new Error(`Cannot find module '${request}': '${target}' does not exist`);
            e.code = 'MODULE_NOT_FOUND';
            throw e;
        }
        // No condition matched. For a subpath that is the end of it; for the
        // package root, fall through to "main", which is where an ES module
        // package ends up once it has been lowered to CommonJS.
        if (subpath !== '.') throw notExportedError(request, pkgDir);
    }

    const base = subpath === '.' ? pkgDir : path.join(pkgDir, subpath);
    const asFile = resolveAsFile(base);
    if (asFile) return asFile;
    const asDir = resolveAsDirectory(base);
    if (asDir) return asDir;

    if (pkg) {
        const e = new Error(`Cannot find module '${request}' (in '${pkgDir}')`);
        e.code = 'MODULE_NOT_FOUND';
        throw e;
    }
    return null;
}

function resolveNodeModules(request, fromDir) {
    const { name, subpath } = splitPackageRequest(request);
    let dir = fromDir;
    while (true) {
        const last = path.basename(dir);
        if (last !== 'node_modules') {
            const pkgDir = path.join(dir, 'node_modules', name);
            if (isFile(pkgDir + '/package.json')) {
                return resolvePackage(pkgDir, subpath, request);
            }
            // No manifest: a bare directory or a loose file dropped into
            // node_modules, which the legacy rules still resolve.
            const candidate = path.join(dir, 'node_modules', request);
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
    if (Object.prototype.hasOwnProperty.call(builtins, request)) {
        return { builtin: true, id: request };
    }

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

/// Compile a CommonJS module body into the function that runs it.
///
/// `new Function` would do, but QuickJS names everything it builds that way
/// `<input>`, so every stack frame from user code reported the same anonymous
/// script and no frame said which file it came from. std.evalScript takes the
/// real path (a wasmhub patch adds the `filename` option), and the wrapper's
/// opening line is kept on the source's first line so reported line numbers
/// are the file's own rather than shifted by the preamble.
///
/// Falls back to `new Function` on a QuickJS without the patch: frames lose
/// their filename again, which is worse output but still runs.
function compileModule(src, filename) {
    if (typeof std.evalScript === 'function') {
        const wrapped =
            '(function (exports, require, module, __filename, __dirname) { ' + src + '\n})';
        const fn = std.evalScript(wrapped, { filename });
        if (typeof fn === 'function') return fn;
    }
    return new Function('exports', 'require', 'module', '__filename', '__dirname', src);
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
        fn = compileModule(src, filename);
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
// std.exit() on the success path (we don't). We layer the Node/browser timer
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
        // std.exit() ends the process there and then, so anything still sitting
        // in a stdio buffer would never be written. Nothing downstream gets a
        // chance to flush it.
        exit(code) {
            try { std.out.flush(); std.err.flush(); } catch (_) { /* already closed */ }
            std.exit(code | 0);
        },
        cwd() { return currentCwd(); },
        stdout: {
            write(s) { std.out.puts(String(s)); std.out.flush(); return true; },
            isTTY: false,
        },
        stderr: {
            write(s) { std.err.puts(String(s)); std.err.flush(); return true; },
            isTTY: false,
        },
        stdin: makeStdinStream(),
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
    installWebGlobals();

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
    std.out.puts(`Features: eval, run, require, filesystem, env, args, stdio, stdin, timers, async, buffer, exports-map resolution\n`);
    std.out.puts(`Built-ins: path, fs, fs/promises, os, buffer, events, util, assert, stream, crypto, url, querystring, string_decoder, timers, timers/promises, process, tty, node:test (and node:* aliases)\n`);
    std.out.puts(`Stubbed: zlib, worker_threads, child_process (present, throw a clear error when used)\n`);
    std.out.puts(`Globals: Buffer, TextEncoder, TextDecoder, atob, btoa, URL, URLSearchParams, crypto, structuredClone\n`);
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
        std.exit(1);
    }
    std.out.flush();
}

function runFile(rawPath, extraArgs) {
    const entryPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(rawPath);

    if (!isFile(entryPath)) {
        std.err.puts(`Error: cannot open '${entryPath}'\n`);
        std.err.flush();
        std.exit(1);
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
        std.exit(1);
    }

    const requireFn = makeRequire(entryDir, entryModule);

    try {
        const fn = compileModule(src, entryPath);
        fn.call(entryModule.exports, entryModule.exports, requireFn, entryModule, entryPath, entryDir);
        entryModule.loaded = true;
    } catch (e) {
        std.err.puts(`Error: ${e.message || e}\n`);
        if (e.stack) std.err.puts(e.stack + "\n");
        std.err.flush();
        std.exit(1);
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
        std.exit(0);
    }

    switch (argv[1]) {
        case "version":
            printVersion();
            break;
        case "eval":
            if (argv.length < 3) {
                std.err.puts("Error: eval requires a code argument\n");
                std.err.flush();
                std.exit(1);
            }
            setupGlobals(null, argv.slice(2));
            evalCode(argv.slice(2).join(" "));
            break;
        case "run":
            if (argv.length < 3) {
                std.err.puts("Error: run requires a file path\n");
                std.err.flush();
                std.exit(1);
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
            std.exit(1);
    }
}
