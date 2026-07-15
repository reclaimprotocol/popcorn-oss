package main

import (
	"io"
	"os"

	"github.com/reclaimprotocol/reclaim-tee/client"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

var reclaimLogger = newReclaimLogger(os.Stdout)

func installReclaimLibraryLogger() {
	client.SetSharedLogger(reclaimLogger)
}

func newReclaimLogger(output io.Writer) *zap.Logger {
	encoderConfig := zap.NewProductionEncoderConfig()
	encoderConfig.TimeKey = "timestamp"
	encoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder

	core := zapcore.NewCore(
		zapcore.NewJSONEncoder(encoderConfig),
		zapcore.AddSync(output),
		zapcore.DebugLevel,
	)
	return zap.New(core)
}
