import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
  strokeWidth?: number | string;
};

function MoonIcon(props: IconProps & { children: ReactNode }) {
  const { size = 18, strokeWidth = 1.8, children, ...rest } = props;
  return (
    <svg
      {...rest}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={rest["aria-label"] ? undefined : true}
    >
      {children}
    </svg>
  );
}

function makeIcon(children: ReactNode) {
  return function Icon(props: IconProps) {
    return <MoonIcon {...props}>{children}</MoonIcon>;
  };
}

export const Archive = makeIcon(
  <>
    <path d="M4.5 7.5h15" />
    <path d="M6 7.5v10.2c0 .9.7 1.6 1.6 1.6h8.8c.9 0 1.6-.7 1.6-1.6V7.5" />
    <path d="M7 4.7h10l1.4 2.8H5.6L7 4.7Z" />
    <path d="M9.3 11.3h5.4" />
  </>,
);

export const BookOpen = makeIcon(
  <>
    <path d="M4.5 5.6c2.8-.8 5.2-.3 7.5 1.4v12c-2.3-1.5-4.7-2-7.5-1.2V5.6Z" />
    <path d="M19.5 5.6c-2.8-.8-5.2-.3-7.5 1.4v12c2.3-1.5 4.7-2 7.5-1.2V5.6Z" />
  </>,
);

export const Bot = makeIcon(
  <>
    <rect x="5" y="8" width="14" height="10" rx="3" />
    <path d="M12 8V4.8" />
    <path d="M9 12.5h.1" />
    <path d="M15 12.5h.1" />
    <path d="M9.5 15.5h5" />
  </>,
);

export const Bookmark = makeIcon(
  <>
    <path d="M7 5.5c0-.9.7-1.6 1.6-1.6h6.8c.9 0 1.6.7 1.6 1.6v14l-5-3.1-5 3.1v-14Z" />
  </>,
);

export const BookmarkCheck = makeIcon(
  <>
    <path d="M7 5.5c0-.9.7-1.6 1.6-1.6h6.8c.9 0 1.6.7 1.6 1.6v14l-5-3.1-5 3.1v-14Z" />
    <path d="m9.5 10.9 1.8 1.8 3.4-4" />
  </>,
);

export const ChevronLeft = makeIcon(<path d="m14.5 6.5-5.5 5.5 5.5 5.5" />);
export const ChevronRight = makeIcon(<path d="m9.5 6.5 5.5 5.5-5.5 5.5" />);
export const ChevronDown = makeIcon(<path d="m6.5 9.5 5.5 5 5.5-5" />);
export const ChevronUp = makeIcon(<path d="m6.5 14.5 5.5-5 5.5 5" />);

export const ClipboardList = makeIcon(
  <>
    <path d="M8.5 5.5h7l.7 2.5H7.8l.7-2.5Z" />
    <rect x="5.5" y="7.5" width="13" height="12" rx="2" />
    <path d="M9 12h.1" />
    <path d="M11.5 12h4" />
    <path d="M9 15.5h.1" />
    <path d="M11.5 15.5h4" />
  </>,
);

export const Copy = makeIcon(
  <>
    <rect x="8" y="8" width="10.5" height="10.5" rx="2" />
    <path d="M5.5 15.5V7.6c0-1.2.9-2.1 2.1-2.1h7.9" />
  </>,
);

export const Download = makeIcon(
  <>
    <path d="M12 4.5v10" />
    <path d="m8 10.8 4 3.9 4-3.9" />
    <path d="M5 18.8h14" />
  </>,
);

export const Eraser = makeIcon(
  <>
    <path d="m4.6 14.2 8.8-8.8c.8-.8 2-.8 2.8 0l2.4 2.4c.8.8.8 2 0 2.8l-7.1 7.1" />
    <path d="m9.1 9.7 6.2 6.2" />
    <path d="M4.6 14.2 8 17.6c.8.8 2 .8 2.8 0l.7-.7" />
    <path d="M4.5 20h15" />
  </>,
);

export const Eye = makeIcon(
  <>
    <path d="M3.8 12s3-5.3 8.2-5.3 8.2 5.3 8.2 5.3-3 5.3-8.2 5.3S3.8 12 3.8 12Z" />
    <circle cx="12" cy="12" r="2.5" />
  </>,
);

export const FileArchive = makeIcon(
  <>
    <path d="M7 3.8h6l4 4v12.4H7V3.8Z" />
    <path d="M13 3.8v4h4" />
    <path d="M10 7h2" />
    <path d="M10 10h2" />
    <path d="M10 13h4" />
    <rect x="9.5" y="15.5" width="5" height="2.8" rx=".8" />
  </>,
);

export const FileText = makeIcon(
  <>
    <path d="M7 3.8h6l4 4v12.4H7V3.8Z" />
    <path d="M13 3.8v4h4" />
    <path d="M9.5 12h5" />
    <path d="M9.5 15h5" />
  </>,
);

export const FolderOpen = makeIcon(
  <>
    <path d="M4.5 8.2h5l1.8 2h8.2v1.3" />
    <path d="M4.8 9.8h14.7l-1.6 8.5H5.9L4.8 9.8Z" />
  </>,
);

export const FolderPlus = makeIcon(
  <>
    <path d="M4.5 7.4h5l1.7 2h8.3v8.2c0 1-.8 1.8-1.8 1.8H6.3c-1 0-1.8-.8-1.8-1.8V7.4Z" />
    <path d="M12 12.4v4" />
    <path d="M10 14.4h4" />
  </>,
);

export const Grid2X2 = makeIcon(
  <>
    <rect x="5" y="5" width="5.5" height="5.5" rx="1.2" />
    <rect x="13.5" y="5" width="5.5" height="5.5" rx="1.2" />
    <rect x="5" y="13.5" width="5.5" height="5.5" rx="1.2" />
    <rect x="13.5" y="13.5" width="5.5" height="5.5" rx="1.2" />
  </>,
);

export const GripVertical = makeIcon(
  <>
    <path d="M9 7.2h.1" />
    <path d="M15 7.2h.1" />
    <path d="M9 12h.1" />
    <path d="M15 12h.1" />
    <path d="M9 16.8h.1" />
    <path d="M15 16.8h.1" />
  </>,
);

export const Highlighter = makeIcon(
  <>
    <path d="m6 16 8.8-8.8 3 3L9 19H5l1-3Z" />
    <path d="m13.6 8.4 2 2" />
    <path d="M4 20h9" />
  </>,
);

export const Info = makeIcon(
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 10.8v5" />
    <path d="M12 7.7h.1" />
  </>,
);

export const Languages = makeIcon(
  <>
    <path d="M5 6.5h8" />
    <path d="M9 4.5v2" />
    <path d="M7 6.5c.7 2.6 2.4 4.5 5.2 5.7" />
    <path d="M12.3 6.5c-.9 2.4-2.6 4.3-5.3 5.8" />
    <path d="M13.5 19.5 17 11l3.5 8.5" />
    <path d="M15 16.3h4" />
  </>,
);

export const Library = makeIcon(
  <>
    <path d="M5.5 5.5h3v13h-3z" />
    <path d="M10.5 5.5h3v13h-3z" />
    <path d="m15.2 6 2.7-.7 3 12.5-2.7.7-3-12.5Z" />
  </>,
);

export const Link = makeIcon(
  <>
    <path d="M9.7 14.3 8.4 15.6a3.2 3.2 0 0 1-4.5-4.5l2.5-2.5a3.2 3.2 0 0 1 4.5 0" />
    <path d="M14.3 9.7 15.6 8.4a3.2 3.2 0 0 1 4.5 4.5l-2.5 2.5a3.2 3.2 0 0 1-4.5 0" />
    <path d="m9.5 14.5 5-5" />
  </>,
);

export const List = makeIcon(
  <>
    <path d="M8 7h11" />
    <path d="M8 12h11" />
    <path d="M8 17h11" />
    <path d="M5 7h.1" />
    <path d="M5 12h.1" />
    <path d="M5 17h.1" />
  </>,
);

export const ListPlus = makeIcon(
  <>
    <path d="M8 7h10" />
    <path d="M8 12h10" />
    <path d="M8 17h5" />
    <path d="M5 7h.1" />
    <path d="M5 12h.1" />
    <path d="M16.5 15v5" />
    <path d="M14 17.5h5" />
  </>,
);

export const ListTree = makeIcon(
  <>
    <path d="M6 5v11.5h4" />
    <path d="M10 8h8" />
    <path d="M10 16.5h8" />
    <path d="M6 11.5h4" />
    <path d="M10 11.5h6" />
  </>,
);

export const Maximize2 = makeIcon(
  <>
    <path d="M8.5 5H5v3.5" />
    <path d="M15.5 5H19v3.5" />
    <path d="M5 15.5V19h3.5" />
    <path d="M19 15.5V19h-3.5" />
  </>,
);

export const MessageCircle = makeIcon(
  <>
    <path d="M12 5c4.1 0 7.3 2.7 7.3 6.2s-3.2 6.2-7.3 6.2c-.9 0-1.7-.1-2.5-.4L5 19l1.4-3.7a5.7 5.7 0 0 1-1.7-4.1C4.7 7.7 7.9 5 12 5Z" />
  </>,
);

export const MessageSquare = makeIcon(
  <>
    <path d="M5.5 5.5h13v10.3c0 1-.8 1.7-1.7 1.7H10l-4.5 3v-15Z" />
  </>,
);

export const MessageSquareText = makeIcon(
  <>
    <path d="M5.5 5.5h13v10.3c0 1-.8 1.7-1.7 1.7H10l-4.5 3v-15Z" />
    <path d="M8.5 9.5h7" />
    <path d="M8.5 12.7h5" />
  </>,
);

export const MoreVertical = makeIcon(
  <>
    <path d="M12 7h.1" />
    <path d="M12 12h.1" />
    <path d="M12 17h.1" />
  </>,
);

export const Move = makeIcon(
  <>
    <path d="M12 4.5v15" />
    <path d="M4.5 12h15" />
    <path d="m8.5 8-4 4 4 4" />
    <path d="m15.5 8 4 4-4 4" />
  </>,
);

export const PanelRight = makeIcon(
  <>
    <rect x="4.5" y="5" width="15" height="14" rx="2" />
    <path d="M14 5v14" />
  </>,
);

export const PenLine = makeIcon(
  <>
    <path d="m5 17.5 1.2-4 8.7-8.7 3.3 3.3-8.7 8.7-4.5.7Z" />
    <path d="m13.5 6.2 3.3 3.3" />
    <path d="M4.5 20h15" />
  </>,
);

export const Quote = makeIcon(
  <>
    <path d="M8.5 10.5H5.8c.1-2.3 1.3-4 3.6-5l1.1 2c-1 .5-1.6 1.2-1.8 2.1 1.3.2 2.2 1.1 2.2 2.4 0 1.5-1.1 2.6-2.6 2.6s-2.7-1.2-2.7-3c0-.4.1-.8.2-1.1" />
    <path d="M17.2 10.5h-2.7c.1-2.3 1.3-4 3.6-5l1.1 2c-1 .5-1.6 1.2-1.8 2.1 1.3.2 2.2 1.1 2.2 2.4 0 1.5-1.1 2.6-2.6 2.6s-2.7-1.2-2.7-3c0-.4.1-.8.2-1.1" />
  </>,
);

export const RefreshCw = makeIcon(
  <>
    <path d="M18.8 9.5a7 7 0 0 0-12-2.1L5 9.2" />
    <path d="M5 5v4.2h4.2" />
    <path d="M5.2 14.5a7 7 0 0 0 12 2.1l1.8-1.8" />
    <path d="M19 19v-4.2h-4.2" />
  </>,
);

export const Save = makeIcon(
  <>
    <path d="M5 5h12.5L19 6.5V19H5V5Z" />
    <path d="M8 5v5h7V5" />
    <path d="M8 19v-5h8v5" />
  </>,
);

export const Search = makeIcon(
  <>
    <circle cx="10.8" cy="10.8" r="5.8" />
    <path d="m15.2 15.2 4.1 4.1" />
  </>,
);

export const Send = makeIcon(
  <>
    <path d="M4.5 5.3 20 12 4.5 18.7l2.2-6.7-2.2-6.7Z" />
    <path d="M6.8 12H20" />
  </>,
);

export const Settings = makeIcon(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 4.5v2" />
    <path d="M12 17.5v2" />
    <path d="M4.5 12h2" />
    <path d="M17.5 12h2" />
    <path d="m6.7 6.7 1.4 1.4" />
    <path d="m15.9 15.9 1.4 1.4" />
    <path d="m17.3 6.7-1.4 1.4" />
    <path d="m8.1 15.9-1.4 1.4" />
  </>,
);

export const Share2 = makeIcon(
  <>
    <circle cx="7" cy="12" r="2.3" />
    <circle cx="17" cy="6.5" r="2.3" />
    <circle cx="17" cy="17.5" r="2.3" />
    <path d="m9 10.8 6-3.2" />
    <path d="m9 13.2 6 3.2" />
  </>,
);

export const SlidersHorizontal = makeIcon(
  <>
    <path d="M4.5 7h8" />
    <path d="M16.5 7h3" />
    <circle cx="14.5" cy="7" r="2" />
    <path d="M4.5 17h3" />
    <path d="M11.5 17h8" />
    <circle cx="9.5" cy="17" r="2" />
  </>,
);

export const Sparkles = makeIcon(
  <>
    <path d="M12 3.8 13.7 9l5.2 1.7-5.2 1.7L12 17.6l-1.7-5.2-5.2-1.7L10.3 9 12 3.8Z" />
    <path d="m18.2 15.4.6 1.8 1.8.6-1.8.6-.6 1.8-.6-1.8-1.8-.6 1.8-.6.6-1.8Z" />
  </>,
);

export const Trash2 = makeIcon(
  <>
    <path d="M5 7h14" />
    <path d="M9 7V5h6v2" />
    <path d="M7 7.5 8 19h8l1-11.5" />
    <path d="M10.2 11v5" />
    <path d="M13.8 11v5" />
  </>,
);

export const Upload = makeIcon(
  <>
    <path d="M12 19.5v-10" />
    <path d="m8 13.2 4-3.9 4 3.9" />
    <path d="M5 5.2h14" />
  </>,
);

export const X = makeIcon(
  <>
    <path d="M6.5 6.5 17.5 17.5" />
    <path d="M17.5 6.5 6.5 17.5" />
  </>,
);

export const ZoomIn = makeIcon(
  <>
    <circle cx="10.8" cy="10.8" r="5.8" />
    <path d="m15.2 15.2 4.1 4.1" />
    <path d="M10.8 8.3v5" />
    <path d="M8.3 10.8h5" />
  </>,
);

export const ZoomOut = makeIcon(
  <>
    <circle cx="10.8" cy="10.8" r="5.8" />
    <path d="m15.2 15.2 4.1 4.1" />
    <path d="M8.3 10.8h5" />
  </>,
);
