/**
 * Strichzeichnungen, alle auf demselben 24er-Raster mit 1.6 px Strichstärke.
 * Als Komponenten statt als Icon-Font oder SVG-Sprite: keine zusätzliche
 * Abhängigkeit, und die Strichstärke bleibt über alle Größen konsistent.
 */

import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 18, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
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

export const IconBack = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15 19l-7-7 7-7" />
  </Icon>
);

export const IconUndo = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 8h11a5 5 0 0 1 0 10H9" />
    <path d="M7 4L3 8l4 4" />
  </Icon>
);

export const IconRedo = (p: IconProps) => (
  <Icon {...p}>
    <path d="M21 8H10a5 5 0 0 0 0 10h5" />
    <path d="M17 4l4 4-4 4" />
  </Icon>
);

export const IconPlus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const IconClose = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

export const IconCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 12.5l5 5L20 6.5" />
  </Icon>
);

export const IconReset = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
    <path d="M3 4v5h5" />
  </Icon>
);

export const IconCompare = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M12 5v14" />
    <path d="M8.5 10.5L6.5 12l2 1.5M15.5 10.5l2 1.5-2 1.5" />
  </Icon>
);

export const IconSparkle = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
  </Icon>
);

export const IconSliders = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </Icon>
);

export const IconDroplet = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5s6 6.3 6 10.1a6 6 0 0 1-12 0C6 9.8 12 3.5 12 3.5z" />
  </Icon>
);

export const IconDetail = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
    <path d="M11 8.5v5M8.5 11h5" />
  </Icon>
);

export const IconEffects = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="4" />
  </Icon>
);

export const IconCurve = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
    <path d="M4 20C9 20 8 6 20 4" />
  </Icon>
);

export const IconExport = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 16V4" />
    <path d="M8 8l4-4 4 4" />
    <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </Icon>
);

export const IconPhoto = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <circle cx="8.5" cy="10" r="1.6" />
    <path d="M21 16l-5-5-5.5 5.5L8 14l-5 4" />
  </Icon>
);

export const IconLayers = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3l9 5-9 5-9-5 9-5z" />
    <path d="M3 13l9 5 9-5" />
  </Icon>
);

export const IconInfo = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 7.6v.6" />
  </Icon>
);

export const IconWarn = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4.5l8.5 15h-17z" />
    <path d="M12 10v4M12 17v.5" />
  </Icon>
);

export const IconTrash = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h16M10 7V5h4v2M6 7l1 13h10l1-13" />
  </Icon>
);

export const IconZoom = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5M8.5 11h5" />
  </Icon>
);

export const IconBrush = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9.5 14.5L5 19c-.8.8-.3 2.2.8 2.3 1.6.2 3.4-.4 4.4-1.4 1-1 1-2.6.3-3.4z" />
    <path d="M11 16.5L19.6 7.9a2 2 0 0 0 0-2.8l-.7-.7a2 2 0 0 0-2.8 0L7.5 13" />
  </Icon>
);

export const IconMask = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <circle cx="9.5" cy="12" r="4" />
    <path d="M14 8.5h4.5M14 12h4.5M14 15.5h4.5" />
  </Icon>
);

export const IconGraduation = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4L2.5 9 12 14l9.5-5L12 4z" />
    <path d="M6 11v4.5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V11" />
  </Icon>
);

export const IconShield = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5l7 2.5v5.5c0 4-2.9 7.4-7 8.5-4.1-1.1-7-4.5-7-8.5V6z" />
    <path d="M9.4 12.2l1.9 1.9 3.5-3.9" />
  </Icon>
);
