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
	analyticsURL    string
	serviceAuthToken string
	clusterName     string
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
		if err := endSession(sessionID, "expired"); err != nil {
			log.Error(err, "Failed to send expiry event", "sessionId", sessionID)
		} else {
			log.Info("Reported session expiry", "sessionId", sessionID, "gameServer", gameServerName)
		}
	}()
}

// endSession posts a session end event to the control plane
func endSession(sessionID string, status string) error {
	reqBody := EndSessionRequest{Status: status}
	body, err := json.Marshal(reqBody)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	url := fmt.Sprintf("%s/sessions/%s/end", analyticsURL, sessionID)
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return err
	}

	req.Header.Set("Content-Type", "application/json")
	if serviceAuthToken != "" {
		req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", serviceAuthToken))
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("control plane returned status %d", resp.StatusCode)
	}

	return nil
}
