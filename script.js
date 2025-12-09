/**********************************************
 * exAO v02 — SCRIPT PRINCIPAL
 * Correction complète + CSV + Charts + Caméra
 **********************************************/

// ----------- Variables globales -----------
let videoStream = null;
let bgFrame = null;
let preview = document.getElementById("preview");
let previewCanvas = document.getElementById("previewCanvas");
let ctxPrev = previewCanvas.getContext("2d");
let recordFrames = [];
let detecting = false;
let processInProgress = false;

// ----------- Sélection caméra -----------
async function listCameras() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === "videoinput");

    const sel = document.getElementById("cameraSelect");
    sel.innerHTML = "";

    cams.forEach(cam => {
        const opt = document.createElement("option");
        opt.value = cam.deviceId;
        opt.textContent = cam.label || "Caméra";
        sel.appendChild(opt);
    });

    return cams.length > 0;
}

async function startPreview(deviceId = null) {
    if (videoStream) {
        videoStream.getTracks().forEach(t => t.stop());
    }

    const constraints = {
        video: deviceId ? { deviceId: { exact: deviceId } } : true,
        audio: false
    };

    try {
        videoStream = await navigator.mediaDevices.getUserMedia(constraints);
        preview.srcObject = videoStream;
        preview.onloadedmetadata = () => preview.play();
        return true;
    } catch (e) {
        console.error("Erreur caméra :", e);
        alert("Impossible d'accéder à la caméra.");
        return false;
    }
}

document.getElementById("cameraSelect").addEventListener("change", e => {
    startPreview(e.target.value);
});

// ----------- Prévisualisation -----------

function previewLoop() {
    if (!preview.videoWidth) {
        requestAnimationFrame(previewLoop);
        return;
    }

    previewCanvas.width = preview.videoWidth;
    previewCanvas.height = preview.videoHeight;
    ctxPrev.drawImage(preview, 0, 0);

    requestAnimationFrame(previewLoop);
}
previewLoop();

// ----------- Capture du fond -----------

function captureBackground() {
    ctxPrev.drawImage(preview, 0, 0);
    bgFrame = ctxPrev.getImageData(0, 0, previewCanvas.width, previewCanvas.height);
}

document.getElementById("captureBgBtn").addEventListener("click", () => {
    captureBackground();
    alert("Fond capturé !");
});

// ----------- Enregistrement vidéo -----------

document.getElementById("startRecBtn").addEventListener("click", () => {
    recordFrames = [];
    detecting = true;
    document.getElementById("stopRecBtn").disabled = false;
    document.getElementById("startRecBtn").disabled = true;
    document.getElementById("recState").textContent = "État : enregistrement…";

    grabFrameLoop();
});

document.getElementById("stopRecBtn").addEventListener("click", () => {
    detecting = false;
    document.getElementById("stopRecBtn").disabled = true;
    document.getElementById("startRecBtn").disabled = false;
    document.getElementById("processBtn").disabled = false;
    document.getElementById("recState").textContent =
        `État : ${recordFrames.length} images enregistrées`;
});

function grabFrameLoop() {
    if (!detecting) return;

    ctxPrev.drawImage(preview, 0, 0);
    const frame = ctxPrev.getImageData(0, 0, previewCanvas.width, previewCanvas.height);
    recordFrames.push(frame);

    requestAnimationFrame(grabFrameLoop);
}

// ----------- Import vidéo -----------

document.getElementById("loadFileBtn").addEventListener("click", () => {
    document.getElementById("fileInput").click();
});
document.getElementById("fileInput").addEventListener("change", loadVideoFile);

function loadVideoFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    const url = URL.createObjectURL(file);
    const tempVideo = document.createElement("video");
    tempVideo.src = url;
    tempVideo.muted = true;
    tempVideo.play();

    recordFrames = [];
    tempVideo.addEventListener("loadeddata", () => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        canvas.width = tempVideo.videoWidth;
        canvas.height = tempVideo.videoHeight;

        let t = 0;
        function extract() {
            if (t > tempVideo.duration) {
                document.getElementById("processBtn").disabled = false;
                document.getElementById("recState").textContent =
                    `Imported : ${recordFrames.length} frames`;
                return;
            }
            tempVideo.currentTime = t;
            ctx.drawImage(tempVideo, 0, 0);
            recordFrames.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
            t += 0.01;
            setTimeout(extract, 20);
        }
        extract();
    });
}

// ----------- Détection mouvement -----------

function detectMotion(frame) {
    if (!bgFrame) return [];

    const w = frame.width, h = frame.height;
    const diff = [];

    const fD = frame.data;
    const bD = bgFrame.data;

    for (let i = 0; i < fD.length; i += 4) {
        const dr = Math.abs(fD[i] - bD[i]);
        const dg = Math.abs(fD[i + 1] - bD[i + 1]);
        const db = Math.abs(fD[i + 2] - bD[i + 2]);
        const d = (dr + dg + db) / 3;
        diff.push(d);
    }

    const mean = diff.reduce((a, b) => a + b, 0) / diff.length;
    let sumSq = 0;
    diff.forEach(v => (sumSq += (v - mean) ** 2));
    const std = Math.sqrt(sumSq / diff.length);

    const thresh = mean + 2 * std;
    const points = [];

    for (let i = 0; i < diff.length; i++) {
        if (diff[i] > thresh) {
            const y = Math.floor(i / w);
            const x = i % w;
            points.push([x, y]);
        }
    }
    return points;
}

// ----------- Kalman simple 2D -----------

class Kalman2D {
    constructor() {
        this.x = 0;
        this.y = 0;
        this.vx = 0;
        this.vy = 0;
        this.P = 1;
    }
    update(mx, my) {
        const K = this.P / (this.P + 0.1);
        this.x += K * (mx - this.x);
        this.y += K * (my - this.y);
        this.vx = mx - this.x;
        this.vy = my - this.y;
        this.P = (1 - K) * this.P + 0.01;
    }
}

// ----------- PROCESS -----------

document.getElementById("processBtn").addEventListener("click", processVideo);

async function processVideo() {
    if (processInProgress) return;
    processInProgress = true;

    const dt = parseFloat(document.getElementById("frameStepMs").value) / 1000;
    const angleDeg = parseFloat(document.getElementById("angleInput").value);
    const angle = angleDeg * Math.PI / 180;

    const kalman = new Kalman2D();
    const samples = [];

    for (let i = 0; i < recordFrames.length; i++) {
        const pts = detectMotion(recordFrames[i]);
        if (!pts.length) continue;

        const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;

        kalman.update(mx, my);

        samples.push({
            t: i * dt,
            x: kalman.x,
            y: kalman.y
        });
    }

    const samplesFilt = samples.filter((s, i) => i % 3 === 0);

    // Vitesse
    samplesFilt.forEach((s, i) => {
        if (i === 0) {
            s.vx = 0;
            s.vy = 0;
        } else {
            s.vx = (samplesFilt[i].x - samplesFilt[i - 1].x) / dt;
            s.vy = (samplesFilt[i].y - samplesFilt[i - 1].y) / dt;
        }
    });

    // Régression vx vs t
    const times = samplesFilt.map(s => s.t);
    const vxs   = samplesFilt.map(s => s.vx);

    const fit = linearRegression(times, vxs);
    const aEst = fit.slope;

    document.getElementById("aEstimated").textContent = aEst.toFixed(4);
    document.getElementById("aTheory").textContent =
        (9.81 * Math.sin(angle)).toFixed(4);

    buildCharts(times, vxs, fit);
    buildPositionChart(samplesFilt);

    document.getElementById("nSamples").textContent = samplesFilt.length;

    processInProgress = false;
}

// ----------- Régression linéaire -----------

function linearRegression(t, v) {
    const n = t.length;
    const sumT = t.reduce((a, b) => a + b, 0);
    const sumV = v.reduce((a, b) => a + b, 0);
    const sumTV = t.reduce((a, b, i) => a + b * v[i], 0);
    const sumTT = t.reduce((a, b) => a + b * b, 0);

    const slope = (n * sumTV - sumT * sumV) / (n * sumTT - sumT ** 2);
    const intercept = (sumV - slope * sumT) / n;

    return { slope, intercept };
}

// ----------- AFFICHAGE CHARTS -----------

let velChartObj = null;
let fitChartObj = null;
let doc3ChartObj = null;

function buildCharts(times, velocities, fit) {
    const ctxVel = document.getElementById("velChart").getContext("2d");
    if (velChartObj) velChartObj.destroy();

    velChartObj = new Chart(ctxVel, {
        type: "line",
        data: {
            labels: times,
            datasets: [
                {
                    label: "Vitesse (m/s)",
                    data: velocities,
                    borderWidth: 2,
                    fill: false
                }
            ]
        }
    });

    const ctxFit = document.getElementById("fitChart").getContext("2d");
    if (fitChartObj) fitChartObj.destroy();

    fitChartObj = new Chart(ctxFit, {
        type: "line",
        data: {
            labels: times,
            datasets: [
                {
                    label: "Données",
                    data: velocities,
                    borderWidth: 2,
                    fill: false
                },
                {
                    label: "v = a·t",
                    data: times.map(t => fit.slope * t + fit.intercept),
                    borderDash: [5, 5],
                    borderWidth: 2,
                    fill: false
                }
            ]
        }
    });

    document.getElementById("regEquation").textContent =
        `v = ${fit.slope.toFixed(4)}·t + ${fit.intercept.toFixed(4)}`;
}

function buildPositionChart(samples) {
    const ctxDoc3 = document.getElementById("doc3Chart").getContext("2d");
    if (doc3ChartObj) doc3ChartObj.destroy();

    doc3ChartObj = new Chart(ctxDoc3, {
        type: "line",
        data: {
            labels: samples.map(s => s.t),
            datasets: [
                {
                    label: "Position X (px)",
                    data: samples.map(s => s.x),
                    borderWidth: 2,
                    fill: false
                }
            ]
        }
    });
}

// ----------- IMPORT CSV -----------

document.getElementById("csvInput").addEventListener("change", e => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = evt => {
        const lines = evt.target.result.split("\n").map(l => l.trim());
        const rows = lines.slice(1).map(l => l.split(","));

        const t = rows.map(r => parseFloat(r[0]));
        const vx = rows.map(r => parseFloat(r[3]));

        const fit = linearRegression(t, vx);
        buildCharts(t, vx, fit);

        document.getElementById("aEstimated").textContent =
            fit.slope.toFixed(4);
    };
    reader.readAsText(file);
});
