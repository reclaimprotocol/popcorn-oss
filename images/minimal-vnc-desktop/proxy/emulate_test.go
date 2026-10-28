package main

import (
	"testing"
	"time"
)

func awake(e *emulator) bool {
	select {
	case <-e.awake:
		return true
	default:
		return false
	}
}

func TestEmulatorAttachesAtStartByDefault(t *testing.T) {
	t.Setenv("MVD_EMULATOR_OFF", "0")
	t.Setenv("MVD_EMULATOR_ON_VIEWER", "")
	if em := newEmulator("127.0.0.1:1"); !awake(em) {
		t.Fatal("emulator waits for a viewer without MVD_EMULATOR_ON_VIEWER")
	}
}

func TestEmulatorWaitsForFirstViewer(t *testing.T) {
	t.Setenv("MVD_EMULATOR_OFF", "0")
	t.Setenv("MVD_EMULATOR_ON_VIEWER", "1")
	em := newEmulator("127.0.0.1:1")
	if awake(em) {
		t.Fatal("emulator attached before any viewer")
	}
	k := newScreenKeeper(time.Hour, nil)
	k.onConnect = em.wake
	k.connect(true)
	if !awake(em) {
		t.Fatal("first viewer did not wake the emulator")
	}
	k.connect(true)
	em.wake()
}

func TestEmulatorWakesOnViewerSize(t *testing.T) {
	t.Setenv("MVD_EMULATOR_OFF", "0")
	t.Setenv("MVD_EMULATOR_ON_VIEWER", "1")
	em := newEmulator("127.0.0.1:1")
	em.set(emulateRequest{Width: 390, Height: 844, DeviceScaleFactor: 1})
	if !awake(em) {
		t.Fatal("a viewer's size did not wake the emulator")
	}
}
