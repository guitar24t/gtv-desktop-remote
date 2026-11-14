import { ClassicRemote } from './ClassicRemote';
import { ShieldRemote } from './ShieldRemote';
import type { RemoteSkin, RemoteSkinId } from './types';

export type { RemoteSkin, RemoteSkinId, RemoteSkinProps } from './types';

const CLASSIC_SKIN: RemoteSkin = {
  id: 'classic',
  name: 'Classic',
  description: 'The original GTV Remote layout.',
  layout: 'standard',
  fullWindow: false,
  Component: ClassicRemote,
};

/** Every remote skin, in the order Settings lists them. Add new skins here. */
export const REMOTE_SKINS: readonly RemoteSkin[] = [
  CLASSIC_SKIN,
  {
    id: 'shield',
    name: 'SHIELD',
    description:
      'A slim black remote laid out like the NVIDIA SHIELD TV remote. The window takes the shape of the remote.',
    layout: 'shield',
    fullWindow: true,
    Component: ShieldRemote,
  },
];

export const DEFAULT_SKIN_ID: RemoteSkinId = 'classic';
export const SKIN_STORAGE_KEY = 'gtv-remote.skin';

export function isRemoteSkinId(value: unknown): value is RemoteSkinId {
  return REMOTE_SKINS.some((skin) => skin.id === value);
}

export function getRemoteSkin(id: RemoteSkinId): RemoteSkin {
  return REMOTE_SKINS.find((skin) => skin.id === id) ?? CLASSIC_SKIN;
}

/** The saved skin, or the default when nothing valid is stored or storage is unavailable. */
export function loadSkinId(): RemoteSkinId {
  try {
    const saved = window.localStorage.getItem(SKIN_STORAGE_KEY);
    return isRemoteSkinId(saved) ? saved : DEFAULT_SKIN_ID;
  } catch {
    return DEFAULT_SKIN_ID;
  }
}

export function saveSkinId(id: RemoteSkinId): void {
  try {
    window.localStorage.setItem(SKIN_STORAGE_KEY, id);
  } catch {
    // Storage can be unavailable; the choice still applies for this session.
  }
}
