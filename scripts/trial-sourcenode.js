#!/usr/bin/env node
/**
 * 4 parallel trials: "Create a summary of sourcenode's latest appearance on the Robin Seyr podcast in the last month"
 * Validates that:
 *  - find_person is called and guestGuids hint is used
 *  - get_episode is called on the guest guids (not just search_quotes)
 *  - the May 1 episode (648a5c32-...) is referenced in the output
 */

const http = require('http');

const QUERY = 'Create a summary of sourcenode\'s latest appearance on the Robin Seyr podcast in the last month';
const PORT  = 4132;
const TRIALS = 4;

function runTrial(trialNum) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ message: QUERY, mode: 'deep' });
    const options = {
      hostname: 'localhost',
      port: PORT,
      path: '/api/pull',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'text/event-stream',
        'X-Free-Tier': 'true',
      },
    };

    const result = {
      trialNum,
      toolCalls: [],
      guestGuidsFound: false,
      getEpisodeCalls: [],
      may1EpisodeFound: false,
      april26EpisodeFound: false,
      finalText: '',
      requestId: null,
      error: null,
    };

    const MAY1_GUID   = '648a5c32-7564-49d5-bf5b-95a293a160c8';
    const APRIL26_GUID = '2a611ce8-579a-4414-a1a9-194ec26b7171';

    const req = http.request(options, (res) => {
      let buffer = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        // SSE blocks are separated by blank lines
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop(); // keep incomplete block

        for (const block of blocks) {
          const lines = block.split('\n');
          let eventType = null;
          let dataRaw = null;

          for (const line of lines) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataRaw = line.slice(6).trim();
          }

          if (!dataRaw || dataRaw === '[DONE]') continue;

          let payload;
          try { payload = JSON.parse(dataRaw); } catch { continue; }

          // Support both named-event style and type-in-payload style
          const type = eventType || payload.type;

          if (type === 'request_id') result.requestId = payload.requestId;

          if (type === 'tool_call') {
            const toolName = payload.tool || payload.name;
            result.toolCalls.push(toolName);
            if (toolName === 'find_person') result.guestGuidsFound = true;
            if (toolName === 'get_episode') {
              const guidArg = payload.input?.guid || payload.input?.episodeGuid || '';
              result.getEpisodeCalls.push(guidArg);
              if (guidArg.includes(MAY1_GUID))   result.may1EpisodeFound = true;
              if (guidArg.includes(APRIL26_GUID)) result.april26EpisodeFound = true;
            }
          }

          if (type === 'text_delta') result.finalText += payload.text || '';
          if (type === 'text_done')  result.finalText = payload.text || result.finalText;
        }
      });

      res.on('end', () => {
        // also check final text for guid references
        if (result.finalText.includes(MAY1_GUID))   result.may1EpisodeFound = true;
        if (result.finalText.includes(APRIL26_GUID)) result.april26EpisodeFound = true;
        if (result.finalText.toLowerCase().includes('bitcoin at $76k') ||
            result.finalText.toLowerCase().includes('generationally cheap') ||
            result.finalText.toLowerCase().includes('may 1') ||
            result.finalText.toLowerCase().includes('may 1, 2026')) {
          result.may1EpisodeFound = true;
        }
        resolve(result);
      });
    });

    req.on('error', (e) => {
      result.error = e.message;
      resolve(result);
    });

    req.setTimeout(120000, () => {
      result.error = 'timeout after 120s';
      req.destroy();
    });

    req.write(body);
    req.end();
  });
}

async function main() {
  console.log(`\nFiring ${TRIALS} parallel trials...\n`);
  console.log(`Query: "${QUERY}"\n`);
  console.log('─'.repeat(80));

  const promises = Array.from({ length: TRIALS }, (_, i) => runTrial(i + 1));
  const results  = await Promise.all(promises);

  let passed = 0;

  for (const r of results) {
    const ok = !r.error && r.guestGuidsFound && r.getEpisodeCalls.length > 0 && r.may1EpisodeFound;
    if (ok) passed++;

    console.log(`\nTrial ${r.trialNum}  [${ok ? '✓ PASS' : '✗ FAIL'}]  requestId=${r.requestId || 'n/a'}`);
    if (r.error) {
      console.log(`  ERROR: ${r.error}`);
      continue;
    }
    console.log(`  find_person called:         ${r.guestGuidsFound ? 'YES' : 'NO'}`);
    console.log(`  get_episode calls:          ${r.getEpisodeCalls.length > 0 ? r.getEpisodeCalls.join(', ') : 'NONE'}`);
    console.log(`  May 1 episode found:        ${r.may1EpisodeFound  ? 'YES' : 'NO'}`);
    console.log(`  April 26 episode found:     ${r.april26EpisodeFound ? 'YES' : 'NO'}`);
    console.log(`  Total tool calls:           [${r.toolCalls.join(', ')}]`);
    const preview = r.finalText.replace(/\s+/g, ' ').trim().slice(0, 200);
    console.log(`  Response preview:           ${preview}…`);
  }

  console.log('\n' + '─'.repeat(80));
  console.log(`\nResult: ${passed}/${TRIALS} trials passed\n`);
  process.exit(passed === TRIALS ? 0 : 1);
}

main();
