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
	"mime"
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
	flag.Parse()

	ready := readyGate{file: *readyFile}
	servers := []*http.Server{
		{
			Addr:              *listen,
			Handler:           noVNCMux(*web, *vnc, *cdpUpstream, ready),
			ReadHeaderTimeout: 5 * time.Second,
		},
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
	log.Fatal(<-errs)
}

func noVNCMux(web, vnc, cdpUpstream string, ready readyGate) http.Handler {
	mux := http.NewServeMux()
	kbd := newKbdHub()
	mux.HandleFunc("/kbd", func(w http.ResponseWriter, r *http.Request) {
		kbd.serve(w, r, ready)
	})
	// Mobile viewport emulation: the viewer POSTs its own size so the remote
	// reflows to a real mobile layout (see emulate.go). One persistent CDP
	// manager applies it to every page target (incl. popups/new tabs). Safe
	// subset of CDP only.
	em := newEmulator(cdpUpstream)
	// JS dialogs (alert/confirm/prompt) are intercepted in emulate.go and drawn by
	// the viewer instead of by Chromium, which lays them out against the real
	// window and clips them off a narrow emulated viewport. The hub is the
	// transport (viewers already hold that socket, and it resyncs late joiners);
	// the REPLY is executed here, so the viewer sends accept/dismiss + text and
	// never a CDP method.
	em.setDialogSink(kbd.broadcastDialog)
	em.fedcm.setSink(kbd.broadcastDialog)
	// Popup windows (OAuth "Continue with Google") are fullscreened by emulate.go
	// so they are usable on a phone, which removes the window's own close button.
	// The viewer draws a replacement and asks us to close it; see emulator.closePopup.
	em.setPopupSink(kbd.broadcastPopup)
	// The extension's dialog bridge (dialog.go) is the PREFERRED path: it overrides
	// the page's dialog functions so Chromium never opens one, which removes both
	// the duplicate dialog and the machine-fast alert() return that the CDP path
	// cannot avoid. emulate.go's CDP interception stays as the fallback for dialogs
	// the bridge can't reach (beforeunload, and any page the extension didn't
	// inject into) — the two are naturally exclusive, since a dialog the bridge
	// handles never reaches Chromium at all.
	dlg := newDialogBridge(kbd)
	kbd.bridgeToken = dlg.token
	mux.HandleFunc("/dialog", dialogBridgeHandler(dlg, ready))
	kbd.onViewerMsg = func(payload []byte) {
		var msg struct {
			DialogReply *struct {
				Seq    uint64 `json:"seq"`
				Accept bool   `json:"accept"`
				Text   string `json:"text"`
				// Which mechanism raised this dialog. The bridge and the CDP path keep
				// INDEPENDENT sequence counters, so seq alone is ambiguous — routing on
				// it would let a reply resolve the wrong mechanism's dialog. The viewer
				// echoes back the flag it was sent.
				Bridge bool `json:"bridge"`
				// FedCM account chooser (fedcm.go). Third mechanism, third flag —
				// accountIndex is meaningless to the other two.
				Fedcm        bool `json:"fedcm"`
				AccountIndex int  `json:"accountIndex"`
			} `json:"dialogReply"`
			// Close the foreground popup window. Carries only a sequence number —
			// the viewer cannot name a target, so it can only ever close the popup
			// the proxy itself advertised.
			PopupClose *struct {
				Seq uint64 `json:"seq"`
			} `json:"popupClose"`
		}
		if err := json.Unmarshal(payload, &msg); err != nil {
			return
		}
		if msg.PopupClose != nil {
			em.closePopup(msg.PopupClose.Seq)
			return
		}
		if msg.DialogReply == nil {
			return
		}
		// Clear the resync cache first, unconditionally: a notification sheet (an
		// alert we already accepted) has no dialog left to answer, but its cached
		// state must still stop being replayed to the next viewer that connects.
		if b, err := json.Marshal(map[string]any{"dialog": map[string]any{"open": false}}); err == nil {
			kbd.broadcastDialog(b, false)
		}
		if msg.DialogReply.Fedcm {
			em.answerFedcm(msg.DialogReply.Seq, msg.DialogReply.Accept, msg.DialogReply.AccountIndex)
			return
		}
		if msg.DialogReply.Bridge {
			dlg.answer(msg.DialogReply.Seq, msg.DialogReply.Accept, msg.DialogReply.Text)
			return
		}
		em.answerDialog(msg.DialogReply.Seq, msg.DialogReply.Accept, msg.DialogReply.Text)
	}
	emulate := emulateHTTPHandler(em, ready)
	mux.HandleFunc("/emulate", func(w http.ResponseWriter, r *http.Request) {
		emulate(w, r)
		// A viewer pushes /emulate exactly when it resizes the X screen (fit
		// enter/exit, settle), so this is the event the kiosk window follows
		// instead of a poll. See window.go.
		requestWindowFit(log.Printf)
	})
	// Boot framebuffer geometry (WIDTH x FB_HEIGHT) = the advertised desktop size
	// (the kiosk window starts there; window.go re-fits it as the screen moves).
	// The viewer reads this to cap its resize requests rather than guessing from
	// the (sticky-across-sessions) connect-time framebuffer. See
	// geometryHTTPHandler in emulate.go.
	mux.HandleFunc("/geometry", geometryHTTPHandler())
	// Native touch input: the viewer streams touch points here and we dispatch
	// CDP Input.dispatchTouchEvent, so the remote page handles scroll/drag/
	// sliders/pinch itself (VNC only carries mouse). See emulate.go.
	mux.HandleFunc("/input", inputWSHandler(em, ready))
	// Keyboard diagnostics: the viewer batches structural keyboard events (never
	// field text) here so mobile keyboard issues show up in the proxy log rather
	// than requiring on-device screenshots. See klog.go.
	mux.HandleFunc("/klog", klogHTTPHandler())
	// Screen-geometry hygiene: a fit/magnify viewer resizes the X screen to its own
	// layout and nothing put it back, so the next session inherited a phone-shaped
	// screen. Restore the advertised desktop size once the last viewer leaves.
	// Restore to the BOOT geometry (WIDTH x FB_HEIGHT); the kiosk window follows
	// the restored screen at the X level (window.go), in both directions.
	bootW, bootH := envInt("WIDTH", 1920), envInt("FB_HEIGHT", envInt("HEIGHT", 1080))
	keeper := newScreenKeeper(screenRestoreDelay, restoreScreenFunc(bootW, bootH, em, log.Printf))
	keeper.logf = log.Printf
	// The FIRST viewer of a session must start from boot geometry, not from
	// whatever the previous session left: connecting inside the restore delay
	// cancels the pending restore, which is right for a reload but wrong for a
	// changeover (a plain viewer after a magnify session inherited a phone-shaped
	// screen forever). See resetScreenOnFirstConnect in screen.go.
	keeper.resetOnFirst = resetScreenOnFirstConnect(bootW, bootH, em, log.Printf)
	// Keep the kiosk window covering the screen whatever size viewers make it —
	// rows the window does not cover stream as the black X root. See window.go.
	go windowWatcher(log.Printf)
	mux.HandleFunc("/websockify", func(w http.ResponseWriter, r *http.Request) {
		serveWebsocket(w, r, vnc, ready, keeper)
	})
	mux.HandleFunc("/vnc-ws/", func(w http.ResponseWriter, r *http.Request) {
		serveWebsocket(w, r, vnc, ready, keeper)
	})
	mux.HandleFunc("/liveview-ws/", func(w http.ResponseWriter, r *http.Request) {
		serveWebsocket(w, r, vnc, ready, keeper)
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

func serveWebsocket(w http.ResponseWriter, r *http.Request, upstream string, ready readyGate, keeper *screenKeeper) {
	if !ready.ready() {
		http.Error(w, "app is not ready", http.StatusServiceUnavailable)
		return
	}
	// Bracket the VNC session so the screen geometry a fit/magnify viewer leaves
	// behind is not inherited by the next one (see screen.go). ?keep=1 marks a
	// viewer that manages its own geometry (magnify) and opts out of the
	// first-connect boot reset — see screenKeeper.connect.
	keeper.connect(r.URL.Query().Get("keep") == "1")
	defer keeper.disconnect()
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
		// The content-hashed viewer bundle (viewer-<hash>.bundle.js) is safe to cache
		// forever: a content change yields a new filename, so the browser can never
		// serve stale logic. Caching it immutably lets a reconnect/reopen skip the
		// re-download entirely (the win over plain no-store). The .gz sibling served
		// below inherits this via the same clean path.
		//
		// Everything else in the viewer shell (HTML + the raw input/keyboard logic)
		// changes constantly and is NOT content-hashed. The Dockerfile pins these
		// files' mtimes to a fixed epoch for reproducible builds, so their
		// Last-Modified never changes and a browser would 304 to its stale cached
		// copy forever — even across rebuilds. Force a fresh fetch so a device always
		// runs the current logic. In particular liveview.html MUST stay no-store: it
		// carries the current bundle hash, so it has to be re-read every load.
		base := path.Base(clean)
		switch {
		case strings.HasPrefix(base, "viewer-") && strings.HasSuffix(base, ".bundle.js"):
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		case strings.HasSuffix(clean, "/liveview.html") || strings.HasSuffix(clean, "/kbd-autofocus.js") ||
			strings.HasPrefix(clean, "/kbd/"):
			w.Header().Set("Cache-Control", "no-store, max-age=0, must-revalidate")
		}
		// Serve a precompressed sibling (.br/.gz) when the client accepts that
		// encoding and the file exists on disk. The ~500KB viewer bundle is the
		// cold-start bottleneck over the tunnel; gzip cuts it ~4.5x. Falls through
		// to the raw file when there's no matching variant or Accept-Encoding.
		if enc, suffix := precompressedVariant(root, clean, r.Header.Get("Accept-Encoding")); enc != "" {
			servePrecompressed(w, r, root, clean, suffix, enc)
			return
		}
		files.ServeHTTP(w, r)
	}
}

// precompressedVariant picks the best precompressed sibling of root+clean that
// the client accepts and that exists on disk. Brotli is preferred over gzip.
// Returns (encoding, filenameSuffix) or ("","") if none applies.
func precompressedVariant(root, clean, acceptEncoding string) (string, string) {
	for _, c := range []struct{ enc, suffix string }{{"br", ".br"}, {"gzip", ".gz"}} {
		if !acceptsEncoding(acceptEncoding, c.enc) {
			continue
		}
		p := filepath.Join(root, filepath.FromSlash(clean)+c.suffix)
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return c.enc, c.suffix
		}
	}
	return "", ""
}

// acceptsEncoding reports whether the Accept-Encoding header lists enc (ignoring
// q-values; a client that sends the token at all accepts it here).
func acceptsEncoding(header, enc string) bool {
	for _, part := range strings.Split(header, ",") {
		token := strings.TrimSpace(part)
		if i := strings.IndexByte(token, ';'); i >= 0 {
			token = strings.TrimSpace(token[:i])
		}
		if strings.EqualFold(token, enc) {
			return true
		}
	}
	return false
}

// servePrecompressed streams the precompressed sibling with the ORIGINAL file's
// content type (not the .gz/.br) plus Content-Encoding/Vary, letting the browser
// transparently decompress. http.ServeContent handles Content-Length and
// conditional/range requests; any Cache-Control already set is preserved.
func servePrecompressed(w http.ResponseWriter, r *http.Request, root, clean, suffix, enc string) {
	p := filepath.Join(root, filepath.FromSlash(clean)+suffix)
	f, err := os.Open(p)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	ctype := mime.TypeByExtension(filepath.Ext(clean))
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Content-Encoding", enc)
	w.Header().Set("Vary", "Accept-Encoding")
	http.ServeContent(w, r, filepath.Base(clean), fi.ModTime(), f)
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
		// The restricted port is the client-reachable one, so it gets the tight cap; the full port is internal
		// and may legitimately carry a large command (an intercepted-request body, a big injected script).
		max := uint64(maxWSFrame)
		if b.restricted {
			max = maxRestrictedCDPFrame
		}
		fin, opcode, payload, err := readFrameLimit(b.clientReader, max)
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
		// Chromium's own responses — the one direction that is genuinely large (screenshots, response bodies).
		fin, opcode, payload, err := readFrameLimit(b.upstreamReader, maxWSFrame)
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

	// TCP keepalive is a second-layer half-open detector beneath the app-level
	// WS pings below: on mobile the carrier NAT / wss tunnel silently drops an
	// idle mapping, and without this the next keystroke writes into a black hole
	// that TCP retries for minutes before erroring.
	if tcp, ok := clientConn.(*net.TCPConn); ok {
		_ = tcp.SetKeepAlive(true)
		_ = tcp.SetKeepAlivePeriod(wsKeepAlivePeriod)
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

// Liveness tuning for the /websockify bridge. An idle viewer (reading a static
// page) generates zero RFB traffic for minutes, so we drive our own keepalive:
//   - wsPingInterval: server->client WS pings keep both NAT directions and the
//     wss tunnel warm; browsers auto-pong, which refreshes the read deadline.
//   - wsClientReadDeadline: reap a half-open client that has gone silent (no
//     data, no pong) so the VNC side is freed and the client's own reconnect
//     loop can restore the session. Must exceed wsPingInterval*2 like /kbd.
//   - wsWriteDeadline: bound a stalled frame write so a dead client can't pin
//     the VNC->client goroutine.
//   - wsKeepAlivePeriod: TCP-level keepalive as a second-layer detector.
const (
	wsPingInterval       = 25 * time.Second
	wsClientReadDeadline = 75 * time.Second
	wsWriteDeadline      = 10 * time.Second
	wsKeepAlivePeriod    = 30 * time.Second
)

type wsBridge struct {
	client net.Conn
	reader *bufio.Reader
	vnc    net.Conn
	mu     sync.Mutex
}

func (b *wsBridge) run() {
	done := make(chan struct{}, 2)
	stopPing := make(chan struct{})

	go func() {
		b.copyWebsocketToVNC()
		done <- struct{}{}
	}()

	go func() {
		b.copyVNCToWebsocket()
		done <- struct{}{}
	}()

	go b.pingLoop(stopPing)

	<-done
	close(stopPing)
	_ = b.client.Close()
	_ = b.vnc.Close()
}

// pingLoop sends server->client WS pings so idle-but-alive connections stay warm
// and half-open ones surface as a failed write. Stops when the bridge tears down.
func (b *wsBridge) pingLoop(stop <-chan struct{}) {
	ticker := time.NewTicker(wsPingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			if err := b.writeFrame(0x9, nil); err != nil {
				return
			}
		}
	}
}

func (b *wsBridge) copyWebsocketToVNC() {
	for {
		// Refresh the read deadline on every frame (client keystrokes AND the
		// auto-pongs to our pings count as liveness), so a silent half-open
		// client is torn down within wsClientReadDeadline instead of lingering.
		_ = b.client.SetReadDeadline(time.Now().Add(wsClientReadDeadline))
		_, opcode, payload, err := readFrameLimit(b.reader, maxRFBClientFrame)
		if errors.Is(err, errFrameTooLarge) {
			continue // e.g. an enormous clipboard paste: drop the message, keep the session
		}
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
	_ = b.client.SetWriteDeadline(time.Now().Add(wsWriteDeadline))
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

// Per-direction frame ceilings: only trusted peers get the big one.
const (
	// Chromium's CDP responses (screenshots, response bodies) and the internal-only full-CDP port.
	maxWSFrame = 64 * 1024 * 1024
	// Client->server RFB is keys and pointer moves; only ClientCutText (a paste) varies. The framebuffer
	// travels the other way and never passes through readFrame at all.
	maxRFBClientFrame = 1024 * 1024
	// Restricted CDP is the client-reachable port; its allowlist tops out at Input.insertText.
	maxRestrictedCDPFrame = 1024 * 1024
)

// errFrameTooLarge means the frame exceeded the caller's limit and its body was drained. The connection is
// still usable — callers that treat an oversized frame as noise (see /kbd, /input, RFB) skip and read on.
var errFrameTooLarge = errors.New("websocket frame too large")

// readFrame decodes at the transport ceiling; production readers pass their own limit instead.
func readFrame(r *bufio.Reader) (bool, byte, []byte, error) {
	return readFrameLimit(r, maxWSFrame)
}

// readFrameLimit rejects an over-max frame from the LENGTH HEADER, before allocating. That ordering is the
// point: /kbd and /input used to allocate at the 64 MiB ceiling and only then check their own limit, so a
// few concurrent clients could each make us allocate 64 MiB on a lie.
func readFrameLimit(r *bufio.Reader, max uint64) (bool, byte, []byte, error) {
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

	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(r, mask[:]); err != nil {
			return false, 0, nil, err
		}
	}

	// Over the limit: DISCARD the body by streaming it to io.Discard (constant memory, no allocation on a
	// lie) and report errFrameTooLarge. Draining keeps the stream framed, so a caller that wants the old
	// "ignore this frame" behaviour can continue reading instead of dropping the connection.
	if length > max {
		if _, err := io.CopyN(io.Discard, r, int64(length)); err != nil {
			return false, 0, nil, err
		}
		return false, 0, nil, fmt.Errorf("%w: %d (max %d)", errFrameTooLarge, length, max)
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
