/**
 * Consistent error model for /api/tape/* (spec §9).
 *
 * All errors return an RFC7807-ish body:
 *   { type, title, status, detail, ...extra }
 *
 * The 429 path additionally carries a `creditInfo` object shaped like the
 * existing /api/pull quota response so the frontend's
 * `parseQuotaExceededResponse` works unchanged.
 */

const TYPE_BASE = 'https://pullthatupjamie.ai/tape';

/**
 * Throwable error a recipe handler can raise to produce a structured response.
 * The endpoint wrapper catches it and renders via `tapeError`.
 */
class TapeHttpError extends Error {
  constructor(status, slug, title, detail, extra = {}) {
    super(detail || title);
    this.name = 'TapeHttpError';
    this.status = status;
    this.slug = slug;
    this.title = title;
    this.detail = detail;
    this.extra = extra;
  }
}

/**
 * Send a structured error response.
 *
 * @param {import('express').Response} res
 * @param {number} status            HTTP status code
 * @param {string} slug              short error slug (becomes part of `type`)
 * @param {string} title             human-readable title
 * @param {string} [detail]          longer explanation
 * @param {object} [extra]           merged into the body (e.g. creditInfo)
 */
function tapeError(res, status, slug, title, detail, extra = {}) {
  const body = {
    type: `${TYPE_BASE}/${slug}`,
    title,
    status,
    ...(detail ? { detail } : {}),
    ...extra,
  };
  return res.status(status).json(body);
}

/**
 * 429 quota/rate-limit response. `creditInfo` mirrors the /api/pull 429 shape
 * (used, max, resetDate, daysUntilReset) so existing clients can parse it.
 *
 * @param {object} opts
 * @param {string} opts.detail
 * @param {number} [opts.used]
 * @param {number} [opts.max]
 * @param {Date|string} [opts.resetDate]
 * @param {number} [opts.retryAfterSec]
 */
function tapeRateLimited(res, { detail, used, max, resetDate, retryAfterSec } = {}) {
  const resetIso = resetDate
    ? (resetDate instanceof Date ? resetDate.toISOString() : String(resetDate))
    : null;
  const daysUntilReset = resetDate
    ? Math.max(0, Math.ceil((new Date(resetIso).getTime() - Date.now()) / 86_400_000))
    : null;

  if (Number.isFinite(retryAfterSec)) {
    res.setHeader('Retry-After', String(Math.ceil(retryAfterSec)));
  }

  return tapeError(res, 429, 'rate-limited', 'Rate limit exceeded', detail, {
    creditInfo: {
      error: 'Quota exceeded',
      code: 'QUOTA_EXCEEDED',
      ...(Number.isFinite(used) ? { used } : {}),
      ...(Number.isFinite(max) ? { max } : {}),
      ...(resetIso ? { resetDate: resetIso } : {}),
      ...(daysUntilReset != null ? { daysUntilReset } : {}),
    },
  });
}

module.exports = { tapeError, tapeRateLimited, TapeHttpError, TYPE_BASE };
