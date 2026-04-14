/**
 * Agent Intent Profiles
 *
 * Each profile defines which prompt sections and tools the agent receives
 * based on the classified intent. The `search` profile is the full default.
 */

const { PROMPT_SECTIONS, TOOL_DEFINITIONS } = require('./setup-agent');

const ALL_TOOL_NAMES = TOOL_DEFINITIONS.map(t => t.name);

const SEARCH_TOOLS = ALL_TOOL_NAMES; // everything

const RESEARCH_SESSION_TOOLS = [
  'search_quotes',
  'search_chapters',
  'find_person',
  'get_person_episodes',
  'create_research_session',
  'suggest_action',
];

const TRANSCRIBE_TOOLS = [
  'discover_podcasts',
  'suggest_action',
];

function filterTools(allowedNames) {
  return TOOL_DEFINITIONS.filter(t => allowedNames.includes(t.name));
}

const PROFILES = {
  search: {
    buildPrompt() {
      return [
        PROMPT_SECTIONS.base,
        PROMPT_SECTIONS.searchTools,
        PROMPT_SECTIONS.searchCrafting,
        PROMPT_SECTIONS.criticalRules,
        PROMPT_SECTIONS.insufficientEvidence,
        PROMPT_SECTIONS.upsellRules,
        PROMPT_SECTIONS.suggestActionRules,
        PROMPT_SECTIONS.tokenStewardship,
        PROMPT_SECTIONS.responseFormat,
      ].join('\n');
    },
    tools() { return filterTools(SEARCH_TOOLS); },
  },

  research_session: {
    buildPrompt() {
      return [
        PROMPT_SECTIONS.base,
        PROMPT_SECTIONS.searchCrafting,
        PROMPT_SECTIONS.sessionCuration,
        PROMPT_SECTIONS.tokenStewardship,
      ].join('\n');
    },
    tools() { return filterTools(RESEARCH_SESSION_TOOLS); },
  },

  transcribe: {
    buildPrompt() {
      return [
        PROMPT_SECTIONS.base,
        PROMPT_SECTIONS.transcribeTools,
        PROMPT_SECTIONS.transcribeRules,
      ].join('\n');
    },
    tools() { return filterTools(TRANSCRIBE_TOOLS); },
  },
};

const VALID_INTENTS = Object.keys(PROFILES);
const DEFAULT_INTENT = 'search';

const CLASSIFIER_PROMPT = `Classify the user's intent into exactly one category. Respond with ONLY a JSON object: {"intent":"<value>"}

Categories:
- "research_session": User explicitly asks to CREATE a research session, playlist, collection, or compilation of clips. Must be an explicit creation request, not just a search.
- "transcribe": User explicitly asks to TRANSCRIBE, INGEST, or ADD a podcast/episode to the corpus. Must be an explicit transcription request.
- "search": Everything else — questions, searches, lookups, comparisons, topic exploration. This is the default.

Examples:
- "Make me a research session on AI" → {"intent":"research_session"}
- "Build a playlist about Bitcoin" → {"intent":"research_session"}
- "Put together clips of Huberman on sleep" → {"intent":"research_session"}
- "Transcribe the latest Lex Fridman episode" → {"intent":"transcribe"}
- "Can you ingest the All-In podcast?" → {"intent":"transcribe"}
- "Get Corporate Gossip transcribed" → {"intent":"transcribe"}
- "What did Huberman say about creatine?" → {"intent":"search"}
- "Palmer Luckey on Joe Rogan" → {"intent":"search"}
- "Compare Bitcoin views on TFTC vs WBD" → {"intent":"search"}`;

module.exports = { PROFILES, VALID_INTENTS, DEFAULT_INTENT, CLASSIFIER_PROMPT };
