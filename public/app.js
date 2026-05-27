const form = document.querySelector("#readerForm");
const input = document.querySelector("#objectKey");
const statusBox = document.querySelector("#status");
const textOutput = document.querySelector("#textOutput");
const imagePreview = document.querySelector("#imagePreview");
const quickButtons = document.querySelectorAll("[data-key]");
const uploadForm = document.querySelector("#uploadForm");
const fileInput = document.querySelector("#fileInput");
const uploadStatus = document.querySelector("#uploadStatus");
const uploadOutput = document.querySelector("#uploadOutput");

function basePath() {
  return window.location.pathname.endsWith("/")
    ? window.location.pathname
    : window.location.pathname.replace(/[^/]*$/, "");
}

function apiUrl(key) {
  return `${basePath()}api/oss?key=${encodeURIComponent(key)}`;
}

function uploadUrl() {
  return `${basePath()}api/upload`;
}

function setStatus(element, message, isError = false) {
  element.textContent = message;
  element.style.color = isError ? "#b42318" : "#147a4d";
}

function resetOutput() {
  textOutput.style.display = "none";
  imagePreview.style.display = "none";
  textOutput.textContent = "";
  imagePreview.removeAttribute("src");
}

async function loadObject(key) {
  resetOutput();
  setStatus(statusBox, "正在通过服务器读取 OSS 内网 Endpoint...");

  const response = await fetch(apiUrl(key), { cache: "no-store" });
  const contentType = response.headers.get("content-type") || "";

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `HTTP ${response.status}`);
  }

  if (contentType.startsWith("image/")) {
    imagePreview.src = `${apiUrl(key)}&t=${Date.now()}`;
    imagePreview.style.display = "block";
    setStatus(statusBox, `图片读取成功：${key}`);
    return;
  }

  const text = await response.text();
  textOutput.textContent = text;
  textOutput.style.display = "block";
  setStatus(statusBox, `文本读取成功：${key}`);
}

async function uploadFile() {
  const file = fileInput.files[0];

  if (!file) {
    throw new Error("请先选择一个文件");
  }

  uploadOutput.style.display = "none";
  uploadOutput.textContent = "";
  setStatus(uploadStatus, "正在上传到服务器，再由服务器走 OSS 内网上传...");

  const body = new FormData();
  body.append("file", file);

  const response = await fetch(uploadUrl(), {
    method: "POST",
    body,
    cache: "no-store"
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.ok) {
    throw new Error(result.error || `HTTP ${response.status}`);
  }

  uploadOutput.textContent = JSON.stringify(result, null, 2);
  uploadOutput.style.display = "block";
  input.value = result.key;
  setStatus(uploadStatus, `上传成功：${result.key}`);
  await loadObject(result.key);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const key = input.value.trim();

  try {
    await loadObject(key);
  } catch (error) {
    resetOutput();
    setStatus(statusBox, error.message, true);
  }
});

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    await uploadFile();
  } catch (error) {
    setStatus(uploadStatus, error.message, true);
  }
});

quickButtons.forEach((button) => {
  button.addEventListener("click", () => {
    input.value = button.dataset.key;
    form.requestSubmit();
  });
});

form.requestSubmit();
