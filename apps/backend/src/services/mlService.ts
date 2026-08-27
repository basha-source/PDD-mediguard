import axios from "axios";
import { ENV } from "../config/env";

/**
 * Client for the MediGuard ML service (apps/ml-service).
 *
 * It owns /ocr and /ask. The response shapes are frozen to what those routes
 * have always returned, so callers forward its body unchanged and the mobile
 * app needs no migration.
 *
 * It is hosted on a free tier that sleeps when idle, so the first request after
 * a quiet period can take ~30s to wake the container. That is why the timeouts
 * are generous and why a timed-out or 502/503 request is retried once: the
 * retry usually lands on a container that is now awake.
 */

const COLD_START_RETRIES = 1;
const RETRY_DELAY_MS = 3000;

/**
 * Per-attempt budget for /ask.
 *
 * The chat screen aborts its own fetch at 60s, and that abort must never fire
 * before the backend has finished trying — otherwise the user is shown a
 * "timed out" message while the real failure (service down, index missing) is
 * still on its way and never reaches them.
 *
 * Worst case here is attempt + delay + attempt = 25 + 3 + 25 = 53s, which
 * leaves ~7s of headroom under the client's 60s for the phone's own network
 * latency. 25s per attempt is still comfortably more than a warm answer needs,
 * and the retry lands at t=28s — by which point a cold container is awake.
 */
const ASK_TIMEOUT_MS = 25_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isColdStart(err: any): boolean {
  const status = err?.response?.status;
  return (
    err?.code === "ECONNABORTED" ||   // our own timeout
    err?.code === "ECONNREFUSED" ||
    err?.code === "ECONNRESET" ||
    status === 502 || status === 503 || status === 504
  );
}

async function post<T>(path: string, body: unknown, timeout: number): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= COLD_START_RETRIES; attempt++) {
    try {
      const { data } = await axios.post<T>(`${ENV.ML_SERVICE_URL}${path}`, body, { timeout });
      return data;
    } catch (err: any) {
      lastError = err;
      const detail = err?.response?.data?.error ?? err?.message ?? "unknown";
      console.error(`[ML] ${path} attempt ${attempt + 1} failed: ${detail}`);
      if (attempt === COLD_START_RETRIES || !isColdStart(err)) break;
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

export type OcrMode = "expiry" | "packaging" | "prescription";

/** Images are large and OCR is the slowest path, so it gets the longest budget. */
export const ocr = (image: string, mode: OcrMode) =>
  post<Record<string, unknown>>("/ocr", { image, mode }, 60_000);

export const ask = (question: string) =>
  post<{ answer: string }>("/ask", { question }, ASK_TIMEOUT_MS);

/** Used by the keep-alive ping and /health. */
export async function health(): Promise<{ ok: boolean; detail?: unknown }> {
  try {
    const { data } = await axios.get(`${ENV.ML_SERVICE_URL}/health`, { timeout: 10_000 });
    return { ok: true, detail: data };
  } catch (err: any) {
    return { ok: false, detail: err?.message ?? "unreachable" };
  }
}
