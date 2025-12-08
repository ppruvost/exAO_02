/************************************************************
 * script.js - Détection stable d'objet en mouvement + calcul de l'angle du rail
 * - Soustraction de fond + prétraitement (niveaux de gris + flou)
 * - Lissage temporel (moyenne mobile)
 * - Détection automatique de l'angle du rail noir sur fond blanc
 * - Filtre de Kalman 2D (x,y + vx,vy)
 ************************************************************/

/* -------------------------
   CONFIG
   ------------------------- */
const REAL_DIAM_M = 0.15; // 15 cm (diamètre réel de l'objet)
const MIN_PIXELS_FOR_DETECT = 40; // Nombre minimum de pixels pour valider une détection
const motionThreshold = 35; // Seuil de différence pour détecter le mouvement
const historyLength = 5; // Nombre de frames pour le lissage temporel
const blackThreshold = 60; // Seuil de luminosité pour détecter le rail noir

/* -------------------------
   STATE
   ------------------------- */
let recordedChunks = [];
let recordedBlob = null;
let videoURL = null;
let pxToMeter = null;
let samplesRaw = [];   // {t, x_px, y_px, x_m, y_m}
let samplesFilt = [];  // {t, x, y, vx, vy}
let slowMotionFactor = 1;
let mediaRecorder = null;
let videoStream = null;
let backgroundImageData = null;
let positionHistory = []; // Historique des positions pour le lissage
let railAngleDetected = false; // Pour éviter de recalculer l'angle à chaque frame

/* -------------------------
   DOM
   ------------------------- */
const preview = document.getElementById("preview");
const previewCanvas = document.getElementById("previewCanvas");
previewCanvas.width = 640;
previewCanvas.height = 480;
const ctx = previewCanvas.getContext("2d");
const startBtn = document.getElementById("startRecBtn");
const stopBtn = document.getElementById("stopRecBtn");
const loadBtn = document.getElementById("loadFileBtn");
const fileInput = document.getElementById("fileInput");
const processBtn = document.getElementById("processBtn");
const slowMoBtn = document.getElementById("slowMoBtn");
const frameStepMsInput = document.getElementById("frameStepMs");
const angleInput = document.getElementById("angleInput");
const recStateP = document.getElementById("recState");
const blobSizeP = document.getElementById("blobSize");
const nSamplesSpan = document.getElementById("nSamples");
const aEstimatedSpan = document.getElementById("aEstimated");
const aTheorySpan = document.getElementById("aTheory");
const regEquationP = document.getElementById("regEquation");
const exportCSVBtn = document.getElementById("exportCSVBtn");
const captureBgBtn = document.getElementById("captureBgBtn");

/* Charts */
let posChart = null;
let velChart = null;
let fitChart = null;
let positionChart = null;

/* -------------------------
   Utilities: RGB -> HSV
   ------------------------- */
function rgbToHsv(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const v = max;
  const d = max - min;
  s = max === 0 ? 0 : d / max;
  if (d !== 0) {
    if (max === r) {
      h = (g - b) / d + (g < b ? 6 : 0);
    } else if (max === g) {
      h = (b - r) / d + 2;
    } else {
      h = (r - g) / d + 4;
    }
    h *= 60;
  }
  return { h, s, v };
}

/* -------------------------
   Détection de l'angle du rail (noir sur fond blanc)
   ------------------------- */
function detectRailAngle(imgData) {
  const data = imgData.data;
  const W = imgData.width;
  const H = imgData.height;

  // Trouver les pixels noirs (rail)
  let railPixels = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const luminosity = (r + g + b) / 3;
      if (luminosity < blackThreshold) {
        railPixels.push({ x, y });
      }
    }
  }

  if (railPixels.length < 100) {
    console.error("Rail non détecté : trop peu de pixels noirs.");
    return null;
  }

  // Trouver les bords supérieurs et inférieurs du rail
  let minY = H;
  let maxY = 0;
  let minXForMinY = 0;
  let minXForMaxY = 0;

  for (const pixel of railPixels) {
    if (pixel.y < minY) {
      minY = pixel.y;
      minXForMinY = pixel.x;
    }
    if (pixel.y > maxY) {
      maxY = pixel.y;
      minXForMaxY = pixel.x;
    }
  }

  // Calculer l'angle du rail
  const deltaX = minXForMaxY - minXForMinY;
  const deltaY = maxY - minY;

  if (deltaY === 0) {
    console.error("Impossible de calculer l'angle : deltaY est nul.");
    return null;
  }

  // Calculer l'angle en radians puis en degrés (valeur absolue)
  const angleRad = Math.atan2(Math.abs(deltaX), Math.abs(deltaY));
  const angleDeg = angleRad * (180 / Math.PI);

  return angleDeg;
}

/* -------------------------
   Prétraitement de l'image (niveaux de gris + flou)
   ------------------------- */
function preprocessImage(imgData) {
  const data = imgData.data;
  const W = imgData.width;
  const H = imgData.height;
  const processedData = new Uint8ClampedArray(data.length);

  // Convertir en niveaux de gris
  for (let i = 0; i < data.length; i += 4) {
    const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
    processedData[i] = avg;
    processedData[i + 1] = avg;
    processedData[i + 2] = avg;
    processedData[i + 3] = data[i + 3];
  }

  // Appliquer un flou léger (3x3)
  const blurredData = new Uint8ClampedArray(processedData.length);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = (y * W + x) * 4;
      let sumR = 0, sumG = 0, sumB = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const neighborIdx = ((y + dy) * W + (x + dx)) * 4;
          sumR += processedData[neighborIdx];
          sumG += processedData[neighborIdx + 1];
          sumB += processedData[neighborIdx + 2];
        }
      }
      blurredData[i] = sumR / 9;
      blurredData[i + 1] = sumG / 9;
      blurredData[i + 2] = sumB / 9;
      blurredData[i + 3] = processedData[i + 3];
    }
  }

  return new ImageData(blurredData, W, H);
}

/* -------------------------
   Capture du fond
   ------------------------- */
function captureBackground() {
  ctx.drawImage(preview, 0, 0, previewCanvas.width, previewCanvas.height);
  const imgData = ctx.getImageData(0, 0, previewCanvas.width, previewCanvas.height);
  backgroundImageData = preprocessImage(imgData);
  console.log("Fond capturé et prétraité.");
}

/* -------------------------
   Lissage temporel (moyenne mobile)
   ------------------------- */
function smoothPosition(currentPos) {
  if (!currentPos) return null;
  positionHistory.push(currentPos);
  if (positionHistory.length > historyLength) {
    positionHistory.shift();
  }
  let sumX = 0;
  let sumY = 0;
  for (const pos of positionHistory) {
    sumX += pos.x;
    sumY += pos.y;
  }
  return {
    x: sumX / positionHistory.length,
    y: sumY / positionHistory.length,
    count: currentPos.count
  };
}

/* -------------------------
   Détection de mouvement avec seuil dynamique
   ------------------------- */
function detectMotion(currentImageData) {
  if (!backgroundImageData) {
    console.error("Aucun fond capturé.");
    return null;
  }

  const currentData = currentImageData.data;
  const bgData = backgroundImageData.data;
  const W = currentImageData.width;
  const H = currentImageData.height;

  // Calculer la moyenne et l'écart-type des différences
  let differences = [];
  for (let i = 0; i < currentData.length; i += 4) {
    const diff = Math.abs(currentData[i] - bgData[i]);
    differences.push(diff);
  }
  const meanDiff = differences.reduce((a, b) => a + b, 0) / differences.length;
  const stdDiff = Math.sqrt(differences.reduce((sq, n) => sq + Math.pow(n - meanDiff, 2), 0) / differences.length);
  const dynamicThreshold = meanDiff + 2 * stdDiff;

  // Détecter les pixels en mouvement
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const diff = Math.abs(currentData[i] - bgData[i]);
      if (diff > dynamicThreshold) {
        sumX += x;
        sumY += y;
        count++;
      }
    }
  }

  if (count < MIN_PIXELS_FOR_DETECT) return null;
  return { x: sumX / count, y: sumY / count, count };
}

/* -------------------------
   Calibration: estimation pixels->mètres
   ------------------------- */
function estimatePxToMeter(imgData) {
  if (!backgroundImageData) {
    console.error("Aucun fond capturé pour la calibration.");
    return null;
  }

  const processedImg = preprocessImage(imgData);
  const currentData = processedImg.data;
  const bgData = backgroundImageData.data;
  const W = processedImg.width;
  const H = processedImg.height;

  // Calculer la moyenne et l'écart-type des différences
  let differences = [];
  for (let i = 0; i < currentData.length; i += 4) {
    const diff = Math.abs(currentData[i] - bgData[i]);
    differences.push(diff);
  }
  const meanDiff = differences.reduce((a, b) => a + b, 0) / differences.length;
  const stdDiff = Math.sqrt(differences.reduce((sq, n) => sq + Math.pow(n - meanDiff, 2), 0) / differences.length);
  const dynamicThreshold = meanDiff + 2 * stdDiff;

  // Trouver les pixels de l'objet
  let found = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const diff = Math.abs(currentData[i] - bgData[i]);
      if (diff > dynamicThreshold) {
        found.push({ x, y });
      }
    }
  }

  if (found.length < 200) return null;

  // Calculer la boîte englobante
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of found) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  const diamPx = Math.max(maxX - minX, maxY - minY);
  if (diamPx <= 2) return null;
  return REAL_DIAM_M / diamPx;
}

/* -------------------------
   Filtre de Kalman 2D
   ------------------------- */
function createKalman() {
  let x = [[0], [0], [0], [0]];
  let P = identity(4, 1e3);
  const qPos = 1e-5;
  const qVel = 1e-3;
  const Q = [
    [qPos, 0, 0, 0],
    [0, qVel, 0, 0],
    [0, 0, qPos, 0],
    [0, 0, 0, qVel],
  ];
  const H = [[1, 0, 0, 0], [0, 0, 1, 0]];
  const R = [[1e-6, 0], [0, 1e-6]];

  function predict(dt) {
    const F = [
      [1, dt, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, dt],
      [0, 0, 0, 1],
    ];
    x = matMul(F, x);
    P = add(matMul(matMul(F, P), transpose(F)), Q);
  }

  function update(z) {
    const y_resid = sub(z, matMul(H, x));
    const S = add(matMul(matMul(H, P), transpose(H)), R);
    const K = matMul(matMul(P, transpose(H)), inv2x2(S));
    x = add(x, matMul(K, y_resid));
    const I = identity(4);
    P = matMul(sub(I, matMul(K, H)), P);
  }

  function setFromMeasurement(z) {
    x = [[z[0][0]], [0], [z[1][0]], [0]];
    P = identity(4, 1e-1);
  }

  function getState() {
    return { x: x[0][0], vx: x[1][0], y: x[2][0], vy: x[3][0] };
  }

  return { predict, update, getState, setFromMeasurement };
}

/* Matrix helpers */
function identity(n, scale = 1) {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? scale : 0))
  );
}

function transpose(A) {
  return A[0].map((_, c) => A.map(r => r[c]));
}

function matMul(A, B) {
  const aR = A.length;
  const aC = A[0].length;
  const bC = B[0].length;
  const C = Array.from({ length: aR }, () =>
    Array.from({ length: bC }, () => 0)
  );
  for (let i = 0; i < aR; i++) {
    for (let k = 0; k < aC; k++) {
      const aik = A[i][k];
      for (let j = 0; j < bC; j++) {
        C[i][j] += aik * B[k][j];
      }
    }
  }
  return C;
}

function add(A, B) {
  return A.map((row, i) => row.map((v, j) => v + B[i][j]));
}

function sub(A, B) {
  return A.map((row, i) => row.map((v, j) => v - B[i][j]));
}

function inv2x2(M) {
  const a = M[0][0];
  const b = M[0][1];
  const c = M[1][0];
  const d = M[1][1];
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return [[1e12, 0], [0, 1e12]];
  return [[d / det, -b / det], [-c / det, a / det]];
}

/* -------------------------
   Camera preview + overlay (real-time)
   ------------------------- */
async function startPreview() {
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 }
    });
    preview.srcObject = videoStream;
    previewLoop();
    return true;
  } catch (e) {
    console.error("Erreur accès caméra :", e);
    alert("Impossible d'accéder à la caméra. Vérifiez les permissions.");
    return false;
  }
}

function previewLoop() {
  if (preview.readyState >= 2) {
    ctx.drawImage(preview, 0, 0, previewCanvas.width, previewCanvas.height);
    const img = ctx.getImageData(0, 0, previewCanvas.width, previewCanvas.height);
    const processedImg = preprocessImage(img);

    if (!backgroundImageData) {
      // Optionnel : capturer automatiquement le fond
    } else {
      const pos = detectMotion(processedImg);
      if (pos) {
        const smoothedPos = smoothPosition(pos);
        if (smoothedPos) {
          ctx.beginPath();
          ctx.strokeStyle = "lime";
          ctx.lineWidth = 3;
          ctx.arc(smoothedPos.x, smoothedPos.y, 12, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
  }
  requestAnimationFrame(previewLoop);
}

/* -------------------------
   Recording handlers
   ------------------------- */
startBtn.addEventListener("click", async () => {
  if (!videoStream) {
    const success = await startPreview();
    if (!success) return;
  }
  recordedChunks = [];
  try {
    mediaRecorder = new MediaRecorder(videoStream, { mimeType: "video/webm;codecs=vp9" });
  } catch (e) {
    mediaRecorder = new MediaRecorder(videoStream);
  }
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size) recordedChunks.push(e.data);
  };
  mediaRecorder.onstop = () => {
    recordedBlob = new Blob(recordedChunks, { type: "video/webm" });
    videoURL = URL.createObjectURL(recordedBlob);
    processBtn.disabled = false;
    slowMoBtn.disabled = false;
    blobSizeP.textContent = `Vidéo enregistrée (${(recordedBlob.size / 1024 / 1024).toFixed(2)} MB)`;
  };
  mediaRecorder.start();
  recStateP.textContent = "État : enregistrement...";
  startBtn.disabled = true;
  stopBtn.disabled = false;
});

stopBtn.addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
    recStateP.textContent = "État : arrêté";
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
});

/* -------------------------
   Process recorded video (frame-by-frame)
   ------------------------- */
processBtn.addEventListener("click", async () => {
  if (!videoURL) {
    alert("Aucune vidéo. Enregistrez ou chargez un fichier.");
    return;
  }

  // Reset
  samplesRaw = [];
  samplesFilt = [];
  pxToMeter = null;
  positionHistory = [];
  railAngleDetected = false;
  nSamplesSpan.textContent = "0";
  aEstimatedSpan.textContent = "—";
  aTheorySpan.textContent = "—";
  regEquationP.textContent = "Équation : —";
  exportCSVBtn.disabled = true;

  const vid = document.createElement("video");
  vid.src = videoURL;
  vid.muted = true;

  await new Promise((res, rej) => {
    vid.onloadedmetadata = () => res();
    vid.onerror = (e) => rej(e);
  });

  const stepSec = Math.max(1, Number(frameStepMsInput.value) || 10) / 1000;
  const kf = createKalman();
  let initialized = false;
  let prevT = 0;

  function processFrame() {
    try {
      ctx.drawImage(vid, 0, 0, previewCanvas.width, previewCanvas.height);
      const img = ctx.getImageData(0, 0, previewCanvas.width, previewCanvas.height);

      // Détecter l'angle du rail une seule fois
      if (!railAngleDetected) {
        const railAngle = detectRailAngle(img);
        if (railAngle !== null) {
          angleInput.value = railAngle.toFixed(2);
          console.log("Angle du rail détecté :", railAngle, "degrés");
          railAngleDetected = true;
        } else {
          console.error("Échec de la détection de l'angle du rail.");
        }
      }

      const processedImg = preprocessImage(img);

      if (!pxToMeter) {
        const cal = estimatePxToMeter(img);
        if (cal) {
          pxToMeter = cal;
          const pxDisp = document.getElementById("pxToMeterDisplay");
          if (pxDisp) pxDisp.textContent = pxToMeter.toFixed(6) + " m/px";
        }
      }

      const pos = detectMotion(processedImg);
      const t = vid.currentTime * slowMotionFactor;

      if (pos) {
        const smoothedPos = smoothPosition(pos);
        if (smoothedPos) {
          const x_px = smoothedPos.x;
          const y_px = smoothedPos.y;
          const x_m = pxToMeter ? x_px * pxToMeter : NaN;
          const y_m = pxToMeter ? y_px * pxToMeter : NaN;

          samplesRaw.push({ t, x_px, y_px, x_m, y_m });

          if (pxToMeter && !isNaN(x_m) && !isNaN(y_m)) {
            const z = [[x_m], [y_m]];
            if (!initialized) {
              kf.setFromMeasurement(z);
              initialized = true;
              prevT = t;
            } else {
              const dt = Math.max(1e-3, t - prevT);
              kf.predict(dt);
              kf.update(z);
              prevT = t;
            }
            const st = kf.getState();
            samplesFilt.push({
              t,
              x: st.x,
              y: st.y,
              vx: st.vx,
              vy: st.vy,
            });
            nSamplesSpan.textContent = samplesRaw.length.toString();
          }
        }
      }

      if (vid.currentTime + 0.0001 < vid.duration) {
        vid.currentTime = Math.min(vid.duration, vid.currentTime + stepSec);
      } else {
        finalize();
        return;
      }
    } catch (err) {
      console.error("processFrame error", err);
      finalize();
      return;
    }
  }

  vid.onseeked = processFrame;
  vid.currentTime = 0;
});

/* -------------------------
   Finalize analysis: compute a, update charts
   ------------------------- */
function finalize() {
  console.log("Données filtrées :", samplesFilt);
  if (samplesFilt.length < 3) {
    alert("Données insuffisantes après filtrage.");
    return;
  }
  const T = samplesFilt.map((s) => s.t);
  const Y = samplesFilt.map((s) => s.y);
  const fit = fitQuadratic(T, Y);
  regEquationP.textContent = `y(t) = ${fit.a.toFixed(4)}·t² + ${fit.b.toFixed(4)}·t + ${fit.c.toFixed(4)}`;

  const aEst = 2 * fit.a;
  const alphaDeg = Number(angleInput.value) || 0;
  const aTheory = 9.81 * Math.sin((alphaDeg * Math.PI) / 180);

  aEstimatedSpan.textContent = aEst.toFixed(4);
  aTheorySpan.textContent = aTheory.toFixed(4);

  buildCharts(samplesFilt, aEst);
  setTimeout(() => buildPositionChart(samplesFilt, fit), 100);
  exportCSVBtn.disabled = false;
}

/* -------------------------
   Fit quadratic function (y = a*t^2 + b*t + c)
   ------------------------- */
function fitQuadratic(T, Y) {
  const n = T.length;
  let sumT = 0, sumT2 = 0, sumT3 = 0, sumT4 = 0;
  let sumY = 0, sumTY = 0, sumT2Y = 0;
  for (let i = 0; i < n; i++) {
    const t = T[i];
    const y = Y[i];
    const t2 = t * t;
    const t3 = t2 * t;
    const t4 = t3 * t;
    sumT += t;
    sumT2 += t2;
    sumT3 += t3;
    sumT4 += t4;
    sumY += y;
    sumTY += t * y;
    sumT2Y += t2 * y;
  }
  const A = [
    [sumT4, sumT3, sumT2],
    [sumT3, sumT2, sumT],
    [sumT2, sumT, n],
  ];
  const B = [sumT2Y, sumTY, sumY];
  const detA =
    A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) -
    A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) +
    A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
  const detA1 =
    B[0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) -
    A[0][1] * (B[1] * A[2][2] - A[1][2] * B[2]) +
    A[0][2] * (B[1] * A[2][1] - A[1][1] * B[2]);
  const detA2 =
    A[0][0] * (B[1] * A[2][2] - A[1][2] * B[2]) -
    B[0] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) +
    A[0][2] * (A[1][0] * B[2] - B[1] * A[2][0]);
  const detA3 =
    A[0][0] * (A[1][1] * B[2] - B[1] * A[2][1]) -
    A[0][1] * (A[1][0] * B[2] - B[1] * A[2][0]) +
    B[0] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
  const a = detA1 / detA;
  const b = detA2 / detA;
  const c = detA3 / detA;
  return { a, b, c };
}

/* -------------------------
   Build charts (filtered data)
   ------------------------- */
function buildCharts(filteredSamples, aEst) {
  const T = filteredSamples.map((s) => s.t);
  const Y = filteredSamples.map((s) => s.y);
  const V = filteredSamples.map((s) => Math.hypot(s.vx, s.vy));

  if (posChart) posChart.destroy();
  posChart = new Chart(document.getElementById("posChart"), {
    type: "line",
    data: { labels: T, datasets: [{ label: "Position filtrée y (m)", data: Y, borderColor: "cyan" }] },
    options: { scales: { x: { title: { display: true, text: "t (s)" } }, y: { title: { display: true, text: "y (m)" } } } },
  });

  if (velChart) velChart.destroy();
  velChart = new Chart(document.getElementById("velChart"), {
    type: "line",
    data: { labels: T, datasets: [{ label: "Vitesse filtrée (m/s)", data: V, borderColor: "magenta" }] },
    options: { scales: { x: { title: { display: true, text: "t (s)" } }, y: { title: { display: true, text: "v (m/s)" } } } },
  });

  const points = T.map((t, i) => ({ x: t, y: V[i] }));
  const fitLine = T.map((t) => ({ x: t, y: aEst * t }));

  if (fitChart) fitChart.destroy();
  fitChart = new Chart(document.getElementById("fitChart"), {
    type: "scatter",
    data: {
      datasets: [
        { label: "Vitesse filtrée", data: points, pointRadius: 3 },
        { label: "Ajustement v = a·t", data: fitLine, type: "line", borderColor: "orange" },
      ],
    },
    options: { scales: { x: { title: { display: true, text: "t (s)" } }, y: { title: { display: true, text: "v (m/s)" } } } },
  });
}

/* -------------------------
   Build position chart with quadratic fit (style MRUV)
   ------------------------- */
function buildPositionChart(samples, fit) {
  const T = samples.map((s) => s.t);
  const Y = samples.map((s) => s.y);
  const Y_fit = T.map((t) => fit.a * t * t + fit.b * t + fit.c);

  const ctx = document.getElementById("positionChart").getContext("2d");

  // Détruire le graphique précédent s'il existe
  if (positionChart) {
    positionChart.destroy();
  }

  // Créer le nouveau graphique avec Chart.js
  positionChart = new Chart(ctx, {
    type: "scatter",
    data: {
      datasets: [
        {
          label: "Position mesurée (y en m)",
          data: T.map((t, i) => ({ x: t, y: Y[i] })),
          borderColor: "blue",
          backgroundColor: "blue",
          showLine: false, // Ne pas relier les points mesurés
          pointRadius: 4,
          pointBackgroundColor: "blue",
        },
        {
          label: "Ajustement quadratique (y = a·t² + b·t + c)",
          data: T.map((t, i) => ({ x: t, y: Y_fit[i] })),
          borderColor: "red",
          backgroundColor: "red",
          showLine: true, // Relier les points pour la courbe ajustée
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.1, // Lissage léger de la courbe
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: "Position du mobile en fonction du temps (MRUV)",
          font: {
            size: 16,
          },
        },
        legend: {
          position: "top",
        },
      },
      scales: {
        x: {
          title: {
            display: true,
            text: "Temps (t) en secondes",
            font: {
              size: 14,
            },
          },
          grid: {
            display: true,
          },
        },
        y: {
          title: {
            display: true,
            text: "Position (y) en mètres",
            font: {
              size: 14,
            },
          },
          grid: {
            display: true,
          },
        },
      },
    },
  });

  // Afficher l'équation de la courbe ajustée
  const positionEquationElement = document.getElementById("positionEquation");
  positionEquationElement.textContent = `Équation : y(t) = ${fit.a.toFixed(4)}·t² + ${fit.b.toFixed(4)}·t + ${fit.c.toFixed(4)}`;
}

/* -------------------------
   Export CSV (filtered)
   ------------------------- */
exportCSVBtn.addEventListener("click", () => {
  if (!samplesFilt.length) {
    alert("Aucune donnée filtrée.");
    return;
  }
  const header = ["t(s)", "x(m)", "y(m)", "vx(m/s)", "vy(m/s)"];
  const rows = samplesFilt.map((s) => `${s.t.toFixed(4)},${s.x.toFixed(6)},${s.y.toFixed(6)},${s.vx.toFixed(6)},${s.vy.toFixed(6)}`);
  const csv = [header.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "exao_kalman_filtered.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
});

/* -------------------------
   Ralenti toggle
   ------------------------- */
slowMoBtn.addEventListener("click", () => {
  if (slowMotionFactor === 1) {
    slowMotionFactor = 0.25;
    slowMoBtn.textContent = "Ralenti ×1 (normal)";
  } else {
    slowMotionFactor = 1;
    slowMoBtn.textContent = "Ralenti ×0.25";
  }
});

/* -------------------------
   Bouton pour capturer le fond
   ------------------------- */
captureBgBtn.addEventListener("click", captureBackground);

// Initialisation
startPreview();
document.addEventListener('DOMContentLoaded', async () => {
  await startPreview();
});
