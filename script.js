/************************************************************
 * exAO – Analyse du mouvement d’une balle
 * Version : unique balle + couleur RGB (230,190,40)
 * Calibrage automatique : diamètre réel = 0.15 m
 * Ajout bouton "Ralenti analyse ×0.25"
 ************************************************************/

// --- Variables globales ---
let mediaRecorder;
let recordedChunks = [];
let recordedBlob = null;
let videoURL = null;

let pxToMeter = null;        // conversion pixels → mètres
const REAL_DIAM = 0.15;      // diamètre réel = 15 cm

let samples = [];            // mesures (t, x, y, v)
let slowMotionFactor = 1;    // 1 = normal ; 0.25 = ralenti

// --- Récupération des éléments DOM ---
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

// --- Chart.js graphiques ---
let posChart, velChart, fitChart;


/************************************************************
 * 1. Démarrage de la caméra
 ************************************************************/
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 }
    });
    preview.srcObject = stream;
  } catch (e) {
    alert("Erreur accès caméra");
  }
}
startCamera();


/************************************************************
 * 2. Enregistrement vidéo
 ************************************************************/
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


/************************************************************
 * 3. Import d’un fichier vidéo
 ************************************************************/
loadBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  recordedBlob = file;
  videoURL = URL.createObjectURL(file);
  processBtn.disabled = false;
  slowMoBtn.disabled = false;
});


/************************************************************
 * 4. Détection d’une balle (RGB ≈ 230,190,40)
 *    Utilise HSV plutôt que RGB direct
 ************************************************************/
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
      case r: h = (g - b) / d + (g < b ? 6 : 1); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h: h * 360, s, v };
}

function detectBall(imgData) {
  const data = imgData.data;
  const W = imgData.width;
  const H = imgData.height;

  let sumX = 0, sumY = 0, count = 0;

  const stride = 2;

  for (let y = 0; y < H; y += stride) {
    for (let x = 0; x < W; x += stride) {

      const i = (y * W + x) * 4;
      const r = data[i];
      const g = data[i+1];
      const b = data[i+2];

      const hsv = rgbToHsv(r, g, b);

      // Détection autour de RGB(230,190,40)
      const ok =
        hsv.h >= 30 && hsv.h <= 55 &&
        hsv.s >= 0.35 && hsv.s <= 0.75 &&
        hsv.v >= 0.55 && hsv.v <= 1.00;

      if (ok) {
        sumX += x;
        sumY += y;
        count++;
      }
    }
  }

  if (count === 0) return null;

  return {
    x: sumX / count,
    y: sumY / count
  };
}


/************************************************************
 * 5. Calibrage automatique (avec diamètre réel 15 cm)
 ************************************************************/
function autoCalibrateDiameter(imgData) {
  const W = imgData.width;
  const H = imgData.height;

  let pixels = [];

  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {

      const i = (y * W + x) * 4;
      const r = imgData.data[i];
      const g = imgData.data[i+1];
      const b = imgData.data[i+2];

      const hsv = rgbToHsv(r, g, b);
      const ok =
        hsv.h >= 30 && hsv.h <= 55 &&
        hsv.s >= 0.35 && hsv.s <= 0.75 &&
        hsv.v >= 0.55 && hsv.v <= 1.00;

      if (ok) pixels.push({x,y});
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


/************************************************************
 * 6. Traitement vidéo – VERSION CORRIGÉE
 ************************************************************/
processBtn.addEventListener("click", async () => {
  samples = [];

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

    // --- calibrage auto uniquement sur la première frame détectée ---
    if (!pxToMeter) {
      const cal = autoCalibrateDiameter(img);
      if (cal) pxToMeter = cal;
    }

    // --- détection balle ---
    const pos = detectBall(img);
    if (pos && pxToMeter) {
      samples.push({
        t: video.currentTime * slowMotionFactor,
        x: pos.x * pxToMeter,
        y: pos.y * pxToMeter
      });
    }

    // --- frame suivante ---
    video.currentTime += step;
    video.onseeked = processFrame;
  }

  // lancement
  video.currentTime = 0;
  video.onseeked = processFrame;
});

/************************************************************
 * 7. Calcul vitesses + régression
 ************************************************************/
function updateAll() {
  // calcul vitesses
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].t - samples[i-1].t;
    const dy = samples[i].y - samples[i-1].y;
    samples[i].v = dy / dt;
  }

  buildCharts();
}


/************************************************************
 * 8. Affichage Chart.js
 ************************************************************/
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
      datasets: [{
        label: "Position (m)",
        data: Y
      }]
    }
  });

  // Vitesse
  if (velChart) velChart.destroy();
  velChart = new Chart(document.getElementById("velChart"), {
    type: "line",
    data: {
      labels: T,
      datasets: [{
        label: "Vitesse (m/s)",
        data: V
      }]
    }
  });

  // Ajustement linéaire
  const a = regressionSlope(T, V);
  document.getElementById("regEquation").textContent =
    "v = " + a.toFixed(3) + "·t";

  if (fitChart) fitChart.destroy();
  fitChart = new Chart(document.getElementById("fitChart"), {
    type: "scatter",
    data: {
      datasets: [
        {
          label: "Vitesse",
          data: T.map((t,i)=>({x:t,y:V[i]}))
        },
        {
          label: "Ajustement",
          type: "line",
          data: T.map(t=>({x:t,y:a*t}))
        }
      ]
    }
  });
}

// régression simple
function regressionSlope(T, V) {
  let n = T.length;
  let sumT = 0, sumV = 0, sumTV = 0, sumT2 = 0;

  for (let i = 0; i < n; i++) {
    sumT += T[i];
    sumV += V[i];
    sumTV += T[i] * V[i];
    sumT2 += T[i] * T[i];
  }

  return (n * sumTV - sumT * sumV) / (n * sumT2 - sumT * sumT);
}


/************************************************************
 * 9. Bouton Ralenti analyse ×0.25
 ************************************************************/
slowMoBtn.addEventListener("click", () => {
  if (slowMotionFactor === 1) {
    slowMotionFactor = 0.25;
    slowMoBtn.textContent = "Ralenti analyse ×1 (normal)";
  } else {
    slowMotionFactor = 1;
    slowMoBtn.textContent = "Ralenti analyse ×0.25";
  }
});
