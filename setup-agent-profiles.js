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
- "research_session": The user wants a **curated multi-clip or multi-episode artifact** they can keep, revisit, or share — not a one-off answer. Treat as research_session when they ask to **build, make, create, put together, compile, bundle, curate, aggregate, assemble, collect, line up, queue, or give** a **playlist, research session, clip pack, supercut, highlight reel, binge list, anthology, reading/listening list of clips, digest of clips, or "episodes to watch/listen"** for a topic or show (optionally with a time window: "this month", "last month", "recent", "latest episodes"). Phrases like **"for my team"**, **"I can send to a friend"**, **"shareable"**, **"save this"** (when tied to multiple clips/episodes) also count. **Err on the side of research_session** when the deliverable sounds like **more than a single narrative answer** — e.g. ordered list of episodes with clips to explore in-app.
- "transcribe": User explicitly asks to TRANSCRIBE, INGEST, or ADD a podcast/episode. Must be an explicit FUTURE-TENSE transcription request (imperative: "transcribe X", "ingest Y", "get Z transcribed"). Past-tense mentions ("I transcribed", "already transcribed", "just transcribed") are NOT transcribe intent — they're context for a follow-up search. If the same message contains a follow-up question ("what did they say", "summarize", "tell me about"), always prefer "search".
- "search": Single-pass questions — explain, compare, summarize, "what did X say about Y", topic exploration, one episode deep dive, or a follow-up after transcription **without** asking for a saved playlist/session/clip bundle. This is the default when unsure **unless** the user clearly wants a **multi-item curated artifact** as above.

Examples:
- "Make me a research session on AI" → {"intent":"research_session"}
- "Build a playlist about Bitcoin" → {"intent":"research_session"}
- "Make me a playlist of Shawn Ryan's last month" → {"intent":"research_session"}
- "Curate the best clips on inflation from the last 90 days" → {"intent":"research_session"}
- "Put together clips of Huberman on sleep" → {"intent":"research_session"}
- "Compile a highlight reel of Rogan on UFOs" → {"intent":"research_session"}
- "Line up recent All-In takes on AI regulation I can share" → {"intent":"research_session"}
- "Aggregate podcast takes on UBI into one place" → {"intent":"research_session"}
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
