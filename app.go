package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"sync"

	"github.com/atotto/clipboard"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App: Wailsバインディング。ファイル保存ダイアログとチャンク書き込みを提供。
type App struct {
	ctx   context.Context
	mu    sync.Mutex
	files map[string]*os.File
}

func NewApp() *App {
	return &App{files: map[string]*os.File{}}
}

func (a *App) Startup(ctx context.Context) {
	a.ctx = ctx
}

// PickSavePath: ネイティブ保存ダイアログを開き、選択パスを返す(キャンセルは空文字)
func (a *App) PickSavePath(defaultName string) (string, error) {
	return runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		DefaultFilename: defaultName,
		Title:           "保存先を選択",
	})
}

// AppendChunk: 指定パスのファイルへチャンクを追記する(初回は作成)
// Wails v2のバインディングはUint8Arrayを渡せないため、実体はbase64版を使う
func (a *App) AppendChunk(path string, data []byte) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	f, ok := a.files[path]
	if !ok {
		var err error
		f, err = os.Create(path)
		if err != nil {
			return err
		}
		a.files[path] = f
	}
	_, err := f.Write(data)
	return err
}

// AppendChunkB64: base64文字列で受け取ってチャンク追記する(フロントエンドからはこれを使う)
func (a *App) AppendChunkB64(path string, dataB64 string) error {
	data, err := base64.StdEncoding.DecodeString(dataB64)
	if err != nil {
		return fmt.Errorf("base64デコード失敗: %w", err)
	}
	return a.AppendChunk(path, data)
}

// CloseFile: ファイルを閉じてハンドルを破棄する
func (a *App) CloseFile(path string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if f, ok := a.files[path]; ok {
		delete(a.files, path)
		return f.Close()
	}
	return nil
}

// ReadClipboard: Windowsクリップボードのテキストを読み取る(右クリック貼り付け用)
func (a *App) ReadClipboard() (string, error) {
	return clipboard.ReadAll()
}

// WriteClipboard: Windowsクリップボードへテキストを書き込む(右クリックコピー用)
func (a *App) WriteClipboard(text string) error {
	return clipboard.WriteAll(text)
}
