import { afterEach, describe, expect, it } from 'vitest';
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import {
  createDirectLarkHttpInstance,
  isCardStreamRequest,
  isRetryableCardStreamFailure,
  requestCardStreamWithRetry,
} from '../../../src/platform/lark-http';

const ORIGINAL_PROXY_ENV = {
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  http_proxy: process.env.http_proxy,
  https_proxy: process.env.https_proxy,
};

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_PROXY_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('createDirectLarkHttpInstance', () => {
  it('disables Axios proxy environment handling for Feishu only', () => {
    process.env.HTTP_PROXY = 'http://127.0.0.1:7897';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7897';

    const client = createDirectLarkHttpInstance(30_000);

    expect(client).toBe(defaultHttpInstance);
    expect(defaultHttpInstance.defaults.proxy).toBe(false);
    expect(defaultHttpInstance.defaults.timeout).toBe(30_000);
    expect(process.env.HTTP_PROXY).toBe('http://127.0.0.1:7897');
    expect(process.env.HTTPS_PROXY).toBe('http://127.0.0.1:7897');
  });

  it('recognizes only the idempotent CardKit stream PUT endpoint', () => {
    expect(isCardStreamRequest({
      method: 'PUT',
      url: 'https://open.feishu.cn/open-apis/cardkit/v1/cards/card-1/elements/stream_md/content',
    })).toBe(true);
    expect(isCardStreamRequest({
      method: 'POST',
      url: 'https://open.feishu.cn/open-apis/im/v1/messages',
    })).toBe(false);
  });

  it('retries transient stream failures with the exact same request', async () => {
    const config = {
      method: 'PUT',
      url: 'https://open.feishu.cn/open-apis/cardkit/v1/cards/card-1/elements/stream_md/content',
      data: { content: 'answer', sequence: 7, uuid: 'c_card-1_7' },
    };
    const seen: unknown[] = [];
    const waits: number[] = [];
    let calls = 0;

    const result = await requestCardStreamWithRetry(
      config,
      async (received) => {
        seen.push(received);
        calls++;
        if (calls < 3) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
        return 'ok';
      },
      async (ms) => { waits.push(ms); },
    );

    expect(result).toBe('ok');
    expect(seen).toEqual([config, config, config]);
    expect(waits).toEqual([300, 1_000]);
  });

  it('does not retry non-transient business errors', async () => {
    expect(isRetryableCardStreamFailure({ response: { status: 400 } })).toBe(false);
    expect(isRetryableCardStreamFailure({ response: { status: 503 } })).toBe(true);
  });

  it('rejects a resolved non-zero CardKit business response', async () => {
    const config = {
      method: 'PUT',
      url: 'https://open.feishu.cn/open-apis/cardkit/v1/cards/card-1/elements/stream_md/content',
      data: { content: 'answer', sequence: 8, uuid: 'c_card-1_8' },
    };

    await expect(
      requestCardStreamWithRetry(config, async () => ({
        code: 200850,
        msg: 'Card streaming timeout',
      })),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'LarkCardStreamBusinessError',
        code: 200850,
      }),
    );
  });
});
