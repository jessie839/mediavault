import { useState, useRef, useEffect, useCallback } from "react";

// ─── CONFIG — paste your Cloudinary values here ───────────────────────────────
const CLOUD_NAME    = "dmhbmil4k";       // e.g. "my-cloud-abc123"
const UPLOAD_PRESET = "mediavault_unsigned";
// ─────────────────────────────────────────────────────────────────────────────

// Build a safe thumbnail URL from a Cloudinary secure_url
// Uses the ORIGINAL url as fallback if transformation fails
function makeThumbnail(url, isVideo) {
  try {
    if (isVideo) {
      // Video: grab frame at 0s, resize, convert to jpg
      return url
        .replace("/upload/", "/upload/so_0,w_400,h_300,c_fill,f_jpg/")
        .replace(/\.(mp4|webm|mov|avi)(\?.*)?$/, ".jpg");
    }
    // Image: just resize — keep original format (no format conversion)
    return url.replace("/upload/", "/upload/w_400,h_300,c_fill/");
  } catch {
    return url; // fallback: show original
  }
}

export default function App() {
  const [media,     setMedia]     = useState([]);
  const [uploading, setUploading] = useState([]);
  const [dragging,  setDragging]  = useState(false);
  const [selected,  setSelected]  = useState(null);
  const [filter,    setFilter]    = useState("all");
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);
  const [copied,    setCopied]    = useState(null);
  const fileRef = useRef();

  // ── Load gallery ────────────────────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/media")
      .then(r => {
        if (!r.ok) throw new Error(`API error ${r.status}`);
        return r.json();
      })
      .then(data => { setMedia(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(err  => { setError(err.message); setLoading(false); });
  }, []);

  // ── Upload one file ─────────────────────────────────────────────────────────
  const uploadFile = useCallback(async (file) => {
    const uid     = `${Date.now()}-${Math.random()}`;
    const isVideo = file.type.startsWith("video/");
    // Show local preview immediately while uploading
    const localPreview = URL.createObjectURL(file);

    setUploading(prev => [...prev, {
      uid, name: file.name, progress: 0, localPreview, isVideo, error: null,
    }]);

    // ── Step 1: Upload to Cloudinary ─────────────────────────────────────────
    const formData = new FormData();
    formData.append("file",           file);
    formData.append("upload_preset",  UPLOAD_PRESET);

    let cloudRes;
    try {
      await new Promise((resolve, reject) => {
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
            if (xhr.status >= 400 || parsed.error) {
              reject(new Error(parsed.error?.message || `Cloudinary error ${xhr.status}`));
            } else {
              cloudRes = parsed;
              resolve();
            }
          } catch { reject(new Error("Invalid Cloudinary response")); }
        };
        xhr.onerror = () => reject(new Error("Network error during upload"));
        xhr.open("POST", `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/upload`);
        xhr.send(formData);
      });
    } catch (err) {
      setUploading(prev => prev.map(u =>
        u.uid === uid ? { ...u, error: `Upload failed: ${err.message}` } : u
      ));
      setTimeout(() => setUploading(prev => prev.filter(u => u.uid !== uid)), 4000);
      URL.revokeObjectURL(localPreview);
      return;
    }

    // ── Step 2: Build item using the REAL Cloudinary URL ─────────────────────
    const item = {
      publicId:     cloudRes.public_id,
      url:          cloudRes.secure_url,          // always use secure_url directly
      thumbnailUrl: makeThumbnail(cloudRes.secure_url, isVideo),
      type:         isVideo ? "video" : "image",
      name:         file.name,
      size:         file.size,
      width:        cloudRes.width,
      height:       cloudRes.height,
    };

    // ── Step 3: Save URL to MongoDB via Vercel API ────────────────────────────
    try {
      const saved = await fetch("/api/media", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(item),
      }).then(r => {
        if (!r.ok) throw new Error(`API save error ${r.status}`);
        return r.json();
      });

      setUploading(prev => prev.filter(u => u.uid !== uid));
      setMedia(prev => [saved, ...prev]);
    } catch (err) {
      // Even if DB save fails, show the image using the Cloudinary URL
      // (it won't persist across refreshes but at least it shows)
      setUploading(prev => prev.filter(u => u.uid !== uid));
      setMedia(prev => [{ ...item, _id: uid, _localOnly: true }, ...prev]);
    }

    URL.revokeObjectURL(localPreview);
  }, []);

  function handleFiles(files) {
    Array.from(files)
      .filter(f => f.type.startsWith("image/") || f.type.startsWith("video/"))
      .forEach(f => uploadFile(f));
  }

  async function deleteMedia(id) {
    try { await fetch(`/api/media?id=${id}`, { method: "DELETE" }); } catch {}
    setMedia(prev => prev.filter(m => (m._id || m.uid) !== id));
    if ((selected?._id || selected?.uid) === id) setSelected(null);
  }

  function copyLink(url, id) {
    navigator.clipboard.writeText(url).catch(() => {});
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  }

  const filtered  = media.filter(m => filter === "all" || m.type === filter);
  const totalSize = media.reduce((a, m) => a + (m.size || 0), 0);
  const fmtSize   = totalSize > 1e6
    ? `${(totalSize / 1e6).toFixed(1)} MB`
    : `${Math.round(totalSize / 1024)} KB`;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: "#0c0c0e", fontFamily: "'DM Sans', sans-serif", color: "#fff" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=Syne:wght@700;800&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{ borderBottom: "1px solid #1e1e22", padding: "1rem 1.5rem", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: "linear-gradient(135deg,#6366f1,#a855f7)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>📸</div>
          <span style={{ fontFamily: "'Syne',sans-serif", fontSize: 20, fontWeight: 800 }}>MediaVault</span>
        </div>
        <div style={{ display: "flex", gap: "1.5rem", fontSize: 13, color: "#6b7280" }}>
          <span>{media.length} files</span>
          <span>{fmtSize}</span>
        </div>
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "1.5rem" }}>

        {/* Error banner */}
        {error && (
          <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 10, padding: "10px 14px", marginBottom: "1rem", fontSize: 13, color: "#f87171" }}>
            ⚠️ Could not load gallery: {error}. Check your /api/media route and MongoDB connection.
          </div>
        )}

        {/* Drop Zone */}
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
          <p style={{ margin: 0, fontSize: 13, color: "#6b7280" }}>or click to browse · Visible to everyone instantly</p>
        </div>

        {/* Upload progress rows */}
        {uploading.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: "1.5rem" }}>
            {uploading.map(u => (
              <div key={u.uid} style={{ background: "#17171a", border: `1px solid ${u.error ? "rgba(239,68,68,0.4)" : "#2a2a2e"}`, borderRadius: 12, padding: "10px 14px", display: "flex", alignItems: "center", gap: 12 }}>
                {/* Local preview thumbnail while uploading */}
                {u.isVideo
                  ? <div style={{ width: 40, height: 40, borderRadius: 8, background: "#2a2a2e", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>🎬</div>
                  : <img src={u.localPreview} alt="" style={{ width: 40, height: 40, borderRadius: 8, objectFit: "cover", flexShrink: 0 }} />
                }
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: "0 0 4px", fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.name}</p>
                  {u.error
                    ? <p style={{ margin: 0, fontSize: 12, color: "#f87171" }}>{u.error}</p>
                    : <div style={{ height: 4, background: "#2a2a2e", borderRadius: 99 }}>
                        <div style={{ height: "100%", width: `${u.progress}%`, background: "linear-gradient(90deg,#6366f1,#a855f7)", borderRadius: 99, transition: "width 0.3s" }} />
                      </div>
                  }
                </div>
                {!u.error && <span style={{ fontSize: 12, color: "#9ca3af", flexShrink: 0 }}>{u.progress}%</span>}
              </div>
            ))}
          </div>
        )}

        {/* Filter tabs */}
        {media.length > 0 && (
          <div style={{ display: "flex", gap: 8, marginBottom: "1.25rem", flexWrap: "wrap" }}>
            {[
              ["all",   `All (${media.length})`],
              ["image", `📷 Photos (${media.filter(m => m.type === "image").length})`],
              ["video", `🎬 Videos (${media.filter(m => m.type === "video").length})`],
            ].map(([f, label]) => (
              <button key={f} onClick={() => setFilter(f)}
                style={{
                  padding: "6px 16px", borderRadius: 99, border: "1px solid", fontSize: 13, fontWeight: 500, cursor: "pointer",
                  background:   filter === f ? "linear-gradient(135deg,#6366f1,#a855f7)" : "transparent",
                  borderColor:  filter === f ? "transparent" : "#2a2a2e",
                  color:        filter === f ? "#fff" : "#9ca3af",
                }}>
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Gallery grid */}
        {loading ? (
          <div style={{ textAlign: "center", padding: "4rem", color: "#6b7280" }}>Loading gallery…</div>
        ) : filtered.length === 0 && uploading.length === 0 ? (
          <div style={{ textAlign: "center", padding: "4rem" }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>🌌</div>
            <p style={{ fontSize: 16, color: "#6b7280", margin: "0 0 6px" }}>No media yet</p>
            <p style={{ fontSize: 13, color: "#4b5563", margin: 0 }}>Upload something — it'll appear here for everyone</p>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: 12 }}>
            {filtered.map(item => {
              const key = item._id || item.uid;
              return (
                <div key={key} onClick={() => setSelected(item)}
                  style={{ position: "relative", borderRadius: 12, overflow: "hidden", background: "#17171a", border: "1px solid #2a2a2e", cursor: "pointer", aspectRatio: "4/3" }}>
                  <img
                    src={item.thumbnailUrl || item.url}   
                    alt={item.name}
                    loading="lazy"
                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                    onError={e => {
                      // If thumbnail fails, try the original full URL
                      if (e.target.src !== item.url) {
                        e.target.src = item.url;
                      }
                    }}
                  />
                  {item.type === "video" && (
                    <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 42, height: 42, borderRadius: "50%", background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>▶</div>
                  )}
                  {item._localOnly && (
                    <div style={{ position: "absolute", top: 6, right: 6, background: "rgba(245,158,11,0.9)", borderRadius: 6, padding: "2px 6px", fontSize: 10, color: "#fff" }}>local</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Lightbox */}
      {selected && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.93)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}
          onClick={e => { if (e.target === e.currentTarget) setSelected(null); }}>
          <div style={{ background: "#17171a", borderRadius: 20, border: "1px solid #2a2a2e", maxWidth: 820, width: "100%", overflow: "hidden" }}>
            <div style={{ background: "#0c0c0e", display: "flex", alignItems: "center", justifyContent: "center", minHeight: 200, maxHeight: "62vh" }}>
              {selected.type === "video"
                ? <video src={selected.url} controls style={{ maxWidth: "100%", maxHeight: "62vh" }} />
                : <img
                    src={selected.url}
                    alt={selected.name}
                    style={{ maxWidth: "100%", maxHeight: "62vh", objectFit: "contain", display: "block" }}
                    onError={e => { e.target.alt = "Image failed to load — check Cloudinary URL"; }}
                  />
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
              {/* URL row */}
              <div style={{ background: "#0c0c0e", border: "1px solid #2a2a2e", borderRadius: 10, padding: "8px 12px", display: "flex", gap: 8, alignItems: "center", marginBottom: "0.75rem" }}>
                <span style={{ fontSize: 12, color: "#9ca3af", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selected.url}</span>
                <button
                  onClick={() => copyLink(selected.url, selected._id || selected.uid)}
                  style={{ background: copied === (selected._id || selected.uid) ? "#22c55e" : "linear-gradient(135deg,#6366f1,#a855f7)", border: "none", borderRadius: 6, padding: "4px 12px", color: "#fff", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" }}>
                  {copied === (selected._id || selected.uid) ? "✓ Copied!" : "Copy Link"}
                </button>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <a href={selected.url} target="_blank" rel="noreferrer"
                  style={{ flex: 1, padding: "8px", textAlign: "center", background: "#2a2a2e", borderRadius: 8, color: "#d1d5db", fontSize: 13, textDecoration: "none" }}>
                  Open ↗
                </a>
                <a href={selected.url} download
                  style={{ flex: 1, padding: "8px", textAlign: "center", background: "#2a2a2e", borderRadius: 8, color: "#d1d5db", fontSize: 13, textDecoration: "none" }}>
                  Download ↓
                </a>
                <button
                  onClick={() => deleteMedia(selected._id || selected.uid)}
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