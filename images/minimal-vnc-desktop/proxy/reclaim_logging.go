package main

import (
	"io"
	"os"

	"github.com/reclaimprotocol/reclaim-tee/client"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

var reclaimLogger = newReclaimLogger(os.Stdout)

var safeReclaimStringFields = map[string]struct{}{
	"cipher":               {},
	"cipher_suite":         {},
	"current_phase":        {},
	"description":          {},
	"from":                 {},
	"identifier":           {},
	"outcome":              {},
	"phase":                {},
	"progress_description": {},
	"provider":             {},
	"requestId":            {},
	"request_id":           {},
	"service":              {},
	"source":               {},
	"status":               {},
	"to":                   {},
	"type":                 {},
}

func installReclaimLibraryLogger() {
	client.SetSharedLogger(reclaimLogger)
}

func newReclaimLogger(output io.Writer) *zap.Logger {
	encoderConfig := zap.NewProductionEncoderConfig()
	encoderConfig.TimeKey = "timestamp"
	encoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder

	baseCore := zapcore.NewCore(
		zapcore.NewJSONEncoder(encoderConfig),
		zapcore.AddSync(output),
		zapcore.InfoLevel,
	)
	return zap.New(&safeReclaimCore{Core: baseCore})
}

// safeReclaimCore keeps the library's event stream while preventing payloads,
// URLs, errors, and cryptographic material from reaching container logs.
type safeReclaimCore struct {
	zapcore.Core
}

func (c *safeReclaimCore) With(fields []zapcore.Field) zapcore.Core {
	return &safeReclaimCore{Core: c.Core.With(safeReclaimFields(fields))}
}

func (c *safeReclaimCore) Check(entry zapcore.Entry, checked *zapcore.CheckedEntry) *zapcore.CheckedEntry {
	if c.Enabled(entry.Level) {
		return checked.AddCore(entry, c)
	}
	return checked
}

func (c *safeReclaimCore) Write(entry zapcore.Entry, fields []zapcore.Field) error {
	return c.Core.Write(entry, safeReclaimFields(fields))
}

func safeReclaimFields(fields []zapcore.Field) []zapcore.Field {
	safe := make([]zapcore.Field, 0, len(fields))
	for _, field := range fields {
		switch field.Type {
		case zapcore.BoolType,
			zapcore.DurationType,
			zapcore.Float32Type,
			zapcore.Float64Type,
			zapcore.Int8Type,
			zapcore.Int16Type,
			zapcore.Int32Type,
			zapcore.Int64Type,
			zapcore.Uint8Type,
			zapcore.Uint16Type,
			zapcore.Uint32Type,
			zapcore.Uint64Type,
			zapcore.UintptrType:
			safe = append(safe, field)
		case zapcore.StringType:
			if _, ok := safeReclaimStringFields[field.Key]; ok {
				safe = append(safe, field)
			}
		}
	}
	return safe
}
