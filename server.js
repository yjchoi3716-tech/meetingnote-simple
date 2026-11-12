import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI, createPartFromUri, FileState } from '@google/genai';
import { sleep, withRetry } from './retry.js';

const { GEMINI_API_KEY, GEMINI_MODEL = 'gemini-3.1-flash-lite', PORT = 3000 } = process.env;

if (!GEMINI_API_KEY) {
  console.error('[오류] .env 파일에 GEMINI_API_KEY 를 입력하세요.');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));

const NOTES_DIR = path.resolve('data', 'notes');
await mkdir(NOTES_DIR, { recursive: true });

// 인라인 요청 한도(20MB)를 넘는 오디오는 Files API 로 업로드
const INLINE_LIMIT = 15 * 1024 * 1024;

// ───────────────────────── Gemini ─────────────────────────
const TRANSCRIBE_PROMPT = `다음 회의 녹음을 한국어로 정확하게 받아써 주세요.
- 들리는 그대로 받아쓰고, 내용을 요약하거나 생략하지 마세요.
- 화자가 바뀌면 줄을 바꾸고 "화자 1:", "화자 2:" 처럼 구분하세요.
- 알아들을 수 없는 부분은 [불명확] 으로 표시하세요.
- 받아쓴 텍스트만 출력하세요.`;

const SUMMARY_PROMPT = `아래 회의 받아쓰기를 회의록으로 정리해 주세요.
- title: 회의 내용을 나타내는 짧은 제목
- summary: 회의 핵심 요약 (3~5문장)
- decisions: 회의에서 확정된 결정 사항. 보류·검토만 한 것은 넣지 마세요.
- actions: 할 일. 담당자(owner)와 기한(due)은 언급된 경우만, 없으면 빈 문자열.
- 잡담 등 회의와 무관한 내용은 제외하고, 받아쓰기에 없는 내용은 지어내지 마세요.

--- 받아쓰기 ---
`;

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    decisions: { type: 'array', items: { type: 'string' } },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { owner: { type: 'string' }, task: { type: 'string' }, due: { type: 'string' } },
        required: ['owner', 'task', 'due'],
      },
    },
  },
  required: ['title', 'summary', 'decisions', 'actions'],
};

async function audioPart(file) {
  const mimeType = (file.mimetype || 'audio/webm').split(';')[0];
  if (file.size <= INLINE_LIMIT) {
    return { inlineData: { mimeType, data: file.buffer.toString('base64') } };
  }
  let uploaded = await ai.files.upload({
    file: new Blob([file.buffer], { type: mimeType }),
    config: { mimeType },
  });
  while (uploaded.state === FileState.PROCESSING) {
    await sleep(2000);
    uploaded = await ai.files.get({ name: uploaded.name });
  }
  if (uploaded.state === FileState.FAILED) throw new Error('오디오 파일 처리에 실패했습니다.');
  return createPartFromUri(uploaded.uri, uploaded.mimeType);
}

const sendError = (res, err) => {
  console.error(err);
  res.status(500).json({ error: err.message });
};

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '오디오 파일이 없습니다.' });
    const transcript = await withRetry('받아쓰기', async () => {
      const part = await audioPart(req.file);
      const result = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: 'user', parts: [part, { text: TRANSCRIBE_PROMPT }] }],
      });
      const text = result.text?.trim();
      if (!text) throw new Error('받아쓰기 결과가 비어 있습니다.'); // 빈 응답도 재시도
      return text;
    });
    res.json({ transcript });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/summarize', async (req, res) => {
  try {
    const transcript = req.body?.transcript?.trim();
    if (!transcript) return res.status(400).json({ error: '받아쓰기 내용이 없습니다.' });
    const note = await withRetry('정리', async () => {
      const result = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: SUMMARY_PROMPT + transcript,
        config: { responseMimeType: 'application/json', responseJsonSchema: SUMMARY_SCHEMA },
      });
      return JSON.parse(result.text);
    });
    res.json(note);
  } catch (err) {
    sendError(res, err);
  }
});

// ───────────────────────── 회의록 저장소 ─────────────────────────
// data/notes/<uuid>.json 파일 하나가 회의록 하나
const UUID_RE = /^[0-9a-f-]{36}$/;
const notePath = (id) => path.join(NOTES_DIR, `${id}.json`);

function validId(req, res) {
  if (UUID_RE.test(req.params.id)) return true;
  res.status(400).json({ error: '잘못된 ID 입니다.' });
  return false;
}

app.get('/api/notes', async (_req, res) => {
  try {
    const files = (await readdir(NOTES_DIR)).filter((f) => f.endsWith('.json'));
    const notes = await Promise.all(
      files.map(async (f) => {
        const { id, title, createdAt } = JSON.parse(await readFile(path.join(NOTES_DIR, f), 'utf8'));
        return { id, title, createdAt };
      }),
    );
    notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json(notes);
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/notes/:id', async (req, res) => {
  if (!validId(req, res)) return;
  try {
    res.type('json').send(await readFile(notePath(req.params.id), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: '회의록을 찾을 수 없습니다.' });
    sendError(res, err);
  }
});

app.post('/api/notes', async (req, res) => {
  try {
    const { title, summary, decisions, actions, transcript, fileName } = req.body ?? {};
    if (!summary && !transcript) return res.status(400).json({ error: '저장할 내용이 없습니다.' });
    const note = {
      id: randomUUID(),
      title: title?.trim() || '제목 없는 회의',
      createdAt: new Date().toISOString(),
      fileName: fileName ?? '',
      summary: summary ?? '',
      decisions: Array.isArray(decisions) ? decisions : [],
      actions: Array.isArray(actions) ? actions : [],
      transcript: transcript ?? '',
    };
    await writeFile(notePath(note.id), JSON.stringify(note, null, 2), 'utf8');
    res.status(201).json(note);
  } catch (err) {
    sendError(res, err);
  }
});

app.delete('/api/notes/:id', async (req, res) => {
  if (!validId(req, res)) return;
  try {
    await rm(notePath(req.params.id));
    res.status(204).end();
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: '회의록을 찾을 수 없습니다.' });
    sendError(res, err);
  }
});

app.listen(PORT, (err) => {
  if (err) {
    console.error(err.code === 'EADDRINUSE'
      ? `[오류] ${PORT} 포트를 이미 다른 프로그램(이전에 실행한 서버 등)이 쓰고 있습니다. 그 프로그램을 끄거나 .env 의 PORT 를 바꿔주세요.`
      : `[오류] 서버 시작 실패: ${err.message}`);
    process.exit(1);
  }
  console.log(`미팅노트 실행 중: http://localhost:${PORT}  (모델: ${GEMINI_MODEL})`);
});
