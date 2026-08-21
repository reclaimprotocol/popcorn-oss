package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	agonesv1 "agones.dev/agones/pkg/apis/agones/v1"
	ctrl "sigs.k8s.io/controller-runtime"
)

// viewerRttSummary mirrors the proxy's GET /rtstats response; field names match
// the control plane's normalizeViewerRttSummary contract, so it forwards as-is.
type viewerRttSummary struct {
	SampleCount int     `json:"sampleCount"`
	AvgMs       float64 `json:"avgMs"`
	P50Ms       float64 `json:"p50Ms"`
	P95Ms       float64 `json:"p95Ms"`
	MaxMs       float64 `json:"maxMs"`
}

const viewerStatsTimeout = 3 * time.Second

// viewerStatsPort mirrors pool-manager's browserRoutePort: the proxy serves on
// the "novnc" port, 6080 when Agones reports no named port.
func viewerStatsPort(gs *agonesv1.GameServer) int32 {
	for _, p := range gs.Status.Ports {
		if p.Name == "novnc" {
			return p.Port
		}
	}
	return 6080
}

// fetchViewerRtt reads the pod's cumulative RTT aggregate. (nil, nil) means
// nothing to record: sessions nobody viewed and pod images predating the
// endpoint both surface as 404.
func fetchViewerRtt(client *http.Client, podBaseURL string, sessionID string) (*viewerRttSummary, error) {
	ctx, cancel := context.WithTimeout(context.Background(), viewerStatsTimeout)
	defer cancel()

	reqURL := fmt.Sprintf("%s/rtstats?sid=%s", podBaseURL, url.QueryEscape(sessionID))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusMethodNotAllowed {
		return nil, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("pod returned status %d", resp.StatusCode)
	}
	var sum viewerRttSummary
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&sum); err != nil {
		return nil, err
	}
	if sum.SampleCount < 1 {
		return nil, nil
	}
	return &sum, nil
}

func postViewerStats(client *http.Client, baseURL string, authToken string, sessionID string, sum *viewerRttSummary) error {
	body, err := json.Marshal(sum)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), viewerStatsTimeout)
	defer cancel()

	reqURL := fmt.Sprintf("%s/sessions/%s/viewer-stats", baseURL, url.PathEscape(sessionID))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if authToken != "" {
		req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", authToken))
	}

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("control plane returned status %d", resp.StatusCode)
	}
	return nil
}

// forwardViewerRtt ships the pod's viewer-measured RTT aggregate to the control
// plane. The pod fetch runs synchronously before the caller deletes the
// GameServer (the aggregate lives only in pod memory); the control-plane POST
// is fire-and-forget like reportExpiry. Telemetry loss never blocks expiry.
func forwardViewerRtt(ctx context.Context, gs *agonesv1.GameServer, sessionID string) {
	log := ctrl.LoggerFrom(ctx)

	if sessionID == "" || gs.Status.Address == "" {
		return
	}
	podBaseURL := fmt.Sprintf("http://%s:%d", gs.Status.Address, viewerStatsPort(gs))
	sum, err := fetchViewerRtt(http.DefaultClient, podBaseURL, sessionID)
	if err != nil {
		log.V(1).Info("Could not read viewer RTT from pod", "sessionId", sessionID, "error", err.Error())
		return
	}
	if sum == nil {
		return
	}

	go func() {
		if err := postViewerStats(http.DefaultClient, analyticsURL, serviceAuthToken, sessionID, sum); err != nil {
			log.Error(err, "Failed to forward viewer RTT summary", "sessionId", sessionID)
		} else {
			log.Info("Forwarded viewer RTT summary", "sessionId", sessionID, "samples", sum.SampleCount)
		}
	}()
}
