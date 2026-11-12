import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { GoogleGenAI, createPartFromUri, FileState } from '@google/genai';

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

// 인라인 요청 한도(20MB)를 넘는 오디오는 Files API 로 업로드
const INLINE_LIMIT = 15 * 1024 * 1024;

const TRANSCRIBE_PROMPT = `다음 회의 녹음을 한국어로 정확하게 받아써 주세요.
- 들리는 그대로 받아쓰고, 내용을 요약하거나 생략하지 마세요.
- 화자가 바뀌면 줄을 바꾸고 "화자 1:", "화자 2:" 처럼 구분하세요.
- 알아들을 수 없는 부분은 [불명확] 으로 표시하세요.
- 받아쓴 텍스트만 출력하세요.`;

const SUMMARY_PROMPT = `아래 회의 받아쓰기 내용을 바탕으로 회의록을 Markdown 으로 정리해 주세요.

형식:
## 회의 요약
(3~5줄 핵심 요약)

## 주요 논의 사항
- 항목별 정리

## 결정 사항
- 결정된 내용 (없으면 "없음")

## 할 일 (Action Items)
- [ ] 담당자 — 할 일 — 기한 (언급된 경우만)

받아쓰기에 없는 내용은 지어내지 마세요.

--- 받아쓰기 ---
`;

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
    await new Promise((r) => setTimeout(r, 2000));
    uploaded = await ai.files.get({ name: uploaded.name });
  }
  if (uploaded.state === FileState.FAILED) throw new Error('오디오 파일 처리에 실패했습니다.');
  return createPartFromUri(uploaded.uri, uploaded.mimeType);
}

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '오디오 파일이 없습니다.' });
    const part = await audioPart(req.file);
    const result = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [{ role: 'user', parts: [part, { text: TRANSCRIBE_PROMPT }] }],
    });
    res.json({ transcript: result.text?.trim() ?? '' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/summarize', async (req, res) => {
  try {
    const transcript = req.body?.transcript?.trim();
    if (!transcript) return res.status(400).json({ error: '받아쓰기 내용이 없습니다.' });
    const result = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: SUMMARY_PROMPT + transcript,
    });
    res.json({ summary: result.text?.trim() ?? '' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`미팅노트 실행 중: http://localhost:${PORT}  (모델: ${GEMINI_MODEL})`);
});
