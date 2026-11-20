// @spinframework/spin-code-sandbox, an extensible client for sandboxed code execution,
// consumed from a Spin application.
//
// Author a tool against `CodeRunner` (from "@spinframework/spin-code-sandbox/core") and it
// runs unchanged on any backend; the host injects the concrete client:
//
//   import { Interpreter } from "@spinframework/spin-code-sandbox/interpreter";
//   const runner = new Interpreter({ baseUrl: "http://ts-sandbox.spin.internal" });
//
// Only the Wasm interpreter backend ships today. To extend it, add a new module
// that implements `CodeRunner` and declares itself through `Caps`, and export it
// below. The core contract (`CodeRunner`, `RunOpts`, `Result`, `Caps`) is
// backend-neutral. Agent tools live in "@spinframework/spin-code-sandbox/tools" so that only
// apps that use them need the optional `zod` peer dependency.

export * from "./core/index.ts";
export { Interpreter, InterpreterKV, type BoundRunOpts, type InterpreterOptions } from "./interpreter/index.ts";
export { KvCodeStore, serveStoredCode, type KvCodeStoreOptions } from "./store/index.ts";
