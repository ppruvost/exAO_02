/************************************************************
 * script.js - exAO_02 pack complet
 * - Détection couleur ~ RGB(230,190,40) (HSV)
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

/* -------------------------
   DOM
   ------------------------- */
const preview = document.getElementById("preview");
const previewCanvas = document.getElementById("previewCanvas");
previewCanvas.width = 640; previewCanvas.height = 480;
const ctx = previewCanvas.getContext("2d");

const startBtn = document.getElementById("startRecBtn");
const stopBtn  = document.getElementById("stopRecBtn");
const loadBtn  = document.getElementById("loadFileBtn");
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

/* Charts */
let posChart = null, velChart = null, fitChart = null;

/* -------------------------
   Utilities: RGB -> HSV
   ------------------------- */
function rgbToHsv(r,g,b){
  r/=255; g/=255; b/=255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h=0, s=0, v=max;
  const d = max - min;
  s = max === 0 ? 0 : d / max;
  if (d !== 0){
    if (max === r) h = (g - b)/d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r)/d + 2;
    else h = (r - g)/d + 4;
    h *= 60;
  }
  return {h, s, v};
}

/* -------------------------
   Detection: tuned HSV for light brown / ochre ~ (230,190,40)
   returns centroid {x,y,count} in pixel coordinates, or null
   ------------------------- */
function detectBall(imgData, stride=2){
  const data = imgData.data;
  const W = imgData.width, H = imgData.height;
  let sumX=0, sumY=0, count=0;

  for (let y=0; y<H; y+=stride){
    for (let x=0; x<W; x+=stride){
      const i = (y*W + x)*4;
      const r = data[i], g = data[i+1], b = data[i+2];
      const hsv = rgbToHsv(r,g,b);
      // thresholds (adjustable)
      const ok = hsv.h >= 28 && hsv.h <= 55 && hsv.s >= 0.22 && hsv.v >= 0.45;
      if (!ok) continue;
      if (r+g+b < 120) continue; // avoid dark spots
      sumX += x; sumY += y; count++;
    }
  }
  if (count < MIN_PIXELS_FOR_DETECT) return null;
  return { x: sumX/count, y: sumY/count, count };
}

/* -------------------------
   Calibration: estimate pixels->meters using bounding box of candidate pixels
   returns pxToMeter or null if not enough pixels
   ------------------------- */
function estimatePxToMeter(imgData){
  const data = imgData.data;
  const W = imgData.width, H = imgData.height;
  let found = [];
  for (let y=0;y<H;y++){
    for (let x=0;x<W;x++){
      const i = (y*W + x)*4;
      const r = data[i], g = data[i+1], b = data[i+2];
      const hsv = rgbToHsv(r,g,b);
      if (hsv.h >= 28 && hsv.h <= 55 && hsv.s >= 0.22 && hsv.v >= 0.45 && (r+g+b>120)){
        found.push({x,y});
      }
    }
  }
  if (found.length < 200) return null;
  let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
  for (const p of found){
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const diamPx = Math.max(maxX-minX, maxY-minY);
  if (diamPx <= 2) return null;
  return REAL_DIAM_M / diamPx;
}

/* -------------------------
   Simple Kalman 2D (state [x, vx, y, vy])
   We'll implement small matrix ops inside
   ------------------------- */
function createKalman(){
  // state x as 4x1 matrix
  let x = [[0],[0],[0],[0]];
  let P = identity(4, 1e3);
  const qPos = 1e-5, qVel = 1e-3;
  let Q = [
    [qPos,0,0,0],
    [0,qVel,0,0],
    [0,0,qPos,0],
    [0,0,0,qVel]
  ];
  const H = [ [1,0,0,0], [0,0,1,0] ]; // measure x,y
  let R = [ [1e-6,0], [0,1e-6] ];

  function predict(dt){
    const F = [
      [1, dt, 0, 0],
      [0, 1,  0, 0],
      [0, 0,  1, dt],
      [0, 0,  0, 1]
    ];
    x = matMul(F, x);
    P = add( matMul( matMul(F,P), transpose(F) ), Q );
  }
  function update(z){
    // z is 2x1 [[xm],[ym]]
    const y_resid = sub(z, matMul(H, x)); // 2x1
    const S = add( matMul( matMul(H, P), transpose(H) ), R ); // 2x2
    const K = matMul( matMul(P, transpose(H)), inv2x2(S) ); // 4x2
    x = add(x, matMul(K, y_resid));
    const I = identity(4);
    const KH = matMul(K, H); // 4x4
    P = matMul( sub(I, KH), P );
  }
  function setFromMeasurement(z){
    x = [[z[0][0]],[0],[z[1][0]],[0]];
    P = identity(4, 1e-1);
  }
  function getState(){
    return { x: x[0][0], vx: x[1][0], y: x[2][0], vy: x[3][0] };
  }
  return { predict, update, getState, setFromMeasurement };
}

/* Matrix helpers */
function identity(n, scale=1){
  return Array.from({length:n}, (_,i) => Array.from({length:n}, (_,j) => i===j ? scale : 0));
}
function transpose(A){ return A[0].map((_,c)=>A.map(r=>r[c])); }
function matMul(A,B){
  const aR=A.length, aC=A[0].length, bC=B[0].length;
  const C = Array.from({length:aR}, ()=>Array.from({length:bC}, ()=>0));
  for (let i=0;i<aR;i++){
    for (let k=0;k<aC;k++){
      const aik = A[i][k];
      for (let j=0;j<bC;j++){
        C[i][j] += aik * B[k][j];
      }
    }
  }
  return C;
}
function add(A,B){ return A.map((row,i)=>row.map((v,j)=>v + B[i][j])); }
function sub(A,B){ return A.map((row,i)=>row.map((v,j)=>v - B[i][j])); }
function inv2x2(M){
  const a=M[0][0], b=M[0][1], c=M[1][0], d=M[1][1];
  const det = a*d - b*c;
  if (Math.abs(det) < 1e-12) return [[1e12,0],[0,1e12]];
  return [[d/det, -b/det], [-c/det, a/det]];
}

/* -------------------------
   Camera preview + overlay (real-time)
   ------------------------- */
async function startPreview(){
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width:640, height:480 }});
    preview.srcObject = stream;
    // overlay loop
    setInterval(()=>{
      try{
        ctx.drawImage(preview, 0, 0, previewCanvas.width, previewCanvas.height);
        const img = ctx.getImageData(0,0,previewCanvas.width, previewCanvas.height);
        const pos = detectBall(img, 4);
        if (pos){
          ctx.beginPath();
          ctx.strokeStyle = "lime";
          ctx.lineWidth = 3;
          ctx.arc(pos.x, pos.y, 12, 0, Math.PI*2);
          ctx.stroke();
        }
      }catch(e){}
    }, 120);
  } catch(e){
    console.warn("preview failed", e);
  }
}
startPreview();

/* -------------------------
   Recording handlers
   ------------------------- */
startBtn.addEventListener("click", async ()=>{
  if (!preview.srcObject) {
    try { const s = await navigator.mediaDevices.getUserMedia({video:{width:640,height:480}}); preview.srcObject = s; }
    catch(e){ alert("Accès caméra refusé"); return; }
  }
  recordedChunks = [];
  try { mediaRecorder = new MediaRecorder(preview.srcObject, { mimeType: "video/webm;codecs=vp9" }); }
  catch(e){ mediaRecorder = new MediaRecorder(preview.srcObject); }
  mediaRecorder.ondataavailable = e => { if (e.data && e.data.size) recordedChunks.push(e.data); };
  mediaRecorder.onstop = ()=>{
    recordedBlob = new Blob(recordedChunks, { type:"video/webm" });
    videoURL = URL.createObjectURL(recordedBlob);
    processBtn.disabled = false; slowMoBtn.disabled = false;
    blobSizeP && (blobSizeP.textContent = `Vidéo enregistrée (${(recordedBlob.size/1024/1024).toFixed(2)} MB)`);
  };
  mediaRecorder.start();
  recStateP.textContent = "État : enregistrement...";
  startBtn.disabled = true; stopBtn.disabled = false;
});
stopBtn.addEventListener("click", ()=>{
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  recStateP.textContent = "État : arrêté";
  startBtn.disabled = false; stopBtn.disabled = true;
});
loadBtn.addEventListener("click", ()=> fileInput.click());
fileInput.addEventListener("change", ()=>{
  const f = fileInput.files[0];
  if (!f) return;
  recordedBlob = f;
  videoURL = URL.createObjectURL(f);
  processBtn.disabled = false; slowMoBtn.disabled = false;
  blobSizeP && (blobSizeP.textContent = `Fichier chargé (${(f.size/1024/1024).toFixed(2)} MB)`);
});

/* -------------------------
   Process recorded video (frame-by-frame)
   ------------------------- */
processBtn.addEventListener("click", async ()=>{
  if (!videoURL) { alert("Aucune vidéo. Enregistre ou charge un fichier."); return; }

  // reset
  samplesRaw = []; samplesFilt = []; pxToMeter = null;
  nSamplesSpan.textContent = "0";
  aEstimatedSpan.textContent = "—";
  aTheorySpan.textContent = "—";
  regEquationP.textContent = "Équation : —";
  exportCSVBtn.disabled = true;

  const vid = document.createElement("video");
  vid.src = videoURL;
  vid.muted = true;

  await new Promise((res,rej)=> { vid.onloadedmetadata = ()=> res(); vid.onerror = e=> rej(e); });

  const stepSec = Math.max(1, Number(frameStepMsInput.value) || 10)/1000;

  // Kalman
  const kf = createKalman();
  let initialized = false;
  let prevT = 0;

  // processing function
  function processFrame(){
    try {
      // draw
      ctx.drawImage(vid, 0, 0, previewCanvas.width, previewCanvas.height);
      const img = ctx.getImageData(0,0,previewCanvas.width, previewCanvas.height);

      // calibration
      if (!pxToMeter){
        const cal = estimatePxToMeter(img);
        if (cal) {
          pxToMeter = cal;
          // optional display
          const pxDisp = document.getElementById("pxToMeterDisplay");
          if (pxDisp) pxDisp.textContent = pxToMeter.toFixed(6) + " m/px";
        }
      }

      const pos = detectBall(img, 2);
      const t = vid.currentTime * slowMotionFactor;

      if (pos){
        const x_px = pos.x, y_px = pos.y;
        const x_m = pxToMeter ? x_px * pxToMeter : NaN;
        const y_m = pxToMeter ? y_px * pxToMeter : NaN;
        samplesRaw.push({t, x_px, y_px, x_m, y_m});

        // Kalman update if calibrated
        if (pxToMeter && Number.isFinite(x_m) && Number.isFinite(y_m)){
          const z = [[x_m],[y_m]];
          if (!initialized){
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
          samplesFilt.push({t, x: st.x, y: st.y, vx: st.vx, vy: st.vy});

          // overlay draw raw + filtered
          // raw (red)
          ctx.beginPath(); ctx.strokeStyle = "rgba(255,0,0,0.7)"; ctx.lineWidth = 2;
          ctx.arc(x_px, y_px, 6, 0, Math.PI*2); ctx.stroke();
          // filtered (cyan) convert meters back to px for overlay
          const fx_px = pxToMeter ? st.x / pxToMeter : st.x;
          const fy_px = pxToMeter ? st.y / pxToMeter : st.y;
          ctx.beginPath(); ctx.strokeStyle = "cyan"; ctx.lineWidth = 2;
          ctx.arc(fx_px, fy_px, 10, 0, Math.PI*2); ctx.stroke();

          nSamplesSpan.textContent = String(samplesRaw.length);
        }
      }

      // advance
      if (vid.currentTime + 0.0001 < vid.duration) {
        vid.currentTime = Math.min(vid.duration, vid.currentTime + stepSec);
      } else {
        // finished
        finalize();
        return;
      }
    } catch(err){
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
function finalize(){
  if (samplesFilt.length < 3){
    alert("Données insuffisantes après filtrage (vérifie détection / calibration).");
    return;
  }

  // compute speed magnitude from vx,vy
  const T = samplesFilt.map(s=>s.t);
  const V = samplesFilt.map(s=>Math.hypot(s.vx, s.vy));
  const Y = samplesFilt.map(s=>s.y);

  // constrained regression v = a * t (through origin)
  let num=0, den=0;
  for (let i=0;i<T.length;i++){
    if (Number.isFinite(V[i]) && Number.isFinite(T[i])){
      num += T[i]*V[i];
      den += T[i]*T[i];
    }
  }
  const aEst = den ? num/den : NaN;

  const alphaDeg = Number(angleInput.value) || 0;
  const aTheory = 9.8 * Math.sin(alphaDeg * Math.PI/180);

  aEstimatedSpan.textContent = Number.isFinite(aEst) ? aEst.toFixed(4) : "—";
  aTheorySpan.textContent = aTheory.toFixed(4);
  regEquationP.textContent = Number.isFinite(aEst) ? `v = ${aEst.toFixed(4)} · t` : "Équation : —";

  // charts
  buildCharts(samplesFilt, aEst);

  exportCSVBtn.disabled = false;
}

/* -------------------------
   Build charts (filtered data)
   ------------------------- */
function buildCharts(filteredSamples, aEst){
  const T = filteredSamples.map(s=>s.t);
  const Y = filteredSamples.map(s=>s.y);
  const V = filteredSamples.map(s=>Math.hypot(s.vx, s.vy));

  // position chart
  if (posChart) posChart.destroy();
  posChart = new Chart(document.getElementById("posChart"), {
    type: 'line',
    data: { labels: T, datasets: [{ label: 'Position filtrée y (m)', data: Y, borderColor:'cyan', fill:false }] },
    options: { scales:{ x:{ title:{display:true,text:'t (s)'} }, y:{ title:{display:true,text:'y (m)'} } } }
  });

  // velocity chart
  if (velChart) velChart.destroy();
  velChart = new Chart(document.getElementById("velChart"), {
    type: 'line',
    data: { labels: T, datasets: [{ label: 'Vitesse filtrée (m/s)', data: V, borderColor:'magenta', fill:false }] },
    options: { scales:{ x:{ title:{display:true,text:'t (s)'} }, y:{ title:{display:true,text:'v (m/s)'} } } }
  });

  // fit chart
  const points = T.map((t,i)=>({x:t, y: V[i]}));
  const fitLine = T.map(t => ({x:t, y: aEst * t}));

  if (fitChart) fitChart.destroy();
  fitChart = new Chart(document.getElementById("fitChart"), {
    type: 'scatter',
    data: {
      datasets: [
        { label: 'Vitesse filtrée', data: points, pointRadius:3 },
        { label: 'Ajustement v = a·t', data: fitLine, type:'line', borderColor:'orange', fill:false }
      ]
    },
    options: { scales:{ x:{ title:{display:true,text:'t (s)'} }, y:{ title:{display:true,text:'v (m/s)'} } } }
  });
}

/* -------------------------
   Export CSV (filtered)
   ------------------------- */
exportCSVBtn.addEventListener("click", ()=>{
  if (!samplesFilt.length) { alert("Aucune donnée filtrée."); return; }
  const header = ['t(s)','x(m)','y(m)','vx(m/s)','vy(m/s)'];
  const rows = samplesFilt.map(s => [s.t.toFixed(4), s.x.toFixed(6), s.y.toFixed(6), s.vx.toFixed(6), s.vy.toFixed(6)].join(','));
  const csv = [header.join(','), ...rows].join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'exao_kalman_filtered.csv';
  document.body.appendChild(a); a.click(); a.remove();
});

/* -------------------------
   Ralenti toggle
   ------------------------- */
slowMoBtn.addEventListener("click", ()=>{
  if (slowMotionFactor === 1) {
    slowMotionFactor = 0.25;
    slowMoBtn.textContent = "Ralenti ×1 (normal)";
  } else {
    slowMotionFactor = 1;
    slowMoBtn.textContent = "Ralenti ×0.25";
  }
});

/* -------------------------
   End of script
   ------------------------- */
