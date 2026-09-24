/**
 * The public surface of RAG-03, the Incident Knowledge Assistant.
 *
 * A leaf (PRD 11.2): nothing imports it, and it imports nothing from RAG-02. What the two share
 * comes from `packages/*` — the sandbox above all, which exists because both needed it (ADR 0008).
 */

export {
  DEFAULT_WINDOW_HOURS,
  INCIDENT_CHUNK_TOKENS,
  createIncidentAssistant,
  type EvidenceItem,
  type IncidentAssistant,
  type IncidentAssistantOptions,
  type IncidentBrief,
  type InvestigateOptions,
  type RecentChange,
} from "./assistant.js";

export {
  evaluateIncident,
  loadIncidentDataset,
  resolveIncidentItems,
  type IncidentDataset,
  type IncidentItem,
  type IncidentScores,
  type SectionLabel,
} from "./evaluate.js";

export {
  EVIDENCE_KINDS,
  displayPathOf,
  headerOf,
  kindOf,
  type DocumentHeader,
  type EvidenceKind,
} from "./metadata.js";

export {
  STALE_AFTER_DAYS,
  UNCERTAINTY_CODES,
  uncertaintiesOf,
  type EvidenceSummary,
  type Uncertainty,
  type UncertaintyCode,
} from "./uncertainty.js";
