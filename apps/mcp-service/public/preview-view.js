// Standalone page: the live preview in a phone/tablet/desktop frame, opened in its own tab so the customer
// can fill the WhatsApp gate (served by the preview host itself) without losing their place in the wizard.
import { DEVICES, fitDevice, framable } from "./device.js";

const $ = (id) => document.getElementById(id);
const url = new URLSearchParams(location.search).get("url") ?? "";
let device = "desktop";

if (!framable(url)) {
  $("device-page").replaceChildren(Object.assign(document.createElement("p"), { className: "device-size", textContent: "Link de prévia inválido ou expirado." }));
} else {
  $("device-iframe").src = url;

  function layout() {
    const stage = $("device-stage");
    const f = fitDevice(device, stage.clientWidth, Math.max(320, window.innerHeight - 140));
    const frame = $("device-frame");
    frame.className = `device-frame ${device}`;
    frame.style.width = `${f.width}px`;
    frame.style.height = `${f.height}px`;
    const iframe = $("device-iframe");
    iframe.style.width = `${f.screenW}px`;
    iframe.style.height = `${f.screenH}px`;
    iframe.style.transform = `scale(${f.scale})`;
    $("device-size").textContent = device === "desktop" ? `Computador · ${f.screenW} px de largura` : `${f.screenW} × ${f.screenH} px`;
  }

  document.querySelectorAll(".dev-btn").forEach((b) =>
    b.addEventListener("click", () => {
      device = b.dataset.device in DEVICES ? b.dataset.device : "desktop";
      document.querySelectorAll(".dev-btn").forEach((x) => {
        x.classList.toggle("on", x === b);
        x.setAttribute("aria-pressed", String(x === b));
      });
      layout();
    }),
  );
  new ResizeObserver(() => layout()).observe($("device-stage"));
  window.addEventListener("resize", layout);
  layout();
}
