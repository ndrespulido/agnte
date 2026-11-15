/**
 * The icon set: one stroke weight, one size, drawn in `currentColor`.
 *
 * Inline SVG rather than an icon font or a package, for three reasons that
 * all come from CLAUDE.md. A font is a network request and a flash of empty
 * boxes; a package is a dependency for two dozen paths; and inline paths take
 * the ink colour of whatever they sit in, so dark mode costs nothing.
 *
 * Every icon is decoration beside a control that already has a name
 * (`aria-label` or a placeholder), so they are hidden from assistive tech.
 * An icon that *is* the control's only name is the caller's job to label.
 */
const PATHS = {
  note: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4',
  pin: 'M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.500C5 14.800 12 21 12 21zM12 12a2.500 2.500 0 1 0 0-5 2.500 2.500 0 0 0 0 5z',
  calendar:
    'M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM4 10h16M8 3v4M16 3v4',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  star: 'M12 3.500l2.600 5.400 5.900.800-4.300 4.100 1 5.800L12 16.900l-5.200 2.700 1-5.800L3.500 9.700l5.900-.800L12 3.500z',
  eye: 'M2.500 12S6 5.500 12 5.500 21.500 12 21.500 12 18 18.500 12 18.500 2.500 12 2.500 12zM12 14.500a2.500 2.500 0 1 0 0-5 2.500 2.500 0 0 0 0 5z',
  image:
    'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM4 16l4.500-4.500 4 4 2.500-2.500L20 18M15 9.500a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  tag: 'M3.500 12.500V4.500a1 1 0 0 1 1-1h8l8 8a1.400 1.400 0 0 1 0 2l-7 7a1.400 1.400 0 0 1-2 0l-8-8zM8 8.500a.500.500 0 1 0 0-1 .500.500 0 0 0 0 1z',
  list: 'M9 6h11M9 12h11M9 18h11M4.500 6h.010M4.500 12h.010M4.500 18h.010',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
  clip: 'M20 11.500l-7.800 7.800a5 5 0 0 1-7-7l8.500-8.500a3.300 3.300 0 0 1 4.700 4.700l-8.500 8.500a1.700 1.700 0 0 1-2.400-2.400L15 7',
  mic: 'M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5.500 11a6.500 6.500 0 0 0 13 0M12 17.500V21',
  stop: 'M7 7h10v10H7z',
  send: 'M12 19V5M6 11l6-6 6 6',
  chevronLeft: 'M15 5l-7 7 7 7',
  chevronRight: 'M9 5l7 7-7 7',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
