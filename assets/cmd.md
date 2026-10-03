yt-dlp --js-runtimes "deno:C:\Users\annus\.deno\bin\deno.exe" --remote-components "ejs:github" --cookies "G:\YouTube_MP3\youtube_cookies.txt" -x --audio-format mp3 --audio-quality 192K -o "G:\YouTube_MP3\Downloads\%(title)s.%(ext)s" "URL_SHOULD_BE_HERE"



python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000