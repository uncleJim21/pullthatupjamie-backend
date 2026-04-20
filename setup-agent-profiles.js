/**
 * Agent Intent Profiles
 *
 * Each profile defines which prompt sections and tools the agent receives
 * based on the classified intent. The `search` profile is the full default.
 */

const { PROMPT_SECTIONS, TOOL_DEFINITIONS, buildCurrentDateSection } = require('./setup-agent');

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

// Transcribe profile is the safety net for two scenarios:
//   1. User explicitly asks to transcribe/ingest something (primary use case).
//   2. Classifier misroutes a follow-up question about an already-transcribed
//      episode into transcribe (e.g. "I just transcribed X, tell me about Y").
// For (2) we include search/lookup tools so the agent can still answer usefully
// instead of dead-ending on discover_podcasts alone.
const TRANSCRIBE_TOOLS = [
  'discover_podcasts',
  'search_quotes',
  'search_chapters',
  'find_person',
  'get_person_episodes',
  'list_episode_chapters',
  'get_episode',
  'get_feed',
  'get_feed_episodes',
  'get_adjacent_paragraphs',
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
        buildCurrentDateSection(),
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
        buildCurrentDateSection(),
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
        buildCurrentDateSection(),
        PROMPT_SECTIONS.searchTools,
        PROMPT_SECTIONS.searchCrafting,
        PROMPT_SECTIONS.criticalRules,
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
- "transcribe": User explicitly asks to TRANSCRIBE, INGEST, or ADD a podcast/episode. Must be an explicit FUTURE-TENSE transcription request (imperative: "transcribe X", "ingest Y", "get Z transcribed"). Past-tense mentions ("I transcribed", "already transcribed", "just transcribed") are NOT transcribe intent — they're context for a follow-up search. If the same message contains a follow-up question ("what did they say", "summarize", "tell me about"), always prefer "search".
- "search": Everything else — questions, searches, lookups, comparisons, topic exploration, AND any message that references an already-transcribed episode with a follow-up question. This is the default.

Examples:
- "Make me a research session on AI" → {"intent":"research_session"}
- "Build a playlist about Bitcoin" → {"intent":"research_session"}
- "Put together clips of Huberman on sleep" → {"intent":"research_session"}
- "Transcribe the latest Lex Fridman episode" → {"intent":"transcribe"}
- "Can you ingest the All-In podcast?" → {"intent":"transcribe"}
- "Get Corporate Gossip transcribed" → {"intent":"transcribe"}
- "I just transcribed episode abc123. What did they say about tariffs?" → {"intent":"search"}
- "I transcribed the latest All-In, summarize the key points" → {"intent":"search"}
- "Already transcribed that one — now tell me the top takeaways" → {"intent":"search"}
- "What did Huberman say about creatine?" → {"intent":"search"}
- "Palmer Luckey on Joe Rogan" → {"intent":"search"}
- "Compare Bitcoin views on TFTC vs WBD" → {"intent":"search"}`;

module.exports = { PROFILES, VALID_INTENTS, DEFAULT_INTENT, CLASSIFIER_PROMPT };
