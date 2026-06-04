/**
 * Confidence tiers for synthesize responses (memo: confidence tiers).
 *
 * The tier is the backend's editorial judgment, computed DETERMINISTICALLY from
 * signals available post-synthesis — candidate count, rendered section/marker
 * presence, publisher/side distribution, date spread — NOT model self-grading
 * (LLMs are poorly calibrated). `confidenceReason` is a short templated sentence
 * (≤100 chars) the client renders verbatim.
 *
 * Unified enum across kinds: strong | partial | thin | empty.
 *   strong  → full result, no pill
 *   partial → result + yellow pill (reason)
 *   thin    → result + red pill (reason)
 *   empty   → empty state, reason shown verbatim
 */

const CLIP_RE = /\{\{clip:[^}]+\}\}/g;

function markerCount(text, re) { return (text.match(re) || []).length; }
function clipCount(s) { return (s.match(CLIP_RE) || []).length; }
function trim100(s) { const t = String(s || '').trim(); return t.length > 100 ? `${t.slice(0, 97)}…` : t; }

function fmtMonth(ms) {
  const d = new Date(ms);
  return `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCFullYear()}`;
}
function dateRange(candidates) {
  const ds = candidates
    .map((c) => (c.publishedDate ? new Date(c.publishedDate).getTime() : NaN))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (ds.length < 2) return null;
  return `${fmtMonth(ds[0])}–${fmtMonth(ds[ds.length - 1])}`;
}

/**
 * @returns {{ confidence:'strong'|'partial'|'thin'|'empty', confidenceReason:string|null, candidateCount:number }}
 */
function assessConfidence({
  kind, candidates = [], finalText = '',
  synthesizedEmpty = false, emptyReason = null,
  windowDays = null, windowExpanded = false,
}) {
  const candidateCount = candidates.length;
  if (synthesizedEmpty) {
    return {
      confidence: 'empty',
      confidenceReason: trim100(emptyReason || 'Not enough on-topic material to synthesize.'),
      candidateCount,
    };
  }

  let tier = 'strong';
  let reason = '';

  switch (kind) {
    case 'brief': {
      const publishers = markerCount(finalText, /^##\s*PUBLISHER\s*:/gim);
      if (publishers >= 3) { tier = 'strong'; } else if (publishers >= 1) { tier = 'partial'; reason = `Only ${publishers} publisher${publishers > 1 ? 's' : ''} in the window.`; } else { tier = 'thin'; reason = 'Single source; little corroboration.'; }
      // Widening past the default week caps it at partial and is called out.
      if (windowExpanded) {
        if (tier === 'strong') tier = 'partial';
        reason = `Widened to ${windowDays} days; ${candidateCount} mentions.`;
      }
      break;
    }
    case 'readin': {
      const wtd = /##\s*WHAT_THEY_DO/i.test(finalText);
      const pulse = /##\s*PULSE/i.test(finalText);
      const bull = /##\s*SMART_MONEY\s*:\s*BULL/i.test(finalText);
      const bear = /##\s*SMART_MONEY\s*:\s*BEAR/i.test(finalText);
      const risks = /##\s*RISKS/i.test(finalText);
      if (wtd && pulse && bull && bear && risks) { tier = 'strong'; } else if (wtd && (pulse || bull || bear)) {
        tier = 'partial';
        const miss = [!bull && 'bull', !bear && 'bear', !risks && 'risks'].filter(Boolean).join('/');
        reason = `Incomplete: ${miss || 'some sections'} not synthesized.`;
      } else { tier = 'thin'; reason = 'Only a primer; no bull/bear structure available.'; }
      break;
    }
    case 'split': {
      const blocks = finalText.split(/^##\s*PERSON\s*:/im).slice(1);
      const a = clipCount(blocks[0] || '');
      const b = clipCount(blocks[1] || '');
      const total = a + b;
      if (a >= 4 && b >= 4) { tier = 'strong'; } else if (total >= 4) {
        tier = 'partial';
        reason = (Math.min(a, b) <= 2) ? 'One side thinly represented; contrast weak.' : 'Asymmetric coverage across the two sides.';
      } else { tier = 'thin'; reason = 'Few quotes across both sides combined.'; }
      break;
    }
    case 'dossier': {
      const topics = markerCount(finalText, /^##\s*TOPIC\s*:/gim);
      if (candidateCount >= 5 && topics >= 3) { tier = 'strong'; } else if (candidateCount >= 3) { tier = 'partial'; reason = `${candidateCount} appearances — narrow sample.`; } else { tier = 'thin'; reason = `Only ${candidateCount} appearance${candidateCount === 1 ? '' : 's'}.`; }
      break;
    }
    case 'narrative': {
      const buckets = markerCount(finalText, /^##\s*BUCKET\s*\|/gim);
      const range = dateRange(candidates);
      if (candidateCount >= 20 && buckets >= 4) { tier = 'strong'; } else if (candidateCount >= 10 || buckets >= 2) {
        tier = 'partial';
        reason = range ? `Coverage clusters in ${range}; earlier history sparse.` : `${candidateCount} candidates across ${buckets} windows.`;
      } else { tier = 'thin'; reason = `Only ${candidateCount} candidates / ${buckets} window${buckets === 1 ? '' : 's'}.`; }
      break;
    }
    default:
      tier = 'strong';
  }

  return {
    confidence: tier,
    confidenceReason: tier === 'strong' ? null : trim100(reason),
    candidateCount,
  };
}

module.exports = { assessConfidence };
