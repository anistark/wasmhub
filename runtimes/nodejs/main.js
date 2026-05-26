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
        const f = std.open(p, "r");
        if (!f) throw fsError('ENOENT', 'no such file or directory, open', p);
        try {
            const s = f.readAsString();
            // Binary read not yet supported; always return string. If no encoding
            // was given, Node would return a Buffer — callers expecting that will
            // need to handle the string fallback for now.
            return s;
        } finally {
            f.close();
        }
    },

    writeFileSync(p, data, _options) {
        const f = std.open(p, "w");
        if (!f) throw fsError('EACCES', 'cannot write file', p);
        try {
            f.puts(typeof data === 'string' ? data : String(data));
        } finally {
            f.close();
        }
    },

    appendFileSync(p, data, _options) {
        const f = std.open(p, "a");
        if (!f) throw fsError('EACCES', 'cannot append to file', p);
        try {
            f.puts(typeof data === 'string' ? data : String(data));
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

// ═══ Built-in module registry ════════════════════════════════════════════════

const builtins = {
    'path': path,
    'fs': fs,
    'os': nodeOs,
    'node:path': path,
    'node:fs': fs,
    'node:os': nodeOs,
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

function fileExists(p) {
    const f = std.open(p, "r");
    if (f) { f.close(); return true; }
    return false;
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
        if (fileExists(c)) return c;
    }
    return null;
}

function resolveAsDirectory(base) {
    const pkgPath = base + '/package.json';
    if (fileExists(pkgPath)) {
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
        nextTick(fn, ...args) { fn(...args); },
        hrtime: (() => {
            const start = Date.now();
            return () => {
                const ms = Date.now() - start;
                return [Math.floor(ms / 1000), (ms % 1000) * 1e6];
            };
        })(),
    };
    globalThis.global = globalThis;

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
    std.out.puts(`Features: eval, run, require, filesystem, env, args, stdio\n`);
    std.out.puts(`Built-ins: path, fs, os (and node:* aliases)\n`);
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

    if (!fileExists(entryPath)) {
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
