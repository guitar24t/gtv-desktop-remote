import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SKIN_ID,
  getRemoteSkin,
  isRemoteSkinId,
  loadSkinId,
  REMOTE_SKINS,
  saveSkinId,
  SKIN_STORAGE_KEY,
} from '..';

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('remote skin registry', () => {
  it('lists Classic first as the default and SHIELD as a full-window skin', () => {
    expect(REMOTE_SKINS.map((skin) => skin.id)).toEqual(['classic', 'shield']);
    expect(DEFAULT_SKIN_ID).toBe('classic');
    expect(getRemoteSkin('classic')).toMatchObject({ layout: 'standard', fullWindow: false });
    expect(getRemoteSkin('shield')).toMatchObject({ layout: 'shield', fullWindow: true });
  });

  it('recognises only registered skin ids', () => {
    expect(isRemoteSkinId('shield')).toBe(true);
    expect(isRemoteSkinId('nope')).toBe(false);
    expect(isRemoteSkinId(undefined)).toBe(false);
  });

  it('loads the saved skin and falls back to the default for unknown values', () => {
    expect(loadSkinId()).toBe('classic');
    saveSkinId('shield');
    expect(window.localStorage.getItem(SKIN_STORAGE_KEY)).toBe('shield');
    expect(loadSkinId()).toBe('shield');
    window.localStorage.setItem(SKIN_STORAGE_KEY, 'removed-skin');
    expect(loadSkinId()).toBe('classic');
  });

  it('survives unavailable storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(loadSkinId()).toBe('classic');
    expect(() => {
      saveSkinId('shield');
    }).not.toThrow();
  });
});
