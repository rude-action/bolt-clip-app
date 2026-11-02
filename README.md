# Bolt Clip

Goで実装されたYouTubeダウンローダ。ブラウザUI(Wails)で動画の取得・
映像/音声の合成・保存までを行う。

## 使い方

`build/bin/BoltClip.exe` をダブルクリックするだけ。インストール不要。

配布用には `build/bin/BoltClip-Setup-1.0.0.exe`(NSISインストーラ、
日本語/英語UI、インストール先選択可、スタートメニュー登録)を使う。

## 構成

- `main.go` / `app.go` — Wailsアプリ本体。ネイティブ保存ダイアログと
  チャンク書き込みのバインディングを提供
- `api.go` — `api/player.js` `api/stream.js` のGo移植。
  ANDROID_VR / VISIONOS / ANDROID クライアントでInnerTubeを並列呼び出し、
  googlevideoストリームをRange対応で中継する(POトークン不要)
- `frontend/` — Vercel版のフロントエンド(index.html / client.js /
  remux.js / style.css)。`remux.js` の saveBlob だけWails用に
  ネイティブ保存ダイアログへ差し替えてある

## ビルド・テスト

```bash
go run tools/gen_icon/main.go   # build/windows/icon.ico を生成
go test ./...                   # 実YouTubeに対する結合テスト
wails build                     # build/bin/BoltClip.exe
wails build -nsis               # + インストーラ(NSIS要: winget install NSIS.NSIS)
```

フロントエンドだけ差し替えたいときは `frontend/` のファイルを
書き換えて `wails build` し直す。
