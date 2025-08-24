import * as functions from "firebase-functions/v1";
import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";
import admin from "firebase-admin";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

// Try env-based creds first
if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    } as admin.ServiceAccount),
  });
} else {
  // Fall back to local JSON key for dev convenience
  const keyPath = path.join(__dirname, "..", "serviceAccountKey.json");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const serviceAccount = require(keyPath);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
  });
}

// Mongo connection string comes from environment variables (.env for emulators, Cloud Functions env for prod)
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  throw new Error(
    "MONGODB_URI config missing. Provide via environment variable MONGODB_URI"
  );
}

const client = new MongoClient(MONGODB_URI);
const app = express();
app.use(cors());
app.use(express.json());

let entriesCol: any;

async function connectDb() {
  await client.connect();
  const db = client.db();
  entriesCol = db.collection("entries");
  await entriesCol.createIndex({ uid: 1, timestamp: -1 });
  console.log("MongoDB connected and index ensured");
}
connectDb();

async function verifyToken(req: any, res: any, next: any) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing token" });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    (req as any).uid = decoded.uid;
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// Public health-check endpoint to verify API is up without authentication
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use(verifyToken);

app.get("/entries", async (req, res) => {
  const uid = (req as any).uid;
  const entries = await entriesCol
    .find({ uid })
    .sort({ timestamp: -1 })
    .toArray();
  res.json(entries);
});

app.post("/entries", async (req, res) => {
  const uid = (req as any).uid;
  const entry = req.body;
  entry.uid = uid;
  if (entry._id) delete entry._id;
  if (!entry.id) {
    return res.status(400).json({ error: "Entry id required" });
  }
  await entriesCol.updateOne(
    { uid, id: entry.id },
    { $set: entry },
    { upsert: true }
  );
  res.json({ success: true });
});

app.delete("/entries/:id", async (req, res) => {
  const uid = (req as any).uid;
  const { id } = req.params;
  await entriesCol.deleteOne({ uid, id });
  res.json({ success: true });
});

export const api = functions.region("us-central1").https.onRequest(app);

// When running this file directly (e.g., `node dist/index.js`) start an HTTP server for local dev
if (require.main === module) {
  const port = process.env.PORT || 4000;
  app.listen(port, () => {
    console.log(`API server running locally on port ${port}`);
  });
}
