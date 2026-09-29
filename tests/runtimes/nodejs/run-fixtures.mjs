#!/usr/bin/env node
// Run every fixture in ./fixtures against a built nodejs wasm, checking each
// one's exit code and a line of its output, under either of two hosts:
//
//   wasmtime  a stock WASI host, run as a subprocess per fixture
//   wasmrun   wasmrun's agent mode, the runtime's real consumer: an agent
//             server is started, the wasm under test is served to it as a
//             wasmhub release, and each fixture runs in its own session
//
// The node harness (*.test.mjs) covers the runtime's pure-JS logic, but not the
// real engine: its event loop, its console, WASI, or the exit code the process
// really ends with. v0.5.0 shipped a runtime whose console had no `error` and
// whose failed runs exited 0, and both would have shown up here.
//
// Usage:
//   node tests/runtimes/nodejs/run-fixtures.mjs [--host wasmtime|wasmrun] [--only NAMES] [path/to/nodejs-20.wasm]
//
// --only takes a comma-separated list of check names, each matching itself and
// any check it prefixes: `--only timers`, `--only lifecycle,httpserver`.
//
// The httpserver check needs its host to hand the program a listening socket.
// wasmrun always can. wasmtime can only through its legacy Preview 1
// implementation, which wasmtime 47 removed, so there the check is skipped on a
// wasmtime that cannot; WASMHUB_REQUIRE_HTTP=1 makes the skip a failure, which
// is how CI keeps it from quietly lapsing. WASMRUN_BIN overrides the wasmrun
// binary (default: `wasmrun` on PATH).

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const PROJECT_ROOT = resolve(HERE, '../../..');

// ── The checks, shared by both hosts ─────────────────────────────────────────
//
// Scenarios are chosen through `env` rather than argv, because wasmrun's agent
// mode passes a script no arguments.
//
// `knownFailure` marks a check that fails on one host for a reason outside
// this runtime, with the reason. It is reported as `xfail` rather than failing
// the run, and a known failure that starts passing fails the run instead, so
// the marker cannot outlive the bug it describes.

const CHECKS = [
    { name: 'app', file: 'app.js', code: 0, text: 'require.main===module: true' },
    { name: 'timers', file: 'timers.js', code: 0, text: 'interval 3' },
    { name: 'buffer', file: 'buffer.js', code: 0, text: 'done' },
    { name: 'base', file: 'base.js', code: 0, text: 'callbackify=10' },
    { name: 'stream', file: 'stream.js', code: 0, text: 'pipe=FOO|BAR|BAZ|!' },
    { name: 'webglobals', file: 'webglobals.js', code: 0, text: 'fetch.err=clear' },
    { name: 'builtins', file: 'builtins.js', code: 0, text: 'builtins=pass' },
    {
        name: 'append',
        file: 'append.js',
        code: 0,
        text: 'append=pass',
        knownFailure: {
            wasmrun: "wasmrun's path_open ignores fdflags, so O_APPEND is dropped and an append overwrites from offset 0 (anistark/wasmrun#123)",
        },
    },
    { name: 'resolver', file: 'resolver.js', code: 0, text: 'resolver=pass' },
    { name: 'testrunner', file: 'testrunner.js', code: 0, text: '# pass 3' },
    // A failing node:test run has to exit 1, or a caller cannot see it failed.
    { name: 'testrunner-failing', file: 'testrunner.js', env: { WASMHUB_TEST_FAIL: '1' }, code: 1, text: '# fail 1' },
    { name: 'stdin', file: 'stdin.js', stdin: 'hello from the host', code: 0, text: 'stdin=pass' },
    { name: 'stdin-mismatch', file: 'stdin.js', stdin: 'something else', code: 1, text: 'stdin=FAIL' },
    ...[
        ['console', 0, 'to stderr'],
        ['catch-exit', 1, 'caught boom'],
        ['unhandled', 1, 'TypeError: nobody caught me'],
        ['late-catch', 0, 'lifecycle=pass'],
        ['timer-throw', 1, 'Error: in timer'],
        ['exit-code', 3, 'exit event 3'],
        ['listeners', 0, 'lifecycle=pass'],
    ].map(([scenario, code, text]) => ({
        name: `lifecycle:${scenario}`,
        file: 'lifecycle.js',
        env: { LIFECYCLE_SCENARIO: scenario },
        code,
        text,
    })),
];

// ── Hosts ────────────────────────────────────────────────────────────────────

/// A host runs one check and resolves to { code, out }, and serves
/// httpserver.js, resolving to { ok, detail }. `skipHttp()` names why the host
/// cannot serve, or returns null.

function wasmtimeHost(wasm) {
    const tmp = mkdtempSync(join(tmpdir(), 'wasmhub-fixtures-'));
    mkdirSync(join(tmp, 'tmp'));

    // Older wasmtime spells the option --tcplisten; 14 to 46 offer it only on
    // the legacy Preview 1 implementation, as -S tcplisten; 47 and later not at all.
    const help = spawnSync('wasmtime', ['run', '--help'], { encoding: 'utf8' }).stdout || '';
    const listenArgs = (addr) => (help.includes('--tcplisten')
        ? ['--tcplisten', addr]
        : ['-S', 'preview2=n', '-S', `tcplisten=${addr}`]);

    const envArgs = (env = {}) => Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);

    return {
        key: 'wasmtime',
        name: `wasmtime (${spawnSync('wasmtime', ['--version'], { encoding: 'utf8' }).stdout.trim()})`,

        async run(check) {
            // From the fixtures dir, preopened as ".", so paths stay relative.
            const r = spawnSync('wasmtime', [
                'run', '--dir', '.', '--dir', `${join(tmp, 'tmp')}::/tmp`,
                ...envArgs(check.env), wasm, 'run', `./${check.file}`,
            ], { cwd: FIXTURES, input: check.stdin || '', encoding: 'utf8' });
            return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
        },

        skipHttp() {
            const probe = spawnSync('wasmtime', ['run', ...listenArgs('127.0.0.1:0'), wasm, 'version']);
            return probe.status === 0
                ? null
                : `this wasmtime cannot hand a listening socket to a Preview 1 module; 46.x is the last that can`;
        },

        async serveHttp() {
            const port = 20000 + Math.floor(Math.random() * 20000);
            const addr = `127.0.0.1:${port}`;
            // Through eval rather than run: with the socket on fd 3, wasi-libc's
            // preopen scan stops there and no --dir after it is visible, so the
            // file could not be opened. httpserver.js requires only built-ins.
            const child = spawn('wasmtime', [
                'run', ...listenArgs(addr),
                '--env', 'WASMHUB_LISTEN_FD=3', '--env', `WASMHUB_LISTEN_ADDR=${addr}`,
                wasm, 'eval', readFileSync(join(FIXTURES, 'httpserver.js'), 'utf8'),
            ]);
            let log = '';
            child.stdout.on('data', (d) => { log += d; });
            child.stderr.on('data', (d) => { log += d; });
            const exited = new Promise((res) => child.on('exit', (code) => res(code)));
            const result = await exerciseHttpServer(`http://${addr}`);
            const code = await Promise.race([exited, sleep(5000).then(() => { child.kill(); return 'timeout'; })]);
            return { ok: result.ok && code === 0, detail: `exit ${code}, ${result.detail}\n${log}` };
        },

        async close() { rmSync(tmp, { recursive: true, force: true }); },
    };
}

async function wasmrunHost(wasm) {
    const bin = process.env.WASMRUN_BIN || 'wasmrun';
    const version = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (version.status !== 0) throw new Error(`cannot run ${bin}; set WASMRUN_BIN or put wasmrun on PATH`);

    // Serve the wasm under test as a one-runtime wasmhub release. The manifest
    // is generated here so its sha256 is the build's own, whatever the
    // committed manifest says.
    const bytes = readFileSync(wasm);
    const manifest = JSON.stringify({
        language: 'nodejs',
        latest: '20',
        versions: {
            20: {
                file: 'nodejs-20.wasm',
                size: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex'),
                released: new Date().toISOString(),
                wasi: 'wasip1',
                features: [],
            },
        },
    });
    // Anything else, which in practice is swc (wasmrun lowers the fixtures'
    // .mjs files to CommonJS with it), is served from this checkout when it
    // holds a build of it that its manifest describes, as it does in the
    // release job, and otherwise comes from the published release, the way it
    // would for a real session.
    const local = localRuntimes();
    const localFiles = [...local.keys()].filter((k) => k.endsWith('.wasm'));
    if (localFiles.length) console.log(`serving from this checkout: ${localFiles.join(', ')}`);
    const releaseFallback = process.env.WASMHUB_RELEASE_URL ||
        'https://github.com/anistark/wasmhub/releases/latest/download';
    const release = createServer((req, res) => {
        if (req.url === '/nodejs-manifest.json') return res.end(manifest);
        if (req.url === '/nodejs-20.wasm') return res.end(bytes);
        const name = req.url.slice(1);
        if (local.has(name)) return res.end(readFileSync(local.get(name)));
        res.writeHead(302, { Location: `${releaseFallback}${req.url}` });
        res.end();
    });
    await new Promise((res) => release.listen(0, '127.0.0.1', res));
    const releaseUrl = `http://127.0.0.1:${release.address().port}`;

    // A private HOME, so wasmrun's runtime cache starts empty and cannot hand
    // back a runtime some earlier build left behind.
    const home = mkdtempSync(join(tmpdir(), 'wasmhub-wasmrun-home-'));
    const agentPort = 20000 + Math.floor(Math.random() * 20000);
    const agent = spawn(bin, ['agent', '--port', String(agentPort)], {
        env: { ...process.env, HOME: home, WASMRUN_WASMHUB_BASE_URL: releaseUrl },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let agentLog = '';
    agent.stdout.on('data', (d) => { agentLog += d; });
    agent.stderr.on('data', (d) => { agentLog += d; });
    const base = `http://127.0.0.1:${agentPort}`;
    const api = `${base}/api/v1`;

    for (let i = 0; ; i++) {
        try {
            if ((await fetch(`${base}/health`)).ok) break;
        } catch (_) { /* not listening yet */ }
        if (i > 100 || agent.exitCode !== null) {
            throw new Error(`wasmrun agent did not start:\n${agentLog}`);
        }
        await sleep(100);
    }

    const files = fixtureFiles();
    const call = async (method, path, body) => {
        const r = await fetch(`${api}${path}`, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await r.text();
        if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${text}`);
        return text ? JSON.parse(text) : {};
    };
    const withSession = async (fn) => {
        const { session_id: id } = await call('POST', '/sessions');
        try {
            return await fn(id);
        } finally {
            await call('DELETE', `/sessions/${id}`).catch(() => {});
        }
    };

    // The banner is styled; the version is the first x.y.z in it.
    const plain = version.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    const versionNumber = (plain.match(/\d+\.\d+\.\d+/) || ['unknown version'])[0];

    return {
        key: 'wasmrun',
        name: `wasmrun ${versionNumber}`,

        run(check) {
            return withSession(async (id) => {
                const r = await call('POST', `/sessions/${id}/exec`, {
                    files,
                    entry: check.file,
                    language: 'javascript',
                    env: check.env || {},
                    stdin: check.stdin || '',
                    timeout: 60,
                });
                const out = (r.stdout || '') + (r.stderr || '') + (r.error ? `\nerror: ${r.error}` : '');
                return { code: r.exit_code, out };
            });
        },

        skipHttp() { return null; },

        serveHttp() {
            return withSession(async (id) => {
                const started = await call('POST', `/sessions/${id}/serve`, {
                    files,
                    entry: 'httpserver.js',
                    language: 'javascript',
                });
                const result = await exerciseHttpServer(`http://127.0.0.1:${started.port}`);
                let status;
                for (let i = 0; i < 50; i++) {
                    status = await call('GET', `/sessions/${id}/serve`);
                    if (!status.running) break;
                    await sleep(100);
                }
                const clean = !status.running && status.ended === 'exited' && status.exit_code === 0;
                return {
                    ok: result.ok && clean,
                    detail: `${result.detail}, server ${JSON.stringify({ running: status.running, ended: status.ended, exit_code: status.exit_code })}\n${status.stdout || ''}${status.stderr || ''}`,
                };
            });
        },

        async close() {
            agent.kill();
            release.close();
            rmSync(home, { recursive: true, force: true });
        },
    };
}

// ── Shared helpers ───────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/// Release file name → local path, for every non-nodejs runtime in
/// runtimes/ whose manifest's latest entry matches the wasm beside it. A stale
/// committed manifest, or no local build at all, leaves that runtime out.
function localRuntimes() {
    const found = new Map();
    const dir = join(PROJECT_ROOT, 'runtimes');
    for (const lang of readdirSync(dir)) {
        if (lang === 'nodejs') continue;
        const manifestPath = join(dir, lang, 'manifest.json');
        try {
            const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
            const v = m.versions[m.latest];
            const wasmPath = join(dir, lang, v.file);
            const sha = createHash('sha256').update(readFileSync(wasmPath)).digest('hex');
            if (sha !== v.sha256) continue;
            found.set(`${lang}-manifest.json`, manifestPath);
            found.set(v.file, wasmPath);
        } catch (_) { /* no manifest, no build, or not a runtime */ }
    }
    return found;
}

/// Every file under ./fixtures, keyed by its path relative to it, which is the
/// shape wasmrun's `files` exec takes.
function fixtureFiles() {
    const out = {};
    const walk = (dir) => {
        for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            if (statSync(p).isDirectory()) walk(p);
            else out[relative(FIXTURES, p)] = readFileSync(p, 'utf8');
        }
    };
    walk(FIXTURES);
    return out;
}

/// Talk to httpserver.js the way its header describes: two requests, then
/// /stop, after which the fixture closes its server and exits 0.
async function exerciseHttpServer(origin) {
    let hello = '';
    for (let i = 0; i < 50 && !hello; i++) {
        try {
            const r = await fetch(`${origin}/hello`);
            if (r.ok) hello = await r.text();
        } catch (_) { /* not accepting yet */ }
        if (!hello) await sleep(100);
    }
    let post = '';
    try { post = await (await fetch(`${origin}/x`, { method: 'POST', body: 'ping' })).text(); } catch (_) { /* reported below */ }
    try { await fetch(`${origin}/stop`); } catch (_) { /* the server may close first */ }
    const ok = hello.includes('"url":"/hello"') && post.includes('"body":"ping"');
    return { ok, detail: `GET '${hello}', POST '${post}'` };
}

// ── Main ─────────────────────────────────────────────────────────────────────

/// A mistake on the command line: reported as its message, without a stack.
function usageError(message) {
    const e = new Error(message);
    e.usage = true;
    return e;
}

function parseArgs(argv) {
    let host = 'wasmtime';
    let wasm = join(PROJECT_ROOT, 'runtimes/nodejs/nodejs-20.wasm');
    let only = null;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--host') host = argv[++i];
        else if (argv[i].startsWith('--host=')) host = argv[i].slice(7);
        else if (argv[i] === '--only') only = argv[++i].split(',');
        else if (argv[i].startsWith('--only=')) only = argv[i].slice(7).split(',');
        else wasm = resolve(argv[i]);
    }
    if (!['wasmtime', 'wasmrun'].includes(host)) {
        throw usageError(`unknown host '${host}': expected wasmtime or wasmrun`);
    }
    const selected = (name) => !only || only.some((o) => name === o || name.startsWith(o));
    const known = [...CHECKS.map((c) => c.name), 'httpserver'];
    if (only && !known.some(selected)) {
        throw usageError(`--only ${only.join(',')} matches no check; known: ${known.join(', ')}`);
    }
    return { host, wasm, selected };
}

async function main() {
    const { host: hostName, wasm, selected } = parseArgs(process.argv.slice(2));
    try {
        statSync(wasm);
    } catch (_) {
        console.error(`Error: no runtime at ${wasm}; build one with 'just build-nodejs'`);
        process.exit(1);
    }

    const host = hostName === 'wasmrun' ? await wasmrunHost(wasm) : wasmtimeHost(wasm);
    console.log(`host: ${host.name}\n`);

    let passed = 0;
    let failed = 0;
    let xfailed = 0;
    const report = (ok, name, why, out) => {
        if (ok) {
            console.log(`ok   ${name}`);
            passed++;
        } else {
            console.log(`FAIL ${name}: ${why}`);
            if (out) console.log(out.replace(/\s+$/, '').replace(/^/gm, '     | '));
            failed++;
        }
    };

    try {
        for (const check of CHECKS.filter((c) => selected(c.name))) {
            const { code, out } = await host.run(check);
            const ok = code === check.code && out.includes(check.text);
            const known = check.knownFailure && check.knownFailure[host.key];
            if (known && !ok) {
                console.log(`xfail ${check.name}: ${known}`);
                xfailed++;
            } else if (known) {
                report(false, check.name, `passes on ${host.key} now; remove its knownFailure marker`);
            } else {
                report(ok, check.name,
                    `exit ${code} (want ${check.code}), expected output containing '${check.text}'`, out);
            }
        }

        const skip = host.skipHttp();
        if (!selected('httpserver')) {
            // not asked for
        } else if (!skip) {
            const { ok, detail } = await host.serveHttp();
            report(ok, 'httpserver', 'server did not answer and exit cleanly', detail);
        } else if (process.env.WASMHUB_REQUIRE_HTTP === '1') {
            report(false, 'httpserver', skip);
        } else {
            console.log(`skip httpserver: ${skip}`);
        }
    } finally {
        await host.close();
    }

    console.log(`\n${passed} passed, ${failed} failed${xfailed ? `, ${xfailed} known failure${xfailed > 1 ? 's' : ''}` : ''}`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e && e.usage ? `Error: ${e.message}` : (e && e.stack) || e);
    process.exit(1);
});
