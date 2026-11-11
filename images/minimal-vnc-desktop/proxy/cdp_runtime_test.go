package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// shimHarness runs a full-CDP bridge with the Runtime shim between a test
// client and a scripted browser.
type shimHarness struct {
	t       *testing.T
	client  net.Conn
	browser net.Conn

	clientMu  sync.Mutex
	browserMu sync.Mutex

	mu       sync.Mutex
	received []shimMessage // what the client was sent
	commands []shimMessage // what the browser was sent
	// reply overrides the scripted browser's answer for one method.
	reply map[string]func(shimMessage) any
}

type shimMessage struct {
	ID        int64           `json:"id"`
	Method    string          `json:"method"`
	SessionID string          `json:"sessionId"`
	Params    json.RawMessage `json:"params"`
	Result    json.RawMessage `json:"result"`
	raw       string
}

func newShimHarness(t *testing.T) *shimHarness {
	t.Helper()
	client, proxyClient := net.Pipe()
	browser, proxyUpstream := net.Pipe()
	h := &shimHarness{t: t, client: client, browser: browser, reply: map[string]func(shimMessage) any{}}
	bridge := &cdpBridge{
		client:         proxyClient,
		clientReader:   bufio.NewReader(proxyClient),
		upstream:       proxyUpstream,
		upstreamReader: bufio.NewReader(proxyUpstream),
	}
	bridge.shim = newRuntimeShim(bridge)
	bridge.shim.callTimeout = 300 * time.Millisecond
	go bridge.run()
	go h.readClient()
	go h.serveBrowser()
	t.Cleanup(func() {
		_ = client.Close()
		_ = browser.Close()
	})
	return h
}

func (h *shimHarness) readClient() {
	reader := bufio.NewReader(h.client)
	for {
		_, opcode, payload, err := readFrame(reader)
		if err != nil {
			return
		}
		if opcode != 0x1 {
			continue
		}
		msg := shimMessage{raw: string(payload)}
		_ = json.Unmarshal(payload, &msg)
		h.mu.Lock()
		h.received = append(h.received, msg)
		h.mu.Unlock()
	}
}

// serveBrowser answers every command the way a browser with one frame "F"
// would: isolated worlds get context 3, and the frame's main world is 7.
func (h *shimHarness) serveBrowser() {
	reader := bufio.NewReader(h.browser)
	for {
		_, opcode, payload, err := readFrame(reader)
		if err != nil {
			return
		}
		if opcode != 0x1 {
			continue
		}
		msg := shimMessage{raw: string(payload)}
		_ = json.Unmarshal(payload, &msg)
		h.mu.Lock()
		h.commands = append(h.commands, msg)
		override := h.reply[msg.Method]
		h.mu.Unlock()

		var result any = map[string]any{}
		switch {
		case override != nil:
			result = override(msg)
		case msg.Method == "Page.getFrameTree":
			result = map[string]any{"frameTree": map[string]any{"frame": map[string]any{"id": "F", "securityOrigin": "https://a.test"}}}
		case msg.Method == "Page.createIsolatedWorld":
			result = map[string]any{"executionContextId": 3}
		case msg.Method == "Runtime.evaluate" && strings.Contains(msg.raw, `"expression":"document"`):
			result = map[string]any{"result": map[string]any{"objectId": "9.3.1"}}
		case msg.Method == "Runtime.evaluate" && strings.Contains(msg.raw, `"expression":"self"`):
			result = map[string]any{"result": map[string]any{"objectId": "9.5.1"}}
		case msg.Method == "Runtime.evaluate":
			result = map[string]any{"result": map[string]any{"type": "undefined"}}
		case msg.Method == "DOM.describeNode":
			result = map[string]any{"node": map[string]any{"backendNodeId": 11}}
		case msg.Method == "DOM.resolveNode":
			result = map[string]any{"object": map[string]any{"objectId": "9.7.2"}}
		}
		if result == nil {
			continue // the test answers, or leaves it unanswered
		}
		body, _ := json.Marshal(result)
		reply := fmt.Sprintf(`{"id":%d,"result":%s,"sessionId":%q}`, msg.ID, body, msg.SessionID)
		_ = writeFrameToConn(h.browser, &h.browserMu, 0x1, []byte(reply), false, true)
	}
}

func (h *shimHarness) fromClient(payload string) {
	h.t.Helper()
	if err := writeFrameToConn(h.client, &h.clientMu, 0x1, []byte(payload), true, true); err != nil {
		h.t.Fatalf("client write: %v", err)
	}
}

func (h *shimHarness) fromBrowser(payload string) {
	h.t.Helper()
	if err := writeFrameToConn(h.browser, &h.browserMu, 0x1, []byte(payload), false, true); err != nil {
		h.t.Fatalf("browser write: %v", err)
	}
}

func (h *shimHarness) wait(what string, list func() []shimMessage, match func(shimMessage) bool) shimMessage {
	h.t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		h.mu.Lock()
		for _, msg := range list() {
			if match(msg) {
				h.mu.Unlock()
				return msg
			}
		}
		h.mu.Unlock()
		if time.Now().After(deadline) {
			h.t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (h *shimHarness) clientGets(what string, match func(shimMessage) bool) shimMessage {
	h.t.Helper()
	return h.wait("client: "+what, func() []shimMessage { return h.received }, match)
}

func (h *shimHarness) browserGets(what string, match func(shimMessage) bool) shimMessage {
	h.t.Helper()
	return h.wait("browser: "+what, func() []shimMessage { return h.commands }, match)
}

// settle lets in-flight work finish before asserting that something did not happen.
func (h *shimHarness) settle() { time.Sleep(60 * time.Millisecond) }

func (h *shimHarness) got(list *[]shimMessage, match func(shimMessage) bool) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.ContainsFunc(*list, match)
}

func (h *shimHarness) clientGot(match func(shimMessage) bool) bool { return h.got(&h.received, match) }

func (h *shimHarness) browserGot(match func(shimMessage) bool) bool { return h.got(&h.commands, match) }

func method(name string) func(shimMessage) bool {
	return func(msg shimMessage) bool { return msg.Method == name }
}

func reply(id int64) func(shimMessage) bool {
	return func(msg shimMessage) bool { return msg.ID == id && msg.Method == "" }
}

// enable has the client enable the Runtime domain on session S and waits for the answer.
func (h *shimHarness) enable() {
	h.t.Helper()
	h.fromClient(`{"id":1,"method":"Runtime.enable","sessionId":"S"}`)
	h.clientGets("Runtime.enable answer", reply(1))
}

type shimContextEvent struct {
	Context struct {
		ID       int    `json:"id"`
		Name     string `json:"name"`
		Origin   string `json:"origin"`
		UniqueID string `json:"uniqueId"`
		AuxData  struct {
			IsDefault bool   `json:"isDefault"`
			Type      string `json:"type"`
			FrameID   string `json:"frameId"`
		} `json:"auxData"`
	} `json:"context"`
}

func contextEvent(t *testing.T, msg shimMessage) shimContextEvent {
	t.Helper()
	var event shimContextEvent
	if err := json.Unmarshal(msg.Params, &event); err != nil {
		t.Fatalf("context event: %v", err)
	}
	return event
}

func TestRuntimeShimKeepsRuntimeDisabledAndReportsContexts(t *testing.T) {
	h := newShimHarness(t)
	h.fromClient(`{"id":5,"method":"Page.addScriptToEvaluateOnNewDocument","params":{"source":"","worldName":"util"},"sessionId":"S"}`)
	h.clientGets("script registration answer", reply(5))
	h.enable()

	main := contextEvent(t, h.clientGets("main world", func(msg shimMessage) bool {
		return msg.Method == "Runtime.executionContextCreated" && strings.Contains(string(msg.Params), `"isDefault":true`)
	}))
	if main.Context.ID != 7 || main.Context.AuxData.FrameID != "F" || main.Context.Origin != "https://a.test" || main.Context.UniqueID != "9.7" {
		t.Fatalf("main world = %+v", main.Context)
	}
	world := contextEvent(t, h.clientGets("client world", func(msg shimMessage) bool {
		return msg.Method == "Runtime.executionContextCreated" && strings.Contains(string(msg.Params), `"name":"util"`)
	}))
	if world.Context.ID != 3 || world.Context.AuxData.IsDefault || world.Context.AuxData.Type != "isolated" {
		t.Fatalf("client world = %+v", world.Context)
	}
	if h.browserGot(method("Runtime.enable")) {
		t.Fatal("Runtime.enable reached the browser")
	}
	// Each context is reported before the command that asked for it is answered.
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, msg := range h.received {
		if msg.Method == "Runtime.executionContextCreated" {
			return
		}
		if msg.ID == 1 {
			t.Fatal("Runtime.enable was answered before its contexts were reported")
		}
	}
}

func TestRuntimeShimPassesThroughTargetsItCannotDescribe(t *testing.T) {
	h := newShimHarness(t)
	h.fromBrowser(`{"method":"Target.attachedToTarget","params":{"sessionId":"B","targetInfo":{"type":"browser"}}}`)
	h.clientGets("attach event", method("Target.attachedToTarget"))
	h.fromClient(`{"id":2,"method":"Runtime.enable","sessionId":"B"}`)
	h.browserGets("forwarded Runtime.enable", func(msg shimMessage) bool {
		return msg.Method == "Runtime.enable" && msg.SessionID == "B" && msg.ID == 2
	})
}

func TestRuntimeShimFallsBackWhenTheTargetHasNoFrames(t *testing.T) {
	h := newShimHarness(t)
	h.reply["Page.getFrameTree"] = func(msg shimMessage) any {
		// The browser puts the id first, which is how the shim recognises a reply.
		failure := fmt.Sprintf(`{"id":%d,"error":{"code":-32601,"message":"'Page.getFrameTree' wasn't found"},"sessionId":%q}`, msg.ID, msg.SessionID)
		_ = writeFrameToConn(h.browser, &h.browserMu, 0x1, []byte(failure), false, true)
		return nil
	}
	h.fromClient(`{"id":1,"method":"Runtime.enable","sessionId":"S"}`)
	h.browserGets("forwarded Runtime.enable", func(msg shimMessage) bool { return msg.Method == "Runtime.enable" && msg.ID == 1 })
}

func TestRuntimeShimDescribesWorkersAndHoldsThemUntilReady(t *testing.T) {
	h := newShimHarness(t)
	release := make(chan struct{})
	h.reply["Console.enable"] = func(shimMessage) any {
		<-release
		return map[string]any{}
	}
	h.fromBrowser(`{"method":"Target.attachedToTarget","params":{"sessionId":"W","targetInfo":{"type":"worker"}}}`)
	h.clientGets("attach event", method("Target.attachedToTarget"))
	h.fromClient(`{"id":1,"method":"Runtime.enable","sessionId":"W"}`)
	h.fromClient(`{"id":2,"method":"Runtime.runIfWaitingForDebugger","sessionId":"W"}`)

	created := contextEvent(t, h.clientGets("worker context", method("Runtime.executionContextCreated")))
	if created.Context.ID != 5 || !created.Context.AuxData.IsDefault {
		t.Fatalf("worker context = %+v", created.Context)
	}
	h.browserGets("error listener", func(msg shimMessage) bool {
		return msg.Method == "Runtime.evaluate" && strings.Contains(msg.raw, "unhandledrejection")
	})
	h.settle()
	if h.browserGot(method("Runtime.runIfWaitingForDebugger")) {
		t.Fatal("the worker was resumed before its listener was in place")
	}
	close(release)
	h.clientGets("Runtime.enable answer", reply(1))
	h.browserGets("resume", method("Runtime.runIfWaitingForDebugger"))
	if h.browserGot(method("Runtime.enable")) || h.browserGot(method("Page.getFrameTree")) {
		t.Fatal("a worker was treated as a frame target")
	}
}

func TestRuntimeShimTranslatesConsoleMessages(t *testing.T) {
	h := newShimHarness(t)
	h.enable()
	h.browserGets("Console.enable", method("Console.enable"))
	h.fromBrowser(`{"method":"Console.messageAdded","params":{"message":{"source":"console-api","level":"warning","text":"careful 42","url":"https://a.test/app.js","line":3,"column":9}},"sessionId":"S"}`)

	called := h.clientGets("console event", method("Runtime.consoleAPICalled"))
	var event struct {
		Type               string `json:"type"`
		ExecutionContextID int    `json:"executionContextId"`
		Args               []struct {
			Type  string `json:"type"`
			Value string `json:"value"`
		} `json:"args"`
		StackTrace struct {
			CallFrames []struct {
				URL          string `json:"url"`
				LineNumber   int    `json:"lineNumber"`
				ColumnNumber int    `json:"columnNumber"`
			} `json:"callFrames"`
		} `json:"stackTrace"`
	}
	if err := json.Unmarshal(called.Params, &event); err != nil {
		t.Fatal(err)
	}
	if event.Type != "warning" || event.ExecutionContextID != 7 || len(event.Args) != 1 || event.Args[0].Value != "careful 42" {
		t.Fatalf("console event = %+v", event)
	}
	if frame := event.StackTrace.CallFrames[0]; frame.URL != "https://a.test/app.js" || frame.LineNumber != 2 || frame.ColumnNumber != 8 {
		t.Fatalf("console location = %+v", frame)
	}
	h.settle()
	if h.clientGot(method("Console.messageAdded")) {
		t.Fatal("a Console event reached a client that did not enable the domain")
	}

	h.fromClient(`{"id":9,"method":"Console.enable","sessionId":"S"}`)
	h.clientGets("Console.enable answer", reply(9))
	h.fromBrowser(`{"method":"Console.messageAdded","params":{"message":{"source":"console-api","level":"log","text":"again"}},"sessionId":"S"}`)
	h.clientGets("forwarded Console event", method("Console.messageAdded"))
}

// errorReport builds the console message the page listener sends for session S.
func (h *shimHarness) errorReport(report string) string {
	h.t.Helper()
	script := h.browserGets("error listener", func(msg shimMessage) bool {
		return msg.Method == "Page.addScriptToEvaluateOnNewDocument" && strings.Contains(msg.raw, "unhandledrejection")
	})
	var params struct {
		Source string `json:"source"`
	}
	if err := json.Unmarshal(script.Params, &params); err != nil {
		h.t.Fatal(err)
	}
	at := strings.Index(params.Source, `cdp-uncaught\u0001`)
	if at < 0 {
		h.t.Fatalf("no report prefix in the listener: %.200s", params.Source)
	}
	nonce := params.Source[at+len(`cdp-uncaught\u0001`):][:16]
	text, _ := json.Marshal(shimErrorPrefix + nonce + report)
	return fmt.Sprintf(`{"method":"Console.messageAdded","params":{"message":{"source":"console-api","level":"debug","text":%s}},"sessionId":"S"}`, text)
}

func TestRuntimeShimReportsUncaughtErrors(t *testing.T) {
	cases := []struct {
		name, report, wantText string
		want                   map[string]any
	}{
		{
			name:     "thrown error",
			report:   `{"m":"Uncaught TypeError: x is not a function","u":"https://a.test/app.js","l":4,"c":2}`,
			wantText: "Uncaught",
			want:     map[string]any{"type": "object", "subtype": "error", "className": "Error", "description": "TypeError: x is not a function\n    at https://a.test/app.js:4:2"},
		},
		{
			name:     "rejected error",
			report:   `{"p":true,"k":"error","n":"RangeError","m":"too big"}`,
			wantText: "Uncaught (in promise)",
			want:     map[string]any{"type": "object", "subtype": "error", "className": "RangeError", "description": "RangeError: too big"},
		},
		{
			name:     "rejected string",
			report:   `{"p":true,"k":"string","v":"nope"}`,
			wantText: "Uncaught (in promise)",
			want:     map[string]any{"type": "string", "value": "nope"},
		},
		{
			name:     "rejected object left unread",
			report:   `{"p":true,"k":"object"}`,
			wantText: "Uncaught (in promise)",
			want:     map[string]any{"type": "object", "className": "Object", "description": "Object"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newShimHarness(t)
			h.enable()
			h.fromBrowser(h.errorReport(tc.report))
			thrown := h.clientGets("exception", method("Runtime.exceptionThrown"))
			var event struct {
				ExceptionDetails struct {
					Text               string         `json:"text"`
					ExecutionContextID int            `json:"executionContextId"`
					Exception          map[string]any `json:"exception"`
				} `json:"exceptionDetails"`
			}
			if err := json.Unmarshal(thrown.Params, &event); err != nil {
				t.Fatal(err)
			}
			details := event.ExceptionDetails
			if details.Text != tc.wantText || details.ExecutionContextID != 7 {
				t.Fatalf("details = %+v", details)
			}
			got, _ := json.Marshal(details.Exception)
			want, _ := json.Marshal(tc.want)
			if string(got) != string(want) {
				t.Fatalf("exception = %s, want %s", got, want)
			}
			h.settle()
			if h.clientGot(method("Runtime.consoleAPICalled")) || h.clientGot(method("Console.messageAdded")) {
				t.Fatal("an error report was also delivered as a console message")
			}
		})
	}
}

func TestRuntimeShimDropsAnotherSessionsErrorReport(t *testing.T) {
	h := newShimHarness(t)
	h.enable()
	text, _ := json.Marshal(shimErrorPrefix + "0000000000000000" + `{"m":"Uncaught Error: other"}`)
	h.fromBrowser(fmt.Sprintf(`{"method":"Console.messageAdded","params":{"message":{"level":"debug","text":%s}},"sessionId":"S"}`, text))
	h.settle()
	if h.clientGot(method("Runtime.exceptionThrown")) || h.clientGot(method("Runtime.consoleAPICalled")) {
		t.Fatal("a report for another session's listener was delivered")
	}
}

func TestRuntimeShimReportsAWorkerErrorOnce(t *testing.T) {
	shim := newRuntimeShim(&cdpBridge{})
	report := `{"m":"Uncaught Error: boom","u":"blob:x","l":1,"c":1}`
	if shim.bubbledFromWorker(report, true) {
		t.Fatal("the worker's own report was dropped")
	}
	if !shim.bubbledFromWorker(report, false) {
		t.Fatal("the copy raised on the page was reported again")
	}
	if shim.bubbledFromWorker(report, false) {
		t.Fatal("a later page error with the same text was dropped")
	}
}

// The browser adds a binding to the contexts that already exist even while the
// domain is off, so the document that is loaded when a client registers one is
// served by the client's own command. The shim must not swallow or alter it.
func TestRuntimeShimForwardsABindingForTheLoadedDocument(t *testing.T) {
	h := newShimHarness(t)
	h.enable()
	h.fromClient(`{"id":3,"method":"Runtime.addBinding","params":{"name":"report"},"sessionId":"S"}`)
	forwarded := h.browserGets("the client's own command", func(msg shimMessage) bool {
		return msg.Method == "Runtime.addBinding" && msg.ID == 3
	})
	if forwarded.raw != `{"id":3,"method":"Runtime.addBinding","params":{"name":"report"},"sessionId":"S"}` {
		t.Fatalf("forwarded = %s", forwarded.raw)
	}
	h.clientGets("its answer", reply(3))
}

func TestRuntimeShimReinstallsBindingsInNewContexts(t *testing.T) {
	h := newShimHarness(t)
	h.enable()
	h.fromClient(`{"id":3,"method":"Runtime.addBinding","params":{"name":"report"},"sessionId":"S"}`)
	h.clientGets("addBinding answer", reply(3))
	h.browserGets("stand-in for early calls", func(msg shimMessage) bool {
		return msg.Method == "Page.addScriptToEvaluateOnNewDocument" && strings.Contains(msg.raw, `\"report\"`) && strings.Contains(msg.raw, "queue")
	})

	h.reply["DOM.resolveNode"] = func(shimMessage) any {
		return map[string]any{"object": map[string]any{"objectId": "9.21.1"}}
	}
	h.reply["Runtime.evaluate"] = func(msg shimMessage) any {
		switch {
		case strings.Contains(msg.raw, `"expression":"document"`):
			return map[string]any{"result": map[string]any{"objectId": "9.3.1"}}
		case strings.Contains(msg.raw, `"contextId":21`):
			return map[string]any{"result": map[string]any{"objectId": "9.21.8"}} // calls made before the binding existed
		}
		return map[string]any{"result": map[string]any{"type": "undefined"}}
	}
	h.fromBrowser(`{"method":"Page.frameNavigated","params":{"frame":{"id":"F","loaderId":"L2","securityOrigin":"https://b.test"},"type":"Navigation"},"sessionId":"S"}`)

	h.clientGets("contexts cleared", method("Runtime.executionContextsCleared"))
	h.clientGets("new main world", func(msg shimMessage) bool {
		return msg.Method == "Runtime.executionContextCreated" && strings.Contains(string(msg.Params), `"id":21`)
	})
	h.browserGets("binding in the new context", func(msg shimMessage) bool {
		return msg.Method == "Runtime.addBinding" && strings.Contains(string(msg.Params), `"executionContextId":21`) && strings.Contains(string(msg.Params), `"name":"report"`)
	})
	h.browserGets("queued calls delivered", func(msg shimMessage) bool {
		return msg.Method == "Runtime.callFunctionOn" && strings.Contains(string(msg.Params), `"objectId":"9.21.8"`)
	})
}

func TestRuntimeShimReportsDestroyedFrameContexts(t *testing.T) {
	h := newShimHarness(t)
	h.enable()
	h.reply["Page.createIsolatedWorld"] = func(shimMessage) any { return map[string]any{"executionContextId": 30} }
	h.reply["DOM.resolveNode"] = func(shimMessage) any {
		return map[string]any{"object": map[string]any{"objectId": "9.31.1"}}
	}
	h.reply["Runtime.evaluate"] = func(shimMessage) any {
		return map[string]any{"result": map[string]any{"objectId": "9.30.1"}}
	}
	h.fromBrowser(`{"method":"Page.frameAttached","params":{"frameId":"C","parentFrameId":"F"},"sessionId":"S"}`)
	h.clientGets("child main world", func(msg shimMessage) bool {
		return msg.Method == "Runtime.executionContextCreated" && strings.Contains(string(msg.Params), `"id":31`) && strings.Contains(string(msg.Params), `"frameId":"C"`)
	})
	h.fromBrowser(`{"method":"Page.frameDetached","params":{"frameId":"C","reason":"remove"},"sessionId":"S"}`)
	destroyed := h.clientGets("child context destroyed", method("Runtime.executionContextDestroyed"))
	if !strings.Contains(string(destroyed.Params), `"executionContextId":31`) || !strings.Contains(string(destroyed.Params), `"executionContextUniqueId":"9.31"`) {
		t.Fatalf("destroyed = %s", destroyed.Params)
	}
	h.settle()
	if h.clientGot(func(msg shimMessage) bool {
		return msg.Method == "Runtime.executionContextDestroyed" && strings.Contains(string(msg.Params), `"executionContextId":7`)
	}) {
		t.Fatal("the main frame's context was reported destroyed")
	}
}

func TestRuntimeShimHidesPageEventsTheClientDidNotAskFor(t *testing.T) {
	h := newShimHarness(t)
	h.enable()
	h.browserGets("Page.enable for the shim", method("Page.enable"))
	h.fromBrowser(`{"method":"Page.frameStoppedLoading","params":{"frameId":"F"},"sessionId":"S"}`)
	h.fromBrowser(`{"method":"Network.dataReceived","params":{},"sessionId":"S"}`)
	h.clientGets("unrelated event", method("Network.dataReceived"))
	if h.clientGot(method("Page.frameStoppedLoading")) {
		t.Fatal("a Page event reached a client that did not enable the domain")
	}

	h.fromClient(`{"id":4,"method":"Page.enable","sessionId":"S"}`)
	h.clientGets("Page.enable answer", reply(4))
	h.fromBrowser(`{"method":"Page.frameStoppedLoading","params":{"frameId":"F"},"sessionId":"S"}`)
	h.clientGets("Page event", method("Page.frameStoppedLoading"))

	h.fromClient(`{"id":6,"method":"Page.disable","sessionId":"S"}`)
	h.clientGets("Page.disable answer", reply(6))
	if h.browserGot(method("Page.disable")) {
		t.Fatal("Page.disable reached the browser while the shim depends on the domain")
	}
}

func TestRuntimeShimSendsLoadEventsForARestoredPage(t *testing.T) {
	h := newShimHarness(t)
	h.fromClient(`{"id":2,"method":"Page.setLifecycleEventsEnabled","params":{"enabled":true},"sessionId":"S"}`)
	h.clientGets("lifecycle answer", reply(2))
	h.fromClient(`{"id":3,"method":"Page.enable","sessionId":"S"}`)
	h.clientGets("Page.enable answer", reply(3))
	h.fromBrowser(`{"method":"Page.frameNavigated","params":{"frame":{"id":"F","loaderId":"L9","securityOrigin":"https://a.test"},"type":"BackForwardCacheRestore"},"sessionId":"S"}`)

	h.clientGets("load event", func(msg shimMessage) bool {
		return msg.Method == "Page.lifecycleEvent" && strings.Contains(string(msg.Params), `"name":"load"`) && strings.Contains(string(msg.Params), `"loaderId":"L9"`)
	})
	h.mu.Lock()
	defer h.mu.Unlock()
	navigated := false
	var names []string
	for _, msg := range h.received {
		switch msg.Method {
		case "Page.frameNavigated":
			navigated = true
		case "Page.lifecycleEvent":
			if !navigated {
				t.Fatal("a load event preceded the navigation it belongs to")
			}
			var event struct {
				Name string `json:"name"`
			}
			_ = json.Unmarshal(msg.Params, &event)
			names = append(names, event.Name)
		}
	}
	if strings.Join(names, ",") != "init,commit,DOMContentLoaded,load" {
		t.Fatalf("lifecycle events = %v", names)
	}
}

func TestRuntimeShimKeepsALateReplyFromTheClient(t *testing.T) {
	h := newShimHarness(t)
	h.mu.Lock()
	h.reply["Console.enable"] = func(shimMessage) any { return nil } // never answered in time
	h.mu.Unlock()
	h.fromClient(`{"id":1,"method":"Runtime.enable","sessionId":"S"}`)
	pending := h.browserGets("Console.enable", method("Console.enable"))
	h.clientGets("Runtime.enable answer once the wait runs out", reply(1))

	h.fromBrowser(fmt.Sprintf(`{"id":%d,"result":{},"sessionId":"S"}`, pending.ID))
	h.fromBrowser(`{"method":"Network.dataReceived","params":{},"sessionId":"S"}`)
	h.clientGets("later event", method("Network.dataReceived"))
	if h.clientGot(reply(pending.ID)) {
		t.Fatal("a reply to a command the client never sent was forwarded")
	}
}

func TestRuntimeShimLeavesClientIDsAlone(t *testing.T) {
	h := newShimHarness(t)
	h.enable()
	// Any id a client chooses is the client's, however large or negative.
	for _, id := range []int64{1_500_000_001, 2_147_483_647, -40_000} {
		h.fromClient(fmt.Sprintf(`{"id":%d,"method":"Browser.getVersion"}`, id))
		h.browserGets("forwarded command", func(msg shimMessage) bool { return msg.ID == id && msg.Method == "Browser.getVersion" })
		h.clientGets("its reply", reply(id))
	}
}

func TestRuntimeShimStepsAroundAClientsNegativeID(t *testing.T) {
	h := newShimHarness(t)
	h.mu.Lock()
	h.reply["Browser.getVersion"] = func(shimMessage) any { return nil } // left in flight
	h.mu.Unlock()
	// The shim's first id would be -1; the client has it out already.
	h.fromClient(`{"method": "Browser.getVersion", "id": -1}`)
	h.browserGets("client command", func(msg shimMessage) bool { return msg.ID == -1 && msg.Method == "Browser.getVersion" })
	h.enable()
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, msg := range h.commands {
		if msg.ID == -1 && msg.Method != "Browser.getVersion" {
			t.Fatalf("the shim reused the client's id for %s", msg.Method)
		}
	}
}

func TestRuntimeShimRefusesAClientIDItHasOut(t *testing.T) {
	h := newShimHarness(t)
	h.mu.Lock()
	h.reply["Console.enable"] = func(shimMessage) any { return nil } // the shim's command stays in flight
	h.mu.Unlock()
	h.fromClient(`{"id":1,"method":"Runtime.enable","sessionId":"S"}`)
	pending := h.browserGets("Console.enable", method("Console.enable"))

	// Spaced as a client is free to write it.
	h.fromClient(fmt.Sprintf(`{ "id" : %d , "method" : "Browser.getVersion", "sessionId": "S" }`, pending.ID))
	refused := h.clientGets("refusal", func(msg shimMessage) bool { return msg.ID == pending.ID && strings.Contains(msg.raw, `"error"`) })
	if refused.SessionID != "S" {
		t.Fatalf("refusal = %s", refused.raw)
	}
	if h.browserGot(func(msg shimMessage) bool { return msg.ID == pending.ID && msg.Method == "Browser.getVersion" }) {
		t.Fatal("two commands with one id reached the browser")
	}
}

func TestContextIDFromObjectID(t *testing.T) {
	id, isolate, err := contextIDFromObjectID("-2056584488901696505.4.17")
	if err != nil || id != 4 || isolate != "-2056584488901696505" {
		t.Fatalf("got id=%d isolate=%q err=%v", id, isolate, err)
	}
	for _, bad := range []string{"", "1.2", "a.b.c", "1.2.3.4"} {
		if _, _, err := contextIDFromObjectID(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

func TestEventSession(t *testing.T) {
	cases := map[string]string{
		`{"method":"Page.frameNavigated","params":{},"sessionId":"ABC"}`: "ABC",
		`{"method":"Page.frameNavigated","params":{}}`:                   "",
		// A session id inside the params belongs to another target.
		`{"method":"Target.attachedToTarget","params":{"sessionId":"INNER"},"sessionId":"OUTER"}`: "OUTER",
	}
	for payload, want := range cases {
		if got := eventSession([]byte(payload)); got != want {
			t.Fatalf("eventSession(%s) = %q, want %q", payload, got, want)
		}
	}
}
