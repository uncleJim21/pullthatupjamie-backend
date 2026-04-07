const BASE_URL = process.env.FRONTEND_URL || 'https://www.pullthatupjamie.ai';

/**
 * Format workflow results based on the requested outputFormat.
 *
 * @param {object} workflowResult - Raw result from runWorkflow()
 * @param {string} outputFormat - 'structured' | 'text' | 'audio' | 'video'
 * @returns {object} Formatted response
 */
function formatWorkflowOutput(workflowResult, outputFormat = 'structured') {
  switch (outputFormat) {
    case 'text':
      return formatAsText(workflowResult);
    case 'audio':
      return formatAsAudio(workflowResult);
    case 'video':
      return formatAsVideo(workflowResult);
    case 'structured':
    default:
      return formatAsStructured(workflowResult);
  }
}

function formatAsStructured(result) {
  const clips = [];
  const chapters = [];
  const discoveries = [];
  const personEpisodes = [];

  for (const item of (result.results || [])) {
    const sourceStep = item._sourceStep;

    if (sourceStep === 'search-quotes') {
      clips.push({
        text: item.quote || '',
        speaker: item.creator || null,
        podcast: item.episode || null,
        timestamp: item.timeContext?.start_time || null,
        date: item.date || null,
        similarity: item.similarity || null,
        shareUrl: item.shareUrl || null,
        miniPlayer: item.miniPlayer || {
          pineconeId: item.pineconeId,
          timestamp: item.timeContext?.start_time || null,
          duration: (item.timeContext?.end_time && item.timeContext?.start_time)
            ? item.timeContext.end_time - item.timeContext.start_time
            : null,
          episode: item.episode || null,
          speaker: item.creator || null,
          audioUrl: item.audioUrl || null,
        },
        guid: item.guid || null,
        feedId: item.feedId || null,
      });
    } else if (sourceStep === 'search-chapters') {
      chapters.push({
        headline: item.headline || null,
        keywords: item.keywords || [],
        summary: item.summary || null,
        startTime: item.startTime || null,
        endTime: item.endTime || null,
        episode: item.episode || null,
        guid: item.guid || null,
        feedId: item.feedId || null,
      });
    } else if (sourceStep === 'discover-podcasts') {
      discoveries.push({
        title: item.title || '',
        author: item.author || '',
        feedId: item.feedId || null,
        transcriptAvailable: item.transcriptAvailable || false,
        description: item.description || '',
      });
    } else if (sourceStep === 'person-lookup') {
      personEpisodes.push({
        title: item.title || '',
        creator: item.creator || null,
        publishedDate: item.publishedDate || null,
        guid: item.guid || null,
        feedId: item.feedId || null,
        matchedGuest: item.matchedGuest || null,
      });
    }
  }

  return {
    status: result.status,
    sessionId: result.sessionId,
    iterationsUsed: result.iterationsUsed,
    workflowType: result.workflowType,
    results: {
      clips,
      chapters,
      discoveries,
      personEpisodes,
      sessionUrl: `${BASE_URL}/sessions/${result.sessionId}`,
    },
    steps: result.accumulatedSteps || [],
    cost: result.cost,
    latencyMs: result.latencyMs,
  };
}

function formatAsText(result) {
  const lines = [];
  lines.push(`# Research Results\n`);
  lines.push(`**Task:** ${result.results?.[0]?._sourceStep ? '' : ''}${result.workflowType?.replace(/_/g, ' ') || 'research'}`);
  lines.push(`**Iterations:** ${result.iterationsUsed}\n`);

  const quoteResults = (result.results || []).filter(r => r._sourceStep === 'search-quotes');
  const chapterResults = (result.results || []).filter(r => r._sourceStep === 'search-chapters');
  const discoveryResults = (result.results || []).filter(r => r._sourceStep === 'discover-podcasts');
  const personResults = (result.results || []).filter(r => r._sourceStep === 'person-lookup');

  if (quoteResults.length > 0) {
    lines.push(`## Quotes Found (${quoteResults.length})\n`);
    for (let i = 0; i < quoteResults.length; i++) {
      const q = quoteResults[i];
      const listenLink = q.shareUrl ? `[Listen](${q.shareUrl})` : '';
      lines.push(`${i + 1}. "${(q.quote || '').substring(0, 200)}${q.quote?.length > 200 ? '...' : ''}"`);
      lines.push(`   — ${q.creator || 'Unknown'} | ${q.episode || 'Unknown episode'} | ${q.date || ''} ${listenLink}\n`);
    }
  }

  if (chapterResults.length > 0) {
    lines.push(`## Related Chapters (${chapterResults.length})\n`);
    for (const ch of chapterResults) {
      lines.push(`- **${ch.headline || 'Untitled'}** — ${ch.episode?.title || 'Unknown episode'}`);
      if (ch.summary) lines.push(`  ${ch.summary.substring(0, 150)}${ch.summary.length > 150 ? '...' : ''}`);
    }
    lines.push('');
  }

  if (discoveryResults.length > 0) {
    lines.push(`## Discovered Podcasts (${discoveryResults.length})\n`);
    for (const d of discoveryResults) {
      const status = d.transcriptAvailable ? 'transcribed' : 'not yet transcribed';
      lines.push(`- **${d.title}** by ${d.author || 'Unknown'} (${status})`);
    }
    lines.push('');
  }

  if (personResults.length > 0) {
    lines.push(`## Person Appearances (${personResults.length})\n`);
    for (const p of personResults) {
      lines.push(`- **${p.title}** — ${p.creator || ''} (${p.publishedDate || ''})`);
    }
    lines.push('');
  }

  lines.push(`---`);
  lines.push(`Session: ${BASE_URL}/sessions/${result.sessionId}`);

  return {
    status: result.status,
    sessionId: result.sessionId,
    iterationsUsed: result.iterationsUsed,
    workflowType: result.workflowType,
    text: lines.join('\n'),
    cost: result.cost,
    latencyMs: result.latencyMs,
  };
}

function formatAsAudio(result) {
  const audioClips = (result.results || [])
    .filter(r => r._sourceStep === 'search-quotes' && r.shareUrl)
    .map(r => ({
      shareUrl: r.shareUrl,
      quote: (r.quote || '').substring(0, 100),
      episode: r.episode || null,
      speaker: r.creator || null,
      timestamp: r.timeContext?.start_time || null,
      miniPlayer: r.miniPlayer || null,
    }));

  return {
    status: result.status,
    sessionId: result.sessionId,
    iterationsUsed: result.iterationsUsed,
    clips: audioClips,
    cost: result.cost,
    latencyMs: result.latencyMs,
  };
}

function formatAsVideo(result) {
  // Video format is reserved for when clip creation is implemented.
  // For now, return the same as audio with a note.
  const audioResult = formatAsAudio(result);
  return {
    ...audioResult,
    note: 'Video clip generation is not yet available in workflow mode. Audio deeplinks are provided instead.',
  };
}

module.exports = { formatWorkflowOutput };
