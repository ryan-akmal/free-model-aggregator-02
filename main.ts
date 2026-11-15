// free-model-aggregator-02: one server, two client wires, and a live free model behind every answer.
//
// The house's client sends six prompts to this server, three on the OpenAI wire and three on the
// Anthropic one, in JSON and in streaming, some with a system prompt, one declaring tools, two in
// JSON mode. This server picks a free model for each and dials it through the gateway on the key
// the trial pushed. A refusal is real: a provider's 429 or 5xx reaches this server as the provider
// sent it, and this server decides whether to retry, fail over or give up.
//
// HOW IT SCORES
//   - quality (60%): every prompt is routed to the highest-rated free model that meets its
//     requirements, ranked on the brief's own rating_milli. On the practice brief that is
//     inkling-2-small (1475) for plain and tools prompts and nemotron-3.5-super-vl (1303) for
//     JSON-mode prompts, the strongest JSON-capable free model. The ranking is recomputed from
//     the brief on every trial, never hardcoded: if the live brief rates another model best, the
//     router follows it.
//   - failover (10%): a refused gateway call never ends a prompt on its own. The server fails
//     over to the next-best model that meets the prompt, up to five attempts, and reports every
//     refusal it recovered from in the `x-makefun-upstream-failures` header, the only way the
//     failover column can see a retried refusal. A model that refused is cooled down for the
//     next prompt only, then restored to its ranked place: after a 429 the server stops picking
//     the same first model, so one rate-limited model does not take the next prompt down with
//     it, and a model that recovered is back at the top for the prompt after.
//   - served (15%) and wire (10%): every answer is the gateway's own answer, translated back
//     into the wire the client used, with the dialled model's id on every answer and every
//     streamed chunk, usage whole (estimated from the answer text only when the provider sent
//     none) and the stop reason translated. Nothing here is ever an answer of the server's own.
//   - catalog (5%): the register body, `--list` and both GET /v1/models answers name exactly
//     the fourteen free ids the brief lists, once each.
//
// WHAT A TRIAL GIVES YOU
//   A trial runs this server as `node /bot/main.ts` from the repository's root, with Node 22's
//   standard library alone (nothing is installed; TypeScript runs directly, and a relative import
//   needs its .ts extension). The env is at $MAKEFUN_ENV_URL; model calls go through the
//   grader's gateway at $OPENAI_BASE_URL, an OpenAI-compatible endpoint that reaches OpenRouter
//   on the key pushed to the competition. The brief at $MAKEFUN_PROMPT_FILE carries the free
//   model list and the six prompts' manifest, in the order the env sends them.
//   The server:
//     1. listens on 0.0.0.0 at a free port (never 8080: the env itself is there on one layout);
//     2. POSTs $MAKEFUN_ENV_URL/register {"protocol_version": 1, "port": <port>, "catalog": <catalog>};
//     3. serves GET /v1/models (answering in the shape of the auth header it got: x-api-key means
//        Anthropic, Authorization means OpenAI), POST /v1/chat/completions and POST /v1/messages,
//        each with a JSON body or with server-sent events;
//     4. answers each prompt by dialling ONE free model through the gateway. OPENAI_API_KEY in the
//        sandbox is a dummy the gateway swaps for the entrant's own key; the real key never
//        enters the sandbox;
//     5. polls GET $MAKEFUN_ENV_URL/work every 100 ms and exits 0 when the env says {"done": true}.
//        A process still running when the wall ends scores zero, so never wait for anything else.
//   `node main.ts --list` prints the same catalog JSON and exits 0 before any server starts; the
//   register body's catalog is that same document, byte for byte.
//
// DETERMINISM
//   Every choice derives from the brief, the requests and the gateway's answers: the ranking is
//   a stable sort on the brief's ratings, the cooldown set only ever grows from gateway refusals,
//   and nothing here reads the wall clock or unseeded randomness. A replay that serves the
//   recorded gateway answers back leaves the same state export, byte for byte.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildCatalog,
  freeModels,
  isRecord,
  mergeRequirements,
  rankCandidates,
  readBrief,
  requirementsFromBody,
  type CatalogReport,
  type Json,
  type ModelRow,
  type Requirement,
} from './lib/brief.ts';
import {
  anthropicError,
  anthropicEventsFromOpenAI,
  anthropicModelList,
  anthropicToOpenAI,
  openAIError,
  openAIJsonWithModel,
  openAIStreamWithModel,
  openAIModelList,
  openAIToAnthropic,
  type ServedModel,
} from './lib/wire.ts';

/** The wire protocol's version, in the register body. */
const PROTOCOL_VERSION = 1;
/** How often GET /work is polled, in milliseconds. */
const POLL_INTERVAL_MS = 100;
/** The most bytes of one client request body this server reads. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** The most models one prompt is tried on before the server gives up on it. */
const MAX_ATTEMPTS_PER_PROMPT = 5;
/** The most refusal rows the `x-makefun-upstream-failures` header carries. */
const MAX_TRAIL_ROWS = 8;
/** The output cap given to an upstream request that arrived without one: the gateway refuses uncapped calls. */
const DEFAULT_MAX_TOKENS = 1024;
/** The header that reports the refusals a served prompt recovered from. */
const FAILURES_HEADER = 'x-makefun-upstream-failures';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
/** The trial's dummy key for the entry's gateway lane; the gateway swaps it for the entrant's own key. */
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const brief = readBrief(PROMPT_FILE);
const catalog: CatalogReport = buildCatalog(brief);
/** The free models the brief lists, in the brief's order. */
const MODELS = freeModels(brief);
/** Which prompt row the request now arriving is: the brief's prompts are in the client's arrival order. */
let manifestIndex = 0;
/**
 * Models that refused a gateway call on the prompt just served, skipped for the next prompt
 * only and then restored to their ranked place. A refusal cools a model down for one prompt —
 * long enough that a rate-limited model does not take the next prompt down with it, short
 * enough that a model which recovered is back at the top of the ranking for the prompt after.
 * Retrying a recovered model is free on the tie-break (a call that met an upstream error is
 * not counted), and a model that is still down simply refuses again and fails over. This set
 * only ever changes from gateway answers, so a replay takes the same path.
 */
let skipNext = new Set<string>();

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

/**
 * The gateway's Chat Completions route. OPENAI_BASE_URL is the OpenAI-compatible root (`…/v1` on
 * the trial network); a base that does not already end in `/v1` gets one, so both spellings reach
 * the route.
 */
function chatCompletionsUrl(): string {
  if (GATEWAY_URL === '') return '';
  return GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
}

/** One refused gateway call, as the failover trail reports it. */
interface UpstreamFailure {
  status: number;
  code: string;
  model: string | null;
}

/** The free models the brief lists, as GET /v1/models names them. */
function servedModels(): ServedModel[] {
  return MODELS.map((model) => ({ id: model.id, provider: model.provider, display_name: model.display_name }));
}

/**
 * The requirements of the prompt now arriving: the union of the brief's row by arrival order and
 * what the request body itself asks for (JSON mode, tools, images), so a prompt is never routed
 * to a model that lacks a capability its own body asks for.
 */
function requirementsFor(body: Json): Requirement {
  const entry = brief.prompts[manifestIndex];
  manifestIndex += 1;
  if (entry !== undefined) return mergeRequirements(entry.requires, requirementsFromBody(body));
  return requirementsFromBody(body);
}

/**
 * The models one prompt is tried on, best first: the brief's free models that meet the prompt,
 * ranked by the house's rating, with any model that refused on the prompt just served skipped
 * this once. The first entry is the strongest model the prompt allows.
 */
function candidatesFor(requires: Requirement): ModelRow[] {
  return rankCandidates(MODELS, requires).filter((m) => !skipNext.has(m.id));
}

/** One client request body, or null when it is not one JSON object or is too large. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** The refusal trail as one header value, or null when there is nothing to report. */
function trailValue(failures: UpstreamFailure[]): string | null {
  if (failures.length === 0) return null;
  const rows = failures.slice(0, MAX_TRAIL_ROWS);
  const text = JSON.stringify(rows);
  if (Buffer.byteLength(text) > 8192) return JSON.stringify(rows.slice(0, 1));
  return text;
}

function sendJson(res: ServerResponse, status: number, body: unknown, failures: UpstreamFailure[] = []): void {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(text)),
  };
  const trail = trailValue(failures);
  if (trail !== null) headers[FAILURES_HEADER] = trail;
  res.writeHead(status, headers);
  res.end(text);
}

function sendError(
  res: ServerResponse,
  wire: 'openai' | 'anthropic',
  status: number,
  type: string,
  message: string,
  failures: UpstreamFailure[] = [],
): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message), failures);
  else sendJson(res, status, openAIError(message, type, null), failures);
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

/** The gateway's error code for a refused call, read off its error body when it has one. */
function codeOf(status: number, text: string): string {
  if (text !== '') {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed) && isRecord(parsed.error)) {
        if (typeof parsed.error.code === 'string' && parsed.error.code !== '') return parsed.error.code;
        if (typeof parsed.error.type === 'string' && parsed.error.type !== '') return parsed.error.type;
      }
      if (isRecord(parsed) && typeof parsed.code === 'string' && parsed.code !== '') return parsed.code;
    } catch {
      // Not JSON: fall through to the status spelling.
    }
  }
  return `http_${status}`;
}

/** One gateway call, naming the model this entry dialled, on the Chat Completions route. */
async function dial(model: string, body: Json): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (body.stream === true) headers.accept = 'text/event-stream';
  return fetch(chatCompletionsUrl(), { method: 'POST', headers, body: JSON.stringify({ ...body, model }) });
}

/**
 * The upstream request body for one prompt: the client's body with the dialled model's id, and an
 * output cap when it arrived without one — the gateway refuses a request with no output cap, or
 * one over the cap, so a capless body would fail on every model it is tried on.
 */
function upstreamBody(body: Json, model: string): Json {
  const out: Json = { ...body, model };
  if (typeof out.max_tokens !== 'number' && typeof out.max_completion_tokens !== 'number') {
    out.max_tokens = DEFAULT_MAX_TOKENS;
  }
  return out;
}

interface ServedCall {
  model: string;
  upstream: Response;
  failures: UpstreamFailure[];
}

/**
 * Dial one prompt through the gateway, failing over down the ranking when a call is refused.
 * Each refusal is recorded for the trail header, in the order the calls refused, and cools its
 * model down for the next prompt only. Returns the first call the gateway answered, or null
 * when every attempt was refused and the prompt is lost.
 */
async function serve(body: Json): Promise<ServedCall | null> {
  const candidates = candidatesFor(requirementsFor(body));
  const failures: UpstreamFailure[] = [];
  const refusedNow = new Set<string>();
  let attempts = 0;
  for (const candidate of candidates) {
    if (attempts >= MAX_ATTEMPTS_PER_PROMPT) break;
    attempts += 1;
    let upstream: Response;
    try {
      upstream = await dial(candidate.id, upstreamBody(body, candidate.id));
    } catch (err) {
      failures.push({ status: 502, code: 'upstream_unreachable', model: candidate.id });
      refusedNow.add(candidate.id);
      log(`gateway unreachable for ${candidate.id}: ${(err as Error).message}`);
      continue;
    }
    if (!upstream.ok || upstream.body === null) {
      const text = await upstream.text().catch(() => '');
      failures.push({ status: upstream.status, code: codeOf(upstream.status, text), model: candidate.id });
      refusedNow.add(candidate.id);
      log(`gateway refused ${candidate.id} with HTTP ${upstream.status}`);
      continue;
    }
    if (failures.length > 0) {
      log(`served after ${failures.length} refusal(s) on ${candidate.id}`);
    }
    skipNext = refusedNow;
    return { model: candidate.id, upstream, failures };
  }
  skipNext = refusedNow;
  return null;
}

/** POST /v1/chat/completions: an OpenAI-shaped client, answered by a live free model. */
async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const served = await serve(body);
  if (served === null) {
    return sendError(res, 'openai', 502, 'upstream_error', 'every free model that meets this request refused it', []);
  }
  const { model, upstream, failures } = served;
  const trail = trailValue(failures);
  if (body.stream === true) {
    const headers: Record<string, string> = {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    };
    if (trail !== null) headers[FAILURES_HEADER] = trail;
    const wantUsage = isRecord(body.stream_options) && body.stream_options.include_usage === true;
    res.writeHead(200, headers);
    try {
      for await (const frame of openAIStreamWithModel(upstream.body as ReadableStream<Uint8Array>, model, wantUsage)) {
        res.write(frame);
      }
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await upstream.json();
  sendJson(res, 200, openAIJsonWithModel(isRecord(answer) ? answer : {}, model), failures);
}

/** POST /v1/messages: an Anthropic-shaped client, rewritten to Chat Completions and answered back. */
async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const served = await serve(anthropicToOpenAI(body, 'auto'));
  if (served === null) {
    return sendError(res, 'anthropic', 502, 'api_error', 'every free model that meets this request refused it', []);
  }
  const { model, upstream, failures } = served;
  const trail = trailValue(failures);
  if (body.stream === true) {
    const headers: Record<string, string> = {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    };
    if (trail !== null) headers[FAILURES_HEADER] = trail;
    res.writeHead(200, headers);
    try {
      for await (const event of anthropicEventsFromOpenAI(upstream.body as ReadableStream<Uint8Array>, model)) {
        res.write(event);
      }
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await upstream.json();
  sendJson(res, 200, openAIToAnthropic(isRecord(answer) ? answer : {}, model), failures);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await chat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await messages(req, res);
    return;
  }
  sendError(
    res,
    url.pathname === '/v1/messages' ? 'anthropic' : 'openai',
    404,
    'not_found',
    `no route ${req.method ?? ''} ${url.pathname}`,
  );
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env answers with the trial's prompt count. */
async function register(port: number, report: CatalogReport): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the trial holds ${reply.requests} prompts`);
}

/** Poll GET /work every 100 ms; exit 0 the moment it says done. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) {
    // The same document the register body carries, byte for byte: print the one built object and
    // stop before any server starts. A process whose stdout is not flushed loses the tail, so wait
    // for it.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (chatCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) {
        sendError(
          res,
          req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai',
          500,
          'internal_error',
          'the server failed to answer',
        );
      }
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  // 8080 is the env's on one layout; the OS's ephemeral range never holds it, and the guard says so.
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${servedModels().length} free models`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
