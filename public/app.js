// ============================================================
// app.js
// Détection de pose en temps réel dans le navigateur via MediaPipe
// (PoseLandmarker, modèle exécuté localement, aucune donnée vidéo
// n'est jamais envoyée à un serveur — seuls les ANGLES calculés
// sont transmis, ce qui est rapide et respecte la vie privée).
// ============================================================

import { PoseLandmarker, FilesetResolver, DrawingUtils } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

// ------------------------------------------------------------
// Références DOM
// ------------------------------------------------------------
const video = document.getElementById("webcam");
const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");
const startButton = document.getElementById("startButton");
const generateButton = document.getElementById("generateButton");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const codeDisplay = document.getElementById("codeDisplay");
const codeValue = document.getElementById("codeValue");
const debugOutput = document.getElementById("debugOutput");

// ------------------------------------------------------------
// État global
// ------------------------------------------------------------
let poseLandmarker = null;
let currentCode = null;
let isCameraActive = false;
let isTrackingLive = false;
let lastVideoTime = -1;
const drawingUtils = new DrawingUtils(ctx);

const SEND_INTERVAL_MS = 100; // 10 envois/seconde vers le backend (aligné sur le polling Roblox)
let lastSendTime = 0;

// ------------------------------------------------------------
// Initialisation du modèle MediaPipe Pose Landmarker
// ------------------------------------------------------------
async function initPoseLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );

  poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numPoses: 1,
  });
}

// ------------------------------------------------------------
// Démarrage de la caméra
// ------------------------------------------------------------
startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  startButton.textContent = "Chargement du modèle IA...";

  try {
    await initPoseLandmarker();

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
      audio: false,
    });
    video.srcObject = stream;

    video.addEventListener("loadeddata", () => {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      isCameraActive = true;
      startButton.textContent = "Caméra active ✓";
      generateButton.disabled = false;
      updateStatus("idle", "Caméra prête. Génère un code pour démarrer.");
      predictLoop();
    });
  } catch (err) {
    console.error(err);
    startButton.disabled = false;
    startButton.textContent = "Activer la caméra";
    updateStatus("error", "Erreur d'accès caméra ou de chargement IA.");
  }
});

// ------------------------------------------------------------
// Génération du code de liaison auprès du backend
// ------------------------------------------------------------
generateButton.addEventListener("click", async () => {
  generateButton.disabled = true;
  generateButton.textContent = "Génération...";

  try {
    const response = await fetch("/api/generate-code", { method: "POST" });
    const result = await response.json();

    if (result.success) {
      currentCode = result.code;
      codeValue.textContent = currentCode;
      codeDisplay.style.display = "block";
      isTrackingLive = true;
      updateStatus("tracking", "Tracking actif — connecte-toi dans Roblox !");
      generateButton.textContent = "Nouveau code";
      generateButton.disabled = false;
    } else {
      throw new Error("Échec de génération");
    }
  } catch (err) {
    console.error(err);
    updateStatus("error", "Impossible de contacter le serveur.");
    generateButton.disabled = false;
    generateButton.textContent = "Générer le code de liaison";
  }
});

// ------------------------------------------------------------
// Mise à jour visuelle du statut
// ------------------------------------------------------------
function updateStatus(state, message) {
  statusText.textContent = message;
  statusDot.className = "status-dot";
  if (state === "idle") statusDot.classList.add("active");
  if (state === "tracking") statusDot.classList.add("tracking");
}

// ------------------------------------------------------------
// Boucle principale de détection (appelée à chaque frame vidéo)
// ------------------------------------------------------------
async function predictLoop() {
  if (!isCameraActive) return;

  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const result = poseLandmarker.detectForVideo(video, performance.now());

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (result.landmarks && result.landmarks.length > 0) {
      const landmarks = result.landmarks[0];

      // Dessine le squelette détecté (retour visuel pour l'utilisateur)
      drawingUtils.drawLandmarks(landmarks, { radius: 3, color: "#5865f2" });
      drawingUtils.drawConnectors(landmarks, PoseLandmarker.POSE_CONNECTIONS, {
        color: "#4ade80",
        lineWidth: 2,
      });

      const movementData = computeMovementAngles(landmarks);
      debugOutput.textContent = JSON.stringify(movementData, null, 2);

      // Envoi au backend à intervalle régulier (throttle)
      const now = performance.now();
      if (isTrackingLive && currentCode && now - lastSendTime >= SEND_INTERVAL_MS) {
        lastSendTime = now;
        sendMovementData(movementData);
      }
    }
  }

  requestAnimationFrame(predictLoop);
}

// ------------------------------------------------------------
// Calcul des angles (X, Y, Z approximatifs) à partir des landmarks
//
// Indices MediaPipe Pose utilisés :
//  11 = épaule gauche   12 = épaule droite
//  13 = coude gauche    14 = coude droit
//  23 = hanche gauche   24 = hanche droite
//  25 = genou gauche    26 = genou droit
//
// Méthode : on calcule l'angle du vecteur "membre" (ex: épaule->coude)
// par rapport à un axe de référence vertical du buste, sur 3 plans.
// C'est une approximation suffisante pour du RP — pas une IK complète.
// ------------------------------------------------------------
function computeMovementAngles(lm) {
  const leftShoulder = lm[11];
  const rightShoulder = lm[12];
  const leftElbow = lm[13];
  const rightElbow = lm[14];
  const leftHip = lm[23];
  const rightHip = lm[24];
  const leftKnee = lm[25];
  const rightKnee = lm[26];

  return {
    LeftArm: computeLimbAngle(leftShoulder, leftElbow, "arm"),
    RightArm: computeLimbAngle(rightShoulder, rightElbow, "arm"),
    LeftLeg: computeLimbAngle(leftHip, leftKnee, "leg"),
    RightLeg: computeLimbAngle(rightHip, rightKnee, "leg"),
  };
}

function computeLimbAngle(origin, target, limbType) {
  if (!origin || !target) {
    return { X: 0, Y: 0, Z: 0 };
  }

  // Vecteur du membre dans l'espace normalisé MediaPipe (x, y, z)
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const dz = (target.z || 0) - (origin.z || 0);

  // Conversion en angles approximatifs (degrés), bornés à +/-130°
  // Y inversé car l'axe Y de MediaPipe pointe vers le bas de l'image
  let angleX = Math.atan2(dz, dy) * (180 / Math.PI);
  let angleZ = Math.atan2(dx, -dy) * (180 / Math.PI);
  let angleY = Math.atan2(dx, dz) * (180 / Math.PI) * 0.3; // amorti, rotation Y moins fiable en 2D

  // Pour les jambes, on réduit l'amplitude par défaut (mouvement naturel plus restreint)
  const dampening = limbType === "leg" ? 0.7 : 1.0;

  return {
    X: clamp(angleX * dampening, -130, 130),
    Y: clamp(angleY * dampening, -130, 130),
    Z: clamp(angleZ * dampening, -130, 130),
  };
}

function clamp(value, min, max) {
  if (Number.isNaN(value)) return 0;
  return Math.max(min, Math.min(max, value));
}

// ------------------------------------------------------------
// Envoi des données au backend (lié au code de session courant)
// ------------------------------------------------------------
async function sendMovementData(data) {
  try {
    await fetch("/api/update-movements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: currentCode, data }),
    });
  } catch (err) {
    console.error("Erreur d'envoi des mouvements :", err);
  }
}