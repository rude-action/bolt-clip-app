package main

// api/player.js と api/stream.js のGo移植。
// デスクトップアプリは自宅回線IPから直接呼ぶためPOトークン不要。

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	neturl "net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

const fallbackKey = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"

const safariUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"

type clientDef struct {
	Key        string
	Name       string
	Ver        string
	Num        string
	Extra      map[string]any
	UA         string
	ThirdParty map[string]any
}

var clients = []clientDef{
	{
		Key: "androidvr", Name: "ANDROID_VR", Ver: "1.60.19", Num: "28",
		UA: "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12; GB) gzip",
		Extra: map[string]any{
			"androidSdkVersion": 32, "osName": "Android", "osVersion": "12",
			"userAgent": "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12; GB) gzip",
		},
	},
	{
		Key: "visionos", Name: "VISIONOS", Ver: "1.02", Num: "101",
		UA: safariUA,
		Extra: map[string]any{
			"deviceMake": "Apple", "deviceModel": "RealityDevice17,1",
			"osName": "visionOS", "osVersion": "26.5.23O471", "userAgent": safariUA,
		},
	},
	{
		Key: "android", Name: "ANDROID", Ver: "21.26.364", Num: "3",
		UA: "com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip",
		Extra: map[string]any{
			"androidSdkVersion": 30, "osName": "Android", "osVersion": "11",
			"userAgent": "com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip",
		},
	},
	{
		// データセンターIPでも通りやすいフォールバック
		Key: "ios", Name: "IOS", Ver: "21.26.364", Num: "5",
		UA: "com.google.ios.youtube/21.26.364 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)",
		Extra: map[string]any{
			"deviceMake": "Apple", "deviceModel": "iPhone16,2",
			"osName": "iPhone", "osVersion": "18.3.2.22D80",
		},
	},
	{
		Key: "tvembed", Name: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", Ver: "2.0", Num: "85",
		UA: safariUA,
		Extra: map[string]any{
			"clientScreen": "EMBED",
		},
		ThirdParty: map[string]any{"embedUrl": "https://www.youtube.com/"},
	},
}

type format struct {
	Itag       int    `json:"itag"`
	URL        string `json:"url"`
	Mime       string `json:"mime"`
	Codec      string `json:"codec"`
	Size       int64  `json:"size"`
	Estimated  bool   `json:"estimated,omitempty"`
	Label      string `json:"label"`
	Height     int    `json:"height"`
	FPS        int    `json:"fps"`
	Bitrate    int64  `json:"bitrate"`
	DurationMs int64  `json:"durationMs"`
}

type playerResult struct {
	Muxed   []format `json:"muxed"`
	Video   []format `json:"video"`
	Audio   []format `json:"audio"`
	Title   string   `json:"title"`
	Seconds int      `json:"seconds"`
	Status  string   `json:"status"`
	Reason  string   `json:"reason"`
	Diag    string   `json:"diag"`
}

var httpClient = &http.Client{Timeout: 30 * time.Second}
var streamClient = &http.Client{Timeout: 0} // ストリーム用(タイムアウトなし)

var videoIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
var pathIDRe = regexp.MustCompile(`^/(?:shorts|live|embed|v|e)/([A-Za-z0-9_-]{11})`)

func parseVideoID(input string) string {
	if input == "" {
		return ""
	}
	if videoIDRe.MatchString(input) {
		return input
	}
	if strings.HasPrefix(input, "http://") || strings.HasPrefix(input, "https://") || strings.Contains(input, "/") {
		u := input
		if i := strings.Index(u, "?"); i >= 0 && !strings.Contains(u, "://") {
			u = u[:0] // fallthrough to error
		}
		_ = u
		if idx := strings.Index(input, "v="); idx >= 0 {
			rest := input[idx+2:]
			if i := strings.IndexAny(rest, "&#/"); i >= 0 {
				rest = rest[:i]
			}
			if videoIDRe.MatchString(rest) {
				return rest
			}
		}
		if m := pathIDRe.FindStringSubmatch(getPath(input)); m != nil {
			return m[1]
		}
		// youtu.be/<id>
		if strings.Contains(input, "youtu.be/") {
			rest := input[strings.Index(input, "youtu.be/")+9:]
			if i := strings.IndexAny(rest, "?#/"); i >= 0 {
				rest = rest[:i]
			}
			if videoIDRe.MatchString(rest) {
				return rest
			}
		}
	}
	return ""
}

func getPath(raw string) string {
	s := raw
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	if i := strings.Index(s, "?"); i >= 0 {
		s = s[:i]
	}
	if i := strings.Index(s, "/"); i >= 0 {
		return s[i:]
	}
	return "/"
}

// getVisitorData: watchページから正規のvisitor IDを取得
func getVisitorData(videoID string) (visitor string, sts int) {
	req, _ := http.NewRequest("GET", "https://www.youtube.com/watch?v="+videoID, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", 0
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return "", 0
	}
	if m := regexp.MustCompile(`"visitorData":"([^"]+)"`).FindSubmatch(body); m != nil {
		visitor = string(m[1])
	}
	if m := regexp.MustCompile(`"signatureTimestamp":(\d+)`).FindSubmatch(body); m != nil {
		fmt.Sscanf(string(m[1]), "%d", &sts)
	}
	return visitor, sts
}

func callPlayer(c clientDef, videoID, visitor string) (map[string]any, error) {
	clientCtx := map[string]any{
		"clientName": c.Name, "clientVersion": c.Ver, "hl": "en", "gl": "US",
	}
	for k, v := range c.Extra {
		clientCtx[k] = v
	}
	if visitor != "" {
		clientCtx["visitorData"] = visitor
	}
	body := map[string]any{
		"context":        map[string]any{"client": clientCtx},
		"videoId":        videoID,
		"contentCheckOk": true,
		"racyCheckOk":    true,
	}
	if c.ThirdParty != nil {
		body["thirdParty"] = c.ThirdParty
	}
	payload, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST",
		"https://www.youtube.com/youtubei/v1/player?key="+fallbackKey+"&prettyPrint=false",
		strings.NewReader(string(payload)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Youtube-Client-Name", c.Num)
	req.Header.Set("X-Youtube-Client-Version", c.Ver)
	req.Header.Set("User-Agent", c.UA)
	if visitor != "" {
		req.Header.Set("X-Goog-Visitor-Id", visitor)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("InnerTube HTTP %d (%s)", resp.StatusCode, c.Key)
	}
	var data map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, err
	}
	return data, nil
}

func str(m map[string]any, k string) string {
	if v, ok := m[k].(string); ok {
		return v
	}
	return ""
}
func num(m map[string]any, k string) float64 {
	if v, ok := m[k].(float64); ok {
		return v
	}
	return 0
}

func codecOf(mime string) string {
	if m := regexp.MustCompile(`codecs="([^"]+)"`).FindStringSubmatch(mime); m != nil {
		return m[1]
	}
	return ""
}

func collect(players map[string]map[string]any) playerResult {
	out := playerResult{Muxed: []format{}, Video: []format{}, Audio: []format{}}
	seen := map[string]bool{}

	push := func(list *[]format, f map[string]any, kind string) {
		url := str(f, "url")
		if url == "" {
			return
		}
		key := fmt.Sprintf("%s:%v", kind, num(f, "itag"))
		if seen[key] {
			return
		}
		seen[key] = true
		mime := str(f, "mimeType")
		base := strings.SplitN(mime, ";", 2)[0]
		isAudio := strings.HasPrefix(base, "audio/")
		var label string
		if isAudio {
			if b := num(f, "bitrate"); b > 0 {
				label = fmt.Sprintf("%d kbps", int(b/1000))
			}
		} else {
			label = str(f, "qualityLabel")
		}
		*list = append(*list, format{
			Itag:       int(num(f, "itag")),
			URL:        url,
			Mime:       base,
			Codec:      codecOf(mime),
			Size:       int64(num(f, "contentLength")),
			Label:      label,
			Height:     int(num(f, "height")),
			FPS:        int(num(f, "fps")),
			Bitrate:    int64(num(f, "bitrate")),
			DurationMs: int64(num(f, "approxDurationMs")),
		})
	}

	statusRank := map[string]int{"OK": 0, "UNPLAYABLE": 2, "LOGIN_REQUIRED": 3, "ERROR": 4}
	for _, c := range clients {
		p, ok := players[c.Key]
		if !ok {
			continue
		}
		ps, _ := p["playabilityStatus"].(map[string]any)
		vd, _ := p["videoDetails"].(map[string]any)
		if out.Title == "" {
			out.Title = str(vd, "title")
			out.Seconds = int(num(vd, "lengthSeconds"))
		}
		st := str(ps, "status")
		if st == "OK" {
			out.Status = "OK"
			out.Reason = ""
		} else if cur, ok := statusRank[out.Status]; !ok || statusRank[st] < cur {
			out.Status = st
			out.Reason = str(ps, "reason")
		}
		sd, _ := p["streamingData"].(map[string]any)
		if sd == nil {
			continue
		}
		for _, f := range toMapSlice(sd["formats"]) {
			push(&out.Muxed, f, "muxed")
		}
		for _, f := range toMapSlice(sd["adaptiveFormats"]) {
			mime := str(f, "mimeType")
			if strings.HasPrefix(mime, "audio/") {
				push(&out.Audio, f, "audio")
			} else {
				push(&out.Video, f, "video")
			}
		}
	}

	// サイズ推定
	secs := float64(out.Seconds)
	for _, list := range []*[]format{&out.Muxed, &out.Video, &out.Audio} {
		for i := range *list {
			f := &(*list)[i]
			if f.Size == 0 {
				s := secs
				if f.DurationMs > 0 {
					s = float64(f.DurationMs) / 1000
				}
				if s > 0 && f.Bitrate > 0 {
					f.Size = int64(float64(f.Bitrate) * s / 8)
					f.Estimated = true
				}
			}
		}
	}

	rank := func(codec string) int {
		if strings.Contains(codec, "avc1") {
			return 0
		}
		if strings.Contains(codec, "av01") {
			return 1
		}
		if strings.Contains(codec, "vp9") || strings.Contains(codec, "vp09") {
			return 2
		}
		return 3
	}
	sort.SliceStable(out.Muxed, func(i, j int) bool {
		a, b := out.Muxed[i], out.Muxed[j]
		return a.Height > b.Height || (a.Height == b.Height && a.Bitrate > b.Bitrate)
	})
	sort.SliceStable(out.Video, func(i, j int) bool {
		a, b := out.Video[i], out.Video[j]
		if a.Height != b.Height {
			return a.Height > b.Height
		}
		if a.FPS != b.FPS {
			return a.FPS > b.FPS
		}
		if rank(a.Codec) != rank(b.Codec) {
			return rank(a.Codec) < rank(b.Codec)
		}
		return a.Bitrate > b.Bitrate
	})
	sort.SliceStable(out.Audio, func(i, j int) bool {
		a, b := out.Audio[i], out.Audio[j]
		amp4 := strings.Contains(a.Mime, "mp4")
		bmp4 := strings.Contains(b.Mime, "mp4")
		if amp4 != bmp4 {
			return !amp4
		}
		return a.Bitrate > b.Bitrate
	})

	// 同解像度・同fpsは最佳コーデック1本に絞る
	type hk struct{ h, fps int }
	byH := map[hk]format{}
	var order []hk
	for _, v := range out.Video {
		k := hk{v.Height, v.FPS}
		if cur, ok := byH[k]; !ok || rank(v.Codec) < rank(cur.Codec) {
			if !ok {
				order = append(order, k)
			}
			byH[k] = v
		}
	}
	out.Video = nil
	for _, k := range order {
		out.Video = append(out.Video, byH[k])
	}
	if out.Video == nil {
		out.Video = []format{}
	}
	return out
}

func toMapSlice(v any) []map[string]any {
	list, ok := v.([]any)
	if !ok {
		return nil
	}
	var out []map[string]any
	for _, item := range list {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// APIHandler: /api/player と /api/stream をGoで処理する
func APIHandler(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/api/player":
		handlePlayer(w, r)
	case "/api/stream":
		handleStream(w, r)
	default:
		http.NotFound(w, r)
	}
}

func handlePlayer(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	id := parseVideoID(r.URL.Query().Get("url"))
	if id == "" {
		id = parseVideoID(r.URL.Query().Get("v"))
	}
	if id == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "有効なYouTubeのURLまたはvideoIdを指定してください"})
		return
	}

	visitor, _ := getVisitorData(id)
	type result struct {
		key  string
		data map[string]any
		err  error
	}
	results := make(chan result, len(clients))
	for _, c := range clients {
		go func(c clientDef) {
			data, err := callPlayer(c, id, visitor)
			results <- result{c.Key, data, err}
		}(c)
	}
	players := map[string]map[string]any{}
	diag := make([]string, 0, len(clients))
	for i := 0; i < len(clients); i++ {
		res := <-results
		if res.err != nil {
			diag = append(diag, res.key+":"+res.err.Error())
			continue
		}
		st := "?"
		if ps, ok := res.data["playabilityStatus"].(map[string]any); ok {
			if s := str(ps, "status"); s != "" {
				st = s
			}
		}
		diag = append(diag, res.key+":"+st)
		players[res.key] = res.data
	}

	if len(players) == 0 {
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "InnerTubeが拒否しました (" + strings.Join(diag, ", ") + ")",
		})
		return
	}

	out := collect(players)
	out.Diag = strings.Join(diag, ", ")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(out)
}

// googlevideoは映像のみ/音声のみのURLで、1接続を続けると途中から
// 数十KB/sに絞られる。そのため1リクエストの中継ではなく、
// chunkSizeごとにRangeリクエストを張り直して高速を保つ。
const streamChunkSize = 4 << 20

func handleStream(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("url")
	if target == "" {
		http.Error(w, `{"error":"url required"}`, http.StatusBadRequest)
		return
	}
	if !strings.Contains(target, "googlevideo.com/") {
		http.Error(w, `{"error":"googlevideo.com のURLのみ中継できます"}`, http.StatusBadRequest)
		return
	}

	// クライアントのRange(あれば)から開始位置と総サイズを得る。
	// Range未指定なら先頭から。
	start := int64(0)
	if rg := r.Header.Get("Range"); rg != "" {
		var endPart int64
		if n, _ := fmt.Sscanf(rg, "bytes=%d-%d", &start, &endPart); n < 1 {
			http.Error(w, `{"error":"unsupported range"}`, http.StatusBadRequest)
			return
		}
	}
	probe, err := http.NewRequest("GET", target, nil)
	if err != nil {
		http.Error(w, `{"error":"invalid url"}`, http.StatusBadRequest)
		return
	}
	probe.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, start))
	presp, err := streamClient.Do(probe)
	if err != nil {
		http.Error(w, `{"error":"upstream fetch failed"}`, http.StatusBadGateway)
		return
	}
	io.Copy(io.Discard, io.LimitReader(presp.Body, 1<<20))
	presp.Body.Close()
	if presp.StatusCode != 200 && presp.StatusCode != 206 {
		detail := ""
		if u, err := neturl.Parse(target); err == nil {
			detail = "itag=" + u.Query().Get("itag")
		}
		http.Error(w, fmt.Sprintf(`{"error":"googlevideo HTTP %d (%s)。URL期限切れの可能性があるため再取得します"}`,
			presp.StatusCode, detail), presp.StatusCode)
		return
	}
	total := parseStreamTotal(presp.Header.Get("Content-Range"))
	if total <= 0 {
		// Content-Rangeが取れない環境では従来の単一接続にフォールバック
		relaySingle(w, r, target)
		return
	}

	ct := presp.Header.Get("Content-Type")
	if start > 0 || r.Header.Get("Range") != "" {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, total-1, total))
		w.Header().Set("Content-Length", fmt.Sprintf("%d", total-start))
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("Content-Type", ct)
		w.WriteHeader(http.StatusPartialContent)
	} else {
		w.Header().Set("Content-Type", ct)
		w.Header().Set("Content-Length", fmt.Sprintf("%d", total))
		w.Header().Set("Accept-Ranges", "bytes")
		w.WriteHeader(http.StatusOK)
	}
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}

	buf := make([]byte, 64<<10)
	off := start
	for off < total {
		end := off + streamChunkSize - 1
		if end >= total {
			end = total - 1
		}
		req, _ := http.NewRequest("GET", target, nil)
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", off, end))
		resp, err := streamClient.Do(req)
		if err != nil {
			return // クライアント中断の可能性が高い
		}
		if resp.StatusCode != 200 && resp.StatusCode != 206 {
			io.Copy(io.Discard, io.LimitReader(resp.Body, 256))
			resp.Body.Close()
			return
		}
		n, _ := io.CopyBuffer(w, resp.Body, buf)
		resp.Body.Close()
		if n <= 0 {
			return
		}
		off += n
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}
}

// "bytes 0-0/12345" の総サイズ部分を取り出す
func parseStreamTotal(cr string) int64 {
	i := strings.LastIndex(cr, "/")
	if i < 0 {
		return 0
	}
	var t int64
	fmt.Sscanf(cr[i+1:], "%d", &t)
	return t
}

// relaySingle: Range非対応の場合の従来動作(1接続の中継)
func relaySingle(w http.ResponseWriter, r *http.Request, target string) {
	req, err := http.NewRequest("GET", target, nil)
	if err != nil {
		http.Error(w, `{"error":"invalid url"}`, http.StatusBadRequest)
		return
	}
	if rg := r.Header.Get("Range"); rg != "" {
		req.Header.Set("Range", rg)
	}
	resp, err := streamClient.Do(req)
	if err != nil {
		http.Error(w, `{"error":"upstream fetch failed"}`, http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 && resp.StatusCode != 206 {
		detail := ""
		if u, err := neturl.Parse(target); err == nil {
			detail = "itag=" + u.Query().Get("itag")
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		http.Error(w, fmt.Sprintf(`{"error":"googlevideo HTTP %d (%s)。URL期限切れの可能性があるため再取得します","body":%q}`,
			resp.StatusCode, detail, string(body)), resp.StatusCode)
		return
	}
	for _, h := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"} {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	io.Copy(w, resp.Body)
}
