// 일시적 오류(요청 과다·서버 오류·네트워크)만 재시도. 키 오류 같은 4xx 는 바로 실패.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
export const RETRY_DELAYS_MS = [2000, 5000, 10000]; // 최초 시도 + 3회 재시도

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isRetryable(err) {
  if (typeof err?.status === 'number') return RETRYABLE_STATUS.has(err.status);
  return true; // status 없음 = 네트워크/타임아웃/빈 응답 등
}

export async function withRetry(label, fn, delays = RETRY_DELAYS_MS) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const delay = delays[attempt];
      if (delay === undefined || !isRetryable(err)) throw err;
      console.warn(`[${label}] 실패 (${err.status ?? err.message}) → ${delay / 1000}초 후 재시도 ${attempt + 1}/${delays.length}`);
      await sleep(delay);
    }
  }
}
