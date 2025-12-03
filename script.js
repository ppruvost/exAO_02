
/* script.js
   Version complète:
   - Enregistre la caméra (MediaRecorder)
   - Prend le Blob vidéo -> traite frame-by-frame (requestVideoFrameCallback si dispo)
   - Détection couleur (HSV) pour balle verte & rose
   - Calibrage px->m via deux clicks
   - Calcul position, vitesses, régression (contrainte a via v=a*t and free linear fit v=a*t+b)
   - Trace pos, vel et droite d'ajustement, affiche équation + R^2
*/

const preview = document.getElementById('preview');
const previewCanvas = document.getElementById('previewCanvas');
const pCtx = previewCanvas.getContext('2d');

const startRecBtn = document.getElementById('startRecBtn');
const stopRecBtn  = document.getElementById('stopRecBtn');
const loadFileBtn  = document.getElementById('loadFileBtn');
const fileInput = document.getElementById('fileInput');
const processBtn = document.getElementById('processBtn');

const angleInput = document.getElementById('angleInput');
const frameStepMsInput = document.getElementById('frameStepMs');
const scaleMetersInput = document.getElementById('scaleMeters');
const calibrateBtn = document.getElementById('calibrateBtn');

const recStateP = document.getElementById('recState');
const blobSizeP = document.getElementById('blobSize');

const nSamplesSpan = document.getElementById('nSamples');
const aEstimatedSpan = document.getElementById('aEstimated');
const aTheorySpan = document.getElementById('aTheory');
const dataTableBody = document.querySelector('#dataTable tbody');
const exportCSVBtn = document.getElementById('exportCSVBtn');

const regEquationP = document.getElementById('regEquation');

let mediaStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordedBlob = null;

let pxToMeter = null; // calibration
let calibrateClicks = null;

let samples = [];
let posChart = null, velChart = null, fitChart = null;

// ---------- init camera ----------
async function initCamera() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
    preview.srcObject = mediaStream;
    await preview.play();
    recStateP.textContent = 'État : caméra prête';
  } catch (err) {
    alert('Erreur accès caméra: ' + err.message);
    console.error(err);
  }
}
initCamera();

// ---------- recording ----------
startRecBtn.addEventListener('click', async () => {
  if (!mediaStream) { await initCamera(); if (!mediaStream) return; }
  recordedChunks = [];
  let options = { mimeType: 'video/webm;codecs=vp9' };
  try { mediaRecorder = new MediaRecorder(mediaStream, options); }
  catch(e) { mediaRecorder = new MediaRecorder(mediaStream); }
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recordedChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    recordedBlob = new Blob(recordedChunks, { type: 'video/webm' });
    blobSizeP.textContent = `Vidéo enregistrée — taille: ${(recordedBlob.size/1024/1024).toFixed(2)} MB`;
    processBtn.disabled = false;
  };
  mediaRecorder.start();
  recStateP.textContent = 'État : enregistrement...';
  startRecBtn.disabled = true;
  stopRecBtn.disabled = false;
});

stopRecBtn.addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  recStateP.textContent = 'État : enregistrement arrêté';
  startRecBtn.disabled = false;
  stopRecBtn.disabled = true;
});

loadFileBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  recordedBlob = f;
  blobSizeP.textContent = `Fichier chargé — taille: ${(f.size/1024/1024).toFixed(2)} MB`;
  processBtn.disabled = false;
});

// calibration
calibrateBtn.addEventListener('click', () => {
  calibrateClicks = [];
  alert('Cliquez 2 points sur la vidéo pour définir la distance connue (p.ex. 0.5 m)');
});
previewCanvas.addEventListener('click', (e) => {
  if (calibrateClicks === null) return;
  const rect = previewCanvas.getBoundingClientRect();
  calibrateClicks.push({x: e.clientX - rect.left, y: e.clientY - rect.top});
  if (calibrateClicks.length === 2) {
    const dx = calibrateClicks[0].x - calibrateClicks[1].x;
    const dy = calibrateClicks[0].y - calibrateClicks[1].y;
    const distPx = Math.hypot(dx, dy);
    const meters = parseFloat(scaleMetersInput.value);
    if (!meters || meters <= 0) { alert('Entrez une distance (m) valide'); calibrateClicks = null; return; }
    pxToMeter = meters / distPx;
    alert(`Calibré : ${distPx.toFixed(1)} px = ${meters} m → pxToMeter = ${pxToMeter.toFixed(6)}`);
    calibrateClicks = null;
  } else {
    alert('Point 1 enregistré, cliquez le point 2.');
  }
});

// preview draw
setInterval(()=>{ try{ pCtx.drawImage(preview,0,0,previewCanvas.width,previewCanvas.height);}catch(e){} }, 100);

// ---------- processing recorded video ----------
processBtn.addEventListener('click', async () => {
  if (!recordedBlob) { alert('Aucune vidéo enregistrée ou chargée'); return; }
  samples = [];
  clearTable();
  regEquationP.textContent = 'Équation : —';
  aEstimatedSpan.textContent = '—';
  aTheorySpan.textContent = '—';
  nSamplesSpan.textContent = '0';
  await processBlobFrames(recordedBlob);
  updateStatsAndCharts();
});

// process blob frames
async function processBlobFrames(blob){
  return new Promise((resolve, reject) => {
    const videoEl = document.createElement('video');
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.src = URL.createObjectURL(blob);

    const w = 640, h = 480;
    const workCanvas = document.createElement('canvas');
    workCanvas.width = w; workCanvas.height = h;
    const wCtx = workCanvas.getContext('2d');

    videoEl.onloadedmetadata = async () => {
      videoEl.currentTime = 0;
      const frameStepMs = Number(frameStepMsInput.value) || 10;
      const desiredStep = frameStepMs / 1000;

      function detectTwoColorsFromImageData(imgData){
        const data = imgData.data;
        const width = imgData.width, height = imgData.height;
        let greenSumX=0, greenSumY=0, greenCount=0;
        let pinkSumX=0, pinkSumY=0, pinkCount=0;
        const stride = 2;
        for (let y=0; y<height; y+=stride){
          for (let x=0; x<width; x+=stride){
            const i = (y*width + x)*4;
            const r = data[i], g = data[i+1], b = data[i+2];
            const hsv = rgbToHsv(r,g,b);
            if (hsv.h >= 70 && hsv.h <= 170 && hsv.s > 0.25 && hsv.v > 0.15 && g > r && g > b){
              greenSumX += x; greenSumY += y; greenCount++;
            }
            if ((hsv.h >= 300 || hsv.h <= 25) && hsv.s > 0.2 && hsv.v > 0.15 && r > g && r > b){
              pinkSumX += x; pinkSumY += y; pinkCount++;
            }
          }
        }
        const green = greenCount ? { x: greenSumX/greenCount, y: greenSumY/greenCount } : null;
        const pink  = pinkCount  ? { x: pinkSumX/pinkCount,  y: pinkSumY/pinkCount }  : null;
        return {green, pink};
      }

      // use requestVideoFrameCallback if available
      if (videoEl.requestVideoFrameCallback) {
        let nextProcessTime = 0;
        let ended = false;
        videoEl.play().catch(()=>{});
        const onFrame = (now, metadata) => {
          const t = metadata.presentationTime;
          if (t + 1e-9 >= nextProcessTime) {
            try {
              wCtx.drawImage(videoEl, 0, 0, w, h);
              const imageData = wCtx.getImageData(0,0,w,h);
              const pos = detectTwoColorsFromImageData(imageData);
              const sample = {
                t: Math.round(t*100)/100,
                xV: pos.green ? (pxToMeter ? pos.green.x * pxToMeter : pos.green.x) : NaN,
                yV: pos.green ? (pxToMeter ? pos.green.y * pxToMeter : pos.green.y) : NaN,
                xP: pos.pink  ? (pxToMeter ? pos.pink.x  * pxToMeter : pos.pink.x)  : NaN,
                yP: pos.pink  ? (pxToMeter ? pos.pink.y  * pxToMeter : pos.pink.y)  : NaN
              };
              samples.push(sample);
              updateTableRow(sample);
              nSamplesSpan.textContent = samples.length;
            } catch(err) { console.warn('frame draw error', err); }
            nextProcessTime += desiredStep;
          }
          if (!ended) videoEl.requestVideoFrameCallback(onFrame);
        };
        videoEl.onended = () => { ended = true; resolve(); };
        videoEl.requestVideoFrameCallback(onFrame);
      } else {
        const duration = videoEl.duration;
        const times = [];
        for (let t = 0; t <= duration; t += desiredStep) times.push(Math.min(t, duration));
        let idx = 0;
        videoEl.pause();
        const processNext = () => {
          if (idx >= times.length) { resolve(); return; }
          const t = times[idx];
          videoEl.currentTime = t;
        };
        videoEl.ontimeupdate = () => {
          const t = videoEl.currentTime;
          try {
            wCtx.drawImage(videoEl, 0, 0, w, h);
            const imageData = wCtx.getImageData(0,0,w,h);
            const pos = detectTwoColorsFromImageData(imageData);
            const sample = {
              t: Math.round(t*100)/100,
              xV: pos.green ? (pxToMeter ? pos.green.x * pxToMeter : pos.green.x) : NaN,
              yV: pos.green ? (pxToMeter ? pos.green.y * pxToMeter : pos.green.y) : NaN,
              xP: pos.pink  ? (pxToMeter ? pos.pink.x  * pxToMeter : pos.pink.x)  : NaN,
              yP: pos.pink  ? (pxToMeter ? pos.pink.y  * pxToMeter : pos.pink.y)  : NaN
            };
            samples.push(sample);
            updateTableRow(sample);
            nSamplesSpan.textContent = samples.length;
          } catch(e){ console.warn('seek draw error', e); }
          idx++;
          if (idx < times.length) processNext(); else resolve();
        };
        processNext();
      }
    };
    videoEl.onerror = (e) => { reject('Erreur lecture vidéo'); };
  });
}

// rgb->hsv
function rgbToHsv(r,g,b){
  r/=255; g/=255; b/=255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h=0, s=0, v=max;
  const d = max - min;
  s = max === 0 ? 0 : d / max;
  if (d !== 0) {
    switch(max){
      case r: h = ((g - b)/d) % 6; break;
      case g: h = ((b - r)/d) + 2; break;
      case b: h = ((r - g)/d) + 4; break;
    }
    h *= 60; if (h < 0) h += 360;
  }
  return {h, s, v};
}

// table functions
function clearTable(){ dataTableBody.innerHTML = ''; }
function updateTableRow(sample){
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${sample.t.toFixed(2)}</td>
    <td>${Number.isFinite(sample.xV)?sample.xV.toFixed(4):''}</td>
    <td>${Number.isFinite(sample.yV)?sample.yV.toFixed(4):''}</td>
    <td>${Number.isFinite(sample.xP)?sample.xP.toFixed(4):''}</td>
    <td>${Number.isFinite(sample.yP)?sample.yP.toFixed(4):''}</td>
    <td></td>`;
  dataTableBody.appendChild(tr);
  while (dataTableBody.children.length > 2000) dataTableBody.removeChild(dataTableBody.firstChild);
}

// compute velocities, regression and charts
function updateStatsAndCharts(){
  if (!samples.length) return;
  const t = samples.map(s => s.t);
  const posM = samples.map(s => Number.isFinite(s.yV) ? s.yV : NaN);

  const vel = new Array(samples.length).fill(NaN);
  for (let i=1;i<samples.length;i++){
    const dt = t[i] - t[i-1];
    if (dt > 0){
      const p1 = posM[i], p0 = posM[i-1];
      if (Number.isFinite(p1) && Number.isFinite(p0)) vel[i] = (p1 - p0)/dt;
    }
  }

  // constrained regression a (v = a * t, intercept 0)
  const pairsForConstraint = [];
  for (let i=0;i<vel.length;i++){
    if (Number.isFinite(vel[i]) && Number.isFinite(t[i])) pairsForConstraint.push({t:t[i], v:vel[i]});
  }
  let aEst = NaN;
  if (pairsForConstraint.length >= 2){
    let num=0, den=0;
    for (const p of pairsForConstraint){ num += p.t * p.v; den += p.t * p.t; }
    aEst = den ? num/den : NaN;
  }

  // theoretical
  const alphaDeg = Number(angleInput.value) || 0;
  const aTheory = 9.8 * Math.sin(alphaDeg * Math.PI/180);

  aEstimatedSpan.textContent = Number.isFinite(aEst) ? aEst.toFixed(4) : '—';
  aTheorySpan.textContent = aTheory.toFixed(4);

  // prepare chart data
  const posSeries = samples.map((s,i) => ({x:s.t, y: Number.isFinite(s.yV) ? s.yV : null}));
  const velSeries = vel.map((v,i) => ({x: samples[i].t, y: Number.isFinite(v) ? v : null}));

  // update position chart
  if (!posChart){
    posChart = new Chart(document.getElementById('posChart').getContext('2d'), {
      type: 'line',
      data: { datasets: [{ label: 'Position (balle verte) [m or px]', data: posSeries, parsing:false, spanGaps:true }]},
      options: { scales:{ x:{ type:'linear', title:{display:true, text:'t (s)'} }, y:{ title:{display:true,text:'position'} } } }
    });
  } else { posChart.data.datasets[0].data = posSeries; posChart.update('none'); }

  // update velocity chart
  if (!velChart){
    velChart = new Chart(document.getElementById('velChart').getContext('2d'), {
      type: 'line',
      data: { datasets: [{ label: 'Vitesse (balle verte) [m/s or px/s]', data: velSeries, parsing:false, spanGaps:true }]},
      options: { scales:{ x:{ type:'linear', title:{display:true, text:'t (s)'} }, y:{ title:{display:true,text:'vitesse'} } } }
    });
  } else { velChart.data.datasets[0].data = velSeries; velChart.update('none'); }

  // linear regression y = a*x + b on velSeries (ignore nulls)
  const validPairs = velSeries.filter(p => p.y !== null);
  const fit = linearRegression(validPairs);
  if (fit){
    regEquationP.textContent = `v = ${fit.a.toFixed(4)} · t + ${fit.b.toFixed(4)}   (R² = ${fit.r2.toFixed(4)})`;
  } else {
    regEquationP.textContent = 'Équation : —';
  }

  const fitData = fit ? validPairs.map(p => ({x: p.x, y: fit.a * p.x + fit.b})) : [];

  if (!fitChart){
    fitChart = new Chart(document.getElementById('fitChart').getContext('2d'), {
      type: 'line',
      data: {
        datasets: [
          { label: 'Données vitesse (balle verte)', data: validPairs, parsing:false, spanGaps:true, showLine:false, pointRadius:3 },
          { label: 'Ajustement linéaire', data: fitData, parsing:false, spanGaps:true, showLine:true, borderDash:[6,4], pointRadius:0 }
        ]
      },
      options: { scales:{ x:{ type:'linear', title:{display:true, text:'t (s)'} }, y:{ title:{display:true,text:'vitesse'} } } }
    });
  } else {
    fitChart.data.datasets[0].data = validPairs;
    fitChart.data.datasets[1].data = fitData;
    fitChart.update('none');
  }

  // fill velocity column in table
  const rows = dataTableBody.querySelectorAll('tr');
  for (let i=0;i<rows.length;i++){
    const idx = i;
    if (idx < vel.length){
      const v = vel[idx];
      const vCell = rows[i].cells[5];
      if (vCell) vCell.textContent = Number.isFinite(v) ? v.toFixed(4) : '';
    }
  }
}

// linear regression y = a*x + b
function linearRegression(dataXY){
  const n = dataXY.length;
  if (n < 2) return null;
  let sumX=0, sumY=0, sumXY=0, sumX2=0, sumY2=0;
  for (const p of dataXY){ sumX += p.x; sumY += p.y; sumXY += p.x * p.y; sumX2 += p.x * p.x; sumY2 += p.y * p.y; }
  const meanX = sumX / n, meanY = sumY / n;
  const denom = (sumX2 - n * meanX * meanX);
  if (Math.abs(denom) < 1e-12) return null;
  const a = (sumXY - n * meanX * meanY) / denom;
  const b = meanY - a * meanX;
  const SSxy = sumXY - n * meanX * meanY;
  const SSxx = sumX2 - n * meanX * meanX;
  const SSyy = sumY2 - n * meanY * meanY;
  const r2 = (SSxy * SSxy) / (SSxx * SSyy);
  return {a, b, r2};
}

// export CSV
exportCSVBtn.addEventListener('click', () => {
  if (!samples.length) { alert('Aucune donnée'); return; }
  const header = ['t (s)','xV','yV','xP','yP'];
  const rows = samples.map(s => [s.t.toFixed(2), Number.isFinite(s.xV)?s.xV:'', Number.isFinite(s.yV)?s.yV:'', Number.isFinite(s.xP)?s.xP:'', Number.isFinite(s.yP)?s.yP:''].join(','));
  const csv = [header.join(','), ...rows].join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'exao_video_data.csv'; document.body.appendChild(a); a.click(); a.remove();
});

// small helper to draw preview overlay (not used heavily)
function drawPreviewOverlay(pos){
  try {
    pCtx.drawImage(preview, 0, 0, previewCanvas.width, previewCanvas.height);
    if (!pos) return;
    pCtx.save();
    pCtx.lineWidth = 2;
    if (pos.green) { pCtx.strokeStyle = 'lime'; pCtx.beginPath(); pCtx.arc(pos.green.x, pos.green.y, 8, 0, Math.PI*2); pCtx.stroke(); }
    if (pos.pink)  { pCtx.strokeStyle = 'magenta'; pCtx.beginPath(); pCtx.arc(pos.pink.x, pos.pink.y, 8, 0, Math.PI*2); pCtx.stroke(); }
    pCtx.restore();
  } catch(e){}
}
