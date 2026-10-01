import { describe, expect, it, vi } from 'vitest';
import { refreshLiveRunCard, registerLiveRunCardRefresh } from '../../../src/card/run-refresh';

describe('live reply refresh', () => {
  it('refreshes the exact live message through its controller without sending', async () => {
    const refresh = vi.fn(async () => {});
    const remove = registerLiveRunCardRefresh('om_live', 'oc_group', refresh);
    try {
      expect(await refreshLiveRunCard('om_live', 'oc_other')).toBe(false);
      expect(await refreshLiveRunCard('om_other', 'oc_group')).toBe(false);
      expect(await refreshLiveRunCard('om_live', 'oc_group')).toBe(true);
      expect(refresh).toHaveBeenCalledOnce();
    } finally { remove(); }
    expect(await refreshLiveRunCard('om_live', 'oc_group')).toBe(false);
  });

  it('does not remove a newer registered controller during old cleanup', async () => {
    const old = registerLiveRunCardRefresh('om_replace', 'oc_group', async () => {});
    const refresh = vi.fn(async () => {});
    const remove = registerLiveRunCardRefresh('om_replace', 'oc_group', refresh);
    old();
    try {
      expect(await refreshLiveRunCard('om_replace', 'oc_group')).toBe(true);
      expect(refresh).toHaveBeenCalledOnce();
    } finally { remove(); }
  });

  it('propagates delivery errors without falling back to a new message', async () => {
    const remove = registerLiveRunCardRefresh('om_error', 'oc_group', async () => { throw new Error('offline'); });
    try { await expect(refreshLiveRunCard('om_error', 'oc_group')).rejects.toThrow('offline'); }
    finally { remove(); }
  });
});
