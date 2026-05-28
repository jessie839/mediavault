// api/media.js  — Vercel Serverless Function
// Handles: GET /api/media  →  list all media
//          POST /api/media →  save a new media item
//          DELETE /api/media?id=xxx  →  remove a media item

import { MongoClient, ObjectId } from "mongodb";

const uri = process.env.MONGODB_URI;       // set in Vercel environment variables
const DB  = process.env.MONGODB_DB || "mediavault";
const COL = "media";

let cached = null; // reuse connection across warm Lambda invocations

async function connect() {
  if (cached) return cached;
  const client = new MongoClient(uri);
  await client.connect();
  cached = client.db(DB).collection(COL);
  return cached;
}

export default async function handler(req, res) {
  // Allow requests from any origin (CORS)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const col = await connect();

    // ── GET: return all media, newest first ────────────────────────────────
    if (req.method === "GET") {
      const docs = await col
        .find({})
        .sort({ createdAt: -1 })
        .limit(200)
        .toArray();
      return res.status(200).json(docs);
    }

    // ── POST: save a new media item ────────────────────────────────────────
    if (req.method === "POST") {
      const { publicId, url, thumbnailUrl, type, name, size, width, height } = req.body;
      if (!url || !type) return res.status(400).json({ error: "url and type are required" });

      const doc = { publicId, url, thumbnailUrl, type, name, size, width, height, createdAt: new Date() };
      const result = await col.insertOne(doc);
      return res.status(201).json({ ...doc, _id: result.insertedId });
    }

    // ── DELETE: remove by MongoDB _id ─────────────────────────────────────
    if (req.method === "DELETE") {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: "id is required" });
      await col.deleteOne({ _id: new ObjectId(id) });
      return res.status(200).json({ deleted: true });
    }

    return res.status(405).json({ error: "Method not allowed" });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
