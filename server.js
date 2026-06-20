// ============================================================
// server.js
// Backend de liaison "Caméra IA (navigateur) <-> Roblox"
//
// Rôle :
//  1. Génère des codes de liaison uniques pour chaque session de tracking.
//  2. Reçoit les données de mouvement détectées par le navigateur (MediaPipe)
//     via POST /api/update-movements.
//  3. Sert ces données à Roblox via GET /api/get-movements (polling).
//  4. Nettoie automatiquement les sessions inactives (anti fuite mémoire).
// ============================================================

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ------------------------------------------------------------
// Middlewares
// ------------------------------------------------------------
app.use(cors()); // Autorise les appels cross-origin (navigateur hébergé ailleurs)
app.use(express.json({ limit: "200kb" })); // JSON uniquement, payload limité (sécurité)
app.use(express.static(path.join(__dirname, "public"))); // Sert le frontend (index.html, app.js)

// ------------------------------------------------------------
// Stockage en mémoire des sessions actives
// Structure : sessions[code] = {
//   data: { LeftArm: {X,Y,Z}, RightArm: {...}, LeftLeg: {...}, RightLeg: {...} },
//   lastUpdate: timestamp,
//   createdAt: timestamp
// }
// ------------------------------------------------------------
const sessions = {};

const SESSION_TIMEOUT_MS = 60 * 1000;   // Session supprimée après 60s d'inactivité du navigateur
const CODE_LENGTH = 8;

// Format de données neutre par défaut (T-pose / position de repos)
const NEUTRAL_POSE = {
  LeftArm: { X: 0, Y: 0, Z: 0 },
  RightArm: { X: 0, Y: 0, Z: 0 },
  LeftLeg: { X: 0, Y: 0, Z: 0 },
  RightLeg: { X: 0, Y: 0, Z: 0 },
};

// ------------------------------------------------------------
// Génère un code de liaison unique (lisible, sans ambiguïté 0/O, 1/I)
// ------------------------------------------------------------
function generateUniqueCode() {
  const charset = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    const bytes = crypto.randomBytes(CODE_LENGTH);
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += charset[bytes[i] % charset.length];
    }
  } while (sessions[code]); // Évite les collisions (très rare mais on vérifie)
  return code;
}

// ------------------------------------------------------------
// Nettoyage périodique des sessions expirées (toutes les 30s)
// ------------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  for (const code in sessions) {
    if (now - sessions[code].lastUpdate > SESSION_TIMEOUT_MS) {
      delete sessions[code];
      console.log(`[Cleanup] Session expirée supprimée : ${code}`);
    }
  }
}, 30 * 1000);

// ==============================================================
// ROUTE 1 : Génération d'un nouveau code de liaison
// Appelée par le navigateur quand l'utilisateur clique "Démarrer"
// ==============================================================
app.post("/api/generate-code", (req, res) => {
  const code = generateUniqueCode();

  sessions[code] = {
    data: { ...NEUTRAL_POSE },
    lastUpdate: Date.now(),
    createdAt: Date.now(),
  };

  console.log(`[Session] Nouveau code généré : ${code}`);
  res.json({ success: true, code });
});

// ==============================================================
// ROUTE 2 : Réception des données de mouvement depuis le navigateur
// Appelée en continu (~10x/seconde) par MediaPipe côté client
// ==============================================================
app.post("/api/update-movements", (req, res) => {
  const { code, data } = req.body;

  if (!code || typeof code !== "string" || !sessions[code]) {
    return res.status(404).json({ success: false, message: "Code de session inconnu." });
  }

  if (!data || typeof data !== "object") {
    return res.status(400).json({ success: false, message: "Données de mouvement manquantes." });
  }

  // Validation minimale de la structure attendue + clamp de sécurité des valeurs
  const limbs = ["LeftArm", "RightArm", "LeftLeg", "RightLeg"];
  const sanitized = {};

  for (const limb of limbs) {
    const incoming = data[limb] || { X: 0, Y: 0, Z: 0 };
    sanitized[limb] = {
      X: clampAngle(incoming.X),
      Y: clampAngle(incoming.Y),
      Z: clampAngle(incoming.Z),
    };
  }

  sessions[code].data = sanitized;
  sessions[code].lastUpdate = Date.now();

  res.json({ success: true });
});

function clampAngle(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return 0;
  return Math.max(-130, Math.min(130, num));
}

// ==============================================================
// ROUTE 3 : Endpoint de POLLING utilisé par Roblox (HttpService)
// GET /api/get-movements?code=XYZ
// GET /api/get-movements?code=XYZ&validate=true  -> handshake initial
// ==============================================================
app.get("/api/get-movements", (req, res) => {
  const { code, validate } = req.query;

  if (!code || typeof code !== "string") {
    return res.status(400).json({ valid: false, message: "Paramètre 'code' manquant." });
  }

  const session = sessions[code];

  // -------- Mode validation (handshake initial depuis Roblox) --------
  if (validate === "true") {
    if (!session) {
      return res.json({ valid: false, message: "Code introuvable ou expiré." });
    }
    return res.json({ valid: true });
  }

  // -------- Mode récupération des données (polling régulier) --------
  if (!session) {
    return res.status(404).json({
      success: false,
      message: "Session introuvable. Le code a peut-être expiré.",
    });
  }

  res.json(session.data);
});

// ==============================================================
// ROUTE 4 : Statut de session (utile pour debug / UI du site)
// ==============================================================
app.get("/api/session-status", (req, res) => {
  const { code } = req.query;
  const session = sessions[code];

  if (!session) {
    return res.json({ connected: false });
  }

  res.json({
    connected: true,
    lastUpdate: session.lastUpdate,
    secondsSinceUpdate: (Date.now() - session.lastUpdate) / 1000,
  });
});

// ==============================================================
// Route de santé (utile pour Render/Railway healthchecks)
// ==============================================================
app.get("/health", (req, res) => {
  res.json({ status: "ok", activeSessions: Object.keys(sessions).length });
});

app.listen(PORT, () => {
  console.log(`✓ Serveur de tracking caméra IA démarré sur le port ${PORT}`);
});