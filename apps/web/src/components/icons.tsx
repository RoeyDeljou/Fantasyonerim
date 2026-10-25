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
