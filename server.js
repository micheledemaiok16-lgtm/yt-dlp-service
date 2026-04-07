const express = require("express");
const cors = require("cors");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const execFileAsync = promisify(execFile);

const app = express();
app.use(cors());
app.use(express.json());

// --- Config ---
const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = path.join(__dirname, "downloads");
const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : process.env.BASE_URL || `http://localhost:${PORT}`;
const MAX_FILE_AGE_MS = 30 * 60 * 1000;
const YT_DLP_BIN = process.env.YT_DLP_BIN || "yt-dlp";
const PROXY_URL = process.env.PROXY_URL || "";

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

function getProxyArgs() {
  if (PROXY_URL) {
    return ["--proxy", PROXY_URL];
  }
  return [];
}

// Common yt-dlp args for all endpoints
function getCommonArgs() {
  return [
    ...getProxyArgs(),
    "--extractor-args", "youtube:player_client=web,default",
    "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  ];
}

// --- Serve downloaded files ---
app.use("/files", express.static(DOWNLOAD_DIR, {
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {
      ".mp3": "audio/mpeg",
      ".m4a": "audio/mp4",
      ".opus": "audio/opus",
      ".ogg": "audio/ogg",
    };
    if (mimeMap[ext]) res.setHeader("Content-Type", mimeMap[ext]);
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(filePath)}"`);
  },
}));

// --- Serve frontend ---
app.use(express.static(path.join(__dirname, "public")));

// --- Health check ---
app.get("/api/health", async (req, res) => {
  try {
    const { stdout } = await execFileAsync(YT_DLP_BIN, ["--version"]);
    res.json({
      status: "ok",
      ytdlp_version: stdout.trim(),
      proxy: PROXY_URL || "none",
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: "yt-dlp not found", error: err.message });
  }
});

// --- Get video info ---
app.get("/api/info", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing 'url' query parameter" });

  try {
    const { stdout } = await execFileAsync(YT_DLP_BIN, [
      ...getCommonArgs(),
      "--dump-json",
      "--no-download",
      "--no-warnings",
      url,
    ], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });

    const info = JSON.parse(stdout);
    res.json({
      id: info.id,
      title: info.title,
      duration: info.duration,
      thumbnail: info.thumbnail,
      uploader: info.uploader,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to get video info", details: err.stderr || err.message });
  }
});

// --- Download audio as MP3 (with fallback for music videos) ---
app.post("/api/download", async (req, res) => {
  const { url, quality } = req.body;
  if (!url) return res.status(400).json({ error: "Missing 'url' in request body" });

  const jobId = uuidv4();
  const outputTemplate = path.join(DOWNLOAD_DIR, `${jobId}_%(title).50s.%(ext)s`);
  const audioQuality = quality || "0";

  // Different strategies to try, in order
  const strategies = [
    {
      name: "web",
      args: ["--extractor-args", "youtube:player_client=web,default"],
    },
    {
      name: "ios",
      args: [
        "--extractor-args", "youtube:player_client=ios,web",
        "--user-agent", "com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)",
      ],
    },
    {
      name: "android",
      args: [
        "--extractor-args", "youtube:player_client=android_music,android",
        "--user-agent", "com.google.android.youtube/19.29.37 (Linux; U; Android 14) gzip",
      ],
    },
    {
      name: "tv",
      args: [
        "--extractor-args", "youtube:player_client=tv,web",
      ],
    },
  ];

  let lastError = null;

  for (const strategy of strategies) {
    // Clean up any partial files from previous attempt
    fs.readdirSync(DOWNLOAD_DIR)
      .filter(f => f.startsWith(jobId))
      .forEach(f => { try { fs.unlinkSync(path.join(DOWNLOAD_DIR, f)); } catch {} });

    const userAgent = strategy.args.some(a => a === "--user-agent")
      ? []
      : ["--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"];

    const args = [
      ...getProxyArgs(),
      ...strategy.args,
      ...userAgent,
      "--no-warnings",
      "--no-playlist",
      "--restrict-filenames",
      "-x",
      "--audio-format", "mp3",
      "--audio-quality", audioQuality,
      "-o", outputTemplate,
      url,
    ];

    console.log(`[download] Trying strategy: ${strategy.name} for ${url}`);

    try {
      await execFileAsync(YT_DLP_BIN, args, {
        timeout: 600000,
        maxBuffer: 50 * 1024 * 1024,
      });

      const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(jobId));
      if (files.length === 0) continue;

      const filename = files[0];
      const filePath = path.join(DOWNLOAD_DIR, filename);
      const stats = fs.statSync(filePath);

      // Check file is not empty
      if (stats.size < 1000) {
        fs.unlinkSync(filePath);
        continue;
      }

      console.log(`[download] Success with strategy: ${strategy.name}`);
      return res.json({
        success: true,
        file_url: `${BASE_URL}/files/${encodeURIComponent(filename)}`,
        filename,
        size: stats.size,
        expires_in: "30 minutes",
      });
    } catch (err) {
      lastError = err.stderr || err.message;
      console.log(`[download] Strategy ${strategy.name} failed: ${lastError.substring(0, 100)}`);
    }
  }

  // All strategies failed - cleanup
  fs.readdirSync(DOWNLOAD_DIR)
    .filter(f => f.startsWith(jobId))
    .forEach(f => { try { fs.unlinkSync(path.join(DOWNLOAD_DIR, f)); } catch {} });

  res.status(500).json({ error: "Download failed", details: lastError });
});

// --- Cleanup old files ---
setInterval(() => {
  const now = Date.now();
  fs.readdirSync(DOWNLOAD_DIR).forEach((file) => {
    const filePath = path.join(DOWNLOAD_DIR, file);
    try {
      const stats = fs.statSync(filePath);
      if (now - stats.mtimeMs > MAX_FILE_AGE_MS) {
        fs.unlinkSync(filePath);
        console.log(`[cleanup] Removed: ${file}`);
      }
    } catch {}
  });
}, 5 * 60 * 1000);

// --- Start ---
app.listen(PORT, () => {
  console.log(`yt-dlp service running on port ${PORT}`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Proxy: ${PROXY_URL || "none"}`);
});