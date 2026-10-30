package main

import "testing"

// A fit taller than the browser window paints at a reduced scale, and CDP reads
// input in the scaled view's pixels: a tap the viewer maps to page CSS (801,854)
// must be sent at (801,854)*scale, or it lands at (1579,1683) on a 0.507 paint.
func TestPaintScaleScalesInput(t *testing.T) {
	e := &emulator{}
	if k := e.paintScale(); k != 1 {
		t.Fatalf("no emulation: scale %v, want 1", k)
	}
	e.params = &emulateRequest{Width: 980, Height: 2129, DeviceScaleFactor: 1, Scale: 1080.0 / 2129}
	if k := e.paintScale(); k != 1080.0/2129 {
		t.Fatalf("scale %v, want %v", k, 1080.0/2129)
	}
	for in, want := range map[float64]float64{0: 1, 1: 1, 1.5: 1, 0.05: 0.2, 0.5: 0.5} {
		if got := clampPaintScale(in); got != want {
			t.Errorf("clampPaintScale(%v) = %v, want %v", in, got, want)
		}
	}
	e.params = &emulateRequest{Reset: true, Scale: 0.5}
	if k := e.paintScale(); k != 1 {
		t.Fatalf("reset: scale %v, want 1", k)
	}
}
