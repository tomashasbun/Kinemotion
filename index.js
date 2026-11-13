const videoElement = document.getElementById('video');
const canvasElement = document.getElementById('canvas');
const canvasCtx = canvasElement.getContext('2d');

const angleValueElement = document.getElementById('angle-value');
const statusTextElement = document.getElementById('status-text');
const pathologyTextElement = document.getElementById('pathology-text');
const angleCard = document.getElementById('angle-card');
const scaleMarker = document.getElementById('scale-marker');
const romValueElement = document.getElementById('rom-value');
const maxValueElement = document.getElementById('max-value');
const minValueElement = document.getElementById('min-value');
const legValueElement = document.getElementById('leg-value');
const stageEmpty = document.getElementById('stage-empty');
const stageResolution = document.getElementById('stage-resolution');
const trackingStatus = document.getElementById('tracking-status');
const recordingLabel = document.getElementById('recording-label');
const sourceBadge = document.getElementById('source-badge');
const sourceLabel = document.getElementById('source-label');
const liveChip = document.getElementById('live-chip');
const sessionClock = document.getElementById('session-clock');
const sampleCount = document.getElementById('sample-count');
const chartEmpty = document.getElementById('chart-empty');
const captureNote = document.getElementById('capture-note');

const startCameraButton = document.getElementById('start-camera-btn');
const stopButton = document.getElementById('stop-btn');
const resetButton = document.getElementById('reset-btn');
const uploadInput = document.getElementById('video-upload');
const legSelect = document.getElementById('leg-select');

const state = {
  mode: 'idle', // idle | camera | file
  stream: null,
  fileUrl: null,
  animationFrameId: null,
  processing: false,
  lastVideoTime: -1,
  lastChartUpdate: 0,
  startTime: null,
  clockTimer: null,
  sampleTimes: [],
  angles: [],
  minAngle: Infinity,
  maxAngle: -Infinity,
  smoothedAngle: null,
  lastLeg: '--',
  autoSide: null,
  poseReady: false,
};

const MAX_CHART_POINTS = 180;
const CHART_INTERVAL_MS = 180;

function formatAngle(value, decimals = 1) {
  if (!Number.isFinite(value)) return '--';
  const rounded = Number(value.toFixed(decimals));
  return `${rounded > 0 ? '+' : ''}${rounded}`;
}

function landmarkConfidence(point) {
  if (!point) return 0;
  const visibility = Number.isFinite(point.visibility) ? point.visibility : null;
  const presence = Number.isFinite(point.presence) ? point.presence : null;
  if (visibility === null && presence === null) return 0;
  if (visibility === null) return presence;
  if (presence === null) return visibility;
  return Math.min(visibility, presence);
}

function createLandmarkSet(landmarks, side) {
  const isLeft = side === 'left';
  const set = {
    key: side,
    side: isLeft ? 'Izquierda' : 'Derecha',
    knee: landmarks[isLeft ? 25 : 26],
    ankle: landmarks[isLeft ? 27 : 28],
    heel: landmarks[isLeft ? 29 : 30],
    toe: landmarks[isLeft ? 31 : 32],
  };

  // Para medir el tobillo necesitamos cuatro hitos visibles, no solo la punta del pie.
  const points = [set.knee, set.ankle, set.heel, set.toe];
  const confidences = points.map(landmarkConfidence);
  const average = confidences.reduce((sum, value) => sum + value, 0) / confidences.length;
  const weakest = Math.min(...confidences);
  set.score = (average * 0.65) + (weakest * 0.35);
  set.valid = points.every((point) => landmarkConfidence(point) >= 0.50);
  return set;
}

function getLandmarkSet(landmarks) {
  const left = createLandmarkSet(landmarks, 'left');
  const right = createLandmarkSet(landmarks, 'right');
  const selectedSide = legSelect.value;

  if (selectedSide === 'left') {
    state.autoSide = null;
    return left;
  }
  if (selectedSide === 'right') {
    state.autoSide = null;
    return right;
  }

  // En automático se mantiene la pierna elegida para evitar saltos entre lados
  // cuando la confianza de MediaPipe fluctúa ligeramente entre fotogramas.
  const current = state.autoSide === 'left' ? left : state.autoSide === 'right' ? right : null;
  const alternative = state.autoSide === 'left' ? right : left;

  if (current && current.valid) {
    if (alternative.valid && alternative.score > current.score * 1.25 && alternative.score > 0.72) {
      state.autoSide = alternative.key;
      return alternative;
    }
    return current;
  }

  const best = left.score >= right.score ? left : right;
  const other = best.key === 'left' ? right : left;
  if (best.valid && best.score >= 0.58) {
    state.autoSide = best.key;
    return best;
  }
  if (other.valid && other.score >= 0.58) {
    state.autoSide = other.key;
    return other;
  }
  return best;
}

function isLandmarkVisible(point) {
  return landmarkConfidence(point) >= 0.50;
}

function calculateAnkleAngle(knee, ankle, heel, toe) {
  // Se trabaja en píxeles: x e y de MediaPipe están normalizados por separado.
  // Corregir la relación de aspecto evita distorsionar el ángulo en videos 16:9.
  const width = canvasElement.width;
  const height = canvasElement.height;
  const shank = {
    x: (knee.x - ankle.x) * width,
    y: (knee.y - ankle.y) * height,
  };
  // Eje longitudinal del pie: talón -> punta, más estable que tobillo -> punta.
  const foot = {
    x: (toe.x - heel.x) * width,
    y: (toe.y - heel.y) * height,
  };

  const shankLength = Math.hypot(shank.x, shank.y);
  const footLength = Math.hypot(foot.x, foot.y);
  if (shankLength < 18 || footLength < 18) return null;

  const dot = (shank.x * foot.x) + (shank.y * foot.y);
  const cosine = Math.max(-1, Math.min(1, dot / (shankLength * footLength)));
  const includedAngle = Math.acos(cosine) * (180 / Math.PI);

  // Convención: 90° entre tibia y pie = neutro; menor = dorsiflexión (+),
  // mayor = flexión plantar (−). El cálculo es válido con el pie orientado
  // hacia la izquierda o hacia la derecha de la imagen.
  return 90 - includedAngle;
}

function setTrackingState(detected, message) {
  trackingStatus.classList.toggle('detected', detected);
  trackingStatus.innerHTML = `<span class="tracking-dot"></span> ${message}`;
}

function resizeCanvasToImage(image) {
  const width = image.videoWidth || image.width || 640;
  const height = image.videoHeight || image.height || 480;
  if (canvasElement.width !== width || canvasElement.height !== height) {
    canvasElement.width = width;
    canvasElement.height = height;
    stageResolution.textContent = `${width} × ${height}`;
  }
}

function drawSkeleton(knee, ankle, heel, toe) {
  const width = canvasElement.width;
  const height = canvasElement.height;
  const px = (point) => ({ x: point.x * width, y: point.y * height });
  const points = [
    { point: knee, label: 'RODILLA', color: '#55d8a6' },
    { point: ankle, label: 'TOBILLO', color: '#ffbe69' },
    { point: heel, label: 'TALÓN', color: '#77b7ff' },
    { point: toe, label: 'PUNTA', color: '#d6a2ff' },
  ];

  canvasCtx.save();
  canvasCtx.lineCap = 'round';
  canvasCtx.lineJoin = 'round';

  // Segmento de la pierna (rodilla-tobillo).
  canvasCtx.beginPath();
  canvasCtx.moveTo(px(knee).x, px(knee).y);
  canvasCtx.lineTo(px(ankle).x, px(ankle).y);
  canvasCtx.strokeStyle = '#55d8a6';
  canvasCtx.lineWidth = Math.max(3, width * 0.004);
  canvasCtx.shadowColor = 'rgba(74, 218, 201, .45)';
  canvasCtx.shadowBlur = 10;
  canvasCtx.stroke();

  // Eje del pie utilizado en el cálculo (talón-punta).
  canvasCtx.beginPath();
  canvasCtx.moveTo(px(heel).x, px(heel).y);
  canvasCtx.lineTo(px(toe).x, px(toe).y);
  canvasCtx.strokeStyle = '#77b7ff';
  canvasCtx.lineWidth = Math.max(3, width * 0.004);
  canvasCtx.stroke();
  canvasCtx.shadowBlur = 0;

  // Unión visual tobillo-talón para mostrar los cuatro hitos del modelo.
  canvasCtx.beginPath();
  canvasCtx.moveTo(px(ankle).x, px(ankle).y);
  canvasCtx.lineTo(px(heel).x, px(heel).y);
  canvasCtx.strokeStyle = 'rgba(255,255,255,.72)';
  canvasCtx.lineWidth = Math.max(2, width * 0.0025);
  canvasCtx.setLineDash([5, 6]);
  canvasCtx.stroke();
  canvasCtx.setLineDash([]);

  points.forEach(({ point, label, color }) => {
    const position = px(point);
    const radius = Math.max(5, width * 0.0065);
    canvasCtx.beginPath();
    canvasCtx.arc(position.x, position.y, radius, 0, Math.PI * 2);
    canvasCtx.fillStyle = color;
    canvasCtx.fill();
    canvasCtx.lineWidth = 2;
    canvasCtx.strokeStyle = '#071522';
    canvasCtx.stroke();

    // Etiquetas pequeñas para comprobar visualmente que cada hito esté bien ubicado.
    canvasCtx.font = `600 ${Math.max(10, width * 0.012)}px Arial`;
    const textWidth = canvasCtx.measureText(label).width;
    const labelX = Math.min(Math.max(4, position.x + radius + 5), width - textWidth - 10);
    const labelY = Math.max(14, position.y - radius - 7);
    canvasCtx.fillStyle = 'rgba(5, 15, 27, .78)';
    canvasCtx.fillRect(labelX - 4, labelY - 11, textWidth + 8, 16);
    canvasCtx.fillStyle = '#ffffff';
    canvasCtx.fillText(label, labelX, labelY + 1);
  });
  canvasCtx.restore();
}

function classifyAngle(angle) {
  if (angle > 20) {
    return {
      label: 'Dorsiflexión sobre referencia',
      description: 'El valor supera el límite superior configurado (+20°). Interpreta el resultado junto con la evaluación clínica.',
      className: 'warning',
    };
  }
  if (angle < -25) {
    return {
      label: 'Flexión plantar sobre referencia',
      description: 'El valor está por debajo del límite inferior configurado (−25°). Revisa la técnica y la posición de la cámara.',
      className: 'danger',
    };
  }
  if (angle >= 0) {
    return {
      label: 'Dorsiflexión en referencia',
      description: 'La medición está dentro del rango de referencia configurado para dorsiflexión.',
      className: 'normal',
    };
  }
  return {
    label: 'Flexión plantar en referencia',
    description: 'La medición está dentro del rango de referencia configurado para flexión plantar.',
    className: 'normal',
  };
}

function updateAngleUI(angle, legSide) {
  angleValueElement.textContent = formatAngle(angle, 1);
  const classification = classifyAngle(angle);
  statusTextElement.textContent = classification.label;
  pathologyTextElement.textContent = classification.description;
  angleCard.classList.remove('warning', 'danger');
  if (classification.className !== 'normal') angleCard.classList.add(classification.className);
  legValueElement.textContent = legSide;

  // Escala visual limitada a -40° ... +40°.
  const normalized = Math.max(0, Math.min(100, ((angle + 40) / 80) * 100));
  scaleMarker.style.left = `${normalized}%`;
}

function updateMetrics() {
  if (state.angles.length === 0) {
    romValueElement.innerHTML = '--<small>°</small>';
    maxValueElement.innerHTML = '--<small>°</small>';
    minValueElement.innerHTML = '--<small>°</small>';
    sampleCount.textContent = '0 muestras';
    return;
  }
  const rom = state.maxAngle - state.minAngle;
  romValueElement.innerHTML = `${rom.toFixed(1)}<small>°</small>`;
  maxValueElement.innerHTML = `${formatAngle(state.maxAngle, 1)}<small>°</small>`;
  minValueElement.innerHTML = `${formatAngle(state.minAngle, 1)}<small>°</small>`;
  sampleCount.textContent = `${state.angles.length} muestras`;
}

function updateSessionClock() {
  if (!state.startTime) {
    sessionClock.textContent = '00:00';
    return;
  }
  const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
  const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const seconds = String(elapsed % 60).padStart(2, '0');
  sessionClock.textContent = `${minutes}:${seconds}`;
}

function startClock() {
  if (!state.startTime) state.startTime = Date.now();
  if (state.clockTimer) clearInterval(state.clockTimer);
  state.clockTimer = setInterval(updateSessionClock, 500);
  updateSessionClock();
}

function stopClock() {
  if (state.clockTimer) clearInterval(state.clockTimer);
  state.clockTimer = null;
}

function updateChart(angle, timestamp) {
  const elapsedSeconds = Math.max(0, (timestamp - state.startTime) / 1000);
  const minutes = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
  const seconds = String(Math.floor(elapsedSeconds % 60)).padStart(2, '0');
  const label = `${minutes}:${seconds}`;

  romChart.data.labels.push(label);
  romChart.data.datasets[0].data.push(Number(angle.toFixed(2)));
  romChart.data.datasets[1].data.push(0);
  romChart.data.datasets[2].data.push(20);
  romChart.data.datasets[3].data.push(-25);

  if (romChart.data.labels.length > MAX_CHART_POINTS) {
    romChart.data.labels.shift();
    romChart.data.datasets.forEach((dataset) => dataset.data.shift());
  }
  romChart.update('none');
  chartEmpty.classList.add('hidden');
}

function recordAngle(angle, legSide) {
  // Suavizado exponencial ligero para reducir pequeños saltos de los landmarks.
  state.smoothedAngle = state.smoothedAngle === null
    ? angle
    : (state.smoothedAngle * 0.72) + (angle * 0.28);
  const stableAngle = state.smoothedAngle;

  state.angles.push(stableAngle);
  state.minAngle = Math.min(state.minAngle, stableAngle);
  state.maxAngle = Math.max(state.maxAngle, stableAngle);
  state.lastLeg = legSide;

  updateAngleUI(stableAngle, legSide);
  updateMetrics();

  const now = performance.now();
  if (now - state.lastChartUpdate >= CHART_INTERVAL_MS) {
    updateChart(stableAngle, Date.now());
    state.lastChartUpdate = now;
  }
}

function onPoseResults(results) {
  const image = results.image;
  if (!image) return;

  resizeCanvasToImage(image);
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  canvasCtx.drawImage(image, 0, 0, canvasElement.width, canvasElement.height);
  stageEmpty.hidden = true;

  const landmarks = results.poseLandmarks;
  if (!landmarks) {
    setTrackingState(false, 'No se detecta la pierna');
    angleValueElement.textContent = '--';
    statusTextElement.textContent = 'Esperando puntos de referencia';
    pathologyTextElement.textContent = 'Mantén la rodilla, el tobillo, el talón y la punta del pie visibles en la imagen.';
    return;
  }

  const selected = getLandmarkSet(landmarks);
  const { knee, ankle, heel, toe, side } = selected;
  const requiredLandmarks = [knee, ankle, heel, toe];
  if (!requiredLandmarks.every(isLandmarkVisible)) {
    setTrackingState(false, 'Hitos anatómicos incompletos');
    angleValueElement.textContent = '--';
    statusTextElement.textContent = 'No se reconocen todos los hitos';
    pathologyTextElement.textContent = 'Se necesitan rodilla, tobillo, talón y punta del pie. Usa una vista lateral y evita ocultar el pie.';
    return;
  }

  const clinicalAngle = calculateAnkleAngle(knee, ankle, heel, toe);
  if (clinicalAngle === null || !Number.isFinite(clinicalAngle)) {
    setTrackingState(false, 'Ajusta la posición');
    angleValueElement.textContent = '--';
    statusTextElement.textContent = 'Puntos demasiado próximos';
    pathologyTextElement.textContent = 'Separa ligeramente la pierna del fondo y asegúrate de que la cámara vea el talón y la punta del pie.';
    return;
  }

  drawSkeleton(knee, ankle, heel, toe);
  setTrackingState(true, `Hitos detectados · Pierna ${side.toLowerCase()}`);
  recordAngle(clinicalAngle, side);
}

function setCaptureUI(mode) {
  const active = mode !== 'idle';
  state.mode = mode;
  stopButton.disabled = !active;
  startCameraButton.disabled = mode === 'camera';
  liveChip.classList.toggle('active', active);
  liveChip.textContent = active ? 'ANALIZANDO' : 'INACTIVO';
  recordingLabel.classList.toggle('active', active);
  recordingLabel.innerHTML = active
    ? '<span class="recording-dot"></span> ANALIZANDO'
    : '<span class="recording-dot"></span> EN ESPERA';
  sourceBadge.classList.toggle('active', active);
  sourceLabel.textContent = mode === 'camera' ? 'Webcam' : mode === 'file' ? 'Video cargado' : 'Sin señal';
}

function startProcessingLoop() {
  cancelAnimationFrame(state.animationFrameId);
  state.lastVideoTime = -1;

  const process = async () => {
    if (state.mode === 'idle') return;
    if (videoElement.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        videoElement.videoWidth > 0 &&
        videoElement.currentTime !== state.lastVideoTime &&
        !state.processing) {
      state.processing = true;
      state.lastVideoTime = videoElement.currentTime;
      try {
        await pose.send({ image: videoElement });
      } catch (error) {
        console.error('Error procesando el cuadro con MediaPipe:', error);
        captureNote.textContent = 'No se pudo procesar un cuadro. Comprueba que el video tenga un formato compatible.';
      } finally {
        state.processing = false;
      }
    }
    if (state.mode !== 'idle') state.animationFrameId = requestAnimationFrame(process);
  };

  state.animationFrameId = requestAnimationFrame(process);
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    alert('Tu navegador no permite acceder a la cámara. Abre la aplicación mediante HTTPS o desde localhost.');
    return;
  }

  stopCapture(false);
  resetMeasurements();
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    videoElement.srcObject = state.stream;
    videoElement.loop = true;
    await videoElement.play();
    canvasElement.classList.add('mirrored');
    setCaptureUI('camera');
    startClock();
    setTrackingState(false, 'Buscando pierna');
    captureNote.textContent = 'Webcam activa. Coloca la pierna de perfil y mantén rodilla, tobillo y pie dentro del encuadre.';
    startProcessingLoop();
  } catch (error) {
    console.error('No se pudo iniciar la webcam:', error);
    stopCapture(false);
    let message = 'No se pudo iniciar la cámara.';
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      message = 'Permite el acceso a la cámara desde los permisos del navegador y vuelve a intentarlo.';
    } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      message = 'No se encontró una cámara conectada al dispositivo.';
    }
    captureNote.textContent = message;
    alert(message);
  }
}

async function loadVideo(file) {
  if (!file) return;
  if (!file.type.startsWith('video/')) {
    alert('Selecciona un archivo de video válido.');
    uploadInput.value = '';
    return;
  }

  stopCapture(false);
  resetMeasurements();
  if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
  state.fileUrl = URL.createObjectURL(file);
  videoElement.srcObject = null;
  videoElement.src = state.fileUrl;
  videoElement.loop = true;
  videoElement.muted = true;
  canvasElement.classList.remove('mirrored');

  try {
    await new Promise((resolve, reject) => {
      videoElement.onloadedmetadata = resolve;
      videoElement.onerror = () => reject(new Error('No se pudo abrir el archivo de video.'));
    });
    await videoElement.play();
    setCaptureUI('file');
    startClock();
    setTrackingState(false, 'Procesando video');
    captureNote.textContent = `Analizando: ${file.name}. El video se reproduce en bucle para facilitar la observación.`;
    startProcessingLoop();
  } catch (error) {
    console.error('Error al cargar el video:', error);
    stopCapture(false);
    captureNote.textContent = 'No fue posible reproducir este video. Prueba con MP4, WebM o MOV.';
    alert('No fue posible reproducir este video. Prueba con un archivo MP4 o WebM.');
  }
}

function stopCapture(clearSource = true) {
  state.mode = 'idle';
  cancelAnimationFrame(state.animationFrameId);
  state.animationFrameId = null;
  state.lastVideoTime = -1;
  state.processing = false;

  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }
  videoElement.pause();
  if (clearSource) {
    videoElement.srcObject = null;
    videoElement.removeAttribute('src');
    videoElement.load();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    canvasElement.width = 640;
    canvasElement.height = 360;
    stageResolution.textContent = '-- × --';
    stageEmpty.hidden = false;
    canvasElement.classList.remove('mirrored');
  }

  setCaptureUI('idle');
  stopClock();
  setTrackingState(false, 'Captura detenida');
  updateSessionClock();
}

function resetMeasurements() {
  state.sampleTimes = [];
  state.angles = [];
  state.minAngle = Infinity;
  state.maxAngle = -Infinity;
  state.smoothedAngle = null;
  state.lastLeg = '--';
  state.autoSide = null;
  state.lastChartUpdate = 0;
  state.startTime = state.mode === 'idle' ? null : Date.now();

  romChart.data.labels = [];
  romChart.data.datasets.forEach((dataset) => { dataset.data = []; });
  romChart.update('none');
  chartEmpty.classList.remove('hidden');

  angleValueElement.textContent = '--';
  statusTextElement.textContent = 'Esperando medición';
  pathologyTextElement.textContent = 'Inicia la captura y coloca la pierna de perfil frente a la cámara.';
  angleCard.classList.remove('warning', 'danger');
  legValueElement.textContent = '--';
  scaleMarker.style.left = '55.5%';
  updateMetrics();
  updateSessionClock();
  if (state.mode !== 'idle') startClock();
}

// Gráfico de ROM: línea de ángulo y referencias clínicas horizontales.
const chartContext = document.getElementById('rom-chart').getContext('2d');
const chartGradient = chartContext.createLinearGradient(0, 0, 0, 250);
chartGradient.addColorStop(0, 'rgba(85, 198, 235, .22)');
chartGradient.addColorStop(1, 'rgba(85, 198, 235, 0)');

const romChart = new Chart(chartContext, {
  type: 'line',
  data: {
    labels: [],
    datasets: [
      {
        label: 'Ángulo medido', data: [], borderColor: '#55c6eb', backgroundColor: chartGradient,
        borderWidth: 2.2, fill: true, tension: 0.28, pointRadius: 0, pointHitRadius: 8,
      },
      {
        label: 'Neutro (0°)', data: [], borderColor: 'rgba(173, 192, 213, .65)',
        borderWidth: 1, borderDash: [5, 5], pointRadius: 0, fill: false,
      },
      {
        label: 'Límite +20°', data: [], borderColor: 'rgba(224, 177, 107, .8)',
        borderWidth: 1, borderDash: [2, 5], pointRadius: 0, fill: false,
      },
      {
        label: 'Límite −25°', data: [], borderColor: 'rgba(224, 177, 107, .8)',
        borderWidth: 1, borderDash: [2, 5], pointRadius: 0, fill: false,
      },
    ],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { intersect: false, mode: 'index' },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#0b1727',
        borderColor: 'rgba(144, 177, 211, .2)',
        borderWidth: 1,
        titleColor: '#dceafa',
        bodyColor: '#9db4ce',
        padding: 10,
        callbacks: {
          label: (context) => `${context.dataset.label}: ${Number(context.parsed.y).toFixed(1)}°`,
        },
      },
    },
    scales: {
      x: {
        grid: { color: 'rgba(145, 169, 197, .07)', drawTicks: false },
        border: { display: false },
        ticks: { color: '#748ba6', maxTicksLimit: 7, maxRotation: 0, font: { family: 'DM Sans', size: 9 } },
      },
      y: {
        min: -45,
        max: 45,
        grid: { color: 'rgba(145, 169, 197, .09)', drawTicks: false },
        border: { display: false },
        ticks: { stepSize: 15, color: '#748ba6', padding: 8, font: { family: 'DM Sans', size: 9 }, callback: (value) => `${value}°` },
      },
    },
  },
});

// Inicializa MediaPipe una sola vez.
const pose = new Pose({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
});
pose.setOptions({
  // El modelo 2 prioriza precisión de landmarks sobre velocidad de procesamiento.
  modelComplexity: 2,
  smoothLandmarks: true,
  enableSegmentation: false,
  minDetectionConfidence: 0.60,
  minTrackingConfidence: 0.60,
});
pose.onResults(onPoseResults);

startCameraButton.addEventListener('click', startCamera);
stopButton.addEventListener('click', () => stopCapture(true));
resetButton.addEventListener('click', resetMeasurements);
uploadInput.addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  loadVideo(file);
  // Permite volver a seleccionar el mismo archivo más adelante.
  uploadInput.value = '';
});
legSelect.addEventListener('change', () => {
  resetMeasurements();
  if (state.mode !== 'idle') {
    captureNote.textContent = `Extremidad seleccionada: ${legSelect.options[legSelect.selectedIndex].text}. Se reinició el registro para no mezclar mediciones de ambas piernas.`;
  }
});

window.addEventListener('beforeunload', () => {
  stopCapture(false);
  resetMeasurements();
  if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
});

// Estado inicial del panel.
setCaptureUI('idle');
setTrackingState(false, 'Esperando sujeto');
updateMetrics();

/* ============================================================================
   KINEMOTION · EXTENSIÓN ADITIVA DE EVALUACIÓN
   Se añade al final del archivo para conservar intacta la implementación base.
   Incluye: KPIs ampliados, registros, importación CSV, validación y exportación.
   ============================================================================ */

const kmAddon = (() => {
  const APP_VERSION = 'KineMotion 1.1 · extensión ABM';
  const MIN_SAMPLES_TO_SAVE = 5;
  const MAX_CSV_BYTES = 5 * 1024 * 1024;
  const DEFAULT_TOLERANCES = { rom: 5, dorsiflexion: 5, plantarflexion: 5 };

  let samples = [];
  let records = [];
  let validations = [];
  let sessionToken = makeId('SES');
  let sourceMode = 'Sin datos';
  let demoActive = false;
  let lastSavedSessionToken = null;
  let tolerances = { ...DEFAULT_TOLERANCES };
  let tolerancesConfirmed = false;
  let toleranceConfirmedAt = null;
  let lastExportAt = null;
  let validationMethod = '';
  let lastKpiUiUpdate = 0;
  let lastTrackingNotice = '';
  let lastTrackingNoticeAt = 0;

  const root = document.createElement('section');
  root.id = 'km-extension';
  root.className = 'km-extension';
  root.setAttribute('aria-label', 'Herramientas ampliadas de análisis y validación');
  root.innerHTML = `
    <section class="km-panel km-workflow-panel" aria-labelledby="km-workflow-title">
      <div class="km-section-heading">
        <div>
          <p class="km-kicker">FLUJO DE EVALUACIÓN · TRAZABILIDAD</p>
          <h2 id="km-workflow-title">Registro y evaluación completa</h2>
          <p class="km-muted">Conserva cada ejecución como un registro independiente, revisa sus indicadores y exporta los datos utilizados.</p>
        </div>
        <span class="km-version-chip">${APP_VERSION}</span>
      </div>
      <div class="km-step-grid" id="km-step-grid" aria-label="Etapas del flujo">
        <div class="km-step" data-step="1"><span class="km-step-number">1</span><div><strong>Adquisición</strong><small>Webcam, video o CSV</small></div><span class="km-step-state">Pendiente</span></div>
        <div class="km-step" data-step="2"><span class="km-step-number">2</span><div><strong>Análisis</strong><small>Datos y procesamiento</small></div><span class="km-step-state">Pendiente</span></div>
        <div class="km-step" data-step="3"><span class="km-step-number">3</span><div><strong>Indicadores</strong><small>KPIs e interpretación</small></div><span class="km-step-state">Pendiente</span></div>
        <div class="km-step" data-step="4"><span class="km-step-number">4</span><div><strong>Exportación</strong><small>Informe y datos crudos</small></div><span class="km-step-state">Pendiente</span></div>
      </div>
      <div class="km-action-bar">
        <div class="km-action-group">
          <button type="button" class="km-btn km-btn-primary" id="km-save-record" disabled>Guardar registro</button>
          <button type="button" class="km-btn" id="km-demo-a">Cargar demo A</button>
          <button type="button" class="km-btn" id="km-demo-b">Cargar demo B</button>
          <label class="km-btn km-file-btn" for="km-csv-upload">Importar CSV</label>
          <input type="file" id="km-csv-upload" accept=".csv,text/csv" hidden />
          <button type="button" class="km-btn km-btn-light" id="km-example-csv">Descargar CSV de ejemplo</button>
        </div>
        <div class="km-action-group">
          <button type="button" class="km-btn km-btn-export" id="km-export-json" disabled>Exportar informe JSON</button>
          <button type="button" class="km-btn km-btn-export" id="km-export-csv" disabled>Exportar resumen CSV</button>
        </div>
      </div>
      <div class="km-inline-status" id="km-inline-status" role="status" aria-live="polite">Carga una captura, importa un CSV o abre uno de los casos de demostración.</div>
      <div class="km-meta-grid">
        <div class="km-meta-item"><span>Fuente activa</span><strong id="km-source-value">Sin datos</strong></div>
        <div class="km-meta-item"><span>Muestras válidas</span><strong id="km-samples-value">0</strong></div>
        <div class="km-meta-item"><span>Frecuencia efectiva</span><strong id="km-frequency-value">—</strong></div>
        <div class="km-meta-item"><span>Registro en curso</span><strong id="km-session-value">—</strong></div>
      </div>
    </section>

    <section class="km-panel" aria-labelledby="km-kpi-title">
      <div class="km-section-heading">
        <div>
          <p class="km-kicker">INDICADORES CINEMÁTICOS</p>
          <h2 id="km-kpi-title">KPIs ampliados del tobillo</h2>
          <p class="km-muted">Los valores se actualizan desde los datos de la sesión actual. Las referencias son orientativas y no constituyen rangos diagnósticos.</p>
        </div>
        <span class="km-unit-chip">Unidad angular: grados (°)</span>
      </div>
      <div class="km-kpi-grid">
        <article class="km-kpi-card km-kpi-highlight"><span>ROM total</span><strong id="km-kpi-rom">—</strong><small>Máximo − mínimo</small></article>
        <article class="km-kpi-card"><span>Pico de dorsiflexión</span><strong id="km-kpi-dorsi">—</strong><small>Máximo de la serie</small></article>
        <article class="km-kpi-card"><span>Pico de flexión plantar</span><strong id="km-kpi-plantar">—</strong><small>Mínimo de la serie</small></article>
        <article class="km-kpi-card"><span>Ángulo medio</span><strong id="km-kpi-mean">—</strong><small>Promedio de muestras</small></article>
        <article class="km-kpi-card"><span>Variabilidad (DE)</span><strong id="km-kpi-sd">—</strong><small>Desviación estándar</small></article>
        <article class="km-kpi-card"><span>Dentro de referencia</span><strong id="km-kpi-range">—</strong><small>Proporción entre −25° y +20°</small></article>
      </div>
      <div class="km-interpretation" id="km-kpi-interpretation">Cuando existan muestras válidas, aquí aparecerá una interpretación descriptiva de los indicadores.</div>
      <div class="km-definition-grid">
        <div><strong>ROM total</strong><p>Máximo angular − mínimo angular de la sesión. Resume la excursión observada, sin equivaler automáticamente al ROM clínico medido con goniómetro.</p></div>
        <div><strong>Picos angulares</strong><p>El máximo representa el mayor valor de dorsiflexión observado; el mínimo, el mayor valor de flexión plantar observado. Ambos se expresan en grados.</p></div>
        <div><strong>Ángulo medio y DE</strong><p>Media aritmética y desviación estándar poblacional de las muestras válidas. Describen el nivel y la dispersión de la serie.</p></div>
        <div><strong>Dentro de referencia</strong><p>Porcentaje de muestras entre −25° y +20°. Es una proporción descriptiva calculada con los límites configurados en esta interfaz.</p></div>
      </div>
    </section>

    <section class="km-panel" aria-labelledby="km-records-title">
      <div class="km-section-heading">
        <div>
          <p class="km-kicker">HISTORIAL DE EJECUCIONES</p>
          <h2 id="km-records-title">Registros independientes</h2>
          <p class="km-muted">Guarda al menos dos capturas diferentes para contrastar los KPIs. Los registros quedan en memoria local hasta que cierres o recargues la página, o los exportes.</p>
        </div>
        <span class="km-count-chip" id="km-record-count">0 registros</span>
      </div>
      <div class="km-record-list" id="km-record-list"><div class="km-empty-state">Aún no hay registros guardados. Analiza una captura y selecciona “Guardar registro”.</div></div>
      <div class="km-record-note">Privacidad: los registros no se envían a un servidor ni se guardan automáticamente. Evita introducir nombres, RUT u otros identificadores personales.</div>
    </section>

    <section class="km-panel" aria-labelledby="km-validation-title">
      <div class="km-section-heading">
        <div>
          <p class="km-kicker">CRITERIO I5 · VALIDACIÓN CUANTITATIVA</p>
          <h2 id="km-validation-title">Contraste con referencia independiente</h2>
          <p class="km-muted">Compara tres KPIs en dos registros. Utiliza una medición independiente (por ejemplo, goniómetro o inclinómetro) y define las tolerancias antes de introducir las referencias.</p>
        </div>
        <span class="km-required-chip">2 registros · 3 KPIs</span>
      </div>
      <div class="km-validation-warning"><strong>Importante:</strong> la tolerancia inicial de 5° es solo un valor de trabajo editable para la demostración; no es un estándar clínico universal. Justifica y confirma los límites antes de realizar el contraste.</div>
      <div class="km-tolerance-area">
        <div class="km-subheading"><h3>1. Definir tolerancias previas</h3><span id="km-tolerance-state">Sin confirmar</span></div>
        <div class="km-tolerance-grid">
          <label>ROM total (°)<input type="number" id="km-tol-rom" min="0" max="90" step="0.1" value="5" /></label>
          <label>Pico dorsiflexión (°)<input type="number" id="km-tol-dorsi" min="0" max="90" step="0.1" value="5" /></label>
          <label>Pico flexión plantar (°)<input type="number" id="km-tol-plantar" min="0" max="90" step="0.1" value="5" /></label>
        </div>
        <div class="km-tolerance-actions"><button type="button" class="km-btn km-btn-primary" id="km-confirm-tolerances">Confirmar tolerancias</button><button type="button" class="km-btn" id="km-edit-tolerances" hidden>Editar tolerancias</button><span class="km-helper" id="km-tolerance-help">Confirma antes de completar las referencias.</span></div>
      </div>
      <div class="km-subheading"><h3>2. Seleccionar dos registros y anotar la referencia</h3><span>Valores en grados (°)</span></div>
      <div class="km-reference-grid">
        <fieldset class="km-reference-card">
          <legend>Registro A</legend>
          <label>Registro guardado<select id="km-record-a"><option value="">Selecciona un registro</option></select></label>
          <label>ROM de referencia (°)<input type="number" id="km-ref-a-rom" step="0.1" placeholder="Ej. 35.0" /></label>
          <label>Dorsiflexión de referencia (°)<input type="number" id="km-ref-a-dorsi" step="0.1" placeholder="Ej. 15.0" /></label>
          <label>Flexión plantar de referencia (°)<input type="number" id="km-ref-a-plantar" step="0.1" placeholder="Ej. -20.0" /></label>
        </fieldset>
        <fieldset class="km-reference-card">
          <legend>Registro B</legend>
          <label>Registro guardado<select id="km-record-b"><option value="">Selecciona un registro</option></select></label>
          <label>ROM de referencia (°)<input type="number" id="km-ref-b-rom" step="0.1" placeholder="Ej. 32.0" /></label>
          <label>Dorsiflexión de referencia (°)<input type="number" id="km-ref-b-dorsi" step="0.1" placeholder="Ej. 13.0" /></label>
          <label>Flexión plantar de referencia (°)<input type="number" id="km-ref-b-plantar" step="0.1" placeholder="Ej. -19.0" /></label>
        </fieldset>
      </div>
      <div class="km-reference-method">
        <label>Método independiente de referencia<input type="text" id="km-reference-method" placeholder="Ej. Goniómetro universal · protocolo y posición utilizados" /></label>
        <label>Evaluador/a o código anónimo<input type="text" id="km-reference-evaluator" maxlength="60" placeholder="Ej. Eval-02 (sin datos personales)" /></label>
      </div>
      <div class="km-validation-actions"><button type="button" class="km-btn km-btn-primary" id="km-run-validation">Calcular errores y comparar</button><span class="km-helper">Error absoluto = |valor estimado − referencia|. Cumple cuando el error es menor o igual a la tolerancia previa.</span></div>
      <div class="km-validation-output" id="km-validation-output" aria-live="polite"><div class="km-empty-state">La tabla de contraste aparecerá aquí después de completar los dos registros y las referencias independientes.</div></div>
      <div class="km-validation-history" id="km-validation-history"></div>
    </section>

    <section class="km-panel" aria-labelledby="km-method-title">
      <div class="km-section-heading">
        <div>
          <p class="km-kicker">CRITERIOS I1 · I3 · I6 · I7 · I8</p>
          <h2 id="km-method-title">Método, calidad y reproducción</h2>
          <p class="km-muted">Información para interpretar el origen de los datos, las unidades y las condiciones de medición.</p>
        </div>
      </div>
      <div class="km-details-grid">
        <details class="km-details" open>
          <summary>Fuente, procesamiento y parámetros</summary>
          <ul>
            <li><strong>Entrada webcam/video:</strong> MediaPipe Pose (modelo de cuerpo completo, complejidad 2). Se utilizan los landmarks de rodilla, tobillo, talón y punta del pie de la extremidad seleccionada.</li>
            <li><strong>Hitos:</strong> rodilla 25/26, tobillo 27/28, talón 29/30 y punta 31/32 (índices MediaPipe para izquierda/derecha).</li>
            <li><strong>Confianza:</strong> cada hito debe alcanzar visibilidad/presencia mínima de 0,50; la detección del modelo está configurada en 0,60.</li>
            <li><strong>Cálculo:</strong> se corrige la relación de aspecto con ancho y alto del cuadro; se compara el vector rodilla→tobillo con el vector talón→punta. Convención: 90° entre ejes equivale a 0° neutro; menor ángulo incluido produce valor positivo.</li>
            <li><strong>Suavizado:</strong> promedio exponencial 72% de la muestra anterior y 28% de la nueva. El gráfico se actualiza aproximadamente cada 180 ms.</li>
            <li><strong>Unidades y alcance:</strong> grados angulares estimados en una imagen 2D. No hay calibración de longitud física ni conversión a centímetros; no equivale a una medición clínica tridimensional.</li>
          </ul>
        </details>
        <details class="km-details">
          <summary>Cómo probar el flujo completo</summary>
          <ol>
            <li>Abre la app en HTTPS o localhost y permite el uso de webcam, o carga un video lateral compatible.</li>
            <li>Como alternativa, importa un CSV con columnas <code>time_s,angle_deg</code> o carga el caso de demostración A/B.</li>
            <li>Espera al menos cinco muestras válidas y presiona “Guardar registro”. Repite con otra ejecución para tener dos registros.</li>
            <li>Confirma las tolerancias antes de ingresar referencias externas; selecciona dos registros distintos y anota los tres KPIs de referencia.</li>
            <li>Ejecuta el contraste y exporta el informe JSON o el resumen CSV. Reabre el JSON para comprobar la trazabilidad.</li>
          </ol>
        </details>
        <details class="km-details">
          <summary>Errores frecuentes y recuperación</summary>
          <ul>
            <li><strong>Cámara bloqueada:</strong> revisa el permiso del navegador y utiliza HTTPS o localhost. Si no hay cámara, importa un CSV o utiliza los ejemplos.</li>
            <li><strong>Hitos incompletos:</strong> usa vista lateral, buena iluminación y deja rodilla, tobillo, talón y punta del pie visibles.</li>
            <li><strong>Video incompatible:</strong> prueba MP4 (H.264) o WebM y confirma que el archivo no esté dañado.</li>
            <li><strong>CSV inválido:</strong> revisa que tenga encabezados y al menos cinco filas numéricas con tiempo ascendente y ángulos en grados.</li>
            <li><strong>Sin resultados:</strong> el sistema no considera válidas las muestras cuando faltan hitos o los segmentos son demasiado pequeños.</li>
          </ul>
        </details>
        <details class="km-details">
          <summary>Versiones, almacenamiento y límites</summary>
          <ul>
            <li><strong>Interfaz:</strong> HTML, CSS y JavaScript ES Modules, versión ${APP_VERSION}.</li>
            <li><strong>Bibliotecas base:</strong> MediaPipe Pose desde jsDelivr y Chart.js 4.4.7 desde jsDelivr. Se requiere conexión a internet para cargar esas bibliotecas desde CDN.</li>
            <li><strong>Almacenamiento:</strong> procesamiento en el navegador; los registros se mantienen solo en memoria mientras la página está abierta. Exporta para conservarlos.</li>
            <li><strong>Datos personales:</strong> usa códigos anónimos. No introduzcas identificadores personales en los campos de evaluador o notas.</li>
            <li><strong>Validación:</strong> dos casos de prueba no acreditan validez clínica general. La referencia debe ser realmente independiente y las tolerancias deben justificarse para el método y propósito.</li>
          </ul>
        </details>
      </div>
    </section>
  `;

  const footer = document.querySelector('.app-footer');
  if (footer) footer.before(root);

  const $ = (id) => document.getElementById(id);
  const refs = {
    status: $('km-inline-status'), save: $('km-save-record'), demoA: $('km-demo-a'), demoB: $('km-demo-b'),
    csvUpload: $('km-csv-upload'), exampleCsv: $('km-example-csv'), exportJson: $('km-export-json'), exportCsv: $('km-export-csv'),
    records: $('km-record-list'), recordCount: $('km-record-count'), source: $('km-source-value'), sampleCount: $('km-samples-value'),
    frequency: $('km-frequency-value'), session: $('km-session-value'), interpretation: $('km-kpi-interpretation'),
    validationOutput: $('km-validation-output'), validationHistory: $('km-validation-history'),
    toleranceState: $('km-tolerance-state'), toleranceHelp: $('km-tolerance-help'), confirmTolerance: $('km-confirm-tolerances'),
    editTolerance: $('km-edit-tolerances'), runValidation: $('km-run-validation'), method: $('km-reference-method'), evaluator: $('km-reference-evaluator'),
  };

  function makeId(prefix) {
    const d = new Date();
    const stamp = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'), '-', String(d.getHours()).padStart(2, '0'), String(d.getMinutes()).padStart(2, '0'), String(d.getSeconds()).padStart(2, '0')].join('');
    return `${prefix}-${stamp}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  }

  function safeText(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function format(value, decimals = 1, withSign = false) {
    if (!Number.isFinite(value)) return '—';
    const rounded = Number(value.toFixed(decimals));
    const sign = withSign && rounded > 0 ? '+' : '';
    return `${sign}${rounded.toFixed(decimals)}`;
  }

  function notify(message, type = 'info') {
    if (!refs.status) return;
    refs.status.textContent = message;
    refs.status.classList.remove('is-error', 'is-success', 'is-warning');
    if (type === 'error') refs.status.classList.add('is-error');
    if (type === 'success') refs.status.classList.add('is-success');
    if (type === 'warning') refs.status.classList.add('is-warning');
  }

  function computeStats(values) {
    const clean = values.map(Number).filter(Number.isFinite);
    if (!clean.length) return null;
    const bounds = clean.reduce((acc, value) => ({ min: Math.min(acc.min, value), max: Math.max(acc.max, value) }), { min: Infinity, max: -Infinity });
    const min = bounds.min;
    const max = bounds.max;
    const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length;
    const variance = clean.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / clean.length;
    const within = clean.filter((value) => value >= -25 && value <= 20).length;
    return {
      n: clean.length, min, max, rom: max - min, mean, sd: Math.sqrt(variance),
      withinPct: (within / clean.length) * 100,
      plantar: min, dorsiflexion: max,
    };
  }

  function currentSamples() {
    if (samples.length) return samples;
    return (state.angles || []).map((angle, index) => ({
      elapsed_s: index * 0.18,
      angle_deg: Number(angle),
      leg_side: state.lastLeg || '--',
      valid: true,
    }));
  }

  function currentStats() {
    return computeStats(currentSamples().map((sample) => sample.angle_deg));
  }

  function currentFrequency() {
    const data = currentSamples();
    if (data.length < 2) return null;
    const duration = data[data.length - 1].elapsed_s - data[0].elapsed_s;
    if (!(duration > 0)) return null;
    return (data.length - 1) / duration;
  }

  function updateStepStates() {
    const dataCount = currentSamples().length;
    const hasInput = state.mode !== 'idle' || demoActive || dataCount > 0 || records.length > 0;
    const hasAnalysis = dataCount >= MIN_SAMPLES_TO_SAVE;
    const hasInterpretation = Boolean(currentStats());
    const stepValues = [hasInput, hasAnalysis, hasInterpretation, Boolean(lastExportAt)];
    root.querySelectorAll('.km-step').forEach((item, index) => {
      const done = Boolean(stepValues[index]);
      item.classList.toggle('is-done', done);
      const stateEl = item.querySelector('.km-step-state');
      if (stateEl) stateEl.textContent = done ? 'Completa' : 'Pendiente';
    });
  }

  function updateLiveKpis() {
    const stats = currentStats();
    const data = currentSamples();
    const frequency = currentFrequency();
    $('km-kpi-rom').textContent = stats ? `${format(stats.rom)}°` : '—';
    $('km-kpi-dorsi').textContent = stats ? `${format(stats.dorsiflexion, 1, true)}°` : '—';
    $('km-kpi-plantar').textContent = stats ? `${format(stats.plantar)}°` : '—';
    $('km-kpi-mean').textContent = stats ? `${format(stats.mean, 1, true)}°` : '—';
    $('km-kpi-sd').textContent = stats ? `${format(stats.sd)}°` : '—';
    $('km-kpi-range').textContent = stats ? `${format(stats.withinPct, 1)}%` : '—';
    refs.source.textContent = sourceMode;
    refs.sampleCount.textContent = String(data.length);
    refs.frequency.textContent = frequency ? `${format(frequency, 1)} Hz` : '—';
    refs.session.textContent = data.length ? sessionToken : '—';
    refs.save.disabled = data.length < MIN_SAMPLES_TO_SAVE || lastSavedSessionToken === sessionToken;
    refs.exportJson.disabled = records.length === 0;
    refs.exportCsv.disabled = records.length === 0;

    if (!stats) {
      refs.interpretation.textContent = 'Cuando existan muestras válidas, aquí aparecerá una interpretación descriptiva de los indicadores.';
    } else {
      const motion = stats.mean >= 0 ? 'predominio de valores hacia dorsiflexión' : 'predominio de valores hacia flexión plantar';
      const rangeText = stats.withinPct >= 90 ? 'La mayoría de las muestras está dentro de los límites configurados.' : 'Una parte de las muestras se encuentra fuera de los límites configurados; verifica la técnica y el plano de captura.';
      refs.interpretation.textContent = `Se registraron ${stats.n} muestras válidas, con un ROM observado de ${format(stats.rom)}°. La media es ${format(stats.mean, 1, true)}° (${motion}). ${rangeText} Esta descripción no identifica una patología.`;
    }
    updateStepStates();
  }

  function renderRecords() {
    refs.recordCount.textContent = `${records.length} ${records.length === 1 ? 'registro' : 'registros'}`;
    if (!records.length) {
      refs.records.innerHTML = '<div class="km-empty-state">Aún no hay registros guardados. Analiza una captura y selecciona “Guardar registro”.</div>';
    } else {
      refs.records.innerHTML = records.map((record) => `
        <article class="km-record-card">
          <div class="km-record-header"><strong>${safeText(record.id)}</strong><span>${safeText(record.source)}</span></div>
          <div class="km-record-stats"><span>ROM <b>${format(record.stats.rom)}°</b></span><span>Dorsi <b>${format(record.stats.dorsiflexion, 1, true)}°</b></span><span>Plantar <b>${format(record.stats.plantar)}°</b></span><span>Muestras <b>${record.stats.n}</b></span></div>
          <div class="km-record-footer"><span>${new Date(record.createdAt).toLocaleString('es-CL')}</span><span>${safeText(record.legSide || 'Lado no identificado')}</span></div>
        </article>`).join('');
    }
    ['a', 'b'].forEach((slot) => {
      const select = $(`km-record-${slot}`);
      const oldValue = select.value;
      select.innerHTML = '<option value="">Selecciona un registro</option>' + records.map((record) => `<option value="${safeText(record.id)}">${safeText(record.id)} · ROM ${format(record.stats.rom)}°</option>`).join('');
      if (records.some((record) => record.id === oldValue)) select.value = oldValue;
    });
    updateLiveKpis();
  }

  function saveRecord() {
    const data = currentSamples();
    const stats = computeStats(data.map((sample) => sample.angle_deg));
    if (!stats || stats.n < MIN_SAMPLES_TO_SAVE) {
      notify(`Se requieren al menos ${MIN_SAMPLES_TO_SAVE} muestras válidas para guardar un registro.`, 'warning');
      return;
    }
    if (lastSavedSessionToken === sessionToken) {
      notify('Esta ejecución ya fue guardada. Inicia otra captura para crear un registro diferente.', 'warning');
      return;
    }
    const record = {
      id: makeId('KM'),
      sessionToken,
      createdAt: new Date().toISOString(),
      source: sourceMode,
      legSide: state.lastLeg || data[data.length - 1]?.leg_side || '--',
      units: 'degrees',
      stats,
      frequencyHz: currentFrequency(),
      durationSeconds: data.length > 1 ? data[data.length - 1].elapsed_s - data[0].elapsed_s : 0,
      sampleCount: data.length,
      samples: data.map((sample) => ({ ...sample })),
      demo: demoActive,
    };
    records.push(record);
    lastSavedSessionToken = sessionToken;
    renderRecords();
    notify(`Registro ${record.id} guardado con ${record.sampleCount} muestras.`, 'success');
  }

  function resetLiveSession() {
    samples = [];
    lastKpiUiUpdate = 0;
    sessionToken = makeId('SES');
    sourceMode = 'Sin datos';
    demoActive = false;
    lastSavedSessionToken = null;
    lastExportAt = null;
    updateLiveKpis();
  }

  function drawChartFromSamples(data) {
    const labels = data.map((sample) => {
      const total = Math.max(0, sample.elapsed_s);
      const mins = String(Math.floor(total / 60)).padStart(2, '0');
      const secs = String(Math.floor(total % 60)).padStart(2, '0');
      return `${mins}:${secs}`;
    });
    romChart.data.labels = labels.slice(-180);
    romChart.data.datasets[0].data = data.map((sample) => Number(sample.angle_deg)).slice(-180);
    romChart.data.datasets[1].data = data.map(() => 0).slice(-180);
    romChart.data.datasets[2].data = data.map(() => 20).slice(-180);
    romChart.data.datasets[3].data = data.map(() => -25).slice(-180);
    romChart.update('none');
    chartEmpty.classList.add('hidden');
  }

  function loadDemo(which) {
    stopCapture(true);
    resetMeasurements();
    const n = 86;
    const step = 0.18;
    const phaseOffset = which === 'B' ? 0.35 : 0;
    const baseline = which === 'B' ? -4.5 : -2.5;
    const amplitude = which === 'B' ? 15.8 : 13.8;
    const generated = Array.from({ length: n }, (_, index) => {
      const phase = (index / (n - 1)) * Math.PI * 5.3 + phaseOffset;
      const angle = baseline + amplitude * Math.sin(phase) + 1.1 * Math.sin(phase * 2.2);
      return { elapsed_s: Number((index * step).toFixed(2)), angle_deg: Number(angle.toFixed(2)), leg_side: 'Derecha', valid: true };
    });
    samples = generated;
    state.angles = generated.map((sample) => sample.angle_deg);
    state.minAngle = state.angles.reduce((min, value) => Math.min(min, value), Infinity);
    state.maxAngle = state.angles.reduce((max, value) => Math.max(max, value), -Infinity);
    state.smoothedAngle = state.angles[state.angles.length - 1];
    state.lastLeg = 'Derecha';
    state.startTime = Date.now() - (generated[generated.length - 1].elapsed_s * 1000);
    state.autoSide = 'right';
    demoActive = true;
    sourceMode = `Datos simulados · caso ${which}`;
    lastSavedSessionToken = null;
    lastExportAt = null;
    setCaptureUI('idle');
    liveChip.textContent = 'DEMO';
    const chartLiveLabel = document.querySelector('.chart-live');
    if (chartLiveLabel) chartLiveLabel.textContent = 'DATOS DEMO';
    sourceBadge.classList.add('active');
    sourceLabel.textContent = `Demo ${which}`;
    setTrackingState(false, 'Datos de ejemplo · no es una captura');
    recordingLabel.classList.remove('active');
    recordingLabel.innerHTML = '<span class="recording-dot"></span> DEMOSTRACIÓN';
    stageEmpty.hidden = false;
    captureNote.textContent = `Caso ${which}: datos sintéticos precargados para demostrar cálculos, gráficos, validación y exportación. No son mediciones de una persona.`;
    stageResolution.textContent = 'CSV / datos demo';
    drawChartFromSamples(generated);
    updateAngleUI(state.smoothedAngle, 'Derecha');
    updateMetrics();
    updateSessionClock();
    updateLiveKpis();
    notify(`Caso de demostración ${which} cargado (${generated.length} muestras sintéticas). No utilizar como evidencia clínica ni referencia independiente.`, 'warning');
  }

  function parseCsv(text) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length < 6) throw new Error('El CSV debe incluir encabezados y al menos cinco filas de datos.');
    const delimiter = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
    const headers = lines[0].split(delimiter).map((value) => value.trim().toLowerCase().replace(/["']/g, '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
    const timeIndex = headers.findIndex((header) => /^(time_s|elapsed_s|tiempo_s|tiempo|time|elapsed)$/.test(header));
    const angleIndex = headers.findIndex((header) => /^(angle_deg|ankle_angle_deg|angulo_deg|angulo|angle|ankle_angle)$/.test(header));
    const legIndex = headers.findIndex((header) => /^(leg|side|pierna|lado)$/.test(header));
    if (timeIndex < 0 || angleIndex < 0) throw new Error('No se reconocen los encabezados. Utiliza time_s,angle_deg (y opcionalmente leg).');
    const parsed = [];
    for (let index = 1; index < lines.length; index += 1) {
      const cells = lines[index].split(delimiter).map((value) => value.trim().replace(/^"|"$/g, ''));
      const parseNumber = (value) => Number(delimiter === ';' ? value.replace(',', '.') : value);
      const timeRaw = cells[timeIndex] ?? '';
      const angleRaw = cells[angleIndex] ?? '';
      const time = timeRaw.trim() === '' ? NaN : parseNumber(timeRaw);
      const angle = angleRaw.trim() === '' ? NaN : parseNumber(angleRaw);
      if (!Number.isFinite(time) || !Number.isFinite(angle)) throw new Error(`La fila ${index + 1} contiene tiempo o ángulo vacío/no numérico.`);
      if (time < 0) throw new Error(`La fila ${index + 1} contiene tiempo negativo.`);
      if (Math.abs(angle) > 90) throw new Error(`La fila ${index + 1} contiene un ángulo fuera de ±90°. Revisa la unidad y el formato.`);
      if (parsed.length && time <= parsed[parsed.length - 1].elapsed_s) throw new Error(`El tiempo debe aumentar de forma estricta. Revisa la fila ${index + 1}.`);
      parsed.push({ elapsed_s: time, angle_deg: angle, leg_side: cells[legIndex] || 'CSV', valid: true });
    }
    if (parsed.length < MIN_SAMPLES_TO_SAVE) throw new Error(`Se requieren al menos ${MIN_SAMPLES_TO_SAVE} muestras numéricas.`);
    if (parsed.length > 20000) throw new Error('El CSV contiene más de 20.000 muestras. Divide el archivo en registros más pequeños.');
    return parsed;
  }

  async function importCsv(file) {
    if (!file) return;
    if (file.size > MAX_CSV_BYTES) {
      notify('El CSV supera 5 MB. Reduce el tamaño del archivo e inténtalo nuevamente.', 'error');
      refs.csvUpload.value = '';
      return;
    }
    if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') {
      notify('Formato no válido. Selecciona un archivo CSV.', 'error');
      refs.csvUpload.value = '';
      return;
    }
    try {
      const parsed = parseCsv(await file.text());
      stopCapture(true);
      resetMeasurements();
      samples = parsed;
      state.angles = parsed.map((sample) => sample.angle_deg);
      state.minAngle = state.angles.reduce((min, value) => Math.min(min, value), Infinity);
      state.maxAngle = state.angles.reduce((max, value) => Math.max(max, value), -Infinity);
      state.smoothedAngle = state.angles[state.angles.length - 1];
      state.lastLeg = parsed[parsed.length - 1].leg_side || 'CSV';
      state.startTime = Date.now() - parsed[parsed.length - 1].elapsed_s * 1000;
      demoActive = false;
      sourceMode = 'CSV angular importado';
      lastSavedSessionToken = null;
      lastExportAt = null;
      setCaptureUI('idle');
      liveChip.textContent = 'CSV';
      sourceBadge.classList.add('active');
      sourceLabel.textContent = 'CSV importado';
      setTrackingState(true, `CSV importado · ${parsed.length} muestras`);
      recordingLabel.classList.remove('active');
      recordingLabel.innerHTML = '<span class="recording-dot"></span> DATOS IMPORTADOS';
      stageEmpty.hidden = false;
      stageResolution.textContent = 'CSV · datos angulares';
      captureNote.textContent = 'CSV importado. Estos ángulos ya estaban calculados en grados: la importación no ejecuta detección de pose ni vuelve a estimar los hitos.';
      drawChartFromSamples(parsed);
      updateAngleUI(state.smoothedAngle, state.lastLeg);
      updateMetrics();
      updateSessionClock();
      updateLiveKpis();
      notify(`${parsed.length} muestras importadas desde el archivo CSV. Revisa la unidad y la procedencia antes de guardar.`, 'success');
    } catch (error) {
      notify(`No se pudo importar el CSV: ${error.message}`, 'error');
    } finally {
      refs.csvUpload.value = '';
    }
  }

  function csvEscape(value) {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function downloadFile(filename, content, mime, markSessionExport = true) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
    if (markSessionExport) {
      lastExportAt = new Date().toISOString();
      updateLiveKpis();
    }
  }

  function exportJson() {
    if (!records.length) return notify('Guarda al menos un registro antes de exportar.', 'warning');
    const payload = {
      app: 'KineMotion', version: APP_VERSION, schema_version: '1.0', exported_at: new Date().toISOString(),
      method: {
        source: 'MediaPipe Pose 2D o datos angulares importados por CSV',
        units: 'degrees', landmark_indices: { left: { knee: 25, ankle: 27, heel: 29, toe: 31 }, right: { knee: 26, ankle: 28, heel: 30, toe: 32 } },
        confidence_threshold: 0.5, detection_confidence: 0.6, tracking_confidence: 0.6,
        smoothing: '0.72 * previous + 0.28 * new', chart_interval_ms: 180,
        angle_definition: '90° - included angle between knee-to-ankle and heel-to-toe vectors',
        scope: '2D angular estimate; no physical-length calibration; not a diagnosis or clinical validation',
      },
      tolerance_protocol: { values_deg: tolerances, confirmed_before_validation: tolerancesConfirmed, confirmed_at: toleranceConfirmedAt },
      records,
      validations,
      privacy_note: 'No se han incluido nombres ni identificadores personales. Registros mantenidos localmente hasta la exportación.',
    };
    downloadFile(`kinemotion-informe-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
    notify('Informe JSON exportado con registros, muestras, parámetros y validaciones.', 'success');
  }

  function exportCsv() {
    if (!records.length) return notify('Guarda al menos un registro antes de exportar.', 'warning');
    const rows = [['tipo', 'registro_id', 'fuente', 'variable', 'valor', 'unidad', 'referencia', 'error_absoluto', 'tolerancia', 'resultado', 'muestra', 'tiempo_s', 'lado', 'fecha']];
    records.forEach((record) => {
      const metrics = [
        ['ROM total', record.stats.rom, '°'], ['Pico dorsiflexión', record.stats.dorsiflexion, '°'],
        ['Pico flexión plantar', record.stats.plantar, '°'], ['Ángulo medio', record.stats.mean, '°'],
        ['Desviación estándar', record.stats.sd, '°'], ['Dentro de referencia', record.stats.withinPct, '%'],
        ['Frecuencia efectiva', record.frequencyHz, 'Hz'],
      ];
      metrics.forEach(([name, value, unit]) => rows.push(['KPI', record.id, record.source, name, value, unit, '', '', '', '', '', '', record.legSide, record.createdAt]));
      record.samples.forEach((sample, index) => rows.push(['MUESTRA', record.id, record.source, 'Ángulo de tobillo', sample.angle_deg, '°', '', '', '', '', index + 1, sample.elapsed_s, sample.leg_side, record.createdAt]));
    });
    validations.forEach((validation) => validation.results.forEach((result) => rows.push([
      'VALIDACIÓN', result.recordId, validation.method, result.metric, result.measured, '°', result.reference, result.error, result.tolerance, result.pass ? 'CUMPLE' : 'NO CUMPLE', '', '', '', validation.createdAt,
    ])));
    const csv = '\uFEFF' + rows.map((row) => row.map(csvEscape).join(';')).join('\r\n');
    downloadFile(`kinemotion-resumen-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8');
    notify('Resumen CSV exportado. Incluye KPIs, muestras individuales y resultados del contraste.', 'success');
  }

  function downloadExampleCsv() {
    const example = Array.from({ length: 30 }, (_, index) => {
      const time = (index * 0.2).toFixed(2);
      const angle = (-3 + 13 * Math.sin((index / 29) * Math.PI * 4.4)).toFixed(2);
      return `${time},${angle},Derecha`;
    });
    const csv = '\uFEFFtime_s,angle_deg,leg\r\n' + example.join('\r\n') + '\r\n';
    downloadFile('kinemotion-ejemplo-sintetico.csv', csv, 'text/csv;charset=utf-8', false);
    notify('CSV sintético descargado. Puedes volver a importarlo desde “Importar CSV”.', 'success');
  }

  function numericInput(id, label) {
    const input = $(id);
    const value = input.value.trim();
    if (value === '' || !Number.isFinite(Number(value))) throw new Error(`Completa el valor de ${label} con un número válido.`);
    return Number(value);
  }

  function readTolerances() {
    const next = {
      rom: numericInput('km-tol-rom', 'tolerancia de ROM'),
      dorsiflexion: numericInput('km-tol-dorsi', 'tolerancia de dorsiflexión'),
      plantarflexion: numericInput('km-tol-plantar', 'tolerancia de flexión plantar'),
    };
    if (Object.values(next).some((value) => value < 0 || value > 90)) throw new Error('Las tolerancias deben estar entre 0° y 90°.');
    return next;
  }

  function confirmTolerances() {
    try {
      tolerances = readTolerances();
      tolerancesConfirmed = true;
      toleranceConfirmedAt = new Date().toISOString();
      validationMethod = '';
      ['km-tol-rom', 'km-tol-dorsi', 'km-tol-plantar'].forEach((id) => { $(id).disabled = true; });
      refs.confirmTolerance.hidden = true;
      refs.editTolerance.hidden = false;
      refs.toleranceState.textContent = `Confirmadas · ${new Date(toleranceConfirmedAt).toLocaleTimeString('es-CL')}`;
      refs.toleranceState.classList.add('is-confirmed');
      refs.toleranceHelp.textContent = 'Valores bloqueados y fechados antes del contraste. Puedes editarlos si aún no has iniciado la comparación.';
      notify('Tolerancias confirmadas antes del contraste. Ahora ingresa las referencias independientes.', 'success');
    } catch (error) {
      notify(error.message, 'error');
    }
  }

  function editTolerances() {
    tolerancesConfirmed = false;
    toleranceConfirmedAt = null;
    ['km-tol-rom', 'km-tol-dorsi', 'km-tol-plantar'].forEach((id) => { $(id).disabled = false; });
    refs.confirmTolerance.hidden = false;
    refs.editTolerance.hidden = true;
    refs.toleranceState.textContent = 'Sin confirmar';
    refs.toleranceState.classList.remove('is-confirmed');
    refs.toleranceHelp.textContent = 'Confirma antes de completar las referencias.';
    notify('Puedes ajustar las tolerancias. Debes confirmarlas nuevamente antes de comparar.', 'warning');
  }

  function getRecord(id) {
    return records.find((record) => record.id === id);
  }

  function renderValidation(validation) {
    const rows = validation.results.map((result) => `
      <tr>
        <td>${safeText(result.recordId)}</td><td>${safeText(result.metric)}</td>
        <td>${format(result.measured)}°</td><td>${format(result.reference)}°</td>
        <td>${format(result.error)}°</td><td>${format(result.tolerance)}°</td>
        <td><span class="km-result-pill ${result.pass ? 'pass' : 'fail'}">${result.pass ? 'Cumple' : 'No cumple'}</span></td>
      </tr>`).join('');
    const passCount = validation.results.filter((result) => result.pass).length;
    refs.validationOutput.innerHTML = `
      <div class="km-validation-summary"><strong>${passCount} de ${validation.results.length} comparaciones cumplen la tolerancia.</strong><span>Método: ${safeText(validation.method)} · Evaluador: ${safeText(validation.evaluator || 'No indicado')}</span></div>
      <div class="km-table-scroll"><table class="km-table"><thead><tr><th>Registro</th><th>KPI</th><th>Estimado</th><th>Referencia</th><th>Error abs.</th><th>Tolerancia</th><th>Resultado</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="km-helper">Los valores de referencia y tolerancias quedan asociados a este contraste. La calidad de la conclusión depende de la independencia y el protocolo de la referencia introducida.</p>`;
    refs.validationHistory.innerHTML = `<div class="km-history-line">Último contraste: ${new Date(validation.createdAt).toLocaleString('es-CL')} · ${passCount}/${validation.results.length} cumplen.</div>`;
  }

  function runValidation() {
    if (!tolerancesConfirmed) return notify('Primero confirma las tolerancias antes de introducir o comparar las referencias.', 'warning');
    const idA = $('km-record-a').value;
    const idB = $('km-record-b').value;
    if (!idA || !idB) return notify('Selecciona dos registros guardados.', 'warning');
    if (idA === idB) return notify('Selecciona dos ejecuciones distintas para el contraste.', 'error');
    const recordA = getRecord(idA);
    const recordB = getRecord(idB);
    if (!recordA || !recordB) return notify('Uno de los registros ya no está disponible. Actualiza la selección.', 'error');
    const method = refs.method.value.trim();
    if (method.length < 4) return notify('Describe el método de referencia independiente utilizado.', 'warning');
    const evaluator = refs.evaluator.value.trim();
    try {
      const resultRows = [];
      const metricConfig = [
        { key: 'rom', label: 'ROM total', refId: 'rom', toleranceKey: 'rom' },
        { key: 'dorsiflexion', label: 'Pico dorsiflexión', refId: 'dorsi', toleranceKey: 'dorsiflexion' },
        { key: 'plantar', label: 'Pico flexión plantar', refId: 'plantar', toleranceKey: 'plantarflexion' },
      ];
      for (const [slot, record] of [['a', recordA], ['b', recordB]]) {
        for (const metric of metricConfig) {
          const reference = numericInput(`km-ref-${slot}-${metric.refId}`, `referencia ${metric.label} del registro ${slot.toUpperCase()}`);
          if (metric.key === 'rom' && (reference < 0 || reference > 180)) throw new Error(`La referencia de ROM del registro ${slot.toUpperCase()} debe estar entre 0° y 180°.`);
          if (metric.key !== 'rom' && (reference < -90 || reference > 90)) throw new Error(`La referencia angular del registro ${slot.toUpperCase()} debe estar entre −90° y +90°.`);
          const measured = record.stats[metric.key];
          const error = Math.abs(measured - reference);
          const tolerance = tolerances[metric.toleranceKey];
          resultRows.push({
            recordId: record.id, metric: metric.label, measured: Number(measured.toFixed(3)),
            reference: Number(reference.toFixed(3)), error: Number(error.toFixed(3)), tolerance,
            pass: error <= tolerance,
          });
        }
      }
      if ([recordA, recordB].some((record) => record.demo)) {
        notify('Aviso: uno o ambos registros contienen datos sintéticos. Este contraste solo prueba la función; no constituye validación independiente.', 'warning');
      }
      const validation = {
        id: makeId('VAL'), createdAt: new Date().toISOString(), method, evaluator,
        toleranceConfirmedAt, tolerances: { ...tolerances }, recordIds: [recordA.id, recordB.id], results: resultRows,
      };
      validations.push(validation);
      renderValidation(validation);
      const countPass = resultRows.filter((result) => result.pass).length;
      notify(`Contraste calculado: ${countPass} de ${resultRows.length} comparaciones cumplen la tolerancia.`, countPass === 6 ? 'success' : 'warning');
    } catch (error) {
      notify(error.message || 'No fue posible completar el contraste. Revisa las referencias introducidas.', 'error');
    }
  }

  function attachEvents() {
    refs.save.addEventListener('click', saveRecord);
    refs.demoA.addEventListener('click', () => loadDemo('A'));
    refs.demoB.addEventListener('click', () => loadDemo('B'));
    refs.csvUpload.addEventListener('change', (event) => importCsv(event.target.files?.[0]));
    refs.exampleCsv.addEventListener('click', downloadExampleCsv);
    refs.exportJson.addEventListener('click', exportJson);
    refs.exportCsv.addEventListener('click', exportCsv);
    refs.confirmTolerance.addEventListener('click', confirmTolerances);
    refs.editTolerance.addEventListener('click', editTolerances);
    refs.runValidation.addEventListener('click', runValidation);
  }

  function init() {
    attachEvents();
    renderRecords();
    updateLiveKpis();
    notify('Extensión cargada. Puedes iniciar la webcam, cargar un video, importar un CSV o probar los datos de ejemplo.');

    // Replica en un estado accesible los mensajes del módulo original (por ejemplo, permisos de cámara).
    const noteObserver = new MutationObserver(() => {
      const note = captureNote.textContent.trim();
      if (note && /permite|no se pudo|no fue posible|formato compatible|no se encontró|cámara/i.test(note)) {
        notify(note, /no se pudo|no fue posible|no se encontró/i.test(note) ? 'warning' : 'info');
      }
    });
    noteObserver.observe(captureNote, { childList: true, characterData: true, subtree: true });
    const trackingObserver = new MutationObserver(() => {
      const message = trackingStatus.textContent.trim();
      if (message && !trackingStatus.classList.contains('detected') && message !== lastTrackingNotice && Date.now() - lastTrackingNoticeAt > 900) {
        lastTrackingNotice = message;
        lastTrackingNoticeAt = Date.now();
        notify(message, 'warning');
      } else if (trackingStatus.classList.contains('detected')) {
        lastTrackingNotice = '';
      }
    });
    trackingObserver.observe(trackingStatus, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });

    // En una selección inválida se detiene el listener base antes de que intente analizarla.
    uploadInput.addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (!file.type.startsWith('video/')) {
        event.stopImmediatePropagation();
        uploadInput.value = '';
        notify('Archivo rechazado: selecciona un formato de video válido.', 'error');
        return;
      }
      if (file.size > 500 * 1024 * 1024) {
        event.stopImmediatePropagation();
        uploadInput.value = '';
        notify('El video supera 500 MB. Utiliza un archivo más pequeño para evitar falta de memoria.', 'error');
        return;
      }
      setTimeout(() => {
        sourceMode = 'Video cargado · MediaPipe Pose';
        updateLiveKpis();
      }, 0);
    }, true);

    // Si el usuario pierde la cámara o detiene la pista del navegador, informa el estado.
    if (navigator.mediaDevices?.getUserMedia) {
      navigator.mediaDevices.addEventListener?.('devicechange', () => {
        if (state.mode === 'camera' && state.stream && state.stream.getVideoTracks().every((track) => track.readyState === 'ended')) {
          notify('La cámara se desconectó. Reinicia la webcam o cambia a video/CSV.', 'error');
          stopCapture(false);
        }
      });
    }
  }

  init();

  return {
    onMeasurement(angle, legSide) {
      if (demoActive) return;
      const elapsed = state.startTime ? Math.max(0, (Date.now() - state.startTime) / 1000) : (samples.length ? samples[samples.length - 1].elapsed_s + 0.18 : 0);
      samples.push({ elapsed_s: Number(elapsed.toFixed(3)), angle_deg: Number(angle.toFixed(3)), leg_side: legSide, valid: true });
      if (state.mode === 'camera') sourceMode = 'Webcam · MediaPipe Pose';
      else if (state.mode === 'file') sourceMode = sourceMode.startsWith('Video') ? sourceMode : 'Video · MediaPipe Pose';
      const chartLiveLabel = document.querySelector('.chart-live');
      if (chartLiveLabel) chartLiveLabel.textContent = 'EN VIVO';
      lastExportAt = null;
      if (Date.now() - lastKpiUiUpdate >= 300) {
        lastKpiUiUpdate = Date.now();
        updateLiveKpis();
      }
    },
    reset: resetLiveSession,
  };
})();

// Wrappers aditivos: los métodos originales se ejecutan primero y conservan su comportamiento.
const kmOriginalRecordAngle = recordAngle;
recordAngle = function (angle, legSide) {
  kmOriginalRecordAngle(angle, legSide);
  if (Number.isFinite(state.smoothedAngle) && state.mode !== 'idle') kmAddon.onMeasurement(state.smoothedAngle, legSide);
};

const kmOriginalResetMeasurements = resetMeasurements;
resetMeasurements = function () {
  kmOriginalResetMeasurements();
  kmAddon.reset();
};
