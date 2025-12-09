/************************************************************
 * script.js - Détection stable d'objet en mouvement + calcul
 * de l'angle du rail
 ************************************************************/

/* -------------------------
   CONFIG
------------------------- */
const REAL_DIAM_M = 0.15; // 15 cm
const MIN_PIXELS_FOR_DETECT = 40;
const motionThreshold = 35;
const historyLength = 5;
const blackThreshold = 60;

/* -------------------------
   STATE
------------------------- */
let recordedChunks = [];
let recordedBlob = null;
let videoURL = null;
let pxToMeter = null;
let samplesRaw = [];
let samplesFilt = [];
let slowMotionFactor = 1;
let mediaRecorder = null;
let videoStream = null;
let backgroundImageData = null;
let positionHistory = [];
let railAngleDetected = false;

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
let velChart = null;
let fitChart = null;
let positionChart = null;

/* -------------------------
   Caméras + choix caméra
------------------------- */
async function listCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter(d => d.kind === "videoinput");
}

async function startPreview(deviceId = null) {
  try {
    if (videoStream) videoStream.getTracks().forEach(track => track.stop());
    let constraints = { video: { width: { ideal: 1280 }, height: { ideal: 720 } } };
    if (deviceId) constraints.video.deviceId = { exact: deviceId };
    videoStream = await navigator.mediaDevices.getUserMedia(constraints);
    preview.srcObject = videoStream;
    previewLoop();
    return true;
  } catch (e) {
    console.error("Erreur accès caméra :", e);
    alert("Impossible d'accéder à une caméra. Vérifiez les permissions.");
    return false;
  }
}

async function populateCameraSelect() {
  const cameraSelect = document.getElementById("cameraSelect");
  const cameras = await listCameras();
  cameraSelect.innerHTML = "";
  cameras.forEach((cam, index) => {
    const option = document.createElement("option");
    option.value = cam.deviceId;
    option.textContent = cam.label || `Caméra ${index + 1}`;
    cameraSelect.appendChild(option);
  });
  if (cameras.length > 0) await startPreview(cameras[0].deviceId);
}

document.getElementById("cameraSelect").addEventListener("change", async (e) => {
  await startPreview(e.target.value);
});

document.addEventListener("DOMContentLoaded", populateCameraSelect);

/* -------------------------
   Utilities: RGB -> HSV
------------------------- */
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, v = max, d = max - min;
  s = max === 0 ? 0 : d / max;
  if (d !== 0) {
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s, v };
}

/* -------------------------
   Rail detection
------------------------- */
function detectRailAngle(imgData) {
  const data = imgData.data, W = imgData.width, H = imgData.height;
  let railPixels = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
      if (lum < blackThreshold) railPixels.push({ x, y });
    }
  }
  if (railPixels.length < 100) return null;
  let minY = H, maxY = 0, minXForMinY = 0, minXForMaxY = 0;
  for (const p of railPixels) {
    if (p.y < minY) { minY = p.y; minXForMinY = p.x; }
    if (p.y > maxY) { maxY = p.y; minXForMaxY = p.x; }
  }
  const deltaX = minXForMaxY - minXForMinY;
  const deltaY = maxY - minY;
  if (deltaY === 0) return null;
  return Math.atan2(Math.abs(deltaX), Math.abs(deltaY)) * 180 / Math.PI;
}

/* -------------------------
   Image preprocessing (gray + blur)
------------------------- */
function preprocessImage(imgData) {
  const data = imgData.data, W = imgData.width, H = imgData.height;
  const processed = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const avg = (data[i] + data[i+1] + data[i+2])/3;
    processed[i] = processed[i+1] = processed[i+2] = avg;
    processed[i+3] = data[i+3];
  }
  const blurred = new Uint8ClampedArray(processed.length);
  for (let y=1; y<H-1; y++) for (let x=1; x<W-1; x++) {
    const i=(y*W+x)*4; let sumR=0,sumG=0,sumB=0;
    for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
      const ni = ((y+dy)*W+(x+dx))*4;
      sumR += processed[ni]; sumG += processed[ni+1]; sumB += processed[ni+2];
    }
    blurred[i]=sumR/9; blurred[i+1]=sumG/9; blurred[i+2]=sumB/9; blurred[i+3]=processed[i+3];
  }
  return new ImageData(blurred,W,H);
}

/* -------------------------
   Capture background
------------------------- */
function captureBackground() {
  ctx.drawImage(preview, 0, 0, previewCanvas.width, previewCanvas.height);
  backgroundImageData = preprocessImage(ctx.getImageData(0,0,previewCanvas.width,previewCanvas.height));
  console.log("Fond capturé et prétraité.");
}

/* -------------------------
   Temporal smoothing
------------------------- */
function smoothPosition(currentPos) {
  if (!currentPos) return null;
  positionHistory.push(currentPos);
  if(positionHistory.length>historyLength) positionHistory.shift();
  let sumX=0,sumY=0;
  for(const pos of positionHistory){sumX+=pos.x;sumY+=pos.y;}
  return { x:sumX/positionHistory.length, y:sumY/positionHistory.length, count: currentPos.count };
}

/* -------------------------
   Motion detection
------------------------- */
function detectMotion(currentImageData) {
  if(!backgroundImageData) return null;
  const curr = currentImageData.data, bg = backgroundImageData.data;
  const W=currentImageData.width, H=currentImageData.height;
  let diffArr=[];
  for(let i=0;i<curr.length;i+=4) diffArr.push(Math.abs(curr[i]-bg[i]));
  const mean = diffArr.reduce((a,b)=>a+b,0)/diffArr.length;
  const std = Math.sqrt(diffArr.reduce((sq,n)=>sq+Math.pow(n-mean,2),0)/diffArr.length);
  const thresh = mean + 2*std;

  let sumX=0,sumY=0,count=0;
  for(let y=0;y<H;y++) for(let x=0;x<W;x++){
    const i=(y*W+x)*4; if(Math.abs(curr[i]-bg[i])>thresh){sumX+=x;sumY+=y;count++;}
  }
  if(count<MIN_PIXELS_FOR_DETECT) return null;
  return { x: sumX/count, y: sumY/count, count };
}

/* -------------------------
   Calibration px -> m
------------------------- */
function estimatePxToMeter(imgData){
  if(!backgroundImageData) return null;
  const processed=preprocessImage(imgData);
  const curr=processed.data, bg=backgroundImageData.data;
  const W=processed.width,H=processed.height;
  let found=[];
  for(let y=0;y<H;y++) for(let x=0;x<W;x++){
    const i=(y*W+x)*4;
    if(Math.abs(curr[i]-bg[i])>10) found.push({x,y});
  }
  if(found.length<200) return null;
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for(const p of found){ if(p.x<minX) minX=p.x; if(p.x>maxX) maxX=p.x; if(p.y<minY) minY=p.y; if(p.y>maxY) maxY=p.y;}
  const diamPx=Math.max(maxX-minX,maxY-minY);
  if(diamPx<=2) return null;
  return REAL_DIAM_M/diamPx;
}

/* -------------------------
   Kalman 2D
------------------------- */
function createKalman(){
  let x=[[0],[0],[0],[0]],P=identity(4,1e3);
  const Q=[[1e-5,0,0,0],[0,1e-3,0,0],[0,0,1e-5,0],[0,0,0,1e-3]],H=[[1,0,0,0],[0,0,1,0]],R=[[1e-6,0],[0,1e-6]];
  function predict(dt){ const F=[[1,dt,0,0],[0,1,0,0],[0,0,1,dt],[0,0,0,1]]; x=matMul(F,x); P=add(matMul(matMul(F,P),transpose(F)),Q); }
  function update(z){ const y=sub(z,matMul(H,x)); const S=add(matMul(matMul(H,P),transpose(H)),R); const K=matMul(matMul(P,transpose(H)),inv2x2(S)); x=add(x,matMul(K,y)); P=matMul(sub(identity(4),matMul(K,H)),P); }
  function setFromMeasurement(z){x=[[z[0][0]],[0],[z[1][0]],[0]]; P=identity(4,1e-1); }
  function getState(){return {x:x[0][0],vx:x[1][0],y:x[2][0],vy:x[3][0]};}
  return {predict,update,getState,setFromMeasurement};
}

/* -------------------------
   Matrix helpers
------------------------- */
function identity(n,scale=1){return Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>(i===j?scale:0))); }
function transpose(A){return A[0].map((_,c)=>A.map(r=>r[c])); }
function matMul(A,B){const aR=A.length,aC=A[0].length,bC=B[0].length,C=Array.from({length:aR},()=>Array.from({length:bC},()=>0));for(let i=0;i<aR;i++) for(let k=0;k<aC;k++) for(let j=0;j<bC;j++) C[i][j]+=A[i][k]*B[k][j];return C; }
function add(A,B){return A.map((row,i)=>row.map((v,j)=>v+B[i][j])); }
function sub(A,B){return A.map((row,i)=>row.map((v,j)=>v-B[i][j])); }
function inv2x2(M){const [a,b,c,d]=[M[0][0],M[0][1],M[1][0],M[1][1]],det=a*d-b*c; if(Math.abs(det)<1e-12) return [[1e12,0],[0,1e12]]; return [[d/det,-b/det],[-c/det,a/det]]; }

/* -------------------------
   Preview loop
------------------------- */
function previewLoop(){
  if(preview.readyState>=2){
    ctx.drawImage(preview,0,0,previewCanvas.width,previewCanvas.height);
    const img=ctx.getImageData(0,0,previewCanvas.width,previewCanvas.height);
    const processed=preprocessImage(img);
    if(backgroundImageData){
      const pos=detectMotion(processed);
      if(pos){
        const smoothed=smoothPosition(pos);
        if(smoothed){
          ctx.beginPath();
          ctx.strokeStyle="lime";
          ctx.lineWidth=3;
          ctx.arc(smoothed.x,smoothed.y,12,0,Math.PI*2);
          ctx.stroke();
        }
      }
    }
  }
  requestAnimationFrame(previewLoop);
}

/* -------------------------
   Event listeners: capture background
------------------------- */
captureBgBtn.addEventListener("click", captureBackground);

/* -------------------------
   Event listeners: recording
   (start/stop)
------------------------- */
startBtn.addEventListener("click", async()=>{
  if(!videoStream){await populateCameraSelect();}
  recordedChunks=[]; try{mediaRecorder=new MediaRecorder(videoStream,{mimeType:"video/webm;codecs=vp9"});}catch(e){mediaRecorder=new MediaRecorder(videoStream);}
  mediaRecorder.ondataavailable=e=>{if(e.data && e.data.size) recordedChunks.push(e.data);};
  mediaRecorder.onstop=()=>{
    recordedBlob=new Blob(recordedChunks,{type:"video/webm"});
    videoURL=URL.createObjectURL(recordedBlob);
    processBtn.disabled=false;
    slowMoBtn.disabled=false;
    blobSizeP.textContent=`Vidéo enregistrée (${(recordedBlob.size/1024/1024).toFixed(2)} MB)`;
  };
  mediaRecorder.start();
  recStateP.textContent="État : enregistrement...";
  startBtn.disabled=true;
  stopBtn.disabled=false;
});

stopBtn.addEventListener("click",()=>{if(mediaRecorder && mediaRecorder.state!=="inactive"){mediaRecorder.stop(); recStateP.textContent="État : arrêté"; startBtn.disabled=false; stopBtn.disabled=true;}});

/* -------------------------
   Helper: determine angle (deg)
   - prefer angleInput if set
   - else try rail detection on current background image
------------------------- */
function getAngleDegFallback() {
  // 1) from input
  const v = parseFloat(angleInput.value);
  if (!isNaN(v) && isFinite(v)) return v;
  // 2) from detected rail (if background exists)
  if (backgroundImageData) {
    try {
      const detected = detectRailAngle(backgroundImageData);
      if (detected !== null) return detected;
    } catch (e) {
      console.warn("detectRailAngle failed:", e);
    }
  }
  // default 0
  return 0;
}

/* -------------------------
   Compute theoretical acceleration g*sin(theta)
------------------------- */
function computeTheoreticalAcceleration(thetaDeg) {
  const g = 9.81;
  const theta = thetaDeg * Math.PI / 180;
  return g * Math.sin(theta);
}

/* -------------------------
   Compute acceleration from samples t,x,y
   - samples: [{t, x, y}, ...] with x,y in meters
   - returns object {a, intercept, n}
------------------------- */
function computeAccelerationFromTxY(samples) {
  if (!samples || samples.length < 3) return null;
  // compute speed magnitude between consecutive points
  const vSamples = [];
  for (let i=1;i<samples.length;i++){
    const dt = samples[i].t - samples[i-1].t;
    if (dt <= 0) continue;
    const dx = samples[i].x - samples[i-1].x;
    const dy = samples[i].y - samples[i-1].y;
    const dist = Math.sqrt(dx*dx + dy*dy); // meters
    const v = dist / dt;
    vSamples.push({ t: samples[i].t, v });
  }
  if (vSamples.length < 2) return null;
  // linear regression v = a * t + b
  const n = vSamples.length;
  let sumT=0,sumV=0,sumTV=0,sumTT=0;
  for (let i=0;i<n;i++){ const ti=vSamples[i].t, vi=vSamples[i].v; sumT+=ti; sumV+=vi; sumTV+=ti*vi; sumTT+=ti*ti; }
  const denom = n*sumTT - sumT*sumT;
  if (Math.abs(denom) < 1e-12) return null;
  const a = (n*sumTV - sumT*sumV) / denom;
  const b = (sumV - a*sumT) / n;
  return { a, intercept: b, n };
}

/* -------------------------
   Compute acceleration from samples t,v
   - samples: [{t, v}, ...]
------------------------- */
function computeAccelerationFromTV(samples) {
  if (!samples || samples.length < 2) return null;
  const n = samples.length;
  let sumT=0,sumV=0,sumTV=0,sumTT=0;
  for (let i=0;i<n;i++){ const ti=samples[i].t, vi=samples[i].v; sumT+=ti; sumV+=vi; sumTV+=ti*vi; sumTT+=ti*ti; }
  const denom = n*sumTT - sumT*sumT;
  if (Math.abs(denom) < 1e-12) return null;
  const a = (n*sumTV - sumT*sumV) / denom;
  const b = (sumV - a*sumT) / n;
  return { a, intercept: b, n };
}

/* -------------------------
   Import CSV (amélioré)
   - support t,v  (2 colonnes)
   - support t,x,y (3 colonnes) with x,y en mètres
------------------------- */
document.getElementById("csvInput").addEventListener("change",function(e){
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = function(ev){
    const raw = ev.target.result.replace(/\r/g,"");
    const lines = raw.split("\n").map(l=>l.trim()).filter(l=>l!=="" && !l.startsWith("#"));
    if (lines.length === 0) {
      alert("CSV vide ou invalide.");
      return;
    }

    // Attempt to parse flexible columns (separator ; or ,)
    const parsed = lines.map(line => {
      const sep = line.includes(";") ? ";" : ",";
      const parts = line.split(sep).map(p=>p.trim());
      return parts;
    });

    // Determine format: 2 cols => t,v ; 3 cols => t,x,y
    const first = parsed[0];
    if (first.length < 2) { alert("Format CSV non reconnu (au moins 2 colonnes attendues)."); return; }

    let tvSamples = [];
    let txySamples = [];
    let detectedFormat = null;

    for (const parts of parsed) {
      if (parts.length >= 3) {
        const t = parseFloat(parts[0]);
        const x = parseFloat(parts[1]);
        const y = parseFloat(parts[2]);
        if (!isNaN(t) && !isNaN(x) && !isNaN(y)) {
          txySamples.push({ t, x, y });
          detectedFormat = 'txy';
          continue;
        }
      }
      // fallback to 2-col parse
      if (parts.length >= 2) {
        const t = parseFloat(parts[0]);
        const v = parseFloat(parts[1]);
        if (!isNaN(t) && !isNaN(v)) {
          tvSamples.push({ t, v });
          if (detectedFormat === null) detectedFormat = 'tv';
          continue;
        }
      }
      // else skip line
    }

    nSamplesSpan.textContent = (detectedFormat === 'txy') ? txySamples.length : tvSamples.length;

    // If txy present prefer that
    let regResult = null;
    let tValues = [], vValues = [];

    if (detectedFormat === 'txy' && txySamples.length >= 2) {
      // compute velocities and regression
      const accRes = computeAccelerationFromTxY(txySamples);
      if (accRes) {
        regResult = accRes;
        // create arrays for plotting: we need t and v for each v-sample (derivative points)
        // recreate vSamples used in computeAccelerationFromTxY
        const vSamples = [];
        for (let i=1;i<txySamples.length;i++){
          const dt = txySamples[i].t - txySamples[i-1].t;
          if (dt <= 0) continue;
          const dx = txySamples[i].x - txySamples[i-1].x;
          const dy = txySamples[i].y - txySamples[i-1].y;
          const dist = Math.sqrt(dx*dx + dy*dy);
          const v = dist / dt;
          vSamples.push({ t: txySamples[i].t, v });
        }
        tValues = vSamples.map(s=>s.t);
        vValues = vSamples.map(s=>s.v);
      }
    } else if (detectedFormat === 'tv' && tvSamples.length >= 2) {
      const accRes = computeAccelerationFromTV(tvSamples);
      if (accRes) {
        regResult = accRes;
        tValues = tvSamples.map(s=>s.t);
        vValues = tvSamples.map(s=>s.v);
      }
    } else {
      alert("CSV non exploitable : trop peu de points ou format non pris en charge.");
      return;
    }

    // Draw velocity chart (existing behavior)
    if (window.velChartInstance) window.velChartInstance.destroy();
    const ctxVel = document.getElementById("velChart").getContext("2d");
    window.velChartInstance = new Chart(ctxVel,{type:"line",data:{labels:tValues,datasets:[{label:"Vitesse mesurée (m/s)",data:vValues}]}});

    // Fill regression results into DOM
    if (regResult) {
      aEstimatedSpan.textContent = regResult.a.toFixed(3);
      // theoretical acceleration from angle
      const thetaDeg = getAngleDegFallback();
      const aTheo = computeTheoreticalAcceleration(thetaDeg);
      aTheorySpan.textContent = aTheo.toFixed(3);
      // regression equation
      regEquationP.textContent = `Régression: v = ${regResult.a.toFixed(4)}·t + ${regResult.intercept.toFixed(4)}  (n=${regResult.n})`;

      // plot fit line v = a·t + b
      const fitValues = tValues.map(t => regResult.a * t + regResult.intercept);
      if (window.fitChartInstance) window.fitChartInstance.destroy();
      const ctxFit = document.getElementById("fitChart").getContext("2d");
      window.fitChartInstance = new Chart(ctxFit,{
        type:"line",
        data:{
          labels:tValues,
          datasets:[
            { label:"Vitesse mesurée", data:vValues, fill:false },
            { label:`Modèle v = a·t + b`, data:fitValues, fill:false }
          ]
        }
      });
    } else {
      aEstimatedSpan.textContent = "—";
      aTheorySpan.textContent = getAngleDegFallback() ? computeTheoreticalAcceleration(getAngleDegFallback()).toFixed(3) : "—";
      regEquationP.textContent = "Régression impossible (données insuffisantes).";
    }
  };
  reader.readAsText(file);
});
