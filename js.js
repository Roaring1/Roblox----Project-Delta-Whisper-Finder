/* 28/12/2025-1
   Summary:
   - Paste / drop / upload an image.
   - Runs OCR in two crops:
     (A) left crop to read "Premium #X"
     (B) right crop to read the two uptime timers
   - Matches rows by order and prints:
     Premium #11 | 04:23:33 | 47:44:40
*/

const els = {
  fileInput: document.getElementById("fileInput"),
  pasteBtn: document.getElementById("pasteBtn"),
  clearBtn: document.getElementById("clearBtn"),
  dropZone: document.getElementById("dropZone"),
  preview: document.getElementById("preview"),
  output: document.getElementById("output"),
  log: document.getElementById("log")
};

let worker = null;

function logLine(msg) {
  const t = new Date().toLocaleTimeString();
  els.log.textContent += `[${t}] ${msg}\n`;
}

function clearAll() {
  els.output.textContent = "";
  els.log.textContent = "";
  els.preview.src = "";
  els.preview.style.display = "none";
}

function extractPremiumIds(text) {
  const out = [];
  const re = /Premium\s*#\s*(\d+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) out.push(`Premium #${m[1]}`);
  return out;
}

function extractTimes(text) {
  const m = String(text || "").match(/\b\d{1,3}:\d{2}:\d{2}\b/g);
  return m ? m : [];
}

async function ensureWorker() {
  if (worker) return worker;

  if (!window.Tesseract || !window.Tesseract.createWorker) {
    throw new Error(
      "Tesseract.js not found. Did you add the CDN script in CodePen settings?"
    );
  }

  logLine("Initializing Tesseract worker...");
  worker = await window.Tesseract.createWorker({
    logger: (m) => {
      if (m?.status && typeof m?.progress === "number") {
        logLine(`${m.status} ${(m.progress * 100).toFixed(0)}%`);
      }
    }
  });

  // Typical flow is: create worker once, reuse, terminate at end. :contentReference[oaicite:2]{index=2}
  await worker.load();
  await worker.loadLanguage("eng");
  await worker.initialize("eng");
  logLine("Worker ready.");
  return worker;
}

async function fileToImageBitmap(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  await img.decode();
  URL.revokeObjectURL(url);
  return await createImageBitmap(img);
}

function drawCropToCanvas(bitmap, crop) {
  const { x, y, w, h } = crop;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(w));
  canvas.height = Math.max(1, Math.floor(h));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  ctx.drawImage(bitmap, x, y, w, h, 0, 0, canvas.width, canvas.height);

  // Light contrast boost (simple + fast)
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i],
      g = d[i + 1],
      b = d[i + 2];
    // grayscale
    let v = r * 0.299 + g * 0.587 + b * 0.114;
    // contrast-ish
    v = (v - 128) * 1.25 + 128;
    v = Math.max(0, Math.min(255, v));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(imgData, 0, 0);

  return canvas;
}

async function ocrCanvas(canvas, whitelist) {
  const w = await ensureWorker();

  // Tesseract.js lets you set Tesseract parameters via worker.setParameters. :contentReference[oaicite:3]{index=3}
  await w.setParameters({
    tessedit_char_whitelist: whitelist,
    preserve_interword_spaces: "1"
  });

  const ret = await w.recognize(canvas);
  return (ret?.data?.text || "").trim();
}

function computeCropsForServerList(bitmap) {
  // These fractions assume the screenshot layout like your server browser:
  // - left block: server name lines
  // - right block: the two timers
  // Tweak these if needed.

  const W = bitmap.width;
  const H = bitmap.height;

  const leftCrop = {
    x: Math.floor(W * 0.0),
    y: Math.floor(H * 0.0),
    w: Math.floor(W * 0.55),
    h: Math.floor(H * 1.0)
  };

  const rightCrop = {
    x: Math.floor(W * 0.63),
    y: Math.floor(H * 0.0),
    w: Math.floor(W * 0.34),
    h: Math.floor(H * 1.0)
  };

  return { leftCrop, rightCrop };
}

function formatPairedOutput(premiumIds, times) {
  const rows = [];
  const pairCount = Math.floor(times.length / 2);

  const n = Math.min(premiumIds.length, pairCount);

  for (let i = 0; i < n; i++) {
    const tA = times[i * 2] || "";
    const tB = times[i * 2 + 1] || "";
    rows.push(`${premiumIds[i]} | ${tA} | ${tB}`);
  }

  const diagnostics = [];
  diagnostics.push(`IDs found: ${premiumIds.length}`);
  diagnostics.push(`Times found: ${times.length} (${pairCount} pairs)`);
  diagnostics.push(`Rows output: ${n}`);

  if (premiumIds.length !== pairCount) {
    diagnostics.push(
      "⚠️ Count mismatch: tweak crop fractions or improve image clarity."
    );
  }

  return rows.join("\n") + "\n\n" + diagnostics.join(" | ");
}

async function processImageFile(file) {
  if (!file || !file.type.startsWith("image/")) return;

  clearAll();
  logLine(
    `Got image: ${file.name || "(clipboard image)"} (${Math.round(
      file.size / 1024
    )} KB)`
  );

  const bitmap = await fileToImageBitmap(file);

  els.preview.src = URL.createObjectURL(file);
  els.preview.style.display = "block";

  const { leftCrop, rightCrop } = computeCropsForServerList(bitmap);

  logLine("Cropping + OCR (left: Premium #, right: timers) ...");

  const leftCanvas = drawCropToCanvas(bitmap, leftCrop);
  const rightCanvas = drawCropToCanvas(bitmap, rightCrop);

  // Tight whitelists help reduce garbage characters. :contentReference[oaicite:4]{index=4}
  const leftText = await ocrCanvas(
    leftCanvas,
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#[]:- "
  );
  const rightText = await ocrCanvas(rightCanvas, "0123456789: ");

  const premiumIds = extractPremiumIds(leftText);
  const times = extractTimes(rightText);

  els.output.textContent = formatPairedOutput(premiumIds, times);

  logLine("Done.");
}

async function handlePasteEvent(e) {
  // Classic paste event approach (Ctrl+V). :contentReference[oaicite:5]{index=5}
  const files = e.clipboardData?.files;
  if (!files || files.length === 0) return;

  for (const f of files) {
    if (f.type.startsWith("image/")) {
      e.preventDefault();
      await processImageFile(f);
      return;
    }
  }
}

async function pasteViaButton() {
  // Async Clipboard API option (permission-gated). :contentReference[oaicite:6]{index=6}
  if (!navigator.clipboard || typeof navigator.clipboard.read !== "function") {
    logLine("Async clipboard read not supported here. Use Ctrl+V instead.");
    return;
  }

  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imgType = (item.types || []).find((t) => t.startsWith("image/"));
      if (!imgType) continue;

      const blob = await item.getType(imgType);
      const file = new File([blob], "clipboard.png", { type: blob.type });
      await processImageFile(file);
      return;
    }
    logLine("Clipboard read worked, but no image was found.");
  } catch (err) {
    logLine(
      `Clipboard read failed: ${err?.name || "Error"} ${err?.message || ""}`
    );
  }
}

function wireUi() {
  document.addEventListener("paste", (e) => {
    handlePasteEvent(e).catch((err) =>
      logLine(`Paste error: ${err.message || err}`)
    );
  });

  els.fileInput.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    processImageFile(f).catch((err) =>
      logLine(`File error: ${err.message || err}`)
    );
  });

  els.dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
  });

  els.dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    processImageFile(f).catch((err) =>
      logLine(`Drop error: ${err.message || err}`)
    );
  });

  els.pasteBtn.addEventListener("click", () => {
    pasteViaButton().catch((err) =>
      logLine(`Paste button error: ${err.message || err}`)
    );
  });

  els.clearBtn.addEventListener("click", () => clearAll());

  logLine("Ready. Click the box and press Ctrl+V.");
}

wireUi();
