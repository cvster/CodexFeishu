import { defaultHttpInstance, type HttpInstance } from '@larksuiteoapi/node-sdk';
import { getLogContext, log } from '../core/logger';

const CARD_STREAM_PATH = /\/open-apis\/cardkit\/v1\/cards\/[^/]+\/elements\/[^/]+\/content(?:\?|$)/;
const CARD_STREAM_RETRY_DELAYS_MS = [300, 1_000, 2_000] as const;
const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNABORTED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ERR_NETWORK',
]);

export interface HttpRequestConfig {
  url?: string;
  method?: string;
  data?: unknown;
  [key: string]: unknown;
}

interface HttpFailure {
  code?: string | number;
  message?: string;
  response?: { status?: number };
}

interface RetryableHttpInstance {
  request<T = unknown, R = T>(opts: HttpRequestConfig): Promise<R>;
  [BRIDGE_WRAPPED]?: true;
}

interface LarkBusinessResponse {
  code?: unknown;
  msg?: unknown;
  message?: unknown;
}

export class LarkCardStreamBusinessError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(`Feishu CardKit stream failed (${code}): ${message}`);
    this.name = 'LarkCardStreamBusinessError';
    this.code = code;
  }
}

const BRIDGE_WRAPPED = Symbol.for('lark-channel-bridge.card-stream-retry');
const confirmedCardStreamContent = new Map<string, string>();

/**
 * Configure the Feishu SDK HTTP client to always connect directly.
 *
 * Axios reads HTTP_PROXY / HTTPS_PROXY by default. Merely disabling the
 * channel SDK's proxy support therefore is not sufficient: REST calls can
 * still be routed through a desktop proxy by Axios itself. We intentionally
 * reuse node-sdk's default instance because it carries required request and
 * response interceptors (payload formatting and token handling); a fresh
 * axios.create() instance silently breaks authentication.
 *
 * `proxy: false` disables environment-proxy lookup on this Feishu-only
 * instance while leaving process.env untouched for agent subprocesses.
 */
export function createDirectLarkHttpInstance(timeoutMs: number): HttpInstance {
  defaultHttpInstance.defaults.timeout = timeoutMs;
  defaultHttpInstance.defaults.proxy = false;
  delete defaultHttpInstance.defaults.httpAgent;
  delete defaultHttpInstance.defaults.httpsAgent;
  installCardStreamRetry(defaultHttpInstance as unknown as RetryableHttpInstance);
  return defaultHttpInstance;
}

export function getConfirmedCardStreamContent(traceId: string): string | undefined {
  return confirmedCardStreamContent.get(traceId);
}

export function clearCardStreamProgress(traceId: string): void {
  confirmedCardStreamContent.delete(traceId);
}

export function isCardStreamRequest(config: HttpRequestConfig | undefined): boolean {
  return Boolean(
    config?.method?.toUpperCase() === 'PUT' &&
      typeof config.url === 'string' &&
      CARD_STREAM_PATH.test(config.url),
  );
}

export function isRetryableCardStreamFailure(error: HttpFailure): boolean {
  if (error instanceof LarkCardStreamBusinessError || typeof error.code === 'number') return false;
  const status = error.response?.status;
  if (status !== undefined) return RETRYABLE_HTTP_STATUS.has(status);
  if (error.code && RETRYABLE_NETWORK_CODES.has(error.code)) return true;
  const message = error.message?.toUpperCase() ?? '';
  return (
    message.includes('ECONNRESET') ||
    message.includes('SOCKET HANG UP') ||
    message.includes('ETIMEDOUT') ||
    message.includes('TIMEOUT')
  );
}

function installCardStreamRetry(client: RetryableHttpInstance): void {
  if (client[BRIDGE_WRAPPED]) return;
  client[BRIDGE_WRAPPED] = true;
  const originalRequest = client.request.bind(client);

  client.request = async <T = unknown, R = T>(config: HttpRequestConfig): Promise<R> => {
    return requestCardStreamWithRetry(
      config,
      (requestConfig) => originalRequest<T, R>(requestConfig),
    );
  };
}

export async function requestCardStreamWithRetry<R>(
  config: HttpRequestConfig,
  request: (config: HttpRequestConfig) => Promise<R>,
  wait: (ms: number) => Promise<void> = delay,
): Promise<R> {
  if (!isCardStreamRequest(config)) return request(config);

  const traceId = getLogContext()?.traceId;
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await request(config);
      assertSuccessfulBusinessResponse(result);
      const content = cardStreamContent(config.data);
      if (traceId && content !== undefined) confirmedCardStreamContent.set(traceId, content);
      return result;
    } catch (error) {
      const failure = error as HttpFailure;
      const delayMs = CARD_STREAM_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !isRetryableCardStreamFailure(failure)) throw error;
      log.warn('lark-http', 'card-stream-retry', {
        attempt: attempt + 1,
        delayMs,
        code: failure.code,
        status: failure.response?.status,
        err: failure.message,
      });
      await wait(delayMs);
    }
  }
}

function assertSuccessfulBusinessResponse(result: unknown): void {
  if (!result || typeof result !== 'object') return;
  const response = result as LarkBusinessResponse;
  if (typeof response.code !== 'number' || response.code === 0) return;
  const message =
    typeof response.msg === 'string'
      ? response.msg
      : typeof response.message === 'string'
        ? response.message
        : 'unknown CardKit business error';
  throw new LarkCardStreamBusinessError(response.code, message);
}

function cardStreamContent(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const content = (data as { content?: unknown }).content;
  return typeof content === 'string' ? content : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
