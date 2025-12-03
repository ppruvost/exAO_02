/************************************************************
 * exAO – Analyse du mouvement d’une balle (version A)
 * - Détection robuste couleur ~ RGB(230,190,40) (HSV)
 * - Calibrage automatique (diamètre réel = 0.15 m)
 * - Affichage overlay temps réel pendant prévisualisation
 * - Traitement vidéo frame-by-frame (stable)
 * - Filtre de Kalman 2D (x,y + vx,vy) pour lissage
 * - Graphiques: position brute / filtrée, vitesse filtrée, régression v = a·t
 * - Bouton "Ralenti analyse ×0.25"
 *
 * Important: nécessite Chart.js (inclus dans index.html)
 ************************************************************/

/* ---------------------------
   Config & variables globales
   --------------------------- */
const REAL_DIAM = 0.15; // m
let pxToMeter = null;

let recordedBlob = null;
let videoURL = null;
let recordedChunks = [];
let mediaRecorder = null;

let samplesRaw = [];   // {t, x_px, y_px, x_m, y_m}
let samplesFilt = [];  // {t, x, y, vx, vy} after Kalman
let slowMotionFactor = 1; // 1 normal, 0.25 ralenti

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

const nSamplesSpan = document.getElementById("nSamples");
const aEstimatedSpan = document.getElementById("aEstimated");
const aTheorySpan = document.getElementById("aTheory");
const regEquationP = document.getElementById("regEquation");

const exportCSVBtn = document.getElementById("exportCSVBtn");

// Charts
let posChart = null, velChart = null, fitChart = null;

/* ---------------------------
   Helpers: RGB→HSV
   --------------------------- */
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  let max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, v = max;
  const d = max - min;
  s = max === 0 ? 0 : d / max;
  if (d !== 0) {
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = h * 60;
  }
  return {h, s, v};
}

/* ---------------------------
   Détection robuste (HSV)
   ciblée autour de la couleur balle ~ (230,190,40)
   paramètres ajustés et filtrage du bruit
   --------------------------- */
function detectBall(imgData, sampleStride = 2) {
  const data = imgData.data;
  const W = imgData.width, H = imgData.height;
  let sumX = 0, sumY = 0, count = 0;

  // scanning with stride for speed
  for (let y = 0; y < H; y += sampleStride) {
    for (let x = 0; x < W; x += sampleStride) {
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i+1], b = data[i+2];
      const hsv = rgbToHsv(r, g, b);

      // tuned HSV for light brown / ochre (approx RGB 230,190,40)
      const ok =
        hsv.h >= 28 && hsv.h <= 55 &&
        hsv.s >= 0.25 && hsv.s <= 0.9 &&
        hsv.v >= 0.45;

      if (!ok) continue;
      // avoid very dark pixels
      if (r + g + b < 120) continue;

      sumX += x;
      sumY += y;
      count++;
    }
  }

  if (count < 40) return null; // not enough pixels → no detection

  return { x: sumX / count, y: sumY / count, count };
}

/* ---------------------------
   Calibration auto : estimate diameter in px and compute pxToMeter
   Strategy: find the bounding box of candidate pixels and take median across small local neighborhoods
   --------------------------- */
function estimatePxToMeter(imgData) {
  const data = imgData.data;
  const W = imgData.width, H = imgData.height;
  const pixels = [];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i+1], b = data[i+2];
      const hsv = rgbToHsv(r,g,b);
      const ok =
        hsv.h >= 28 && hsv.h <= 55 &&
        hsv.s >= 0.25 && hsv.v >= 0.45;
      if (ok) pixels.push({x,y});
    }
  }

  if (pixels.length < 200) return null;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  pixels.forEach(p => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  });

  const diamPx = Math.max(maxX - minX, maxY - minY);
  if (diamPx <= 2) return null;
  return REAL_DIAM / diamPx;
}

/* ---------------------------
   Kalman 2D implementation (state = [x, vx, y, vy])
   Simple discrete linear Kalman filter
   --------------------------- */
function createKalman() {
  // state vector: [x, vx, y, vy] column
  let x = math.zeros(4,1); // initial state (use mathjs-like simple arrays; we'll implement small matrix ops)
  // covariance matrix P (4x4)
  let P = identityMatrix(4, 1e3); // large initial uncertainty
  // process noise Q
  const qPos = 0.01; // position process noise
  const qVel = 0.5;  // velocity process noise
  let Q = [
    [qPos,0,0,0],
    [0,qVel,0,0],
    [0,0,qPos,0],
    [0,0,0,qVel]
  ];
  // measurement matrix H (we measure x and y)
  const H = [
    [1,0,0,0],
    [0,0,1,0]
  ];
  // measurement noise R
  let R = [
    [0.0004, 0],
    [0, 0.0004]
  ];

  function predict(dt) {
    // F matrix
    const F = [
      [1, dt, 0, 0],
      [0, 1,  0, 0],
      [0, 0,  1, dt],
      [0, 0,  0, 1]
    ];
    x = matMul(F, x);            // x = F x
    P = addMat(matMul(matMul(F, P), transpose(F)), Q); // P = F P F^T + Q
  }

  function update(z) {
    // z is [x_meas, y_meas] column
    const y_resid = subMat(z, matMul(H, x)); // innovation
    const S = addMat(matMul(matMul(H, P), transpose(H)), R); // S = H P H^T + R
    const K = matMul(matMul(P, transpose(H)), inv2x2(S)); // K = P H^T S^-1  (P 4x4, H^T 4x2 -> K 4x2)
    x = addMat(x, matMul(K, y_resid)); // x = x + K y
    const I = identityMatrix(4);
    const KH = matMul(K, H); // 4x4
    P = matMul(subMat(I, KH), P);
  }

  function getState() {
    return {
      x: x[0][0],
      vx: x[1][0],
      y: x[2][0],
      vy: x[3][0]
    };
  }

  function setStateFromMeasurement(z) {
    // Initialize state from first measurement
    x = [[z[0][0]],[0],[z[1][0]],[0]];
    P = identityMatrix(4, 1e-1);
  }

  return { predict, update, getState, setStateFromMeasurement };
}

/* ---------------------------
   Tiny matrix helpers (small matrices only)
   Represent matrices as arrays of arrays
   --------------------------- */
function identityMatrix(n, scale=1) {
  const M = Array.from({length:n}, (_,i) => Array.from({length:n}, (_,j) => (i===j?scale:0)));
  return M;
}
function transpose(A) {
  return A[0].map((_,c) => A.map(r => r[c]));
}
function matMul(A,B) {
  const aRows = A.length, aCols = A[0].length;
  const bRows = B.length, bCols = B[0].length;
  const C = Array.from({length:aRows}, () => Array.from({length:bCols}, () => 0));
  for (let i=0;i<aRows;i++){
    for (let k=0;k<aCols;k++){
      const aik = A[i][k];
      for (let j=0;j<bCols;j++){
        C[i][j] += aik * B[k][j];
      }
    }
  }
  return C;
}
function addMat(A,B) {
  const R = A.map((row,i) => row.map((v,j) => v + B[i][j]));
  return R;
}
function subMat(A,B) {
  const R = A.map((row,i) => row.map((v,j) => v - B[i][j]));
  return R;
}
// inverse for 2x2 matrix only
function inv2x2(M){
  const a = M[0][0], b = M[0][1], c = M[1][0], d = M[1][1];
  const det = a*d - b*c;
  if (Math.abs(det) < 1e-12) return [[1e12,0],[0,1e12]];
  const inv = [[d/det, -b/det], [-c/det, a/det]];
  return inv;
}

/* ---------------------------
   UI: start camera preview + overlay (real-time detection)
   --------------------------- */
async function startCameraPreview() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width:640, height:480 }});
    preview.srcObject = stream;
    // redraw overlay periodically
    setInterval(() => {
      try {
        ctx.drawImage(preview, 0, 0, previewCanvas.width, previewCanvas.height);
        const img = ctx.getImageData(0,0,previewCanvas.width, previewCanvas.height);
        const pos = detectBall(img, 3);
        if (pos) {
          ctx.beginPath();
          ctx.strokeStyle = "lime";
          ctx.lineWidth = 3;
          ctx.arc(pos.x, pos.y, 14, 0, Math.PI*2);
          ctx.stroke();
        }
      } catch(e){}
    }, 120);
  } catch(e){
    console.warn("Cam preview failed:", e);
  }
}
startCameraPreview();

/* ---------------------------
   Recording handlers
   --------------------------- */
startBtn.addEventListener("click", async () => {
  if (!preview.srcObject) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width:640, height:480 }});
      preview.srcObject = s;
    } catch(e){ alert("Impossible d'accéder à la caméra"); return; }
  }
  recordedChunks = [];
  const stream = preview.srcObject;
  try {
    mediaRecorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9" });
  } catch(e) {
    mediaRecorder = new MediaRecorder(stream);
  }
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recordedChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    recordedBlob = new Blob(recordedChunks, { type: "video/webm" });
    videoURL = URL.createObjectURL(recordedBlob);
    processBtn.disabled = false;
    slowMoBtn.disabled = false;
    document.getElementById("blobSize").textContent = `Vidéo enregistrée (${(recordedBlob.size/1024/1024).toFixed(2)} MB)`;
  };
  mediaRecorder.start();
  document.getElementById("recState").textContent = "État : enregistrement...";
  startBtn.disabled = true; stopBtn.disabled = false;
});
stopBtn.addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  document.getElementById("recState").textContent = "État : arrêté";
  startBtn.disabled = false; stopBtn.disabled = true;
});
loadBtn.addEventListener("click", ()=> fileInput.click());
fileInput.addEventListener("change", ()=> {
  const f = fileInput.files[0];
  if (!f) return;
  recordedBlob = f;
  videoURL = URL.createObjectURL(f);
  processBtn.disabled = false; slowMoBtn.disabled = false;
  document.getElementById("blobSize").textContent = `Fichier chargé (${(f.size/1024/1024).toFixed(2)} MB)`;
});

/* ---------------------------
   Core: process a recorded video frame-by-frame with Kalman smoothing
   --------------------------- */
processBtn.addEventListener("click", async () => {
  if (!videoURL) { alert("Aucune vidéo enregistrée ou chargée."); return; }

  // reset data
  samplesRaw = []; samplesFilt = [];
  pxToMeter = null;
  nSamplesSpan.textContent = "0";
  aEstimatedSpan.textContent = "—";
  aTheorySpan.textContent = "—";
  regEquationP.textContent = "Équation : —";

  const video = document.createElement("video");
  video.src = videoURL;
  video.muted = true;

  // ensure metadata loaded
  await new Promise((res,rej)=> {
    video.onloadedmetadata = ()=> res();
    video.onerror = (e)=> rej(e);
  });

  // we use stepping by currentTime increments to support variable frame rates
  const step = Math.max(1, Number(frameStepMs.value) || 10) / 1000; // seconds

  // Kalman instance
  const kf = createKalman();
  let firstMeasure = true;
  let prevT = 0;

  // frame processing function
  function processFrame() {
    try {
      // draw frame to canvas
      ctx.drawImage(video, 0, 0, previewCanvas.width, previewCanvas.height);
      const img = ctx.getImageData(0,0,previewCanvas.width, previewCanvas.height);

      // calibration if not done
      if (!pxToMeter) {
        const cal = estimatePxToMeter(img);
        if (cal) {
          pxToMeter = cal;
          document.getElementById("pxToMeterDisplay")?.textContent = pxToMeter.toFixed(6) + " m/px";
        }
      }

      // detect ball
      const pos = detectBall(img, 2);

      const t = video.currentTime * slowMotionFactor;

      if (pos) {
        const x_px = pos.x, y_px = pos.y;
        const x_m = pxToMeter ? x_px * pxToMeter : NaN;
        const y_m = pxToMeter ? y_px * pxToMeter : NaN;
        samplesRaw.push({t, x_px, y_px, x_m, y_m});

        // Kalman update
        if (pxToMeter && Number.isFinite(x_m) && Number.isFinite(y_m)) {
          const z = [[x_m],[y_m]];
          if (firstMeasure) {
            kf.setStateFromMeasurement(z);
            firstMeasure = false;
          } else {
            const dt = Math.max(1e-3, t - prevT);
            // predict with dt
            kf.predict(dt);
            kf.update(z);
          }
          const st = kf.getState();
          samplesFilt.push({t, x: st.x, y: st.y, vx: st.vx, vy: st.vy});
          prevT = t;

          // overlay filtered & raw
          // draw raw small circle (red)
          ctx.beginPath();
          ctx.strokeStyle = "rgba(255,0,0,0.7)";
          ctx.lineWidth = 2;
          ctx.arc(x_px, y_px, 6, 0, Math.PI*2);
          ctx.stroke();
          // draw filtered circle (cyan)
          ctx.beginPath();
          // convert filtered x (m) back to px for overlay on canvas
          const fx_px = pxToMeter ? (st.x / pxToMeter) : st.x;
          const fy_px = pxToMeter ? (st.y / pxToMeter) : st.y;
          ctx.strokeStyle = "cyan";
          ctx.lineWidth = 2;
          ctx.arc(fx_px, fy_px, 10, 0, Math.PI*2);
          ctx.stroke();

          nSamplesSpan.textContent = samplesRaw.length.toString();
        }
      }

      // advance frame
      if (video.currentTime + 0.0001 < video.duration) {
        video.currentTime = Math.min(video.duration, video.currentTime + step);
      } else {
        // finished
        finalizeAnalysis();
        return;
      }
    } catch (e) {
      console.error("processFrame error", e);
      finalizeAnalysis();
      return;
    }
  }

  // link handler
  video.onseeked = processFrame;
  // start at 0
  video.currentTime = 0;
});

/* ---------------------------
   Finalize: compute velocities, regression and draw charts
   --------------------------- */
function finalizeAnalysis() {
  if (samplesFilt.length < 3) {
    alert("Données insuffisantes après filtrage (vérifiez la détection / la calibration).");
    return;
  }

  // ensure velocities exist (kf provides vx,vy per sample)
  // compute scalar velocity along slope: use projection of velocity vector onto downhill direction
  // But simpler: use magnitude of vy projected (depends on orientation); here we'll compute speed magnitude
  const T = samplesFilt.map(s => s.t);
  const V = samplesFilt.map(s => Math.hypot(s.vx, s.vy));
  const Y = samplesFilt.map(s => s.y);

  // linear regression constrained to v = a * t (through origin)
  // compute a = sum(t*v) / sum(t^2)
  let num = 0, den = 0;
  for (let i=0;i<T.length;i++){
    if (Number.isFinite(V[i]) && Number.isFinite(T[i])) {
      num += T[i]*V[i];
      den += T[i]*T[i];
    }
  }
  const aEst = den ? num/den : NaN;

  // theoretical
  const alphaDeg = Number(angleInput.value) || 0;
  const aTheory = 9.8 * Math.sin(alphaDeg * Math.PI/180);

  // update DOM
  document.getElementById("aEstimated").textContent = Number.isFinite(aEst) ? aEst.toFixed(4) : "—";
  document.getElementById("aTheory").textContent = aTheory.toFixed(4);
  regEquationP.textContent = Number.isFinite(aEst) ? `v = ${aEst.toFixed(4)} · t` : "Équation : —";

  // build charts: position (filtered), velocity (filtered), fit
  buildChartsFromFiltered(samplesFilt, aEst);

  // enable CSV export
  exportCSVBtn.disabled = false;
}

/* ---------------------------
   Charts: display filtered vs raw
   --------------------------- */
function buildChartsFromFiltered(filteredSamples, aEst) {
  const T = filteredSamples.map(s => s.t);
  const Y = filteredSamples.map(s => s.y);
  const V = filteredSamples.map(s => Math.hypot(s.vx, s.vy));

  // Position chart (filtered)
  if (posChart) posChart.destroy();
  posChart = new Chart(document.getElementById("posChart"), {
    type: 'line',
    data: {
      labels: T,
      datasets: [
        { label: 'Position filtrée y (m)', data: Y, borderColor: 'cyan', fill:false },
      ]
    },
    options: { scales:{ x:{ title:{display:true,text:'t (s)'} }, y:{ title:{display:true,text:'y (m)'} } } }
  });

  // Velocity chart
  if (velChart) velChart.destroy();
  velChart = new Chart(document.getElementById("velChart"), {
    type: 'line',
    data: {
      labels: T,
      datasets: [
        { label: 'Vitesse filtrée (m/s)', data: V, borderColor: 'magenta', fill:false }
      ]
    },
    options: { scales:{ x:{ title:{display:true,text:'t (s)'} }, y:{ title:{display:true,text:'v (m/s)'} } } }
  });

  // Fit chart: scatter measured v vs t and fitted line
  const points = T.map((t,i)=>({x:t, y: V[i]}));
  const fitLine = T.map(t=>({x:t, y: aEst * t}));

  if (fitChart) fitChart.destroy();
  fitChart = new Chart(document.getElementById("fitChart"), {
    type: 'scatter',
    data: {
      datasets: [
        { label: 'Vitesse filtrée', data: points, pointRadius:3, showLine:false },
        { label: 'Ajustement v = a·t', data: fitLine, type:'line', borderColor:'orange', fill:false }
      ]
    },
    options: { scales:{ x:{ title:{display:true,text:'t (s)'} }, y:{ title:{display:true,text:'v (m/s)'} } } }
  });
}

/* ---------------------------
   CSV export (filtered data)
   --------------------------- */
exportCSVBtn.addEventListener("click", () => {
  if (!samplesFilt.length) { alert("Aucune donnée filtrée à exporter."); return; }
  const header = ['t (s)','x (m)','y (m)','vx (m/s)','vy (m/s)'];
  const rows = samplesFilt.map(s => [s.t.toFixed(4), s.x.toFixed(6), s.y.toFixed(6), s.vx.toFixed(6), s.vy.toFixed(6)].join(','));
  const csv = [header.join(','), ...rows].join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'exao_filtered_data.csv';
  document.body.appendChild(a); a.click(); a.remove();
});

/* ---------------------------
   Ralenti toggle
   --------------------------- */
slowMoBtn.addEventListener("click", () => {
  if (slowMotionFactor === 1) {
    slowMotionFactor = 0.25;
    slowMoBtn.textContent = "Ralenti analyse ×1 (normal)";
  } else {
    slowMotionFactor = 1;
    slowMoBtn.textContent = "Ralenti analyse ×0.25";
  }
});

/* ---------------------------
   matrix utility note:
   We used small matrix helpers in createKalman (matMul, addMat...).
   For brevity those helpers are embedded above inside createKalman() scope.
   If you copy elsewhere, ensure helpers are present.
   --------------------------- */

/* ---------------------------
   End of script
   --------------------------- */
