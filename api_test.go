package main

import (
	"encoding/json"
	"io"
	"net/http/httptest"
	"net/url"
	"testing"
)

// 実YouTubeに対する結合テスト(自宅IPから)。失敗時は原因を表示する。
func TestPlayerEndpoint(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/player?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ", nil)
	w := httptest.NewRecorder()
	handlePlayer(w, req)

	var out playerResult
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("JSON decode failed: %v", err)
	}
	t.Logf("status=%q diag=%q title=%q muxed=%d video=%d audio=%d",
		out.Status, out.Diag, out.Title, len(out.Muxed), len(out.Video), len(out.Audio))
	if out.Status != "OK" {
		t.Fatalf("status not OK: %s %s", out.Status, out.Reason)
	}
	if len(out.Video) == 0 {
		t.Fatal("no video formats")
	}

	// ストリームプロキシのテスト(最初の1MB)
	target := out.Video[0].URL
	req2 := httptest.NewRequest("GET", "/api/stream?url="+url.QueryEscape(target), nil)
	req2.Header.Set("Range", "bytes=0-1048575")
	w2 := httptest.NewRecorder()
	handleStream(w2, req2)
	if w2.Code != 206 && w2.Code != 200 {
		t.Fatalf("stream status=%d body=%s", w2.Code, w2.Body.String()[:200])
	}
	n, err := io.Copy(io.Discard, w2.Result().Body)
	t.Logf("stream: status=%d bytes=%d err=%v", w2.Code, n, err)
	if n < 1024 {
		t.Fatalf("stream too small: %d", n)
	}
}

