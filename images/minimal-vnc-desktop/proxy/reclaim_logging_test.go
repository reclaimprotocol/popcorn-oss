package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/reclaimprotocol/reclaim-tee/client"
	"go.uber.org/zap"
)

func TestReclaimLibraryLoggerForwardsRecordsUnchanged(t *testing.T) {
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
	libraryLogger.Debug(
		"Complete HTTP request before redaction",
		zap.String("request", "Cookie: debug-secret-cookie"),
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
		`"request":"Authorization: secret-token"`,
		`"http_start":"Set-Cookie: secret-cookie"`,
		`"url":"https://private.example/account"`,
		`"error":"remote response contained secret-body"`,
		`"msg":"Decrypted HTTP preview"`,
		`"http_start":"Set-Cookie: another-secret-cookie"`,
		`"msg":"Complete HTTP request before redaction"`,
		`"request":"Cookie: debug-secret-cookie"`,
		`"msg":"Failed to start HTTP request"`,
		`"error":"request contained another-secret-token"`,
	} {
		if !strings.Contains(output, expected) {
			t.Fatalf("missing library log field %s: %s", expected, output)
		}
	}
}
