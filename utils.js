const https = require('https');
const http = require('http');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

async function downloadOnce(url, dest, redirectCount = 0) {
  if (redirectCount > 5) throw new Error('Too many redirects for: ' + url);
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    const req = protocol.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
        file.close();
        fs.unlink(dest, () => {});
        return downloadOnce(res.headers.location, dest, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', reject);
    });
    req.on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
    req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout: ' + url)); });
  });
}

async function download(url, dest, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await downloadOnce(url, dest);
      return;
    } catch (err) {
      const msg = err instanceof AggregateError ? err.errors.map(e => e.message).join(', ') : err.message;
      console.warn(`[download] Attempt ${i + 1}/${retries} failed for ${url}: ${msg}`);
      if (i < retries - 1) await new Promise(r => setTimeout(r, 3000 * (i + 1)));
      else throw new Error(`Download failed after ${retries} attempts: ${msg}`);
    }
  }
}

async function getAudioDuration(filePath) {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    );
    const d = parseFloat(stdout.trim());
    return isNaN(d) ? 5 : d;
  } catch {
    return 5;
  }
}

function wrapText(text, maxCharsPerLine) {
  const words = (text || '').toString().split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (test.length <= maxCharsPerLine) {
      cur = test;
    } else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

async function writeTextFile(text, filePath) {
  await fs.promises.writeFile(filePath, (text || '').toString(), 'utf8');
  return filePath;
}

module.exports = { download, getAudioDuration, wrapText, writeTextFile };
