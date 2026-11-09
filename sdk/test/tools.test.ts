import assert from "node:assert/strict";
import { test } from "node:test";

import { Interpreter } from "../src/interpreter/index.ts";
import { interpreterTool, toAnthropicTool, toOpenAITool, toToolDefinition, type ToolDefinition } from "../src/tools.ts";

type Reply = { body: unknown; status?: number };
// Interpreter clients whose sandbox answers every request with `reply`; `requests` records envelopes.
function stubInterpreters(reply: Reply = { body: { stdout: "" } }) {
  const requests: Array<{ url: string; body: any }> = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    const body = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(body, { status: reply.status ?? 200 });
  }) as typeof globalThis.fetch;
  const python = Interpreter.python({ baseUrl: "http://py", fetch });
  const javascript = Interpreter.javascript({ baseUrl: "http://ts", fetch });
  return { requests, python, javascript };
}

const { python, javascript } = stubInterpreters();
const tool = interpreterTool({ interpreters: { python, javascript } });
const { inputSchema } = tool;
const json = toToolDefinition(tool);

test("the derived JSON Schema and description match the reviewed golden output", async () => {
  // Any drift in what the model sees fails here; update the fixture deliberately.
  const { default: golden } = await import("./fixtures/interpreter-tool.json", { with: { type: "json" } });
  const configs = {
    default: { python, javascript },
    python: { python },
    javascript: { javascript },
    "javascript,python": { javascript, python },
  };
  for (const [key, interpreters] of Object.entries(configs)) {
    assert.deepStrictEqual(toToolDefinition(interpreterTool({ interpreters })), golden[key as keyof typeof golden], key);
  }
});

test("a single-language tool only describes and accepts that language", () => {
  const pyTool = interpreterTool({ interpreters: { python } });
  const { properties } = toToolDefinition(pyTool).inputSchema;
  assert.deepEqual(Object.keys(properties), ["language", "code", "input"]);
  assert.equal(pyTool.inputSchema.safeParse({ language: "javascript", code: "1" }).success, false);
  assert.equal(pyTool.inputSchema.safeParse({ language: "python", code: "1", dependencies: {} }).success, false);
  assert.doesNotMatch(pyTool.description, /fetch rejects|lodash/);

  const jsTool = interpreterTool({ interpreters: { javascript } });
  assert.deepEqual(Object.keys(toToolDefinition(jsTool).inputSchema.properties), ["language", "code", "dependencies", "input"]);
  assert.doesNotMatch(jsTool.description, /HttpRequestDenied|numpy/);
});

test("at least one interpreter is required", () => {
  assert.throws(() => interpreterTool({ interpreters: {} }), /at least one interpreter/);
});

test("call() runs code with the application's policy and formats the output", async () => {
  const stub = stubInterpreters({ body: { stdout: "42\n", stderr: "warn\n" } });
  const sandbox = interpreterTool({
    interpreters: { python: stub.python },
    policy: { allowedHosts: ["https://api.example.com"], kvEnabled: true, identity: "app" },
  });
  const output = await sandbox.call({ language: "python", code: "print(42)" });
  assert.deepEqual(output, {
    content: "stdout:\n42\n\n\nstderr:\nwarn\n",
    isError: false,
    stdout: "42\n",
    stderr: "warn\n",
    error: null,
    status: undefined,
  });
  const [{ url, body }] = stub.requests;
  assert.match(url, /^http:\/\/py\//);
  assert.deepEqual(body.allowedHosts, ["https://api.example.com"]);
  assert.equal(body.kvEnabled, true);
  assert.equal(body.sandboxId, "app");
});

test("call() returns invalid arguments to the model with the offending field", async () => {
  const output = await tool.call({ language: "javascript", code: "1", dependencies: { marked: 11 } });
  assert.equal(output.isError, true);
  assert.match(output.content, /dependencies\.marked/);
  const policy = await tool.call({ language: "python", code: "1", allowedHosts: ["*"] });
  assert.equal(policy.isError, true);
  assert.match(policy.content, /allowedHosts/);
});

test("run() reports code errors and transport failures as error output, not throws", async () => {
  const failing = stubInterpreters({ body: { stdout: "", error: "NameError: x" } });
  const codeError = await interpreterTool({ interpreters: { python: failing.python } }).run({ language: "python", code: "x" });
  assert.equal(codeError.isError, true);
  assert.equal(codeError.content, "error: NameError: x");

  const down = stubInterpreters({ body: "bad gateway", status: 502 });
  const transport = await interpreterTool({ interpreters: { python: down.python } }).run({ language: "python", code: "1" });
  assert.equal(transport.isError, true);
  assert.match(transport.content, /^error: sandbox error: .*502/);
});

test("run() returns a handler's HTTP response when input is supplied", async () => {
  const stub = stubInterpreters({ body: "hello", status: 201 });
  const sandbox = interpreterTool({ interpreters: { javascript: stub.javascript } });
  const output = await sandbox.run({ language: "javascript", code: "export default {}", input: { path: "/x" } });
  assert.equal(output.content, "HTTP 201\nhello");
  assert.equal(output.status, 201);
  assert.equal(stub.requests[0].body.input.path, "/x");
});

test("execute() returns the model-facing text, as the Vercel AI SDK expects", async () => {
  const stub = stubInterpreters({ body: { stdout: "ok" } });
  const sandbox = interpreterTool({ interpreters: { python: stub.python } });
  assert.equal(await sandbox.execute({ language: "python", code: "print('ok')" }), "stdout:\nok");
});

test("the tool leaves execution policy to the application", () => {
  for (const field of ["allowedHosts", "kvEnabled", "identity"]) {
    assert.equal(field in json.inputSchema.properties, false);
    assert.equal(json.description.includes(field), false);
  }
  assert.deepEqual(json.inputSchema.required, ["language", "code"]);
  assert.equal(json.inputSchema.additionalProperties, false);
  assert.match(json.description, /configured by the application/);
  assert.equal("$schema" in json.inputSchema, false);
});

test("the Zod schema rejects policy fields and unknown arguments", () => {
  for (const field of ["allowedHosts", "kvEnabled", "identity", "extra"]) {
    const result = inputSchema.safeParse({ language: "python", code: "print(1)", [field]: true });
    assert.equal(result.success, false, field);
  }
});

test("the Zod schema validates model arguments", () => {
  const args = {
    language: "javascript",
    code: "console.log(1)",
    dependencies: { marked: "^11.0.0" },
    input: { method: "POST", path: "/x", body: { a: 1 } },
  };
  assert.deepEqual(inputSchema.parse(args), args);
  assert.equal(inputSchema.safeParse({ language: "ruby", code: "puts 1" }).success, false);
  assert.equal(inputSchema.safeParse({ language: "python" }).success, false);
  assert.equal(inputSchema.safeParse({ language: "python", code: 1 }).success, false);
  assert.equal(inputSchema.safeParse({ language: "javascript", code: "", dependencies: { x: 1 } }).success, false);
});

test("the description carries the runtime guidance the model relies on", () => {
  assert.match(JSON.stringify(json.inputSchema.properties.code), /Never leave floating promises/);
  assert.match(json.description, /same language or different languages/);
  assert.match(json.description, /not on reusing an Interpreter client object/);
  assert.match(json.description, /variables and globals do not carry over/);
  assert.match(json.description, /guard returns HttpRequestDenied/);
  assert.match(json.description, /destination is not allowed, fetch rejects/);
});

test("withPolicy() merges a policy into a copy that shares the schema", async () => {
  const stub = stubInterpreters({ body: { stdout: "" } });
  const base = interpreterTool({
    interpreters: { python: stub.python },
    policy: { allowedHosts: ["https://api.example.com"], identity: "app" },
  });
  const session = base.withPolicy({ identity: "session-1", kvEnabled: true });
  assert.equal(session.inputSchema, base.inputSchema);
  assert.equal(toToolDefinition(session).inputSchema, toToolDefinition(base).inputSchema);

  await session.call({ language: "python", code: "1" });
  await base.call({ language: "python", code: "1" });
  const [derived, original] = stub.requests.map((r) => r.body);
  assert.deepEqual([derived.sandboxId, derived.kvEnabled, derived.allowedHosts], ["session-1", true, ["https://api.example.com"]]);
  assert.deepEqual([original.sandboxId, original.kvEnabled], ["app", false]);
});

test("JSON Schema conversion is cached per schema", () => {
  assert.equal(toToolDefinition(tool).inputSchema, json.inputSchema);
});

test("tool adapters support Anthropic and OpenAI shapes", () => {
  assert.deepEqual(toAnthropicTool(tool), {
    name: json.name,
    description: json.description,
    input_schema: json.inputSchema,
  });
  assert.deepEqual(toOpenAITool(tool), {
    type: "function",
    function: { name: json.name, description: json.description, parameters: json.inputSchema },
  });
});

test("tool adapters pass hand-written JSON Schema tools through unchanged", () => {
  const custom: ToolDefinition = {
    name: "create_app",
    description: "Publish an app.",
    inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false },
  };
  assert.equal(toToolDefinition(custom), custom);
  assert.equal(toAnthropicTool(custom).input_schema, custom.inputSchema);
  assert.equal(toOpenAITool(custom).function.parameters, custom.inputSchema);
});

test("anthropic.results() answers this tool's tool_use blocks and skips everything else", async () => {
  const stub = stubInterpreters({ body: { stdout: "2" } });
  const sandbox = interpreterTool({ interpreters: { python: stub.python }, policy: { identity: "s1" } });
  assert.deepEqual(sandbox.anthropic.tool, toAnthropicTool(sandbox));
  const results = await sandbox.anthropic.results([
    { type: "text" },
    { type: "tool_use", id: "a", name: sandbox.name, input: { language: "python", code: "print(1+1)" } },
    { type: "tool_use", id: "b", name: "other_tool", input: {} },
    { type: "tool_use", id: "c", name: sandbox.name, input: { language: "python" } },
  ]);
  assert.deepEqual(results.map((r) => [r.type, r.tool_use_id, r.is_error]), [
    ["tool_result", "a", false],
    ["tool_result", "c", true],
  ]);
  assert.equal(results[0].content, "stdout:\n2");
  assert.match(results[1].content, /code/);
  assert.equal(stub.requests.length, 1);
  assert.equal(stub.requests[0].body.sandboxId, "s1");
});

test("openai.results() parses JSON arguments and answers with tool messages", async () => {
  const stub = stubInterpreters({ body: { stdout: "ok" } });
  const sandbox = interpreterTool({ interpreters: { python: stub.python } });
  assert.deepEqual(sandbox.openai.tool, toOpenAITool(sandbox));
  const messages = await sandbox.openai.results([
    { id: "1", type: "function", function: { name: sandbox.name, arguments: '{"language":"python","code":"1"}' } },
    { id: "2", type: "function", function: { name: sandbox.name, arguments: "{not json" } },
    { id: "3", type: "function", function: { name: "other_tool", arguments: "{}" } },
  ]);
  assert.deepEqual(messages, [
    { role: "tool", tool_call_id: "1", content: "stdout:\nok" },
    { role: "tool", tool_call_id: "2", content: "error: tool arguments are not valid JSON" },
  ]);
  assert.deepEqual(await sandbox.openai.results(undefined), []);
});

test("openaiResponses uses a non-strict tool and answers function_call items", async () => {
  const stub = stubInterpreters({ body: { stdout: "ok" } });
  const sandbox = interpreterTool({ interpreters: { python: stub.python } });
  const { tool: responsesTool } = sandbox.openaiResponses;
  assert.equal(responsesTool.strict, false);
  assert.equal(responsesTool.name, sandbox.name);
  assert.deepEqual(responsesTool.parameters, toToolDefinition(sandbox).inputSchema);
  const outputs = await sandbox.openaiResponses.results([
    { type: "message" },
    { type: "function_call", call_id: "c1", name: sandbox.name, arguments: '{"language":"python","code":"1"}' },
  ]);
  assert.deepEqual(outputs, [{ type: "function_call_output", call_id: "c1", output: "stdout:\nok" }]);
});
