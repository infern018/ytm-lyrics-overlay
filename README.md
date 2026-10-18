# YTM Fullscreen Synced Lyrics

A Tampermonkey userscript that adds a fullscreen, time-synced, auto-scrolling
lyrics overlay to the YouTube Music web player (music.youtube.com) — similar
to the lyrics experience on the YTM mobile app.

Lyrics are fetched from the free [LRCLIB](https://lrclib.net) database. Most
tracks will have synced (line-by-line timed) lyrics; if none are found, the
overlay falls back to plain lyrics, or shows a "not found" message.

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser
   extension (Chrome, Firefox, Edge, Safari all supported).
2. Click **[this link](https://raw.githubusercontent.com/infern018/ytm-lyrics-overlay/main/ytm-lyrics-overlay.user.js)**
   — Tampermonkey will detect it and prompt you to install. Click **Install**.
3. Go to [music.youtube.com](https://music.youtube.com) and play a song.

The script auto-updates whenever a new version is pushed to this repo.

<details>
<summary>Manual install (alternative)</summary>

1. Open the Tampermonkey dashboard → **Create a new script**.
2. Delete the placeholder content and paste in the contents of
   [`ytm-lyrics-overlay.user.js`](./ytm-lyrics-overlay.user.js).
3. Save (`Ctrl/Cmd + S`).

</details>

## Use

- A **LYRICS** button is added to the player bar. Click it to open the
  fullscreen overlay.
- The current line is highlighted and the view auto-scrolls to keep it
  centered as the song plays.
- Press **Esc** or click outside the lyrics (or the ✕ in the top-right) to
  close the overlay — playback is unaffected.
- Switching tracks (even without reloading the page) automatically fetches
  and loads new lyrics.

## Notes / limitations

- Synced lyrics quality depends entirely on what's available in the LRCLIB
  database — not every track has them.
- Track title/artist are read from the YTM player bar DOM, so if YouTube
  changes its page structure, selectors in the script may need updating.
