import * as std from "std";
import * as os from "os";

const NODE_COMPAT_VERSION = "20";
const ENGINE = "QuickJS";

function printUsage() {
    std.out.puts("WasmHub Node.js Runtime\n");
    std.out.puts("\n");
    std.out.puts("Usage: nodejs-runtime <command> [args...]\n");
    std.out.puts("\n");
    std.out.puts("Commands:\n");
    std.out.puts("  version         Print runtime version info\n");
    std.out.puts("  eval <code>     Evaluate JavaScript\n");
    std.out.puts("  run <file>      Execute a JavaScript file\n");
    std.out.puts("  env             Print environment variables\n");
    std.out.puts("  echo [args...]  Print arguments to stdout\n");
    std.out.flush();
}

function printVersion() {
    std.out.puts(`WasmHub Node.js Runtime\n`);
    std.out.puts(`Node.js compat: v${NODE_COMPAT_VERSION}.x\n`);
    std.out.puts(`Engine: ${ENGINE}\n`);
    std.out.puts(`Target: WASI Preview 1\n`);
    std.out.puts(`Features: eval, filesystem, env, args, stdio\n`);
    std.out.flush();
}

function evalCode(code) {
    try {
        const result = eval(code);
        if (result !== undefined) {
            std.out.puts(String(result) + "\n");
        }
    } catch (e) {
        std.err.puts(`Error: ${e.message}\n`);
        std.err.flush();
        os.exit(1);
    }
    std.out.flush();
}

function runFile(path) {
    const f = std.open(path, "r");
    if (!f) {
        std.err.puts(`Error: cannot open '${path}'\n`);
        std.err.flush();
        os.exit(1);
    }
    const code = f.readAsString();
    f.close();
    evalCode(code);
}

function printEnv() {
    // QuickJS exposes environ via std.getenv; enumerate known vars via os
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

// QuickJS runs the module body during LINKING before C module init_funcs are called,
// so std.out/std.err are JS_UNDEFINED at that point. Guard the dispatch on std.out
// being truthy so LINKING succeeds; dispatch runs on the EVALUATION pass.
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
            evalCode(argv.slice(2).join(" "));
            break;
        case "run":
            if (argv.length < 3) {
                std.err.puts("Error: run requires a file path\n");
                std.err.flush();
                os.exit(1);
            }
            runFile(argv[2]);
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
