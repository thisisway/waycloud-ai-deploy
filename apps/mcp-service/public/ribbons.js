// The Way Cloud brand ribbons (same animation as the customer area login), light palette.
// Soft blue light beams drawn as gradient strokes on a canvas; paused when the tab is hidden and static for reduced motion.

const PALETTE = [[242, 246, 255], [232, 240, 255], [211, 225, 255], [194, 213, 255], [163, 192, 255], [127, 171, 255], [76, 135, 255], [29, 102, 255], [23, 88, 220], [19, 73, 192], [14, 58, 153], [10, 42, 114]];
const RIBBONS = [
  { p: [0.4, -0.3, 0.66, 0.06, 0.78, 0.52, 1.34, 0.86], w0: 0.46, w3: 0.16, u0: 0, u1: 0.42, alpha: 0.52, spd: 11e-5, ph: 0, flow: 55e-6, waves: 1.6 },
  { p: [0.54, -0.28, 0.76, 0.12, 0.9, 0.5, 1.36, 0.62], w0: 0.3, w3: 0.28, u0: 0.14, u1: 0.62, alpha: 0.44, spd: 8e-5, ph: 2.1, flow: 8e-5, waves: 2.2 },
  { p: [0.66, -0.26, 0.86, 0.2, 0.94, 0.62, 1.32, 1.15], w0: 0.22, w3: 0.4, u0: 0.3, u1: 0.8, alpha: 0.38, spd: 14e-5, ph: 4.3, flow: 42e-6, waves: 1.2 },
  { p: [0.3, -0.2, 0.58, 0.2, 0.74, 0.7, 1.26, 1.25], w0: 0.36, w3: 0.2, u0: 0, u1: 0.24, alpha: 0.5, spd: 6e-5, ph: 5.6, flow: 11e-5, waves: 2.8 },
];
const STEPS = 54;
const SCALE = 0.55; // canvas resolution relative to CSS pixels: the beams are blurry anyway, so this keeps it cheap

const shade = (t) => {
  const a = Math.max(0, Math.min(1, t)) * (PALETTE.length - 1);
  const i = Math.min(PALETTE.length - 2, Math.floor(a));
  const f = a - i;
  const [p, q] = [PALETTE[i], PALETTE[i + 1]];
  return `${Math.round(p[0] + (q[0] - p[0]) * f)},${Math.round(p[1] + (q[1] - p[1]) * f)},${Math.round(p[2] + (q[2] - p[2]) * f)}`;
};

export function startRibbons(canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  let w = 1;
  let h = 1;
  let time = 0;
  let frame = 0;

  const resize = () => {
    const r = canvas.getBoundingClientRect();
    w = Math.max(1, Math.round(r.width * SCALE));
    h = Math.max(1, Math.round(r.height * SCALE));
    canvas.width = w;
    canvas.height = h;
  };

  const draw = (t) => {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.lineCap = "round";
    for (const rb of RIBBONS) {
      const s = Math.sin(t * rb.spd + rb.ph);
      const c = Math.cos(t * rb.spd * 0.7 + rb.ph);
      const [x0, y0, cx1, cy1, cx2, cy2, x1, y1] = rb.p;
      const wa = rb.w0 * (1 + s * 0.3);
      const wb = rb.w3 * (1 + c * 0.35);
      const c1y = cy1 + s * 0.07;
      const c2y = cy2 + c * 0.09;
      const c1x = cx1 + c * 0.05;
      const c2x = cx2 + s * 0.04;
      ctx.lineWidth = Math.max(1, ((Math.max(wa, wb) * h) / STEPS) * 1.9);
      const flow = t * rb.flow;
      for (let i = 0; i <= STEPS; i++) {
        const k = i / STEPS;
        const off0 = (k - 0.5) * wa * h;
        const off1 = (k - 0.5) * wb * h;
        const fade = Math.sin(Math.PI * k);
        const tone = rb.u0 + (rb.u1 - rb.u0) * k;
        const g = ctx.createLinearGradient(x0 * w, y0 * h + off0, x1 * w, y1 * h + off1);
        for (let n = 0; n <= 4; n++) {
          const stop = n / 4;
          const wave = Math.sin((stop * rb.waves - flow + k * 0.35) * Math.PI * 2);
          const alpha = rb.alpha * fade * (0.72 + 0.42 * (1 - Math.abs(wave)));
          g.addColorStop(stop, `rgba(${shade(tone + wave * 0.22)},${alpha.toFixed(3)})`);
        }
        ctx.strokeStyle = g;
        ctx.beginPath();
        ctx.moveTo(x0 * w, y0 * h + off0);
        ctx.bezierCurveTo(c1x * w, c1y * h + off0 * 0.66 + off1 * 0.34, c2x * w, c2y * h + off0 * 0.34 + off1 * 0.66, x1 * w, y1 * h + off1);
        ctx.stroke();
      }
    }
  };

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const loop = () => {
    frame = requestAnimationFrame(function tick(now) {
      time = now;
      draw(now);
      frame = requestAnimationFrame(tick);
    });
  };
  const onVisibility = () => {
    if (reduced) return;
    cancelAnimationFrame(frame);
    if (!document.hidden) loop();
  };

  resize();
  const observer = new ResizeObserver(() => {
    resize();
    draw(time);
  });
  observer.observe(canvas);
  if (reduced) draw(0);
  else loop();
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    cancelAnimationFrame(frame);
    document.removeEventListener("visibilitychange", onVisibility);
    observer.disconnect();
  };
}
