package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	ctrl "sigs.k8s.io/controller-runtime"
)

var (
	analyticsURL     string
	serviceAuthToken string
	clusterName      string
)

const (
	endSessionMaxAttempts = 3
	endSessionRetryDelay  = 250 * time.Millisecond
)

func initAnalytics() {
	log := ctrl.Log.WithName("analytics")

	// Get control-plane URL.
	analyticsURL = os.Getenv("CONTROL_PLANE_URL")
	if analyticsURL == "" {
		analyticsURL = "http://control-plane.default.svc.cluster.local:3000"
	}

	// Get cluster name
	clusterName = os.Getenv("CLUSTER_NAME")
	if clusterName == "" {
		clusterName = "unknown"
	}

	// Get service auth token from environment.
	serviceAuthToken = os.Getenv("CONTROL_PLANE_SERVICE_AUTH_TOKEN")
	tokenLength := len(serviceAuthToken)

	log.Info("Analytics initialized",
		"url", analyticsURL,
		"clusterName", clusterName,
		"tokenLength", tokenLength,
		"hasToken", tokenLength > 0)
}

type EndSessionRequest struct {
	Status string `json:"status"`
}

// reportExpiry reports an expiry event using session ID from GameServer annotations
func reportExpiry(ctx context.Context, gameServerName string, sessionID string) {
	log := ctrl.LoggerFrom(ctx)

	if sessionID == "" {
		log.V(1).Info("No session ID found for GameServer", "gameServer", gameServerName)
		return
	}

	// Report session end with "expired" status
	go func() {
		attempts, err := endSessionWithRetry(
			http.DefaultClient,
			analyticsURL,
			serviceAuthToken,
			sessionID,
			"expired",
			endSessionMaxAttempts,
			endSessionRetryDelay,
		)
		if err != nil {
			log.Error(err, "Failed to send expiry event", "sessionId", sessionID)
		} else {
			log.Info("Reported session expiry", "sessionId", sessionID, "gameServer", gameServerName, "attempts", attempts)
		}
	}()
}

// postSessionEnd posts one session-end attempt. The boolean indicates whether a
// retry can reasonably succeed (network errors, rate limits, and server errors).
func postSessionEnd(client *http.Client, baseURL string, authToken string, sessionID string, status string) (bool, error) {
	reqBody := EndSessionRequest{Status: status}
	body, err := json.Marshal(reqBody)
	if err != nil {
		return false, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	url := fmt.Sprintf("%s/sessions/%s/end", baseURL, sessionID)
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return false, err
	}

	req.Header.Set("Content-Type", "application/json")
	if authToken != "" {
		req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", authToken))
	}

	resp, err := client.Do(req)
	if err != nil {
		return true, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		retryable := resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= http.StatusInternalServerError
		return retryable, fmt.Errorf("control plane returned status %d", resp.StatusCode)
	}

	return false, nil
}

// endSessionWithRetry makes a small bounded number of attempts so a transient
// control-plane or network failure does not leave a session permanently active.
func endSessionWithRetry(
	client *http.Client,
	baseURL string,
	authToken string,
	sessionID string,
	status string,
	maxAttempts int,
	retryDelay time.Duration,
) (int, error) {
	if maxAttempts < 1 {
		maxAttempts = 1
	}

	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		retryable, err := postSessionEnd(client, baseURL, authToken, sessionID, status)
		if err == nil {
			return attempt, nil
		}
		lastErr = err
		if !retryable || attempt == maxAttempts {
			return attempt, lastErr
		}
		if retryDelay > 0 {
			time.Sleep(retryDelay * time.Duration(1<<(attempt-1)))
		}
	}

	return maxAttempts, lastErr
}
