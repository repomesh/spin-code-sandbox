import * as z from "zod";

import type { Language } from "./core/index.ts";
import type { BoundRunOpts, Interpreter } from "./interpreter/index.ts";

/**
 * A tool whose input is described by a Zod schema. `{ description, inputSchema }` is what the
 * Vercel AI SDK's `tool()` expects, and `inputSchema.safeParse(args)` validates model-supplied
 * arguments before they are used. Convert it with `toAnthropicTool()`, `toOpenAITool()`, or
 * `toToolDefinition()` for providers that take JSON Schema.
 */
export interface StructuredTool<Input = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
}

/** A JSON Schema object describing tool arguments, as Anthropic and OpenAI accept it. */
export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties?: boolean;
  [keyword: string]: unknown;
}

/** Provider-neutral tool metadata with a plain JSON Schema for its input. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
}

/** Either kind of tool the adapters accept. */
export type AnyTool = StructuredTool | ToolDefinition;

const stringMap = () => z.record(z.string(), z.string());

const CODE = z.string();
const DEPENDENCIES = stringMap().describe(
  "JavaScript only. Extra npm dependencies as name -> semver ranges. Use ESM import; Python cannot add packages.",
);
const HTTP_INPUT = z
  .object({
    method: z.string().optional().describe("HTTP method; defaults to GET."),
    path: z.string().optional().describe("Request path; defaults to /."),
    headers: stringMap().optional(),
    query: stringMap().optional(),
    body: z.unknown().optional().describe("Request body as a string or JSON value."),
  })
  .describe(
    "Mock HTTP request for handler code. Supplying it runs a JavaScript `export default { fetch(request) {} }` or Python `handle_request(request)` handler and returns its HTTP response.",
  );

/**
 * Arguments the model supplies to `run_in_wasm_interpreter`. `language` narrows to the
 * configured languages; `dependencies` is only accepted by the schema when JavaScript is served.
 */
export interface InterpreterToolInput<L extends Language = Language> {
  language: L;
  code: string;
  /** JavaScript only: extra npm dependencies as name -> semver range. */
  dependencies?: Record<string, string>;
  input?: z.infer<typeof HTTP_INPUT>;
}

/** Execution policy the application sets for every run. Model arguments never reach it. */
export type ExecutionPolicy = Pick<BoundRunOpts, "allowedHosts" | "kvEnabled" | "identity" | "timeoutMs">;

export interface InterpreterToolOptions<L extends Language> {
  /**
   * One client per language you serve, e.g. `{ python: Interpreter.python({ baseUrl }) }`. The
   * tool offers exactly these languages, in this order.
   */
  interpreters: { readonly [K in L]: Interpreter };
  /** Applied to every run. Defaults deny egress and KV and use a fresh identity per run. */
  policy?: ExecutionPolicy;
}

/** What to send back to the model for one tool call. */
export interface ToolOutput {
  content: string;
  isError: boolean;
}

/** A finished run: the model-facing output plus its parts, e.g. for streaming to a UI. */
export interface ToolRun extends ToolOutput {
  stdout: string;
  stderr: string;
  /** Code, sandbox, or transport error; null on success. */
  error: string | null;
  /** HTTP status, when `input` ran the code as a handler. */
  status?: number;
}

/** Result of `InterpreterTool.parse()`: typed arguments, or the error to return to the model. */
export type ParsedToolCall<L extends Language> =
  | { ok: true; args: InterpreterToolInput<L> }
  | { ok: false; output: ToolOutput };

/** The `run_in_wasm_interpreter` tool, bound to interpreter clients and an execution policy. */
export interface InterpreterTool<L extends Language = Language> extends StructuredTool<InterpreterToolInput<L>> {
  /** Runs validated arguments and returns the text for the model (the Vercel AI SDK `execute`). */
  execute(args: InterpreterToolInput<L>): Promise<string>;
  /** Runs validated arguments. */
  run(args: InterpreterToolInput<L>): Promise<ToolRun>;
  /** Validates raw model arguments (e.g. Anthropic `tool_use.input`), then runs them. */
  call(input: unknown): Promise<ToolOutput>;
  /** Validates raw model arguments; on failure, `output` names the bad fields for the model. */
  parse(input: unknown): ParsedToolCall<L>;
  /**
   * Returns this tool with `policy` merged over its policy, e.g. `withPolicy({ identity })` per
   * conversation. The copy shares the interpreters, schema, and cached JSON Schema.
   */
  withPolicy(policy: ExecutionPolicy): InterpreterTool<L>;
  /** Anthropic Messages API: `tools: [sandbox.anthropic.tool]`, then `results(response.content)`. */
  readonly anthropic: ProviderHelpers<AnthropicTool, AnthropicContentBlock, AnthropicToolResult>;
  /** OpenAI Chat Completions: `tools: [sandbox.openai.tool]`, then `results(message.tool_calls)`. */
  readonly openai: ProviderHelpers<OpenAITool, OpenAIToolCall, OpenAIToolMessage>;
  /** OpenAI Responses API: `tools: [sandbox.openaiResponses.tool]`, then `results(response.output)`. */
  readonly openaiResponses: ProviderHelpers<OpenAIResponsesTool, OpenAIResponseItem, OpenAIFunctionCallOutput>;
}

/** A provider's tool definition plus a way to answer its tool calls. */
export interface ProviderHelpers<Tool, Call, Result> {
  /** The tool definition to send to the provider. */
  readonly tool: Tool;
  /**
   * Runs every call to this tool in a model response, concurrently, and returns the provider's
   * result items in order. Items that are not calls to this tool are skipped, so other tools
   * can share the response.
   */
  results(calls: readonly Call[] | null | undefined): Promise<Result[]>;
}

/** A content block of an Anthropic response; only `tool_use` blocks are read. */
export interface AnthropicContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
}

/** An Anthropic `tool_result` content block. */
export interface AnthropicToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

/** A tool call in an OpenAI Chat Completions assistant message. */
export interface OpenAIToolCall {
  id: string;
  type: string;
  function?: { name: string; arguments: string };
}

/** An OpenAI Chat Completions `tool` message answering one tool call. */
export interface OpenAIToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

/** An OpenAI Responses API output item; only `function_call` items are read. */
export interface OpenAIResponseItem {
  type: string;
  call_id?: unknown;
  name?: unknown;
  arguments?: unknown;
}

/** An OpenAI Responses API `function_call_output` input item. */
export interface OpenAIFunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

/**
 * Returns the `run_in_wasm_interpreter` tool for the given interpreter clients. Its
 * `inputSchema` is a strict Zod object: unknown fields (such as `allowedHosts`, `kvEnabled`, or
 * `identity`) are rejected, so execution policy stays with the application.
 *
 * ```ts
 * const sandbox = interpreterTool({
 *   interpreters: { python: Interpreter.python({ baseUrl: "http://py-sandbox.spin.internal" }) },
 *   policy: { allowedHosts: ["https://api.example.com"] },
 * });
 * const { content, isError } = await sandbox.call(toolUse.input);
 * ```
 */
export function interpreterTool<const L extends Language>(
  options: InterpreterToolOptions<L>,
): InterpreterTool<L> {
  const { interpreters, policy = {} } = options;
  return bindTool(describeTool(Object.keys(interpreters) as L[]), interpreters, policy);
}

interface ToolSchema<L extends Language> {
  description: string;
  inputSchema: z.ZodType<InterpreterToolInput<L>>;
}

/** Builds the policy-independent part of the tool: what the model sees. */
function describeTool<L extends Language>(languages: L[]): ToolSchema<L> {
  if (languages.length === 0) throw new Error("interpreterTool requires at least one interpreter");
  const served = new Set<Language>(languages);
  const js = served.has("javascript");
  const py = served.has("python");

  const language = z.enum(languages as [L, ...L[]]);
  const code = CODE.describe(
    js
      ? "The complete program to run. Print results to stdout. JavaScript supports top-level await: await all asynchronous work directly. Never leave floating promises (an un-awaited async IIFE, main() call, or timer); work still running when the program ends is discarded without any output or error."
      : "The complete program to run. Print results to stdout.",
  );
  const input = HTTP_INPUT.optional();
  const inputSchema = js
    ? z.strictObject({ language, code, dependencies: DEPENDENCIES.optional(), input })
    : z.strictObject({ language, code, input });

  const description = [
    `Run ${languages.join(" or ")} code in an isolated WebAssembly sandbox and get back its stdout, stderr, and error.`,
    "Beyond computation, parsing, and data work, code can call external HTTP APIs, keep data across runs, and serve HTTP requests.",
    "Outbound HTTP is denied unless the application permits the destination.",
    js && "JavaScript uses the standard `fetch`. If the destination is not allowed, fetch rejects; the runtime may report the generic error \"An error occurred while using the host API\".",
    py && "Python uses `from spin_sdk.http import send, Request` and `send(Request(method, url, headers, body))`; urllib, http.client, and requests are not available.",
    py && "If the destination is not allowed, the guard returns HttpRequestDenied, surfaced as `Err(ErrorCode_HttpRequestDenied())`.",
    "Network permissions are configured by the application and cannot be changed through tool arguments.",
    "Persistent storage is available only when enabled by the application, which also controls the storage namespace.",
    "Runs in the same namespace share stored KV data, whether they use the same language or different languages.",
    "Sharing depends on the namespace, not on reusing an Interpreter client object; different namespaces are isolated.",
    js && "JavaScript: `import { openDefault } from \"@spinframework/spin-kv\"`, then get/set or getJson/setJson.",
    py && "Python: `from spin_sdk import key_value`, then `key_value.open_default()` with get/set (values are bytes).",
    "HTTP handlers: supply input to run a handler against that request and get its HTTP response.",
    "JavaScript exports `default { async fetch(request) {} }`, awaiting all async work before it returns the Response; Python defines `handle_request(request)` and may return an iterable of str or bytes chunks to stream the body.",
    py && "Python includes numpy, pydantic, pyyaml, regex, beautifulsoup4, jinja2, markdown, tabulate, sqlalchemy, tiktoken (no built-in encodings: get_encoding() fails, so pass your own mergeable_ranks to tiktoken.Encoding), and the standard library except its networking modules.",
    js && "JavaScript (TypeScript syntax is accepted) includes lodash, zod, date-fns, dayjs, cheerio, node-html-parser, js-yaml, uuid, ulidx, and nanoid.",
    js && "For other npm packages, list them in dependencies as name -> semver ranges; they are bundled before the run. Use ESM import, never require().",
    "Each run is a fresh instance: variables and globals do not carry over. When storage is enabled, persist state in the key-value store.",
    "There is no filesystem, shell, subprocess, or raw socket, and no runtime pip install. stdout and stderr are each capped at 256 KB.",
  ]
    .filter(Boolean)
    .join(" ");

  return { description, inputSchema };
}

/** Binds the tool's schema to interpreter clients and a policy. */
function bindTool<L extends Language>(
  schema: ToolSchema<L>,
  interpreters: { readonly [K in L]: Interpreter },
  policy: ExecutionPolicy,
): InterpreterTool<L> {
  const { inputSchema } = schema;

  const parse = (input: unknown): ParsedToolCall<L> => {
    const parsed = inputSchema.safeParse(input);
    if (parsed.success) return { ok: true, args: parsed.data };
    const content = `error: invalid tool arguments:\n${z.prettifyError(parsed.error)}\nExecution permissions are controlled by the application.`;
    return { ok: false, output: { content, isError: true } };
  };

  const run = async (args: InterpreterToolInput<L>): Promise<ToolRun> => {
    const interpreter: Interpreter | undefined = interpreters[args.language];
    if (!interpreter) return toolRun({ error: `unsupported language: ${String(args.language)}` });
    const dependencies = args.language === "javascript" ? args.dependencies : undefined;
    const opts: BoundRunOpts = {
      ...policy,
      packageJson: dependencies && Object.keys(dependencies).length ? { dependencies } : undefined,
    };
    try {
      if (args.input) {
        const response = await interpreter.runHandler(args.code, args.input, opts);
        return toolRun({ stdout: await response.text(), status: response.status });
      }
      const result = await interpreter.execute(args.code, opts);
      return toolRun({
        stdout: result.stdout,
        stderr: result.stderr,
        // Runtime errors arrive with the generic name "error"; only specific kinds add information.
        error: result.error && (result.error.name === "error" ? result.error.value : `${result.error.name}: ${result.error.value}`),
      });
    } catch (e) {
      return toolRun({ error: `sandbox error: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const tool: InterpreterTool<L> = {
    name: "run_in_wasm_interpreter",
    ...schema,
    parse,
    run,
    execute: async (args) => (await run(args)).content,
    call,
    withPolicy: (overrides) => bindTool(schema, interpreters, { ...policy, ...overrides }),
    get anthropic(): InterpreterTool<L>["anthropic"] {
      return providerHelpers(toAnthropicTool(tool), ({ type, name, id, input }: AnthropicContentBlock) => {
        if (type !== "tool_use" || name !== tool.name || id === undefined) return undefined;
        return async () => {
          const { content, isError } = await call(input);
          return { type: "tool_result", tool_use_id: id, content, is_error: isError };
        };
      });
    },
    get openai(): InterpreterTool<L>["openai"] {
      return providerHelpers(toOpenAITool(tool), ({ id, function: fn }: OpenAIToolCall) => {
        if (fn?.name !== tool.name) return undefined;
        return async () => {
          const { content } = await callJson(fn.arguments);
          return { role: "tool", tool_call_id: id, content };
        };
      });
    },
    get openaiResponses(): InterpreterTool<L>["openaiResponses"] {
      return providerHelpers(toOpenAIResponsesTool(tool), ({ type, name, call_id, arguments: args }: OpenAIResponseItem) => {
        if (type !== "function_call" || name !== tool.name || typeof call_id !== "string") return undefined;
        return async () => {
          const { content } = await callJson(typeof args === "string" ? args : "");
          return { type: "function_call_output", call_id, output: content };
        };
      });
    },
  };
  return tool;

  async function call(input: unknown): Promise<ToolOutput> {
    const parsed = parse(input);
    return parsed.ok ? run(parsed.args) : parsed.output;
  }

  // OpenAI sends arguments as a JSON string.
  async function callJson(json: string): Promise<ToolOutput> {
    let input: unknown;
    try {
      input = JSON.parse(json);
    } catch {
      return { content: "error: tool arguments are not valid JSON", isError: true };
    }
    return call(input);
  }
}

/**
 * Builds a provider's helpers from its tool definition and a matcher that returns a runner for
 * each call addressed to this tool (and undefined for anything else in the response).
 */
function providerHelpers<Tool, Call, Result>(
  tool: Tool,
  match: (call: Call) => (() => Promise<Result>) | undefined,
): ProviderHelpers<Tool, Call, Result> {
  return {
    tool,
    results: (calls) => Promise.all((calls ?? []).flatMap((c) => match(c) ?? []).map((runCall) => runCall())),
  };
}

function toolRun({ stdout = "", stderr = "", error = null, status }: Partial<ToolRun>): ToolRun {
  const content =
    status === undefined
      ? [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`, error && `error: ${error}`]
          .filter(Boolean)
          .join("\n\n") || "(no output)"
      : `HTTP ${status}\n${stdout}`;
  return { content, isError: error !== null, stdout, stderr, error, status };
}

function isStructured(tool: AnyTool): tool is StructuredTool {
  // Zod v4 marks every schema with `_zod`; checking it also accepts schemas from another zod copy.
  return typeof tool.inputSchema === "object" && tool.inputSchema !== null && "_zod" in tool.inputSchema;
}

const jsonSchemas = new WeakMap<z.ZodType, JsonSchemaObject>();

/**
 * Returns the tool with a plain JSON Schema input, converting a Zod schema if needed. The
 * conversion is cached per schema, so calling an adapter on every model turn, or on every
 * `withPolicy()` copy, is cheap.
 */
export function toToolDefinition(tool: AnyTool): ToolDefinition {
  if (!isStructured(tool)) return tool;
  let inputSchema = jsonSchemas.get(tool.inputSchema);
  if (!inputSchema) {
    inputSchema = toJsonSchema(tool);
    jsonSchemas.set(tool.inputSchema, inputSchema);
  }
  return { name: tool.name, description: tool.description, inputSchema };
}

function toJsonSchema(tool: StructuredTool): JsonSchemaObject {
  const { $schema: _, ...schema } = z.toJSONSchema(tool.inputSchema, {
    io: "input",
    // Zod emits `propertyNames: { type: "string" }` for string-keyed records. JSON object keys
    // are always strings, so the keyword adds nothing for the model; drop it to keep the schema lean.
    override: ({ jsonSchema }) => {
      const names = jsonSchema.propertyNames;
      if (names && typeof names === "object" && names.type === "string" && Object.keys(names).length === 1) {
        delete jsonSchema.propertyNames;
      }
    },
  });
  if (schema.type !== "object") throw new Error(`tool ${tool.name} must take an object input`);
  return { properties: {}, required: [], ...schema } as JsonSchemaObject;
}

/** Adapts a tool to Anthropic's tool shape. */
export function toAnthropicTool(tool: AnyTool): AnthropicTool {
  const { name, description, inputSchema } = toToolDefinition(tool);
  return { name, description, input_schema: inputSchema };
}

/** The tool shape the Anthropic Messages API takes. */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: JsonSchemaObject;
}

/** The function-tool shape OpenAI Chat Completions takes. */
export interface OpenAITool {
  type: "function";
  function: { name: string; description: string; parameters: JsonSchemaObject };
}

/** The function-tool shape the OpenAI Responses API takes. */
export interface OpenAIResponsesTool {
  type: "function";
  name: string;
  description: string;
  parameters: JsonSchemaObject;
  strict: false;
}

/** Adapts a tool to OpenAI Chat Completions' function-tool shape (non-strict). */
export function toOpenAITool(tool: AnyTool): OpenAITool {
  const { name, description, inputSchema } = toToolDefinition(tool);
  return { type: "function", function: { name, description, parameters: inputSchema } };
}

/**
 * Adapts a tool to the OpenAI Responses API's function-tool shape. `strict` is false because the
 * Responses API otherwise defaults to strict mode, which rejects optional fields.
 */
export function toOpenAIResponsesTool(tool: AnyTool): OpenAIResponsesTool {
  const { name, description, inputSchema } = toToolDefinition(tool);
  return { type: "function", name, description, parameters: inputSchema, strict: false };
}
