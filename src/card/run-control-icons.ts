import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';
import { RUN_BUTTON_IMAGES, type RunButtonAction } from './run-button-images';

// Rasterized at 4x from a 24px vector: three circular Git nodes, with a
// single lower stem branching into two upper arms. Blue is Feishu #3370FF.
// Keep this inline so packaged deployments need no extra asset paths or
// image-rendering dependency. Image keys are scoped to the uploading app.
const GIT_FORK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAACXBIWXMAAAsTAAALEwEAmpwYAAAFOklEQVR4nO2cy49URRTGK0HRQHwiC3zEDdEEHZuuc7tD3LBWFPEx/8Lo0HZX3ZkY2E1Ao2tDYsTHxo2IcaeyNjEGE+JSwQX42hAx6KgLxMlnTnUbpU3furf7dnedsn5JJZPpqenv1KnHqap7j1KJRCKRSCQSiUQiMQHZCu6hHp4ng1Pa4iwZ/MZl8DP/rsN/E2ojZ1L1N3LcRQbHtcFVskBhMdggi5PNVdyrAkG0fjI4QBa/eoUPFW2wnhnsT/onQFuYQY+o1PhDvak7LyeI1u96/iTi/2VENoeRIFp/u4u7x5l2Rk5HFr80O7gz6S+Jtni7rsanf8obs3KAaP0chmmLP+s2QBtc5Wgk6ffg4mT/vPgVz7EPv4Cb2l3crHM86WJpnxNyHJy2A6Tr58XrlE98w+DW4XoLy7hNG5zz1P0w6fdQohEPjKrbNHjK5zw1ZaTrZwPWi0TwkB1Vlz/zrAPrSf8UHUCHcItkB1AA+r1DmBesUXWzHp4urGtxNun3OcDiY18j8oI7XG9PjtvJ4ut5L8JauH42oFMooj8Uz/GCxcOZy6DnF4u3zoDlpL/EMYTkjVhbuH4HGbxZuwEWr89EfAT63QWGL5qoVAx+JosdSX8FMoNHahnKBhtNi8dn1fix6HfwZcSkFxraojMX8RHod7D3x5qO+tPOvrmKj0C/Y3cX28ni1bKX2trgnVnO+bHrv/bpAo8BMwvV/of6HT4DVOCQcP3iDSDh+sUbQML1izeAhOvnbf6VIgN2rWGzCpSdXdzgiYCuqNDRBj8VGcHHuipQaAV3FGnXFpdU6JDBN0VGtCweUIGS9fCgxwHnVehog0/HvTGbN2TxjGcN+ESFjrZ4y9OLXlKBQgaveNaA4yp0KMeqpxd9pgJFG3zu0Z6r0NE59nh60QbfSqnAaPAdh+d4ummRqdDZu4br+GlnjxMOqcAgi8Oe3n95cRGblATI4oPCdcDgu5D2Azs5/jf4weOAk0oKg9eWCneUZPGcCoQyT3qE8DpVabh386bFMw392OpgWwibL9/mkbXSEq5XktAWL/p6lTZ4d946yeJEidF6REnDbev5PVufcQbPzk2jwXKJTrIe8vFJIWTxcone9Qf18OgctO0reQV5VEnloVVsJYtvSzjh91k6gRvffadf1wVawhYlGbJ4ooShcCNhBtMRTzulej5PPz08pmKALF4r6QTwwszrx5SOmk+U1mFxTMXC3jXcqA2+qGD8JX7hrY7NGm+yOM73hprXljNcT8XEICFG4V0B/dcR3/MRwThnRy7zCR8v+He4w995PshnfuogM7ifDC5WaRDqRyL8+OBpjqrcuwY5Fjg05BHCxb08kWPBfdY/Uj491iOHBhdbK7hPxYxzAkcXVRvHTrdwz4++8f+G80JUWRNo+uVMtNNO0cJMFaKjKfb8Y9EtuFXIDPZXXZxrKheiifMnhZawhe+K60yBM7LH86PoBkfF73CnQauDba5x+Pi37sbv/88jYg/WZsmuNWzmIwxt8P7gRYhxG/4yGbzH01xIN3CiWFzEJsrRJoMVTopUotH5b/Ksh5aYO1wpZP3dbaEDgszrKZ2G5Lye0iHheUlFoyXn9ZQOSc7rKZ228Lyk4tGS83pKJxOel1Q8JD2vp3RIeF5S8WjpeT2lo4XnJRWPlp7XUzpaeF5S8WjpeT2lo4XnJRVPO4a8ntIh6Xk9pdMQnpc0CrIY8npKh2LI6ymdZgx5PaWzO5a8nlEszjkOaoOP3JF0/9aMy5e8yeI4P4WaiUQikUgkEolEQgXOX7dCwVkFa7qXAAAAAElFTkSuQmCC';

export interface RunControlIcons {
  forkIconKey?: string;
  buttonImageKeys?: Partial<Record<RunButtonAction, string>>;
}

export function gitForkIconPng(): Buffer {
  return Buffer.from(GIT_FORK_PNG_BASE64, 'base64');
}

export async function prepareRunControlIcons(options: {
  appId: string;
  cachePath: string;
  upload(png: Buffer): Promise<string>;
}): Promise<RunControlIcons> {
  const png = gitForkIconPng();
  const digest = createHash('sha256').update(png).update(JSON.stringify(RUN_BUTTON_IMAGES)).digest('hex');
  try {
    const cached = JSON.parse(await readFile(options.cachePath, 'utf8')) as {
      appId?: string; digest?: string; forkIconKey?: string;
      buttonImageKeys?: Partial<Record<RunButtonAction, string>>;
    };
    if (cached.appId === options.appId && cached.digest === digest &&
      typeof cached.forkIconKey === 'string' && cached.forkIconKey.trim() &&
      Object.keys(RUN_BUTTON_IMAGES).every((key) =>
        typeof cached.buttonImageKeys?.[key as RunButtonAction] === 'string' &&
        cached.buttonImageKeys[key as RunButtonAction]?.trim())) {
      return { forkIconKey: cached.forkIconKey, buttonImageKeys: cached.buttonImageKeys };
    }
  } catch {
    // Missing/invalid caches are replaced after a successful upload.
  }
  const forkIconKey = await options.upload(png);
  if (!forkIconKey.trim()) throw new Error('Git fork icon upload returned no image key');
  const buttonImageKeys: Partial<Record<RunButtonAction, string>> = {};
  for (const [action, base64] of Object.entries(RUN_BUTTON_IMAGES)) {
    const key = await options.upload(Buffer.from(base64, 'base64'));
    if (!key.trim()) throw new Error(`Control image upload returned no key: ${action}`);
    buttonImageKeys[action as RunButtonAction] = key;
  }
  await writeFileAtomic(options.cachePath,
    `${JSON.stringify({ appId: options.appId, digest, forkIconKey, buttonImageKeys })}\n`);
  return { forkIconKey, buttonImageKeys };
}
