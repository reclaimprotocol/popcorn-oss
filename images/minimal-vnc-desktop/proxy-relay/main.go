// proxy-relay: a tiny local forward proxy that Chromium points at with NO auth,
// and which upstreams to an authenticated proxy (e.g. BrightData) by injecting
// Proxy-Authorization. This keeps proxy auth entirely OFF the CDP path — no
// Fetch.authRequired handler, so anti-bot systems (reCAPTCHA Enterprise, Akamai)
// don't see the automation signal that a persistent CDP interception leaves.
//
// Config via env (inherited from the container):
//   HTTPS_PROXY_URL  scheme://user:pass@host:port  ({{geoLocation}} supported)
//   PROXY_GEO        country substituted into {{geoLocation}} (default us)
//   PROXY_SESSION    BrightData sticky-session id (default: one per process)
//   PROXY_SCHEME     override upstream connection scheme (http|https)
//   RELAY_LISTEN     local listen addr (default 127.0.0.1:13128)
package main

import (
	"bufio"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

type upstream struct {
	scheme string // http | https (how we connect TO the proxy)
	addr   string // host:port
	host   string // host (for TLS SNI)
	auth   string // "Basic ..." or ""
}

var urlRe = regexp.MustCompile(`^(\w+)://(?:([^:@]+):([^@]*)@)?([^:/]+):(\d+)`)

// BrightData usernames are dash-delimited (…-country-X-session-Y), so a session
// id must be alphanumeric — a dash/underscore in it is parsed as extra tokens
// and rejected with 407 client_10001 "Invalid authentication".
var sessionRe = regexp.MustCompile(`[^a-zA-Z0-9]`)

func buildUpstream() (*upstream, error) {
	raw := os.Getenv("HTTPS_PROXY_URL")
	if raw == "" {
		return nil, fmt.Errorf("HTTPS_PROXY_URL not set")
	}
	raw = strings.ReplaceAll(raw, "{{geoLocation}}", env("PROXY_GEO", "us"))
	m := urlRe.FindStringSubmatch(raw)
	if m == nil {
		return nil, fmt.Errorf("cannot parse HTTPS_PROXY_URL")
	}
	scheme, user, pass, host, port := m[1], m[2], m[3], m[4], m[5]
	if s := os.Getenv("PROXY_SCHEME"); s != "" {
		scheme = s
	}
	sess := os.Getenv("PROXY_SESSION")
	if sess == "" {
		sess = fmt.Sprintf("s%d", time.Now().UnixNano())
	}
	sess = sessionRe.ReplaceAllString(sess, "") // alphanumeric only (see sessionRe)
	if user != "" && !strings.Contains(user, "-session-") {
		user = user + "-session-" + sess
	}
	u := &upstream{scheme: scheme, addr: host + ":" + port, host: host}
	if user != "" {
		u.auth = "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+pass))
	}
	log.Printf("[relay] upstream %s://%s (geo=%s session=%s)", scheme, u.addr, env("PROXY_GEO", "us"), sess)
	return u, nil
}

func (u *upstream) dial() (net.Conn, error) {
	d := &net.Dialer{Timeout: 20 * time.Second}
	if u.scheme == "https" {
		return tls.DialWithDialer(d, "tcp", u.addr, &tls.Config{ServerName: u.host})
	}
	return d.Dial("tcp", u.addr)
}

func main() {
	listen := env("RELAY_LISTEN", "127.0.0.1:13128")
	up, err := buildUpstream()
	if err != nil {
		log.Fatalf("[relay] %v", err)
	}
	ln, err := net.Listen("tcp", listen)
	if err != nil {
		log.Fatalf("[relay] listen %s: %v", listen, err)
	}
	log.Printf("[relay] listening on %s", listen)
	for {
		c, err := ln.Accept()
		if err != nil {
			continue
		}
		go handle(c, up)
	}
}

func handle(client net.Conn, up *upstream) {
	defer client.Close()
	br := bufio.NewReader(client)
	req, err := http.ReadRequest(br)
	if err != nil {
		return
	}

	upConn, err := up.dial()
	if err != nil {
		log.Printf("[relay] upstream dial: %v", err)
		return
	}
	defer upConn.Close()

	if req.Method == http.MethodConnect {
		// Chain the CONNECT to the upstream proxy, adding auth.
		fmt.Fprintf(upConn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n", req.Host, req.Host)
		if up.auth != "" {
			fmt.Fprintf(upConn, "Proxy-Authorization: %s\r\n", up.auth)
		}
		fmt.Fprint(upConn, "\r\n")

		upBr := bufio.NewReader(upConn)
		resp, err := http.ReadResponse(upBr, req)
		if err != nil {
			return
		}
		if resp.StatusCode != http.StatusOK {
			fmt.Fprintf(client, "HTTP/1.1 %d %s\r\n\r\n", resp.StatusCode, resp.Status)
			log.Printf("[relay] upstream CONNECT %s -> %d", req.Host, resp.StatusCode)
			return
		}
		fmt.Fprint(client, "HTTP/1.1 200 Connection established\r\n\r\n")
		// Flush any bytes the reader buffered past the response header, then tunnel.
		if n := upBr.Buffered(); n > 0 {
			b, _ := upBr.Peek(n)
			client.Write(b)
			upBr.Discard(n)
		}
		go io.Copy(upConn, br)
		io.Copy(client, upConn)
		return
	}

	// Plain HTTP: forward the absolute-form request to the upstream proxy with auth.
	if up.auth != "" {
		req.Header.Set("Proxy-Authorization", up.auth)
	}
	if err := req.WriteProxy(upConn); err != nil {
		return
	}
	go io.Copy(upConn, br)
	io.Copy(client, upConn)
}
