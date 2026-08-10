import { spawn, spawnSync } from "node:child_process";
import { abortError, wireChildAbort } from "./child-abort.js";
import { createReadStream, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resolveApiKey } from "./auth/api-keys.js";

/**
 * Whisper transcription backends. Tries local whisper.cpp first (free, fast,
 * private), falls back to the OpenAI API if the binary isn't installed.
 *
 * Both backends normalize to the same shape:
 *   { language, duration, segments: [{ start, end, text }] }
 *
 * Word-level timestamps are optional. When `wordTimestamps: true`:
 *   - whisper.cpp uses `--max-len 1` to force one-word segments + `-ml 1`
 *   - OpenAI verbose_json with `timestamp_granularities[]=word` returns words
 * Both populate `words?: TranscriptWord[]` per segment when supported. When
 * unsupported (older whisper.cpp build) the field is omitted; agents check.
 */

export interface TranscriptWord {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  /** Word-level timing if requested + available. */
  words?: TranscriptWord[];
  /**
   * Speaker label, when present. Populated only when the transcript was
   * produced by a tool that does diarization (whisperx, AssemblyAI, manual).
   * gg-editor's bundled `transcribe` does not produce speaker labels.
   */
  speaker?: string;
}

export interface Transcript {
  language: string;
  durationSec: number;
  segments: TranscriptSegment[];
}

/**
 * OpenAI transcription model identifiers — see
 * https://platform.openai.com/docs/api-reference/audio/createTranscription.
 *
 *   - `whisper-1`              Legacy Whisper V2. Only model with `verbose_json` +
 *                              word/segment timestamp_granularities. Best when you
 *                              need word-level timing (caption burn-in).
 *   - `gpt-4o-transcribe`      GPT-4o speech model (~$0.006/min). Higher accuracy.
 *                              JSON-only response — text + duration only, NO segments.
 *   - `gpt-4o-mini-transcribe` Cheaper sibling (~$0.003/min). JSON-only.
 *   - `gpt-4o-transcribe-diarize` Built-in speaker diarization. Returns segments with
 *                              `speaker` labels via `diarized_json`. Replaces the
 *                              whisperx + HF_TOKEN + pyannote chain. Requires
 *                              `chunking_strategy: "auto"` for inputs > 30s.
 */
export type OpenAITranscriptionModel =
  "whisper-1" | "gpt-4o-transcribe" | "gpt-4o-mini-transcribe" | "gpt-4o-transcribe-diarize";

export interface TranscribeOptions {
  /** Force a backend; otherwise auto-pick (whisperx if diarize=true, else local first, then api). */
  backend?: "local" | "api" | "whisperx";
  /** Local whisper.cpp model file. Required if backend=local. */
  modelPath?: string;
  /** OpenAI API key (env OPENAI_API_KEY otherwise). */
  apiKey?: string;
  /**
   * OpenAI model id. Default `whisper-1` because it's the only model that
   * returns word/segment timestamps — required by burn_subtitles and the
   * caption pipeline. Pick `gpt-4o-transcribe-diarize` for built-in speaker
   * labels (no whisperx install needed).
   */
  apiModel?: OpenAITranscriptionModel;
  /** ISO-639-1 language code; whisper auto-detects when omitted. */
  language?: string;
  /** Request word-level timestamps. Required for word-by-word burned captions. */
  wordTimestamps?: boolean;
  /**
   * Run speaker diarization. Two paths exist:
   *  1. Set `apiModel: "gpt-4o-transcribe-diarize"` — server-side diarization,
   *     no extra dependencies. Recommended.
   *  2. Set `backend: "whisperx"` (or omit and let auto-detect kick in) —
   *     local whisperx + pyannote, requires `whisperx` on PATH and HF_TOKEN.
   * The `diarize: true` flag alone routes to whisperx for backwards compat.
   */
  diarize?: boolean;
  /** HF token override (otherwise reads HF_TOKEN env). Used by whisperx --hf_token. */
  hfToken?: string;
  /** whisperx model size. Default "base". */
  whisperxModel?: string;
  /**
   * Server-side audio chunking for the OpenAI gpt-4o-transcribe family. Set to
   * `"auto"` to have the server normalize loudness, run VAD, and chunk the file
   * (up to 1500s for transcribe, 1400s for transcribe-diarize, both within the
   * 25 MB upload cap). Required for `gpt-4o-transcribe-diarize` on inputs > 30s
   * — auto-enabled in that case if you don't set it.
   */
  chunkingStrategy?: "auto";
  /** Abort signal. */
  signal?: AbortSignal;
}

// ── Backend detection ──────────────────────────────────

export function detectLocalWhisper(): { cmd: string; argsPrefix: string[] } | undefined {
  // whisper.cpp ships under several names depending on build:
  //   - whisper-cli (modern)
  //   - main (legacy whisper.cpp build artifact)
  //   - whisper (some distros)
  for (const cmd of ["whisper-cli", "whisper", "main"]) {
    const r = spawnSync(cmd, ["--help"], { encoding: "utf8" });
    if (r.status === 0 && (r.stdout + r.stderr).toLowerCase().includes("whisper")) {
      return { cmd, argsPrefix: [] };
    }
  }
  return undefined;
}

/**
 * Detect whisperx (the diarization-capable wrapper around whisper). It prints
 * its name in --help; we accept either way it might be exposed.
 */
export function detectWhisperx(): boolean {
  const r = spawnSync("whisperx", ["--help"], { encoding: "utf8" });
  return r.status === 0;
}

export function detectApiKey(override?: string): string | undefined {
  return override ?? process.env.OPENAI_API_KEY;
}

// ── Public dispatcher ───────────────────────────────────────

export async function transcribe(
  inputPath: string,
  opts: TranscribeOptions = {},
): Promise<Transcript> {
  const wantLocal = opts.backend === "local";
  const wantApi = opts.backend === "api";
  const wantWhisperx = opts.backend === "whisperx" || opts.diarize === true;

  // Diarize via OpenAI (gpt-4o-transcribe-diarize) takes precedence over
  // whisperx when explicitly requested by model id — no install needed.
  const wantDiarizeApi = opts.apiModel === "gpt-4o-transcribe-diarize";
  if (wantDiarizeApi) {
    const apiKey = detectApiKey(opts.apiKey);
    if (!apiKey) {
      throw new Error(
        "gpt-4o-transcribe-diarize requires OPENAI_API_KEY. Either set it, " +
          "or set backend: 'whisperx' to diarize locally.",
      );
    }
    return transcribeOpenAI(inputPath, apiKey, opts);
  }

  if (wantWhisperx) {
    if (!detectWhisperx()) {
      throw new Error(
        "whisperx not on PATH. Install: pip install whisperx. " +
          "Diarization also requires HF_TOKEN (free account at huggingface.co). " +
          "Or set apiModel: 'gpt-4o-transcribe-diarize' for server-side diarization.",
      );
    }
    return transcribeWhisperx(inputPath, opts);
  }

  if (!wantApi) {
    const local = detectLocalWhisper();
    if (local && opts.modelPath) {
      return transcribeLocal(inputPath, local.cmd, opts);
    }
    if (wantLocal) {
      throw new Error(
        "whisper.cpp not found or modelPath not set. " +
          "Install whisper.cpp and pass modelPath to ggml-*.bin.",
      );
    }
  }

  const apiKey = detectApiKey(opts.apiKey);
  if (!apiKey) {
    throw new Error(
      "No transcription backend available. " +
        "Either install whisper.cpp + pass modelPath, or set OPENAI_API_KEY.",
    );
  }
  return transcribeOpenAI(inputPath, apiKey, opts);
}

// ── Local: whisper.cpp ──────────────────────────────────────

function transcribeLocal(
  inputPath: string,
  cmd: string,
  opts: TranscribeOptions,
): Promise<Transcript> {
  return new Promise((resolve, reject) => {
    if (!opts.modelPath) {
      reject(new Error("modelPath required for local whisper backend"));
      return;
    }
    const args = [
      "-m",
      opts.modelPath,
      "-f",
      inputPath,
      "-oj", // output JSON
      "-of",
      "/dev/stdout", // some builds ignore -of stdout; we re-derive from stderr if needed
      "-pp", // print progress
      "-nt", // no timestamps in printed text
    ];
    if (opts.language) args.push("-l", opts.language);
    if (opts.wordTimestamps) {
      // whisper.cpp emits per-token timestamps in the JSON when -ml=1 forces
      // single-token segments. We post-process to lift them onto words.
      args.push("-ml", "1");
    }

    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const cleanup = wireChildAbort(opts.signal, child, {
      onAbort: () => reject(abortError("transcribe aborted")),
    });
    child.on("error", (e) => {
      cleanup();
      reject(e);
    });
    child.on("close", (code) => {
      cleanup();
      if (code !== 0) {
        reject(new Error(`whisper.cpp exited ${code}: ${stderr.slice(-500)}`));
        return;
      }
      try {
        // whisper.cpp -oj writes a JSON file alongside the input by default;
        // when -of /dev/stdout is honoured, JSON is in stdout. Try both.
        const json = stdout.trim().startsWith("{") ? stdout : (extractJsonBlock(stdout) ?? stderr);
        const parsed = JSON.parse(json) as {
          result?: { language?: string };
          transcription?: Array<{ offsets: { from: number; to: number }; text: string }>;
        };
        const tokens = parsed.transcription ?? [];
        const segments = opts.wordTimestamps
          ? regroupTokensIntoSegments(tokens)
          : tokens.map((t) => ({
              start: t.offsets.from / 1000,
              end: t.offsets.to / 1000,
              text: t.text.trim(),
            }));
        resolve({
          language: parsed.result?.language ?? opts.language ?? "unknown",
          durationSec: tokens[tokens.length - 1]?.offsets.to
            ? tokens[tokens.length - 1].offsets.to / 1000
            : 0,
          segments,
        });
      } catch (e) {
        reject(new Error(`failed to parse whisper.cpp JSON: ${(e as Error).message}`));
      }
    });
  });
}

function extractJsonBlock(s: string): string | undefined {
  const open = s.indexOf("{");
  const close = s.lastIndexOf("}");
  if (open >= 0 && close > open) return s.slice(open, close + 1);
  return undefined;
}

/**
 * whisper.cpp with -ml=1 emits ONE entry per token. We regroup adjacent tokens
 * back into sentence-ish segments (split at sentence punctuation) and attach
 * the original tokens as the `words` array.
 */
export function regroupTokensIntoSegments(
  tokens: Array<{ offsets: { from: number; to: number }; text: string }>,
): TranscriptSegment[] {
  if (tokens.length === 0) return [];
  const segments: TranscriptSegment[] = [];
  let current: TranscriptWord[] = [];
  const flush = () => {
    if (current.length === 0) return;
    segments.push({
      start: current[0].start,
      end: current[current.length - 1].end,
      text: current
        .map((w) => w.text)
        .join(" ")
        .replace(/\s+([.,!?;:])/g, "$1")
        .trim(),
      words: current,
    });
    current = [];
  };
  for (const t of tokens) {
    const txt = t.text.trim();
    if (!txt) continue;
    current.push({ start: t.offsets.from / 1000, end: t.offsets.to / 1000, text: txt });
    if (/[.!?]$/.test(txt)) flush();
  }
  flush();
  return segments;
}

// ── whisperx (diarization) ───────────────────────────

export interface WhisperxJson {
  language?: string;
  segments?: Array<{
    start: number;
    end: number;
    text: string;
    speaker?: string;
    words?: Array<{ start: number; end: number; word: string; speaker?: string }>;
  }>;
}

/**
 * Pure-data conversion: whisperx JSON shape → our Transcript shape.
 * Exposed for unit tests; production code reads the file from disk first.
 */
export function whisperxJsonToTranscript(
  parsed: WhisperxJson,
  fallbackLanguage = "unknown",
): Transcript {
  const segments: TranscriptSegment[] = (parsed.segments ?? []).map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text.trim(),
    ...(s.speaker ? { speaker: s.speaker } : {}),
    ...(s.words && s.words.length > 0
      ? {
          words: s.words
            .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end))
            .map((w) => ({
              start: w.start,
              end: w.end,
              text: w.word.trim(),
            })),
        }
      : {}),
  }));
  return {
    language: parsed.language ?? fallbackLanguage,
    durationSec: segments.at(-1)?.end ?? 0,
    segments,
  };
}

function transcribeWhisperx(inputPath: string, opts: TranscribeOptions): Promise<Transcript> {
  return new Promise((resolve, reject) => {
    const outDir = mkdtempSync(join(tmpdir(), "gg-editor-whisperx-"));
    const args = [
      inputPath,
      "--model",
      opts.whisperxModel ?? "base",
      "--output_format",
      "json",
      "--output_dir",
      outDir,
    ];
    if (opts.diarize) args.push("--diarize");
    if (opts.language) args.push("--language", opts.language);
    const hfToken = opts.hfToken ?? resolveApiKey("HF_TOKEN", "huggingface");
    if (opts.diarize) {
      if (!hfToken) {
        reject(
          new Error(
            "HF_TOKEN required for diarization. Get one free at huggingface.co/settings/tokens " +
              "and accept the pyannote/speaker-diarization-3.1 license.",
          ),
        );
        return;
      }
      args.push("--hf_token", hfToken);
    }

    const child = spawn("whisperx", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const cleanup = wireChildAbort(opts.signal, child, {
      onAbort: () => reject(abortError("whisperx aborted")),
    });
    child.on("error", (e) => {
      cleanup();
      reject(e);
    });
    child.on("close", (code) => {
      cleanup();
      if (code !== 0) {
        reject(new Error(`whisperx exited ${code}: ${stderr.slice(-500)}`));
        return;
      }
      try {
        // whisperx writes <basename>.json into outDir.
        const files = readdirSync(outDir).filter((f) => f.endsWith(".json"));
        if (files.length === 0) {
          reject(new Error("whisperx produced no JSON output"));
          return;
        }
        const parsed = JSON.parse(readFileSync(join(outDir, files[0]), "utf8")) as WhisperxJson;
        resolve(whisperxJsonToTranscript(parsed, opts.language ?? "unknown"));
      } catch (e) {
        reject(new Error(`failed to parse whisperx JSON: ${(e as Error).message}`));
      }
    });
  });
}

// ── OpenAI API ──────────────────────────────────────────────

/**
 * Per-model request shape. The OpenAI transcription API rejects mismatched
 * combinations (e.g. response_format=verbose_json on gpt-4o-transcribe), so we
 * route per model. Pure function — exported for unit tests.
 */
export interface OpenAIRequestPlan {
  /** What to put in the `response_format` form field. */
  responseFormat: "verbose_json" | "json" | "diarized_json";
  /** True if the model+request supports word-level + segment-level timing. */
  emitsTimestamps: boolean;
  /** True if the response will include speaker labels. */
  emitsSpeakers: boolean;
  /**
   * Effective chunking_strategy to send (or undefined to omit). Auto-enables
   * "auto" for diarize when the caller didn't explicitly set one.
   */
  chunkingStrategy: "auto" | undefined;
}

export function planOpenAIRequest(
  model: OpenAITranscriptionModel,
  opts: Pick<TranscribeOptions, "wordTimestamps" | "chunkingStrategy">,
): OpenAIRequestPlan {
  switch (model) {
    case "whisper-1":
      // The only model that supports verbose_json + timestamp_granularities.
      return {
        responseFormat: "verbose_json",
        emitsTimestamps: true,
        emitsSpeakers: false,
        chunkingStrategy: opts.chunkingStrategy,
      };
    case "gpt-4o-transcribe":
    case "gpt-4o-mini-transcribe":
      // GPT-4o transcribe family: JSON-only, no segments, no word timestamps.
      // Higher accuracy than whisper-1 but you lose timing — picks like
      // burn_subtitles still want whisper-1.
      return {
        responseFormat: "json",
        emitsTimestamps: false,
        emitsSpeakers: false,
        chunkingStrategy: opts.chunkingStrategy,
      };
    case "gpt-4o-transcribe-diarize":
      // diarized_json is required to receive speaker segments. Server requires
      // chunking_strategy for inputs > 30s — we always send "auto" unless the
      // caller explicitly set a different strategy.
      return {
        responseFormat: "diarized_json",
        emitsTimestamps: true,
        emitsSpeakers: true,
        chunkingStrategy: opts.chunkingStrategy ?? "auto",
      };
  }
}

/**
 * Response shape covering all three OpenAI variants we route. Optional fields
 * are present on different models:
 *   - whisper-1 verbose_json: text, language, duration, segments[], words[]
 *   - gpt-4o-(mini-)transcribe json: text, language?, duration?
 *   - gpt-4o-transcribe-diarize diarized_json: text, segments[{speaker,start,end,text}]
 */
interface OpenAITranscriptionResponse {
  text?: string;
  language?: string;
  duration?: number;
  segments?: Array<{
    start: number;
    end: number;
    text: string;
    /** Only on diarized_json. */
    speaker?: string;
  }>;
  /** verbose_json + timestamp_granularities=word. */
  words?: Array<{ start: number; end: number; word: string }>;
}

async function transcribeOpenAI(
  inputPath: string,
  apiKey: string,
  opts: TranscribeOptions,
): Promise<Transcript> {
  const stat = statSync(inputPath);
  if (stat.size > 25 * 1024 * 1024) {
    throw new Error(
      `OpenAI transcription has a 25MB upload cap (got ${(stat.size / 1024 / 1024).toFixed(1)}MB). ` +
        "Compress to mono 16kHz WAV via extract_audio (a 25-min interview fits comfortably). " +
        "chunking_strategy splits long audio server-side but doesn't bypass the upload cap.",
    );
  }

  const model: OpenAITranscriptionModel = opts.apiModel ?? "whisper-1";
  const plan = planOpenAIRequest(model, opts);

  // Use native FormData/Blob — Node 20+ has them as globals. Cleaner than
  // hand-rolling multipart, and the openai SDK does the same internally.
  const fileBuf = await streamToBuffer(createReadStream(inputPath));
  const form = new FormData();
  form.append("model", model);
  form.append("response_format", plan.responseFormat);
  if (plan.responseFormat === "verbose_json" && opts.wordTimestamps) {
    form.append("timestamp_granularities[]", "word");
    form.append("timestamp_granularities[]", "segment");
  }
  if (plan.chunkingStrategy) {
    form.append("chunking_strategy", plan.chunkingStrategy);
  }
  if (opts.language && model !== "gpt-4o-transcribe-diarize") {
    // diarize model rejects language; the others accept it.
    form.append("language", opts.language);
  }
  form.append(
    "file",
    new Blob([new Uint8Array(fileBuf)], { type: "application/octet-stream" }),
    basename(inputPath),
  );

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: opts.signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `OpenAI transcription HTTP ${res.status} (model=${model}): ${errText.slice(0, 300)}`,
    );
  }

  const data = (await res.json()) as OpenAITranscriptionResponse;
  return openAIResponseToTranscript(data, plan, opts);
}

/**
 * Pure-data conversion: OpenAI transcription response → our Transcript shape.
 * Exported for unit tests; production code calls this after fetch.
 */
export function openAIResponseToTranscript(
  data: OpenAITranscriptionResponse,
  plan: OpenAIRequestPlan,
  opts: Pick<TranscribeOptions, "language" | "wordTimestamps">,
): Transcript {
  // gpt-4o-(mini-)transcribe returns `text` only. Synthesise a single segment
  // covering the whole clip so downstream tools (read_transcript, write_srt)
  // still see *something* useful.
  if (!plan.emitsTimestamps) {
    const text = (data.text ?? "").trim();
    return {
      language: data.language ?? opts.language ?? "unknown",
      durationSec: data.duration ?? 0,
      segments: text ? [{ start: 0, end: data.duration ?? 0, text }] : [],
    };
  }

  const segments = (data.segments ?? []).map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text.trim(),
    ...(plan.emitsSpeakers && s.speaker ? { speaker: s.speaker } : {}),
  })) as TranscriptSegment[];

  if (opts.wordTimestamps && data.words && segments.length > 0) {
    // Distribute words into the segment whose [start,end] contains the word's
    // midpoint. Linear walk; both arrays are already in order.
    let segIdx = 0;
    for (const w of data.words) {
      const mid = (w.start + w.end) / 2;
      while (segIdx < segments.length - 1 && mid > segments[segIdx].end) segIdx += 1;
      const seg = segments[segIdx];
      if (!seg.words) seg.words = [];
      seg.words.push({ start: w.start, end: w.end, text: w.word });
    }
  }
  return {
    language: data.language ?? opts.language ?? "unknown",
    durationSec: data.duration ?? segments.at(-1)?.end ?? 0,
    segments,
  };
}

// ── Transcript parsing + validation ──────────────────────────

/**
 * Parse and validate a transcript JSON string.
 *
 * Validates that the result has the shape written by `transcribe()`:
 *   - `language`   — string
 *   - `durationSec` — finite number ≥ 0
 *   - `segments`   — array (may be empty; each element must have start/end/text)
 *
 * Throws a descriptive Error on any mismatch so callers can surface it
 * as a tool error instead of a cryptic `Cannot read property of undefined`
 * deep inside filler-word or caption logic.
 *
 * Does NOT validate optional `words` inside segments — the tools that
 * need word-level timings do their own `hasWords` check after calling this.
 */
export function parseTranscript(raw: string): Transcript {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid transcript: not valid JSON — ${(e as Error).message}`, { cause: e });
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid transcript: root value must be an object");
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.language !== "string") {
    throw new Error(
      `Invalid transcript: missing or non-string 'language' (got ${JSON.stringify(obj.language)})`,
    );
  }

  if (typeof obj.durationSec !== "number" || !isFinite(obj.durationSec) || obj.durationSec < 0) {
    throw new Error(
      `Invalid transcript: missing or invalid 'durationSec' (got ${JSON.stringify(obj.durationSec)}) — must be a finite number ≥ 0`,
    );
  }

  if (!Array.isArray(obj.segments)) {
    throw new Error(`Invalid transcript: 'segments' must be an array (got ${typeof obj.segments})`);
  }

  for (let i = 0; i < obj.segments.length; i++) {
    const seg = obj.segments[i] as Record<string, unknown>;
    if (seg === null || typeof seg !== "object" || Array.isArray(seg)) {
      throw new Error(`Invalid transcript: segments[${i}] is not an object`);
    }
    if (typeof seg.start !== "number") {
      throw new Error(
        `Invalid transcript: segments[${i}].start must be a number (got ${JSON.stringify(seg.start)})`,
      );
    }
    if (typeof seg.end !== "number") {
      throw new Error(
        `Invalid transcript: segments[${i}].end must be a number (got ${JSON.stringify(seg.end)})`,
      );
    }
    if (typeof seg.text !== "string") {
      throw new Error(
        `Invalid transcript: segments[${i}].text must be a string (got ${JSON.stringify(seg.text)})`,
      );
    }
  }

  return parsed as Transcript;
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}
