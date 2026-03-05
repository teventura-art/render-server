const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { download, getAudioDuration, wrapText, writeTextFile } = require('./utils');

const FONT = '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf';

// ─── FFmpeg helpers ────────────────────────────────────────────────────────────

function ffmpeg(args) {
  const cmd = `ffmpeg -y ${args}`;
  console.log('[ffmpeg]', cmd.slice(0, 200));
  return execAsync(cmd, { maxBuffer: 100 * 1024 * 1024, timeout: 300000 });
}

// Build a drawtext filter using a temp file for the text (avoids encoding issues)
function dt(textFile, fontSize, color, x, y, extra = '') {
  return `drawtext=fontfile=${FONT}:textfile='${textFile}':fontsize=${fontSize}:fontcolor=${color}:x=${x}:y=${y}${extra ? ':' + extra : ''}`;
}

// Create a video segment from an image (or null for solid bg) + audio + text overlays
async function createSegment({ imageFile, bgColor, audioFile, duration, filters, outputFile }) {
  const totalDuration = duration;

  let inputArgs = '';
  let videoInput = '';

  if (imageFile) {
    inputArgs = `-loop 1 -t ${totalDuration} -i "${imageFile}"`;
    videoInput = '[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1[scaled];[scaled]drawbox=x=0:y=0:w=iw:h=ih:color=black@0.55:t=fill[bg];';
  } else {
    inputArgs = `-f lavfi -t ${totalDuration} -i "color=c=${bgColor || '0x0d1117'}:size=1920x1080:rate=25"`;
    videoInput = '[0:v]setsar=1[bg];';
  }

  const filterChain = filters.reduce((acc, f, i) => {
    const inputLabel = i === 0 ? '[bg]' : `[v${i - 1}]`;
    const outputLabel = i === filters.length - 1 ? '[vout]' : `[v${i}]`;
    return acc + `${inputLabel}${f}${outputLabel};`;
  }, videoInput).replace(/;$/, '');

  const audioInputIdx = imageFile ? 1 : 1;
  const audioArg = `-i "${audioFile}"`;

  await ffmpeg(
    `${inputArgs} ${audioArg} ` +
    `-filter_complex "${filterChain}" ` +
    `-map "[vout]" -map ${audioInputIdx}:a ` +
    `-c:v libx264 -preset fast -crf 23 -c:a aac -ar 44100 -ac 2 ` +
    `-pix_fmt yuv420p -shortest ` +
    `-t ${totalDuration} ` +
    `"${outputFile}"`
  );
  return outputFile;
}

// Create a silence audio file of given duration
async function createSilence(duration, outputFile) {
  await ffmpeg(`-f lavfi -t ${duration} -i "anullsrc=r=44100:cl=stereo" -c:a aac "${outputFile}"`);
  return outputFile;
}

// Concatenate multiple video files
async function concatenate(segmentFiles, outputFile) {
  const listFile = outputFile.replace('.mp4', '_list.txt');
  const listContent = segmentFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
  await fs.promises.writeFile(listFile, listContent, 'utf8');
  await ffmpeg(
    `-f concat -safe 0 -i "${listFile}" ` +
    `-c:v libx264 -preset fast -crf 23 -c:a aac -ar 44100 -ac 2 ` +
    `-pix_fmt yuv420p "${outputFile}"`
  );
  fs.unlink(listFile, () => {});
}

// ─── QMC Segment builders ──────────────────────────────────────────────────────

async function buildIntroSegment({ audioFile, catTitle, tempDir, idx }) {
  const dur = (await getAudioDuration(audioFile)) + 1;
  const titleFile = path.join(tempDir, `tf_intro_title.txt`);
  const subtitleFile = path.join(tempDir, `tf_intro_sub.txt`);
  await writeTextFile('¿QUÉ ES MÁS CARO?', titleFile);
  await writeTextFile(catTitle.toUpperCase(), subtitleFile);

  const silenceFile = path.join(tempDir, 'silence_intro.aac');
  await createSilence(dur, silenceFile);

  // For solid bg, we use a black image
  const outputFile = path.join(tempDir, `seg_${String(idx).padStart(3, '0')}.mp4`);

  const filterChain = `[0:v]setsar=1[bg];[bg]drawbox=x=0:y=0:w=iw:h=ih:color=0x0a0a1a:t=fill[c1];[c1]drawbox=x=160:y=380:w=1600:h=8:color=0xf5a623:t=fill[line];[line]${dt(titleFile, 90, 'white', '(w-text_w)/2', 220)}[t1];[t1]${dt(subtitleFile, 60, '0xf5a623', '(w-text_w)/2', 460)}[vout]`;

  await ffmpeg(
    `-f lavfi -t ${dur} -i "color=c=0x0a0a1a:size=1920x1080:rate=25" -i "${audioFile}" ` +
    `-filter_complex "${filterChain}" ` +
    `-map "[vout]" -map 1:a ` +
    `-c:v libx264 -preset fast -crf 23 -c:a aac -ar 44100 -ac 2 ` +
    `-pix_fmt yuv420p -shortest -t ${dur} "${outputFile}"`
  );
  return outputFile;
}

async function buildQuestionSegment({ question, imageFile, qNum, total, tempDir, idx }) {
  const audioDur = await getAudioDuration(question.audioQuestion);
  const dur = audioDur + 3; // 3s extra to read options

  const qNumFile = path.join(tempDir, `tf_${idx}_qnum.txt`);
  await writeTextFile(`Pregunta ${qNum} de ${total}`, qNumFile);

  const qLines = wrapText(question.text, 52);
  const qTextFiles = [];
  for (let i = 0; i < Math.min(qLines.length, 3); i++) {
    const f = path.join(tempDir, `tf_${idx}_qline${i}.txt`);
    await writeTextFile(qLines[i], f);
    qTextFiles.push(f);
  }

  const optFiles = [];
  for (let i = 0; i < 3; i++) {
    const opt = question.options[i];
    const f = path.join(tempDir, `tf_${idx}_opt${i}.txt`);
    await writeTextFile(`${opt.label}: ${opt.name}   ${opt.price}`, f);
    optFiles.push(f);
  }

  // Build filter chain
  const filters = [];
  filters.push(`drawbox=x=0:y=0:w=iw:h=80:color=black@0.6:t=fill`);
  filters.push(dt(qNumFile, 34, 'white@0.8', '(w-text_w)/2', 22));

  const qStartY = 110;
  qTextFiles.forEach((f, i) => {
    filters.push(dt(f, 52, 'white', '(w-text_w)/2', qStartY + i * 68));
  });

  // Options box
  const optBoxY = 380;
  filters.push(`drawbox=x=80:y=${optBoxY - 20}:w=1760:h=360:color=black@0.45:t=fill`);

  optFiles.forEach((f, i) => {
    filters.push(dt(f, 44, 'white', 150, optBoxY + i * 110));
  });

  const outputFile = path.join(tempDir, `seg_${String(idx).padStart(3, '0')}.mp4`);
  await createSegment({
    imageFile,
    audioFile: question.audioQuestion,
    duration: dur,
    filters,
    outputFile
  });
  return outputFile;
}

async function buildAnswerSegment({ question, imageFile, qNum, total, tempDir, idx }) {
  const audioDur = await getAudioDuration(question.audioAnswer);
  const dur = audioDur + 3;

  const ansHeaderFile = path.join(tempDir, `tf_${idx}_ansheader.txt`);
  await writeTextFile(`✓ Respuesta correcta`, ansHeaderFile);

  const qLines = wrapText(question.text, 52);
  const qTextFiles = [];
  for (let i = 0; i < Math.min(qLines.length, 2); i++) {
    const f = path.join(tempDir, `tf_${idx}_aqline${i}.txt`);
    await writeTextFile(qLines[i], f);
    qTextFiles.push(f);
  }

  const optFiles = [];
  const optColors = [];
  for (let i = 0; i < 3; i++) {
    const opt = question.options[i];
    const isCorrect = opt.label === question.correct;
    const f = path.join(tempDir, `tf_${idx}_aopt${i}.txt`);
    const prefix = isCorrect ? '✓ ' : '   ';
    await writeTextFile(`${prefix}${opt.label}: ${opt.name}   ${opt.price}`, f);
    optFiles.push(f);
    optColors.push(isCorrect ? '0x00dd44' : 'white@0.5');
  }

  const contextLines = wrapText(question.context, 60);
  const ctxFiles = [];
  for (let i = 0; i < Math.min(contextLines.length, 2); i++) {
    const f = path.join(tempDir, `tf_${idx}_ctx${i}.txt`);
    await writeTextFile(contextLines[i], f);
    ctxFiles.push(f);
  }

  const filters = [];
  filters.push(`drawbox=x=0:y=0:w=iw:h=80:color=0x004422@0.8:t=fill`);
  filters.push(dt(ansHeaderFile, 36, '0x00dd44', '(w-text_w)/2', 20));

  const qStartY = 100;
  qTextFiles.forEach((f, i) => {
    filters.push(dt(f, 42, 'white@0.8', '(w-text_w)/2', qStartY + i * 55));
  });

  const optBoxY = 310;
  filters.push(`drawbox=x=80:y=${optBoxY - 15}:w=1760:h=330:color=black@0.45:t=fill`);
  optFiles.forEach((f, i) => {
    filters.push(dt(f, 44, optColors[i], 120, optBoxY + i * 100));
  });

  if (ctxFiles.length > 0) {
    const ctxBoxY = 780;
    filters.push(`drawbox=x=0:y=${ctxBoxY - 15}:w=iw:h=${ctxFiles.length * 50 + 30}:color=black@0.5:t=fill`);
    ctxFiles.forEach((f, i) => {
      filters.push(dt(f, 32, 'white@0.9', '(w-text_w)/2', ctxBoxY + i * 50));
    });
  }

  const outputFile = path.join(tempDir, `seg_${String(idx).padStart(3, '0')}.mp4`);
  await createSegment({
    imageFile,
    audioFile: question.audioAnswer,
    duration: dur,
    filters,
    outputFile
  });
  return outputFile;
}

async function buildCTASegment({ audioFile, tempDir, idx }) {
  const dur = (await getAudioDuration(audioFile)) + 2;
  const line1File = path.join(tempDir, `tf_cta1.txt`);
  const line2File = path.join(tempDir, `tf_cta2.txt`);
  await writeTextFile('👍 ¡Dale LIKE al video!', line1File);
  await writeTextFile('🔔 Suscríbete para más quizzes de precios', line2File);

  const outputFile = path.join(tempDir, `seg_${String(idx).padStart(3, '0')}.mp4`);
  await ffmpeg(
    `-f lavfi -t ${dur} -i "color=c=0x0a0a1a:size=1920x1080:rate=25" -i "${audioFile}" ` +
    `-filter_complex "[0:v]setsar=1[bg];[bg]drawbox=x=0:y=0:w=iw:h=ih:color=0x1a0a0a:t=fill[c1];[c1]drawbox=x=160:y=530:w=1600:h=8:color=0xf5a623:t=fill[line];[line]${dt(line1File, 72, 'white', '(w-text_w)/2', 350)}[t1];[t1]${dt(line2File, 46, '0xf5a623', '(w-text_w)/2', 590)}[vout]" ` +
    `-map "[vout]" -map 1:a ` +
    `-c:v libx264 -preset fast -crf 23 -c:a aac -ar 44100 -ac 2 ` +
    `-pix_fmt yuv420p -shortest -t ${dur} "${outputFile}"`
  );
  return outputFile;
}

async function buildOutroSegment({ audioFile, catTitle, tempDir, idx }) {
  const dur = (await getAudioDuration(audioFile)) + 2;
  const line1File = path.join(tempDir, `tf_outro1.txt`);
  const line2File = path.join(tempDir, `tf_outro2.txt`);
  await writeTextFile(`¡Eso fue todo sobre ${catTitle}!`, line1File);
  await writeTextFile('Suscríbete y activa la campanita 🔔', line2File);

  const outputFile = path.join(tempDir, `seg_${String(idx).padStart(3, '0')}.mp4`);
  await ffmpeg(
    `-f lavfi -t ${dur} -i "color=c=0x0a0a1a:size=1920x1080:rate=25" -i "${audioFile}" ` +
    `-filter_complex "[0:v]setsar=1[bg];[bg]drawbox=x=0:y=0:w=iw:h=ih:color=0x0a0a1a:t=fill[c1];[c1]drawbox=x=160:y=530:w=1600:h=8:color=0xf5a623:t=fill[line];[line]${dt(line1File, 68, 'white', '(w-text_w)/2', 350)}[t1];[t1]${dt(line2File, 46, '0xf5a623', '(w-text_w)/2', 600)}[vout]" ` +
    `-map "[vout]" -map 1:a ` +
    `-c:v libx264 -preset fast -crf 23 -c:a aac -ar 44100 -ac 2 ` +
    `-pix_fmt yuv420p -shortest -t ${dur} "${outputFile}"`
  );
  return outputFile;
}

// ─── Main QMC Render ──────────────────────────────────────────────────────────

async function renderQMC({ catTitle, questions, urlAudioIntro, urlAudioCTA, urlAudioOutro }, videosDir, baseUrl) {
  const { v4: uuidv4 } = require('uuid');
  const jobId = uuidv4();
  const tempDir = path.join(__dirname, 'temp', jobId);
  const outputFile = path.join(videosDir, `${jobId}.mp4`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    console.log(`[QMC] Job ${jobId} started. ${questions.length} questions, category: ${catTitle}`);

    // 1. Download audio files
    console.log('[QMC] Downloading audio files...');
    const introAudio = path.join(tempDir, 'audio_intro.mp3');
    const ctaAudio   = path.join(tempDir, 'audio_cta.mp3');
    const outroAudio = path.join(tempDir, 'audio_outro.mp3');
    await Promise.all([
      download(urlAudioIntro, introAudio),
      download(urlAudioCTA,   ctaAudio),
      download(urlAudioOutro, outroAudio)
    ]);

    // 2. Download question assets (parallel, up to 5 at a time)
    console.log('[QMC] Downloading question assets...');
    const qAssets = [];
    for (let i = 0; i < questions.length; i += 5) {
      const batch = questions.slice(i, i + 5);
      const results = await Promise.all(batch.map(async (q, bIdx) => {
        const idx = i + bIdx;
        const imgFile = path.join(tempDir, `img_${idx}.jpg`);
        const qAudioFile = path.join(tempDir, `qaudio_${idx}.mp3`);
        const aAudioFile = path.join(tempDir, `aaudio_${idx}.mp3`);
        await Promise.all([
          download(q.URL_Imagen, imgFile).catch(() => null),
          download(q.URL_Audio_Pregunta, qAudioFile),
          download(q.URL_Audio_Respuesta, aAudioFile)
        ]);
        return {
          text: q.Pregunta,
          context: q.Contexto || '',
          correct: q.Respuesta_Correcta,
          options: [
            { label: 'A', name: q.Opcion_A, price: q.Precio_A },
            { label: 'B', name: q.Opcion_B, price: q.Precio_B },
            { label: 'C', name: q.Opcion_C, price: q.Precio_C }
          ],
          audioQuestion: qAudioFile,
          audioAnswer: aAudioFile,
          imageFile: fs.existsSync(imgFile) ? imgFile : null
        };
      }));
      qAssets.push(...results);
    }

    // 3. Build segments
    console.log('[QMC] Building video segments...');
    const segments = [];
    let segIdx = 0;

    // Intro
    segments.push(await buildIntroSegment({ audioFile: introAudio, catTitle, tempDir, idx: segIdx++ }));

    // Questions
    for (let i = 0; i < qAssets.length; i++) {
      const qa = qAssets[i];
      const qNum = i + 1;
      const total = qAssets.length;
      const imgFile = qa.imageFile;

      segments.push(await buildQuestionSegment({ question: qa, imageFile: imgFile, qNum, total, tempDir, idx: segIdx++ }));
      segments.push(await buildAnswerSegment({ question: qa, imageFile: imgFile, qNum, total, tempDir, idx: segIdx++ }));

      if (i === 9) {
        segments.push(await buildCTASegment({ audioFile: ctaAudio, tempDir, idx: segIdx++ }));
      }
      console.log(`[QMC] Question ${qNum}/${total} done`);
    }

    // Outro
    segments.push(await buildOutroSegment({ audioFile: outroAudio, catTitle, tempDir, idx: segIdx++ }));

    // 4. Concatenate
    console.log(`[QMC] Concatenating ${segments.length} segments...`);
    await concatenate(segments, outputFile);

    console.log(`[QMC] Job ${jobId} complete: ${outputFile}`);
    return { status: 'done', url: `${baseUrl}/videos/${jobId}.mp4` };

  } finally {
    fs.rm(tempDir, { recursive: true, force: true }, () => {});
  }
}

// ─── QUIZ Render ──────────────────────────────────────────────────────────────
// Same as QMC but different question structure (no prices) and has background music

async function renderQuiz({ temaTitle, canal, questions, urlAudioIntro, urlAudioCTA, urlAudioOutro, urlMusica }, videosDir, baseUrl) {
  const { v4: uuidv4 } = require('uuid');
  const jobId = uuidv4();
  const tempDir = path.join(__dirname, 'temp', jobId);
  const outputFile = path.join(videosDir, `${jobId}.mp4`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    console.log(`[QUIZ] Job ${jobId} started. ${questions.length} questions, tema: ${temaTitle}`);

    const introAudio = path.join(tempDir, 'audio_intro.mp3');
    const ctaAudio   = path.join(tempDir, 'audio_cta.mp3');
    const outroAudio = path.join(tempDir, 'audio_outro.mp3');
    await Promise.all([
      download(urlAudioIntro, introAudio),
      download(urlAudioCTA,   ctaAudio),
      download(urlAudioOutro, outroAudio)
    ]);

    const qAssets = [];
    for (let i = 0; i < questions.length; i += 5) {
      const batch = questions.slice(i, i + 5);
      const results = await Promise.all(batch.map(async (q, bIdx) => {
        const idx = i + bIdx;
        const imgFile = path.join(tempDir, `img_${idx}.jpg`);
        const qAudioFile = path.join(tempDir, `qaudio_${idx}.mp3`);
        const aAudioFile = path.join(tempDir, `aaudio_${idx}.mp3`);
        await Promise.all([
          q.URL_Imagen ? download(q.URL_Imagen, imgFile).catch(() => null) : Promise.resolve(),
          download(q.URL_Audio_Pregunta, qAudioFile),
          download(q.URL_Audio_Respuesta, aAudioFile)
        ]);
        return {
          text: q.Pregunta,
          context: q.Contexto || '',
          correct: q.Respuesta_Correcta,
          options: [
            { label: 'A', name: q.Opcion_A, price: q.Precio_A || '' },
            { label: 'B', name: q.Opcion_B, price: q.Precio_B || '' },
            { label: 'C', name: q.Opcion_C, price: q.Precio_C || '' }
          ],
          audioQuestion: qAudioFile,
          audioAnswer: aAudioFile,
          imageFile: fs.existsSync(imgFile) ? imgFile : null
        };
      }));
      qAssets.push(...results);
    }

    const segments = [];
    let segIdx = 0;

    segments.push(await buildIntroSegment({ audioFile: introAudio, catTitle: temaTitle, tempDir, idx: segIdx++ }));

    for (let i = 0; i < qAssets.length; i++) {
      const qa = qAssets[i];
      segments.push(await buildQuestionSegment({ question: qa, imageFile: qa.imageFile, qNum: i + 1, total: qAssets.length, tempDir, idx: segIdx++ }));
      segments.push(await buildAnswerSegment({ question: qa, imageFile: qa.imageFile, qNum: i + 1, total: qAssets.length, tempDir, idx: segIdx++ }));
      if (i === 9) {
        segments.push(await buildCTASegment({ audioFile: ctaAudio, tempDir, idx: segIdx++ }));
      }
      console.log(`[QUIZ] Question ${i + 1}/${qAssets.length} done`);
    }

    segments.push(await buildOutroSegment({ audioFile: outroAudio, catTitle: temaTitle, tempDir, idx: segIdx++ }));

    console.log(`[QUIZ] Concatenating ${segments.length} segments...`);
    await concatenate(segments, outputFile);

    console.log(`[QUIZ] Job ${jobId} complete`);
    return { status: 'done', url: `${baseUrl}/videos/${jobId}.mp4` };

  } finally {
    fs.rm(tempDir, { recursive: true, force: true }, () => {});
  }
}

module.exports = { renderQMC, renderQuiz };
