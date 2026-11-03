// Bolt Clip フロントエンド
// フォーマット一覧は /api/player から取得し、合成・保存は remux.js (YTD) が行う。

const inputView = document.getElementById("input-view");
const loadingView = document.getElementById("loading-view");
const resultView = document.getElementById("result-view");
const urlForm = document.getElementById("url-form");
const urlInput = document.getElementById("url-input");
const inputError = document.getElementById("input-error");
const videoTitle = document.getElementById("video-title");
const videoList = document.getElementById("video-list");
const audioList = document.getElementById("audio-list");
const muxedList = document.getElementById("muxed-list");
const mergeBtn = document.getElementById("merge-btn");
const statusLine = document.getElementById("status-line");
const progressBar = document.getElementById("progress-bar");
const anotherBtn = document.getElementById("another-btn");

const state = { formats: [], video: null, audio: null, muxed: null, title: "", busy: false };

function show(view) {
  for (const v of [inputView, loadingView, resultView]) v.classList.add("hidden");
  view.classList.remove("hidden");
}

/* ---------- クリップボード操作(コピペ許可) ---------- */
const pasteBtn = document.getElementById("paste-btn");
const copyTitleBtn = document.getElementById("copy-title-btn");

// クリップボードからURL入力欄へ貼り付け(WailsならWindowsクリップボード直接)
pasteBtn.addEventListener("click", async () => {
  try {
    const text = await clipRead();
    if (text) {
      urlInput.value = text.trim();
      urlInput.focus();
    }
  } catch {
    urlInput.focus();
    inputError.textContent = "クリップボードの読み取りに失敗しました。入力欄で Ctrl+V を押してください。";
    inputError.classList.remove("hidden");
    setTimeout(() => inputError.classList.add("hidden"), 4000);
  }
});

copyTitleBtn.addEventListener("click", async () => {
  if (!state.title) return;
  try {
    await clipWrite(state.title);
  } catch {
    // フォールバック: 非表示のテキストエリアを選択してコピー
    const ta = document.createElement("textarea");
    ta.value = state.title;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  copyTitleBtn.textContent = "✅ コピーしました";
  setTimeout(() => (copyTitleBtn.textContent = "📋 タイトルをコピー"), 2000);
});

/* ---------- 右クリックコンテキストメニュー(マウスでコピペ) ---------- */
const ctxMenu = document.getElementById("ctx-menu");
const app = window.go && window.go.main && window.go.main.App;

// クリップボード読み書き: Wailsバインディング(Windowsクリップボード直接)を
// 優先し、無い環境ではWeb Clipboard APIにフォールバック
async function clipRead() {
  if (app && app.ReadClipboard) return app.ReadClipboard();
  return navigator.clipboard.readText();
}
async function clipWrite(text) {
  if (app && app.WriteClipboard) return app.WriteClipboard(text);
  return navigator.clipboard.writeText(text);
}

let ctxTarget = null; // 対象要素(input または テキスト表示要素)

document.addEventListener("contextmenu", (e) => {
  // ページ内のどこでも右クリックメニューを出す
  e.preventDefault();
  const input = e.target.closest("input, textarea");
  ctxTarget = input || e.target.closest("h1, h2, p, span, div, label, .fmt-row") || e.target;

  // 対象と選択状態に応じてメニュー項目の有効/無効を切り替える
  const selText = String(window.getSelection());
  const hasInputSel = input ? input.selectionEnd > input.selectionStart : false;
  // 入力欄では入力欄内の選択、それ以外はページ全体の選択を対象にする
  const hasSel = input ? hasInputSel : selText.length > 0;
  const hasText = input ? !!input.value : !!(ctxTarget.textContent || "").trim();
  ctxMenu.querySelector('[data-act="cut"]').disabled = !input || !hasSel;
  ctxMenu.querySelector('[data-act="copy"]').disabled = !hasSel;
  ctxMenu.querySelector('[data-act="paste"]').disabled = !input;
  ctxMenu.querySelector('[data-act="copyAll"]').disabled = !hasText;

  ctxMenu.classList.remove("hidden");
  const r = ctxMenu.getBoundingClientRect();
  let x = e.clientX, y = e.clientY;
  if (x + r.width > innerWidth) x = innerWidth - r.width - 4;
  if (y + r.height > innerHeight) y = innerHeight - r.height - 4;
  ctxMenu.style.left = x + "px";
  ctxMenu.style.top = y + "px";
});

// メニュー以外をクリックしたら閉じる
document.addEventListener("mousedown", (e) => {
  if (!ctxMenu.classList.contains("hidden") && !e.target.closest("#ctx-menu")) {
    ctxMenu.classList.add("hidden");
  }
});

ctxMenu.addEventListener("click", async (e) => {
  const act = e.target.dataset && e.target.dataset.act;
  if (!act || !ctxTarget) return;
  ctxMenu.classList.add("hidden");
  const input = ctxTarget.matches("input, textarea") ? ctxTarget : null;

  try {
    if (act === "copyAll") {
      await clipWrite(input ? input.value : ctxTarget.textContent);
    } else if (act === "copy") {
      if (input) {
        await clipWrite(input.value.slice(input.selectionStart, input.selectionEnd));
      } else {
        await clipWrite(String(window.getSelection()));
      }
    } else if (act === "cut") {
      if (input) {
        const s = input.selectionStart, t = input.selectionEnd;
        await clipWrite(input.value.slice(s, t));
        input.value = input.value.slice(0, s) + input.value.slice(t);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } else if (act === "paste") {
      if (input) {
        const text = (await clipRead()) || "";
        const s = input.selectionStart, t = input.selectionEnd;
        input.value = input.value.slice(0, s) + text + input.value.slice(t);
        input.selectionStart = input.selectionEnd = s + text.length;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
  } catch (err) {
    inputError.textContent = "クリップボード操作に失敗しました: " + (err && err.message ? err.message : err);
    inputError.classList.remove("hidden");
    setTimeout(() => inputError.classList.add("hidden"), 4000);
  }
});

/* ---------- プライバシーポリシーモーダル ---------- */
const policyModal = document.getElementById("policy-modal");
document.getElementById("policy-btn").addEventListener("click", () => policyModal.classList.remove("hidden"));
document.getElementById("policy-ok").addEventListener("click", () => policyModal.classList.add("hidden"));
policyModal.addEventListener("click", (e) => {
  if (e.target === policyModal) policyModal.classList.add("hidden");
});

const isMp4 = (f) => !!f.mime && f.mime.includes("mp4");

function fmtLabel(f) {
  const codec = (f.codec || "").split(".")[0];
  if (f.isAudio) {
    return (f.label || "audio") + (codec ? " (" + codec + ")" : "");
  }
  return (f.label || "") + (f.fps ? "@" + f.fps : "") + (codec ? " · " + codec : "");
}

function money(bytes) {
  if (!bytes) return "";
  const mb = bytes / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(2) + " GB" : mb.toFixed(mb >= 100 ? 0 : 1) + " MB";
}

function toYtdFormat(f) {
  return {
    itag: f.itag,
    url: f.url, urls: [f.url],
    mime: f.mime + (f.codec ? '; codecs="' + f.codec + '"' : ""),
    quality: f.label || "",
    contentLength: f.size || 0,
    hasAudio: !!f.hasAudio,
    isAudio: !!f.isAudio,
    fps: f.fps, bitrate: f.bitrate,
    container: f.mime.includes("mp4") ? "mp4" : "webm",
  };
}

/* 拡張機能版のsyncAudioと同じく、映像と音声は同じコンテナファミリーに
 * 揃える（MP4: avc1+aac、WebM: vp9/av1+opus）。 */
function syncAudio() {
  if (!state.video || !state.audio) return;
  if (state.video.container === state.audio.container) return;
  const match = state.formats
    .filter((f) => f.isAudio && f.container === state.video.container)
    .sort((x, y) => (y.bitrate || 0) - (x.bitrate || 0))[0];
  if (match) {
    state.audio = match;
    audioList.querySelectorAll("input").forEach((r) => (r.checked = r.dataset.key === audioKey(match)));
    return;
  }
  // 同一コンテナの音声がない場合: 音声側のコンテナに映像を合わせる
  const vMatch = state.formats
    .filter((f) => !f.isAudio && !f.hasAudio && f.container === state.audio.container)
    .sort((x, y) => (y.height || 0) - (x.height || 0))[0];
  if (vMatch) {
    state.video = vMatch;
    videoList.querySelectorAll("input").forEach((r) => (r.checked = r.dataset.key === vMatch.itag + ":" + vMatch.container));
  }
}

const audioKey = (f) => f.itag + ":" + f.container;

function addRadio(listEl, f, group, onPick) {
  const row = document.createElement("label");
  row.className = "fmt-row";
  const input = document.createElement("input");
  input.type = "radio";
  input.name = group;
  input.dataset.key = f.itag + ":" + f.container;
  input.addEventListener("change", () => onPick(f));
  row.append(input, document.createTextNode(" " + fmtLabel(f)));
  const size = document.createElement("span");
  size.className = "fmt-size";
  size.textContent = (f.estimated ? "~" : "") + money(f.size);
  row.appendChild(size);
  listEl.appendChild(row);
  return input;
}

function addMuxedRow(f) {
  const row = document.createElement("label");
  row.className = "fmt-row";
  const input = document.createElement("input");
  input.type = "radio";
  input.name = "muxed";
  input.addEventListener("change", () => {
    state.muxed = f;
    state.video = null;
    state.audio = null;
  });
  row.append(input, document.createTextNode(" " + fmtLabel({ ...f, isAudio: false })));
  const size = document.createElement("span");
  size.className = "fmt-size";
  size.textContent = (f.estimated ? "~" : "") + money(f.size);
  row.appendChild(size);
  muxedList.appendChild(row);
  return input;
}

// フォーマット一覧の取得とUI反映(URLの再取得・リトライでも使い回す)
let lastUrl = "";
async function loadFormats(url) {
  const res = await fetch("/api/player?url=" + encodeURIComponent(url));
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "HTTP " + res.status);

    const formats = []
      .concat(data.muxed.map((f) => ({ ...f, hasAudio: true, isAudio: false })))
      .concat(data.video.map((f) => ({ ...f, hasAudio: false, isAudio: false })))
      .concat(data.audio.map((f) => ({ ...f, hasAudio: false, isAudio: true })))
      // syncAudioが参照するcontainerを補完(mimeから判定)
      .map((f) => ({ ...f, container: f.mime && f.mime.includes("mp4") ? "mp4" : "webm" }));

    state.title = data.title || "video";
    state.formats = formats;
    state.video = state.audio = state.muxed = null;

    videoTitle.textContent = data.title || urlInput.value;
    videoList.innerHTML = "";
    audioList.innerHTML = "";
    muxedList.innerHTML = "";

    const videos = formats.filter((f) => !f.isAudio && !f.hasAudio);
    const audios = formats.filter((f) => f.isAudio);
    const muxed = formats.filter((f) => f.hasAudio);

    for (const f of videos) {
      const r = addRadio(videoList, f, "video", (x) => { state.video = x; state.muxed = null; syncAudio(); });
      // デフォルトは最高画質ではなく最高画質のMP4(avc1)。
      // WebM(vp9/av01)はJSでの解析・合成が非常に重く数分待たされるため
      if (!state.video || (!isMp4(state.video) && isMp4(f))) { r.checked = true; state.video = f; }
    }
    for (const f of audios) {
      const r = addRadio(audioList, f, "audio", (x) => { state.audio = x; state.muxed = null; });
      if (!state.audio) { r.checked = true; state.audio = f; }
    }
    for (const f of muxed) {
      const r = addMuxedRow(f);
      if (!state.muxed && !videos.length) { r.checked = true; state.muxed = f; }
    }
    if (!videos.length) videoList.innerHTML = '<div class="empty">なし（単一ファイルのみ）</div>';
    if (!audios.length) audioList.innerHTML = '<div class="empty">なし</div>';
    if (!muxed.length) muxedList.innerHTML = '<div class="empty">なし</div>';
    syncAudio();

    statusLine.textContent = data.status === "OK" ? "" : data.reason || "一部のフォーマットは利用できません。";
    progressBar.style.width = "0";
    copyTitleBtn.classList.remove("hidden");
    lastUrl = url;
    show(resultView);
}

urlForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  inputError.classList.add("hidden");
  show(loadingView);
  try {
    await loadFormats(urlInput.value.trim());
  } catch (e) {
    inputError.textContent = e.message || e;
    inputError.classList.remove("hidden");
    show(inputView);
  }
});

/* ---------- 進捗・残り時間表示 ---------- */
// フェーズ(demux/merge/save)の状態表示と、DL速度からの残り時間推定
const phaseStart = { phase: null, t: 0 };
const phaseTimer = setInterval(() => {
  // 合成・解析などの長いフェーズで経過時間を表示(停滞しているか判別できるように)
  if (!phaseStart.phase || state.busy === false) return;
  const secs = Math.round((performance.now() - phaseStart.t) / 1000);
  if (secs > 3) statusLine.textContent = phaseStart.text + " (" + secs + "秒経過)";
}, 1000);

function setPhase(text) {
  phaseStart.phase = text;
  phaseStart.t = performance.now();
  phaseStart.text = text;
  statusLine.textContent = text;
}

const PHASE_TEXT = {
  demux: (d) => "解析中(" + (d.which === "video" ? "映像" : "音声") + ")…",
  merge: () => "映像+音声を合成中… (サイズによって数十秒〜数分かかります)",
  save: () => "ファイル保存中…",
  "save-progress": (d) =>
    "ファイル保存中… " + Math.round((d.written / d.total) * 100) + "% (" +
    YTDU.formatBytes(d.written) + " / " + YTDU.formatBytes(d.total) + ")",
  done: () => { phaseStart.phase = null; },
};
window.addEventListener("ytd-phase", (e) => {
  const d = e.detail || {};
  const fn = PHASE_TEXT[d.phase];
  if (fn) setPhase(fn(d));
});

// 残り時間の目安: 直近の転送速度から計算
const speed = { lastT: 0, lastGot: 0, bps: 0 };
function etaText(got, total) {
  if (!total || got > total) return "";
  const now = performance.now();
  if (speed.lastT && now > speed.lastT + 200) {
    const instBps = ((got - speed.lastGot) / (now - speed.lastT)) * 1000;
    speed.bps = speed.bps ? speed.bps * 0.7 + instBps * 0.3 : instBps; // 平滑化
    speed.lastT = now;
    speed.lastGot = got;
  } else if (!speed.lastT) {
    speed.lastT = now;
    speed.lastGot = 0;
  }
  if (speed.bps < 1024) return "";
  const remain = (total - got) / speed.bps;
  if (!isFinite(remain) || remain > 3600 * 4) return "";
  if (remain < 30) return "残り約" + Math.max(1, Math.round(remain)) + "秒";
  if (remain < 90) return "残り約1分";
  if (remain < 3600) return "残り約" + Math.round(remain / 60) + "分";
  return "残り約" + (remain / 3600).toFixed(1) + "時間";
}

/* ---------- ダウンロード（合成 or 単一） ---------- */
function resetSpeed() { speed.lastT = 0; speed.lastGot = 0; speed.bps = 0; }
async function runDownload() {
  resetSpeed();
  // Wailsでは保存先ダイアログをDL開始前に出す(完了を待たせないため)
  const app = window.go && window.go.main && window.go.main.App;
  let savePath = null;
  if (app && app.PickSavePath) {
    const safe = (state.title || "video").replace(/[\\/:*?"<>|]/g, "_");
    const ext = state.muxed
      ? (state.muxed.mime.includes("webm") ? "webm" : "mp4")
      : state.video && state.audio
        ? (state.video.container === "webm" ? "webm" : "mp4")
        : state.audio ? "m4a" : "mp4";
    savePath = await app.PickSavePath(safe + "." + ext);
    if (!savePath) throw new Error("保存がキャンセルされました");
    statusLine.textContent = "ダウンロードを開始します…";
  }
  if (state.muxed) {
    // 単一ファイル（progressive）はそのまま保存
    return YTD.downloadDirect(toYtdFormat(state.muxed), state.title, (label, got, total) => {
      const pct = total ? Math.round((got / total) * 100) : 0;
      statusLine.textContent = "ダウンロード中 " + pct + "% · " +
        YTDU.formatBytes(got) + (total ? " / " + YTDU.formatBytes(total) : "") +
        " · " + etaText(got, total);
      progressBar.style.width = total ? pct + "%" : "0";
    }, savePath);
  }
  // 映像+音声をブラウザ内で合成（remux）
  return YTD.downloadMerged({
    video: state.video ? toYtdFormat(state.video) : null,
    audio: state.audio ? toYtdFormat(state.audio) : null,
    baseName: state.title,
    savePath,
    onProgress: (label, got, frac) => {
      const which = label === "video" ? "映像" : label === "audio" ? "音声" : label;
      const pct = Math.round((frac || 0) * 100);
      const total = (state.video && state.video.size || 0) + (state.audio && state.audio.size || 0);
      statusLine.textContent = which + "取得中 " + pct + "% · " + YTDU.formatBytes(got) +
        (total ? " / " + YTDU.formatBytes(total) : "") + " · " + etaText(got, total);
      progressBar.style.width = pct + "%";
    },
  });
}

mergeBtn.addEventListener("click", async () => {
  if (state.busy) return;
  const pick = state.muxed || state.video || state.audio;
  if (!pick) {
    statusLine.textContent = "フォーマットを選択してください。";
    return;
  }
  state.busy = true;
  mergeBtn.disabled = true;

  try {
    let n;
    try {
      n = await runDownload();
    } catch (e) {
      // 403はURL期限切れが主原因: 同じ選択(itag)でフォーマットを
      // 再取得してから1回だけリトライする
      if (!/403|期限切れ/.test(String(e.message || e)) || !lastUrl) throw e;
      statusLine.textContent = "URLが期限切れのため再取得中…";
      const wanted = {
        video: state.video && state.video.itag,
        audio: state.audio && state.audio.itag,
        muxed: state.muxed && state.muxed.itag,
      };
      await loadFormats(lastUrl);
      const find = (list) => (list ? state.formats.find((f) => f.itag === list) : null);
      const v = find(wanted.video), a = find(wanted.audio), m = find(wanted.muxed);
      if (m) { state.muxed = m; }
      else if (v && a) { state.video = v; state.audio = a; }
      else if (v) { state.video = v; }
      else if (a) { state.audio = a; }
      n = await runDownload();
    }
    progressBar.style.width = "100%";
    statusLine.textContent = "完了 — " + YTDU.formatBytes(n);
  } catch (e) {
    statusLine.textContent = "エラー: " + (e.message || e);
  } finally {
    state.busy = false;
    mergeBtn.disabled = false;
  }
});

anotherBtn.addEventListener("click", () => {
  urlInput.value = "";
  copyTitleBtn.classList.add("hidden");
  show(inputView);
  urlInput.focus();
});
