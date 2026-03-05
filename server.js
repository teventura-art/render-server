const express = require('express');
const path = require('path');
const fs = require('fs');
const { renderQMC, renderQuiz } = require('./renderer');

const app = express();
app.use(express.json({ limit: '100mb' }));

const PORT = process.env.PORT || 5001;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const VIDEOS_DIR = path.join(__dirname, 'videos');

fs.mkdirSync(VIDEOS_DIR, { recursive: true });
fs.mkdirSync(path.join(__dirname, 'temp'), { recursive: true });

app.use('/videos', express.static(VIDEOS_DIR));

app.get('/', (_, res) => res.json({ status: 'ok', service: 'render-server', version: '1.0.0' }));
app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.post('/render/qmc', async (req, res) => {
  try {
    const { catTitle, questions, urlAudioIntro, urlAudioCTA, urlAudioOutro } = req.body;
    if (!catTitle || !questions || !questions.length) {
      return res.status(400).json({ error: 'Missing required fields: catTitle, questions' });
    }
    console.log(`[QMC] Render request: ${catTitle}, ${questions.length} questions`);
    const result = await renderQMC({ catTitle, questions, urlAudioIntro, urlAudioCTA, urlAudioOutro }, VIDEOS_DIR, BASE_URL);
    res.json(result);
  } catch (err) {
    const msg = err.message || String(err);
    const stderr = err.stderr ? err.stderr.slice(-2000) : '';
    console.error('[QMC] Error:', msg);
    if (stderr) console.error('[QMC] stderr:', stderr);
    res.status(500).json({ error: msg, stderr: stderr.slice(-500) });
  }
});

app.post('/render/quiz', async (req, res) => {
  try {
    const { temaTitle, canal, questions, urlAudioIntro, urlAudioCTA, urlAudioOutro, urlMusica } = req.body;
    if (!questions || !questions.length) {
      return res.status(400).json({ error: 'Missing required fields: questions' });
    }
    console.log(`[QUIZ] Render request: ${temaTitle}, ${questions.length} questions`);
    const result = await renderQuiz({ temaTitle, canal, questions, urlAudioIntro, urlAudioCTA, urlAudioOutro, urlMusica }, VIDEOS_DIR, BASE_URL);
    res.json(result);
  } catch (err) {
    const msg = err.message || String(err);
    const stderr = err.stderr ? err.stderr.slice(-2000) : '';
    console.error('[QUIZ] Error:', msg);
    if (stderr) console.error('[QUIZ] stderr:', stderr);
    res.status(500).json({ error: msg, stderr: stderr.slice(-500) });
  }
});

app.listen(PORT, () => {
  console.log(`Render server running on port ${PORT}`);
  console.log(`Base URL: ${BASE_URL}`);
});
