/** Line icons shared by the app chrome and the remote skins. */
export type IconName =
  | 'devices'
  | 'dropdown'
  | 'disconnect'
  | 'trash'
  | 'tv'
  | 'cast'
  | 'refresh'
  | 'plus'
  | 'minus'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'back'
  | 'keyboard'
  | 'settings'
  | 'sun'
  | 'moon'
  | 'play'
  | 'power'
  | 'volumeUp'
  | 'volumeDown'
  | 'remote'
  | 'assistant'
  | 'rewind'
  | 'fastForward'
  | 'playPause'
  | 'mute'
  | 'menu'
  | 'mic'
  | 'more';

export function Icon({ name, className }: { name: IconName; className?: string }) {
  const props = {
    className,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  switch (name) {
    case 'sun':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2V4M12 20V22M2 12H4M20 12H22M4.9 4.9L6.3 6.3M17.7 17.7L19.1 19.1M4.9 19.1L6.3 17.7M17.7 6.3L19.1 4.9" />
        </svg>
      );
    case 'moon':
      return (
        <svg {...props}>
          <path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z" />
        </svg>
      );
    case 'devices':
      return (
        <svg {...props}>
          <rect x="3.5" y="5" width="11" height="8" rx="1.8" />
          <path d="M1.75 18.5H16.25" />
          <path d="M9 13V18.5" />
          <rect x="16.5" y="7.5" width="5.75" height="11.5" rx="1.6" />
          <circle cx="19.4" cy="16.4" r="0.7" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'dropdown':
      return (
        <svg {...props}>
          <path d="M6.5 9.5L12 15L17.5 9.5" />
        </svg>
      );
    case 'disconnect':
      return (
        <svg {...props}>
          <path d="M8.5 8.5L15.5 15.5" />
          <path d="M15.5 8.5L8.5 15.5" />
          <path d="M5 12C5 8.134 8.134 5 12 5" />
          <path d="M19 12C19 15.866 15.866 19 12 19" />
        </svg>
      );
    case 'trash':
      return (
        <svg {...props}>
          <path d="M4.5 7H19.5" />
          <path d="M9.5 4.5H14.5" />
          <path d="M7 7L8 19H16L17 7" />
          <path d="M10 10V16" />
          <path d="M14 10V16" />
        </svg>
      );
    case 'tv':
      return (
        <svg {...props}>
          <rect x="4" y="5.5" width="16" height="10.5" rx="2" />
          <path d="M9 19H15" />
          <path d="M12 16.5V19" />
        </svg>
      );
    case 'cast':
      return (
        <svg {...props}>
          <path d="M4 17.5A2.5 2.5 0 0 1 6.5 20" />
          <path d="M4 12.5A7.5 7.5 0 0 1 11.5 20" />
          <path d="M4 7.5A12.5 12.5 0 0 1 16.5 20" />
          <path d="M4 5H20V19" />
        </svg>
      );
    case 'refresh':
      return (
        <svg {...props}>
          <path d="M20 11A8 8 0 0 0 6.3 5.4" />
          <path d="M6 2.5V6.5H10" />
          <path d="M4 13A8 8 0 0 0 17.7 18.6" />
          <path d="M18 21.5V17.5H14" />
        </svg>
      );
    case 'plus':
      return (
        <svg {...props}>
          <path d="M12 5V19" />
          <path d="M5 12H19" />
        </svg>
      );
    case 'minus':
      return (
        <svg {...props}>
          <path d="M5 12H19" />
        </svg>
      );
    case 'up':
      return (
        <svg {...props}>
          <path d="M6 14L12 8L18 14" />
        </svg>
      );
    case 'down':
      return (
        <svg {...props}>
          <path d="M6 10L12 16L18 10" />
        </svg>
      );
    case 'left':
      return (
        <svg {...props}>
          <path d="M14 6L8 12L14 18" />
        </svg>
      );
    case 'right':
      return (
        <svg {...props}>
          <path d="M10 6L16 12L10 18" />
        </svg>
      );
    case 'home':
      return (
        <svg {...props}>
          <path d="M4.5 10.5L12 4L19.5 10.5" />
          <path d="M7 9.5V19H17V9.5" />
        </svg>
      );
    case 'back':
      return (
        <svg {...props}>
          <path d="M10 7L5 12L10 17" />
          <path d="M6 12H15.5C18 12 20 14 20 16.5C20 19 18 21 15.5 21" />
        </svg>
      );
    case 'keyboard':
      return (
        <svg {...props}>
          <rect x="3.5" y="6" width="17" height="12" rx="2" />
          <path d="M6.5 10H6.6" />
          <path d="M9.5 10H9.6" />
          <path d="M12.5 10H12.6" />
          <path d="M15.5 10H15.6" />
          <path d="M6.5 13H6.6" />
          <path d="M9.5 13H15.5" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="3" />
          <path d="m9.5 3-.5 2a7 7 0 0 0-1.6.9l-2-.6-2.5 4.3 1.5 1.4a7 7 0 0 0 0 1.9l-1.5 1.4 2.5 4.3 2-.6A7 7 0 0 0 9 19l.5 2h5l.5-2a7 7 0 0 0 1.6-.9l2 .6 2.5-4.3-1.5-1.4a7 7 0 0 0 0-1.9l1.5-1.4-2.5-4.3-2 .6A7 7 0 0 0 15 5l-.5-2Z" />
        </svg>
      );
    case 'play':
      return (
        <svg {...props}>
          <path d="M9 7L17 12L9 17Z" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'power':
      return (
        <svg {...props}>
          <path d="M12 3.5V11" />
          <path d="M7.2 6.5A6.5 6.5 0 1 0 16.8 6.5" />
        </svg>
      );
    case 'volumeUp':
      return (
        <svg {...props}>
          <path d="M5 10H8L12 6V18L8 14H5Z" />
          <path d="M15 9C16.3 10.1 16.3 13.9 15 15" />
          <path d="M17.7 6.8C20 8.7 20 15.3 17.7 17.2" />
        </svg>
      );
    case 'volumeDown':
      return (
        <svg {...props}>
          <path d="M5 10H8L12 6V18L8 14H5Z" />
          <path d="M15.8 10.2L18.2 13.8" />
          <path d="M18.2 10.2L15.8 13.8" />
        </svg>
      );
    case 'remote':
      return (
        <svg {...props}>
          <rect x="8" y="4" width="8" height="16" rx="3" />
          <path d="M7 3C9.2 1.2 14.8 1.2 17 3" />
          <path d="M5 6C8.2 3.8 15.8 3.8 19 6" />
          <circle cx="12" cy="16" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'assistant':
      return (
        <svg className={className} viewBox="0 0 28 24" fill="none" aria-hidden>
          <circle cx="8" cy="12" r="6" fill="#4285F4" />
          <circle cx="16.4" cy="10.3" r="3.9" fill="#EA4335" />
          <circle cx="16.4" cy="17" r="4.5" fill="#FBBC05" />
          <circle cx="21.5" cy="7" r="2.1" fill="#34A853" />
        </svg>
      );
    case 'rewind':
      return (
        <svg {...props}>
          <path d="M11 7L5 12L11 17Z" fill="currentColor" stroke="none" />
          <path d="M19 7L13 12L19 17Z" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'fastForward':
      return (
        <svg {...props}>
          <path d="M5 7L11 12L5 17Z" fill="currentColor" stroke="none" />
          <path d="M13 7L19 12L13 17Z" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'playPause':
      return (
        <svg {...props}>
          <path d="M4 7L11 12L4 17Z" fill="currentColor" stroke="none" />
          <path d="M14.5 7V17M18.5 7V17" />
        </svg>
      );
    case 'mute':
      return (
        <svg {...props}>
          <path d="M5 10H8L12 6V18L8 14H5Z" />
          <path d="M16 10L20 14M20 10L16 14" />
        </svg>
      );
    case 'menu':
      return (
        <svg {...props}>
          <path d="M5 7H19M5 12H19M5 17H19" />
        </svg>
      );
    case 'mic':
      return (
        <svg {...props}>
          <rect x="9" y="3.5" width="6" height="11" rx="3" />
          <path d="M6 11.5A6 6 0 0 0 18 11.5M12 17.5V20.5" />
        </svg>
      );
    case 'more':
      return (
        <svg {...props}>
          <circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
          <circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none" />
        </svg>
      );
    default:
      return null;
  }
}
