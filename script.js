/****************************************************
 *  script.js  — exAO v02 (version complète activée)
 *
 *  - conserve tes fonctions CSV/estimation
 *  - ajoute capture vidéo, enregistrement, traitement frames,
 *    background subtraction, calibration px->m, kalman 2D, export CSV
 ****************************************************/

/* ===================================================
   UTIL / EXISTING FUNCTIONS (from your original file)
=================================================== */
function loadCSV(file, callback) {
  const reader = new FileReader();
  reader.onload = function (e) {
    const text = e.target.result;
    const lines = text.split("\n");
    const samples = [];

    for (let line of lines) {
      const parts = line.trim().split(",");
      if (parts.length < 3) continue;

      const t = parseFloat(parts[0]);
      const x = parseFloat(parts[1]);
      const y = parseFloat(parts[2]);

      if (!isNaN(t) && !isNaN(x) && !isNaN(y)) {
        samples.push({ t, x, y });
      }
    }
    callback(samples);
  };
  reader.readAsText(file);
}

function extractAngleFromFilename(filename) {
  const match = filename.match(/(\d+)deg/i);
  if (!match) return null;
  return parseInt(match[1], 10);
}

function estimateAcceleration(samples) {
  if (samples.length < 3) return null;

  const v = [];

  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    if (dt <= 0) continue;

    const dx = samples[i].x - samples[i - 1].x;
    const vx = dx / dt;

    v.push({ t: samples[i].t, vx });
  }

  if (v.length < 2) return null;

  const n = v.length;
  let sumT = 0, sumV = 0, sumTV = 0, sumT2 = 0;

  for (let i = 0; i < n; i++) {
    const ti = v[i].t;
    const vi = v[i].vx;

    sumT += ti;
    sumV += vi;
    sumTV += ti * vi;
    sumT2 += ti * ti;
  }

  const denom = (n * sumT2 - sumT * sumT);
  const slope = denom === 0 ? 0 : (n * sumTV - sumT * sumV) / denom;

  return { vData: v, acceleration: slope };
}

function computeTheoreticalAcceleration(thetaDeg) {
  const g = 9.81;
  const theta = thetaDeg * Math.PI / 180;
  return g * Math.sin(theta);
}

let fitChartInstance = null;
function drawVelocityChart(vData, a_est) {
  const ctx = document.getElementById("fitChart").getContext("2d");

  const vPoints = vData.map(p => ({ x: p.t, y: p.vx }));

  const t0 = vData[0].t;
  const t1 = vData[vData.length - 1].t;

  const fitValues = [
    { x: t0, y: a_est * t0 },
    { x: t1, y: a_est * t1 }
  ];

  if (fitChartInstance) fitChartInstance.destroy();

  fitChartInstance = new Chart(ctx, {
    type: "scatter",
    data: {
      datasets: [
        {
          label: "Vitesse mesurée",
          data: vPoints,
          borderColor: "blue",
          backgroundColor: "blue",
          showLine: false,
          pointRadius: 3
        },
        {
          label: "Ajustement linéaire v = a·t",
          data: fitValues,
          borderColor: "red",
          borderWidth: 2,
          pointRadius: 0,
          type: "line"
        }
      ]
    },
    options: {
      responsive: true,
      scales: {
        x: { title: { display: true, text: "t (s)" } },
        y: { title: { display: true, text: "v (m/s)" } }
      }
    }
  });
}

/* ===================================================
   GLOBAL STATE
=================================================== */
let currentStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordedBlob = null;
let processingSamples = []; // {t, x_px, y_px}
let pxToM = null;
let bgImageData = null; // background for subtraction
let kalmanState = null; // {x, y, vx, vy, P}
const canvasPreview = document.getElementById("previewCanvas");
const ctxPreview = canvasPreview.getContext("2d");

/* ===================================================
   CAMERA: list + start (handles both preview & videoPreview IDs)
=================================================== */
async function listCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === "videoinput");

    const select = document.getElementById("cameraSelect");
    select.innerHTML = "";

    cams.forEach(cam => {
      const opt = document.createElement("option");
      opt.value = cam.deviceId;
      opt.textContent = cam.label || "Caméra";
      select.appendChild(opt);
    });

    if (cams.length > 0) {
      startCamera(cams[0].deviceId);
    }

    select.onchange = () => startCamera(select.value);

  } catch (e) {
    console.error("Erreur liste caméras :", e);
  }
}

async function startDefaultCamera() {
  try {
    // Request permission to ensure labels populate
    await navigator.mediaDevices.getUserMedia({ video: true });
    listCameras();
  } catch (e) {
    console.error("Permission caméra refusée", e);
  }
}

function getVideoElement() {
  // support both possible IDs
  return document.getElementById("videoPreview") || document.getElementById("preview");
}

async function startCamera(deviceId) {
  try {
    if (currentStream) {
      currentStream.getTracks().forEach(t => t.stop());
    }

    const constraints = deviceId
      ? { video: { deviceId: { exact: deviceId } } }
      : { video: true };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    currentStream = stream;

    const videoEl = getVideoElement();
    if (!videoEl) {
      console.error("Aucun élément <video> trouvé (id preview ou videoPreview).");
      return;
    }

    videoEl.srcObject = stream;
    await videoEl.play();

    // resize canvas to match video when metadata loaded
    videoEl.onloadedmetadata = () => {
      canvasPreview.width = videoEl.videoWidth;
      canvasPreview.height = videoEl.videoHeight;
      // clear bg preview
      ctxPreview.fillStyle = "#f5f5f5";
      ctxPreview.fillRect(0, 0, canvasPreview.width, canvasPreview.height);
    };

  } catch (e) {
    console.error("Erreur démarrage caméra :", e);
  }
}

/* ===================================================
   BUTTON EVENTS: capture bg, record, load video, slowmo, process, export
=================================================== */
document.getElementById("captureBgBtn").addEventListener("click", captureBackground);
document.getElementById("startRecBtn").addEventListener("click", startRecording);
document.getElementById("stopRecBtn").addEventListener("click", stopRecording);
document.getElementById("loadFileBtn").addEventListener("click", () => {
  document.getElementById("fileInput").value = null;
  document.getElementById("fileInput").click();
});
document.getElementById("fileInput").addEventListener("change", handleFileInput);
document.getElementById("slowMoBtn").addEventListener("click", toggleSlowMo);
document.getElementById("processBtn").addEventListener("click", processRecordedVideo);
document.getElementById("exportCSVBtn").addEventListener("click", exportSamplesCSV);

/* ===================================================
   CAPTURE BACKGROUND
=================================================== */
function captureBackground() {
  const videoEl = getVideoElement();
  if (!videoEl || videoEl.readyState < 2) {
    alert("Vidéo non prête : attends que la caméra démarre ou charge une vidéo.");
    return;
  }

  // draw current frame to canvas and store imageData
  ctxPreview.drawImage(videoEl, 0, 0, canvasPreview.width, canvasPreview.height);
  bgImageData = ctxPreview.getImageData(0, 0, canvasPreview.width, canvasPreview.height);

  document.getElementById("recState").textContent = "Fond capturé";
  console.log("Fond capturé");
}

/* ===================================================
   RECORDING (MediaRecorder)
=================================================== */
function startRecording() {
  if (!currentStream) {
    alert("Aucune caméra active à enregistrer.");
    return;
  }

  recordedChunks = [];
  try {
    mediaRecorder = new MediaRecorder(currentStream, { mimeType: "video/webm;codecs=vp8" });
  } catch (e) {
    mediaRecorder = new MediaRecorder(currentStream);
  }

  mediaRecorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size) recordedChunks.push(ev.data);
  };

  mediaRecorder.onstop = () => {
    recordedBlob = new Blob(recordedChunks, { type: "video/webm" });
    document.getElementById("processBtn").disabled = false;
    document.getElementById("recState").textContent = "Enregistrement arrêté — prêt pour traitement";
    console.log("Enregistrement terminé, blob prêt");
  };

  mediaRecorder.start();
  document.getElementById("recState").textContent = "Enregistrement en cours";
  document.getElementById("startRecBtn").disabled = true;
  document.getElementById("stopRecBtn").disabled = false;
  document.getElementById("slowMoBtn").disabled = true;
  console.log("Enregistrement démarré");
}

function stopRecording() {
  if (!mediaRecorder) return;
  mediaRecorder.stop();
  document.getElementById("startRecBtn").disabled = false;
  document.getElementById("stopRecBtn").disabled = true;
}

/* ===================================================
   LOAD VIDEO (from file input) + play in video element
=================================================== */
function handleFileInput(e) {
  const file = e.target.files[0];
  if (!file) return;

  const url = URL.createObjectURL(file);
  const videoEl = getVideoElement();
  videoEl.srcObject = null;
  videoEl.src = url;
  videoEl.play();

  // enable processing of loaded file
  recordedBlob = file;
  document.getElementById("processBtn").disabled = false;

  // try extract angle from filename if present
  const angleFromName = extractAngleFromFilename(file.name);
  if (angleFromName !== null) {
    window.currentAngleDeg = angleFromName;
    document.getElementById("rampAngleDisplay").textContent = "Angle de la rampe : " + angleFromName + "°";
    document.getElementById("angleInput").value = angleFromName;
  }
}

/* ===================================================
   SLOW MOTION (playback at 0.25 speed)
=================================================== */
let slowMoActive = false;
function toggleSlowMo() {
  const videoEl = getVideoElement();
  if (!videoEl) return;
  slowMoActive = !slowMoActive;
  videoEl.playbackRate = slowMoActive ? 0.25 : 1.0;
  document.getElementById("slowMoBtn").textContent = slowMoActive ? "Ralenti : ON ×0.25" : "Ralenti ×0.25";
}

/* ===================================================
   PROCESS VIDEO: decode frames, detect blob, collect samples
=================================================== */
async function processRecordedVideo() {
  if (!recordedBlob) {
    alert("Aucune vidéo à traiter (enregistrez ou chargez une vidéo).");
    return;
  }

  document.getElementById("processBtn").disabled = true;
  processingSamples = [];
  pxToM = null;
  kalmanState = null;

  // ask user for known real diameter (meters) default 0.06 (tennis ~0.065m)
  let realDiameterM = parseFloat(prompt("Diamètre réel de la balle en mètres (pour calibration). Laisser vide pour détecter automatiquement (ex: 0.06):", "0.06"));
  if (isNaN(realDiameterM) || realDiameterM <= 0) realDiameterM = null;

  // create offscreen video to step frames
  const offVideo = document.createElement("video");
  offVideo.muted = true;
  offVideo.playsInline = true;
  offVideo.src = (recordedBlob instanceof Blob) ? URL.createObjectURL(recordedBlob) : URL.createObjectURL(recordedBlob);
  await offVideo.play().catch(() => { /* some browsers need user gesture */ });

  // ensure canvas size matches video
  await new Promise(resolve => {
    if (offVideo.readyState >= 2) resolve();
    else offVideo.onloadedmetadata = () => resolve();
  });

  canvasPreview.width = offVideo.videoWidth;
  canvasPreview.height = offVideo.videoHeight;

  const frameStepMs = parseInt(document.getElementById("frameStepMs").value) || 10;
  const dtSec = frameStepMs / 1000;

  // We'll step through video by setting currentTime
  const duration = offVideo.duration;
  let t = 0;
  let detectedDiametersPx = [];

  // If no background captured, use first frame as background if user agrees
  if (!bgImageData) {
    const useFirstAsBG = confirm("Aucun fond capturé. Utiliser la première frame comme fond (recommandé si fond statique) ?");
    if (useFirstAsBG) {
      offVideo.currentTime = 0;
      await new Promise(res => {
        offVideo.onseeked = () => {
          ctxPreview.drawImage(offVideo, 0, 0, canvasPreview.width, canvasPreview.height);
          bgImageData = ctxPreview.getImageData(0, 0, canvasPreview.width, canvasPreview.height);
          res();
        };
      });
    }
  }

  // iterate frames
  for (let cur = 0; cur < duration; cur += dtSec) {
    // seek to cur
    offVideo.currentTime = cur;
    await new Promise(res => offVideo.onseeked = () => res());

    // draw frame
    ctxPreview.drawImage(offVideo, 0, 0, canvasPreview.width, canvasPreview.height);
    const frame = ctxPreview.getImageData(0, 0, canvasPreview.width, canvasPreview.height);

    // compute mask via background subtraction (if bg exists) else simple threshold on brightness
    const mask = new Uint8ClampedArray(canvasPreview.width * canvasPreview.height);
    if (bgImageData) {
      // bg subtraction
      const fgThreshold = 30; // tunable
      for (let i = 0, p = 0; i < frame.data.length; i += 4, p++) {
        const dr = Math.abs(frame.data[i] - bgImageData.data[i]);
        const dg = Math.abs(frame.data[i+1] - bgImageData.data[i+1]);
        const db = Math.abs(frame.data[i+2] - bgImageData.data[i+2]);
        const diff = (dr + dg + db) / 3;
        mask[p] = (diff > fgThreshold) ? 255 : 0;
      }
    } else {
      // brightness threshold fallback
      const brightThreshold = 200;
      for (let i = 0, p = 0; i < frame.data.length; i += 4, p++) {
        const lum = 0.2126*frame.data[i] + 0.7152*frame.data[i+1] + 0.0722*frame.data[i+2];
        mask[p] = (lum > brightThreshold) ? 255 : 0;
      }
    }

    // simple morphological: remove small noise by connected-component with area filter
    const { cx, cy, area } = detectLargestBlob(mask, canvasPreview.width, canvasPreview.height);

    if (cx !== null) {
      // save sample (pixel coordinates)
      processingSamples.push({ t: cur, x_px: cx, y_px: cy, area_px: area });
      if (area > 0) {
        const diameter_px = Math.sqrt(4 * area / Math.PI);
        detectedDiametersPx.push(diameter_px);
      }
    }

    // draw overlay: mask semi-transparent + centroid
    drawOverlay(mask, canvasPreview.width, canvasPreview.height, cx, cy);
  }

  // compute px->m
  if (realDiameterM) {
    // compute median detected diameter px
    if (detectedDiametersPx.length > 0) {
      const medianPx = median(detectedDiametersPx);
      pxToM = realDiameterM / medianPx;
      document.getElementById("pxToMeterDisplay").textContent = `Calibration automatique : 1 px = ${pxToM.toExponential(6)} m (base diam=${medianPx.toFixed(1)} px)`;
    } else {
      pxToM = null;
      document.getElementById("pxToMeterDisplay").textContent = `Calibration impossible (aucune détection de diamètre).`;
    }
  } else {
    // no real diameter provided -> try prompt fallback
    document.getElementById("pxToMeterDisplay").textContent = `Aucune calibration (les résultats seront en pixels).`;
  }

  // convert processingSamples to meters if pxToM exists
  const samples_m = processingSamples.map(s => {
    return {
      t: s.t,
      x: pxToM ? s.x_px * pxToM : s.x_px,
      y: pxToM ? s.y_px * pxToM : s.y_px
    };
  });

  // apply Kalman smoothing on samples_m
  const smoothSamples = applyKalman2D(samples_m);

  // If we have enough samples, auto-estimate acceleration using your function (assumes x along slope)
  document.getElementById("nSamples").textContent = smoothSamples.length;
  if (smoothSamples.length >= 3 && pxToM) {
    const result = estimateAcceleration(smoothSamples);
    if (result) {
      const a_est = result.acceleration;
      document.getElementById("accelEst").textContent = a_est.toFixed(3) + " m/s²";

      // estimate angle by PCA on positions (if angleInput not set)
      let thetaDeg = parseFloat(document.getElementById("angleInput").value) || 0;
      // set rampAngleDisplay from existing global if available
      if (!window.currentAngleDeg) {
        const anglePCA = computePrincipalAngleDeg(smoothSamples);
        if (anglePCA !== null) {
          window.currentAngleDeg = anglePCA;
          document.getElementById("rampAngleDisplay").textContent = "Angle (PCA) : " + anglePCA.toFixed(1) + "°";
          document.getElementById("angleInput").value = anglePCA.toFixed(1);
          thetaDeg = anglePCA;
        }
      }

      const a_theo = computeTheoreticalAcceleration(thetaDeg);
      document.getElementById("accelTheo").textContent = a_theo.toFixed(3) + " m/s²";

      // draw velocity chart using result.vData
      drawVelocityChart(result.vData, a_est);

    } else {
      document.getElementById("accelEst").textContent = "—";
    }
  } else {
    if (!pxToM) document.getElementById("accelEst").textContent = "N/A (pas de calibration)";
    else document.getElementById("accelEst").textContent = "—";
  }

  // store processed samples for export (meters if available)
  window.lastProcessedSamples = smoothSamples;

  document.getElementById("processBtn").disabled = false;
  document.getElementById("recState").textContent = "Traitement terminé";
  alert("Traitement terminé — échantillons : " + smoothSamples.length);
}

/* ===================================================
   EXPORT CSV
   Exports window.lastProcessedSamples as t,x,y (meters if calibrated else pixels)
=================================================== */
function exportSamplesCSV() {
  const samples = window.lastProcessedSamples || [];
  if (!samples || samples.length === 0) {
    alert("Aucun échantillon à exporter.");
    return;
  }

  let csv = "t,x,y\n";
  for (let s of samples) {
    csv += `${s.t.toFixed(6)},${s.x.toFixed(6)},${s.y.toFixed(6)}\n`;
  }

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "samples_export.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ===================================================
   SIMPLE IMAGE PROCESSING HELPERS
   - detectLargestBlob: connected components (4-neigh) -> returns centroid + area
   - drawOverlay: draws mask + centroid on canvas
=================================================== */
function detectLargestBlob(mask, w, h) {
  // mask: Uint8ClampedArray (0 or 255), length w*h
  const visited = new Uint8Array(w * h);
  const dirs = [-1, 1, -w, w];
  let largest = { area: 0, cx: null, cy: null };

  for (let i = 0; i < mask.length; i++) {
    if (visited[i] || mask[i] === 0) continue;

    // BFS
    let q = [i];
    visited[i] = 1;
    let sumX = 0, sumY = 0, count = 0;
    while (q.length) {
      const idx = q.pop();
      const y = Math.floor(idx / w);
      const x = idx % w;
      sumX += x;
      sumY += y;
      count++;

      // neighbors 4-connectivity
      const neighbors = [idx - 1, idx + 1, idx - w, idx + w];
      for (let nb of neighbors) {
        if (nb < 0 || nb >= mask.length) continue;
        if (visited[nb]) continue;
        if (mask[nb] === 0) continue;
        visited[nb] = 1;
        q.push(nb);
      }
    }

    if (count > largest.area) {
      largest = { area: count, cx: sumX / count, cy: sumY / count };
    }
  }

  return { cx: largest.cx, cy: largest.cy, area: largest.area };
}

function drawOverlay(mask, w, h, cx, cy) {
  // draw semi-transparent mask
  const img = ctxPreview.createImageData(w, h);
  for (let i = 0, p = 0; i < img.data.length; i += 4, p++) {
    const v = mask[p];
    img.data[i] = v; // r
    img.data[i+1] = 0; // g
    img.data[i+2] = 0; // b
    img.data[i+3] = v ? 80 : 0;
  }
  ctxPreview.putImageData(img, 0, 0);

  // draw centroid marker
  if (cx !== null) {
    ctxPreview.beginPath();
    ctxPreview.arc(cx, cy, 8, 0, Math.PI*2);
    ctxPreview.fillStyle = "lime";
    ctxPreview.fill();
    ctxPreview.lineWidth = 2;
    ctxPreview.strokeStyle = "black";
    ctxPreview.stroke();
  }
}

/* ===================================================
   KALMAN 2D simple implementation (constant velocity)
   Input samples: [{t,x,y}] -> returns smoothed samples same timestamps
=================================================== */
function applyKalman2D(samples) {
  if (!samples || samples.length === 0) return [];

  // state: [x, y, vx, vy]
  let dt0 = 0.02;
  kalmanState = {
    x: samples[0].x,
    y: samples[0].y,
    vx: 0,
    vy: 0,
    P: [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]
  };

  const Q = 1e-3; // process noise small
  const R = 1e-1; // measurement noise
  const out = [];

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const dt = i === 0 ? dt0 : Math.max(1e-3, s.t - samples[i-1].t);

    // predict
    const x_pred = kalmanState.x + kalmanState.vx * dt;
    const y_pred = kalmanState.y + kalmanState.vy * dt;
    const vx_pred = kalmanState.vx;
    const vy_pred = kalmanState.vy;

    // simple P growth
    // (we don't compute full matrix propagation here for simplicity)
    kalmanState.x = x_pred;
    kalmanState.y = y_pred;
    kalmanState.vx = vx_pred;
    kalmanState.vy = vy_pred;

    // update with measurement (x,y)
    // simple gain (like alpha filter depending on R)
    const k = 0.6; // blending factor (0-1) higher -> follow measurement
    kalmanState.x = kalmanState.x * (1-k) + s.x * k;
    kalmanState.y = kalmanState.y * (1-k) + s.y * k;

    // estimate velocity by finite difference on smoothed positions when possible
    if (out.length > 0) {
      const prev = out[out.length - 1];
      const dvx = (kalmanState.x - prev.x) / (s.t - prev.t);
      const dvy = (kalmanState.y - prev.y) / (s.t - prev.t);
      kalmanState.vx = dvx;
      kalmanState.vy = dvy;
    }

    out.push({ t: s.t, x: kalmanState.x, y: kalmanState.y });
  }

  return out;
}

/* ===================================================
   PCA principal angle estimation (samples in meters or pixels)
   Returns angle in degrees
=================================================== */
function computePrincipalAngleDeg(samples) {
  if (!samples || samples.length < 2) return null;
  // compute mean
  let mx = 0, my = 0;
  for (let s of samples) { mx += s.x; my += s.y; }
  mx /= samples.length; my /= samples.length;

  // covariance
  let Sxx = 0, Syy = 0, Sxy = 0;
  for (let s of samples) {
    const dx = s.x - mx, dy = s.y - my;
    Sxx += dx * dx;
    Syy += dy * dy;
    Sxy += dx * dy;
  }

  // principal eigenvector of [[Sxx, Sxy],[Sxy,Syy]]
  const theta = 0.5 * Math.atan2(2 * Sxy, Sxx - Syy);
  const deg = theta * 180 / Math.PI;
  return deg;
}

/* ===================================================
   SMALL HELPERS
=================================================== */
function median(arr) {
  if (!arr || arr.length === 0) return null;
  const s = arr.slice().sort((a,b)=>a-b);
  const m = Math.floor(s.length/2);
  return (s.length % 2 === 1) ? s[m] : 0.5*(s[m-1]+s[m]);
}

/* ===================================================
   INIT
=================================================== */
startDefaultCamera();

/* ===================================================
   FILE IMPORT CSV (keep your original listener)
   (this listener already existed in your file; keep it)
=================================================== */
const csvFileEl = document.getElementById("csvFile");
if (csvFileEl) {
  csvFileEl.addEventListener("change", function () {
    const file = this.files[0];
    if (!file) return;

    const angleFromName = extractAngleFromFilename(file.name);

    if (angleFromName !== null) {
      window.currentAngleDeg = angleFromName;
      document.getElementById("angleValue").textContent = angleFromName + "°";

      document.getElementById("rampAngleDisplay").textContent =
        "Angle de la rampe : " + angleFromName + "°";

      document.getElementById("angleInput").value = angleFromName;
    }

    loadCSV(file, (samples) => {
      const result = estimateAcceleration(samples);

      if (!result) {
        document.getElementById("accelEst").textContent = "—";
        alert("Impossible de calculer l'accélération : données insuffisantes");
        return;
      }

      const a_est = result.acceleration;
      const vData = result.vData;

      const thetaDeg = window.currentAngleDeg ?? 0;
      const a_theo = computeTheoreticalAcceleration(thetaDeg);

      document.getElementById("nSamples").textContent = samples.length;
      document.getElementById("accelEst").textContent = a_est.toFixed(3) + " m/s²";
      document.getElementById("accelTheo").textContent = a_theo.toFixed(3) + " m/s²";
      document.getElementById("angleValue").textContent = thetaDeg.toFixed(1) + "°";

      drawVelocityChart(vData, a_est);
    });
  });
}
