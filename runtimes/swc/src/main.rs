//! swc — a TypeScript → JavaScript transpiler as a WASI CLI.
//!
//! Usage:
//!   swc version                     print the transpiler version
//!   swc [options] <file.ts|.tsx>... transpile each input in place
//!
//! Options:
//!   --target <version>       down-level the output (es3, es5, es2015 … es2024,
//!                            esnext; default esnext, which lowers nothing)
//!   --jsx <mode>             classic (React.createElement, the default) or
//!                            automatic (the react/jsx-runtime import)
//!   --jsx-import-source <p>  package the automatic runtime imports from
//!   --decorators             legacy (TypeScript `experimentalDecorators`)
//!   --decorator-metadata     emit design:type metadata; implies --decorators
//!   --source-map             write a sibling `.js.map` and link it from the
//!                            emitted file
//!
//! Each input (a path relative to the preopened root) is transpiled and
//! written as a sibling `.js` file: types stripped, TSX lowered, and ES
//! modules lowered to CommonJS (the module system of the wasmhub nodejs
//! runtime), with interop helpers inlined.
//!
//! Exits non-zero if any input fails; errors are written to stderr as
//! `error: <file>:<line>:<col>: <message>` referencing the original source.
//!
//! Consumed by wasmrun's agent mode (`language: "typescript"`), which runs
//! this module inside the session sandbox before the nodejs runtime.
//!
//! ⚠️ Build note: this crate MUST be compiled MVP-lowered (see
//! `scripts/build-swc.sh`) — default rustc wasm builds emit post-MVP
//! instructions (multi-value, sign-ext, bulk-memory) that downstream
//! interpreters may not support.

use swc_core::common::comments::SingleThreadedComments;
use swc_core::common::source_map::DefaultSourceMapGenConfig;
use swc_core::common::sync::Lrc;
use swc_core::common::{FileName, Globals, Mark, SourceMap, Spanned, GLOBALS};
use swc_core::ecma::ast::{EsVersion, Pass};
use swc_core::ecma::codegen::text_writer::JsWriter;
use swc_core::ecma::codegen::Emitter;
use swc_core::ecma::parser::{lexer::Lexer, Parser, StringInput, Syntax, TsSyntax};
use swc_core::ecma::transforms::base::fixer::fixer;
use swc_core::ecma::transforms::base::helpers::{inject_helpers, Helpers, HELPERS};
use swc_core::ecma::transforms::base::hygiene::hygiene;
use swc_core::ecma::transforms::base::resolver;
use swc_core::ecma::transforms::compat;
use swc_core::ecma::transforms::module::common_js::common_js;
use swc_core::ecma::transforms::proposal::decorators;
use swc_core::ecma::transforms::react;
use swc_core::ecma::transforms::typescript::strip;

/// What the flags asked for. Defaults match the pre-flag behavior exactly, so
/// a caller that passes only file paths gets the same output as before.
struct Options {
    target: EsVersion,
    jsx_runtime: react::Runtime,
    jsx_import_source: Option<String>,
    decorators: bool,
    decorator_metadata: bool,
    source_map: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            target: EsVersion::EsNext,
            jsx_runtime: react::Runtime::Classic,
            jsx_import_source: None,
            decorators: false,
            decorator_metadata: false,
            source_map: false,
        }
    }
}

fn usage() -> ! {
    eprintln!("usage: swc [options] <file.ts|file.tsx>...");
    eprintln!("options:");
    eprintln!("  --target <version>       es3, es5, es2015 … es2024, esnext (default esnext)");
    eprintln!("  --jsx <mode>             classic (default) or automatic");
    eprintln!("  --jsx-import-source <p>  import source for the automatic runtime");
    eprintln!("  --decorators             legacy TypeScript decorators");
    eprintln!("  --decorator-metadata     emit decorator metadata (implies --decorators)");
    eprintln!("  --source-map             write a sibling .js.map");
    std::process::exit(2);
}

fn parse_target(value: &str) -> Option<EsVersion> {
    Some(match value {
        "es3" => EsVersion::Es3,
        "es5" => EsVersion::Es5,
        "es6" | "es2015" => EsVersion::Es2015,
        "es2016" => EsVersion::Es2016,
        "es2017" => EsVersion::Es2017,
        "es2018" => EsVersion::Es2018,
        "es2019" => EsVersion::Es2019,
        "es2020" => EsVersion::Es2020,
        "es2021" => EsVersion::Es2021,
        "es2022" => EsVersion::Es2022,
        "es2023" => EsVersion::Es2023,
        "es2024" => EsVersion::Es2024,
        "esnext" | "latest" => EsVersion::EsNext,
        _ => return None,
    })
}

/// Split the command line into options and inputs. Values may be given as
/// `--flag value` or `--flag=value`; `--` ends option parsing.
fn parse_args(args: Vec<String>) -> (Options, Vec<String>) {
    let mut options = Options::default();
    let mut inputs = Vec::new();
    let mut iter = args.into_iter().peekable();
    let mut only_files = false;

    while let Some(arg) = iter.next() {
        if only_files || !arg.starts_with("--") {
            inputs.push(arg);
            continue;
        }
        if arg == "--" {
            only_files = true;
            continue;
        }

        let (flag, inline) = match arg.split_once('=') {
            Some((f, v)) => (f.to_string(), Some(v.to_string())),
            None => (arg, None),
        };
        let mut value = |flag: &str| -> String {
            inline.clone().or_else(|| iter.next()).unwrap_or_else(|| {
                eprintln!("error: {flag} requires a value");
                usage()
            })
        };

        match flag.as_str() {
            "--source-map" => options.source_map = true,
            "--decorators" => options.decorators = true,
            "--decorator-metadata" => {
                options.decorators = true;
                options.decorator_metadata = true;
            }
            "--target" => {
                let raw = value("--target").to_ascii_lowercase();
                match parse_target(&raw) {
                    Some(v) => options.target = v,
                    None => {
                        eprintln!("error: unknown --target '{raw}'");
                        usage()
                    }
                }
            }
            "--jsx" => {
                let raw = value("--jsx").to_ascii_lowercase();
                options.jsx_runtime = match raw.as_str() {
                    // The tsconfig spellings map onto the two runtimes swc
                    // implements: "react" is the classic factory call,
                    // "react-jsx"/"react-jsxdev" the automatic import.
                    "classic" | "react" => react::Runtime::Classic,
                    "automatic" | "react-jsx" | "react-jsxdev" => react::Runtime::Automatic,
                    _ => {
                        eprintln!("error: unknown --jsx '{raw}' (classic or automatic)");
                        usage()
                    }
                };
            }
            "--jsx-import-source" => options.jsx_import_source = Some(value("--jsx-import-source")),
            other => {
                eprintln!("error: unknown option '{other}'");
                usage()
            }
        }
    }

    (options, inputs)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.len() == 1 && args[0] == "version" {
        println!("swc-transpiler {} (swc_core)", env!("CARGO_PKG_VERSION"));
        return;
    }

    if args.is_empty() {
        usage();
    }

    let (options, inputs) = parse_args(args);
    if inputs.is_empty() {
        eprintln!("error: no input files");
        usage();
    }

    let mut failed = false;
    for path in &inputs {
        if !path.ends_with(".ts") && !path.ends_with(".tsx") {
            eprintln!("error: {path}: input must end in .ts or .tsx");
            failed = true;
            continue;
        }
        if let Err(msg) = transpile_file(path, &options) {
            eprintln!("error: {msg}");
            failed = true;
        }
    }
    std::process::exit(if failed { 1 } else { 0 });
}

/// `foo.ts`/`foo.tsx` → `foo.js`, preserving directories.
fn js_output_path(path: &str) -> String {
    if let Some(stem) = path.strip_suffix(".tsx") {
        format!("{stem}.js")
    } else if let Some(stem) = path.strip_suffix(".ts") {
        format!("{stem}.js")
    } else {
        format!("{path}.js")
    }
}

/// The compat passes needed to reach `target`, newest first. Each one lowers
/// the syntax introduced by its own edition, so running the chain from the top
/// down leaves output the target can execute.
fn lower_to_target(
    program: &mut swc_core::ecma::ast::Program,
    target: EsVersion,
    unresolved: Mark,
) {
    macro_rules! apply {
        ($version:expr, $pass:expr) => {
            if target < $version {
                let mut pass = $pass;
                pass.process(program);
            }
        };
    }

    apply!(
        EsVersion::Es2022,
        compat::es2022(Default::default(), unresolved)
    );
    apply!(EsVersion::Es2021, compat::es2021());
    apply!(
        EsVersion::Es2020,
        compat::es2020(Default::default(), unresolved)
    );
    apply!(EsVersion::Es2019, compat::es2019());
    apply!(EsVersion::Es2018, compat::es2018(Default::default()));
    apply!(
        EsVersion::Es2017,
        compat::es2017(Default::default(), unresolved)
    );
    apply!(EsVersion::Es2016, compat::es2016());
    apply!(
        EsVersion::Es2015,
        compat::es2015(
            unresolved,
            None::<&SingleThreadedComments>,
            Default::default()
        )
    );
    apply!(EsVersion::Es5, compat::es3(true));
}

fn transpile_file(path: &str, options: &Options) -> Result<(), String> {
    let src = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    let tsx = path.ends_with(".tsx");

    let cm: Lrc<SourceMap> = Default::default();
    let fm = cm.new_source_file(Lrc::new(FileName::Custom(path.to_string())), src);

    let comments = SingleThreadedComments::default();
    let lexer = Lexer::new(
        Syntax::Typescript(TsSyntax {
            tsx,
            decorators: true,
            ..Default::default()
        }),
        Default::default(),
        StringInput::from(&*fm),
        Some(&comments),
    );
    let mut parser = Parser::new_from(lexer);
    let located = |e: &swc_core::ecma::parser::error::Error| {
        let pos = cm.lookup_char_pos(e.span().lo());
        format!(
            "{path}:{}:{}: {}",
            pos.line,
            pos.col_display + 1,
            e.kind().msg()
        )
    };
    let mut program = match parser.parse_program() {
        Ok(p) => p,
        Err(e) => return Err(located(&e)),
    };
    // Surface recoverable (non-fatal) parse errors too — silently emitting
    // JS from a broken TS file would defer the confusion to runtime.
    if let Some(e) = parser.take_errors().into_iter().next() {
        return Err(located(&e));
    }

    let out = js_output_path(path);
    let map_name = format!("{}.map", out.rsplit('/').next().unwrap_or(out.as_str()));

    let globals = Globals::default();
    let (code, source_map) = GLOBALS.set(&globals, || {
        // Helpers::new(false) + the `ecma_helpers_inline` feature inline the
        // interop helpers into the output; the sandbox has no @swc/helpers.
        HELPERS.set(&Helpers::new(false), || {
            let unresolved_mark = Mark::new();
            let top_level_mark = Mark::new();

            let mut resolve: Box<dyn Pass> =
                Box::new(resolver(unresolved_mark, top_level_mark, true));
            resolve.process(&mut program);

            // Legacy decorators run before the types they read are stripped:
            // that is where `design:type` metadata comes from.
            if options.decorators {
                let mut pass = decorators(decorators::Config {
                    legacy: true,
                    emit_metadata: options.decorator_metadata,
                    use_define_for_class_fields: false,
                });
                pass.process(&mut program);
            }

            let mut strip_types: Box<dyn Pass> = Box::new(strip(unresolved_mark, top_level_mark));
            strip_types.process(&mut program);

            if tsx {
                let mut pass = react::react(
                    cm.clone(),
                    Some(&comments),
                    react::Options {
                        runtime: Some(options.jsx_runtime),
                        import_source: options.jsx_import_source.as_deref().map(|s| s.into()),
                        ..Default::default()
                    },
                    top_level_mark,
                    unresolved_mark,
                );
                pass.process(&mut program);
            }

            // Down-levelling happens before the module transform, as it does
            // in swc's own pipeline: the compat passes work on syntax, not on
            // the require() calls common_js leaves behind.
            lower_to_target(&mut program, options.target, unresolved_mark);

            let mut finish: Box<dyn Pass> = Box::new((
                common_js(
                    Default::default(),
                    unresolved_mark,
                    Default::default(),
                    Default::default(),
                ),
                inject_helpers(unresolved_mark),
                hygiene(),
                fixer(None),
            ));
            finish.process(&mut program);

            let mut buf = vec![];
            let mut mappings = vec![];
            {
                let mut emitter = Emitter {
                    cfg: swc_core::ecma::codegen::Config::default().with_target(options.target),
                    cm: cm.clone(),
                    comments: None,
                    wr: JsWriter::new(
                        cm.clone(),
                        "\n",
                        &mut buf,
                        options.source_map.then_some(&mut mappings),
                    ),
                };
                emitter.emit_program(&program).unwrap();
            }

            let mut code = String::from_utf8(buf).unwrap();
            if !options.source_map {
                return (code, None);
            }

            // `file_name_to_source` hands back the path the file was parsed
            // under, which is the path the caller passed in, so `sources`
            // points at the original .ts rather than at an absolute host path.
            let mut map = cm.build_source_map(&mappings, None, DefaultSourceMapGenConfig);
            map.set_file(Some(map_name.trim_end_matches(".map").to_string()));
            let mut rendered = vec![];
            let rendered = match map.to_writer(&mut rendered) {
                Ok(()) => Some(rendered),
                Err(_) => None,
            };
            if rendered.is_some() {
                if !code.ends_with('\n') {
                    code.push('\n');
                }
                code.push_str(&format!("//# sourceMappingURL={map_name}\n"));
            }
            (code, rendered)
        })
    });

    std::fs::write(&out, code).map_err(|e| format!("{out}: {e}"))?;
    if let Some(map) = source_map {
        let map_path = format!("{out}.map");
        std::fs::write(&map_path, map).map_err(|e| format!("{map_path}: {e}"))?;
    }
    Ok(())
}
