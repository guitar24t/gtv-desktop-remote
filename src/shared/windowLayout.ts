/**
 * Window sizes the renderer may ask for. The remote view of a shaped skin
 * (e.g. SHIELD) uses a narrow window that matches the remote's outline; every
 * other view uses the standard size.
 */
export const WINDOW_LAYOUTS = Object.freeze({
  standard: { width: 360, height: 720 },
  shield: { width: 200, height: 740 },
} as const);

export type WindowLayout = keyof typeof WINDOW_LAYOUTS;

export function isWindowLayout(value: unknown): value is WindowLayout {
  return typeof value === 'string' && Object.hasOwn(WINDOW_LAYOUTS, value);
}
