package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const websocketGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

func main() {
	listen := flag.String("listen", envDefault("NOVNC_LISTEN", ":6080"), "HTTP listen address")
	vnc := flag.String("vnc", envDefault("VNC_ADDR", "127.0.0.1:5900"), "upstream VNC address")
	web := flag.String("web", envDefault("NOVNC_WEB_ROOT", "/usr/share/novnc"), "noVNC static web root")
	readyFile := flag.String("ready-file", envDefault("READY_FILE", ""), "optional file that must exist before serving noVNC")
	cdpUpstream := flag.String("cdp-upstream", envDefault("CDP_UPSTREAM_ADDR", "127.0.0.1:9223"), "upstream Chromium DevTools HTTP address")
	cdpRestrictedListen := flag.String("cdp-restricted-listen", envDefault("CDP_RESTRICTED_LISTEN", "0.0.0.0:9222"), "restricted CDP proxy listen address; empty disables it")
	cdpFullListen := flag.String("cdp-full-listen", envDefault("CDP_FULL_LISTEN", "0.0.0.0:9226"), "full CDP proxy listen address; empty disables it")
	reclaimAPIListen := flag.String("reclaim-api-listen", envDefault("RECLAIM_API_LISTEN", "0.0.0.0:10001"), "dedicated reclaim API listen address (matches popcorn-images kernel-images-api port); empty disables it")
	flag.Parse()

	ready := readyGate{file: *readyFile}
	servers := []*http.Server{
		{
			Addr:              *listen,
			Handler:           noVNCMux(*web, *vnc, ready),
			ReadHeaderTimeout: 5 * time.Second,
		},
	}

	if strings.TrimSpace(*reclaimAPIListen) != "" {
		servers = append(servers, &http.Server{
			Addr:              *reclaimAPIListen,
			Handler:           reclaimAPIMux(),
			ReadHeaderTimeout: 5 * time.Second,
		})
	}

	if strings.TrimSpace(*cdpRestrictedListen) != "" {
		servers = append(servers, &http.Server{
			Addr:              *cdpRestrictedListen,
			Handler:           cdpMux(*cdpUpstream, true, ready),
			ReadHeaderTimeout: 5 * time.Second,
		})
	}
	if strings.TrimSpace(*cdpFullListen) != "" {
		servers = append(servers, &http.Server{
			Addr:              *cdpFullListen,
			Handler:           cdpMux(*cdpUpstream, false, ready),
			ReadHeaderTimeout: 5 * time.Second,
		})
	}

	errs := make(chan error, len(servers))
	for _, server := range servers {
		server := server
		log.Printf("listening on %s", server.Addr)
		go func() {
			if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				errs <- err
			}
		}()
	}

	log.Printf("serving noVNC from %s on %s, proxying /websockify to %s", *web, *listen, *vnc)
	if strings.TrimSpace(*cdpRestrictedListen) != "" {
		log.Printf("serving restricted CDP on %s, proxying to %s", *cdpRestrictedListen, *cdpUpstream)
	}
	if strings.TrimSpace(*cdpFullListen) != "" {
		log.Printf("serving full CDP on %s, proxying to %s", *cdpFullListen, *cdpUpstream)
	}
	if strings.TrimSpace(*reclaimAPIListen) != "" {
		log.Printf("serving reclaim API on %s", *reclaimAPIListen)
	}

	log.Fatal(<-errs)
}

// registerReclaimRoutes wires the reclaim HTTP endpoints onto mux. Shared by the
// noVNC surface (6080) and the dedicated reclaim API listener (10001) so both
// expose the same handlers.
func registerReclaimRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/reclaim/prove", reclaimProveHTTPHandler)
	mux.HandleFunc("/reclaim/validate", reclaimValidateExtractionHTTPHandler)
	mux.HandleFunc("/reclaim/validate-extraction", reclaimValidateExtractionHTTPHandler)
}

func reclaimAPIMux() http.Handler {
	mux := http.NewServeMux()
	registerReclaimRoutes(mux)
	return mux
}

func noVNCMux(web, vnc string, ready readyGate) http.Handler {
	mux := http.NewServeMux()
	registerReclaimRoutes(mux)
	mux.HandleFunc("/websockify", func(w http.ResponseWriter, r *http.Request) {
		serveWebsocket(w, r, vnc, ready)
	})
	mux.HandleFunc("/vnc-ws/", func(w http.ResponseWriter, r *http.Request) {
		serveWebsocket(w, r, vnc, ready)
	})
	mux.HandleFunc("/liveview-ws/", func(w http.ResponseWriter, r *http.Request) {
		serveWebsocket(w, r, vnc, ready)
	})
	mux.HandleFunc("/", staticHandler(web, ready))
	return mux
}

func envDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

type readyGate struct {
	file string
}

func (g readyGate) ready() bool {
	if g.file == "" {
		return true
	}
	_, err := os.Stat(g.file)
	return err == nil
}

func serveWebsocket(w http.ResponseWriter, r *http.Request, upstream string, ready readyGate) {
	if !ready.ready() {
		http.Error(w, "app is not ready", http.StatusServiceUnavailable)
		return
	}
	proxyWebsocket(w, r, upstream)
}

func staticHandler(root string, ready readyGate) http.HandlerFunc {
	files := http.FileServer(http.Dir(root))
	return func(w http.ResponseWriter, r *http.Request) {
		if !ready.ready() {
			http.Error(w, "app is not ready", http.StatusServiceUnavailable)
			return
		}
		if r.URL.Path == "/" {
			http.Redirect(w, r, "/liveview.html", http.StatusFound)
			return
		}
		clean := filepath.Clean(r.URL.Path)
		if clean == "/websockify" {
			http.NotFound(w, r)
			return
		}
		files.ServeHTTP(w, r)
	}
}

func cdpMux(upstream string, restricted bool, ready readyGate) http.Handler {
	handler := &cdpHandler{
		upstream:   upstream,
		restricted: restricted,
		ready:      ready,
		allowed:    allowedCDPCommands(),
		client: &http.Client{
			Timeout: 5 * time.Second,
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", handler.serve)
	return mux
}

type cdpHandler struct {
	upstream   string
	restricted bool
	ready      readyGate
	allowed    map[string]bool
	client     *http.Client
}

func (h *cdpHandler) serve(w http.ResponseWriter, r *http.Request) {
	setCDPHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	if !h.ready.ready() {
		http.Error(w, "app is not ready", http.StatusServiceUnavailable)
		return
	}

	if isWebsocketRequest(r) {
		h.proxyWebsocket(w, r)
		return
	}

	path := strings.TrimSuffix(r.URL.Path, "/")
	switch path {
	case "/json/version":
		h.proxyJSON(w, r, "/json/version")
	case "/json", "/json/list":
		h.proxyJSON(w, r, "/json")
	default:
		http.NotFound(w, r)
	}
}

func setCDPHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "*")
}

func (h *cdpHandler) proxyJSON(w http.ResponseWriter, r *http.Request, chromePath string) {
	upstreamURL := h.httpURL(chromePath)
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, upstreamURL, nil)
	if err != nil {
		http.Error(w, "failed to build browser request", http.StatusInternalServerError)
		return
	}

	resp, err := h.client.Do(req)
	if err != nil {
		http.Error(w, "failed to fetch from browser", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		http.Error(w, fmt.Sprintf("browser returned status %d", resp.StatusCode), http.StatusBadGateway)
		return
	}

	var raw any
	decoder := json.NewDecoder(io.LimitReader(resp.Body, 16*1024*1024))
	if err := decoder.Decode(&raw); err != nil {
		http.Error(w, "failed to parse browser response", http.StatusBadGateway)
		return
	}

	rewriteChromeURLs(raw, h.host(), externalCDPURLFromRequest(r))
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(raw)
}

func (h *cdpHandler) proxyWebsocket(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	if key == "" {
		http.Error(w, "missing Sec-WebSocket-Key", http.StatusBadRequest)
		return
	}

	upstreamURL, err := h.websocketURL(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	upstreamConn, upstreamReader, err := dialWebsocket(upstreamURL)
	if err != nil {
		http.Error(w, fmt.Sprintf("failed to connect to CDP upstream: %v", err), http.StatusBadGateway)
		return
	}

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		_ = upstreamConn.Close()
		http.Error(w, "hijacking unsupported", http.StatusInternalServerError)
		return
	}

	clientConn, rw, err := hijacker.Hijack()
	if err != nil {
		_ = upstreamConn.Close()
		return
	}

	_, _ = fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\n")
	_, _ = fmt.Fprintf(rw, "Upgrade: websocket\r\n")
	_, _ = fmt.Fprintf(rw, "Connection: Upgrade\r\n")
	_, _ = fmt.Fprintf(rw, "Sec-WebSocket-Accept: %s\r\n", websocketAccept(key))
	_, _ = fmt.Fprint(rw, "\r\n")
	_ = rw.Flush()

	bridge := &cdpBridge{
		client:         clientConn,
		clientReader:   rw.Reader,
		upstream:       upstreamConn,
		upstreamReader: upstreamReader,
		restricted:     h.restricted,
		allowed:        h.allowed,
	}
	bridge.run()
}

func (h *cdpHandler) websocketURL(r *http.Request) (string, error) {
	path := r.URL.Path
	rawQuery := r.URL.RawQuery
	if !strings.HasPrefix(path, "/devtools/") {
		versionURL := h.httpURL("/json/version")
		resp, err := h.client.Get(versionURL)
		if err != nil {
			return "", err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return "", fmt.Errorf("browser returned status %d", resp.StatusCode)
		}
		var payload struct {
			WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
		}
		if err := json.NewDecoder(io.LimitReader(resp.Body, 2*1024*1024)).Decode(&payload); err != nil {
			return "", err
		}
		if payload.WebSocketDebuggerURL == "" {
			return "", fmt.Errorf("browser response missing webSocketDebuggerUrl")
		}
		return payload.WebSocketDebuggerURL, nil
	}

	u := url.URL{Scheme: "ws", Host: h.host(), Path: path, RawQuery: rawQuery}
	return u.String(), nil
}

func (h *cdpHandler) httpURL(path string) string {
	u := url.URL{Scheme: "http", Host: h.host(), Path: path}
	return u.String()
}

func (h *cdpHandler) host() string {
	raw := strings.TrimSpace(h.upstream)
	if raw == "" {
		return "127.0.0.1:9223"
	}
	if strings.Contains(raw, "://") {
		parsed, err := url.Parse(raw)
		if err == nil && parsed.Host != "" {
			return parsed.Host
		}
	}
	return raw
}

var chromeURLFields = []string{"webSocketDebuggerUrl", "devtoolsFrontendUrl"}

type externalCDPURL struct {
	host            string
	prefix          string
	webSocketScheme string
}

func externalCDPURLFromRequest(r *http.Request) externalCDPURL {
	host := firstForwardedValue(r.Header.Get("X-Forwarded-Host"))
	if host == "" {
		host = r.Host
	}

	proto := firstForwardedValue(r.Header.Get("X-Forwarded-Proto"))
	if proto == "" {
		proto = r.URL.Scheme
	}

	return externalCDPURL{
		host:            host,
		prefix:          cleanForwardedPrefix(r.Header.Get("X-Forwarded-Prefix")),
		webSocketScheme: webSocketSchemeForProto(proto),
	}
}

func firstForwardedValue(value string) string {
	if value == "" {
		return ""
	}
	return strings.TrimSpace(strings.Split(value, ",")[0])
}

func cleanForwardedPrefix(prefix string) string {
	prefix = firstForwardedValue(prefix)
	if prefix == "" || prefix == "/" {
		return ""
	}
	if !strings.HasPrefix(prefix, "/") {
		prefix = "/" + prefix
	}
	prefix = path.Clean(prefix)
	if prefix == "/" {
		return ""
	}
	return strings.TrimRight(prefix, "/")
}

func webSocketSchemeForProto(proto string) string {
	switch strings.ToLower(strings.TrimSpace(proto)) {
	case "https", "wss":
		return "wss"
	default:
		return "ws"
	}
}

func rewriteChromeURLs(v any, chromeHost string, external externalCDPURL) {
	switch val := v.(type) {
	case map[string]any:
		for _, field := range chromeURLFields {
			if s, ok := val[field].(string); ok {
				val[field] = rewriteChromeURL(s, chromeHost, external)
			}
		}
		for _, nested := range val {
			rewriteChromeURLs(nested, chromeHost, external)
		}
	case []any:
		for _, item := range val {
			rewriteChromeURLs(item, chromeHost, external)
		}
	}
}

func rewriteChromeURL(raw, chromeHost string, external externalCDPURL) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}

	if parsed.Host == chromeHost {
		parsed.Host = external.host
		if parsed.Scheme == "ws" || parsed.Scheme == "wss" {
			parsed.Scheme = external.webSocketScheme
		}
		parsed.Path = joinURLPrefix(external.prefix, parsed.Path)
	}

	if wsParam := parsed.Query().Get("ws"); wsParam != "" {
		rewritten := rewriteCDPWebSocketParam(wsParam, chromeHost, external)
		if rewritten == wsParam {
			return parsed.String()
		}
		q := parsed.Query()
		q.Set("ws", rewritten)
		parsed.RawQuery = q.Encode()
	}

	return parsed.String()
}

func rewriteCDPWebSocketParam(raw, chromeHost string, external externalCDPURL) string {
	parsed, err := url.Parse(raw)
	if err == nil && parsed.Host == chromeHost {
		parsed.Host = external.host
		if parsed.Scheme == "ws" || parsed.Scheme == "wss" {
			parsed.Scheme = external.webSocketScheme
		}
		parsed.Path = joinURLPrefix(external.prefix, parsed.Path)
		return parsed.String()
	}

	if raw == chromeHost || strings.HasPrefix(raw, chromeHost+"/") {
		suffix := strings.TrimPrefix(raw, chromeHost)
		return external.host + joinURLPrefix(external.prefix, suffix)
	}

	return raw
}

func joinURLPrefix(prefix, rawPath string) string {
	if prefix == "" {
		if rawPath == "" {
			return "/"
		}
		return rawPath
	}
	if rawPath == "" || rawPath == "/" {
		return prefix
	}
	return path.Join(prefix, rawPath)
}

type cdpBridge struct {
	client         net.Conn
	clientReader   *bufio.Reader
	upstream       net.Conn
	upstreamReader *bufio.Reader
	restricted     bool
	allowed        map[string]bool
	clientMu       sync.Mutex
	upstreamMu     sync.Mutex
}

func (b *cdpBridge) run() {
	done := make(chan struct{}, 2)

	go func() {
		b.copyClientToUpstream()
		done <- struct{}{}
	}()
	go func() {
		b.copyUpstreamToClient()
		done <- struct{}{}
	}()

	<-done
	_ = b.client.Close()
	_ = b.upstream.Close()
}

func (b *cdpBridge) copyClientToUpstream() {
	for {
		fin, opcode, payload, err := readFrame(b.clientReader)
		if err != nil {
			return
		}

		switch opcode {
		case 0x0, 0x1, 0x2:
			if b.restricted && (opcode == 0x0 || opcode == 0x2 || (opcode == 0x1 && !fin)) {
				_ = writeFrameToConn(b.client, &b.clientMu, 0x8, []byte{0x03, 0xF0}, false, true)
				return
			}
			if b.restricted && opcode == 0x1 {
				allowed, response := b.filterCDPCommand(payload)
				if !allowed {
					if len(response) > 0 {
						_ = writeFrameToConn(b.client, &b.clientMu, 0x1, response, false, true)
					}
					continue
				}
			}
			if err := writeFrameToConn(b.upstream, &b.upstreamMu, opcode, payload, true, fin); err != nil {
				return
			}
		case 0x8:
			_ = writeFrameToConn(b.upstream, &b.upstreamMu, 0x8, payload, true, true)
			return
		case 0x9:
			_ = writeFrameToConn(b.client, &b.clientMu, 0xA, payload, false, true)
		case 0xA:
		default:
			_ = writeFrameToConn(b.client, &b.clientMu, 0x8, []byte{0x03, 0xEA}, false, true)
			return
		}
	}
}

func (b *cdpBridge) copyUpstreamToClient() {
	for {
		fin, opcode, payload, err := readFrame(b.upstreamReader)
		if err != nil {
			return
		}

		switch opcode {
		case 0x0, 0x1, 0x2:
			if err := writeFrameToConn(b.client, &b.clientMu, opcode, payload, false, fin); err != nil {
				return
			}
		case 0x8:
			_ = writeFrameToConn(b.client, &b.clientMu, 0x8, payload, false, true)
			return
		case 0x9:
			_ = writeFrameToConn(b.upstream, &b.upstreamMu, 0xA, payload, true, true)
		case 0xA:
		default:
			_ = writeFrameToConn(b.client, &b.clientMu, 0x8, []byte{0x03, 0xEA}, false, true)
			return
		}
	}
}

func (b *cdpBridge) filterCDPCommand(payload []byte) (bool, []byte) {
	var msg struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil || msg.Method == "" {
		return true, nil
	}
	if b.allowed[msg.Method] {
		return true, nil
	}

	if len(msg.ID) == 0 {
		return false, nil
	}

	response := bytes.Buffer{}
	response.WriteString(`{"id":`)
	response.Write(msg.ID)
	response.WriteString(`,"error":{"code":-32000,"message":"Command not allowed"}}`)
	return false, response.Bytes()
}

func allowedCDPCommands() map[string]bool {
	return map[string]bool{
		"Input.enable":             true,
		"Input.insertText":         true,
		"Input.dispatchKeyEvent":   true,
		"Input.dispatchMouseEvent": true,
		"Input.dispatchTouchEvent": true,

		"Emulation.setDeviceMetricsOverride":   true,
		"Emulation.setVisibleSize":             true,
		"Emulation.setTouchEmulationEnabled":   true,
		"Emulation.clearDeviceMetricsOverride": true,

		"DOM.enable":             true,
		"DOM.getNodeForLocation": true,
		"DOM.describeNode":       true,

		"Browser.getVersion": true,

		"Target.setAutoAttach":  true,
		"Target.attachToTarget": true,
		"Target.closeTarget":    true,
		"Target.getTargets":     true,

		"Page.enable": true,
		"Page.reload": true,
	}
}

func dialWebsocket(rawURL string) (net.Conn, *bufio.Reader, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, nil, err
	}
	if parsed.Scheme != "ws" {
		return nil, nil, fmt.Errorf("unsupported websocket scheme: %s", parsed.Scheme)
	}

	conn, err := net.DialTimeout("tcp", parsed.Host, 5*time.Second)
	if err != nil {
		return nil, nil, err
	}

	key, err := websocketKey()
	if err != nil {
		_ = conn.Close()
		return nil, nil, err
	}

	requestURI := parsed.RequestURI()
	if requestURI == "" {
		requestURI = "/"
	}

	_, err = fmt.Fprintf(conn,
		"GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: %s\r\n\r\n",
		requestURI,
		parsed.Host,
		key,
	)
	if err != nil {
		_ = conn.Close()
		return nil, nil, err
	}

	reader := bufio.NewReader(conn)
	resp, err := http.ReadResponse(reader, &http.Request{Method: http.MethodGet})
	if err != nil {
		_ = conn.Close()
		return nil, nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		_ = conn.Close()
		return nil, nil, fmt.Errorf("websocket upgrade failed: %s", resp.Status)
	}

	return conn, reader, nil
}

func websocketKey() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(raw[:]), nil
}

func proxyWebsocket(w http.ResponseWriter, r *http.Request, upstream string) {
	if !isWebsocketRequest(r) {
		http.Error(w, "websocket upgrade required", http.StatusBadRequest)
		return
	}

	key := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	if key == "" {
		http.Error(w, "missing Sec-WebSocket-Key", http.StatusBadRequest)
		return
	}

	vncConn, err := net.DialTimeout("tcp", upstream, 5*time.Second)
	if err != nil {
		http.Error(w, fmt.Sprintf("failed to connect to VNC upstream: %v", err), http.StatusBadGateway)
		return
	}

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		_ = vncConn.Close()
		http.Error(w, "hijacking unsupported", http.StatusInternalServerError)
		return
	}

	clientConn, rw, err := hijacker.Hijack()
	if err != nil {
		_ = vncConn.Close()
		return
	}

	accept := websocketAccept(key)
	_, _ = fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\n")
	_, _ = fmt.Fprintf(rw, "Upgrade: websocket\r\n")
	_, _ = fmt.Fprintf(rw, "Connection: Upgrade\r\n")
	_, _ = fmt.Fprintf(rw, "Sec-WebSocket-Accept: %s\r\n", accept)
	_, _ = fmt.Fprint(rw, "\r\n")
	_ = rw.Flush()

	bridge := &wsBridge{
		client: clientConn,
		reader: rw.Reader,
		vnc:    vncConn,
	}
	bridge.run()
}

func isWebsocketRequest(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket") &&
		headerContainsToken(r.Header.Get("Connection"), "upgrade")
}

func headerContainsToken(header, token string) bool {
	for _, part := range strings.Split(header, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}
	return false
}

func websocketAccept(key string) string {
	sum := sha1.Sum([]byte(key + websocketGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

type wsBridge struct {
	client net.Conn
	reader *bufio.Reader
	vnc    net.Conn
	mu     sync.Mutex
}

func (b *wsBridge) run() {
	done := make(chan struct{}, 2)

	go func() {
		b.copyWebsocketToVNC()
		done <- struct{}{}
	}()

	go func() {
		b.copyVNCToWebsocket()
		done <- struct{}{}
	}()

	<-done
	_ = b.client.Close()
	_ = b.vnc.Close()
}

func (b *wsBridge) copyWebsocketToVNC() {
	for {
		_, opcode, payload, err := readFrame(b.reader)
		if err != nil {
			return
		}

		switch opcode {
		case 0x0, 0x1, 0x2:
			if len(payload) == 0 {
				continue
			}
			if _, err := b.vnc.Write(payload); err != nil {
				return
			}
		case 0x8:
			_ = b.writeFrame(0x8, payload)
			return
		case 0x9:
			_ = b.writeFrame(0xA, payload)
		case 0xA:
		default:
			_ = b.writeFrame(0x8, []byte{0x03, 0xEA})
			return
		}
	}
}

func (b *wsBridge) copyVNCToWebsocket() {
	buf := make([]byte, 32*1024)
	for {
		n, err := b.vnc.Read(buf)
		if n > 0 {
			if writeErr := b.writeFrame(0x2, buf[:n]); writeErr != nil {
				return
			}
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				_ = b.writeFrame(0x8, nil)
			}
			return
		}
	}
}

func (b *wsBridge) writeFrame(opcode byte, payload []byte) error {
	return writeFrameToConn(b.client, &b.mu, opcode, payload, false, true)
}

func writeFrameToConn(conn net.Conn, mu *sync.Mutex, opcode byte, payload []byte, masked bool, fin bool) error {
	mu.Lock()
	defer mu.Unlock()

	first := opcode & 0x0F
	if fin {
		first |= 0x80
	}
	header := []byte{first}
	length := len(payload)
	maskBit := byte(0)
	if masked {
		maskBit = 0x80
	}
	switch {
	case length < 126:
		header = append(header, maskBit|byte(length))
	case length <= 0xFFFF:
		header = append(header, maskBit|126, byte(length>>8), byte(length))
	default:
		header = append(header, maskBit|127)
		var size [8]byte
		binary.BigEndian.PutUint64(size[:], uint64(length))
		header = append(header, size[:]...)
	}

	if masked {
		var mask [4]byte
		if _, err := rand.Read(mask[:]); err != nil {
			return err
		}
		header = append(header, mask[:]...)
		maskedPayload := make([]byte, len(payload))
		for i := range payload {
			maskedPayload[i] = payload[i] ^ mask[i%4]
		}
		payload = maskedPayload
	}

	if _, err := conn.Write(header); err != nil {
		return err
	}
	if len(payload) == 0 {
		return nil
	}
	_, err := conn.Write(payload)
	return err
}

func readFrame(r *bufio.Reader) (bool, byte, []byte, error) {
	first, err := r.ReadByte()
	if err != nil {
		return false, 0, nil, err
	}
	second, err := r.ReadByte()
	if err != nil {
		return false, 0, nil, err
	}

	fin := first&0x80 != 0
	opcode := first & 0x0F
	masked := second&0x80 != 0
	length := uint64(second & 0x7F)

	switch length {
	case 126:
		var buf [2]byte
		if _, err := io.ReadFull(r, buf[:]); err != nil {
			return false, 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(buf[:]))
	case 127:
		var buf [8]byte
		if _, err := io.ReadFull(r, buf[:]); err != nil {
			return false, 0, nil, err
		}
		length = binary.BigEndian.Uint64(buf[:])
	}

	if length > 64*1024*1024 {
		return false, 0, nil, fmt.Errorf("websocket frame too large: %d", length)
	}

	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(r, mask[:]); err != nil {
			return false, 0, nil, err
		}
	}

	payload := make([]byte, int(length))
	if _, err := io.ReadFull(r, payload); err != nil {
		return false, 0, nil, err
	}

	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}

	return fin, opcode, payload, nil
}
