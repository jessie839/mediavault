import { useState, useRef, useEffect, useCallback } from "react";

// ─── CONFIG — paste your Cloudinary values here ───────────────────────────────
const CLOUD_NAME    = "dmhbmil4k";    // e.g. "my-cloud-abc123"
const UPLOAD_PRESET = "mediavault_unsigned";
// ─────────────────────────────────────────────────────────────────────────────

function makeThumbnail(url, isVideo) {
  try {
    if (isVideo) {
      return url
        .replace("/upload/", "/upload/so_0,w_400,h_300,c_fill,f_jpg/")
        .replace(/\.(mp4|webm|mov|avi)(\?.*)?$/, ".jpg");
    }
    return url.replace("/upload/", "/upload/w_400,h_300,c_fill/");
  } catch {
    return url;
  }
}

// ── Retry a fetch up to `attempts` times ──────────────────────────────────────
async function fetchWithRetry(url, options = {}, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, options);
      return r;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise(res => setTimeout(res, 800 * (i + 1)));
    }
  }
}

export default function App() {
  const [media,     setMedia]     = useState([]);
  const [uploading, setUploading] = useState([]);
  const [dragging,  setDragging]  = useState(false);
  const [selected,  setSelected]  = useState(null);
  const [filter,    setFilter]    = useState("all");
  const [status,    setStatus]    = useState("loading"); // "loading" | "ok" | "error"
  const [dbError,   setDbError]   = useState(null);
  const [copied,    setCopied]    = useState(null);
  const fileRef = useRef();

  // ── LOAD gallery from MongoDB on every mount / refresh ─────────────────────
  // This is the ONLY source of truth. If this works → all devices see same data.
  const loadGallery = useCallback(async () => {
    setStatus("loading");
    try {
      const r = await fetchWithRetry("/api/media");
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.detail || body.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      if (!Array.isArray(data)) throw new Error("API did not return an array");
      setMedia(data);
      setStatus("ok");
      setDbError(null);
    } catch (err) {
      setStatus("error");
      setDbError(err.message);
    }
  }, []);

  useEffect(() => { loadGallery(); }, [loadGallery]);

  // ── UPLOAD one file ─────────────────────────────────────────────────────────
  const uploadFile = useCallback(async (file) => {
    const uid     = `upload-${Date.now()}-${Math.random()}`;
    const isVideo = file.type.startsWith("video/");
    const localPreview = isVideo ? null : URL.createObjectURL(file);

    setUploading(prev => [...prev, { uid, name: file.name, progress: 0, localPreview, isVideo, uploadError: null }]);

    // Step 1 — send file to Cloudinary
    const formData = new FormData();
    formData.append("file", file);
    formData.append("upload_preset", UPLOAD_PRESET);

    let cloudRes;
    try {
      cloudRes = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = e => {
          if (e.lengthComputable)
            setUploading(prev => prev.map(u =>
              u.uid === uid ? { ...u, progress: Math.round(e.loaded / e.total * 100) } : u
            ));
        };
        xhr.onload = () => {
          try {
            const parsed = JSON.parse(xhr.responseText);
            if (xhr.status >= 400 || parsed.error)
              reject(new Error(parsed.error?.message || `Cloudinary error ${xhr.status}`));
            else resolve(parsed);
          } catch { reject(new Error("Bad response from Cloudinary")); }
        };
        xhr.onerror = () => reject(new Error("Network error — check internet connection"));
        xhr.open("POST", `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/upload`);
        xhr.send(formData);
      });
    } catch (err) {
      setUploading(prev => prev.map(u => u.uid === uid ? { ...u, uploadError: err.message } : u));
      setTimeout(() => setUploading(prev => prev.filter(u => u.uid !== uid)), 5000);
      if (localPreview) URL.revokeObjectURL(localPreview);
      return;
    }

    // Step 2 — save the Cloudinary URL to MongoDB via our API
    const item = {
      publicId:     cloudRes.public_id,
      url:          cloudRes.secure_url,
      thumbnailUrl: makeThumbnail(cloudRes.secure_url, isVideo),
      type:         isVideo ? "video" : "image",
      name:         file.name,
      size:         file.size,
      width:        cloudRes.width  || null,
      height:       cloudRes.height || null,
    };

    try {
      const r = await fetchWithRetry("/api/media", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(item),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.detail || body.error || `API error ${r.status}`);
      }
      const saved = await r.json();  // saved has a real MongoDB _id string

      // Add to gallery using the DB record (so delete works by real _id)
      setMedia(prev => [saved, ...prev]);
      setUploading(prev => prev.filter(u => u.uid !== uid));
    } catch (err) {
      // Cloudinary upload succeeded but DB save failed.
      // Show item with a warning badge — it won't persist on refresh.
      setUploading(prev => prev.filter(u => u.uid !== uid));
      setMedia(prev => [{ ...item, _id: uid, _unsaved: true }, ...prev]);
    }

    if (localPreview) URL.revokeObjectURL(localPreview);
  }, []);

  function handleFiles(files) {
    Array.from(files)
      .filter(f => f.type.startsWith("image/") || f.type.startsWith("video/"))
      .forEach(uploadFile);
  }

  // ── DELETE ──────────────────────────────────────────────────────────────────
  async function deleteMedia(item) {
    const id = item._id;
    // Optimistically remove from UI
    setMedia(prev => prev.filter(m => m._id !== id));
    if (selected?._id === id) setSelected(null);

    if (item._unsaved) return; // never saved to DB, nothing to delete there

    try {
      const r = await fetchWithRetry(`/api/media?id=${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`Delete failed: HTTP ${r.status}`);
    } catch {
      // If delete fails, put it back
      setMedia(prev => [item, ...prev]);
    }
  }

  function copyLink(url, id) {
    navigator.clipboard.writeText(url).catch(() => {});
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  }

  const filtered  = media.filter(m => filter === "all" || m.type === filter);
  const totalSize = media.reduce((a, m) => a + (m.size || 0), 0);
  const fmtSize   = totalSize > 1e6 ? `${(totalSize / 1e6).toFixed(1)} MB` : `${Math.round(totalSize / 1024)} KB`;

  return (
    <div style={{ minHeight: "100vh", background: "#0c0c0e", fontFamily: "'DM Sans', sans-serif", color: "#fff" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=Syne:wght@700;800&display=swap" rel="stylesheet" />

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ borderBottom: "1px solid #1e1e22", padding: "1rem 1.5rem", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: "linear-gradient(135deg,#6366f1,#a855f7)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>📸</div>
          <span style={{ fontFamily: "'Syne',sans-serif", fontSize: 20, fontWeight: 800 }}>MediaVault</span>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 13, color: "#6b7280" }}>
          {status === "ok"      && <span style={{ color: "#22c55e" }}>● Live</span>}
          {status === "loading" && <span style={{ color: "#f59e0b" }}>● Connecting…</span>}
          {status === "error"   && (
            <span style={{ color: "#f87171", cursor: "pointer" }} onClick={loadGallery}>
              ● DB Error — tap to retry
            </span>
          )}
          <span>{media.length} files · {fmtSize}</span>
        </div>
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "1.5rem" }}>

        {/* ── DB error detail ────────────────────────────────────────────── */}
        {status === "error" && (
          <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 12, padding: "14px 18px", marginBottom: "1.25rem" }}>
            <p style={{ margin: "0 0 6px", fontSize: 14, fontWeight: 600, color: "#f87171" }}>⚠️ Could not load gallery from database</p>
            <p style={{ margin: "0 0 10px", fontSize: 13, color: "#fca5a5", fontFamily: "monospace" }}>{dbError}</p>
            <p style={{ margin: "0 0 4px", fontSize: 13, color: "#9ca3af" }}>Check:</p>
            <p style={{ margin: "0 0 2px", fontSize: 13, color: "#9ca3af" }}>1. MONGODB_URI is set in Vercel → Settings → Environment Variables</p>
            <p style={{ margin: "0 0 2px", fontSize: 13, color: "#9ca3af" }}>2. MongoDB Atlas → Network Access → 0.0.0.0/0 is allowed</p>
            <p style={{ margin: "0 0 10px", fontSize: 13, color: "#9ca3af" }}>3. Vercel → your project → Functions tab → click /api/media to see server logs</p>
            <button onClick={loadGallery} style={{ background: "rgba(239,68,68,0.2)", border: "1px solid rgba(239,68,68,0.4)", borderRadius: 8, padding: "6px 14px", color: "#f87171", fontSize: 13, cursor: "pointer" }}>
              Retry
            </button>
          </div>
        )}

        {/* ── Drop Zone ──────────────────────────────────────────────────── */}
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
          onClick={() => fileRef.current.click()}
          style={{
            border: `2px dashed ${dragging ? "#6366f1" : "#2a2a2e"}`,
            borderRadius: 16, padding: "2.5rem", textAlign: "center", cursor: "pointer",
            background: dragging ? "rgba(99,102,241,0.08)" : "#17171a",
            transition: "all 0.2s", marginBottom: "1.5rem",
          }}>
          <input ref={fileRef} type="file" multiple accept="image/*,video/*"
            style={{ display: "none" }} onChange={e => handleFiles(e.target.files)} />
          <div style={{ fontSize: 36, marginBottom: 10 }}>🖼️</div>
          <p style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 500 }}>Drop photos & videos here</p>
          <p style={{ margin: 0, fontSize: 13, color: "#6b7280" }}>or click to browse · stored permanently · visible on all devices</p>
        </div>

        {/* ── Upload progress ─────────────────────────────────────────────── */}
        {uploading.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: "1.5rem" }}>
            {uploading.map(u => (
              <div key={u.uid} style={{ background: "#17171a", border: `1px solid ${u.uploadError ? "rgba(239,68,68,0.4)" : "#2a2a2e"}`, borderRadius: 12, padding: "10px 14px", display: "flex", alignItems: "center", gap: 12 }}>
                {u.isVideo
                  ? <div style={{ width: 40, height: 40, flexShrink: 0, borderRadius: 8, background: "#2a2a2e", display: "flex", alignItems: "center", justifyContent: "center" }}>🎬</div>
                  : u.localPreview
                    ? <img src={u.localPreview} alt="" style={{ width: 40, height: 40, flexShrink: 0, borderRadius: 8, objectFit: "cover" }} />
                    : null
                }
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: "0 0 4px", fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.name}</p>
                  {u.uploadError
                    ? <p style={{ margin: 0, fontSize: 12, color: "#f87171" }}>✗ {u.uploadError}</p>
                    : <div style={{ height: 4, background: "#2a2a2e", borderRadius: 99 }}>
                        <div style={{ height: "100%", width: `${u.progress}%`, background: "linear-gradient(90deg,#6366f1,#a855f7)", borderRadius: 99, transition: "width 0.3s" }} />
                      </div>
                  }
                </div>
                {!u.uploadError && <span style={{ fontSize: 12, color: "#9ca3af", flexShrink: 0 }}>{u.progress}%</span>}
              </div>
            ))}
          </div>
        )}

        {/* ── Filter tabs ─────────────────────────────────────────────────── */}
        {media.length > 0 && (
          <div style={{ display: "flex", gap: 8, marginBottom: "1.25rem", flexWrap: "wrap" }}>
            {[
              ["all",   `All (${media.length})`],
              ["image", `📷 Photos (${media.filter(m => m.type === "image").length})`],
              ["video", `🎬 Videos (${media.filter(m => m.type === "video").length})`],
            ].map(([f, label]) => (
              <button key={f} onClick={() => setFilter(f)}
                style={{
                  padding: "6px 16px", borderRadius: 99, border: "1px solid", fontSize: 13,
                  fontWeight: 500, cursor: "pointer",
                  background:  filter === f ? "linear-gradient(135deg,#6366f1,#a855f7)" : "transparent",
                  borderColor: filter === f ? "transparent" : "#2a2a2e",
                  color:       filter === f ? "#fff" : "#9ca3af",
                }}>
                {label}
              </button>
            ))}
          </div>
        )}

        {/* ── Gallery grid ────────────────────────────────────────────────── */}
        {status === "loading" ? (
          <div style={{ textAlign: "center", padding: "5rem", color: "#6b7280" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
            Loading gallery from database…
          </div>
        ) : filtered.length === 0 && uploading.length === 0 ? (
          <div style={{ textAlign: "center", padding: "5rem" }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>🌌</div>
            <p style={{ fontSize: 16, color: "#6b7280", margin: "0 0 6px" }}>No media yet</p>
            <p style={{ fontSize: 13, color: "#4b5563", margin: 0 }}>Upload something — it'll appear here on every device forever</p>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(175px,1fr))", gap: 12 }}>
            {filtered.map(item => (
              <div key={item._id} onClick={() => setSelected(item)}
                style={{ position: "relative", borderRadius: 12, overflow: "hidden", background: "#17171a", border: "1px solid #2a2a2e", cursor: "pointer", aspectRatio: "4/3" }}>
                <img
                  src={item.thumbnailUrl || item.url}
                  alt={item.name}
                  loading="lazy"
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                  onError={e => { if (e.target.src !== item.url) e.target.src = item.url; }}
                />
                {item.type === "video" && (
                  <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 42, height: 42, borderRadius: "50%", background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, pointerEvents: "none" }}>▶</div>
                )}
                {item._unsaved && (
                  <div title="Not saved to database — won't persist on refresh" style={{ position: "absolute", top: 6, right: 6, background: "rgba(245,158,11,0.9)", borderRadius: 6, padding: "2px 7px", fontSize: 10, color: "#fff", fontWeight: 600 }}>
                    ⚠ not saved
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Lightbox ──────────────────────────────────────────────────────── */}
      {selected && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.93)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}
          onClick={e => { if (e.target === e.currentTarget) setSelected(null); }}>
          <div style={{ background: "#17171a", borderRadius: 20, border: "1px solid #2a2a2e", maxWidth: 820, width: "100%", overflow: "hidden" }}>
            <div style={{ background: "#0c0c0e", display: "flex", alignItems: "center", justifyContent: "center", minHeight: 200, maxHeight: "62vh" }}>
              {selected.type === "video"
                ? <video src={selected.url} controls style={{ maxWidth: "100%", maxHeight: "62vh" }} />
                : <img src={selected.url} alt={selected.name} style={{ maxWidth: "100%", maxHeight: "62vh", objectFit: "contain", display: "block" }}
                    onError={e => { e.target.style.opacity = 0.3; e.target.alt = "Failed to load"; }} />
              }
            </div>
            <div style={{ padding: "1rem 1.25rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.75rem" }}>
                <div>
                  <p style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 500 }}>{selected.name}</p>
                  <p style={{ margin: 0, fontSize: 12, color: "#6b7280" }}>
                    {selected.size  ? `${(selected.size / 1024 / 1024).toFixed(2)} MB` : ""}
                    {selected.width ? ` · ${selected.width}×${selected.height}`        : ""}
                  </p>
                </div>
                <button onClick={() => setSelected(null)}
                  style={{ background: "none", border: "none", color: "#9ca3af", fontSize: 22, cursor: "pointer", lineHeight: 1 }}>✕</button>
              </div>
              <div style={{ background: "#0c0c0e", border: "1px solid #2a2a2e", borderRadius: 10, padding: "8px 12px", display: "flex", gap: 8, alignItems: "center", marginBottom: "0.75rem" }}>
                <span style={{ fontSize: 12, color: "#9ca3af", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selected.url}</span>
                <button onClick={() => copyLink(selected.url, selected._id)}
                  style={{ background: copied === selected._id ? "#22c55e" : "linear-gradient(135deg,#6366f1,#a855f7)", border: "none", borderRadius: 6, padding: "4px 12px", color: "#fff", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" }}>
                  {copied === selected._id ? "✓ Copied!" : "Copy Link"}
                </button>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <a href={selected.url} target="_blank" rel="noreferrer"
                  style={{ flex: 1, padding: "8px", textAlign: "center", background: "#2a2a2e", borderRadius: 8, color: "#d1d5db", fontSize: 13, textDecoration: "none" }}>Open ↗</a>
                <a href={selected.url} download
                  style={{ flex: 1, padding: "8px", textAlign: "center", background: "#2a2a2e", borderRadius: 8, color: "#d1d5db", fontSize: 13, textDecoration: "none" }}>Download ↓</a>
                <button onClick={() => deleteMedia(selected)}
                  style={{ padding: "8px 14px", background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, color: "#f87171", fontSize: 13, cursor: "pointer" }}>
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}