/**
 * The five scenes, run in order and rendered as text a reviewer can read in two minutes.
 *
 * Each scene prints what happened and then the one property it demonstrates, checked against the
 * output rather than claimed: "holds" or "DOES NOT HOLD". A demo that could only print success
 * would be a slide, not a demonstration.
 */

import { RESTRICTED_PREFIX, SCENES, type Asked, type Demo } from "./demo.js";

export interface SceneResult {
  readonly title: string;
  readonly lines: readonly string[];
  /** The property this scene demonstrates, and whether the output shows it. */
  readonly property: string;
  readonly holds: boolean;
}

const indent = (text: string): string => `    ${text}`;

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** At most three citations; the rest are counted, not printed. Three is what a reader takes in. */
const SHOWN_CITATIONS = 3;

function answerLines(asked: Asked): string[] {
  const lines = [
    `${asked.principal} asks: "${asked.query}"`,
    indent(`→ ${oneLine(asked.message)}`),
  ];
  for (const citation of asked.citations.slice(0, SHOWN_CITATIONS)) {
    lines.push(indent(`  cites ${citation.source}: "${oneLine(citation.quote)}"`));
  }
  const more = asked.citations.length - SHOWN_CITATIONS;
  if (more > 0) lines.push(indent(`  …and ${String(more)} more`));
  return lines;
}

export async function runWalkthrough(demo: Demo): Promise<SceneResult[]> {
  const scenes: SceneResult[] = [];

  // 1. A grounded answer: every claim bound to a passage, checked before release (PRD 7.1-7.2).
  const grounded = await demo.ask(SCENES.grounded.principal, SCENES.grounded.query);
  scenes.push({
    title: "1. A cited answer, verified before it is released",
    lines: answerLines(grounded),
    property:
      "every citation points at a passage that was retrieved for this principal (verification is structural, not a model)",
    holds:
      grounded.citations.every((citation) => grounded.sourcesInPrompt.includes(citation.source)) &&
      (grounded.abstained || grounded.citations.length > 0),
  });

  // 2. Permissions are a pre-filter: the same question, two principals (PRD 6.2, 6.4).
  const exec = await demo.ask("prn_exec", SCENES.hidden.query);
  const reader = await demo.ask("prn_reader", SCENES.hidden.query);
  const readerSawRestricted = reader.sourcesInPrompt.some((source) =>
    source.startsWith(RESTRICTED_PREFIX),
  );
  scenes.push({
    title: "2. Permissions are enforced before retrieval, not after",
    lines: [
      ...answerLines(exec),
      "",
      ...answerLines(reader),
      indent(
        `  sources that reached the reader's prompt: ${reader.sourcesInPrompt.join(", ") || "none"}`,
      ),
    ],
    property:
      "nothing from the hidden restricted zone reaches the reader's prompt — not filtered out of the answer, never retrieved",
    holds: !readerSawRestricted,
  });

  // 3. A prompt injection in the corpus and in the query changes nothing it could exploit (PRD 6.5).
  const injected = await demo.ask(SCENES.injection.principal, SCENES.injection.query);
  scenes.push({
    title: "3. A prompt injection reaches nothing it is not allowed to",
    lines: [
      ...answerLines(injected),
      "",
      "What this does not show: whether the prose is appropriate. A model may quote an injected",
      "passage it was allowed to read, as gpt-4.1-mini has done with the public vendor brief.",
      "Verification is structural, so it checks citations, not intent. That is the threat model's",
      "stated residual risk (docs/threat-model.md, section 2).",
    ],
    property:
      "no restricted or finance passage is retrieved for an engineering principal, and any citation is to a retrieved passage",
    holds:
      !injected.sourcesInPrompt.some(
        (source) => source.startsWith(RESTRICTED_PREFIX) || source.startsWith("finance/"),
      ) &&
      injected.citations.every((citation) => injected.sourcesInPrompt.includes(citation.source)),
  });

  // 4. Generation unavailable degrades to ranked passages (PRD 9.4, ADR 0010).
  const degraded = await demo.ask(SCENES.grounded.principal, SCENES.grounded.query, {
    generationFails: true,
  });
  scenes.push({
    title: "4. When generation fails, the passages still come back",
    lines: [...answerLines(degraded), indent(`  degraded: ${degraded.degraded.join(", ")}`)],
    property:
      "the answer degrades to ranked passages with no prose, marked degraded, instead of an error",
    holds:
      degraded.degraded.includes("generation-unavailable") &&
      degraded.citations.length > 0 &&
      degraded.reason === "generation-unavailable",
  });

  // 5. What the first answer cost and where its time went (PRD 9.2).
  const slowest = [...grounded.timings].sort((a, b) => b.ms - a.ms).slice(0, 4);
  scenes.push({
    title: "5. The trace behind scene 1",
    lines: [
      `models: ${Object.entries(demo.models)
        .map(([role, id]) => `${role} ${id}`)
        .join(", ")}`,
      `total ${grounded.totalMs.toFixed(0)} ms; ${grounded.firstTokenMs === null ? "no first-token time (this generator does not stream)" : `model's first token at ${grounded.firstTokenMs.toFixed(0)} ms (the answer is released only after verification)`}`,
      `slowest stages: ${slowest.map((timing) => `${timing.stage} ${timing.ms.toFixed(1)} ms`).join(", ")}`,
      `tokens ${String(grounded.inputTokens)} in / ${String(grounded.outputTokens)} out; cost ${grounded.costUsd === null ? "unpriced (stand-in models have no price)" : `$${grounded.costUsd.toFixed(5)}`}`,
    ],
    property: "every request carries its stage timings, token counts and cost",
    holds: grounded.timings.length > 0,
  });

  return scenes;
}

export function renderWalkthrough(demo: Demo, scenes: readonly SceneResult[]): string {
  // The embedder and generator decide whether answers are language. The reranker is bypassed.
  const standIns = [demo.models.embedder, demo.models.generator].some(
    (id) => id?.startsWith("stand-in") === true,
  );
  const out = [
    "AtlasOps (RAG-01): governed retrieval-augmented answers",
    `corpus: ${String(demo.chunks)} chunks, snapshot ${demo.snapshot.slice(0, 19)}…`,
    ...(standIns
      ? [
          "models: in-repo stand-ins, so answers are mechanical, not language. Every property below holds",
          "either way; run `pnpm demo -- --models openai` for real answers, cost and time to first token.",
        ]
      : []),
    "",
  ];
  for (const scene of scenes) {
    out.push(
      scene.title,
      ...scene.lines.map(indent),
      "",
      indent(`${scene.holds ? "✔ holds" : "✘ DOES NOT HOLD"}: ${scene.property}`),
      "",
    );
  }
  const failed = scenes.filter((scene) => !scene.holds).length;
  out.push(
    failed === 0 ? "All five properties held." : `${String(failed)} propert(ies) did not hold.`,
  );
  return `${out.join("\n")}\n`;
}
