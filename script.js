/****************************************************
 *  script.js  — version corrigée (angle CSV + caméra)
 ****************************************************/

/* ===================================================
   LECTURE CSV
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

/* ===================================================
   EXTRACTION ANGLE VIA NOM DE FICHIER
=================================================== */
function extractAngleFromFilename(filename) {
  const match = filename.match(/(\d+)deg/i);
  if (!match) return null;
  return parseInt(match[1], 10);
}

/* ===================================================
   CALCUL VITESSE + REGRESSION LINÉAIRE
=================================================== */
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

  const slope = (n * sumTV - sumT * sumV) / (n * sumT2 - sumT * sumT);

  return { vData: v, acceleration: slope };
}

/* ===================================================
   ACCÉLÉRATION THÉORIQUE
=================================================== */
function computeTheoreticalAcceleration(thetaDeg) {
  const g = 9.81;
  const theta = thetaDeg * Math.PI / 180;
  return g * Math.sin(theta);
}

/* ===================================================
   GRAPHIQUE CHART.JS
=================================================== */
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
   IMPORT CSV + CALCULS
=================================================== */
document.getElementById("csvFile").addEventListener("change", function () {
  const file = this.files[0];
  if (!file) return;

  /* 🟧 EXTRACTION ANGLE AUTOMATIQUE DU NOM */
  const angleFromName = extractAngleFromFilename(file.name);

  if (angleFromName !== null) {
    window.currentAngleDeg = angleFromName;
    document.getElementById("angleValue").textContent = angleFromName + "°";

    // Affichage dans la zone angle rampe
    document.getElementById("rampAngleDisplay").textContent =
      "Angle de la rampe : " + angleFromName + "°";

    // Input angle utilisateur mis à jour
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

/* ===================================================
   CAMERA – LISTE + STREAM
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

    // Auto-start de la première caméra
    if (cams.length > 0) {
      startCamera(cams[0].deviceId);
    }

    // Quand l'utilisateur change :
    select.onchange = () => startCamera(select.value);

  } catch (e) {
    console.error("Erreur liste caméras :", e);
  }
}

async function startDefaultCamera() {
  try {
    await navigator.mediaDevices.getUserMedia({ video: true });
    listCameras();
  } catch (e) {
    console.error("Permission caméra refusée", e);
  }
}
/* ===================================================
   EVENTS BOUTONS (PATCH MINIMAL)
=================================================== */

document.getElementById("captureBgBtn").addEventListener("click", () => {
  console.log("📸 Capturer le fond — TODO");
});

document.getElementById("startRecBtn").addEventListener("click", () => {
  console.log("▶️ Démarrer enregistrement — TODO");
});

document.getElementById("stopRecBtn").addEventListener("click", () => {
  console.log("⏹️ Arrêter — TODO");
});

document.getElementById("loadFileBtn").addEventListener("click", () => {
  document.getElementById("fileInput").click();
});

document.getElementById("slowMoBtn").addEventListener("click", () => {
  console.log("⏪ Ralenti ×0.25 — TODO");
});

document.getElementById("processBtn").addEventListener("click", () => {
  console.log("⚙️ Traiter la vidéo enregistrée — TODO");
});

startDefaultCamera();

/* ===================================================
   CAMERA – START STREAM
=================================================== */
let currentStream = null;

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

    const videoEl = document.getElementById("videoPreview");
    videoEl.srcObject = stream;
    await videoEl.play();

  } catch (e) {
    console.error("Erreur démarrage caméra :", e);
  }
}

