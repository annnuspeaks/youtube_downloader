# YouTube Media Studio

## Exact location

Create this structure:

G:\YouTube_MP3\
├── .venv\
├── Downloads\
├── youtube_cookies.txt
├── backend\
│   └── app.py
└── frontend\
    ├── index.html
    ├── style.css
    └── app.js

The existing `.venv` and `Downloads` folders can be kept.

## Install backend packages

From:

G:\YouTube_MP3

with `.venv` activated:

```bat
python -m pip install -r requirements.txt
```

## Start backend

```bat
cd /d G:\YouTube_MP3
.venv\Scripts\activate
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

## Open frontend

Open:

G:\YouTube_MP3\frontend\index.html

or use VS Code Live Server.

The UI calls:

http://127.0.0.1:8000

Downloads are saved to:

G:\YouTube_MP3\Downloads

## Important

Keep `youtube_cookies.txt` private. It contains authentication cookies and should never be uploaded to GitHub or shared.
