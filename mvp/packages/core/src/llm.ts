import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

export interface JsonRequest<T> {
  /** Short name for logs and fakes, e.g. "parseIntent". */
  task: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  timeoutMs?: number;
}

/** The only way the MVP talks to an LLM: structured output, validated by zod. */
export interface Llm {
  json<T>(request: JsonRequest<T>): Promise<T>;
}

export class LlmError extends Error {
  constructor(
    readonly task: string,
    readonly reason: "timeout" | "invalid_output" | "provider",
    message: string,
  ) {
    super(`${task}: ${message}`);
    this.name = "LlmError";
  }
}

/** Gemini accepts a JSON Schema subset; the draft marker is not part of it. */
export function toGeminiSchema(schema: z.ZodType): unknown {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { target: "draft-2020-12" }) as Record<string, unknown>;
  return rest;
}

export function createGeminiLlm(options: { apiKey: string; model: string; defaultTimeoutMs?: number }): Llm {
  const ai = new GoogleGenAI({ apiKey: options.apiKey });
  return {
    async json<T>(request: JsonRequest<T>): Promise<T> {
      const timeoutMs = request.timeoutMs ?? options.defaultTimeoutMs ?? 12_000;
      let text: string | undefined;
      try {
        const response = await ai.models.generateContent({
          model: options.model,
          contents: request.prompt,
          config: {
            systemInstruction: request.system,
            responseMimeType: "application/json",
            responseJsonSchema: toGeminiSchema(request.schema),
            temperature: 0.2,
            abortSignal: AbortSignal.timeout(timeoutMs),
          },
        });
        text = response.text;
      } catch (error) {
        const timedOut = error instanceof Error && /abort|timeout/i.test(`${error.name} ${error.message}`);
        throw new LlmError(
          request.task,
          timedOut ? "timeout" : "provider",
          error instanceof Error ? error.message : String(error),
        );
      }
      return parseJson(request, text);
    },
  };
}

export function parseJson<T>(request: Pick<JsonRequest<T>, "task" | "schema">, text: string | undefined): T {
  let raw: unknown;
  try {
    raw = JSON.parse(text ?? "");
  } catch {
    throw new LlmError(request.task, "invalid_output", "response was not JSON");
  }
  const parsed = request.schema.safeParse(raw);
  if (!parsed.success) throw new LlmError(request.task, "invalid_output", parsed.error.message);
  return parsed.data;
}
