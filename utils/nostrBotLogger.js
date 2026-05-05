const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.NOSTR_BOT_LOG_DIR
  ? path.resolve(process.env.NOSTR_BOT_LOG_DIR)
  : path.join(process.cwd(), 'logs', 'nostr-bot');
const LOG_FILE = path.join(LOG_DIR, 'nostr-bot.log');

const ANSI_RE = /\x1b\[[0-9;]*m/g;

let stream = null;
let disabled = false;

function getStream() {
  if (disabled) return null;
  if (stream) return stream;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    stream.on('error', () => {
      // If the stream errors mid-flight (disk full, perms changed),
      // drop further writes rather than crashing the process.
      disabled = true;
      stream = null;
    });
    return stream;
  } catch (_) {
    disabled = true;
    return null;
  }
}

function nostrBotLog(message) {
  const s = getStream();
  if (!s) return;
  const ts = new Date().toISOString();
  const cleaned = String(message).replace(ANSI_RE, '');
  try {
    s.write(`[${ts}] ${cleaned}\n`);
  } catch (_) {
    // Swallow — logging must never break the caller.
  }
}

module.exports = { nostrBotLog, LOG_FILE, LOG_DIR };
