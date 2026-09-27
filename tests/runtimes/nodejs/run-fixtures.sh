#!/usr/bin/env bash
# Run every fixture in ./fixtures against a built nodejs wasm under wasmtime,
# checking each one's exit code and a line of its output.
#
# The node harness (*.test.mjs) covers the runtime's pure-JS logic, but not the
# real engine: its event loop, its console, WASI, or the exit code the process
# really ends with. v0.5.0 shipped a runtime whose console had no `error` and
# whose failed runs exited 0, and both would have shown up here.
#
# Usage: tests/runtimes/nodejs/run-fixtures.sh [path/to/nodejs-20.wasm]
#
# httpserver.js needs wasmtime to hand in a listening socket, which only its
# legacy Preview 1 implementation can do, and wasmtime 47 removed that. On a
# wasmtime that cannot, the check is skipped; WASMHUB_REQUIRE_HTTP=1 makes the
# skip a failure instead, which is how CI keeps it from quietly lapsing.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${HERE}/../../.." && pwd)"
WASM="${1:-${PROJECT_ROOT}/runtimes/nodejs/nodejs-20.wasm}"
FIXTURES="${HERE}/fixtures"

if ! command -v wasmtime > /dev/null; then
    echo "Error: wasmtime is required (https://wasmtime.dev)" >&2
    exit 1
fi
if [[ ! -f "${WASM}" ]]; then
    echo "Error: no runtime at ${WASM}; build one with 'just build-nodejs'" >&2
    exit 1
fi
WASM="$(cd "$(dirname "${WASM}")" && pwd)/$(basename "${WASM}")"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
mkdir -p "${TMP}/tmp"

PASSED=0
FAILED=0

# check <name> <expected exit> <expected output substring> <stdin> <args...>
check() {
    local name="$1" want_code="$2" want_text="$3" input="$4"
    shift 4
    local out code=0
    # Run from the fixtures dir, preopened as ".", so paths stay relative.
    out="$(cd "${FIXTURES}" && printf '%s' "${input}" \
        | wasmtime run --dir . --dir "${TMP}/tmp::/tmp" "${WASM}" run "$@" 2>&1)" || code=$?
    if [[ "${code}" == "${want_code}" ]] && [[ "${out}" == *"${want_text}"* ]]; then
        echo "ok   ${name}"
        PASSED=$((PASSED + 1))
    else
        echo "FAIL ${name}: exit ${code} (want ${want_code}), expected output containing '${want_text}'"
        printf '%s\n' "${out}" | sed 's/^/     | /'
        FAILED=$((FAILED + 1))
    fi
}

check app                0 'require.main===module: true' '' ./app.js
check timers             0 'interval 3'                  '' ./timers.js
check buffer             0 'done'                        '' ./buffer.js
check base               0 'callbackify=10'              '' ./base.js
check stream             0 'pipe=FOO|BAR|BAZ|!'          '' ./stream.js
check webglobals         0 'fetch.err=clear'             '' ./webglobals.js
check builtins           0 'builtins=pass'               '' ./builtins.js
check resolver           0 'resolver=pass'               '' ./resolver.js
check testrunner         0 '# pass 3'                    '' ./testrunner.js
check stdin              0 'stdin=pass'                  'hello from the host' ./stdin.js
check stdin-mismatch     1 'stdin=FAIL'                  'something else' ./stdin.js

check lifecycle:console      0 'to stderr'                  '' ./lifecycle.js console
check lifecycle:catch-exit   1 'caught boom'                '' ./lifecycle.js catch-exit
check lifecycle:unhandled    1 'TypeError: nobody caught me' '' ./lifecycle.js unhandled
check lifecycle:late-catch   0 'lifecycle=pass'             '' ./lifecycle.js late-catch
check lifecycle:timer-throw  1 'Error: in timer'            '' ./lifecycle.js timer-throw
check lifecycle:exit-code    3 'exit event 3'               '' ./lifecycle.js exit-code
check lifecycle:listeners    0 'lifecycle=pass'             '' ./lifecycle.js listeners

# A failing node:test run has to exit 1, or a caller cannot see it failed.
WASMTIME_FAIL_ENV=(--env WASMHUB_TEST_FAIL=1)
out="$(cd "${FIXTURES}" && wasmtime run "${WASMTIME_FAIL_ENV[@]}" --dir . "${WASM}" run ./testrunner.js 2>&1)" && code=0 || code=$?
if [[ "${code}" == 1 ]] && [[ "${out}" == *"# fail 1"* ]]; then
    echo "ok   testrunner-failing"
    PASSED=$((PASSED + 1))
else
    echo "FAIL testrunner-failing: exit ${code} (want 1)"
    FAILED=$((FAILED + 1))
fi

# httpserver.js needs a listening socket from the host and a client to talk to.
# Older wasmtime spells the option --tcplisten; 14 to 46 offer it only on the
# legacy Preview 1 implementation, as -S tcplisten; 47 and later not at all.
listen_args() {
    if wasmtime run --help 2>&1 | grep -q -- '--tcplisten'; then
        LISTEN=(--tcplisten "$1")
    else
        LISTEN=(-S preview2=n -S "tcplisten=$1")
    fi
}
listen_args 127.0.0.1:0
HTTP_SKIP=""
if ! command -v curl > /dev/null; then
    HTTP_SKIP="curl not found"
elif ! wasmtime run "${LISTEN[@]}" "${WASM}" version > /dev/null 2>&1; then
    HTTP_SKIP="this wasmtime ($(wasmtime --version)) cannot hand a listening socket to a Preview 1 module; 46.x is the last that can"
fi

if [[ -z "${HTTP_SKIP}" ]]; then
    PORT=$((20000 + RANDOM % 20000))
    ADDR="127.0.0.1:${PORT}"
    listen_args "${ADDR}"
    # Through eval rather than run: with the socket on fd 3, wasi-libc's
    # preopen scan stops there and no --dir after it is visible, so the file
    # could not be opened. httpserver.js requires only built-ins.
    wasmtime run "${LISTEN[@]}" \
        --env WASMHUB_LISTEN_FD=3 --env "WASMHUB_LISTEN_ADDR=${ADDR}" \
        "${WASM}" eval "$(cat "${FIXTURES}/httpserver.js")" > "${TMP}/http.out" 2>&1 &
    SERVER=$!
    ok=false
    for _ in $(seq 1 50); do
        if body="$(curl -sf "http://${ADDR}/hello" 2>/dev/null)"; then ok=true; break; fi
        sleep 0.1
    done
    post="$(curl -sf -d ping "http://${ADDR}/x" 2>/dev/null || true)"
    curl -sf "http://${ADDR}/stop" > /dev/null 2>&1 || true
    code=0
    wait "${SERVER}" || code=$?
    if ${ok} && [[ "${body}" == *'"url":"/hello"'* ]] && [[ "${post}" == *'"body":"ping"'* ]] && [[ "${code}" == 0 ]]; then
        echo "ok   httpserver"
        PASSED=$((PASSED + 1))
    else
        echo "FAIL httpserver: exit ${code}, GET '${body:-}', POST '${post}'"
        sed 's/^/     | /' "${TMP}/http.out"
        FAILED=$((FAILED + 1))
    fi
elif [[ "${WASMHUB_REQUIRE_HTTP:-}" == "1" ]]; then
    echo "FAIL httpserver: ${HTTP_SKIP}"
    FAILED=$((FAILED + 1))
else
    echo "skip httpserver: ${HTTP_SKIP}"
fi

echo ""
echo "${PASSED} passed, ${FAILED} failed"
[[ "${FAILED}" == 0 ]]
