from pathlib import Path
import threading
import traceback
import uuid

import imageio_ffmpeg
import yt_dlp
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ---------------------------------------------------------
# Local Windows app configuration
# ---------------------------------------------------------
BASE_DIR = Path(r"G:\YouTube_MP3")
COOKIE_FILE = BASE_DIR / "youtube_cookies.txt"
DENO_EXE = Path(r"C:\Users\annus\.deno\bin\deno.exe")
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

# Default is the user's normal Windows Downloads folder on C:.
# BASE_DIR is still used for the YouTube cookie file.
DEFAULT_DOWNLOAD_DIR = Path.home() / "Downloads"
DEFAULT_DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Current folder is kept for this running local app session.
current_download_dir = DEFAULT_DOWNLOAD_DIR

app = FastAPI(title="NexDownload • Nexora Media Utility")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

class URLRequest(BaseModel):
    url: str

jobs = {}
jobs_lock = threading.Lock()


def update_job(job_id, **values):
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].update(values)


def base_ydl_options():
    opts = {
        "quiet": True,
        "noplaylist": True,
        "remote_components": ["ejs:github"],
        "ffmpeg_location": imageio_ffmpeg.get_ffmpeg_exe(),
        "js_runtimes": {
            "deno": {"path": str(DENO_EXE)}
        } if DENO_EXE.exists() else {"deno": {}},
    }

    if COOKIE_FILE.exists():
        opts["cookiefile"] = str(COOKIE_FILE)

    return opts


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "deno": DENO_EXE.exists(),
        "cookies": COOKIE_FILE.exists(),
        "default_download_dir": str(DEFAULT_DOWNLOAD_DIR),
        "save_dir": str(current_download_dir),
    }


@app.post("/api/select-folder")
def select_folder():
    global current_download_dir

    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        root.update()

        initial = current_download_dir if current_download_dir.exists() else DEFAULT_DOWNLOAD_DIR

        selected = filedialog.askdirectory(
            title="Choose NexDownload save folder",
            initialdir=str(initial),
            mustexist=True,
        )

        root.destroy()

        if not selected:
            return {"cancelled": True, "folder": str(current_download_dir)}

        current_download_dir = Path(selected)
        return {"cancelled": False, "folder": str(current_download_dir)}

    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Could not open the Windows folder picker: {exc}",
        )


def normalize_format(f):
    fmt_id = f.get("format_id")
    if not fmt_id:
        return None

    vcodec = f.get("vcodec")
    acodec = f.get("acodec")
    has_video = bool(vcodec and vcodec != "none")
    has_audio = bool(acodec and acodec != "none")

    if not has_video and not has_audio:
        return None

    ext = (f.get("ext") or "").lower()
    height = f.get("height")
    fps = f.get("fps")
    abr = f.get("abr")
    filesize = f.get("filesize") or f.get("filesize_approx")

    if has_video:
        kind = "video" if has_audio else "video-only"
        label = f"{height or '?'}p {ext.upper()}"
        if fps:
            label += f" • {int(fps)}fps"
    else:
        kind = "audio"
        label = f"Audio {ext.upper()}"
        if abr:
            label += f" • {int(abr)} kbps"

    return {
        "id": str(fmt_id),
        "kind": kind,
        "ext": ext,
        "label": label,
        "height": height,
        "fps": fps,
        "abr": abr,
        "filesize": filesize,
        "vcodec": vcodec if has_video else None,
        "acodec": acodec if has_audio else None,
    }


@app.post("/api/info")
def video_info(payload: URLRequest):
    url = payload.url.strip()

    if not url:
        raise HTTPException(status_code=400, detail="Please enter a YouTube URL.")

    try:
        with yt_dlp.YoutubeDL(base_ydl_options()) as ydl:
            info = ydl.extract_info(url, download=False)

        formats = []
        seen = set()

        for raw in info.get("formats", []):
            fmt = normalize_format(raw)
            if not fmt or fmt["id"] in seen:
                continue
            formats.append(fmt)
            seen.add(fmt["id"])

        # Video sources first, highest resolution first; then video-only;
        # audio sources last, highest bitrate first.
        formats.sort(
            key=lambda x: (
                0 if x["kind"] == "video" else 1 if x["kind"] == "video-only" else 2,
                -(x["height"] or 0),
                -(x["fps"] or 0),
                -(x["abr"] or 0),
                x["ext"],
            )
        )

        return {
            "title": info.get("title"),
            "thumbnail": info.get("thumbnail"),
            "channel": info.get("channel") or info.get("uploader"),
            "duration": info.get("duration"),
            "webpage_url": info.get("webpage_url") or url,
            "formats": formats,
            "conversion_formats": [
                {"id": "mp3", "label": "MP3 • 192 kbps"},
                {"id": "m4a", "label": "M4A • best available"},
                {"id": "mp4", "label": "MP4 • best video + audio"},
            ],
        }

    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(exc))


def download_worker(job_id, url, mode, format_id=None, target_format=None, save_dir=None):
    try:
        target_dir = Path(save_dir) if save_dir else current_download_dir

        if not target_dir.exists():
            target_dir.mkdir(parents=True, exist_ok=True)

        if not target_dir.is_dir():
            raise ValueError("Selected save location is not a folder.")

        uses_ffmpeg = mode == "convert"

        update_job(
            job_id,
            status="downloading",
            stage="Preparing download…",
            progress=0,
            folder=str(target_dir),
        )

        def progress_hook(data):
            status_value = data.get("status")

            if status_value == "downloading":
                downloaded = data.get("downloaded_bytes") or 0
                total = data.get("total_bytes") or data.get("total_bytes_estimate")
                percent = (downloaded / total * 100) if total else 0

                update_job(
                    job_id,
                    status="downloading",
                    stage="Downloading…",
                    progress=max(0, min(99, round(percent, 1))),
                    downloaded=downloaded,
                    total=total,
                    speed=data.get("speed"),
                    eta=data.get("eta"),
                )

            elif status_value == "finished":
                if uses_ffmpeg:
                    # Download phase is complete; FFmpeg may still need to run.
                    update_job(
                        job_id,
                        status="converting",
                        stage="Converting with FFmpeg…",
                        progress=99,
                        downloaded=data.get("downloaded_bytes") or 0,
                        total=data.get("total_bytes") or data.get("total_bytes_estimate"),
                        speed=None,
                        eta=0,
                    )
                else:
                    # IMPORTANT: direct source download has no FFmpeg
                    # postprocessor. Mark the byte download complete here.
                    update_job(
                        job_id,
                        status="finalizing",
                        stage="Saving direct file…",
                        progress=100,
                        downloaded=data.get("downloaded_bytes") or 0,
                        total=data.get("total_bytes") or data.get("total_bytes_estimate"),
                        speed=None,
                        eta=0,
                    )

        def postprocessor_hook(data):
            # This hook is attached ONLY in Convert mode.
            status_value = data.get("status")

            if status_value in ("started", "processing"):
                update_job(
                    job_id,
                    status="converting",
                    stage="Converting with FFmpeg…",
                    progress=99,
                )
            elif status_value == "finished":
                update_job(
                    job_id,
                    status="finalizing",
                    stage="Finalizing converted file…",
                    progress=99,
                )

        opts = base_ydl_options()
        opts["outtmpl"] = str(target_dir / "%(title)s.%(ext)s")
        opts["progress_hooks"] = [progress_hook]

        # -------------------------------------------------
        # DIRECT: exact source format, NO FFmpeg settings
        # -------------------------------------------------
        if mode == "direct":
            if not format_id:
                raise ValueError("No source format was selected.")

            # Exact format ID is intentionally used. If the selected source is
            # video-only, the downloaded file remains video-only. Audio is NOT
            # added automatically.
            opts["format"] = str(format_id)

        # -------------------------------------------------
        # CONVERT: FFmpeg only when explicitly selected
        # -------------------------------------------------
        elif mode == "convert":
            target = (target_format or "mp3").lower()

            if target == "mp3":
                opts["format"] = "bestaudio/best"
                opts["postprocessors"] = [{
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": "192",
                }]

            elif target == "m4a":
                opts["format"] = "bestaudio/best"
                opts["postprocessors"] = [{
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "m4a",
                }]

            elif target == "mp4":
                # Prefer a combined MP4 source if available. If YouTube only
                # exposes separate streams, FFmpeg is legitimately required
                # to merge them.
                opts["format"] = "best[ext=mp4]/bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b"
                opts["merge_output_format"] = "mp4"

            else:
                raise ValueError("Unsupported conversion format.")

            opts["postprocessor_hooks"] = [postprocessor_hook]

        else:
            raise ValueError("Unsupported download mode.")

        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)

        update_job(
            job_id,
            status="completed",
            stage="Download completed",
            progress=100,
            title=info.get("title"),
            folder=str(target_dir),
        )

    except Exception as exc:
        traceback.print_exc()

        update_job(
            job_id,
            status="error",
            stage="Download failed",
            progress=0,
            error=str(exc),
        )


@app.post("/api/download")
def start_download(payload: dict):
    url = str(payload.get("url", "")).strip()
    mode = str(payload.get("mode", "direct")).strip().lower()
    format_id = payload.get("format_id")
    target_format = payload.get("target_format")
    save_dir = str(payload.get("save_dir") or current_download_dir).strip()

    if not url:
        raise HTTPException(status_code=400, detail="Please enter a YouTube URL.")

    if mode not in {"direct", "convert"}:
        raise HTTPException(status_code=400, detail="Unsupported download mode.")

    if mode == "direct" and not format_id:
        raise HTTPException(
            status_code=400,
            detail="Please select an available source format.",
        )

    if mode == "convert" and target_format not in {"mp3", "m4a", "mp4"}:
        raise HTTPException(
            status_code=400,
            detail="Unsupported conversion format.",
        )

    target_path = Path(save_dir).expanduser()

    try:
        target_path.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot use selected save folder: {exc}",
        )

    if not target_path.is_dir():
        raise HTTPException(
            status_code=400,
            detail="Selected save location is not a folder.",
        )

    job_id = uuid.uuid4().hex

    with jobs_lock:
        jobs[job_id] = {
            "status": "queued",
            "stage": "Queued…",
            "progress": 0,
            "downloaded": 0,
            "total": None,
            "speed": None,
            "eta": None,
            "folder": str(target_path),
        }

    thread = threading.Thread(
        target=download_worker,
        args=(
            job_id,
            url,
            mode,
            format_id,
            target_format,
            str(target_path),
        ),
        daemon=True,
    )
    thread.start()

    return {
        "success": True,
        "job_id": job_id,
        "message": "Download started.",
    }


@app.get("/api/progress/{job_id}")
def download_progress(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)

    if not job:
        raise HTTPException(status_code=404, detail="Download job not found.")

    return job


if FRONTEND_DIR.exists():
    app.mount(
        "/static",
        StaticFiles(directory=str(FRONTEND_DIR)),
        name="static",
    )

    @app.get("/")
    def frontend():
        return FileResponse(str(FRONTEND_DIR / "index.html"))
