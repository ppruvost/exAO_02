/************************************************************
 * exAO – Analyse du mouvement d’une balle
 * Version optimisée – robuste – détection améliorée HSV
 * Affichage temps réel de la détection
 * Calibrage automatique : diamètre réel = 0.15 m
 * Ajout bouton "Ralenti analyse ×0.25"
 ************************************************************/

/* ==========================================================
   0. Variables globales
   ========================================================== */
let mediaRecorder;
let recordedChunks = [];
let recordedBlob = null;
let videoURL = null;

let pxToMeter = null;
const REAL_DIAM = 0.15;

let samples = [];
let slowMotionFactor = 1;

// DOM
const preview = document.getElementById("preview");
const previewCanvas = document.getElementById("previewCanvas");
const ctx = previewCanvas.getContext("2d");

const startBtn = document.getElementById("startRecBtn");
const stopBtn = document.getElementById("stopRecBtn");
const loadBtn = document.getElementById("loadFileBtn");
const fileInput = document.getElementById("fileInput");
const processBtn = document.getElementById("processBtn");
const slowMoBtn = document.getElementById("slowMoBtn");

const frameStepMs = document.getElementById("frameStepMs");
const angleInput = document.getElementById("angleInput");

let posChart = null, velChart = null, fitChart = null;


/* ==========================================================
   1. Caméra + prévisualisation + overlay détection temps réel
   ========================================================== */
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 }
    });
    preview.srcObject = stream;

    // overlay temps réel
    setInterval(() => {
      ctx.drawImage(preview, 0, 0);
      const img = ctx.getImageData(0, 0, previewCanvas.width, previewCanvas.height);
      const pos = detectBall(img);

      if (pos) {
        ctx.beginPath();
        ctx.strokeStyle = "yellow";
        ctx.lineWidth = 3;
        ctx.arc(pos.x, pos.y, 12, 0, Math.PI * 2);
        ctx.stroke();
      }
    }, 100);

  } catch (e) {
    alert("Erreur accès caméra : " + e.message);
  }
}
startCamera();


/* ==========================================================
   2. Enregistrement vidéo
   ========================================================== */
startBtn.addEventListener("click", () => {
  const stream = preview.srcObject;
  recordedChunks = [];

  mediaRecorder = new MediaRecorder(stream, { mimeType: "video/webm" });

  mediaRecorder.ondataavailable = e => recordedChunks.push(e.data);

  mediaRecorder.onstop = () => {
    recordedBlob = new Blob(recordedChunks, { type: "video/webm" });
    videoURL = URL.createObjectURL(recordedBlob);
    processBtn.disabled = false;
    slowMoBtn.disabled = false;
  };

  mediaRecorder.start();
  document.getElementById("recState").textContent = "État : enregistrement…";

  startBtn.disabled = true;
  stopBtn.disabled = false;
});

stopBtn.addEventListener("click", () => {
  mediaRecorder.stop();
  document.getElementById("recState").textContent = "État : arrêté";
  startBtn.disabled = false;
  stopBtn.disabled = true;
});


/* ==========================================================
   3. Import vidéo depuis fichier
   ========================================================== */
loadBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;

  recordedBlob = file;
  videoURL = URL.createObjectURL(file);
  processBtn.disabled = false;
  slowMoBtn.disabled = false;
});


/* ==========================================================
   4. Détection robuste de la balle (couleur RGB ≈ 230,190,40)
   ========================================================== */
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;

  let max = Math.max(r, g, b),
      min = Math.min(r, g, b);
  let h, s, v = max;

  let d = max - min;
  s = max === 0 ? 0 : d / max;

  if (max === min) h = 0;
  else {
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s, v };
}


// Détection solide avec élimination des faux pixels
function detectBall(imgData) {
  const data = imgData.data;
  const W = imgData.width;
  const H = imgData.height;

  let sumX = 0, sumY = 0, count = 0;

  const stride = 2;

  for (let y = 0; y < H; y += stride) {
    for (let x = 0; x < W; x += stride) {

      const i = (y * W + x) * 4;
      const r = data[i], g = data[i+1], b = data[i+2];

      const hsv = rgbToHsv(r, g, b);

      const ok =
        hsv.h >= 32 && hsv.h <= 55 &&  // gamme resserrée
        hsv.s >= 0.30 && hsv.s <= 0.85 &&
        hsv.v >= 0.50;

      if (!ok) continue;

      // prévention bruit : éliminer très petits clusters
      if (r + g + b < 120) continue;

      sumX += x;
      sumY += y;
      count++;
    }
  }

  if (count < 40) return null;

  return { x: sumX / count, y: sumY / count };
}


/* ==========================================================
   5. Calibrage automatique basé sur diamètre 15 cm
   ========================================================== */
function autoCalibrateDiameter(imgData) {
  const W = imgData.width, H = imgData.height;
  const pixels = [];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {

      const i = (y * W + x) * 4;
      const r = imgData.data[i];
      const g = imgData.data[i+1];
      const b = imgData.data[i+2];

      const hsv = rgbToHsv(r, g, b);
      const ok =
        hsv.h >= 32 && hsv.h <= 55 &&
        hsv.s >= 0.30 &&
        hsv.v >= 0.50;

      if (ok) pixels.push({ x, y });
    }
  }

  if (pixels.length < 50) return null;

  let minX = Infinity, maxX = -1;
  let minY = Infinity, maxY = -1;

  for (let p of pixels) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  const diameterPx = Math.max(maxX - minX, maxY - minY);
  return REAL_DIAM / diameterPx;
}


/* ==========================================================
   6. Analyse d’une vidéo enregistrée – version robuste
   ========================================================== */
processBtn.addEventListener("click", async () => {

  samples = [];
  pxToMeter = null;

  const video = document.createElement("video");
  video.src = videoURL;
  video.muted = true;

  await video.play();
  video.pause();

  const step = Number(frameStepMs.value) / 1000;

  function processFrame() {

    if (video.currentTime >= video.duration) {
      updateAll();
      return;
    }

    ctx.drawImage(video, 0, 0);
    const img = ctx.getImageData(0, 0, previewCanvas.width, previewCanvas.height);

    // Calibrage automatique une seule fois
    if (!pxToMeter) {
      const cal = autoCalibrateDiameter(img);
      if (cal) pxToMeter = cal;
    }

    // Détection balle
    const pos = detectBall(img);
    if (pos && pxToMeter) {
      samples.push({
        t: video.currentTime * slowMotionFactor,
        x: pos.x * pxToMeter,
        y: pos.y * pxToMeter
      });

      // affichage overlay
      ctx.beginPath();
      ctx.strokeStyle = "cyan";
      ctx.lineWidth = 3;
      ctx.arc(pos.x, pos.y, 12, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Frame suivante
    video.currentTime += step;
  }

  video.onseeked = processFrame;
  video.currentTime = 0;
});


/* ==========================================================
   7. Calcul vitesses + régression
   ========================================================== */
function updateAll() {

  // vitesse
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].t - samples[i-1].t;
    if (dt > 0)
      samples[i].v = (samples[i].y - samples[i-1].y) / dt;
  }

  buildCharts();
}


/* ==========================================================
   8. Graphiques Chart.js
   ========================================================== */
function buildCharts() {

  const T = samples.map(s => s.t);
  const Y = samples.map(s => s.y);
  const V = samples.map(s => s.v);

  // Position
  if (posChart) posChart.destroy();
  posChart = new Chart(document.getElementById("posChart"), {
    type: "line",
    data: {
      labels: T,
      datasets: [{ label: "Position (m)", data: Y }]
    }
  });

  // Vitesse
  if (velChart) velChart.destroy();
  velChart = new Chart(document.getElementById("velChart"), {
    type: "line",
    data: {
      labels: T,
      datasets: [{ label: "Vitesse (m/s)", data: V }]
    }
  });

  // Régression
  const a = regressionSlope(T, V);
  document.getElementById("regEquation").textContent =
    "v = " + a.toFixed(4) + "·t";

  const angle = Number(angleInput.value);
  const aTheory = 9.8 * Math.sin(angle * Math.PI/180);
  document.getElementById("aTheory").textContent = aTheory.toFixed(4);
  document.getElementById("aEstimated").textContent = a.toFixed(4);

  if (fitChart) fitChart.destroy();
  fitChart = new Chart(document.getElementById("fitChart"), {
    type: "scatter",
    data: {
      datasets: [
        { label: "Vitesse", data: T.map((t,i)=>({x:t,y:V[i]})) },
        { label: "Ajustement", type: "line", data: T.map(t=>({x:t,y:a*t})) }
      ]
    }
  });
}


// régression simple y = a·t
function regressionSlope(T, V) {
  let n = T.length;
  let sumT=0, sumV=0, sumTV=0, sumT2=0;

  for (let i=0; i<n; i++) {
    if (!Number.isFinite(V[i])) continue;
    sumT += T[i];
    sumV += V[i];
    sumTV += T[i]*V[i];
    sumT2 += T[i]*T[i];
  }

  return (n*sumTV - sumT*sumV) / (n*sumT2 - sumT*sumT);
}


/* ==========================================================
   9. Bouton ralenti ×0.25
   ========================================================== */
slowMoBtn.addEventListener("click", () => {
  if (slowMotionFactor === 1) {
    slowMotionFactor = 0.25;
    slowMoBtn.textContent = "Ralenti analyse ×1 (normal)";
  } else {
    slowMotionFactor = 1;
    slowMoBtn.textContent = "Ralenti analyse ×0.25";
  }
});
