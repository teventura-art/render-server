const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { renderQMC, renderQuiz } = require('./renderer');

const app = express();
app.use(express.json({ limit: '100mb' }));

const PORT = process.env.PORT || 5001;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const VIDEOS_DIR = path.join(__dirname, 'videos');

fs.mkdirSync(VIDEOS_DIR, { recursive: true });
fs.mkdirSync(path.join(__dirname, 'temp'), { recursive: true });

// In-memory job store
const jobs = new Map();

app.use('/videos', express.static(VIDEOS_DIR));

app.get('/', (_, res) => res.json({ status: 'ok', service: 'render-server', version: '2.0.0' }));
app.get('/health', (_, res) => res.json({ status: 'ok' }));

// Job status endpoint — n8n polls this
app.get('/render/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.post('/render/qmc', (req, res) => {
  const { catTitle, questions, urlAudioIntro, urlAudioCTA, urlAudioOutro } = req.body;
  if (!catTitle || !questions || !questions.length) {
    return res.status(400).json({ error: 'Missing required fields: catTitle, questions' });
  }
  // Limit to 25 questions per video
  const q25 = questions.slice(0, 25);
  const jobId = uuidv4();
  jobs.set(jobId, { status: 'processing' });
  console.log(`[QMC] Job ${jobId} queued: ${catTitle}, ${q25.length} questions`);

  // Start render in background — do NOT await
  renderQMC({ catTitle, questions: q25, urlAudioIntro, urlAudioCTA, urlAudioOutro }, VIDEOS_DIR, BASE_URL)
    .then(result => {
      jobs.set(jobId, { status: 'done', url: result.url });
      console.log(`[QMC] Job ${jobId} done: ${result.url}`);
    })
    .catch(err => {
      const msg = err.message || String(err);
      jobs.set(jobId, { status: 'error', error: msg });
      console.error(`[QMC] Job ${jobId} failed:`, msg);
    });

  // Respond immediately with job ID
  res.json({ jobId, status: 'processing' });
});

app.post('/render/quiz', (req, res) => {
  const { temaTitle, canal, questions, urlAudioIntro, urlAudioCTA, urlAudioOutro, urlMusica } = req.body;
  if (!questions || !questions.length) {
    return res.status(400).json({ error: 'Missing required fields: questions' });
  }
  const q25 = questions.slice(0, 25);
  const jobId = uuidv4();
  jobs.set(jobId, { status: 'processing' });
  console.log(`[QUIZ] Job ${jobId} queued: ${temaTitle}, ${q25.length} questions`);

  renderQuiz({ temaTitle, canal, questions: q25, urlAudioIntro, urlAudioCTA, urlAudioOutro, urlMusica }, VIDEOS_DIR, BASE_URL)
    .then(result => {
      jobs.set(jobId, { status: 'done', url: result.url });
      console.log(`[QUIZ] Job ${jobId} done: ${result.url}`);
    })
    .catch(err => {
      const msg = err.message || String(err);
      jobs.set(jobId, { status: 'error', error: msg });
      console.error(`[QUIZ] Job ${jobId} failed:`, msg);
    });

  res.json({ jobId, status: 'processing' });
});

app.listen(PORT, () => {
  console.log(`Render server running on port ${PORT}`);
  console.log(`Base URL: ${BASE_URL}`);
});
