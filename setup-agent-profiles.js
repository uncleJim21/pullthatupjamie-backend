/**
 * Agent Intent Profiles
 *
 * Each profile defines which prompt sections and tools the agent receives
 * based on the classified intent. The `search` profile is the full default.
 */

const { PROMPT_SECTIONS, TOOL_DEFINITIONS, buildCurrentDateSection } = require('./setup-agent');

const ALL_TOOL_NAMES = TOOL_DEFINITIONS.map(t => t.name);

// create_research_session is intentionally excluded from search — it must only
// be available when the classifier explicitly routed to research_session intent.
// Allowing it in search lets DeepSeek self-invoke it on discovery queries and
// produce hallucinated/empty session URLs.
const SEARCH_TOOLS = ALL_TOOL_NAMES.filter(n => n !== 'create_research_session');

const RESEARCH_SESSION_TOOLS = [
  'search_quotes',
  'search_chapters',
  'discover_podcasts',
  'find_person',
  'get_person_episodes',
  'get_feed',
  'get_feed_episodes',
  'get_episode',
  'list_episode_chapters',
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
        PROMPT_SECTIONS.searchTools,
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
- "research_session": The user explicitly wants a **saved, shareable artifact** (playlist, research session, clip pack, highlight reel, supercut, binge list, anthology, digest of clips). Requires ALL of the following: (1) an **explicit creation/curation verb** — build, make, create, put together, bundle, curate, assemble, collect, line up, queue up, give me a playlist/session/pack; AND (2) an **explicit artifact noun** — playlist, research session, clip pack, highlight reel, supercut, binge list, anthology, digest, clip bundle, or "episodes to watch/listen to". Optionally a time window ("last month", "recent"). Phrases like "for my team", "I can share", "shareable link" tied to a collection also count. **Do NOT classify as research_session** for: find, show, tell me, what are, give me, explore, summarize, compare, analyze — even when followed by "best", "top", "greatest", or "from podcasts". Those are search queries that want a written answer with quotes, not a saved artifact.
- "transcribe": User explicitly asks to TRANSCRIBE, INGEST, or ADD a podcast/episode. Must be an explicit FUTURE-TENSE transcription request (imperative: "transcribe X", "ingest Y", "get Z transcribed"). Past-tense mentions ("I transcribed", "already transcribed", "just transcribed") are NOT transcribe intent — they're context for a follow-up search. If the same message contains a follow-up question ("what did they say", "summarize", "tell me about"), always prefer "search".
- "search": Everything else — explain, find, show, tell me, what did X say, compare, summarize, topic exploration, "best X", "top X", one episode deep dive, or a follow-up after transcription. **Default when unsure.**

Examples:
- "Make me a research session on AI" → {"intent":"research_session"}
- "Build a playlist about Bitcoin" → {"intent":"research_session"}
- "Make me a playlist of Shawn Ryan's last month" → {"intent":"research_session"}
- "Curate the best clips on inflation from the last 90 days" → {"intent":"research_session"}
- "Put together clips of Huberman on sleep" → {"intent":"research_session"}
- "Compile a highlight reel of Rogan on UFOs" → {"intent":"research_session"}
- "Line up recent All-In takes on AI regulation I can share" → {"intent":"research_session"}
- "Create a clip bundle of the best takes on UBI" → {"intent":"research_session"}
- "Transcribe the latest Lex Fridman episode" → {"intent":"transcribe"}
- "Can you ingest the All-In podcast?" → {"intent":"transcribe"}
- "Get Corporate Gossip transcribed" → {"intent":"transcribe"}
- "Find the best founder origin stories from podcasts" → {"intent":"search"}
- "Show me the top takes on AI safety" → {"intent":"search"}
- "What are the best Huberman episodes on sleep?" → {"intent":"search"}
- "Give me great clips about Bitcoin" → {"intent":"search"}
- "Best episodes about stoicism" → {"intent":"search"}
- "What did Huberman say about creatine?" → {"intent":"search"}
- "Palmer Luckey on Joe Rogan" → {"intent":"search"}
- "Compare Bitcoin views on TFTC vs WBD" → {"intent":"search"}
- "Compile each host's position on AI regulation and note where they've changed their mind" → {"intent":"search"}
- "Summarize and compile what all four All-In hosts have said about crypto" → {"intent":"search"}
- "Aggregate every macro analyst view on GDP growth in 2026" → {"intent":"search"}
- "I just transcribed episode abc123. What did they say about tariffs?" → {"intent":"search"}
- "Already transcribed that one — now tell me the top takeaways" → {"intent":"search"}`;

module.exports = { PROFILES, VALID_INTENTS, DEFAULT_INTENT, CLASSIFIER_PROMPT };
