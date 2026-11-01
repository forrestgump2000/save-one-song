(() => {
  const FIRST_YEAR = 1980;
  const LAST_YEAR = 2026;
  const PER_ROUND = 6;
  const SAVED_KEY = "sos:saved";
  const META_KEY = "sos:meta:v2";
  const RECENT_KEY = "sos:recent";

  const $ = (id) => document.getElementById(id);
  const store = {
    get(key, fallback) {
      try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
    },
  };

  let saved = store.get(SAVED_KEY, []);
  const metaCache = store.get(META_KEY, {});
  const recent = store.get(RECENT_KEY, {});

  const state = { year: null, songs: [], cut: new Set() };

  // ---------- Song lookup (iTunes Search: art + 30s preview) ----------
  const parse = (s) => {
    const [title, artist] = s.split("|");
    return { title, artist, id: s };
  };
  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const primaryArtist = (a) => a.split(/\s*(?:&|,| feat\.? | ft\.? | with | x )\s*/i)[0];
  const baseTitle = (t) => t.replace(/\s*[\(\[].*?[\)\]]\s*/g, " ").trim();

  async function itunes(term) {
    const url = `https://itunes.apple.com/search?media=music&entity=song&limit=15&country=us&term=${encodeURIComponent(term)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("lookup failed");
    return (await res.json()).results || [];
  }

  function pick(results, song) {
    const wantArtist = norm(primaryArtist(song.artist));
    const wantTitle = norm(baseTitle(song.title));
    const scored = results
      .filter((r) => r.previewUrl && norm(r.trackName).includes(wantTitle))
      .map((r) => {
        const a = norm(r.artistName), t = norm(r.trackName);
        let score = 0;
        if (a.includes(wantArtist) || wantArtist.includes(a)) score += 4;
        if (t === wantTitle) score += 4;
        else if (t.startsWith(wantTitle) || t.includes(wantTitle)) score += 2;
        if (/karaoke|tribute|cover|instrumental|made famous/i.test(r.artistName + r.trackName + (r.collectionName || ""))) score -= 6;
        if (/live|remaster/i.test(r.trackName) && !/live|remaster/i.test(song.title)) score -= 1;
        return { r, score };
      })
      .sort((x, y) => y.score - x.score);
    return scored.length && scored[0].score >= 4 ? scored[0].r : null;
  }

  async function lookup(song) {
    if (metaCache[song.id] !== undefined) return metaCache[song.id];
    let hit = null;
    try {
      hit = pick(await itunes(`${baseTitle(song.title)} ${primaryArtist(song.artist)}`), song);
      if (!hit) hit = pick(await itunes(baseTitle(song.title)), song);
    } catch {
      return null; // network hiccup: don't cache, try again next time
    }
    const meta = hit
      ? {
          art: hit.artworkUrl100.replace("100x100bb", "300x300bb"),
          preview: hit.previewUrl,
          link: hit.trackViewUrl,
        }
      : null;
    metaCache[song.id] = meta;
    store.set(META_KEY, metaCache);
    return meta;
  }

  // ---------- Audio ----------
  const audio = new Audio();
  audio.preload = "none";
  let nowPlaying = null; // song id

  function play(song, meta) {
    if (!meta || !meta.preview) return;
    if (nowPlaying === song.id && !audio.paused) {
      audio.pause();
      return;
    }
    if (nowPlaying !== song.id) {
      audio.src = meta.preview;
      nowPlaying = song.id;
      $("playerArt").src = meta.art;
      $("playerTitle").textContent = song.title;
      $("playerArtist").textContent = song.artist;
    }
    audio.play().catch(() => {});
    $("player").hidden = false;
  }

  function syncPlayingUI() {
    const playing = !audio.paused;
    $("playerToggle").textContent = playing ? "❚❚" : "▶";
    $("playerToggle").setAttribute("aria-label", playing ? "Pause" : "Play");
    document.querySelectorAll("[data-song]").forEach((el) => {
      const on = el.dataset.song === nowPlaying && playing;
      el.classList.toggle("playing", on);
      const icon = el.querySelector(".play:not(.na)");
      if (icon) icon.textContent = on ? "❚❚" : "▶";
    });
  }
  audio.addEventListener("play", syncPlayingUI);
  audio.addEventListener("pause", syncPlayingUI);
  audio.addEventListener("ended", syncPlayingUI);
  audio.addEventListener("timeupdate", () => {
    const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    $("playerProgress").style.width = pct + "%";
    document.querySelectorAll("[data-song] .progress i").forEach((bar) => {
      bar.style.width = bar.closest("[data-song]").dataset.song === nowPlaying ? pct + "%" : "0";
    });
  });
  $("playerToggle").onclick = () => (audio.paused ? audio.play().catch(() => {}) : audio.pause());

  // ---------- Views ----------
  function show(view) {
    document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
    if (view === "home") renderHome();
    if (view === "saved") renderSaved();
    window.scrollTo({ top: 0 });
  }
  document.addEventListener("click", (e) => {
    const nav = e.target.closest("[data-nav]");
    if (nav) show(nav.dataset.nav);
  });

  function updateCount() {
    $("savedCount").textContent = saved.length;
  }

  function renderHome() {
    const savedYears = new Set(saved.map((s) => s.year));
    const wrap = $("decades");
    wrap.innerHTML = "";
    for (let d = FIRST_YEAR; d <= LAST_YEAR; d += 10) {
      const sec = document.createElement("div");
      sec.className = "decade";
      const years = [];
      for (let y = d; y < d + 10 && y <= LAST_YEAR; y++) years.push(y);
      const done = years.filter((y) => savedYears.has(y)).length;
      sec.innerHTML = `<h3>The ${String(d).slice(2)}s <small>${done ? `${done} saved` : ""}</small></h3><div class="years"></div>`;
      const grid = sec.querySelector(".years");
      years.forEach((y) => {
        const b = document.createElement("button");
        b.className = "year";
        b.textContent = y;
        if (savedYears.has(y)) b.innerHTML += `<span class="dot" title="You've saved a song from ${y}"></span>`;
        b.onclick = () => startRound(y);
        grid.appendChild(b);
      });
      wrap.appendChild(sec);
    }
  }

  $("randomYear").onclick = () => startRound(FIRST_YEAR + Math.floor(Math.random() * (LAST_YEAR - FIRST_YEAR + 1)));

  // ---------- Round ----------
  function shuffle(a) {
    a = a.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function dealSix(year) {
    const pool = window.SONGS[year].map(parse);
    const last = new Set(recent[year] || []);
    // Prefer songs you didn't see last round of this year
    const fresh = shuffle(pool.filter((s) => !last.has(s.id)));
    const stale = shuffle(pool.filter((s) => last.has(s.id)));
    const six = fresh.concat(stale).slice(0, PER_ROUND);
    recent[year] = six.map((s) => s.id);
    store.set(RECENT_KEY, recent);
    return six;
  }

  function startRound(year) {
    state.year = year;
    state.songs = dealSix(year);
    state.cut = new Set();
    $("roundYear").textContent = year;
    show("round");
    renderCards();
    state.songs.forEach((song, i) => {
      lookup(song).then((meta) => {
        song.meta = meta;
        fillCard(i);
      });
    });
  }

  $("reshuffle").onclick = () => startRound(state.year);

  function renderCards() {
    const list = $("cards");
    list.innerHTML = "";
    state.songs.forEach((song, i) => {
      const li = document.createElement("li");
      li.className = "card";
      li.dataset.song = song.id;
      li.style.animationDelay = i * 60 + "ms";
      li.innerHTML = `
        <button class="art" aria-label="Play preview of ${esc(song.title)}"><span class="play">…</span></button>
        <div class="meta">
          <p class="title">${esc(song.title)}</p>
          <p class="artist">${esc(song.artist)}</p>
          <div class="actions"><button class="cut">Cut</button></div>
        </div>
        <div class="progress"><i></i></div>`;
      li.querySelector(".art").onclick = () => play(song, song.meta);
      li.querySelector(".cut").onclick = () => toggleCut(i);
      list.appendChild(li);
    });
    updateRoundUI();
  }

  function fillCard(i) {
    const song = state.songs[i];
    const li = $("cards").children[i];
    if (!li || li.dataset.song !== song.id) return;
    const art = li.querySelector(".art");
    if (song.meta) {
      art.innerHTML = `<img src="${song.meta.art}" alt="" loading="lazy" /><span class="play">▶</span>`;
    } else {
      art.innerHTML = `<span class="play na">NO<br>PREVIEW</span>`;
      art.disabled = true;
    }
    syncPlayingUI();
  }

  function toggleCut(i) {
    const id = state.songs[i].id;
    if (state.cut.has(id)) state.cut.delete(id);
    else if (state.cut.size < PER_ROUND - 1) state.cut.add(id);
    if (state.cut.has(id) && nowPlaying === id) audio.pause();
    updateRoundUI();
  }

  function survivor() {
    return state.cut.size === PER_ROUND - 1 ? state.songs.find((s) => !state.cut.has(s.id)) : null;
  }

  function updateRoundUI() {
    const keep = survivor();
    [...$("cards").children].forEach((li, i) => {
      const song = state.songs[i];
      const isCut = state.cut.has(song.id);
      li.classList.toggle("cut-out", isCut);
      li.classList.toggle("survivor", keep === song);
      li.querySelector(".cut").textContent = isCut ? "Undo" : "Cut";
      let badge = li.querySelector(".badge");
      if (keep === song && !badge) li.insertAdjacentHTML("afterbegin", `<span class="badge">Last one standing</span>`);
      if (keep !== song && badge) badge.remove();
    });
    const left = PER_ROUND - 1 - state.cut.size;
    const pips = Array.from({ length: PER_ROUND - 1 }, (_, i) => `<i class="${i < state.cut.size ? "on" : ""}"></i>`).join("");
    $("status").innerHTML = keep
      ? `<b>${esc(keep.title)}</b> survived. Save it, or undo a cut to change your mind.`
      : `Cut <b>${left}</b> more song${left === 1 ? "" : "s"}. Tap the art to listen. <span class="pips">${pips}</span>`;
    $("saveBar").hidden = !keep;
  }

  $("saveBtn").onclick = () => {
    const keep = survivor();
    if (!keep) return;
    saved = saved.filter((s) => s.id !== keep.id);
    saved.unshift({
      id: keep.id, title: keep.title, artist: keep.artist, year: state.year,
      art: keep.meta?.art || null, preview: keep.meta?.preview || null, savedAt: Date.now(),
    });
    store.set(SAVED_KEY, saved);
    updateCount();
    showResult(keep);
  };

  function showResult(song) {
    $("resultYear").textContent = `Saved from ${state.year}`;
    $("resultTitle").textContent = song.title;
    $("resultArtist").textContent = song.artist;
    const img = $("resultArt");
    if (song.meta?.art) img.src = song.meta.art.replace("300x300bb", "600x600bb");
    else img.removeAttribute("src");
    $("againYearLabel").textContent = state.year;
    show("result");
  }
  $("againYear").onclick = () => startRound(state.year);

  // ---------- Saved ----------
  function renderSaved() {
    const wrap = $("savedList");
    if (!saved.length) {
      wrap.innerHTML = `<div class="empty"><p>Nothing saved yet. Every round you play adds one song here.</p><button class="btn primary" data-nav="home">Pick a year</button></div>`;
      return;
    }
    const byYear = {};
    saved.forEach((s) => (byYear[s.year] ||= []).push(s));
    wrap.innerHTML = "";
    Object.keys(byYear).sort((a, b) => b - a).forEach((year) => {
      wrap.insertAdjacentHTML("beforeend", `<div class="saved-year">${year}</div>`);
      byYear[year].forEach((s) => {
        const row = document.createElement("div");
        row.className = "saved-row card-like";
        row.dataset.song = s.id;
        row.innerHTML = `
          <button class="art card-art" style="position:relative;overflow:hidden;border:0;padding:0;background:var(--card-hi)" aria-label="Play ${esc(s.title)}">
            ${s.art ? `<img src="${s.art}" alt="" style="width:100%;height:100%;object-fit:cover;display:block" />` : ""}
            <span class="play" style="position:absolute;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.35)">${s.preview ? "▶" : "–"}</span>
          </button>
          <div><div class="title">${esc(s.title)}</div><div class="artist">${esc(s.artist)}</div></div>
          <button class="remove" aria-label="Remove ${esc(s.title)}">Remove</button>`;
        row.querySelector(".art").onclick = () => play(s, s);
        row.querySelector(".remove").onclick = () => {
          if (nowPlaying === s.id) audio.pause();
          saved = saved.filter((x) => x.id !== s.id);
          store.set(SAVED_KEY, saved);
          updateCount();
          renderSaved();
        };
        wrap.appendChild(row);
      });
    });
    syncPlayingUI();
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  updateCount();
  show("home");
})();
