//! swc — a TypeScript → JavaScript transpiler as a WASI CLI.
//!
//! Usage:
//!   swc version                     print the transpiler version
//!   swc <file.ts|file.tsx>...       transpile each input in place
//!
//! Each input (a path relative to the preopened root) is transpiled and
//! written as a sibling `.js` file: types stripped, TSX lowered to
//! `React.createElement`, and ES modules lowered to CommonJS (the module
//! system of the wasmhub nodejs runtime), with interop helpers inlined.
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
use swc_core::common::sync::Lrc;
use swc_core::common::{FileName, Globals, Mark, SourceMap, Spanned, GLOBALS};
use swc_core::ecma::ast::Pass;
use swc_core::ecma::codegen::text_writer::JsWriter;
use swc_core::ecma::codegen::Emitter;
use swc_core::ecma::parser::{lexer::Lexer, Parser, StringInput, Syntax, TsSyntax};
use swc_core::ecma::transforms::base::fixer::fixer;
use swc_core::ecma::transforms::base::helpers::{inject_helpers, Helpers, HELPERS};
use swc_core::ecma::transforms::base::hygiene::hygiene;
use swc_core::ecma::transforms::base::resolver;
use swc_core::ecma::transforms::module::common_js::common_js;
use swc_core::ecma::transforms::react;
use swc_core::ecma::transforms::typescript::strip;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.len() == 1 && args[0] == "version" {
        println!("swc-transpiler {} (swc_core)", env!("CARGO_PKG_VERSION"));
        return;
    }

    if args.is_empty() {
        eprintln!("usage: swc <file.ts|file.tsx>...");
        std::process::exit(2);
    }

    let mut failed = false;
    for path in &args {
        if !path.ends_with(".ts") && !path.ends_with(".tsx") {
            eprintln!("error: {path}: input must end in .ts or .tsx");
            failed = true;
            continue;
        }
        if let Err(msg) = transpile_file(path) {
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

fn transpile_file(path: &str) -> Result<(), String> {
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

    let globals = Globals::default();
    let code = GLOBALS.set(&globals, || {
        // Helpers::new(false) + the `ecma_helpers_inline` feature inline the
        // interop helpers into the output; the sandbox has no @swc/helpers.
        HELPERS.set(&Helpers::new(false), || {
            let unresolved_mark = Mark::new();
            let top_level_mark = Mark::new();

            let mut pass: Box<dyn Pass> = if tsx {
                Box::new((
                    resolver(unresolved_mark, top_level_mark, true),
                    strip(unresolved_mark, top_level_mark),
                    react::react(
                        cm.clone(),
                        Some(&comments),
                        react::Options::default(),
                        top_level_mark,
                        unresolved_mark,
                    ),
                    common_js(
                        Default::default(),
                        unresolved_mark,
                        Default::default(),
                        Default::default(),
                    ),
                    inject_helpers(unresolved_mark),
                    hygiene(),
                    fixer(None),
                ))
            } else {
                Box::new((
                    resolver(unresolved_mark, top_level_mark, true),
                    strip(unresolved_mark, top_level_mark),
                    common_js(
                        Default::default(),
                        unresolved_mark,
                        Default::default(),
                        Default::default(),
                    ),
                    inject_helpers(unresolved_mark),
                    hygiene(),
                    fixer(None),
                ))
            };
            pass.process(&mut program);

            let mut buf = vec![];
            {
                let mut emitter = Emitter {
                    cfg: Default::default(),
                    cm: cm.clone(),
                    comments: None,
                    wr: JsWriter::new(cm.clone(), "\n", &mut buf, None),
                };
                emitter.emit_program(&program).unwrap();
            }
            String::from_utf8(buf).unwrap()
        })
    });

    let out = js_output_path(path);
    std::fs::write(&out, code).map_err(|e| format!("{out}: {e}"))?;
    Ok(())
}
