//go:build ignore

// アプリアイコン(icon.ico)を生成するツール。
// 使い方: go run tools/gen_icon/main.go
// 出力: build/windows/icon.ico (256x256 PNG内包ICO)
package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
)

func main() {
	const size = 256
	img := image.NewRGBA(image.Rect(0, 0, size, size))

	// 背景の角丸四角形(紫→青の2色でシンプルに塗り分け)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			if !inRoundedRect(x, y, size) {
				continue
			}
			// 上→下で紫(#7C5CFF)から青(#3B82F6)へのグラデーション
			t := float64(y) / float64(size)
			r := uint8(0x7C + (0x3B-0x7C)*t)
			g := uint8(0x5C + (0x82-0x5C)*t)
			b := uint8(0xFF + (0xF6-0xFF)*t)
			img.Set(x, y, color.RGBA{r, g, b, 255})
		}
	}

	// 白いダウンロード矢印(↓)を中央に描く
	arrowCol := color.RGBA{255, 255, 255, 255}
	// 縦のシャフト: x 108..148, y 52..150
	fillRect(img, 108, 52, 148, 150, arrowCol)
	// 矢印の頭(三角形): 頂点(128,204), 左(72,140), 右(184,140)
	fillTriangle(img, 128, 204, 72, 140, 184, 140, arrowCol)

	var pngBuf bytes.Buffer
	if err := png.Encode(&pngBuf, img); err != nil {
		panic(err)
	}

	// ICOコンテナ(1エントリ、PNG内包)
	var ico bytes.Buffer
	ico.Write([]byte{0, 0, 1, 0, 1, 0}) // ICONDIR: reserved=0, type=1(icon), count=1
	entry := make([]byte, 16)
	entry[0] = 0 // 幅256
	entry[1] = 0 // 高さ256
	entry[4] = 1 // planes
	entry[6] = 32
	binary.LittleEndian.PutUint32(entry[8:], uint32(pngBuf.Len()))
	binary.LittleEndian.PutUint32(entry[12:], 22) // ヘッダ直後
	ico.Write(entry)
	ico.Write(pngBuf.Bytes())

	out := filepath.Join("build", "windows", "icon.ico")
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		panic(err)
	}
	if err := os.WriteFile(out, ico.Bytes(), 0o644); err != nil {
		panic(err)
	}
	println("wrote", out, ico.Len(), "bytes")
}

func inRoundedRect(x, y, size int) bool {
	const r = 48
	if x < r && y < r {
		return dist2(x-r, y-r) <= r*r
	}
	if x >= size-r && y < r {
		return dist2(x-(size-r), y-r) <= r*r
	}
	if x < r && y >= size-r {
		return dist2(x-r, y-(size-r)) <= r*r
	}
	if x >= size-r && y >= size-r {
		return dist2(x-(size-r), y-(size-r)) <= r*r
	}
	return true
}

func dist2(dx, dy int) int {
	return dx*dx + dy*dy
}

func fillRect(img *image.RGBA, x0, y0, x1, y1 int, c color.RGBA) {
	for y := y0; y < y1; y++ {
		for x := x0; x < x1; x++ {
			img.Set(x, y, c)
		}
	}
}

func fillTriangle(img *image.RGBA, ax, ay, bx, by, cx, cy int, c color.RGBA) {
	minX, maxX := min3(ax, bx, cx), max3(ax, bx, cx)
	minY, maxY := min3(ay, by, cy), max3(ay, by, cy)
	for y := minY; y <= maxY; y++ {
		for x := minX; x <= maxX; x++ {
			if pointInTriangle(x, y, ax, ay, bx, by, cx, cy) {
				img.Set(x, y, c)
			}
		}
	}
}

func pointInTriangle(px, py, ax, ay, bx, by, cx, cy int) bool {
	d1 := sign(px, py, ax, ay, bx, by)
	d2 := sign(px, py, bx, by, cx, cy)
	d3 := sign(px, py, cx, cy, ax, ay)
	hasNeg := d1 < 0 || d2 < 0 || d3 < 0
	hasPos := d1 > 0 || d2 > 0 || d3 > 0
	return !(hasNeg && hasPos)
}

func sign(px, py, ax, ay, bx, by int) int {
	v := (px-bx)*(ay-by) - (ax-bx)*(py-by)
	if v > 0 {
		return 1
	} else if v < 0 {
		return -1
	}
	return 0
}

func min3(a, b, c int) int {
	m := a
	if b < m {
		m = b
	}
	if c < m {
		m = c
	}
	return m
}
func max3(a, b, c int) int {
	m := a
	if b > m {
		m = b
	}
	if c > m {
		m = c
	}
	return m
}
