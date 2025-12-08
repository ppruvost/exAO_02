/************************************************************
 * script.js - Détection d'objet en mouvement par soustraction de fond
 * - Soustraction de fond pour détecter l'objet en mouvement
 * - Calibrage auto (diamètre = 0.15 m)
 * - Filtre de Kalman 2D (x,y + vx,vy)
 * - Overlay temps réel, traitement vidéo frame-by-frame
 * - Ralenti ×0.25, export CSV, Chart.js
 ************************************************************/

/* -------------------------
   CONFIG
   ------------------------- */
const REAL_DIAM_M = 0.15; // 15 cm
const MIN_PIXELS_FOR_DETECT = 40;
const motionThreshold = 40; // Seuil de différence de couleur pour détecter le mouvement

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
const captureBgBtn = document.getElementById("captureBgBtn"); // Bouton pour capturer le fond

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
   Capture du fond
   ------------------------- */
function captureBackground() {
  ctx.drawImage(preview, 0, 0, previewCanvas.width, previewCanvas.height);
  backgroundImageData = ctx.getImageData(0, 0, previewCanvas.width, previewCanvas.height);
  console.log("Fond capturé.");
}

/* -------------------------
   Détection de mouvement
   ------------------------- */
function detectMotion(currentImageData) {
  if (!backgroundImageData) {
    console.error("Aucun fond capturé. Utilisez captureBackground().");
    return null;
  }

  const currentData = currentImageData.data;
  const bgData = backgroundImageData.data;
  const W = currentImageData.width;
  const H = currentImageData.height;

  let sumX = 0;
  let sumY = 0;
  let count = 0;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;

      // Calculer la différence de couleur entre le fond et l'image actuelle
      const dr = Math.abs(currentData[i] - bgData[i]);
      const dg = Math.abs(currentData[i + 1] - bgData[i + 1]);
      const db = Math.abs(currentData[i + 2] - bgData[i + 2]);

      // Si la différence dépasse le seuil, considérer comme mouvement
      if (dr > motionThreshold || dg > motionThreshold || db > motionThreshold) {
        sumX += x;
        sumY += y;
        count++;
      }
    }
  }

  if (count < MIN_PIXELS_FOR_DETECT) {
    return null;
  }

  return { x: sumX / count, y: sumY / count, count };
}

/* -------------------------
   Calibration: estimate pixels->meters using bounding box of candidate pixels
   ------------------------- */
function estimatePxToMeter(imgData) {
  const data = imgData.data;
  const W = imgData.width;
  const H = imgData.height;
  let found = [];

  // Utiliser la soustraction de fond pour trouver les pixels de l'objet
  if (!backgroundImageData) {
    console.error("Aucun fond capturé pour la calibration.");
    return null;
  }

  const bgData = backgroundImageData.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const dr = Math.abs(data[i] - bgData[i]);
      const dg = Math.abs(data[i + 1] - bgData[i + 1]);
      const db = Math.abs(data[i + 2] - bgData[i + 2]);

      if (dr > motionThreshold || dg > motionThreshold || db > motionThreshold) {
        found.push({ x, y });
      }
    }
  }

  if (found.length < 200) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

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
   Simple Kalman 2D (state [x, vx, y, vy])
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
    const KH = matMul(K, H);
    P = matMul(sub(I, KH), P);
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
  return A[0].map((_, c) => A.map((r) => r[c]));
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
    alert("Impossible d'accéder à la caméra. Vérifiez les permissions ou utilisez un navigateur compatible (Chrome, Firefox, Edge).");
    return false;
  }
}

function previewLoop() {
  if (preview.readyState >= 2) {
    ctx.drawImage(preview, 0, 0, previewCanvas.width, previewCanvas.height);
    const img = ctx.getImageData(0, 0, previewCanvas.width, previewCanvas.height);

    if (!backgroundImageData) {
      // Optionnel : capturer automatiquement le fond après un délai
    } else {
      const pos = detectMotion(img);
      if (pos) {
        ctx.beginPath();
        ctx.strokeStyle = "lime";
        ctx.lineWidth = 3;
        ctx.arc(pos.x, pos.y, 12, 0, Math.PI * 2);
        ctx.stroke();
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

      if (!pxToMeter) {
        const cal = estimatePxToMeter(img);
        if (cal) {
          pxToMeter = cal;
          const pxDisp = document.getElementById("pxToMeterDisplay");
          if (pxDisp) pxDisp.textContent = pxToMeter.toFixed(6) + " m/px";
        }
      }

      const pos = detectMotion(img);
      const t = vid.currentTime * slowMotionFactor;

      if (pos) {
        const x_px = pos.x;
        const y_px = pos.y;
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
    alert("Données insuffisantes après filtrage (vérifiez la détection / calibration).");
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
  let sumT = 0;
  let sumT2 = 0;
  let sumT3 = 0;
  let sumT4 = 0;
  let sumY = 0;
  let sumTY = 0;
  let sumT2Y = 0;
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
    data: {
      labels: T,
      datasets: [
        {
          label: "Position filtrée y (m)",
          data: Y,
          borderColor: "cyan",
          fill: false,
        },
      ],
    },
    options: {
      scales: {
        x: { title: { display: true, text: "t (s)" } },
        y: { title: { display: true, text: "y (m)" } },
      },
    },
  });

  if (velChart) velChart.destroy();
  velChart = new Chart(document.getElementById("velChart"), {
    type: "line",
    data: {
      labels: T,
      datasets: [
        {
          label: "Vitesse filtrée (m/s)",
          data: V,
          borderColor: "magenta",
          fill: false,
        },
      ],
    },
    options: {
      scales: {
        x: { title: { display: true, text: "t (s)" } },
        y: { title: { display: true, text: "v (m/s)" } },
      },
    },
  });

  const points = T.map((t, i) => ({ x: t, y: V[i] }));
  const fitLine = T.map((t) => ({ x: t, y: aEst * t }));

  if (fitChart) fitChart.destroy();
  fitChart = new Chart(document.getElementById("fitChart"), {
    type: "scatter",
    data: {
      datasets: [
        {
          label: "Vitesse filtrée",
          data: points,
          pointRadius: 3,
        },
        {
          label: "Ajustement v = a·t",
          data: fitLine,
          type: "line",
          borderColor: "orange",
          fill: false,
        },
      ],
    },
    options: {
      scales: {
        x: { title: { display: true, text: "t (s)" } },
        y: { title: { display: true, text: "v (m/s)" } },
      },
    },
  });
}

/* -------------------------
   Build position chart with quadratic fit
   ------------------------- */
function buildPositionChart(samples, fit) {
  const T = samples.map((s) => s.t);
  const Y = samples.map((s) => s.y);
  const Y_fit = T.map((t) => fit.a * t * t + fit.b * t + fit.c);
  const ctx = document.getElementById("positionChart").getContext("2d");

  if (positionChart) {
    positionChart.destroy();
  }

  positionChart = new Chart(ctx, {
    type: "scatter",
    data: {
      datasets: [
        {
          label: "Position mesurée (y en m)",
          data: T.map((t, i) => ({ x: t, y: Y[i] })),
          borderColor: "blue",
          backgroundColor: "blue",
          showLine: false,
          pointRadius: 4,
        },
        {
          label: "Ajustement quadratique (y = a·t² + b·t + c)",
          data: T.map((t, i) => ({ x: t, y: Y_fit[i] })),
          borderColor: "red",
          backgroundColor: "red",
          showLine: true,
          pointRadius: 0,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      scales: {
        x: {
          title: {
            display: true,
            text: "Temps (s)",
          },
        },
        y: {
          title: {
            display: true,
            text: "Position (m)",
          },
        },
      },
    },
  });

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
  const rows = samplesFilt.map(
    (s) =>
      `${s.t.toFixed(4)},${s.x.toFixed(6)},${s.y.toFixed(6)},${s.vx.toFixed(
        6
      )},${s.vy.toFixed(6)}`
  );
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
