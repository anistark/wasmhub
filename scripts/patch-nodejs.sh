#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${1:-}"

if [[ -z "${SOURCE_DIR}" ]] || [[ ! -d "${SOURCE_DIR}" ]]; then
    echo "Usage: $0 <source-directory>"
    exit 1
fi

echo "Patching source at ${SOURCE_DIR}..."

# ── QuickJS patches ──────────────────────────────────────────────────────────

if [[ -f "${SOURCE_DIR}/Makefile" ]] && grep -q "quickjs" "${SOURCE_DIR}/Makefile" 2>/dev/null; then
    echo "  [quickjs] Detected QuickJS source tree"

    # Mark CONFIG_WASI in the Makefile so native `make` invocations also get
    # the right defaults (workers disabled, pthreads excluded).
    if grep -q "CONFIG_WASI" "${SOURCE_DIR}/Makefile"; then
        echo "  [quickjs] WASI config already present in Makefile"
    else
        echo "  [quickjs] Adding CONFIG_WASI default to Makefile"
        # GNU sed: insert line before the first CFLAGS= assignment
        sed -i '/^CFLAGS=/i CONFIG_WASI?=y' "${SOURCE_DIR}/Makefile"
    fi

    # Expose entropy to JS as os.getentropy(len) → ArrayBuffer. wasi-libc
    # implements getentropy() via the WASI random_get syscall, which is what
    # backs crypto.getRandomValues in main.js.
    if grep -q "js_os_getentropy" "${SOURCE_DIR}/quickjs-libc.c"; then
        echo "  [quickjs] getentropy binding already present"
    else
        echo "  [quickjs] Adding os.getentropy binding to quickjs-libc.c"
        python3 - "${SOURCE_DIR}/quickjs-libc.c" <<'PYEOF'
import sys

path = sys.argv[1]
content = open(path).read()

func = '''
/* wasmhub: entropy for crypto.getRandomValues — getentropy() is wasi-libc's
   wrapper over the WASI random_get syscall (max 256 bytes per call). */
extern int getentropy(void *buffer, size_t len);

static JSValue js_os_getentropy(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    uint32_t len;
    uint8_t *buf;
    size_t off, chunk;
    JSValue ab;
    if (JS_ToUint32(ctx, &len, argv[0]))
        return JS_EXCEPTION;
    if (len > 65536)
        return JS_ThrowRangeError(ctx, "getentropy: length must not exceed 65536");
    buf = js_malloc(ctx, len ? len : 1);
    if (!buf)
        return JS_EXCEPTION;
    for (off = 0; off < len; off += chunk) {
        chunk = len - off > 256 ? 256 : len - off;
        if (getentropy(buf + off, chunk)) {
            js_free(ctx, buf);
            return JS_ThrowInternalError(ctx, "getentropy failed");
        }
    }
    ab = JS_NewArrayBufferCopy(ctx, buf, len);
    js_free(ctx, buf);
    return ab;
}

'''

anchor = "static const JSCFunctionListEntry js_os_funcs[] = {"
if anchor not in content:
    sys.exit("quickjs-libc.c: js_os_funcs anchor not found")
entry = '    JS_CFUNC_DEF("getentropy", 1, js_os_getentropy ),'
content = content.replace(anchor, func + anchor + "\n" + entry, 1)
open(path, "w").write(content)
PYEOF
    fi

    # Let std.evalScript() name the script it compiles. Stock QuickJS hardcodes
    # "<evalScript>", so every CommonJS module main.js compiled reported the
    # same placeholder and no stack frame said which file it came from.
    if grep -q "wasmhub_eval_filename" "${SOURCE_DIR}/quickjs-libc.c"; then
        echo "  [quickjs] evalScript filename option already present"
    else
        echo "  [quickjs] Adding evalScript filename option to quickjs-libc.c"
        python3 - "${SOURCE_DIR}/quickjs-libc.c" <<'PYEOF'
import sys

path = sys.argv[1]
content = open(path).read()

# 1. Declare the filename locals alongside the existing option locals.
decl_anchor = """    JSValueConst options_obj;
    BOOL backtrace_barrier = FALSE;
    BOOL is_async = FALSE;
    int flags;
"""
if decl_anchor not in content:
    sys.exit("quickjs-libc.c: js_evalScript locals anchor not found")
content = content.replace(decl_anchor, decl_anchor + """    /* wasmhub: optional filename so stack frames name the real script */
    const char *wasmhub_eval_filename = NULL;
    JSValue wasmhub_filename_val = JS_UNDEFINED;
""", 1)

# 2. Read the option next to the ones already parsed.
opt_anchor = """        if (get_bool_option(ctx, &is_async, options_obj,
                            "async"))
            return JS_EXCEPTION;
"""
if opt_anchor not in content:
    sys.exit("quickjs-libc.c: js_evalScript options anchor not found")
content = content.replace(opt_anchor, opt_anchor + """        /* wasmhub */
        wasmhub_filename_val = JS_GetPropertyStr(ctx, options_obj, "filename");
        if (JS_IsException(wasmhub_filename_val))
            return JS_EXCEPTION;
        if (!JS_IsUndefined(wasmhub_filename_val)) {
            wasmhub_eval_filename = JS_ToCString(ctx, wasmhub_filename_val);
            if (!wasmhub_eval_filename) {
                JS_FreeValue(ctx, wasmhub_filename_val);
                return JS_EXCEPTION;
            }
        }
""", 1)

# 3. Use it, and release both borrowed references.
eval_anchor = """    ret = JS_Eval(ctx, str, len, "<evalScript>", flags);
    JS_FreeCString(ctx, str);
"""
if eval_anchor not in content:
    sys.exit("quickjs-libc.c: js_evalScript JS_Eval anchor not found")
content = content.replace(eval_anchor, """    ret = JS_Eval(ctx, str, len,
                  wasmhub_eval_filename ? wasmhub_eval_filename : "<evalScript>",
                  flags);
    JS_FreeCString(ctx, str);
    if (wasmhub_eval_filename)
        JS_FreeCString(ctx, wasmhub_eval_filename);
    JS_FreeValue(ctx, wasmhub_filename_val);
""", 1)

open(path, "w").write(content)
PYEOF
    fi

    # Expose the WASI Preview 1 socket calls to JS as os.sock*, which is what
    # main.js builds the `net` and `http` server halves on. The bindings
    # themselves live in runtimes/nodejs/wasi_sockets.c; this only registers
    # them on the `os` module, alongside the functions quickjs-libc ships.
    if grep -q "wasmhub_sock_funcs" "${SOURCE_DIR}/quickjs-libc.c"; then
        echo "  [quickjs] socket bindings already registered"
    else
        echo "  [quickjs] Registering os.sock* bindings in quickjs-libc.c"
        python3 - "${SOURCE_DIR}/quickjs-libc.c" <<'SOCKEOF'
import re
import sys

path = sys.argv[1]
content = open(path).read()

# The list is defined in wasi_sockets.c, compiled and linked alongside, so an
# extern declaration is all quickjs-libc needs in order to export it.
decl = """
/* wasmhub: host socket bindings (runtimes/nodejs/wasi_sockets.c) */
extern const JSCFunctionListEntry wasmhub_sock_funcs[];
extern const int wasmhub_sock_funcs_count;

"""

init_anchor = "static int js_os_init(JSContext *ctx, JSModuleDef *m)"
if init_anchor not in content:
    sys.exit("quickjs-libc.c: js_os_init anchor not found")
content = content.replace(init_anchor, decl + init_anchor, 1)

# A module's exports are declared with JS_AddModuleExportList when the module
# is created and filled in with JS_SetModuleExportList when it initialises.
# Both have to know about the extra entries or the names resolve to undefined.
add_pat = re.compile(
    r"JS_AddModuleExportList\(ctx,\s*m,\s*js_os_funcs,\s*countof\(js_os_funcs\)\);"
)
if not add_pat.search(content):
    sys.exit("quickjs-libc.c: JS_AddModuleExportList(js_os_funcs) not found")
content = add_pat.sub(
    lambda m: m.group(0)
    + "\n    JS_AddModuleExportList(ctx, m, wasmhub_sock_funcs, wasmhub_sock_funcs_count);",
    content,
    count=1,
)

set_pat = re.compile(
    r"return\s+JS_SetModuleExportList\(ctx,\s*m,\s*js_os_funcs,\s*countof\(js_os_funcs\)\);"
)
if not set_pat.search(content):
    sys.exit("quickjs-libc.c: JS_SetModuleExportList(js_os_funcs) not found")
content = set_pat.sub(
    "if (JS_SetModuleExportList(ctx, m, js_os_funcs, countof(js_os_funcs)))\n"
    "        return -1;\n"
    "    return JS_SetModuleExportList(ctx, m, wasmhub_sock_funcs,\n"
    "                                  wasmhub_sock_funcs_count);",
    content,
    count=1,
)

open(path, "w").write(content)
SOCKEOF
    fi

    # Give main.js the process lifecycle node has. Stock quickjs-libc prints an
    # exception thrown from a timer and carries on, never tracks promise
    # rejections at all, and exits 0 once the loop drains whatever happened, so
    # a crashed program reported success. os.setHostHooks(hooks) installs a
    # rejection tracker and routes those points into JS, which decides what
    # node would: report, emit 'beforeExit' and 'exit', and pick the exit code.
    if grep -q "wasmhub_host_hook" "${SOURCE_DIR}/quickjs-libc.c"; then
        echo "  [quickjs] host lifecycle hooks already present"
    else
        echo "  [quickjs] Adding os.setHostHooks lifecycle hooks to quickjs-libc.c"
        python3 - "${SOURCE_DIR}/quickjs-libc.c" <<'HOOKEOF'
import sys

path = sys.argv[1]
content = open(path).read()

helpers = r'''
/* wasmhub: process lifecycle hooks, registered from main.js with
   os.setHostHooks({ rejection, uncaught, exit }). The object lives on the
   global rather than in a static: a JSValue still held when the generated
   main() frees the runtime trips JS_FreeRuntime's leak assertion. */
#define WASMHUB_HOOKS_PROP "__wasmhubHostHooks"

static JSValue wasmhub_host_hook(JSContext *ctx, const char *name)
{
    JSValue global, hooks, fn = JS_UNDEFINED;
    global = JS_GetGlobalObject(ctx);
    hooks = JS_GetPropertyStr(ctx, global, WASMHUB_HOOKS_PROP);
    if (JS_IsObject(hooks))
        fn = JS_GetPropertyStr(ctx, hooks, name);
    JS_FreeValue(ctx, hooks);
    JS_FreeValue(ctx, global);
    if (JS_IsException(fn)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return JS_UNDEFINED;
    }
    if (!JS_IsFunction(ctx, fn)) {
        JS_FreeValue(ctx, fn);
        return JS_UNDEFINED;
    }
    return fn;
}

/* Takes the pending exception. With no hook, prints it as stock does. */
static void wasmhub_uncaught(JSContext *ctx)
{
    JSValue exc, fn, ret;
    exc = JS_GetException(ctx);
    fn = wasmhub_host_hook(ctx, "uncaught");
    if (JS_IsUndefined(fn)) {
        JS_Throw(ctx, exc);
        js_std_dump_error(ctx);
        return;
    }
    ret = JS_Call(ctx, fn, JS_UNDEFINED, 1, (JSValueConst *)&exc);
    if (JS_IsException(ret))
        js_std_dump_error(ctx);
    JS_FreeValue(ctx, ret);
    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, exc);
}

static void wasmhub_rejection_tracker(JSContext *ctx, JSValueConst promise,
                                      JSValueConst reason,
                                      BOOL is_handled, void *opaque)
{
    JSValue fn, ret;
    JSValueConst args[3];
    fn = wasmhub_host_hook(ctx, "rejection");
    if (JS_IsUndefined(fn))
        return;
    args[0] = promise;
    args[1] = reason;
    args[2] = JS_NewBool(ctx, is_handled);
    ret = JS_Call(ctx, fn, JS_UNDEFINED, 3, args);
    if (JS_IsException(ret))
        js_std_dump_error(ctx);
    JS_FreeValue(ctx, ret);
    JS_FreeValue(ctx, fn);
}

/* The loop is about to drain: node's 'beforeExit'. Nonzero when a listener
   scheduled more work (a job, a timer, an I/O handler), in which case the loop
   carries on and asks again the next time it runs dry. */
static int wasmhub_before_exit(JSContext *ctx)
{
    JSRuntime *rt = JS_GetRuntime(ctx);
    JSThreadState *ts = JS_GetRuntimeOpaque(rt);
    JSValue fn, ret;
    fn = wasmhub_host_hook(ctx, "beforeExit");
    if (JS_IsUndefined(fn))
        return 0;
    ret = JS_Call(ctx, fn, JS_UNDEFINED, 0, NULL);
    if (JS_IsException(ret))
        wasmhub_uncaught(ctx);
    JS_FreeValue(ctx, ret);
    JS_FreeValue(ctx, fn);
    return JS_IsJobPending(rt) || !list_empty(&ts->os_timers) ||
           !list_empty(&ts->os_rw_handlers);
}

/* The loop has nothing left to wait on: node's 'exit'. The hook returns the
   exit code; 0 falls through to the generated main()'s normal teardown. */
static void wasmhub_loop_drained(JSContext *ctx)
{
    JSValue fn, ret;
    int code = 0;
    fn = wasmhub_host_hook(ctx, "exit");
    if (JS_IsUndefined(fn))
        return;
    ret = JS_Call(ctx, fn, JS_UNDEFINED, 0, NULL);
    if (JS_IsException(ret)) {
        js_std_dump_error(ctx);
        code = 1;
    } else if (JS_ToInt32(ctx, &code, ret)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        code = 1;
    }
    JS_FreeValue(ctx, ret);
    JS_FreeValue(ctx, fn);
    if (code != 0) {
        fflush(stdout);
        fflush(stderr);
        exit(code);
    }
}

static JSValue js_os_setHostHooks(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    JSValue global = JS_GetGlobalObject(ctx);
    int ret = JS_DefinePropertyValueStr(ctx, global, WASMHUB_HOOKS_PROP,
                                        JS_DupValue(ctx, argv[0]), 0);
    JS_FreeValue(ctx, global);
    if (ret < 0)
        return JS_EXCEPTION;
    JS_SetHostPromiseRejectionTracker(JS_GetRuntime(ctx),
                                      wasmhub_rejection_tracker, NULL);
    return JS_UNDEFINED;
}

'''

def replace_once(old, new, what):
    global content
    if old not in content:
        sys.exit("quickjs-libc.c: " + what + " anchor not found")
    content = content.replace(old, new, 1)

# 1. The helpers, ahead of their first caller.
replace_once("static void call_handler(JSContext *ctx, JSValueConst func)\n",
             helpers + "static void call_handler(JSContext *ctx, JSValueConst func)\n",
             "call_handler")

# 2. A timer or I/O callback that throws.
replace_once("""    JS_FreeValue(ctx, func1);
    if (JS_IsException(ret))
        js_std_dump_error(ctx);
""", """    JS_FreeValue(ctx, func1);
    if (JS_IsException(ret))
        wasmhub_uncaught(ctx);
""", "call_handler exception")

# 3. A pending job that throws, and the loop draining.
replace_once("""                if (err < 0) {
                    js_std_dump_error(ctx1);
                }
                break;
            }
        }

        if (!os_poll_func || os_poll_func(ctx))
            break;
    }
}
""", """                if (err < 0) {
                    wasmhub_uncaught(ctx1);
                }
                break;
            }
        }

        if (!os_poll_func || os_poll_func(ctx)) {
            if (wasmhub_before_exit(ctx))
                continue;
            break;
        }
    }
    wasmhub_loop_drained(ctx);
}
""", "js_std_loop")

# 4. The binding itself.
replace_once("static const JSCFunctionListEntry js_os_funcs[] = {",
             "static const JSCFunctionListEntry js_os_funcs[] = {\n"
             '    JS_CFUNC_DEF("setHostHooks", 1, js_os_setHostHooks ),',
             "js_os_funcs")

open(path, "w").write(content)
HOOKEOF
    fi

    # Register the engine-backed helpers in runtimes/nodejs/host_bindings.c
    # (native hashing, memoryUsage, the async context) on the `os` module,
    # after the socket list and the same way.
    if grep -q "wasmhub_host_funcs" "${SOURCE_DIR}/quickjs-libc.c"; then
        echo "  [quickjs] host bindings already registered"
    else
        echo "  [quickjs] Registering host bindings in quickjs-libc.c"
        python3 - "${SOURCE_DIR}/quickjs-libc.c" <<'HOSTEOF'
import sys

path = sys.argv[1]
content = open(path).read()

def replace_once(old, new, what):
    global content
    if old not in content:
        sys.exit("quickjs-libc.c: " + what + " anchor not found (is the socket patch applied?)")
    content = content.replace(old, new, 1)

replace_once("extern const int wasmhub_sock_funcs_count;\n",
             "extern const int wasmhub_sock_funcs_count;\n"
             "/* wasmhub: engine-backed helpers (runtimes/nodejs/host_bindings.c) */\n"
             "extern const JSCFunctionListEntry wasmhub_host_funcs[];\n"
             "extern const int wasmhub_host_funcs_count;\n",
             "socket extern declaration")
replace_once("JS_AddModuleExportList(ctx, m, wasmhub_sock_funcs, wasmhub_sock_funcs_count);",
             "JS_AddModuleExportList(ctx, m, wasmhub_sock_funcs, wasmhub_sock_funcs_count);\n"
             "    JS_AddModuleExportList(ctx, m, wasmhub_host_funcs, wasmhub_host_funcs_count);",
             "socket export list")
replace_once("    return JS_SetModuleExportList(ctx, m, wasmhub_sock_funcs,\n"
             "                                  wasmhub_sock_funcs_count);",
             "    if (JS_SetModuleExportList(ctx, m, wasmhub_sock_funcs,\n"
             "                               wasmhub_sock_funcs_count))\n"
             "        return -1;\n"
             "    return JS_SetModuleExportList(ctx, m, wasmhub_host_funcs,\n"
             "                                  wasmhub_host_funcs_count);",
             "socket export values")

open(path, "w").write(content)
HOSTEOF
    fi

    # Carry an async context through promise reactions, for AsyncLocalStorage.
    # The context is captured when a reaction is *registered* (an `await`, a
    # `.then`), not when it is queued: a promise is often settled from a socket
    # poll or another request's code, and the continuation must still see the
    # store it was waiting in. Every queued job carries one extra value past its
    # arguments, which is the context it runs under; the engine swaps it in and
    # out around the job. host_bindings.c reads and writes the current one.
    if grep -q "wasmhub_async_context" "${SOURCE_DIR}/quickjs.c"; then
        echo "  [quickjs] async context already present"
    else
        echo "  [quickjs] Adding the async context to quickjs.c"
        python3 - "${SOURCE_DIR}/quickjs.c" <<'ASYNCEOF'
import sys

path = sys.argv[1]
content = open(path).read()

def replace(old, new, what, count=1):
    global content
    if content.count(old) != count:
        sys.exit("quickjs.c: " + what + " anchor not found " + str(count) + " time(s)")
    content = content.replace(old, new)

# 1. The current context, its accessors, and a queueing call that takes one.
#    A static rather than a runtime field: there is one runtime per process
#    here. JS_FreeRuntime releases it before its leak check.
replace("""int JS_EnqueueJob(JSContext *ctx, JSJobFunc *job_func,
                  int argc, JSValueConst *argv)
{
    JSRuntime *rt = ctx->rt;
    JSJobEntry *e;
    int i;

    e = js_malloc(ctx, sizeof(*e) + argc * sizeof(JSValue));
    if (!e)
        return -1;
    e->ctx = ctx;
    e->job_func = job_func;
    e->argc = argc;
    for(i = 0; i < argc; i++) {
        e->argv[i] = JS_DupValue(ctx, argv[i]);
    }
    list_add_tail(&e->link, &rt->job_list);
    return 0;
}
""", """static JSValue wasmhub_async_context = JS_UNDEFINED;

JSValue wasmhub_get_async_context(JSContext *ctx)
{
    return JS_DupValue(ctx, wasmhub_async_context);
}

void wasmhub_set_async_context(JSContext *ctx, JSValueConst value)
{
    JSValue old = wasmhub_async_context;
    wasmhub_async_context = JS_DupValue(ctx, value);
    JS_FreeValue(ctx, old);
}

/* argv[argc] holds the async context the job runs under. */
static int wasmhub_enqueue_job(JSContext *ctx, JSJobFunc *job_func,
                               int argc, JSValueConst *argv,
                               JSValueConst async_ctx)
{
    JSRuntime *rt = ctx->rt;
    JSJobEntry *e;
    int i;

    e = js_malloc(ctx, sizeof(*e) + (argc + 1) * sizeof(JSValue));
    if (!e)
        return -1;
    e->ctx = ctx;
    e->job_func = job_func;
    e->argc = argc;
    for(i = 0; i < argc; i++) {
        e->argv[i] = JS_DupValue(ctx, argv[i]);
    }
    e->argv[argc] = JS_DupValue(ctx, async_ctx);
    list_add_tail(&e->link, &rt->job_list);
    return 0;
}

int JS_EnqueueJob(JSContext *ctx, JSJobFunc *job_func,
                  int argc, JSValueConst *argv)
{
    return wasmhub_enqueue_job(ctx, job_func, argc, argv,
                               wasmhub_async_context);
}
""", "JS_EnqueueJob")

# 2. Run each job under its own context, then put the caller's back. Whatever
#    the job left current (it may have called enterWith) is released.
replace("""    JSValue res;
    int i, ret;

    if (list_empty(&rt->job_list)) {
        *pctx = NULL;
        return 0;
    }

    /* get the first pending job and execute it */
    e = list_entry(rt->job_list.next, JSJobEntry, link);
    list_del(&e->link);
    ctx = e->ctx;
    res = e->job_func(e->ctx, e->argc, (JSValueConst *)e->argv);
""", """    JSValue res, saved_async_ctx;
    int i, ret;

    if (list_empty(&rt->job_list)) {
        *pctx = NULL;
        return 0;
    }

    /* get the first pending job and execute it */
    e = list_entry(rt->job_list.next, JSJobEntry, link);
    list_del(&e->link);
    ctx = e->ctx;
    saved_async_ctx = wasmhub_async_context;
    wasmhub_async_context = e->argv[e->argc];
    res = e->job_func(e->ctx, e->argc, (JSValueConst *)e->argv);
    JS_FreeValue(ctx, wasmhub_async_context);
    wasmhub_async_context = saved_async_ctx;
""", "JS_ExecutePendingJob")

# 3. Teardown: the jobs' extra slot, and the current context itself.
replace("""    JS_FreeValueRT(rt, rt->current_exception);

    list_for_each_safe(el, el1, &rt->job_list) {
        JSJobEntry *e = list_entry(el, JSJobEntry, link);
        for(i = 0; i < e->argc; i++)
            JS_FreeValueRT(rt, e->argv[i]);
""", """    JS_FreeValueRT(rt, rt->current_exception);
    JS_FreeValueRT(rt, wasmhub_async_context);
    wasmhub_async_context = JS_UNDEFINED;

    list_for_each_safe(el, el1, &rt->job_list) {
        JSJobEntry *e = list_entry(el, JSJobEntry, link);
        for(i = 0; i <= e->argc; i++)
            JS_FreeValueRT(rt, e->argv[i]);
""", "JS_FreeRuntime")

# 4. A promise reaction remembers the context it was registered in.
replace("""    JSValue resolving_funcs[2];
    JSValue handler;
} JSPromiseReactionData;
""", """    JSValue resolving_funcs[2];
    JSValue handler;
    JSValue async_ctx; /* wasmhub: context at registration */
} JSPromiseReactionData;
""", "JSPromiseReactionData")

replace("""    JS_FreeValueRT(rt, rd->handler);
    js_free_rt(rt, rd);
""", """    JS_FreeValueRT(rt, rd->handler);
    JS_FreeValueRT(rt, rd->async_ctx);
    js_free_rt(rt, rd);
""", "promise_reaction_data_free")

# Marked, or a context reachable only through a pending reaction would look
# like an external reference to the cycle collector and outlive the runtime.
replace("""            JS_MarkValue(rt, rd->handler, mark_func);
""", """            JS_MarkValue(rt, rd->handler, mark_func);
            JS_MarkValue(rt, rd->async_ctx, mark_func);
""", "js_promise_mark")

replace("""        rd->handler = JS_DupValue(ctx, handler);
        rd_array[i] = rd;
""", """        rd->handler = JS_DupValue(ctx, handler);
        rd->async_ctx = JS_DupValue(ctx, wasmhub_async_context);
        rd_array[i] = rd;
""", "perform_promise_then")

# Both places a reaction is queued: on settlement, and at registration when
# the promise has already settled.
replace("JS_EnqueueJob(ctx, promise_reaction_job, 5, args);",
        "wasmhub_enqueue_job(ctx, promise_reaction_job, 5, args, rd->async_ctx);",
        "promise_reaction_job enqueue", count=2)

open(path, "w").write(content)
ASYNCEOF
    fi

    echo "  [quickjs] Patches applied"
    exit 0
fi

# ── Node.js patches (full Node.js build, weeks 11-13) ───────────────────────

if [[ -f "${SOURCE_DIR}/configure.py" ]]; then
    echo "  [nodejs] Detected Node.js source tree"

    # configure.py: add 'wasi' to valid dest_os values
    if ! grep -q "'wasi'" "${SOURCE_DIR}/configure.py"; then
        echo "  [nodejs] Patching configure.py: add wasi dest_os"
        sed -i "s/'android', 'freebsd'/'android', 'freebsd', 'wasi'/" "${SOURCE_DIR}/configure.py" || \
        sed -i "s/valid_os = \[/valid_os = ['wasi',/" "${SOURCE_DIR}/configure.py"
    fi

    # configure.py: add 'wasm32' to valid dest_cpu values
    if ! grep -q "'wasm32'" "${SOURCE_DIR}/configure.py"; then
        echo "  [nodejs] Patching configure.py: add wasm32 dest_cpu"
        sed -i "s/valid_arch = \[/valid_arch = ['wasm32',/" "${SOURCE_DIR}/configure.py" || true
    fi

    # node.gyp: disable V8 JIT tiers that require mmap(PROT_EXEC)
    if [[ -f "${SOURCE_DIR}/node.gyp" ]] && ! grep -q "OS==\"wasi\"" "${SOURCE_DIR}/node.gyp"; then
        echo "  [nodejs] Patching node.gyp: disable V8 JIT for WASI"
        python3 - "${SOURCE_DIR}/node.gyp" <<'PYEOF'
import re, sys
content = open(sys.argv[1]).read()
wasi_condition = """['OS=="wasi"', {
          'v8_enable_turbofan%': 0,
          'v8_enable_maglev%': 0,
        }],"""
content = re.sub(r"('OS==\"linux\"')", r"\1, " + wasi_condition.replace('\n', '\n          '), content, count=1)
open(sys.argv[1], 'w').write(content)
PYEOF
    fi

    # libuv: minimal WASI event loop stub (no epoll/kqueue; networking unsupported)
    UV_WASI_STUB="${SOURCE_DIR}/deps/uv/src/wasi.c"
    if [[ ! -f "${UV_WASI_STUB}" ]]; then
        echo "  [nodejs] Creating libuv WASI stub"
        mkdir -p "$(dirname "${UV_WASI_STUB}")"
        cat > "${UV_WASI_STUB}" <<'WASI_STUB'
#if defined(__wasi__)
#include "uv.h"
#include <errno.h>
#include <string.h>

int uv_loop_init(uv_loop_t* loop) { memset(loop, 0, sizeof(*loop)); return 0; }
int uv_run(uv_loop_t* loop, uv_run_mode mode) { (void)loop; (void)mode; return 0; }
void uv_stop(uv_loop_t* loop) { (void)loop; }
int uv_loop_close(uv_loop_t* loop) { (void)loop; return 0; }
int uv_tcp_init(uv_loop_t* loop, uv_tcp_t* handle) { (void)loop; (void)handle; return UV_ENOSYS; }
int uv_listen(uv_stream_t* stream, int backlog, uv_connection_cb cb) { (void)stream; (void)backlog; (void)cb; return UV_ENOSYS; }
int uv_tcp_connect(uv_connect_t* req, uv_tcp_t* handle, const struct sockaddr* addr, uv_connect_cb cb)
{ (void)req; (void)handle; (void)addr; (void)cb; return UV_ENOSYS; }
#endif /* __wasi__ */
WASI_STUB
    fi

    echo "  [nodejs] Patches applied"
    exit 0
fi

echo "Warning: unrecognised source tree at ${SOURCE_DIR} — no patches applied"
