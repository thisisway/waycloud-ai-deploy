import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM served to the browser, without type declarations
import { DEVICES, fitDevice, framable } from "../../apps/mcp-service/public/device.js";
import { previewFrameSource } from "../../apps/mcp-service/src/web.js";

describe("fitDevice()", () => {
  it("scales a desktop screen down to the width of the pane and fills its height", () => {
    const f = fitDevice("desktop", 642, 700);
    expect(f.scale).toBeCloseTo((642 - 2) / 1280, 5);
    expect(f.screenW).toBe(1280);
    expect(f.screenH).toBe(Math.round((700 - 2) / f.scale)); // as tall as the pane allows
    expect(f.width).toBe(Math.round(1280 * f.scale + 2));
    expect(f.height).toBeCloseTo(700, 0);
  });
  it("never makes a desktop screen shorter than 800px", () => {
    expect(fitDevice("desktop", 2000, 300).screenH).toBe(800);
  });
  it("is limited by the height for a tall phone, and never enlarges past 100%", () => {
    const tall = fitDevice("mobile", 900, 600);
    expect(tall.scale).toBeCloseTo((600 - 18) / 844, 5);
    expect(fitDevice("mobile", 2000, 2000).scale).toBe(1);
  });
  it("does not shrink below a readable size (the pane scrolls instead)", () => {
    expect(fitDevice("desktop", 100, 100).scale).toBe(0.3);
  });
  it("falls back to the desktop for an unknown device and knows the three sizes", () => {
    expect(fitDevice("watch", 2000, 2000).screenW).toBe(DEVICES.desktop.w);
    expect(Object.keys(DEVICES)).toEqual(["desktop", "tablet", "mobile"]);
  });
});

describe("framable()", () => {
  it("accepts web addresses only", () => {
    expect(framable("https://abc.waypreview.com.br")).toBe(true);
    expect(framable("http://localhost:3000/x")).toBe(true);
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://x", "not a url", ""]) expect(framable(bad), bad).toBe(false);
  });
});

describe("previewFrameSource()", () => {
  it("allows every preview host of the template, and only those", () => {
    expect(previewFrameSource("https://{slug}.waypreview.com.br")).toBe("https://*.waypreview.com.br");
    expect(previewFrameSource("https://{slug}.preview.test")).toBe("https://*.preview.test");
    expect(previewFrameSource("https://previews.example.com/{slug}")).toBe("https://previews.example.com");
  });
});
