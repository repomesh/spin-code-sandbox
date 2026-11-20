# @spinframework/spin-code-sandbox

An extensible TypeScript client for sandboxed code execution, consumed from a Spin application. It ships one backend today, the Wasm code interpreter (this repo's `ts-sandbox` / `py-sandbox` components), and is built so another backend can be added later without changing the portable surface.

## The portable contract

Author a tool against the `CodeRunner` interface and it runs unchanged on any backend; the host injects the concrete client at the edge.

```ts
import type { CodeRunner } from "@spinframework/spin-code-sandbox/core";
import { Interpreter } from "@spinframework/spin-code-sandbox/interpreter";

// A tool depends only on the interface, so the backend can be swapped without touching it.
async function compute(runner: CodeRunner, code: string) {
  const r = await runner.run(code, { lang: "python", allowedHosts: [] });
  if (r.error) throw new Error(`${r.error.name}: ${r.error.value}`);
  return r.stdout;
}

const runner = Interpreter.python({ baseUrl: "http://py-sandbox.spin.internal" });
console.log(await compute(runner, "print(6 * 7)"));
```

`run()` returns data (`{ stdout, stderr, results, error? }`): an exception inside the sandbox is `Result.error`, not a thrown error. `run()` only throws for transport, auth, or validation failures.

## Agent tools

`interpreterTool()` gives an agent a ready-to-run `run_in_wasm_interpreter` tool. Pass it your `Interpreter` clients (one per language; the tool offers exactly those languages) and your execution policy. It validates the model's arguments against a strict [Zod](https://zod.dev) schema, runs the code, and formats the output for the model. Zod is a peer dependency: install `zod@^4` in apps that import `@spinframework/spin-code-sandbox/tools`.

```ts
import { Interpreter } from "@spinframework/spin-code-sandbox/interpreter";
import { interpreterTool } from "@spinframework/spin-code-sandbox/tools";

const sandbox = interpreterTool({
  interpreters: {
    python: Interpreter.python({ baseUrl: "http://py-sandbox.spin.internal" }),
    javascript: Interpreter.javascript({ baseUrl: "http://ts-sandbox.spin.internal" }),
  },
  // Optional. The default denies egress and KV and uses a fresh identity per run.
  policy: { allowedHosts: ["https://api.example.com"] },
});

// Agent system prompt. Keep the floating-promise rule: un-awaited work is discarded silently.
export const SYSTEM_PROMPT =
  "Write code and run it in the sandbox; never compute by hand. Print results to stdout. " +
  "In JavaScript, await all asynchronous work: never leave floating promises (an un-awaited " +
  "async call, IIFE, or timer), because work still running when the program ends is discarded.";
```

| Method | Use it for |
| --- | --- |
| `sandbox.call(input)` | Raw model arguments in, `{ content, isError }` out: validate, run, format. |
| `sandbox.execute(args)` | The Vercel AI SDK `execute`: validated arguments in, text out. |
| `sandbox.parse(input)` | Validation alone: `{ ok: true, args }` or `{ ok: false, output }` for the model. |
| `sandbox.withPolicy(policy)` | A copy of the tool with `policy` merged over its own, e.g. per conversation. |
| `sandbox.anthropic` / `.openai` / `.openaiResponses` | `.tool` for the request and `.results(calls)` for the reply, per provider (below). |
| `sandbox.run(args)` | Running validated arguments; also returns `stdout`, `stderr`, `error`, and handler `status`, e.g. to stream to a UI. |

The schema is strict, so the model cannot set `allowedHosts`, `kvEnabled`, or `identity`: the application sets them in `policy`. To vary the policy (per user, conversation, or request), derive a tool with `sandbox.withPolicy(...)`; the copy reuses the interpreters, schema, and cached JSON Schema, so it is cheap, and the same pattern works with every provider below. Sandbox and transport failures come back as `isError: true` output for the model rather than as thrown errors. Keep sandbox endpoints private.

### Vercel AI SDK

The tool is already in the AI SDK's tool shape: it validates with `inputSchema` and calls `execute`.

```ts
import { ToolLoopAgent, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

const agent = new ToolLoopAgent({
  model: anthropic("claude-sonnet-5-5"),
  instructions: SYSTEM_PROMPT,
  tools: { [sandbox.name]: sandbox },
  stopWhen: stepCountIs(10),
});

const { text } = await agent.generate({ prompt: "What is the 50th Fibonacci number?" });
```

### Anthropic SDK

`sandbox.anthropic.tool` is the tool definition; `sandbox.anthropic.results(res.content)` runs every `tool_use` block for this tool and returns the `tool_result` blocks.

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const messages: Anthropic.MessageParam[] = [{ role: "user", content: "What is the 50th Fibonacci number?" }];

for (let step = 0; step < 10; step++) {
  const res = await client.messages.create({
    model: "claude-sonnet-5-5",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: [sandbox.anthropic.tool],
    messages,
  });
  messages.push({ role: "assistant", content: res.content });
  if (res.stop_reason !== "tool_use") break;
  messages.push({ role: "user", content: await sandbox.anthropic.results(res.content) });
}
```

### OpenAI SDK

Chat Completions uses `sandbox.openai`; `results()` parses each tool call's JSON arguments and returns the `tool` messages.

```ts
import OpenAI from "openai";

const client = new OpenAI();
const messages: OpenAI.ChatCompletionMessageParam[] = [
  { role: "system", content: SYSTEM_PROMPT },
  { role: "user", content: "What is the 50th Fibonacci number?" },
];

for (let step = 0; step < 10; step++) {
  const res = await client.chat.completions.create({ model: "gpt-5", tools: [sandbox.openai.tool], messages });
  const message = res.choices[0].message;
  messages.push(message);
  if (!message.tool_calls?.length) break;
  messages.push(...(await sandbox.openai.results(message.tool_calls)));
}
```

The Responses API uses `sandbox.openaiResponses`, whose tool sets `strict: false` (the Responses API otherwise defaults to strict mode, which this schema does not support):

```ts
const tools = [sandbox.openaiResponses.tool];
let res = await client.responses.create({ model: "gpt-5", instructions: SYSTEM_PROMPT, tools, input: "What is 2**64?" });
for (let step = 0; step < 10; step++) {
  const outputs = await sandbox.openaiResponses.results(res.output);
  if (!outputs.length) break;
  res = await client.responses.create({ model: "gpt-5", tools, previous_response_id: res.id, input: outputs });
}
console.log(res.output_text);
```

Each `results()` call runs this tool's calls concurrently, keeps their order, and skips any other tool's calls, so you can answer those yourself and combine the arrays.

### Plain JSON Schema

`toToolDefinition(sandbox)` returns the provider-neutral form, and `toAnthropicTool()`, `toOpenAITool()`, and `toOpenAIResponsesTool()` adapt any tool, including a hand-written `ToolDefinition` with a JSON Schema `inputSchema`. Use `sandbox.call(input)` for providers without a helper. The derived schema is not OpenAI strict-mode compatible (optional fields are omitted from `required`), so leave `strict` unset on Chat Completions.

### Identity and session isolation

An `identity` selects a KV namespace, shared across languages when KV is enabled. Omit it for a new ID per call; reuse it for shared storage. Every execution is a fresh Wasm instance: variables and globals never persist. The model never sees or chooses the identity. To let an agent keep state across calls, generate one ID per conversation and pass it with `kvEnabled: true`:

```ts
const conversation = sandbox.withPolicy({ kvEnabled: true, identity: crypto.randomUUID() });

// Then use `conversation` exactly like `sandbox`, with any provider:
tools: { [conversation.name]: conversation }                    // Vercel AI SDK
await conversation.anthropic.results(res.content)               // Anthropic
await conversation.openai.results(message.tool_calls)           // OpenAI
```

For reuse across chat turns, store the UUID server-side with its owner and check ownership on every request. IDs select namespaces; they are not authorization. Never accept raw IDs from model output or unchecked client input. Use separate IDs for separate users/conversations, and define quotas and cleanup: abandoning an ID does not delete its KV data. After stopping all writers, use `await javascript.kv(sessionId).clear()` to remove the namespace's keys. This operation is not transactional; a failure may leave some keys behind and can be retried. Resumable side tracks and KV cloning are not provided.

`allowedHosts` entries use `scheme://host[:port]`, for example `https://api.example.com`
or `https://*.example.com:*`. Wildcards match subdomains only, wildcard hosts grant no
access, and malformed entries return 400. The Spin manifest allowlist remains authoritative.
Private routes are reachable by any component granted the corresponding service-chaining
permission, so only trusted components should be granted access.

## Backends

- **`interpreter`**: a thin client over a sandbox component's `POST /ts/run` (JS/TS) and `/py/run` (Python) routes. Single-shot, buffered, default-deny egress, plus a scoped KV store (`Interpreter.kv(namespace)`).

  The intended deployment is two private components (ts-sandbox, py-sandbox) reached via service chaining. `.spin.internal` resolves to a component id, so each language has its own host: use one `Interpreter` per language, each `baseUrl` pointed at its component:

  ```ts
  const js = Interpreter.javascript({ baseUrl: "http://ts-sandbox.spin.internal" });
  const py = Interpreter.python({ baseUrl: "http://py-sandbox.spin.internal" });
  await js.execute(code); // ts-sandbox
  await py.execute(code); // py-sandbox
  ```

  `Interpreter.javascript({ baseUrl })` is shorthand for `new Interpreter({ baseUrl, lang: "javascript" })`. Language-bound clients reject a mismatched `lang` option. Create an unbound `new Interpreter({ baseUrl })` only when one endpoint really serves both `/ts` and `/py`; scoped KV and npm bundling require that unbound client or a JavaScript client.

  To invoke an HTTP handler, use `runHandler()` rather than manually constructing an envelope. It returns the handler's `Response`, including a streamed response body:

  ```ts
  const response = await py.runHandler(
    `def handle_request(request): return (200, {}, "hello")`,
    { path: "/hello" },
  );
  console.log(await response.text());
  ```

  See [`examples/ai-code-executor`](../examples/ai-code-executor). (A single combined app that routes both `/ts` and `/py` by path also works; then one `baseUrl` at the app suffices.)

## Extending it

The library ships no other-backend types, but it is designed to gain them:

- **`core`** (`./core`) is the only shared surface: `CodeRunner`, `RunOpts`, `Result`, and `Caps`. It carries no transport and nothing interpreter-specific.
- **`Backend`** is a widenable union (`"interpreter" | (string & {})`), so a new backend names itself without a breaking change.
- **`Caps`** already describes capabilities a heavier backend would light up (`filesystem`, `sessions`, `exec`, `lifecycle`, `arbitraryImage`, `realTimeout`), so a tool can branch on them at runtime; native TypeScript tools rely on compile-time method absence instead.

To add one: create a module under `src/`, implement `CodeRunner`, declare its `Caps`, and export it from `src/index.ts`. Nothing in `core` or `interpreter` has to change.

## Develop

```bash
npm install
npm run typecheck    # tsc, incl. the compile-time contract assertions in test/types.assert.ts
npm test             # node --test (runs the .ts tests directly)
npm run check        # both
```

`npm test` runs the TypeScript tests through Node's built-in runner with no build step, so it needs Node 24+ (native type stripping, plus `--test` glob support).

To test the SDK against real sandbox components, first start the root application, then run:

```bash
SANDBOX_BASE_URL=http://127.0.0.1:3007 npm run test:components
```
