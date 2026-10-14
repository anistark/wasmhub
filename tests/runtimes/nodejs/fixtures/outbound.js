// Outbound connections from the nodejs-20-net build: net.connect, http.get
// and fetch against the origin the runner starts (OUTBOUND_ORIGIN), and a
// destination the host's policy refuses (OUTBOUND_DENIED, host:port). Needs a
// host with sock_open/sock_connect that allows the origin, which is wasmrun
// started with --allow-net. Prints `outbound=pass`, or the failures and exits 1.

const net = require('net');
const http = require('http');
const { AsyncLocalStorage } = require('async_hooks');

const origin = new URL(process.env.OUTBOUND_ORIGIN);
const [deniedHost, deniedPort] = process.env.OUTBOUND_DENIED.split(':');
const failures = [];
const expect = (label, got, want) => {
    if (got !== want) failures.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

function rawRequest() {
    return new Promise((resolve, reject) => {
        const socket = net.connect(Number(origin.port), origin.hostname);
        let text = '';
        socket.on('connect', () => socket.write(`GET /json HTTP/1.1\r\nHost: ${origin.host}\r\nConnection: close\r\n\r\n`));
        socket.on('data', (d) => { text += d; });
        socket.on('end', () => resolve(text));
        socket.on('error', reject);
    });
}

function httpGet(path) {
    return new Promise((resolve, reject) => {
        http.get(`${origin.href.replace(/\/$/, '')}${path}`, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { body += d; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        }).on('error', reject);
    });
}

function denied() {
    return new Promise((resolve) => {
        const socket = net.connect(Number(deniedPort), deniedHost);
        socket.on('connect', () => resolve('connected'));
        socket.on('error', (e) => resolve(e.code));
    });
}

async function main() {
    const raw = await rawRequest();
    expect('raw status line', raw.split('\r\n')[0], 'HTTP/1.1 200 OK');
    expect('raw body', raw.endsWith('{"hello":"world"}'), true);

    const got = await httpGet('/chunked');
    expect('http.get status', got.status, 200);
    expect('http.get chunked body', got.body, 'one,two,three');
    expect('http.get framing', got.headers['transfer-encoding'], 'chunked');

    const json = await fetch(new URL('/json', origin));
    expect('fetch ok', json.ok, true);
    expect('fetch json', (await json.json()).hello, 'world');

    const echoed = await (await fetch(new URL('/echo', origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-run': 'wasm' },
        body: JSON.stringify({ n: 42 }),
    })).json();
    expect('fetch POST method', echoed.method, 'POST');
    expect('fetch POST body', echoed.body, '{"n":42}');
    expect('fetch POST header', echoed.headers['x-run'], 'wasm');

    const redirected = await fetch(new URL('/redirect', origin));
    expect('fetch redirected', redirected.redirected, true);
    expect('fetch final url', new URL(redirected.url).pathname, '/json');

    expect('policy refusal', await denied(), 'EACCES');
    try {
        await fetch(`http://${deniedHost}:${deniedPort}/`);
        failures.push('fetch to a denied host resolved');
    } catch (e) {
        expect('fetch refusal', `${e.message}/${e.cause && e.cause.code}`, 'fetch failed/EACCES');
    }

    const als = new AsyncLocalStorage();
    const kept = await als.run('req-1', async () => {
        await fetch(new URL('/json', origin));
        return als.getStore();
    });
    expect('store across await fetch', kept, 'req-1');
}

main().then(
    () => {
        console.log(failures.length ? `outbound=FAIL\n${failures.join('\n')}` : 'outbound=pass');
        process.exitCode = failures.length ? 1 : 0;
    },
    (e) => {
        console.log(`outbound=FAIL ${e && e.stack || e}`);
        process.exitCode = 1;
    },
);
