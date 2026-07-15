package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/reclaimprotocol/reclaim-tee/client"
	"go.uber.org/zap"
)

func TestReclaimLibraryLoggerExportsSafeEvents(t *testing.T) {
	var logs bytes.Buffer
	logger := newReclaimLogger(&logs)
	client.SetSharedLogger(logger)
	defer client.SetSharedLogger(reclaimLogger)

	libraryLogger := client.GetLogger("libreclaim", false)
	libraryLogger.Info(
		"Protocol progress",
		zap.String("requestId", "req-1"),
		zap.String("from", "Handshaking"),
		zap.String("to", "CollectingResponses"),
		zap.Int("progress_percentage", 20),
		zap.String("progress_description", "Sending HTTP request and collecting responses"),
		zap.String("request", "Authorization: secret-token"),
		zap.ByteString("http_start", []byte("Set-Cookie: secret-cookie")),
		zap.String("url", "https://private.example/account"),
		zap.Error(errors.New("remote response contained secret-body")),
	)
	libraryLogger.Info(
		"Decrypted HTTP preview",
		zap.ByteString("http_start", []byte("Set-Cookie: another-secret-cookie")),
	)
	libraryLogger.Error(
		"Failed to start HTTP request",
		zap.Error(errors.New("request contained another-secret-token")),
	)

	output := logs.String()
	for _, expected := range []string{
		`"msg":"Protocol progress"`,
		`"service":"libreclaim"`,
		`"requestId":"req-1"`,
		`"progress_percentage":20`,
		`"progress_description":"Sending HTTP request and collecting responses"`,
		`"msg":"Decrypted HTTP preview"`,
		`"msg":"Failed to start HTTP request"`,
	} {
		if !strings.Contains(output, expected) {
			t.Fatalf("missing safe library log field %s: %s", expected, output)
		}
	}
	for _, secret := range []string{
		"secret-token",
		"secret-cookie",
		"private.example",
		"secret-body",
		"another-secret-cookie",
		"another-secret-token",
		`"request"`,
		`"http_start"`,
		`"url"`,
		`"error":`,
	} {
		if strings.Contains(output, secret) {
			t.Fatalf("exported sensitive library log field %q: %s", secret, output)
		}
	}
}
