// api/media.js — Vercel Serverless Function
// GET    /api/media        → list all media (newest first)
// POST   /api/media        → save a new media item
// DELETE /api/media?id=xx  → delete by MongoDB _id

import { MongoClient, ObjectId } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB  = process.env.MONGODB_DB || "mediavault";

// ── Cache connection on the global object so it survives warm Lambda restarts ──
// A plain module-level `let cached` resets every cold start on Vercel.
if (!global._mongoClient) {
  global._mongoClient     = null;
  global._mongoClientPromise = null;
}

async function getCollection() {
  if (!MONGODB_URI) throw new Error("MONGODB_URI env variable is not set in Vercel");

  if (!global._mongoClientPromise) {
    const client = new MongoClient(MONGODB_URI, {
      // Keep alive so the connection doesn't drop between requests
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 10000,
    });
    global._mongoClientPromise = client.connect().then(c => {
      global._mongoClient = c;
      return c;
    });
  }

  const client = await global._mongoClientPromise;
  return client.db(MONGODB_DB).collection("media");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  let col;
  try {
    col = await getCollection();
  } catch (err) {
    console.error("[MongoDB] Connection failed:", err.message);
    return res.status(500).json({
      error: "Database connection failed",
      detail: err.message,   // visible in Vercel logs
    });
  }

  try {
    // ── GET: return all media, newest first ──────────────────────────────────
    if (req.method === "GET") {
      const docs = await col
        .find({})
        .sort({ createdAt: -1 })
        .limit(500)
        .toArray();
      return res.status(200).json(docs);
    }

    // ── POST: save a new upload ──────────────────────────────────────────────
    if (req.method === "POST") {
      const { publicId, url, thumbnailUrl, type, name, size, width, height } = req.body || {};

      if (!url)  return res.status(400).json({ error: "url is required" });
      if (!type) return res.status(400).json({ error: "type is required" });

      const doc = {
        publicId:     publicId    || "",
        url:          url,
        thumbnailUrl: thumbnailUrl || url,   // fallback: use full url as thumbnail
        type:         type,
        name:         name         || "untitled",
        size:         size         || 0,
        width:        width        || null,
        height:       height       || null,
        createdAt:    new Date(),
      };

      const result = await col.insertOne(doc);
      // Return the full saved doc with the real MongoDB _id
      return res.status(201).json({ ...doc, _id: result.insertedId.toString() });
    }

    // ── DELETE: remove by _id ────────────────────────────────────────────────
    if (req.method === "DELETE") {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: "id query param is required" });

      let objectId;
      try {
        objectId = new ObjectId(id);
      } catch {
        return res.status(400).json({ error: "Invalid id format" });
      }

      const result = await col.deleteOne({ _id: objectId });
      if (result.deletedCount === 0) {
        return res.status(404).json({ error: "Item not found" });
      }
      return res.status(200).json({ deleted: true, id });
    }

    return res.status(405).json({ error: `Method ${req.method} not allowed` });

  } catch (err) {
    console.error("[MongoDB] Query failed:", err.message);
    return res.status(500).json({ error: "Database query failed", detail: err.message });
  }
}