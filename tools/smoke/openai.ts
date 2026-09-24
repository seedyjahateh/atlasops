/**
 * `pnpm smoke:openai` — one real call to each capability, run deliberately.
 *
 * Recorded responses prove the adapter handles a shape; they cannot prove the shape is still what
 * the provider sends. That is the single thing this script exists for, and it is why it is a
 * command a person runs rather than a test: it costs money, it needs a key, and it fails when the
 * network does. **CI never runs it.**
 *
 * It lives under `tools/` because `tools/` is outside the constrained graph the boundary checker
 * scans — the same reason the checker itself lives there. That is a hole in the enforcement and is
 * named as one in ADR 0006: nothing stops product code being written here, except that it would be
 * the wrong place for it and a reviewer would say so.
 *
 * What it prints is what it actually measured: the model identifiers the provider echoed back, the
 * token counts it reported, and the cost those imply at the checked-in price table. It states no
 * latency figure — one call is not a measurement, and PRD 9.3's latency budgets have a method
 * (a scripted load run) that this is not.
 */

import {
  OPENAI_DEFAULT_EMBEDDING_DIMENSION,
  OPENAI_DEFAULT_EMBEDDING_MODEL,
  OPENAI_DEFAULT_GENERATION_MODEL,
  OPENAI_PRICE_TABLE,
  openAiEmbedder,
  openAiGenerator,
  openAiKeyFromEnv,
} from "@atlasops/model-gateway";
import { costOf } from "@atlasops/telemetry";

function argument(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

async function main(): Promise<number> {
  const apiKey = openAiKeyFromEnv(process.env);
  const embeddingModel = argument("embedding-model", OPENAI_DEFAULT_EMBEDDING_MODEL);
  const generationModel = argument("generation-model", OPENAI_DEFAULT_GENERATION_MODEL);

  process.stdout.write(
    `smoke: two live calls, one per capability. This spends money.\n` +
      `  embedding:  ${embeddingModel} @ ${String(OPENAI_DEFAULT_EMBEDDING_DIMENSION)} dimensions\n` +
      `  generation: ${generationModel}\n` +
      `  prices:     ${OPENAI_PRICE_TABLE.version}\n\n`,
  );

  const embedder = openAiEmbedder({
    apiKey,
    model: embeddingModel,
    dimension: OPENAI_DEFAULT_EMBEDDING_DIMENSION,
  });
  const embedding = await embedder.embed({
    texts: ["A governed knowledge platform answers only from what the asker may read."],
  });
  const embeddingCost = costOf(
    OPENAI_PRICE_TABLE,
    embeddingModel,
    embedding.usage.inputTokens,
    embedding.usage.outputTokens,
  );

  process.stdout.write(
    `embedding: ${String(embedding.vectors.length)} vector(s), ` +
      `${String(embedding.vectors[0]?.length ?? 0)} dimensions, ` +
      `${String(embedding.usage.inputTokens)} input token(s), ` +
      `$${embeddingCost.amountUsd.toFixed(8)}\n`,
  );

  const generator = openAiGenerator({ apiKey, model: generationModel, maxOutputTokens: 64 });
  const generated = await generator.generate({
    system: "Answer in one short sentence. Do not add anything the question did not ask for.",
    user: "What is retrieval-augmented generation?",
  });
  const generationCost = costOf(
    OPENAI_PRICE_TABLE,
    generated.modelId,
    generated.usage.inputTokens,
    generated.usage.outputTokens,
  );

  process.stdout.write(
    `generation: model "${generated.modelId}", ` +
      `${String(generated.usage.inputTokens)} in / ${String(generated.usage.outputTokens)} out, ` +
      `$${generationCost.amountUsd.toFixed(8)}\n` +
      `  ${generated.text.replaceAll("\n", " ").slice(0, 200)}\n\n`,
  );

  process.stdout.write(
    `smoke: both capabilities answered. This proves the wire shape, not quality, latency or cost —\n` +
      `two calls are not a measurement, and PRD 9.3's budgets have a method this is not.\n`,
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`smoke: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
