//-----------------------------------------------------
// VARIABLES
//-----------------------------------------------------
let mediaRecorder;
let recordedChunks = [];
let recordedBlob = null;

let video = null;
let canvas = null;
let ctx = null;

let pxToMeter = 1;         // sera déterminé automatiquement
let samples = [];
let playing = false;
let startTime = 0;

// Couleur balle :
const BALL_R = 230, BALL_G = 190, BALL_B = 40;

//-----------------------------------------------------
// INIT
//-----------------------------------------------------
window.addEventListener("load", () => {
  video = document.getElementById("preview");
  canvas = document.getElementById("previewCanvas");
  ctx = canvas.getContext("2d");

  document.getElementById("startRecBtn").onclick = startRecording;
  document.getElementById("stopRecBtn").onclick = stopRecording;
  document.getElementById("processBtn").onclick = processVideo;

  document.getElementById("loadFileBtn").onclick = () =>
      document.getElementById("fileInput").click();

  document.getElementById("fileInput").onchange = loadVideoFile;

  document.getElementById("calibrateBallBtn").onclick = calibrateBallDiameter;
});

//-----------------------------------------------------
// WEBCAM RECORDING
//-----------------------------------------------------
async function startRecording(){
  const stream = await navigator.mediaDevices.getUserMedia({ video:true });
  video.srcObject = stream;

  mediaRecorder = new MediaRecorder(stream);
  recordedChunks = [];

  mediaRecorder.ondataavailable = e => recordedChunks.push(e.data);
  mediaRecorder.onstop = () => {
    recordedBlob = new Blob(recordedChunks, {type:"video/webm"});
    document.getElementById("processBtn").disabled = false;
  };

  mediaRecorder.start();
  document.getElementById("startRecBtn").disabled = true;
  document.getElementById("stopRecBtn").disabled = false;
}

function stopRecording(){
  mediaRecorder.stop();
  document.getElementById("startRecBtn").disabled = false;
  document.getElementById("stopRecBtn").disabled = true;
}

//-----------------------------------------------------
// LOAD VIDEO FILE
//-----------------------------------------------------
function loadVideoFile(){
  const file = this.files[0];
  if(!file) return;
  recordedBlob = URL.createObjectURL(file);
  document.getElementById("processBtn").disabled = false;
}

//-----------------------------------------------------
// CALIBRATION AUTOMATIQUE (diamètre connu = 15 cm)
//-----------------------------------------------------
function calibrateBallDiameter(){
  if(!recordedBlob){ alert("Charge une vidéo d’abord."); return; }

  const tempVid = document.createElement("video");
  tempVid.src = recordedBlob;
  tempVid.muted = true;

  tempVid.onloadeddata = () => {
    tempVid.currentTime = 0;

    tempVid.onseeked = () => {
      const tmpCanvas = document.createElement("canvas");
      tmpCanvas.width = tempVid.videoWidth;
      tmpCanvas.height = tempVid.videoHeight;
      const tctx = tmpCanvas.getContext("2d");

      tctx.drawImage(tempVid,0,0);

      const frame = tctx.getImageData(
         0,0,tmpCanvas.width,tmpCanvas.height
      );

      const pix = detectBall(frame);
      if(!pix) {
        alert("Impossible de détecter la balle pour l’étalonnage.");
        return;
      }

      const diameterMeters = parseFloat(document.getElementById("ballDiameter").value);

      // mesure du diamètre apparent (pixels)
      const dPix = estimateBallDiameter(frame, pix);

      pxToMeter = diameterMeters / dPix;
      alert("Étalonnage OK : " + pxToMeter.toFixed(6)+ " m/px");
    };
  };
}

//-----------------------------------------------------
// BALLE → position barycentre (détection par couleur cible)
//-----------------------------------------------------
function detectBall(img){
  const data = img.data;
  const W = img.width;
  const H = img.height;

  let sx = 0, sy = 0, n = 0;

  const stride = 2;

  for(let y=0;y<H;y+=stride){
    for(let x=0;x<W;x+=stride){

      const i = (y*W + x)*4;
      const r=data[i], g=data[i+1], b=data[i+2];

      // distance RGB simple
      const dr = r - BALL_R;
      const dg = g - BALL_G;
      const db = b - BALL_B;
      const dist = dr*dr + dg*dg + db*db;

      // seuil tolérant
      if(dist < 2500){   // <<< ajustable
        sx += x;
        sy += y;
        n++;
      }
    }
  }

  if(n===0) return null;
  return {x: sx/n, y: sy/n};
}

//-----------------------------------------------------
// ESTIMATION DIAMÈTRE EN PIXELS
//-----------------------------------------------------
function estimateBallDiameter(img, center){
  const data = img.data;
  const W = img.width;
  const H = img.height;

  const cx = Math.round(center.x);
  const cy = Math.round(center.y);

  let count = 0;
  let xmin=9999,xmax=-1, ymin=9999,ymax=-1;

  for(let y=cy-50; y<=cy+50; y++){
    for(let x=cx-50; x<=cx+50; x++){
      if(x<0||y<0||x>=W||y>=H) continue;

      const i = (y*W+x)*4;
      const r=data[i], g=data[i+1], b=data[i+2];

      const dr=r-BALL_R, dg=g-BALL_G, db=b-BALL_B;
      if(dr*dr+dg*dg+db*db < 2500){
        if(x<xmin) xmin=x;
        if(x>xmax) xmax=x;
        if(y<ymin) ymin=y;
        if(y>ymax) ymax=y;
        count++;
      }
    }
  }

  const dx = xmax - xmin;
  const dy = ymax - ymin;
  return Math.max(dx, dy);
}

//-----------------------------------------------------
// PROCESSING VIDEO
//-----------------------------------------------------
function processVideo(){
  samples=[];
  const v2=document.createElement("video");
  v2.src = recordedBlob;
  v2.muted = true;

  v2.onloadeddata = () => {
    v2.play();
    startTime = performance.now();
    playing=true;
    stepFrame(v2);
  };
}

function stepFrame(v2){
  if(!playing) return;

  const now = performance.now();
  const t = (now - startTime)/1000;

  ctx.drawImage(v2,0,0,canvas.width,canvas.height);
  const frame = ctx.getImageData(0,0,canvas.width,canvas.height);

  const pos = detectBall(frame);
  let x=NaN, y=NaN;

  if(pos){
    x = pos.x * pxToMeter;
    y = pos.y * pxToMeter;
  }

  samples.push({t,x,y});

  if(v2.ended){
    playing=false;
    computeVelocity();
    updateCharts();
    updateTable();
    return;
  }

  const step = parseInt(document.getElementById("frameStepMs").value);
  setTimeout(()=>stepFrame(v2), step);
}

//-----------------------------------------------------
// VELOCITY
//-----------------------------------------------------
function computeVelocity(){
  for(let i=1;i<samples.length;i++){
    const dt = samples[i].t - samples[i-1].t;
    if(dt>0){
      const dy = samples[i].y - samples[i-1].y;
      samples[i].v = dy/dt;
    } else samples[i].v=0;
  }
  samples[0].v=0;
}

//-----------------------------------------------------
// CHARTS
//-----------------------------------------------------
let posChart=null, velChart=null, fitChart=null;

function updateCharts(){
  document.getElementById("nSamples").textContent = samples.length;

  // données
  const t = samples.map(s=>s.t);
  const y = samples.map(s=>s.y);
  const v = samples.map(s=>s.v);

  const angle = parseFloat(document.getElementById("angleInput").value);
  const atheo = 9.8*Math.sin(angle*Math.PI/180);
  document.getElementById("aTheory").textContent = atheo.toFixed(3);

  // régression v=a t
  let sumt=0,sumv=0,sumtt=0,sumtv=0,n=0;
  samples.forEach(s=>{
    if(Number.isFinite(s.v)){
      n++;
      sumt+=s.t; sumv+=s.v; sumtt+=s.t*s.t; sumtv+=s.t*s.v;
    }
  });

  const a = (n*sumtv - sumt*sumv)/(n*sumtt - sumt*sumt);
  document.getElementById("aEstimated").textContent = a?.toFixed(3) ?? "—";
  document.getElementById("regEquation").textContent =
    "v = " + a.toFixed(3) + " · t";

  // position
  if(posChart) posChart.destroy();
  posChart = new Chart(document.getElementById("posChart"),{
    type:"line",
    data:{labels:t, datasets:[{label:"y (m)", data:y}]},
    options:{responsive:true}
  });

  // vitesse
  if(velChart) velChart.destroy();
  velChart = new Chart(document.getElementById("velChart"),{
    type:"line",
    data:{labels:t, datasets:[{label:"v (m/s)", data:v}]},
    options:{responsive:true}
  });

  // ajustement
  const fit = t.map(tt=>a*tt);
  if(fitChart) fitChart.destroy();
  fitChart = new Chart(document.getElementById("fitChart"),{
    type:"line",
    data:{labels:t, datasets:[
      {label:"v mesurée", data:v},
      {label:"v = a·t", data:fit}
    ]},
    options:{responsive:true}
  });
}

//-----------------------------------------------------
// TABLE
//-----------------------------------------------------
function updateTable(){
  const tbody=document.querySelector("#dataTable tbody");
  tbody.innerHTML="";
  for(const s of samples){
    const tr=document.createElement("tr");
    tr.innerHTML =
      `<td>${s.t.toFixed(3)}</td>
       <td>${Number.isFinite(s.x)?s.x.toFixed(4):""}</td>
       <td>${Number.isFinite(s.y)?s.y.toFixed(4):""}</td>
       <td>${Number.isFinite(s.v)?s.v.toFixed(4):""}</td>`;
    tbody.appendChild(tr);
  }
}
