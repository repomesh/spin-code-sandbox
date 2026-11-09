// Compile-time assertions. This file is typechecked by `tsc` (npm run typecheck)
// but never executed. The `@ts-expect-error` lines fail the build if a method
// that MUST be backend-locked ever becomes callable on the wrong client; i.e.
// they prove the "non-portability is a compile error" guarantee, and that the
// `CodeRunner` contract is the (only) portable surface a future backend joins.

import type { CodeRunner, Result } from "../src/core/index.ts";
import { Interpreter } from "../src/interpreter/index.ts";

declare const itp: Interpreter;

// A portable tool depends only on the interface: it accepts ANY backend that
// implements CodeRunner.
async function portableTool(r: CodeRunner): Promise<Result> {
  return r.run("print(1)", { lang: "python", allowedHosts: ["api.x.com"], identity: "t" });
}
void portableTool(itp);

// The concrete client satisfies CodeRunner.
const asRunner: CodeRunner = itp;
void asRunner;

// The interpreter has NO filesystem / sessions / exec; these must not compile.
// A heavier backend would add such methods on its OWN client, never on this one,
// so a tool that needs them is a compile error against the interpreter.
// @ts-expect-error interpreter has no filesystem
itp.writeFile("/f", "x");
// @ts-expect-error interpreter has no stateful sessions
itp.startSession("python");
// @ts-expect-error interpreter has no subprocess exec
itp.exec(["echo", "hi"]);

// But the interpreter DOES have its scoped-KV power surface.
void itp.kv("ns");

// The tool's languages and input type come from the interpreters it is given.
import { interpreterTool, type InterpreterToolInput } from "../src/tools.ts";
const both = interpreterTool({ interpreters: { python: itp, javascript: itp } });
const parsed: InterpreterToolInput = both.inputSchema.parse({});
const lang: "python" | "javascript" = parsed.language;
void lang;
const deps: Record<string, string> | undefined = parsed.dependencies;
void deps;
// @ts-expect-error execution policy is not a tool argument
void parsed.allowedHosts;
const pyOnly = interpreterTool({ interpreters: { python: itp } });
// @ts-expect-error language is inferred as "python" from the interpreters given
const notPy: "javascript" = pyOnly.inputSchema.parse({}).language;
void notPy;
// @ts-expect-error a Python-only tool cannot run JavaScript
void pyOnly.run({ language: "javascript", code: "" });
// @ts-expect-error a policy cannot smuggle in run options such as packageJson
void both.withPolicy({ packageJson: {} });
// withPolicy keeps the tool's languages.
const pyAgain: "python" = pyOnly.withPolicy({ identity: "s" }).inputSchema.parse({}).language;
void pyAgain;
