// Device preview: the real preview site is shown in a frame of a phone, tablet or desktop screen, scaled to fit the pane.

/** Screen size (CSS px) of each device and the frame border on each side (the desktop height is only a minimum). */
export const DEVICES = {
  desktop: { w: 1280, h: 800, border: 1 },
  tablet: { w: 768, h: 1024, border: 10 },
  mobile: { w: 390, h: 844, border: 9 },
};

const MIN_SCALE = 0.3;

/**
 * How to draw `device` inside a box of availW x availH: the scale of the screen and the outer size of the frame.
 * Never enlarges past 100% and never shrinks past a readable minimum (the box scrolls instead).
 */
export function fitDevice(device, availW, availH) {
  const d = DEVICES[device] ?? DEVICES.desktop;
  if (device === "desktop" || !DEVICES[device]) {
    // A computer window is as tall as the pane allows (a page longer than that scrolls inside the frame), so the pane is filled.
    const scale = Math.max(MIN_SCALE, Math.min(1, (availW - 2 * d.border) / d.w));
    const screenH = Math.max(d.h, Math.round((availH - 2 * d.border) / scale));
    return { scale, width: Math.round(d.w * scale + 2 * d.border), height: Math.round(screenH * scale + 2 * d.border), screenW: d.w, screenH };
  }
  const scale = Math.max(MIN_SCALE, Math.min(1, (availW - 2 * d.border) / d.w, (availH - 2 * d.border) / d.h));
  return { scale, width: Math.round(d.w * scale + 2 * d.border), height: Math.round(d.h * scale + 2 * d.border), screenW: d.w, screenH: d.h };
}

/** Only web addresses can be framed. */
export const framable = (url) => {
  try {
    return ["https:", "http:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
};
