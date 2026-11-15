// brief.ts — the trial brief: the free model list, the six prompts, the catalog.
//
// The brief at $MAKEFUN_PROMPT_FILE is prose with two JSON documents in it. The prose does not
// matter: each document is found by its `schema` member under this contest's prefix
// (`free-model-aggregator-02/`). A document is recognised by the arrays it carries, never by a
// name alone, so a brief that spells its lists in the sibling contest's names still reads.
//
//   - the model list (`free-model-aggregator-02/models/v1`): one row per free OpenRouter model,
//     keyed by the id the gateway routes (`openrouter/<vendor>/<model>:free`), with the house's
//     published rating in milli-points, what the model can do (tools, vision, JSON mode, context
//     length) and its free flag. Only a free model may serve a prompt.
//   - the prompts (`free-model-aggregator-02/prompts/v1`): the six prompts the house's client
//     sends, in arrival order, each with its id, its api (`openai` or `anthropic`), whether it
//     streams, its weight (1 or 2) and the requirements a model must meet to serve it.
//
// Everything here is a pure function of the brief file: no clock, no randomness, so
// `node main.ts --list` and the register body build the same catalog document, byte for byte,
// on a live pass and on its replay.

import { readFileSync } from 'node:fs';

export const MODELS_SCHEMA = 'free-model-aggregator-02/models/v1';
export const PROMPTS_SCHEMA = 'free-model-aggregator-02/prompts/v1';

/** Every schema this contest's brief writes names this prefix. */
const SCHEMA_PREFIX = 'free-model-aggregator-02/';

/** The public base URL of the provider the free models belong to: the endpoint the gateway reaches. */
export const OPENROUTER_PUBLIC_BASE = 'https://openrouter.ai/api/v1';
/** The environment variable an entrant's OpenRouter key is pushed under. */
export const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY';

export type Json = Record<string, unknown>;
export const isRecord = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

/** One free model as the brief lists it. `id` is the id the gateway routes. */
export interface ModelRow {
  id: string;
  /** The provider the model belongs to, as the brief names it (`openrouter`). */
  provider: string;
  display_name: string;
  /** The house's published rating in milli-points: the quality column's currency. */
  rating_milli: number;
  context_length: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
  free: boolean;
}

/** What one prompt needs: a model without it cannot serve the prompt. */
export interface Requirement {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  min_context?: number;
}

/** One prompt the client will send, as the brief lists it. */
export interface PromptRow {
  id: string;
  api: 'openai' | 'anthropic';
  stream: boolean;
  weight: 1 | 2;
  requires: Requirement;
}

/** The brief as this server reads it. `error` is set when a document could not be read. */
export interface Brief {
  models: ModelRow[];
  prompts: PromptRow[];
  error: string | null;
}

/** One model in the catalog document. */
export interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}

/** One provider in the catalog document. */
export interface CatalogProvider {
  id: string;
  base_url: string;
  key_env: string;
  wire: 'openai';
  models: CatalogModel[];
}

/** What `--list` prints and what the entry POSTs to /register: the same document, byte for byte. */
export interface CatalogReport {
  providers: CatalogProvider[];
}

/** Every JSON object in `text` that carries a string `schema`, in the order they appear. */
function documentsIn(text: string): Json[] {
  const out: Json[] = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = objectEnd(text, start);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (isRecord(value) && typeof value.schema === 'string') out.push(value);
    } catch {
      // Not JSON on its own: look on.
    }
  }
  return out;
}

/** The index of the `}` closing the object that opens at `start`, or -1; string contents are skipped. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function stringOf(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function boolOrNull(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/**
 * The first document under this contest's prefix that carries one of `keys` as an array: the
 * document and the key it was found under.
 */
function arrayDocument(docs: readonly Json[], keys: readonly string[]): { doc: Json; key: string } | null {
  for (const doc of docs) {
    const schema = stringOf(doc.schema);
    if (!schema.includes(SCHEMA_PREFIX)) continue;
    for (const key of keys) if (Array.isArray(doc[key])) return { doc, key };
  }
  return null;
}

/**
 * One model row. The id is the row's `id`, or its `model` under the provider that names it: a row
 * that gives the bare OpenRouter id (`vendor/model:free`) and names `openrouter` is routed as the
 * gateway spells it (`openrouter/vendor/model:free`). A row is free unless it says `free: false`;
 * a paid row is never routed.
 */
function modelOf(v: unknown): ModelRow | null {
  if (!isRecord(v)) return null;
  const raw = stringOf(v.id) !== '' ? stringOf(v.id) : stringOf(v.model);
  if (raw === '') return null;
  const named = stringOf(v.provider) !== '' ? stringOf(v.provider) : stringOf(v.wire);
  const id = named === 'openrouter' && !raw.toLowerCase().startsWith('openrouter/') ? `openrouter/${raw}` : raw;
  return {
    id,
    provider: named === '' ? 'openrouter' : named,
    display_name: stringOf(v.display_name) !== '' ? stringOf(v.display_name) : raw,
    rating_milli: numberOrNull(v.rating_milli) ?? 0,
    context_length: numberOrNull(v.context_length),
    tools: boolOrNull(v.tools),
    vision: boolOrNull(v.vision),
    json: boolOrNull(v.json),
    free: v.free !== false,
  };
}

function promptOf(v: unknown): PromptRow | null {
  if (!isRecord(v)) return null;
  const id = stringOf(v.id);
  if (id === '') return null;
  const requires = isRecord(v.requires) ? v.requires : {};
  return {
    id,
    api: v.api === 'anthropic' ? 'anthropic' : 'openai',
    stream: v.stream === true,
    weight: v.weight === 2 ? 2 : 1,
    requires: {
      ...(requires.tools === true ? { tools: true } : {}),
      ...(requires.vision === true ? { vision: true } : {}),
      ...(requires.json === true ? { json: true } : {}),
      ...(typeof requires.min_context === 'number' && Number.isFinite(requires.min_context)
        ? { min_context: requires.min_context }
        : {}),
    },
  };
}

/** The brief at `path`, its two documents found under this contest's schema prefix. */
export function readBrief(path: string): Brief {
  if (path === '') return { models: [], prompts: [], error: 'MAKEFUN_PROMPT_FILE is not set' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { models: [], prompts: [], error: `cannot read ${path}: ${(err as Error).message}` };
  }
  const docs = documentsIn(text);
  const modelsDoc = arrayDocument(docs, ['models', 'ratings']);
  if (modelsDoc === null) {
    return { models: [], prompts: [], error: `the brief at ${path} holds no ${MODELS_SCHEMA} document` };
  }
  const models = (modelsDoc.doc[modelsDoc.key] as unknown[]).flatMap((v) => {
    const m = modelOf(v);
    return m === null ? [] : [m];
  });
  const promptsDoc = arrayDocument(docs, ['prompts', 'manifest']);
  if (promptsDoc === null) {
    return { models, prompts: [], error: `the brief at ${path} holds no ${PROMPTS_SCHEMA} document` };
  }
  const prompts = (promptsDoc.doc[promptsDoc.key] as unknown[]).flatMap((v) => {
    const p = promptOf(v);
    return p === null ? [] : [p];
  });
  return { models, prompts, error: null };
}

/** The models this entry may serve: the brief's free ones, in the brief's order. */
export function freeModels(brief: Brief): ModelRow[] {
  return brief.models.filter((m) => m.free);
}

/** Whether a model's capabilities meet one prompt's requirements. An unknown capability never meets one. */
export function meetsRequirements(requires: Requirement, model: ModelRow): boolean {
  if (requires.tools === true && model.tools !== true) return false;
  if (requires.vision === true && model.vision !== true) return false;
  if (requires.json === true && model.json !== true) return false;
  if (
    requires.min_context !== undefined &&
    (model.context_length === null || model.context_length < requires.min_context)
  ) {
    return false;
  }
  return true;
}

/**
 * The free models that can serve a prompt, best first: highest published rating wins, and ties
 * keep the brief's order (Array.sort is stable, so equal ratings never reorder). Quality is 60%
 * of the score, so the first candidate is always the strongest model the prompt allows — on the
 * practice brief that is inkling-2-small (1475) for plain and tools prompts, and
 * nemotron-3.5-super-vl (1303) for JSON-mode prompts, the strongest JSON-capable free model.
 */
export function rankCandidates(models: readonly ModelRow[], requires: Requirement): ModelRow[] {
  return models
    .filter((m) => m.free && meetsRequirements(requires, m))
    .sort((a, b) => b.rating_milli - a.rating_milli);
}

/**
 * The catalog the brief's free model list makes: one provider, the models it serves.
 *
 * The base_url is the provider's public endpoint, never the gateway's trial-local address: the
 * gateway's origin differs between a live pass and its replay, and the catalog is part of the
 * state export a replay must reproduce byte for byte.
 *
 * Every free model in the brief is listed, exactly the fourteen dialable ids the catalog column
 * scores: register this set and answer GET /v1/models with it on both auth headers, since
 * listing fewer loses the column as surely as listing more.
 */
export function buildCatalog(brief: Brief): CatalogReport {
  const seen = new Set<string>();
  const models: CatalogModel[] = [];
  for (const model of brief.models) {
    if (!model.free || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push({ id: model.id, free: true, context_length: model.context_length });
  }
  if (models.length === 0) return { providers: [] };
  return {
    providers: [
      {
        id: 'openrouter',
        base_url: OPENROUTER_PUBLIC_BASE,
        key_env: OPENROUTER_KEY_ENV,
        wire: 'openai',
        models,
      },
    ],
  };
}

/**
 * Requirements read off a request body, when the brief has no row for it — or as a second opinion
 * on the row: JSON mode from `response_format`, tools from a non-empty `tools` array, vision from
 * an image block in the messages. The union of the manifest row and the body is what the router
 * uses, so a prompt is never routed to a model that lacks a capability its own body asks for.
 */
export function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return {
    ...(Array.isArray(body.tools) && body.tools.length > 0 ? { tools: true } : {}),
    ...(vision ? { vision: true } : {}),
    ...(format === 'json_object' || format === 'json_schema' ? { json: true } : {}),
  };
}

/** The union of two requirement sets: a capability either side asks for is required. */
export function mergeRequirements(a: Requirement, b: Requirement): Requirement {
  return {
    ...(a.tools === true || b.tools === true ? { tools: true } : {}),
    ...(a.vision === true || b.vision === true ? { vision: true } : {}),
    ...(a.json === true || b.json === true ? { json: true } : {}),
    ...(a.min_context !== undefined || b.min_context !== undefined
      ? { min_context: Math.max(a.min_context ?? 0, b.min_context ?? 0) }
      : {}),
  };
}
