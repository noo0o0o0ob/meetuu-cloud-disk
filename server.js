import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline as streamPipeline } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import OSS from "ali-oss";
import express from "express";
import multer from "multer";
import initSqlJs from "sql.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pipeline = promisify(streamPipeline);
const app = express();
const port = Number(process.env.PORT || 3100);

const bucketName = process.env.OSS_BUCKET_NAME || "";
const ossRegion = process.env.OSS_REGION || "";
const ossEndpoint = process.env.OSS_ENDPOINT || "";
const bucketHost = bucketName && ossEndpoint ? `${bucketName}.${ossEndpoint}` : "";
const bucketBaseUrl = bucketHost ? `http://${bucketHost}` : "";
const maxUploadBytes = Number(process.env.OSS_UPLOAD_MAX_BYTES || 500 * 1024 * 1024);
const chunkSizeBytes = 5 * 1024 * 1024;
const chunkUploadLimitBytes = chunkSizeBytes + 1024 * 1024;
const chunkedUploadThreshold = 20 * 1024 * 1024;
const initialPassword = process.env.CLOUD_DISK_INITIAL_PASSWORD || crypto.randomBytes(12).toString("base64url");
const sessionSecret = process.env.CLOUD_DISK_SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const dataDir = process.env.CLOUD_DISK_DATA_DIR || path.join(__dirname, "data");
const dbPath = process.env.CLOUD_DISK_DB_PATH || path.join(dataDir, "cloud.db");
const uploadTmpDir = path.join(dataDir, "tmp-uploads");

const allowedSiteHosts = (process.env.CLOUD_DISK_ALLOWED_HOSTS || "").split(",").map((h) => h.trim()).filter(Boolean);

const ossAccessKeyId = process.env.OSS_ACCESS_KEY_ID || "";
const ossAccessKeySecret = process.env.OSS_ACCESS_KEY_SECRET || "";
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadTmpDir,
    filename: (_req, _file, cb) => {
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`);
    }
  }),
  limits: {
    files: 1,
    fileSize: maxUploadBytes
  }
});
const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: chunkUploadLimitBytes
  }
});

const ossClient = ossAccessKeyId && ossAccessKeySecret
  ? new OSS({
      region: ossRegion,
      bucket: bucketName,
      endpoint: ossEndpoint,
      internal: true,
      accessKeyId: ossAccessKeyId,
      accessKeySecret: ossAccessKeySecret
    })
  : null;

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadTmpDir, { recursive: true });
const SQL = await initSqlJs({
  locateFile: (file) => path.join(__dirname, "node_modules", "sql.js", "dist", file)
});
const db = fs.existsSync(dbPath)
  ? new SQL.Database(fs.readFileSync(dbPath))
  : new SQL.Database();

function persistDb() {
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
}

function run(sql, params = []) {
  db.run(sql, params);
  const lastIdRow = db.exec("SELECT last_insert_rowid() AS id");
  persistDb();
  return {
    lastID: lastIdRow[0]?.values?.[0]?.[0] || 0,
    changes: db.getRowsModified()
  };
}

function rowsFromResult(result) {
  const table = result[0];
  if (!table) return [];
  return table.values.map((values) => Object.fromEntries(
    table.columns.map((column, index) => [column, values[index]])
  ));
}

function get(sql, params = []) {
  return rowsFromResult(db.exec(sql, params))[0];
}

function all(sql, params = []) {
  return rowsFromResult(db.exec(sql, params));
}

function nowIso() {
  return new Date().toISOString();
}

function hashSecret(value, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(value), salt, 160000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifySecret(value, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const candidate = hashSecret(value, salt).split(":")[1];
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function initDb() {
  run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  run(`CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    storage_type TEXT NOT NULL CHECK(storage_type IN ('temporary', 'permanent')),
    original_name TEXT NOT NULL,
    oss_key TEXT NOT NULL UNIQUE,
    size INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    pickup_code TEXT,
    pickup_code_hash TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL
  )`);

  try { run("ALTER TABLE files ADD COLUMN pickup_code TEXT"); } catch {}

  const password = get("SELECT value FROM settings WHERE key = ?", ["password_hash"]);
  if (!password) {
    const stamp = nowIso();
    run(
      "INSERT INTO settings (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)",
      ["password_hash", hashSecret(initialPassword), stamp, stamp]
    );
  }
}

function parseCookies(req) {
  const header = req.get("cookie") || "";
  return Object.fromEntries(header.split(";").map((part) => {
    const index = part.indexOf("=");
    if (index === -1) return ["", ""];
    return [
      decodeURIComponent(part.slice(0, index).trim()),
      decodeURIComponent(part.slice(index + 1).trim())
    ];
  }).filter(([key]) => key));
}

function sign(value) {
  return crypto.createHmac("sha256", sessionSecret).update(value).digest("hex");
}

function createToken(payload, ttlSeconds) {
  const body = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    nonce: crypto.randomBytes(8).toString("hex")
  };
  const encoded = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

function readToken(token) {
  if (!token || !token.includes(".")) return null;
  const [encoded, signature] = token.split(".");
  if (signature !== sign(encoded)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload.exp || Date.now() > payload.exp * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

function setAuthCookie(res, sessionOnly = false, clientIp = "") {
  const csrfToken = crypto.randomBytes(32).toString("hex");
  const ipHash = crypto.createHash("sha256").update(clientIp || "unknown").digest("hex").slice(0, 16);
  const token = createToken({ type: "session", csrf: csrfToken, ip: ipHash }, 60 * 60 * 12);
  const cookie = sessionOnly
    ? `cloud_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax`
    : `cloud_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 12}`;
  const csrfCookie = sessionOnly
    ? `csrf_token=${encodeURIComponent(csrfToken)}; Path=/; Secure; SameSite=Lax`
    : `csrf_token=${encodeURIComponent(csrfToken)}; Path=/; Secure; SameSite=Lax; Max-Age=${60 * 60 * 12}`;
  res.setHeader("Set-Cookie", [cookie, csrfCookie]);
}

function clearAuthCookie(res) {
  res.setHeader("Set-Cookie", [
    "cloud_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    "csrf_token=; Path=/; Secure; SameSite=Lax; Max-Age=0"
  ]);
}

function isLoggedIn(req) {
  const token = parseCookies(req).cloud_session;
  const payload = readToken(token);
  if (!payload || payload.type !== "session") return false;
  const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  const ipHash = crypto.createHash("sha256").update(clientIp).digest("hex").slice(0, 16);
  if (payload.ip && payload.ip !== ipHash) return false;
  return true;
}

function requireAuth(req, res, next) {
  if (!isLoggedIn(req)) {
    res.status(401).json({ ok: false, error: "Please sign in first" });
    return;
  }
  next();
}

function requireCsrf(req, res, next) {
  const cookies = parseCookies(req);
  const csrfCookie = cookies.csrf_token;
  const csrfHeader = req.get("x-csrf-token") || "";
  if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
    res.status(403).json({ ok: false, error: "CSRF token missing or invalid" });
    return;
  }
  next();
}

function parseHeaderHost(value) {
  if (!value) return "";
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function hostMatchesRule(host, rule) {
  if (!host) return false;
  const normalizedHost = host.toLowerCase();
  const normalizedRule = rule.toLowerCase();
  if (normalizedRule.startsWith("*.")) {
    const domain = normalizedRule.slice(2);
    return normalizedHost === domain || normalizedHost.endsWith(`.${domain}`);
  }
  return normalizedHost === normalizedRule;
}

function isAllowedHost(host) {
  return allowedSiteHosts.some((rule) => hostMatchesRule(host, rule));
}

function getHeaderValue(req, name) {
  return req.get(name) || req.get(name.toLowerCase()) || req.get(name.toUpperCase()) || "";
}

function getRequestSiteHost(req) {
  const originHost = parseHeaderHost(getHeaderValue(req, "origin"));
  if (originHost) return originHost;
  const refererHost = parseHeaderHost(getHeaderValue(req, "referer"));
  if (refererHost) return refererHost;
  return "";
}

function applyCors(req, res) {
  const origin = getHeaderValue(req, "origin");
  const originHost = parseHeaderHost(origin);
  if (origin && isAllowedHost(originHost)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Requested-With, X-CSRF-Token");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
}

function validateHotlink(req) {
  if (req.method === "GET" && req.path === "/api/config") return "";
  const siteHost = getRequestSiteHost(req);
  if (!siteHost) return "missing Origin or Referer";
  if (!isAllowedHost(siteHost)) return `blocked host: ${siteHost}`;
  return "";
}

const rateBuckets = new Map();
function rateLimit(name, limit, windowMs) {
  return (req, res, next) => {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    const key = `${name}:${ip}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
    }
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    if (bucket.count > limit) {
      res.status(429).json({ ok: false, error: "Too many requests, please try later" });
      return;
    }
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now > bucket.resetAt) rateBuckets.delete(key);
  }
}, 60_000);

const allowedOssKeyPrefixes = ["cloud/temp/", "cloud/permanent/"];

function validateObjectKey(key) {
  if (!key || typeof key !== "string") return "key is required";
  if (key.startsWith("/") || key.includes("..") || key.includes("\\")) {
    return "key must be a relative OSS object key without .., backslash, or leading slash";
  }
  return "";
}

function validateOssProxyKey(key) {
  const baseError = validateObjectKey(key);
  if (baseError) return baseError;
  const isAllowed = allowedOssKeyPrefixes.some((prefix) => key.startsWith(prefix));
  if (!isAllowed) return "key must start with cloud/temp/ or cloud/permanent/";
  return "";
}

function safeFileName(fileName) {
  const parsed = path.parse(fileName || "upload.bin");
  const base = parsed.name
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "upload";
  const ext = parsed.ext.replace(/[^\w.]+/g, "").slice(0, 16);
  return `${base}${ext}`.toLowerCase();
}

function buildUploadKey(fileName, storageType) {
  const now = new Date();
  const datePath = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("/");
  const random = crypto.randomBytes(8).toString("hex");
  const prefix = storageType === "temporary" ? "cloud/temp" : "cloud/permanent";
  return `${prefix}/${datePath}/${Date.now()}-${random}-${safeFileName(fileName)}`;
}

function normalizeFile(row) {
  return {
    id: row.id,
    storageType: row.storage_type,
    originalName: row.original_name,
    size: row.size,
    contentType: row.content_type,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    openUrl: `/api/files/${row.id}/download?disposition=inline`,
    downloadUrl: `/api/files/${row.id}/download?disposition=attachment`
  };
}

function isExpired(row) {
  return Boolean(row.expires_at && Date.now() > new Date(row.expires_at).getTime());
}

function contentDisposition(mode, fileName) {
  const disposition = mode === "inline" ? "inline" : "attachment";
  const fallback = safeFileName(fileName);
  const encoded = encodeURIComponent(fileName).replace(/['()]/g, escape);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function streamOssObjectByKey(key, req, res, options = {}) {
  const validationError = validateObjectKey(key);
  if (validationError) {
    res.status(400).type("text/plain; charset=utf-8").send(validationError);
    return;
  }

  if (!ossClient) {
    res.status(503).type("text/plain; charset=utf-8").send("OSS client is not configured");
    return;
  }

  try {
    const result = req.method === "HEAD"
      ? await ossClient.head(key)
      : await ossClient.getStream(key);
    const headers = result.res?.headers || {};

    res.status(result.res?.status || result.status || 200);
    res.setHeader("X-OSS-Proxy", "internal-endpoint");
    res.setHeader("X-OSS-Endpoint", bucketHost);
    res.setHeader("Cache-Control", "private, no-store");

    for (const header of ["content-type", "content-length", "etag", "last-modified"]) {
      const value = headers[header];
      if (value) res.setHeader(header, value);
    }

    if (options.fileName) {
      res.setHeader("Content-Disposition", contentDisposition(options.disposition, options.fileName));
    }

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    if (!result.stream) {
      res.status(502).type("text/plain; charset=utf-8").send("failed to open OSS object stream");
      return;
    }

    await pipeline(result.stream, res);
  } catch (error) {
    const status = ["NoSuchKey", "NoSuchBucket", "NotFound"].includes(error?.code) ? 404 : 502;
    console.error("OSS stream error:", error);
    if (!res.headersSent) {
      res.status(status).type("text/plain; charset=utf-8").send("Failed to read file");
    } else {
      res.destroy(error);
    }
  }
}

async function deleteOssObject(key) {
  if (!ossClient) {
    throw new Error("OSS client is not configured");
  }

  try {
    await ossClient.delete(key);
  } catch (error) {
    if (!["NoSuchKey", "NotFound"].includes(error?.code)) {
      throw error;
    }
  }
}

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  res.setHeader("X-OSS-Test-App", "cloud-disk");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join("; ")
  );
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.path.startsWith("/api/")) {
    const hotlinkError = validateHotlink(req);
    if (hotlinkError) {
      res.status(403).json({ ok: false, error: `hotlink denied: ${hotlinkError}` });
      return;
    }
  }

  next();
});

app.get("/api/config", (req, res) => {
  res.json({
    ok: true,
    region: ossRegion,
    bucket: bucketName,
    endpoint: bucketHost || undefined,
    maxUploadBytes,
    chunkedUploadThreshold,
    chunkSizeBytes,
    uploadConfigured: Boolean(ossClient),
    live: {
      enabled: Boolean(liveRegion && liveBucket),
      region: liveRegion,
      bucket: liveBucket
    }
  });
});

app.get("/api/auth/me", (req, res) => {
  res.json({ ok: true, loggedIn: isLoggedIn(req) });
});

app.post("/api/auth/login", rateLimit("login", 20, 60 * 1000), (req, res) => {
  const password = String(req.body.password || "");
  const sessionOnly = Boolean(req.body.session);
  const row = get("SELECT value FROM settings WHERE key = ?", ["password_hash"]);
  if (!verifySecret(password, row?.value)) {
    res.status(401).json({ ok: false, error: "Password is incorrect" });
    return;
  }
  const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "";
  setAuthCookie(res, sessionOnly, clientIp);
  res.json({ ok: true, loggedIn: true });
});

app.post("/api/auth/logout", requireCsrf, (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true, loggedIn: false });
});

app.post("/api/admin/password", requireAuth, requireCsrf, rateLimit("password", 10, 60 * 1000), (req, res) => {
  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = String(req.body.newPassword || "");
  const confirmPassword = String(req.body.confirmPassword || "");

  if (newPassword.length < 8) {
    res.status(400).json({ ok: false, error: "New password must be at least 8 characters" });
    return;
  }

  if (newPassword !== confirmPassword) {
    res.status(400).json({ ok: false, error: "New passwords do not match" });
    return;
  }

  const row = get("SELECT value FROM settings WHERE key = ?", ["password_hash"]);
  if (!verifySecret(currentPassword, row?.value)) {
    res.status(401).json({ ok: false, error: "Current password is incorrect" });
    return;
  }

  run("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?", [
    hashSecret(newPassword),
    nowIso(),
    "password_hash"
  ]);

  res.json({ ok: true });
});

app.post("/api/files/upload/init", requireAuth, requireCsrf, rateLimit("upload-init", 20, 60 * 1000), async (req, res) => {
  if (!ossClient) {
    res.status(503).json({ ok: false, error: "Upload is not configured on the server" });
    return;
  }

  const storageType = req.body.storageType === "temporary" ? "temporary" : "permanent";
  const fileName = String(req.body.fileName || "upload.bin");
  const fileSize = Number(req.body.fileSize || 0);
  const mimeType = String(req.body.mimeType || "application/octet-stream");
  const pickupCode = String(req.body.pickupCode || "").trim();
  const expiresInHours = Number(req.body.expiresInHours || 24);

  if (fileSize > maxUploadBytes) {
    res.status(400).json({ ok: false, error: "File too large" });
    return;
  }

  if (storageType === "temporary" && pickupCode.length < 2) {
    res.status(400).json({ ok: false, error: "Temporary storage needs a pickup code with at least 2 characters" });
    return;
  }

  const key = buildUploadKey(fileName, storageType);
  const validationError = validateObjectKey(key);
  if (validationError) {
    res.status(400).json({ ok: false, error: validationError });
    return;
  }

  try {
    const result = await ossClient.initMultipartUpload(key, {
      headers: objectHeaders,
      bucket: bucketName || undefined
    });

    const createdAt = nowIso();
    const expiresAt = storageType === "temporary"
      ? new Date(Date.now() + Math.max(1, Math.min(expiresInHours, 24 * 30)) * 60 * 60 * 1000).toISOString()
      : null;

    res.json({
      ok: true,
      uploadId: result.uploadId,
      objectKey: key,
      storageType,
      fileName,
      fileSize,
      mimeType,
      pickupCode: storageType === "temporary" ? pickupCode : null,
      pickupCodeHash: storageType === "temporary" ? hashSecret(pickupCode) : null,
      expiresAt,
      createdAt
    });
  } catch (error) {
    console.error("Init upload failed:", error);
    res.status(502).json({ ok: false, error: "Failed to initialize upload" });
  }
});

app.post("/api/files/upload/part", requireAuth, requireCsrf, rateLimit("upload-part", 200, 60 * 1000), chunkUpload.single("chunk"), async (req, res) => {
  if (!ossClient) {
    res.status(503).json({ ok: false, error: "Upload is not configured on the server" });
    return;
  }

  if (!req.file) {
    res.status(400).json({ ok: false, error: "Missing chunk" });
    return;
  }

  const uploadId = String(req.body.uploadId || "");
  const objectKey = String(req.body.objectKey || "");
  const partNumber = Number(req.body.partNumber || 0);

  if (!uploadId || !objectKey || partNumber < 1) {
    res.status(400).json({ ok: false, error: "Missing or invalid uploadId, objectKey, or partNumber" });
    return;
  }

  const validationError = validateObjectKey(objectKey);
  if (validationError) {
    res.status(400).json({ ok: false, error: validationError });
    return;
  }

  try {
    const result = await ossClient.uploadPart(objectKey, uploadId, partNumber, req.file.buffer);
    res.json({ ok: true, etag: result.etag, partNumber });
  } catch (error) {
    console.error("Upload part failed:", error);
    res.status(502).json({ ok: false, error: "Failed to upload file part" });
  }
}, (error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    res.status(400).json({ ok: false, error: error.message });
    return;
  }
  next(error);
});

app.post("/api/files/upload/complete", requireAuth, requireCsrf, rateLimit("upload-complete", 20, 60 * 1000), async (req, res) => {
  if (!ossClient) {
    res.status(503).json({ ok: false, error: "Upload is not configured on the server" });
    return;
  }

  const uploadId = String(req.body.uploadId || "");
  const objectKey = String(req.body.objectKey || "");
  const partETags = req.body.partETags || [];
  const storageType = req.body.storageType === "temporary" ? "temporary" : "permanent";
  const fileName = String(req.body.fileName || "upload.bin");
  const fileSize = Number(req.body.fileSize || 0);
  const mimeType = String(req.body.mimeType || "application/octet-stream");
  const pickupCode = req.body.pickupCode || null;
  const pickupCodeHash = req.body.pickupCodeHash || null;
  const expiresAt = req.body.expiresAt || null;

  if (!uploadId || !objectKey || !Array.isArray(partETags) || partETags.length === 0) {
    res.status(400).json({ ok: false, error: "Missing required parameters" });
    return;
  }

  const validationError = validateObjectKey(objectKey);
  if (validationError) {
    res.status(400).json({ ok: false, error: validationError });
    return;
  }

  try {
    await ossClient.completeMultipartUpload(objectKey, uploadId, partETags);

    const createdAt = nowIso();
    const result = run(
      `INSERT INTO files
        (storage_type, original_name, oss_key, size, content_type, pickup_code, pickup_code_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        storageType,
        fileName,
        objectKey,
        fileSize,
        mimeType,
        pickupCode,
        pickupCodeHash,
        expiresAt,
        createdAt
      ]
    );

    const row = get("SELECT * FROM files WHERE id = ?", [result.lastID]);
    res.json({ ok: true, file: normalizeFile(row) });
  } catch (error) {
    console.error("Complete upload failed:", error);
    res.status(502).json({ ok: false, error: "Failed to complete upload" });
  }
});

app.post("/api/files/upload", requireAuth, requireCsrf, rateLimit("upload", 40, 60 * 1000), upload.single("file"), async (req, res) => {
  if (!ossClient) {
    res.status(503).json({ ok: false, error: "Upload is not configured on the server" });
    return;
  }

  if (!req.file) {
    res.status(400).json({ ok: false, error: "Please choose a file" });
    return;
  }

  const storageType = req.body.storageType === "temporary" ? "temporary" : "permanent";
  const pickupCode = String(req.body.pickupCode || "").trim();
  const expiresInHours = Number(req.body.expiresInHours || 24);

  if (storageType === "temporary" && pickupCode.length < 2) {
    res.status(400).json({ ok: false, error: "Temporary storage needs a pickup code with at least 2 characters" });
    return;
  }

  const key = buildUploadKey(req.file.originalname, storageType);
  const validationError = validateObjectKey(key);
  if (validationError) {
    res.status(400).json({ ok: false, error: validationError });
    return;
  }

  const createdAt = nowIso();
  const expiresAt = storageType === "temporary"
    ? new Date(Date.now() + Math.max(1, Math.min(expiresInHours, 24 * 30)) * 60 * 60 * 1000).toISOString()
    : null;

  try {
    await ossClient.put(key, req.file.path, {
      mime: req.file.mimetype || "application/octet-stream",
      headers: {
        "Cache-Control": "private, no-store"
      }
    });

    const result = run(
      `INSERT INTO files
        (storage_type, original_name, oss_key, size, content_type, pickup_code, pickup_code_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        storageType,
        req.file.originalname || "upload.bin",
        key,
        req.file.size,
        req.file.mimetype || "application/octet-stream",
        storageType === "temporary" ? pickupCode : null,
        storageType === "temporary" ? hashSecret(pickupCode) : null,
        expiresAt,
        createdAt
      ]
    );

    const row = get("SELECT * FROM files WHERE id = ?", [result.lastID]);
    res.json({ ok: true, file: normalizeFile(row) });
  } catch (error) {
    console.error("Upload failed:", error);
    res.status(502).json({ ok: false, error: "Failed to upload file" });
  } finally {
    try { fs.unlinkSync(req.file.path); } catch {}
  }
}, (error, req, res, next) => {
  if (req.file?.path) {
    try { fs.unlinkSync(req.file.path); } catch {}
  }
  if (error instanceof multer.MulterError) {
    res.status(400).json({ ok: false, error: error.message });
    return;
  }
  next(error);
});

app.get("/api/files", requireAuth, (req, res) => {
  const storageType = req.query.storageType;
  if (storageType && !["permanent", "temporary"].includes(storageType)) {
    res.status(400).json({ ok: false, error: "Invalid storageType" });
    return;
  }
  const rows = storageType
    ? all("SELECT * FROM files WHERE storage_type = ? ORDER BY created_at DESC LIMIT 200", [storageType])
    : all("SELECT * FROM files ORDER BY created_at DESC LIMIT 200");
  res.json({ ok: true, files: rows.map(normalizeFile) });
});

app.get("/api/files/:id/download", requireAuth, rateLimit("download", 120, 60 * 1000), async (req, res) => {
  const row = get("SELECT * FROM files WHERE id = ?", [Number(req.params.id)]);
  if (!row) {
    res.status(404).type("text/plain; charset=utf-8").send("File not found");
    return;
  }

  if (row.storage_type === "temporary" && isExpired(row)) {
    res.status(410).type("text/plain; charset=utf-8").send("File has expired");
    return;
  }

  await streamOssObjectByKey(row.oss_key, req, res, {
    fileName: row.original_name,
    disposition: req.query.disposition === "inline" ? "inline" : "attachment"
  });
});

app.get("/api/files/:id/detail", requireAuth, rateLimit("detail", 120, 60 * 1000), (req, res) => {
  const row = get("SELECT * FROM files WHERE id = ?", [Number(req.params.id)]);
  if (!row) {
    res.status(404).json({ ok: false, error: "File not found" });
    return;
  }

  res.json({
    ok: true,
    file: {
      id: row.id,
      storageType: row.storage_type,
      originalName: row.original_name,
      ossKey: row.oss_key,
      size: row.size,
      contentType: row.content_type,
      hasPickupCode: Boolean(row.pickup_code_hash),
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      expired: isExpired(row)
    }
  });
});

app.delete("/api/files/:id", requireAuth, requireCsrf, rateLimit("delete", 60, 60 * 1000), async (req, res) => {
  const row = get("SELECT * FROM files WHERE id = ?", [Number(req.params.id)]);
  if (!row) {
    res.status(404).json({ ok: false, error: "File not found" });
    return;
  }

  try {
    await deleteOssObject(row.oss_key);
    run("DELETE FROM files WHERE id = ?", [row.id]);
    res.json({ ok: true });
  } catch (error) {
    console.error("Delete failed:", error);
    res.status(502).json({ ok: false, error: "Failed to delete file" });
  }
});

app.post("/api/pickup", rateLimit("pickup", 40, 60 * 1000), (req, res) => {
  const pickupCode = String(req.body.pickupCode || "").trim();
  if (!pickupCode) {
    res.status(400).json({ ok: false, error: "Please enter a pickup code" });
    return;
  }

  const rows = all(
    "SELECT * FROM files WHERE storage_type = ? ORDER BY created_at DESC LIMIT 300",
    ["temporary"]
  );
  const row = rows.find((item) => verifySecret(pickupCode, item.pickup_code_hash));

  if (!row) {
    res.status(404).json({ ok: false, error: "Pickup code is invalid" });
    return;
  }

  if (isExpired(row)) {
    res.status(410).json({ ok: false, error: "File has expired" });
    return;
  }

  const token = createToken({ type: "pickup", fileId: row.id }, 15 * 60);
  res.json({
    ok: true,
    file: {
      id: row.id,
      originalName: row.original_name,
      size: row.size,
      contentType: row.content_type,
      expiresAt: row.expires_at,
      downloadUrl: `/api/pickup/${encodeURIComponent(token)}/download`
    }
  });
});

app.get("/api/pickup/:token/download", rateLimit("pickup-download", 120, 60 * 1000), async (req, res) => {
  const payload = readToken(req.params.token);
  if (!payload || payload.type !== "pickup") {
    res.status(403).type("text/plain; charset=utf-8").send("Pickup link is invalid or expired");
    return;
  }

  const row = get("SELECT * FROM files WHERE id = ?", [Number(payload.fileId)]);
  if (!row || row.storage_type !== "temporary") {
    res.status(404).type("text/plain; charset=utf-8").send("File not found");
    return;
  }

  if (isExpired(row)) {
    res.status(410).type("text/plain; charset=utf-8").send("File has expired");
    return;
  }

  await streamOssObjectByKey(row.oss_key, req, res, {
    fileName: row.original_name,
    disposition: "attachment"
  });
});

app.post("/api/oss", requireAuth, requireCsrf, rateLimit("oss-proxy", 120, 60 * 1000), (req, res) => {
  const key = String(req.body.key || "");
  const validationError = validateOssProxyKey(key);
  if (validationError) {
    res.status(400).json({ ok: false, error: validationError });
    return;
  }
  streamOssObjectByKey(key, req, res);
});

app.head("/api/oss", requireAuth, rateLimit("oss-proxy", 120, 60 * 1000), (req, res) => {
  const key = String(req.query.key || "");
  const validationError = validateOssProxyKey(key);
  if (validationError) {
    res.status(400).json({ ok: false, error: validationError });
    return;
  }
  streamOssObjectByKey(key, req, res);
});

const distDir = path.join(__dirname, "dist");

app.use((req, res, next) => {
  const normalizedPath = path.normalize(req.path);
  if (normalizedPath.startsWith("/data/") || normalizedPath.includes("\0")) {
    res.status(403).json({ ok: false, error: "Forbidden" });
    return;
  }
  next();
});

app.use(express.static(distDir, {
  etag: true,
  maxAge: "30s"
}));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    next();
    return;
  }
  res.sendFile(path.join(distDir, "index.html"));
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ ok: false, error: "Internal server error" });
});

await initDb();

if (!process.env.CLOUD_DISK_SESSION_SECRET) {
  console.warn("\n  ⚠  CLOUD_DISK_SESSION_SECRET not set. Session tokens will be invalidated on restart.\n     Set this env var in PM2 for persistent sessions.\n");
}

if (!process.env.CLOUD_DISK_INITIAL_PASSWORD) {
  const isFirstRun = !get("SELECT value FROM settings WHERE key = ?", ["password_hash"]);
  if (isFirstRun) {
    console.log(`\n  ⚠  No CLOUD_DISK_INITIAL_PASSWORD set. Generated random password:\n     ${initialPassword}\n     Change it immediately after first login.\n`);
  }
}

app.listen(port, "127.0.0.1", () => {
  console.log(`Cloud disk listening on http://127.0.0.1:${port}`);
});
