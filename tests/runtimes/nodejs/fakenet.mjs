// An in-memory stand-in for the host's socket layer, backing the os.sock*
// bindings that runtimes/nodejs/wasi_sockets.c provides in a real build.
//
// It answers with the same [value, code] pairs the C bindings do, and it is
// deliberately picky about the two cases that are easy to get wrong: nothing
// to read yet is EAGAIN, an orderly peer shutdown is 0 bytes, and the two are
// never interchangeable. `maxSend` forces short writes so the runtime's
// re-queueing path is exercised rather than assumed.

const EMPTY = Buffer.alloc(0);

class Connection {
    constructor(fd) {
        this.fd = fd;
        this.toGuest = [];      // bytes the peer has sent, waiting to be read
        this.fromGuest = [];    // bytes the guest has written
        this.peerEnded = false; // peer half-closed its writing side
        this.guestEnded = false;
        this.closed = false;
    }
}

/// One end of a connection, from the point of view of a client talking to the
/// runtime's server.
export class Peer {
    constructor(conn) {
        this._conn = conn;
    }

    /// Send bytes to the server.
    send(data) {
        this._conn.toGuest.push(Buffer.from(data));
        return this;
    }

    /// Half-close: the server sees end of stream on its readable side.
    end(data) {
        if (data !== undefined) this.send(data);
        this._conn.peerEnded = true;
        return this;
    }

    /// Everything the server has written so far.
    received() {
        return this._conn.fromGuest.length === 0
            ? EMPTY
            : Buffer.concat(this._conn.fromGuest);
    }

    text() { return this.received().toString('utf8'); }

    /// True once the server has shut down or closed its side.
    get ended() { return this._conn.guestEnded || this._conn.closed; }
    get closed() { return this._conn.closed; }
}

export class FakeNet {
    /// `listenFd` is what a test puts in WASMHUB_LISTEN_FD. `maxSend` caps a
    /// single send, so the runtime has to make several calls for one write.
    constructor(options = {}) {
        this.listenFd = options.listenFd ?? 3;
        this.maxSend = options.maxSend ?? Infinity;
        this.listenerClosed = false;
        this.nonblocking = new Set();
        this._nextFd = this.listenFd + 1;
        this._pending = [];
        this._conns = new Map();
    }

    /// Open a connection to the server and return the client's end of it.
    connect() {
        const conn = new Connection(this._nextFd++);
        this._pending.push(conn);
        return new Peer(conn);
    }

    /// The object the harness hands to the runtime as its os.sock* bindings.
    get backend() {
        const self = this;
        return {
            nonblocking(fd) { self.nonblocking.add(fd); return null; },

            accept(fd) {
                if (fd !== self.listenFd || self.listenerClosed) return [-1, 'EBADF'];
                if (self._pending.length === 0) return [-1, 'EAGAIN'];
                const conn = self._pending.shift();
                self._conns.set(conn.fd, conn);
                return [conn.fd, null];
            },

            recv(fd, arrayBuffer, offset, length) {
                const conn = self._conns.get(fd);
                if (!conn || conn.closed) return [-1, 'EBADF'];
                if (conn.toGuest.length === 0) {
                    // The distinction the runtime must not collapse.
                    return conn.peerEnded ? [0, null] : [-1, 'EAGAIN'];
                }
                const head = conn.toGuest[0];
                const n = Math.min(length, head.length);
                new Uint8Array(arrayBuffer, offset, n).set(head.subarray(0, n));
                if (n === head.length) conn.toGuest.shift();
                else conn.toGuest[0] = head.subarray(n);
                return [n, null];
            },

            send(fd, arrayBuffer, offset, length) {
                const conn = self._conns.get(fd);
                if (!conn || conn.closed) return [-1, 'EBADF'];
                if (conn.guestEnded) return [-1, 'EPIPE'];
                const n = Math.min(length, self.maxSend);
                if (n === 0) return [-1, 'EAGAIN'];
                conn.fromGuest.push(Buffer.from(new Uint8Array(arrayBuffer, offset, n)));
                return [n, null];
            },

            shutdown(fd, how) {
                const conn = self._conns.get(fd);
                if (!conn) return 'EBADF';
                if (how.includes('w')) conn.guestEnded = true;
                return null;
            },

            close(fd) {
                if (fd === self.listenFd) { self.listenerClosed = true; return null; }
                const conn = self._conns.get(fd);
                if (!conn) return 'EBADF';
                conn.closed = true;
                conn.guestEnded = true;
                return null;
            },
        };
    }
}

/// Polls `predicate` until it is truthy, so a test waits on the runtime's own
/// timer-driven loop instead of guessing at a sleep.
export async function until(predicate, { timeout = 2000, label = 'condition' } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
        const value = predicate();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise(resolve => setTimeout(resolve, 2));
    }
}
