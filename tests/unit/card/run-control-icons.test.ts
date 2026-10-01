import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gitForkIconPng, prepareRunControlIcons } from '../../../src/card/run-control-icons';
import { RUN_BUTTON_IMAGES } from '../../../src/card/run-button-images';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function cachePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'run-icons-'));
  directories.push(dir);
  return join(dir, 'icons.json');
}

describe('app-scoped Git fork icon cache', () => {
  it('contains a transparent 96px PNG suitable for high-density icon display', () => {
    const png = gitForkIconPng();
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.readUInt32BE(16)).toBe(96);
    expect(png.readUInt32BE(20)).toBe(96);
    expect(png[25]).toBe(6); // RGBA, not an opaque background.
  });

  it('contains five transparent 128px framed button images', () => {
    expect(Object.keys(RUN_BUTTON_IMAGES)).toEqual(['stop', 'config', 'refresh', 'fork', 'finish']);
    for (const base64 of Object.values(RUN_BUTTON_IMAGES)) {
      const png = Buffer.from(base64, 'base64');
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(png.readUInt32BE(16)).toBe(128);
      expect(png.readUInt32BE(20)).toBe(128);
      expect(png[25]).toBe(6);
    }
  });

  it('uploads each asset once and reuses keys only for the same app and assets', async () => {
    const path = await cachePath();
    const upload = vi.fn(async () => 'img_app_a');
    expect(await prepareRunControlIcons({ appId: 'app-a', cachePath: path, upload }))
      .toEqual(expectedIcons('img_app_a'));
    expect(await prepareRunControlIcons({ appId: 'app-a', cachePath: path, upload }))
      .toEqual(expectedIcons('img_app_a'));
    expect(upload).toHaveBeenCalledTimes(6);
    expect(upload).toHaveBeenCalledWith(gitForkIconPng());
    const otherUpload = vi.fn(async () => 'img_app_b');
    expect(await prepareRunControlIcons({ appId: 'app-b', cachePath: path, upload: otherUpload }))
      .toEqual(expectedIcons('img_app_b'));
    expect(otherUpload).toHaveBeenCalledTimes(6);
  });

  it('reuploads when an asset changes or a cache is malformed', async () => {
    const path = await cachePath();
    const upload = vi.fn(async () => 'img_current');
    await writeFile(path, JSON.stringify({ appId: 'app-a', digest: 'old', forkIconKey: 'img_old' }));
    await prepareRunControlIcons({ appId: 'app-a', cachePath: path, upload });
    await writeFile(path, '{invalid');
    await prepareRunControlIcons({ appId: 'app-a', cachePath: path, upload });
    expect(upload).toHaveBeenCalledTimes(12);
  });

  it('does not replace a cache with an empty or failed upload', async () => {
    const path = await cachePath();
    await writeFile(path, 'old cache');
    await expect(prepareRunControlIcons({ appId: 'app-a', cachePath: path, upload: async () => '' }))
      .rejects.toThrow('no image key');
    await expect(prepareRunControlIcons({
      appId: 'app-a', cachePath: path, upload: async () => { throw new Error('upload failed'); },
    })).rejects.toThrow('upload failed');
    expect(await readFile(path, 'utf8')).toBe('old cache');
  });

  it('preserves the previous cache if a later button upload fails', async () => {
    const path = await cachePath();
    await writeFile(path, 'old cache');
    const upload = vi.fn(async () => 'img_ok').mockImplementationOnce(async () => 'img_fork')
      .mockImplementationOnce(async () => { throw new Error('button upload failed'); });
    await expect(prepareRunControlIcons({ appId: 'app-a', cachePath: path, upload }))
      .rejects.toThrow('button upload failed');
    expect(await readFile(path, 'utf8')).toBe('old cache');
  });
});

function expectedIcons(key: string) {
  return { forkIconKey: key, buttonImageKeys: Object.fromEntries(Object.keys(RUN_BUTTON_IMAGES).map((action) => [action, key])) };
}
