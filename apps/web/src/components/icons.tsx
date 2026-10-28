import type { SVGProps } from 'react';

/** Inline outline icon set (24×24, stroke = currentColor). Decorative by default (aria-hidden). */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 24, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const NewsIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 5h12v14H6a2 2 0 0 1-2-2V5Z" />
    <path d="M16 9h3a1 1 0 0 1 1 1v7a2 2 0 0 1-2 2h-2" />
    <path d="M7.5 8.5h5M7.5 12h5M7.5 15.5h3" />
  </Svg>
);

export const CommunityIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8.5" r="3" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
    <circle cx="17" cy="9.5" r="2.4" />
    <path d="M15.5 14.2A4.5 4.5 0 0 1 21 18.5" />
  </Svg>
);

export const ShirtIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 3.5 4 6l-1.5 4.5 3 1.2V20h13v-8.3l3-1.2L20 6l-5-2.5a3 3 0 0 1-6 0Z" />
  </Svg>
);

export const TableIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 4h10v4a5 5 0 0 1-10 0V4Z" />
    <path d="M7 6H4.5a2.5 2.5 0 0 0 2.6 3.2M17 6h2.5a2.5 2.5 0 0 1-2.6 3.2" />
    <path d="M12 13v3.5M8.5 20h7M9.5 16.5h5V20h-5z" />
  </Svg>
);

export const LiveIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="2.2" />
    <path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6" />
    <path d="M5.3 5.3a9.5 9.5 0 0 0 0 13.4M18.7 5.3a9.5 9.5 0 0 1 0 13.4" />
  </Svg>
);

export const ChevronStartIcon = (p: IconProps) => (
  <Svg {...p} className={`rtl:rotate-180 ${p.className ?? ''}`}>
    <path d="m14.5 6-6 6 6 6" />
  </Svg>
);

export const ChevronEndIcon = (p: IconProps) => (
  <Svg {...p} className={`rtl:rotate-180 ${p.className ?? ''}`}>
    <path d="m9.5 6 6 6-6 6" />
  </Svg>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 9.5 6 6 6-6" />
  </Svg>
);

export const ArrowUpIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 19V6M6.5 11.5 12 6l5.5 5.5" />
  </Svg>
);

export const ArrowDownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v13M6.5 12.5 12 18l5.5-5.5" />
  </Svg>
);

export const DotIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
  </Svg>
);

export const CopyIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
    <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
  </Svg>
);

export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);

export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const TrashIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12.5h9.4L17.5 7M10 11v5M14 11v5" />
  </Svg>
);

export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="m15 15 5 5" />
  </Svg>
);

export const SunIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
  </Svg>
);

export const MoonIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z" />
  </Svg>
);

export const DeviceIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
    <path d="M11 18.5h2" />
  </Svg>
);

export const LogOutIcon = (p: IconProps) => (
  <Svg {...p} className={`rtl:-scale-x-100 ${p.className ?? ''}`}>
    <path d="M14 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H14" />
    <path d="M10 12h10M16.5 8.5 20 12l-3.5 3.5" />
  </Svg>
);

export const ShieldIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 4.5 6v5.5c0 4.5 3.2 8 7.5 9.5 4.3-1.5 7.5-5 7.5-9.5V6L12 3Z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </Svg>
);

export const ShareIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5v11M8 7.5l4-4 4 4" />
    <path d="M7.5 10.5H6A1.5 1.5 0 0 0 4.5 12v7A1.5 1.5 0 0 0 6 20.5h12a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5h-1.5" />
  </Svg>
);

export const AddSquareIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <path d="M12 8.5v7M8.5 12h7" />
  </Svg>
);

export const DownloadIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" />
  </Svg>
);

export const RefreshIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
    <path d="M19.5 4.5v4h-4" />
  </Svg>
);

export const InfoIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.8v.2" />
  </Svg>
);

export const WifiOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 3l18 18M8.5 12.5a5 5 0 0 1 4.2-1.4M5 9a10 10 0 0 1 3.4-2.1M12 5.5a10 10 0 0 1 7 3.5M12 18.5v.01" />
  </Svg>
);

export const MicIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="8.5" y="2.5" width="7" height="12" rx="3.5" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v4M8.5 21.5h7" />
  </Svg>
);

export const SubInIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 19V6M7 11l5-5 5 5" />
  </Svg>
);

export const SubOutIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v13M7 13l5 5 5-5" />
  </Svg>
);

export const ClockIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);

export const GlobeIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5Z" />
  </Svg>
);

export const KeyIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2" />
  </Svg>
);

export const HeadphonesIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 16v-3a8 8 0 0 1 16 0v3" />
    <rect x="3.5" y="14" width="4" height="6" rx="1.5" />
    <rect x="16.5" y="14" width="4" height="6" rx="1.5" />
  </Svg>
);

export const CameraIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
    <circle cx="12" cy="12" r="4" />
    <path d="M17 7v.01" />
  </Svg>
);

export const XLogoIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 4.5 19.5 19.5M19.5 4.5 4.5 19.5" />
  </Svg>
);

export const ChatIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 19.5 6 15.6A7.5 7.5 0 1 1 8.6 18Z" />
  </Svg>
);

export const GripIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 6v.01M15 6v.01M9 12v.01M15 12v.01M9 18v.01M15 18v.01" strokeWidth={2.6} />
  </Svg>
);

export const PlayIcon = (p: IconProps) => (
  <Svg {...p}>
    <path
      d="M7.5 4.8v14.4a.8.8 0 0 0 1.2.7l11.3-7.2a.8.8 0 0 0 0-1.4L8.7 4.1a.8.8 0 0 0-1.2.7Z"
      fill="currentColor"
    />
  </Svg>
);

export const PauseIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none" />
    <rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none" />
  </Svg>
);

/** "Back N seconds" — a counter-clockwise arrow. Direction is about time, so it is never mirrored. */
export const RewindIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
    <path d="M4.5 4.5v4h4" />
  </Svg>
);

export const ForwardIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
    <path d="M19.5 4.5v4h-4" />
  </Svg>
);

export const VolumeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9.5h3l4.5-4v13l-4.5-4H4z" />
    <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
  </Svg>
);

export const MuteIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9.5h3l4.5-4v13l-4.5-4H4z" />
    <path d="m16 9.5 5 5M21 9.5l-5 5" />
  </Svg>
);

export const MoreIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 12v.01M12 12v.01M18 12v.01" strokeWidth={2.8} />
  </Svg>
);

export const EyeOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 3l18 18" />
    <path d="M10.6 6.1A9.6 9.6 0 0 1 12 6c5 0 8.5 4.5 9 6-.3.8-1.2 2.2-2.6 3.5M6.6 7.6C4.6 8.9 3.3 10.8 3 12c.5 1.5 4 6 9 6 1.6 0 3-.4 4.2-1.1" />
    <path d="M9.9 10a3 3 0 0 0 4.1 4.1" />
  </Svg>
);

export const ExternalIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.5 4.5h6v6M19.5 4.5 11 13" />
    <path d="M18 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H10" />
  </Svg>
);

export const BellIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15Z" />
    <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
  </Svg>
);

export const BellOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 3l18 18" />
    <path d="M8.2 6.3A6 6 0 0 1 18 11v4M6 11v5.5l-1.5 2h11.5" />
    <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
  </Svg>
);

export const MegaphoneIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 10v4a1 1 0 0 0 1 1h2l9 4.5V4.5L7 9H5a1 1 0 0 0-1 1Z" />
    <path d="M8 15l1.2 4.5M19.5 10v4" />
  </Svg>
);

export const RssIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14" />
    <circle cx="6" cy="18" r="1.3" fill="currentColor" />
  </Svg>
);

export const PlugIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 3.5v4M15 3.5v4M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0Z" />
    <path d="M12 16.5v4" />
  </Svg>
);

export const SendIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 12 20 4.5 15.5 20l-3.2-6.3Z" />
    <path d="m12.3 13.7 7.7-9.2" />
  </Svg>
);

/** Brand marks (filled, monochrome currentColor — tinted by our theme, never their brand hex). */
export const XBrandIcon = (p: IconProps) => (
  <Svg {...p} strokeWidth={0}>
    <path
      fill="currentColor"
      d="M17.75 3h2.94l-6.43 7.35L21.8 21h-5.92l-4.64-6.07L5.93 21H3l6.88-7.86L2.6 3h6.07l4.19 5.54ZM16.72 19.13h1.63L7.82 4.78H6.07Z"
    />
  </Svg>
);

export const SpotifyIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M7.5 9.6c3-.9 6.4-.6 9 .9M8 12.7c2.4-.7 5-.4 7.2.8M8.6 15.6c1.9-.5 3.8-.3 5.4.6" />
  </Svg>
);

export const ApplePodcastsIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7.2 16.6a7 7 0 1 1 9.6 0" />
    <path d="M9.4 13.8a3.5 3.5 0 1 1 5.2 0" />
    <circle cx="12" cy="11" r="1.2" fill="currentColor" />
    <path d="M11.2 14.5h1.6l-.3 5.5h-1z" fill="currentColor" />
  </Svg>
);

/** YouTube: a play triangle in a rounded rectangle (outline, theme colour). */
export const YouTubeIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="5.5" width="19" height="13" rx="4" />
    <path d="M10.2 9.4v5.2l4.5-2.6-4.5-2.6Z" fill="currentColor" />
  </Svg>
);

export const HeartIcon = ({ filled = false, ...p }: IconProps & { filled?: boolean }) => (
  <Svg {...p} fill={filled ? 'currentColor' : 'none'}>
    <path d="M12 20s-7.5-4.6-9.2-9.3C1.6 7.3 3.9 4 7.3 4c2 0 3.5 1.1 4.7 2.8C13.2 5.1 14.7 4 16.7 4c3.4 0 5.7 3.3 4.5 6.7C19.5 15.4 12 20 12 20Z" />
  </Svg>
);

export const ImageIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <circle cx="9" cy="9.5" r="1.6" />
    <path d="m4 17 4.6-4.6a1.5 1.5 0 0 1 2.1 0L15 16.7M13.5 15l1.9-1.9a1.5 1.5 0 0 1 2.1 0L20.5 16" />
  </Svg>
);

export const FlagIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 21V4.5M5 4.5h11.5l-2 4 2 4H5" />
  </Svg>
);

export const BanIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m6 6 12 12" />
  </Svg>
);

export const UndoIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Svg>
);

export const EyeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);

/** Lightning bolt — the "live update" composer. */
export const BoltIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12l1-8Z" />
  </Svg>
);

export const DocIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
    <path d="M14 3v4h4M9 12h6M9 15.5h6M9 8.5h2" />
  </Svg>
);
