const API = "";

const urlInput = document.getElementById("urlInput");
const fetchBtn = document.getElementById("fetchBtn");
const downloadBtn = document.getElementById("downloadBtn");
const result = document.getElementById("result");
const statusBox = document.getElementById("status");
const formatSelect = document.getElementById("formatSelect");
const sourceSelect = document.getElementById("sourceSelect");
const directPanel = document.getElementById("directPanel");
const convertPanel = document.getElementById("convertPanel");
const methodHint = document.getElementById("methodHint");
const conversionHint = document.getElementById("conversionHint");
const changeFolderBtn = document.getElementById("changeFolderBtn");
const saveLocation = document.getElementById("saveLocation");
const progressPanel = document.getElementById("progressPanel");
const progressBar = document.getElementById("progressBar");
const progressPercent = document.getElementById("progressPercent");
const progressStage = document.getElementById("progressStage");
const progressTransferred = document.getElementById("progressTransferred");
const progressSpeed = document.getElementById("progressSpeed");
const progressEta = document.getElementById("progressEta");
const themeToggle = document.getElementById("themeToggle");
const themeIcon = document.getElementById("themeIcon");
const themeText = document.getElementById("themeText");

let currentUrl = "";
let currentFormats = [];
let currentSaveDir = "";
let progressTimer = null;

function status(message, type = "") {
  statusBox.textContent = message;
  statusBox.className = `status mt-3 ${type}`;
  statusBox.classList.remove("d-none");
}

function formatDuration(seconds) {
  if (!seconds) return "Duration unavailable";
  const s = Number(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h
    ? `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`
    : `${m}:${String(sec).padStart(2,"0")}`;
}

function formatBytes(bytes) {
  if (!bytes) return "0 MB";
  const mb = bytes / 1024 / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function formatSpeed(bytesPerSecond) {
  if (!bytesPerSecond) return "—";
  const mbps = bytesPerSecond / 1024 / 1024;
  return mbps < 1
    ? `${(bytesPerSecond / 1024).toFixed(0)} KB/s`
    : `${mbps.toFixed(1)} MB/s`;
}

function formatEta(seconds) {
  if (seconds === null || seconds === undefined) return "ETA —";
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `ETA ${m ? `${m}m ` : ""}${sec}s`;
}

function resetProgress() {
  progressPanel.classList.remove("d-none");
  progressBar.style.width = "0%";
  progressPercent.textContent = "0%";
  progressStage.textContent = "Preparing…";
  progressTransferred.textContent = "0 MB";
  progressSpeed.textContent = "—";
  progressEta.textContent = "ETA —";
  progressBar.classList.remove("indeterminate");
}

function renderProgress(job) {
  const pct = Math.max(0, Math.min(100, Number(job.progress || 0)));
  progressBar.style.width = `${pct}%`;
  progressPercent.textContent = `${Math.round(pct)}%`;
  progressStage.textContent = job.stage || "Working…";
  progressTransferred.textContent = job.total
    ? `${formatBytes(job.downloaded)} / ${formatBytes(job.total)}`
    : formatBytes(job.downloaded);
  progressSpeed.textContent = formatSpeed(job.speed);
  progressEta.textContent = formatEta(job.eta);
  progressBar.classList.toggle(
    "indeterminate",
    job.status === "converting" || job.status === "finalizing"
  );
}

function setMethod(method) {
  const direct = method === "direct";

  document.querySelectorAll('input[name="downloadMode"]').forEach(input => {
    const option = input.closest(".method-option");
    if (option) option.classList.toggle("active", input.value === method && input.checked);
  });

  directPanel.classList.toggle("d-none", !direct);
  convertPanel.classList.toggle("d-none", direct);

  if (methodHint) {
    methodHint.textContent = direct
      ? "Direct source = no conversion"
      : "FFmpeg is used only for conversion";
  }

  downloadBtn.innerHTML = direct
    ? "<span>↓</span> Download Selected Media"
    : "<span>↻</span> Convert & Download";

  updateConversionHint();
}

function getDownloadMode() {
  return document.querySelector('input[name="downloadMode"]:checked')?.value || "direct";
}

function getSelectedSourceId() {
  return document.querySelector('input[name="sourceFormat"]:checked')?.value || "";
}

function updateConversionHint() {
  if (!conversionHint || !formatSelect) return;

  const target = formatSelect.value;
  const available = currentFormats.some(
    f => String(f.ext || "").toLowerCase() === target
  );

  conversionHint.textContent = available
    ? `${target.toUpperCase()} is available directly above. You can use Direct Download to avoid conversion.`
    : `${target.toUpperCase()} is not available as a direct source. Convert mode will use FFmpeg.`;
}

function renderSourceFormats(formats) {
  sourceSelect.innerHTML = "";

  if (!formats.length) {
    sourceSelect.innerHTML =
      '<div class="format-empty">No directly downloadable formats were reported for this video.</div>';
    return;
  }

  formats.forEach((f, index) => {
    const wrap = document.createElement("div");
    wrap.className = "format-radio";

    const id = `source-format-${index}`;

    const input = document.createElement("input");
    input.type = "radio";
    input.name = "sourceFormat";
    input.id = id;
    input.value = String(f.id);
    input.checked = index === 0;
    input.setAttribute("aria-label", f.label || `Format ${f.id}`);

    const label = document.createElement("label");
    label.htmlFor = id;

    const copy = document.createElement("span");
    copy.className = "format-copy";

    const strong = document.createElement("strong");
    strong.textContent = f.label || `Format ${f.id}`;

    const kind = document.createElement("span");
    kind.className = `format-kind ${f.kind || ""}`;
    kind.textContent = (f.kind || "source").replace("-", " ");

    const small = document.createElement("small");
    const details = [];
    if (f.filesize) details.push(formatBytes(f.filesize));
    if (f.vcodec && f.vcodec !== "none") details.push(`video ${f.vcodec}`);
    if (f.acodec && f.acodec !== "none") details.push(`audio ${f.acodec}`);
    if (!details.length) details.push("direct source");

    small.textContent = details.join(" • ");

    strong.appendChild(kind);
    copy.append(strong, small);
    label.append(input, copy);
    wrap.appendChild(label);
    sourceSelect.appendChild(wrap);
  });
}

async function pollProgress(jobId) {
  if (progressTimer) clearInterval(progressTimer);

  const poll = async () => {
    try {
      const res = await fetch(`${API}/api/progress/${jobId}`, { cache: "no-store" });
      const job = await res.json();

      if (!res.ok) throw new Error(job.detail || "Could not read download progress.");

      renderProgress(job);

      if (job.status === "completed") {
        clearInterval(progressTimer);
        progressTimer = null;
        progressBar.classList.remove("indeterminate");
        progressBar.style.width = "100%";
        progressPercent.textContent = "100%";
        status(`Completed: ${job.title || "Download"} — saved to ${job.folder}.`, "success");
        downloadBtn.disabled = false;
        setMethod(getDownloadMode());
      } else if (job.status === "error") {
        clearInterval(progressTimer);
        progressTimer = null;
        status(job.error || "Download failed.", "error");
        downloadBtn.disabled = false;
        setMethod(getDownloadMode());
      }
    } catch (err) {
      clearInterval(progressTimer);
      progressTimer = null;
      status(err.message, "error");
      downloadBtn.disabled = false;
      setMethod(getDownloadMode());
    }
  };

  await poll();
  if (!progressTimer) progressTimer = setInterval(poll, 500);
}

fetchBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) return status("Please paste a YouTube URL.", "error");

  fetchBtn.disabled = true;
  fetchBtn.innerHTML = "Fetching…";
  result.classList.add("d-none");
  progressPanel.classList.add("d-none");
  status("Fetching video information…");

  try {
    const res = await fetch(`${API}/api/info`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ url })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Could not fetch video.");

    currentUrl = url;
    currentFormats = Array.isArray(data.formats) ? data.formats : [];

    document.getElementById("title").textContent = data.title || "Untitled";
    document.getElementById("thumbnail").src = data.thumbnail || "";
    document.getElementById("meta").textContent =
      `${data.channel || "Unknown channel"} • ${formatDuration(data.duration)}`;

    renderSourceFormats(currentFormats);
    setMethod("direct");
    result.classList.remove("d-none");

    status(
      "Video found. Choose a visible source format for direct download, or switch to Convert for MP3 / M4A / MP4 output.",
      "success"
    );

    document.getElementById("downloader").scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  } catch (err) {
    status(err.message, "error");
  } finally {
    fetchBtn.disabled = false;
    fetchBtn.innerHTML = 'Fetch Details <span>→</span>';
  }
});

document.querySelectorAll('input[name="downloadMode"]').forEach(input => {
  input.addEventListener("change", () => setMethod(input.value));
});

formatSelect.addEventListener("change", updateConversionHint);

downloadBtn.addEventListener("click", async () => {
  if (!currentUrl) {
    status("Fetch a video first.", "error");
    return;
  }

  const mode = getDownloadMode();
  const formatId = getSelectedSourceId();

  if (mode === "direct" && !formatId) {
    status("Please select an available source format first.", "error");
    return;
  }

  if (!currentSaveDir) {
    await loadSaveLocation();
  }

  downloadBtn.disabled = true;
  downloadBtn.innerHTML =
    '<span class="spinner-border spinner-border-sm me-2"></span>Starting…';
  resetProgress();
  status(mode === "direct" ? "Starting direct download…" : "Starting conversion…");

  try {
    const payload = {
      url: currentUrl,
      mode,
      format_id: mode === "direct" ? formatId : null,
      target_format: mode === "convert" ? formatSelect.value : null,
      save_dir: currentSaveDir
    };

    const res = await fetch(`${API}/api/download`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Download could not be started.");

    downloadBtn.innerHTML =
      '<span class="spinner-border spinner-border-sm me-2"></span>Downloading…';

    await pollProgress(data.job_id);
  } catch (err) {
    status(err.message, "error");
    downloadBtn.disabled = false;
    setMethod(mode);
  }
});

changeFolderBtn.addEventListener("click", async () => {
  changeFolderBtn.disabled = true;
  changeFolderBtn.textContent = "Opening…";

  try {
    const res = await fetch(`${API}/api/select-folder`, {
      method: "POST",
      cache: "no-store"
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.detail || "Could not open the folder picker.");

    if (!data.cancelled && data.folder) {
      currentSaveDir = data.folder;
      saveLocation.textContent = currentSaveDir;
      status(`Save location changed to ${currentSaveDir}.`, "success");
    }
  } catch (err) {
    status(err.message, "error");
  } finally {
    changeFolderBtn.disabled = false;
    changeFolderBtn.textContent = "Change folder";
  }
});

async function loadSaveLocation() {
  try {
    const res = await fetch(`${API}/api/health`, { cache: "no-store" });
    const data = await res.json();

    if (res.ok && data.save_dir) {
      currentSaveDir = data.save_dir;
      saveLocation.textContent = currentSaveDir;
    }
  } catch (_) {
    // Backend health is retried when the user starts a download.
  }
}

urlInput.addEventListener("keydown", e => {
  if (e.key === "Enter") fetchBtn.click();
});

function applyTheme(theme) {
  const light = theme === "light";
  document.body.classList.toggle("light-theme", light);

  if (themeIcon) themeIcon.textContent = light ? "☀" : "☾";
  if (themeText) themeText.textContent = light ? "Light" : "Dark";

  localStorage.setItem("nexdownload-theme", light ? "light" : "dark");
}

if (themeToggle) {
  themeToggle.addEventListener("click", () => {
    applyTheme(document.body.classList.contains("light-theme") ? "dark" : "light");
  });
}

applyTheme(localStorage.getItem("nexdownload-theme") || "dark");
setMethod("direct");
loadSaveLocation();
