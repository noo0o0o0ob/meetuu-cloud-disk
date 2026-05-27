<script setup lang="ts">
import { computed, onMounted, ref, nextTick, type Directive } from "vue";
import gsap from "gsap";

const GLITCH_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";

const vDecrypt: Directive<HTMLElement> = {
  mounted(el, binding) {
    const finalText = binding.value ?? el.textContent ?? "";
    const chars = [...finalText];
    const totalDuration = binding.arg === "slow" ? 3000 : 2400;
    const startTime = performance.now();

    function randomChar() {
      return GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)];
    }

    function frame(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / totalDuration, 1);
      const revealCount = Math.floor(progress * chars.length);
      let result = "";
      for (let i = 0; i < chars.length; i++) {
        result += i < revealCount ? chars[i] : randomChar();
      }
      el.textContent = result;
      if (progress < 1) {
        requestAnimationFrame(frame);
      }
    }

    el.textContent = chars.map(() => randomChar()).join("");
    requestAnimationFrame(frame);
  }
};

type CloudFile = {
  id: number;
  storageType: string;
  originalName: string;
  size: number;
  contentType: string;
  expiresAt: string | null;
  createdAt: string;
  openUrl: string;
  downloadUrl: string;
};

type PickupFile = {
  id: number;
  originalName: string;
  size: number;
  contentType: string;
  expiresAt: string | null;
  downloadUrl: string;
};

type FileDetail = {
  id: number;
  storageType: string;
  originalName: string;
  ossKey: string;
  size: number;
  contentType: string;
  hasPickupCode: boolean;
  expiresAt: string | null;
  createdAt: string;
  expired: boolean;
};

const loggedIn = ref(false);
const password = ref("");
const loginError = ref("");
const sessionOnly = ref(false);
const showLoginModeModal = ref(false);
const notice = ref("");
const noticeType = ref<"info" | "error" | "success">("info");
const uploadBusy = ref(false);
const uploadProgress = ref(0);
const deletingId = ref<number | null>(null);
const confirmTarget = ref<CloudFile | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const selectedFile = ref<File | null>(null);
const storageType = ref<"permanent" | "temporary">("permanent");
const pickupCode = ref("");
const expiresInHours = ref(24);
const files = ref<CloudFile[]>([]);
const pickupInput = ref("");
const pickupFile = ref<PickupFile | null>(null);
const settingsOpen = ref(false);
const currentPassword = ref("");
const newPassword = ref("");
const confirmPassword = ref("");
const maxUploadBytes = ref(20 * 1024 * 1024);
const chunkSizeBytes = ref(5 * 1024 * 1024);
const chunkedUploadThreshold = ref(20 * 1024 * 1024);
const headerRef = ref<HTMLElement | null>(null);
const loginScreenRef = ref<HTMLElement | null>(null);
const uploadCardRef = ref<HTMLElement | null>(null);
const pickupCardRef = ref<HTMLElement | null>(null);
const statusCardRef = ref<HTMLElement | null>(null);
const filesCardRef = ref<HTMLElement | null>(null);
const fileRowsRef = ref<HTMLElement[]>([]);
const isDark = ref(false);
const searchQuery = ref("");
const categoryFilter = ref<"all" | "cloud" | "temp">("all");
const loginMode = ref<"cloud" | "pickup">("cloud");
const pickupLoginCode = ref("");
const pickupLoginFile = ref<PickupFile | null>(null);
const pickupLoginBusy = ref(false);
const pickupLoginError = ref("");
const detailFile = ref<FileDetail | null>(null);
const detailLoading = ref(false);
const openMenuId = ref<number | null>(null);

const maxUploadText = computed(() => formatBytes(maxUploadBytes.value));
const permanentFiles = computed(() => files.value);
const selectedFileLabel = computed(() => selectedFile.value?.name || "点击选择文件");
const selectedFileMeta = computed(() => {
  if (!selectedFile.value) {
    return `最大 ${maxUploadText.value}，文件经服务器内网上传到 OSS`;
  }
  return `${formatBytes(selectedFile.value.size)} · ${selectedFile.value.type || "未知类型"}`;
});

const filteredFiles = computed(() => {
  let result = permanentFiles.value;
  
  result = result.filter(f => {
    if (f.storageType === "temporary" && f.expiresAt && new Date(f.expiresAt).getTime() < now.value) {
      return false;
    }
    return true;
  });
  
  if (categoryFilter.value === "cloud") {
    result = result.filter(f => f.storageType === "permanent");
  } else if (categoryFilter.value === "temp") {
    result = result.filter(f => f.storageType === "temporary");
  }
  
  if (searchQuery.value.trim()) {
    const query = searchQuery.value.toLowerCase().trim();
    result = result.filter(f => 
      f.originalName.toLowerCase().includes(query)
    );
  }
  
  return result;
});

function toggleTheme() {
  const next = !isDark.value;
  applyTheme(next);
  localStorage.setItem("theme", next ? "dark" : "light");
}

function isBeijingNight(): boolean {
  const hour = Number(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai", hour: "numeric", hour12: false }));
  return hour >= 18 || hour < 6;
}

function applyTheme(dark: boolean) {
  isDark.value = dark;
  document.documentElement.classList.toggle("dark", dark);
}

function initTheme() {
  const saved = localStorage.getItem("theme");
  if (saved === "dark" || saved === "light") {
    applyTheme(saved === "dark");
    return;
  }
  applyTheme(isBeijingNight());
  setInterval(() => applyTheme(isBeijingNight()), 60_000);
}

function getCsrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const hasBody = Boolean(options.body);
  const method = (options.method || "GET").toUpperCase();
  const headers: Record<string, string> = hasBody ? {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> || {})
  } : { ...(options.headers as Record<string, string> || {}) };

  if (method === "POST" || method === "DELETE") {
    headers["X-CSRF-Token"] = getCsrfToken();
  }

  const response = await fetch(path, {
    credentials: "include",
    cache: "no-store",
    headers,
    ...options
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok || result.ok === false) {
    throw new Error(result.error || `HTTP ${response.status}`);
  }

  return result as T;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function sameOriginDownloadUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl, window.location.origin);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return rawUrl;
  }
}

function formatTime(value: string | null) {
  if (!value) return "永久保存";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function shortTime(value: string | null) {
  if (!value) return "永久";
  return new Date(value).toLocaleDateString("zh-CN");
}

function showNotice(message: string, type: "info" | "error" | "success" = "info") {
  notice.value = message;
  noticeType.value = type;
}

function fileExtension(fileName: string) {
  const index = fileName.lastIndexOf(".");
  return index >= 0 ? fileName.slice(index + 1).toLowerCase() : "";
}

function fileKind(file: CloudFile) {
  const ext = fileExtension(file.originalName);
  const contentType = file.contentType.toLowerCase();

  if (["exe", "msi", "apk", "dmg", "pkg", "deb", "rpm"].includes(ext)) return "软件";
  if (["doc", "docx"].includes(ext)) return "Word 文档";
  if (["xls", "xlsx", "csv"].includes(ext)) return "表格文件";
  if (["ppt", "pptx", "key"].includes(ext)) return "演示文稿";
  if (["pdf"].includes(ext)) return "PDF";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "压缩包";
  if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic"].includes(ext)) return "图片";
  if (["mp4", "mov", "mkv", "avi", "webm", "flv"].includes(ext)) return "视频";
  if (["mp3", "wav", "flac", "aac", "ogg", "m4a"].includes(ext)) return "音频";
  if (["txt", "md", "log"].includes(ext)) return "文本文件";
  if (["js", "ts", "tsx", "jsx", "vue", "html", "css", "json", "xml", "py", "java", "go", "rs", "php", "c", "cpp", "h"].includes(ext)) return "代码文件";

  if (contentType.startsWith("image/")) return "图片";
  if (contentType.startsWith("video/")) return "视频";
  if (contentType.startsWith("audio/")) return "音频";
  if (contentType.includes("pdf")) return "PDF";
  if (contentType.includes("word") || contentType.includes("document")) return "Word 文档";
  if (contentType.includes("excel") || contentType.includes("spreadsheet")) return "表格文件";
  if (contentType.includes("powerpoint") || contentType.includes("presentation")) return "演示文稿";
  if (contentType.includes("zip") || contentType.includes("rar") || contentType.includes("tar")) return "压缩包";
  return "文件";
}

const dragging = ref(false);
let dragCounter = 0;

function handleFileChange(event: Event) {
  const target = event.target as HTMLInputElement;
  selectedFile.value = target.files?.[0] || null;
}

function onDragEnter(e: DragEvent) {
  e.preventDefault();
  dragCounter++;
  dragging.value = true;
}

function onDragOver(e: DragEvent) {
  e.preventDefault();
}

function onDragLeave(e: DragEvent) {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    dragging.value = false;
  }
}

function onDrop(e: DragEvent) {
  e.preventDefault();
  dragCounter = 0;
  dragging.value = false;
  const file = e.dataTransfer?.files?.[0];
  if (file) {
    selectedFile.value = file;
  }
}

async function loadConfig() {
  const result = await requestJson<{ 
    loggedIn: boolean; 
    maxUploadBytes: number; 
    chunkSizeBytes: number; 
    chunkedUploadThreshold: number;
  }>("/api/config");
  loggedIn.value = result.loggedIn;
  maxUploadBytes.value = result.maxUploadBytes;
  if (result.chunkSizeBytes) chunkSizeBytes.value = result.chunkSizeBytes;
  if (result.chunkedUploadThreshold) chunkedUploadThreshold.value = result.chunkedUploadThreshold;
  if (loggedIn.value) await loadFiles();
}

async function uploadChunked(file: File) {
  // Initialize multipart upload
  const initResult = await requestJson<{
    ok: true;
    uploadId: string;
    objectKey: string;
    storageType: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    pickupCode: string | null;
    pickupCodeHash: string | null;
    expiresAt: string | null;
  }>("/api/files/upload/init", {
    method: "POST",
    body: JSON.stringify({
      storageType: storageType.value,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type || "application/octet-stream",
      pickupCode: pickupCode.value.trim(),
      expiresInHours: expiresInHours.value
    })
  });

  const { uploadId, objectKey, storageType: savedStorageType, fileName, fileSize, mimeType, pickupCode: savedPickupCode, pickupCodeHash, expiresAt } = initResult;

  const totalChunks = Math.ceil(file.size / chunkSizeBytes.value);
  let uploadedChunks = 0;
  const partETags: { number: number; etag: string }[] = [];
  const concurrency = 4; // 4 concurrent threads
  let currentPart = 0;

  // Worker function to upload chunks
  async function uploadNextChunk(): Promise<void> {
    while (currentPart < totalChunks) {
      const partNumber = currentPart + 1;
      currentPart++;
      
      const start = (partNumber - 1) * chunkSizeBytes.value;
      const end = Math.min(start + chunkSizeBytes.value, file.size);
      const chunk = file.slice(start, end);
      
      const formData = new FormData();
      formData.append("chunk", chunk);
      formData.append("uploadId", uploadId);
      formData.append("objectKey", objectKey);
      formData.append("partNumber", String(partNumber));
      
      const response = await fetch("/api/files/upload/part", {
        method: "POST",
        body: formData,
        credentials: "include",
        cache: "no-store",
        headers: {
          "X-CSRF-Token": getCsrfToken()
        }
      });
      
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        throw new Error(result.error || `Failed to upload part ${partNumber}`);
      }
      
      partETags.push({ number: partNumber, etag: result.etag });
      uploadedChunks++;
      uploadProgress.value = Math.round((uploadedChunks / totalChunks) * 90); // 90% for chunks, 10% for complete
    }
  }

  // Start concurrent uploads
  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(uploadNextChunk());
  }
  await Promise.all(workers);

  // Sort partETags by partNumber
  partETags.sort((a, b) => a.partNumber - b.partNumber);

  // Complete the upload
  const completeResult = await requestJson<{ ok: true; file: CloudFile }>("/api/files/upload/complete", {
    method: "POST",
    body: JSON.stringify({
      uploadId,
      objectKey,
      partETags,
      storageType: savedStorageType,
      fileName,
      fileSize,
      mimeType,
      pickupCode: savedPickupCode,
      pickupCodeHash,
      expiresAt
    })
  });

  uploadProgress.value = 100;
  
  return completeResult.file;
}

function showLoginModal() {
  if (!password.value.trim()) {
    loginError.value = "请输入密码";
    return;
  }
  loginError.value = "";
  showLoginModeModal.value = true;
}

function closeLoginModeModal() {
  showLoginModeModal.value = false;
}

async function loginWithMode(isPublic: boolean) {
  showLoginModeModal.value = false;
  sessionOnly.value = isPublic;
  loginError.value = "";
  try {
    await requestJson("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password: password.value, session: isPublic })
    });
    password.value = "";
    loggedIn.value = true;
    await loadFiles();
    await nextTick();
    animateEntrance();
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : "登录失败";
  }
}

async function logout() {
  await requestJson("/api/auth/logout", { method: "POST", body: "{}" });
  loggedIn.value = false;
  files.value = [];
  pickupFile.value = null;
}

async function uploadFile() {
  if (!selectedFile.value) {
    showNotice("请先选择一个文件", "error");
    return;
  }

  if (storageType.value === "temporary" && pickupCode.value.trim().length < 2) {
    showNotice("临时存储需要填写至少 2 位提取码", "error");
    return;
  }

  uploadBusy.value = true;
  uploadProgress.value = 0;
  
  try {
    if (selectedFile.value.size > chunkedUploadThreshold.value) {
      // Use chunked upload for large files
      showNotice(`文件较大 (${formatBytes(selectedFile.value.size)})，采用分片多线程上传...`, "info");
      await uploadChunked(selectedFile.value);
    } else {
      // Use original single upload for small files
      showNotice("正在上传，服务器会通过 OSS 内网写入文件...", "info");
      const form = new FormData();
      form.append("file", selectedFile.value);
      form.append("storageType", storageType.value);
      form.append("pickupCode", pickupCode.value.trim());
      form.append("expiresInHours", String(expiresInHours.value));

      const response = await fetch("/api/files/upload", {
        method: "POST",
        body: form,
        credentials: "include",
        cache: "no-store",
        headers: {
          "X-CSRF-Token": getCsrfToken()
        }
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        throw new Error(result.error || `HTTP ${response.status}`);
      }
    }

    showNotice(
      storageType.value === "temporary"
        ? `临时文件已上传，提取码：${pickupCode.value.trim()}`
        : "云端文件已上传，可在文件列表中打开或下载",
      "success"
    );

    selectedFile.value = null;
    pickupCode.value = "";
    if (fileInput.value) fileInput.value.value = "";
    await loadFiles();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "上传失败", "error");
  } finally {
    uploadBusy.value = false;
    uploadProgress.value = 0;
  }
}

async function loadFiles() {
  const result = await requestJson<{ files: CloudFile[] }>("/api/files");
  files.value = result.files;
}

function openDeleteConfirm(file: CloudFile) {
  confirmTarget.value = file;
}

function closeDeleteConfirm() {
  confirmTarget.value = null;
}

async function confirmDelete() {
  if (!confirmTarget.value) return;
  const file = confirmTarget.value;
  confirmTarget.value = null;

  deletingId.value = file.id;
  try {
    await requestJson(`/api/files/${file.id}`, { method: "DELETE" });
    files.value = files.value.filter((item) => item.id !== file.id);
    showNotice(`已删除：${file.originalName}`, "success");
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "删除失败", "error");
  } finally {
    deletingId.value = null;
  }
}

async function pickup() {
  pickupFile.value = null;
  try {
    const result = await requestJson<{ file: PickupFile }>("/api/pickup", {
      method: "POST",
      body: JSON.stringify({ pickupCode: pickupInput.value.trim() })
    });
    pickupFile.value = result.file;
    showNotice("提取成功，可以下载文件", "success");
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "提取失败", "error");
  }
}

async function pickupLogin() {
  pickupLoginError.value = "";
  pickupLoginFile.value = null;
  const code = pickupLoginCode.value.trim();
  if (!code) {
    pickupLoginError.value = "请输入提取码";
    return;
  }
  pickupLoginBusy.value = true;
  try {
    const result = await requestJson<{ file: PickupFile }>("/api/pickup", {
      method: "POST",
      body: JSON.stringify({ pickupCode: code })
    });
    pickupLoginFile.value = result.file;
  } catch (error) {
    pickupLoginError.value = error instanceof Error ? error.message : "提取失败";
  } finally {
    pickupLoginBusy.value = false;
  }
}

async function loadFileDetail(fileId: number) {
  detailLoading.value = true;
  detailFile.value = null;
  try {
    const result = await requestJson<{ file: FileDetail }>(`/api/files/${fileId}/detail`);
    detailFile.value = result.file;
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "获取详情失败", "error");
  } finally {
    detailLoading.value = false;
  }
}

function openDetail(file: CloudFile) {
  openMenuId.value = null;
  loadFileDetail(file.id);
}

function closeDetail() {
  detailFile.value = null;
}

function toggleMenu(fileId: number) {
  openMenuId.value = openMenuId.value === fileId ? null : fileId;
}

function closeMenu() {
  openMenuId.value = null;
}

function formatTimestamp(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

async function changePassword() {
  try {
    await requestJson("/api/admin/password", {
      method: "POST",
      body: JSON.stringify({
        currentPassword: currentPassword.value,
        newPassword: newPassword.value,
        confirmPassword: confirmPassword.value
      })
    });
    currentPassword.value = "";
    newPassword.value = "";
    confirmPassword.value = "";
    settingsOpen.value = false;
    showNotice("站点密码已修改", "success");
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "修改失败", "error");
  }
}

onMounted(async () => {
  initTheme();
  await loadConfig();
  await nextTick();
  animateEntrance();
  setInterval(() => { now.value = Date.now(); }, 1000);
});

function animateEntrance() {
  const tl = gsap.timeline();
  
  tl.fromTo(headerRef.value, 
    { opacity: 0, y: -20 },
    { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" }
  );
  
  if (loggedIn.value) {
    tl.fromTo(uploadCardRef.value,
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" },
      "-=0.3"
    );
    
    tl.fromTo([pickupCardRef.value, statusCardRef.value],
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.5, stagger: 0.1, ease: "power2.out" },
      "-=0.3"
    );
    
    tl.fromTo(filesCardRef.value,
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" },
      "-=0.2"
    );
  } else {
    tl.fromTo(loginScreenRef.value,
      { opacity: 0, scale: 0.95 },
      { opacity: 1, scale: 1, duration: 0.6, ease: "power2.out" },
      "-=0.2"
    );
  }
}

const now = ref(Date.now());

function countdownText(expiresAt: string | null): string {
  if (!expiresAt) return "";
  const remaining = new Date(expiresAt).getTime() - now.value;
  if (remaining <= 0) return "已过期";
  const d = Math.floor(remaining / 86400000);
  const h = Math.floor((remaining % 86400000) / 3600000);
  const m = Math.floor((remaining % 3600000) / 60000);
  const s = Math.floor((remaining % 60000) / 1000);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}天`);
  if (h > 0) parts.push(`${h}时`);
  if (m > 0) parts.push(`${m}分`);
  parts.push(`${s}秒`);
  return `还有${parts.join("")}后过期`;
}

const SCROLL_SPEED = 40;

function toggleFileNameScroll(event: Event) {
  const target = event.target as HTMLElement;
  if (target.closest("a, button")) return;
  const row = event.currentTarget as HTMLElement;
  const nameEl = row.querySelector(".file-name") as HTMLElement | null;
  if (!nameEl || nameEl.classList.contains("scrolling")) return;
  const overflow = nameEl.scrollWidth - nameEl.clientWidth;
  if (overflow <= 0) return;
  const duration = overflow / SCROLL_SPEED;
  nameEl.style.setProperty("--scroll-distance", `-${overflow}px`);
  nameEl.style.setProperty("--scroll-duration", `${duration}s`);
  nameEl.classList.add("scrolling");
  setTimeout(() => {
    nameEl.classList.remove("scrolling");
    nameEl.style.removeProperty("--scroll-distance");
    nameEl.style.removeProperty("--scroll-duration");
  }, duration * 1000 + 100);
}

function animateModalIn(modal: HTMLElement) {
  gsap.fromTo(modal,
    { opacity: 0, scale: 0.9, y: 20 },
    { opacity: 1, scale: 1, y: 0, duration: 0.3, ease: "power2.out" }
  );
}

function animateModalOut(modal: HTMLElement, onComplete: () => void) {
  gsap.to(modal, {
    opacity: 0,
    scale: 0.95,
    y: -20,
    duration: 0.2,
    ease: "power2.in",
    onComplete
  });
}
</script>

<template>
  <main class="app-shell" @click="closeMenu">
    <header ref="headerRef" class="app-header">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M5 17.5C3.3 16.5 2.25 14.8 2.25 12.75C2.25 9.7 4.7 7.2 7.72 7.08C8.77 4.75 11.12 3.12 13.85 3.12C17.33 3.12 20.2 5.75 20.57 9.13C22.42 9.83 23.75 11.62 23.75 13.72C23.75 16.43 21.55 18.62 18.85 18.62H7.5C6.58 18.62 5.73 18.22 5 17.5Z" />
            <path d="M12 16V9.4M12 9.4L9.6 11.8M12 9.4L14.4 11.8" />
          </svg>
        </div>
        <div>
          <p>oss.meetuu.top</p>
          <h1>Meetuu 云盘</h1>
        </div>
      </div>

      <div v-if="loggedIn" class="header-actions">
        <button class="icon-button" type="button" aria-label="刷新文件" title="刷新文件" @click="loadFiles">
          <svg viewBox="0 0 24 24"><path d="M20 12A8 8 0 1 1 17.66 6.34M20 4v6h-6" /></svg>
        </button>
        <button class="icon-button" type="button" aria-label="设置" title="设置" @click="settingsOpen = true">
          <svg viewBox="0 0 24 24"><path d="M12 15.5A3.5 3.5 0 1 0 12 8.5a3.5 3.5 0 0 0 0 7Z" /><path d="M19.4 15a1.75 1.75 0 0 0 .35 1.93l.05.05a2 2 0 0 1-2.83 2.83l-.05-.05A1.75 1.75 0 0 0 15 19.4a1.75 1.75 0 0 0-1 .55V20a2 2 0 0 1-4 0v-.05a1.75 1.75 0 0 0-1-.55a1.75 1.75 0 0 0-1.93.35l-.05.05a2 2 0 0 1-2.83-2.83l.05-.05A1.75 1.75 0 0 0 4.6 15a1.75 1.75 0 0 0-.55-1H4a2 2 0 0 1 0-4h.05c.23-.4.41-.73.55-1a1.75 1.75 0 0 0-.35-1.93l-.05-.05a2 2 0 1 1 2.83-2.83l.05.05A1.75 1.75 0 0 0 9 4.6c.27-.14.6-.32 1-.55V4a2 2 0 1 1 4 0v.05c.4.23.73.41 1 .55a1.75 1.75 0 0 0 1.93-.35l.05-.05a2 2 0 0 1 2.83 2.83l-.05.05A1.75 1.75 0 0 0 19.4 9c.14.27.32.6.55 1H20a2 2 0 1 1 0 4h-.05c-.23.4-.41.73-.55 1Z" /></svg>
        </button>
        <button class="secondary-button" type="button" @click="logout">退出</button>
      </div>
    </header>

    <section v-if="!loggedIn" ref="loginScreenRef" class="login-screen">
      <div class="login-layout">
        <aside class="login-intro">
          <div class="intro-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M5 17.5C3.3 16.5 2.25 14.8 2.25 12.75C2.25 9.7 4.7 7.2 7.72 7.08C8.77 4.75 11.12 3.12 13.85 3.12C17.33 3.12 20.2 5.75 20.57 9.13C22.42 9.83 23.75 11.62 23.75 13.72C23.75 16.43 21.55 18.62 18.85 18.62H7.5C6.58 18.62 5.73 18.22 5 17.5Z" />
              <path d="M12 16V9.4M12 9.4L9.6 11.8M12 9.4L14.4 11.8" />
            </svg>
          </div>
          <h2 v-decrypt>Meetuu 云盘</h2>
        </aside>

        <div class="login-panel">
          <div class="login-tabs" role="tablist" aria-label="访问方式">
            <button type="button" class="login-tab" :class="{ active: loginMode === 'pickup' }" @click="loginMode = 'pickup'; loginError = ''">
              <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
              <span>
                <span class="bold">提取文件</span>
                <small>输入提取码下载</small>
              </span>
            </button>
            <button type="button" class="login-tab" :class="{ active: loginMode === 'cloud' }" @click="loginMode = 'cloud'; pickupLoginError = ''; pickupLoginFile = null">
              <svg viewBox="0 0 24 24"><path d="M12 15.5A3.5 3.5 0 1 0 12 8.5a3.5 3.5 0 0 0 0 7Z" /><path d="M19.4 15a1.75 1.75 0 0 0 .35 1.93l.05.05a2 2 0 0 1-2.83 2.83l-.05-.05A1.75 1.75 0 0 0 15 19.4a1.75 1.75 0 0 0-1 .55V20a2 2 0 0 1-4 0v-.05a1.75 1.75 0 0 0-1-.55a1.75 1.75 0 0 0-1.93.35l-.05.05a2 2 0 0 1-2.83-2.83l.05-.05A1.75 1.75 0 0 0 4.6 15a1.75 1.75 0 0 0-.55-1H4a2 2 0 0 1 0-4h.05c.23-.4.41-.73.55-1a1.75 1.75 0 0 0-.35-1.93l-.05-.05a2 2 0 1 1 2.83-2.83l.05.05A1.75 1.75 0 0 0 9 4.6c.27-.14.6-.32 1-.55V4a2 2 0 1 1 4 0v.05c.4.23.73.41 1 .55a1.75 1.75 0 0 0 1.93-.35l.05-.05a2 2 0 0 1 2.83 2.83l-.05.05A1.75 1.75 0 0 0 19.4 9c.14.27.32.6.55 1H20a2 2 0 1 1 0 4h-.05c-.23.4-.41.73-.55 1Z" /></svg>
              <span>
                <span class="bold">进入云盘</span>
                <small>站点密码登录</small>
              </span>
            </button>
          </div>

           <div class="login-card">
            <Transition name="list-fade" mode="out-in">
              <div v-if="loginMode === 'cloud'" key="cloud" class="login-body">
                <h2>进入云盘</h2>
                <p>输入站点密码后，可以上传、管理和下载云盘文件。</p>
                <form class="login-form" @submit.prevent="showLoginModal">
                  <label for="password">站点密码</label>
                  <input id="password" v-model="password" type="password" autocomplete="current-password" autofocus>
                  <button class="primary-button" type="submit">登录</button>
                  <span v-if="loginError" class="form-error">{{ loginError }}</span>
                </form>
              </div>
              <div v-else key="pickup" class="login-body">
                <h2>提取文件</h2>
                <p>输入分享者提供的提取码，无需登录即可获取下载链接。</p>
                <form class="login-form" @submit.prevent="pickupLogin">
                  <label for="pickup-code">提取码</label>
                  <input id="pickup-code" v-model="pickupLoginCode" type="text" autocomplete="off" placeholder="请输入提取码" autofocus>
                  <button class="primary-button" type="submit" :disabled="pickupLoginBusy">
                    {{ pickupLoginBusy ? "提取中..." : "获取下载链接" }}
                  </button>
                  <span v-if="pickupLoginError" class="form-error">{{ pickupLoginError }}</span>
                </form>
                <Transition name="slide-down">
                  <div v-if="pickupLoginFile" class="pickup-login-result">
                    <div class="pickup-login-file-info">
                      <svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5" /></svg>
                      <div>
                        <span class="bold">{{ pickupLoginFile.originalName }}</span>
                        <span>{{ formatBytes(pickupLoginFile.size) }} · 到期 {{ formatTime(pickupLoginFile.expiresAt) }}</span>
                      </div>
                    </div>
                    <a class="primary-button pickup-download-btn" :href="sameOriginDownloadUrl(pickupLoginFile.downloadUrl)">下载文件</a>
                  </div>
                </Transition>
              </div>
            </Transition>
          </div>
        </div>
      </div>
    </section>

    <template v-else>
      <section class="hero-grid">
        <form ref="uploadCardRef" class="upload-card" @submit.prevent="uploadFile">
          <div class="section-heading">
            <span class="section-kicker">上传</span>
            <h2>选择文件并保存</h2>
          </div>

          <label
            class="file-picker"
            :class="{ selected: selectedFile, dragging }"
            @dragenter="onDragEnter"
            @dragover="onDragOver"
            @dragleave="onDragLeave"
            @drop="onDrop"
          >
            <input ref="fileInput" type="file" @change="handleFileChange">
            <span class="file-picker-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M12 16V4M12 4 7.5 8.5M12 4l4.5 4.5" /><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></svg>
            </span>
            <span>
              <span class="bold">{{ dragging ? "松开即可上传" : selectedFileLabel }}</span>
              <small>{{ dragging ? "将文件拖放到这里" : selectedFileMeta }}</small>
            </span>
          </label>

          <div class="mode-switch" role="group" aria-label="存储方式">
            <button type="button" :class="{ active: storageType === 'permanent' }" @click="storageType = 'permanent'">
              <span>上传云端</span>
              <span>登录后可打开和下载</span>
            </button>
            <button type="button" :class="{ active: storageType === 'temporary' }" @click="storageType = 'temporary'">
              <span>临时存储</span>
              <span>用提取码分享</span>
            </button>
          </div>

          <Transition name="slide-down">
            <div v-if="storageType === 'temporary'" class="temp-options">
              <label>
                <span>提取码</span>
                <input v-model="pickupCode" type="text" autocomplete="off" placeholder="例如 cloud123">
              </label>
              <label>
                <span>有效期</span>
                <select v-model.number="expiresInHours">
                  <option :value="1">1 小时</option>
                  <option :value="24">24 小时</option>
                  <option :value="72">3 天</option>
                  <option :value="168">7 天</option>
                  <option :value="720">30 天</option>
                </select>
              </label>
            </div>
          </Transition>

          <Transition name="slide-down">
            <div v-if="uploadBusy && uploadProgress > 0" class="upload-progress">
              <div class="progress-bar">
                <div class="progress-fill" :style="{ width: `${uploadProgress}%` }"></div>
              </div>
              <span class="progress-text">{{ uploadProgress }}%</span>
            </div>
          </Transition>

          <button class="primary-button upload-submit" type="submit" :disabled="uploadBusy">
            {{ uploadBusy ? "上传中..." : storageType === "temporary" ? "上传并生成提取码" : "上传到云端" }}
          </button>

          <p v-if="notice" class="notice" :class="noticeType">{{ notice }}</p>
        </form>

        <aside class="side-stack">
          <section ref="pickupCardRef" class="pickup-card">
            <div class="section-heading compact">
              <span class="section-kicker">提取</span>
              <h2>输入提取码</h2>
            </div>
            <form class="pickup-form" @submit.prevent="pickup">
              <input v-model="pickupInput" type="text" placeholder="输入别人给你的提取码" autocomplete="off">
              <button class="primary-button" type="submit">提取</button>
            </form>
            <div v-if="pickupFile" class="pickup-result">
              <div>
                <span class="bold">{{ pickupFile.originalName }}</span>
                <span>{{ formatBytes(pickupFile.size) }} · 到期 {{ formatTime(pickupFile.expiresAt) }}</span>
              </div>
              <a class="secondary-button" :href="sameOriginDownloadUrl(pickupFile.downloadUrl)">下载</a>
            </div>
          </section>

          <section ref="statusCardRef" class="status-card">
            <span>当前模式</span>
            <span class="bold">服务器内网 OSS 代理</span>
            <p>用户下载走服务器公网，服务器读取 OSS 走成都内网 Endpoint。</p>
          </section>


        </aside>
      </section>

      <section ref="filesCardRef" class="files-card">
        <div class="files-toolbar">
          <div>
            <span class="section-kicker">云端文件</span>
            <h2>文件列表 <span class="files-count">({{ filteredFiles.length }})</span></h2>
          </div>
          <div class="files-toolbar-controls">
            <div class="search-box">
              <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
              <input v-model="searchQuery" type="text" placeholder="搜索文件名..." autocomplete="off">
            </div>
            <div class="category-tabs">
              <button type="button" class="category-tab" :class="{ active: categoryFilter === 'all' }" @click="categoryFilter = 'all'">全部</button>
              <button type="button" class="category-tab" :class="{ active: categoryFilter === 'cloud' }" @click="categoryFilter = 'cloud'">云端</button>
              <button type="button" class="category-tab" :class="{ active: categoryFilter === 'temp' }" @click="categoryFilter = 'temp'">临时</button>
            </div>
          </div>
        </div>

        <div v-if="filteredFiles.length === 0" class="empty-state">
          <svg viewBox="0 0 24 24"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z" /></svg>
          <span v-if="searchQuery" class="bold">未找到匹配文件</span>
          <span v-else class="bold">还没有文件</span>
          <span v-if="searchQuery">尝试其他关键词搜索</span>
          <span v-else>上传文件后，会在这里显示</span>
        </div>
        <TransitionGroup v-else name="file-item" tag="div" class="file-list">
          <article v-for="file in filteredFiles" :key="file.id" class="file-row" @click="toggleFileNameScroll">
            <div class="file-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5" /></svg>
            </div>
            <div class="file-main">
              <span class="file-name"><span v-if="file.storageType === 'temporary'" class="temp-tag">临时</span>{{ file.originalName }}</span>
              <span>{{ fileKind(file) }} · {{ formatBytes(file.size) }}<template v-if="file.storageType !== 'temporary'"> · {{ shortTime(file.createdAt) }}</template><template v-if="file.storageType === 'temporary'"> · {{ countdownText(file.expiresAt) }}</template></span>
            </div>
            <div class="file-actions">
              <button class="icon-button detail-btn desktop-only" type="button" title="详情" aria-label="详情" @click.stop="openDetail(file)">
                <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>
              </button>
              <a class="icon-button desktop-only" :href="sameOriginDownloadUrl(file.downloadUrl)" title="下载" aria-label="下载">
                <svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 21h14" /></svg>
              </a>
              <button class="icon-button danger desktop-only" type="button" title="删除" aria-label="删除" :disabled="deletingId === file.id" @click.stop="openDeleteConfirm(file)">
                <svg viewBox="0 0 24 24"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 15H6L5 6" /><path d="M10 11v6M14 11v6" /></svg>
              </button>
              <div class="mobile-menu-wrap mobile-only">
                <button class="icon-button" type="button" title="更多" aria-label="更多" @click.stop="toggleMenu(file.id)">
                  <svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" /></svg>
                </button>
                <Transition name="menu-fade">
                  <div v-if="openMenuId === file.id" class="dropdown-menu">
                    <button type="button" @click.stop="openDetail(file)">
                      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>
                      <span>详情</span>
                    </button>
                    <button type="button" class="danger" :disabled="deletingId === file.id" @click.stop="openDeleteConfirm(file); openMenuId = null">
                      <svg viewBox="0 0 24 24"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 15H6L5 6" /><path d="M10 11v6M14 11v6" /></svg>
                      <span>删除</span>
                    </button>
                  </div>
                </Transition>
              </div>
            </div>
          </article>
        </TransitionGroup>
      </section>

      <Transition name="modal">
        <div v-if="settingsOpen" class="modal-backdrop" @click.self="settingsOpen = false">
          <section class="settings-modal">
            <div class="modal-header">
              <h2>后台设置</h2>
              <button class="icon-button" type="button" aria-label="关闭" @click="settingsOpen = false">
                <svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <form class="settings-form" @submit.prevent="changePassword">
              <label>
                <span>当前密码</span>
                <input v-model="currentPassword" type="password" autocomplete="current-password">
              </label>
              <label>
                <span>新密码</span>
                <input v-model="newPassword" type="password" autocomplete="new-password">
              </label>
              <label>
                <span>确认新密码</span>
                <input v-model="confirmPassword" type="password" autocomplete="new-password">
              </label>
              <div class="modal-actions">
                <button class="secondary-button" type="button" @click="settingsOpen = false">取消</button>
                <button class="primary-button" type="submit">保存密码</button>
              </div>
            </form>
          </section>
        </div>
      </Transition>

      <Transition name="modal">
        <div v-if="confirmTarget" class="modal-backdrop" @click.self="closeDeleteConfirm">
          <section class="confirm-modal">
            <div class="confirm-icon-ring">
              <svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01" /><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /></svg>
            </div>
            <h2>确认删除</h2>
            <p class="confirm-file-name">{{ confirmTarget.originalName }}</p>
            <p class="confirm-desc">文件将从 OSS 和云盘记录中永久移除，此操作无法撤销。</p>
            <div class="modal-actions">
              <button class="secondary-button" type="button" @click="closeDeleteConfirm">取消</button>
              <button class="danger-button" type="button" @click="confirmDelete">确认删除</button>
            </div>
          </section>
        </div>
      </Transition>

      <Transition name="modal">
        <div v-if="detailFile" class="modal-backdrop" @click.self="closeDetail">
          <section class="detail-modal">
            <div class="modal-header">
              <h2>文件详情</h2>
              <button class="icon-button" type="button" aria-label="关闭" @click="closeDetail">
                <svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <div class="detail-body">
              <div class="detail-icon-ring">
                <svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5" /></svg>
              </div>
              <h3 class="detail-filename">{{ detailFile.originalName }}</h3>
              <div class="detail-grid">
                <div class="detail-item">
                  <span class="detail-label">文件 ID</span>
                  <span class="detail-value">{{ detailFile.id }}</span>
                </div>
                <div class="detail-item">
                  <span class="detail-label">存储类型</span>
                  <span class="detail-value">{{ detailFile.storageType === 'permanent' ? '永久云端' : '临时存储' }}</span>
                </div>
                <div class="detail-item">
                  <span class="detail-label">文件大小</span>
                  <span class="detail-value">{{ formatBytes(detailFile.size) }} ({{ detailFile.size.toLocaleString() }} 字节)</span>
                </div>
                <div class="detail-item">
                  <span class="detail-label">MIME 类型</span>
                  <span class="detail-value">{{ detailFile.contentType }}</span>
                </div>
                <div class="detail-item">
                  <span class="detail-label">上传时间</span>
                  <span class="detail-value">{{ formatTimestamp(detailFile.createdAt) }}</span>
                </div>
                <div class="detail-item">
                  <span class="detail-label">过期时间</span>
                  <span class="detail-value" :class="{ 'text-danger': detailFile.expired }">{{ detailFile.expiresAt ? formatTimestamp(detailFile.expiresAt) : '永不过期' }}{{ detailFile.expired ? ' (已过期)' : '' }}</span>
                </div>
                <div class="detail-item">
                  <span class="detail-label">提取码</span>
                  <span class="detail-value">{{ detailFile.hasPickupCode ? '已设置（不显示）' : '无' }}</span>
                </div>
                <div class="detail-item full">
                  <span class="detail-label">OSS 对象键</span>
                  <span class="detail-value detail-mono">{{ detailFile.ossKey }}</span>
                </div>
              </div>
            </div>
            <div class="modal-actions">
              <button class="secondary-button" type="button" @click="closeDetail">关闭</button>
            </div>
          </section>
        </div>
      </Transition>
    </template>

    <Transition name="modal">
      <div v-if="showLoginModeModal" class="modal-backdrop" @click.self="closeLoginModeModal">
        <section class="login-mode-modal">
          <div class="modal-header">
            <h2>请选择登录方式</h2>
            <button class="icon-button" type="button" aria-label="关闭" @click="closeLoginModeModal">
              <svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>
          <div class="login-mode-options">
            <button type="button" class="login-mode-option" @click="loginWithMode(false)">
              <div class="login-mode-icon personal">
                <svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
              </div>
              <div class="login-mode-text">
                <span class="login-mode-title">这是个人设备，我想登录</span>
                <span class="login-mode-desc">云端同步、跨设备联动，方便快捷。</span>
              </div>
            </button>
            <button type="button" class="login-mode-option" @click="loginWithMode(true)">
              <div class="login-mode-icon public">
                <svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
              </div>
              <div class="login-mode-text">
                <span class="login-mode-title">这是公共设备，我不想保存登录状态</span>
                <span class="login-mode-desc">即用即走、无需保存密码，安全省心。</span>
              </div>
            </button>
          </div>
        </section>
      </div>
    </Transition>
  </main>
</template>
