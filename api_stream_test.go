package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAllFormatStreams(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/player?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ", nil)
	w := httptest.NewRecorder()
	handlePlayer(w, req)
	var out playerResult
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "OK" {
		t.Fatalf("player status %s %s", out.Status, out.Reason)
	}
	check := func(kind string, f format) {
		r, _ := http.NewRequest("GET", f.URL, nil)
		r.Header.Set("Range", "bytes=0-1023")
		resp, err := streamClient.Do(r)
		if err != nil {
			t.Errorf("%s itag=%d: ERR %v", kind, f.Itag, err)
			return
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		status := resp.Status
		if resp.StatusCode >= 400 {
			t.Errorf("%s itag=%d %s %s: HTTP %d", kind, f.Itag, f.Mime, f.Codec, resp.StatusCode)
		} else {
			fmt.Printf("OK  %s itag=%-3d %s %-12s %s\n", kind, f.Itag, f.Mime, f.Codec, status)
		}
	}
	for _, f := range out.Video {
		check("video", f)
	}
	for _, f := range out.Audio {
		check("audio", f)
	}
	for _, f := range out.Muxed {
		check("muxed", f)
	}
}
