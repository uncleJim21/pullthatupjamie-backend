const BASENAME_REGEX = /^[a-zA-Z0-9_-]+$/;
const BASENAME_MIN = 3;
const BASENAME_MAX = 100;

/**
 * Sanitize a file name for safe use in storage keys.
 * - Strips any path components
 * - Removes path traversal characters
 * - Replaces unsafe characters with underscores
 */
function sanitizeFileName(fileName) {
  // First, strip any path information by extracting just the file name
  const fileNameOnly = (fileName || '').split('/').pop().split('\\').pop();
  
  // Remove path traversal characters and potentially harmful characters
  const sanitized = fileNameOnly
    .replace(/\.\.\//g, '') // Remove path traversal
    .replace(/[/\\]/g, '_') // Replace slashes with underscores
    .replace(/[^a-zA-Z0-9._-]/g, '_') // Replace other special characters
    .trim();
  
  // Ensure the file name isn't empty after sanitization
  return sanitized || 'unnamed_file';
}

/**
 * Validate an upload file name against basic safety and UX rules.
 * - Must be a string
 * - Must contain exactly one dot (basename + extension)
 * - Basename must be 3-100 chars and match BASENAME_REGEX
 */
function validateUploadFileName(fileName) {
  if (typeof fileName !== 'string') {
    return { ok: false, code: 'invalid_type', message: 'Filename must be a string.' };
  }

  // Normalize any potential path components before validation
  const fileNameOnly = fileName.split('/').pop().split('\\').pop();

  const firstDot = fileNameOnly.indexOf('.');
  const lastDot = fileNameOnly.lastIndexOf('.');

  // Require exactly one dot to separate basename and extension
  if (firstDot === -1 || firstDot !== lastDot) {
    return {
      ok: false,
      code: 'invalid_format',
      message: 'Filename must contain exactly one dot separating name and extension (e.g. my-video.mp4).'
    };
  }

  const base = fileNameOnly.slice(0, firstDot);

  if (base.length < BASENAME_MIN || base.length > BASENAME_MAX) {
    return {
      ok: false,
      code: 'invalid_length',
      message: `Filename must be between ${BASENAME_MIN} and ${BASENAME_MAX} characters (letters, numbers, _ or -).`
    };
  }

  if (!BASENAME_REGEX.test(base)) {
    return {
      ok: false,
      code: 'invalid_characters',
      message: 'Filename may only contain letters, numbers, hyphens (-), and underscores (_).'
    };
  }

  return { ok: true };
}

module.exports = {
  sanitizeFileName,
  validateUploadFileName
};

