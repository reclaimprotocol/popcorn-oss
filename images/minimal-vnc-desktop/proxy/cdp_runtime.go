package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// runtimeShim keeps the Runtime domain disabled in the browser while a full-CDP
// client that asks for it still gets what the domain would have reported.
//
// Pages can observe an enabled Runtime domain, so the client's Runtime.enable
// is answered here instead of being forwarded. Each thing the domain provides
// is rebuilt from commands that work while it is off:
//
//   - Execution contexts: an isolated world's id comes back from
//     Page.createIsolatedWorld, and a frame's main-world id is the middle field
//     of any object id resolved in that world.
//   - Bindings: the browser adds a binding to the contexts that exist when the
//     command arrives whether or not the domain is on, so the client's command
//     is forwarded as it is. What the browser skips, with the domain off, is
//     every context created afterwards. Each binding the client registers is
//     therefore added again to every context reported here. That lands shortly
//     after the document starts, so until then a stand-in queues the calls
//     made by scripts that run first.
//   - Navigation: contexts come and go with frames, which only the Page domain
//     reports. It is enabled for every session described here, and its events
//     are kept from a client that did not enable it.
//   - Console calls: the Console domain reports them as text without
//     serialising their arguments.
//   - Uncaught errors: a main-world listener installed before page scripts
//     reports the fields the browser itself sets on the event.
//
// Frame-bearing targets and workers are both covered; a worker has a single
// context and no frames, so its context is read from its global object.
//
// One thing here is unrelated to the Runtime domain: a page restored from the
// back/forward cache does not load again, so the browser sends none of the load
// events a client waits for after a history navigation. They are sent here.
type runtimeShim struct {
	b       *cdpBridge
	console bool
	errors  bool
	mu      sync.Mutex

	// The shim's own commands are numbered downwards from -1. Clients count
	// upwards, so the two do not meet; a client that does use negative ids is
	// tracked in clientIDs so the shim steps around it. issued holds every id
	// the shim has sent until its reply arrives, including one whose caller
	// stopped waiting: only those replies are kept from the client.
	nextID      int64
	issued      map[int64]struct{}
	clientIDs   map[int64]struct{}
	callTimeout time.Duration
	exceptionID int
	// Reports from workers, by content, so the copy that bubbles to the
	// owning page is not reported a second time.
	workerErrors map[string]time.Time
	// Events to send once the browser frame being handled has been forwarded.
	// Only the goroutine that reads the browser touches it.
	after       []any
	calls       map[int64]chan shimReply
	clientWorld map[int64]shimWorld
	sessions    map[string]*shimSession
	passthrough map[string]bool
}

type shimSession struct {
	worker        bool
	enabled       bool
	enabling      bool
	held          [][]byte
	clientConsole bool
	clientPage    bool
	lifecycle     bool
	worlds        []string
	bindings      []shimBinding
	announced     map[int]bool
	contexts      map[string][]shimContext
	rootFrame     string
	mainContext   int
	nonce         string
}

type shimContext struct {
	id       int
	uniqueID string
}

type shimBinding struct {
	name, world string
}

type shimWorld struct {
	session, frameID, name string
}

type shimReply struct {
	result json.RawMessage
	err    error
}

const (
	shimCallTimeout = 5 * time.Second
	// Ids wrap before they leave the range the browser accepts.
	shimLastID = -2_000_000_000
	// Only used to reach a frame's document when the client registered no world.
	shimProbeWorld = "cdp"
	// Marks a console message as an error report from the listener below.
	shimErrorPrefix = "\x01cdp-uncaught\x01"
)

// shimErrorScript reports uncaught errors and unhandled rejections through a
// console function captured before any page script can replace it. It reads
// only event fields the browser sets, through getters captured the same way.
//
// A rejection's reason is page-controlled, and any access a page can observe
// (a getter, a proxy trap, its stack formatter) would reveal the listener. So
// the reason is described only as far as that is unobservable: Error.isError
// accepts no proxy and runs no page code, and a genuine error's message is
// then read from an own data property. Its stack is never read. %s is the
// per-session prefix. The script also runs in workers.
const shimErrorScript = `(() => {
  const report = console.debug.bind(console), apply = Reflect.apply, json = JSON.stringify;
  const describe = Object.getOwnPropertyDescriptor, protoOf = Object.getPrototypeOf, isError = Error.isError;
  const getter = (proto, name) => describe(proto, name).get;
  const error = ErrorEvent.prototype, message = getter(error, 'message'), file = getter(error, 'filename');
  const line = getter(error, 'lineno'), column = getter(error, 'colno');
  const reason = getter(PromiseRejectionEvent.prototype, 'reason');
  const dom = DOMException.prototype, domName = getter(dom, 'name'), domMessage = getter(dom, 'message');
  const natives = [[Error.prototype, 'Error'], [TypeError.prototype, 'TypeError'], [RangeError.prototype, 'RangeError'],
    [SyntaxError.prototype, 'SyntaxError'], [ReferenceError.prototype, 'ReferenceError'], [EvalError.prototype, 'EvalError'],
    [URIError.prototype, 'URIError'], [AggregateError.prototype, 'AggregateError']];
  const listen = EventTarget.prototype.addEventListener;
  apply(listen, globalThis, ['error', event => {
    try { report(%[1]s + json({ m: apply(message, event, []), u: apply(file, event, []), l: apply(line, event, []), c: apply(column, event, []) })); } catch (_) {}
  }, true]);
  apply(listen, globalThis, ['unhandledrejection', event => {
    try {
      const value = apply(reason, event, []), kind = typeof value, out = { p: true, k: kind };
      if (value === null) out.k = 'null';
      else if (kind === 'string' || kind === 'number' || kind === 'boolean') out.v = value;
      else if (kind === 'object' && isError && isError(value)) {
        const proto = protoOf(value);
        out.k = 'error'; out.n = 'Error'; out.m = '';
        if (proto === dom) { out.n = apply(domName, value, []); out.m = apply(domMessage, value, []); }
        else {
          for (let i = 0; i < natives.length; i++) if (natives[i][0] === proto) out.n = natives[i][1];
          const own = describe(value, 'message');
          if (own && typeof own.value === 'string') out.m = own.value;
        }
      }
      report(%[1]s + json(out));
    } catch (_) {}
  }, true]);
})()`

// textAssembler joins a text message that arrives split across websocket
// frames, so that it is read whole.
type textAssembler struct {
	open    bool
	pending []byte
}

// next takes one data frame and returns the frame to handle now. A piece of a
// split text message is held until the message is complete, and the message
// then comes back as a single final text frame. Everything else comes back as
// it went in.
func (a *textAssembler) next(opcode byte, payload []byte, fin bool) (byte, []byte, bool, bool, error) {
	switch {
	case opcode == 0x1 && !fin:
		a.open, a.pending = true, append(a.pending[:0], payload...)
		return opcode, nil, fin, true, nil
	case opcode == 0x0 && a.open:
		if uint64(len(a.pending))+uint64(len(payload)) > maxWSFrame {
			a.open, a.pending = false, nil
			return opcode, nil, fin, false, errors.New("split text message is too large")
		}
		a.pending = append(a.pending, payload...)
		if !fin {
			return opcode, nil, fin, true, nil
		}
		whole := a.pending
		a.open, a.pending = false, nil
		return 0x1, whole, true, false, nil
	}
	return opcode, payload, fin, false, nil
}

// shimBindingStub stands in for a binding until the browser installs the real
// one over it, keeping the payloads of calls made in between. %s is the name.
const shimBindingStub = `(() => {
  const name = %s;
  if (typeof globalThis[name] === 'function') return;
  const queue = [], stub = payload => { queue.push(payload); };
  stub.queue = queue;
  globalThis[name] = stub;
})()`

var shimDebug = shimFlag("CDP_RUNTIME_SHIM_DEBUG", false)

func shimFlag(name string, fallback bool) bool {
	value, err := strconv.ParseBool(strings.TrimSpace(os.Getenv(name)))
	if err != nil {
		return fallback
	}
	return value
}

func shimLog(format string, args ...any) {
	if shimDebug {
		log.Printf("[cdp-shim] "+format, args...)
	}
}

func runtimeShimEnabled() bool {
	return shimFlag("CDP_RUNTIME_SHIM", false)
}

func newRuntimeShim(b *cdpBridge) *runtimeShim {
	return &runtimeShim{
		b:           b,
		console:     shimFlag("CDP_RUNTIME_SHIM_CONSOLE", true),
		errors:      shimFlag("CDP_RUNTIME_SHIM_ERRORS", true),
		issued:      map[int64]struct{}{},
		clientIDs:   map[int64]struct{}{},
		callTimeout: shimCallTimeout,
		calls:       map[int64]chan shimReply{},
		clientWorld: map[int64]shimWorld{},
		sessions:    map[string]*shimSession{},
		passthrough: map[string]bool{},

		workerErrors: map[string]time.Time{},
	}
}

// session returns the state for sessionID; the caller holds s.mu.
func (s *runtimeShim) session(sessionID string) *shimSession {
	sess := s.sessions[sessionID]
	if sess == nil {
		nonce := make([]byte, 8)
		_, _ = rand.Read(nonce)
		sess = &shimSession{announced: map[int]bool{}, contexts: map[string][]shimContext{}, nonce: hex.EncodeToString(nonce)}
		s.sessions[sessionID] = sess
	}
	return sess
}

func (sess *shimSession) addWorld(name string) {
	if name != "" && !slices.Contains(sess.worlds, name) {
		sess.worlds = append(sess.worlds, name)
	}
}

// dropFrame forgets a frame's contexts and returns them.
func (sess *shimSession) dropFrame(frameID string) []shimContext {
	dropped := sess.contexts[frameID]
	delete(sess.contexts, frameID)
	for _, context := range dropped {
		delete(sess.announced, context.id)
	}
	return dropped
}

func (sess *shimSession) removeBinding(name string) {
	sess.bindings = slices.DeleteFunc(sess.bindings, func(binding shimBinding) bool { return binding.name == name })
}

// fromClient reports whether a complete client text frame should be forwarded.
func (s *runtimeShim) fromClient(payload []byte) bool {
	forward, unlocked := s.clientFrame(payload)
	// Sent ahead of the client's frame, and after the state lock is released.
	if unlocked != nil {
		unlocked()
	}
	return forward
}

// clientFrame decides what happens to a client frame, and returns what has to
// be sent first, once the state lock is released.
func (s *runtimeShim) clientFrame(payload []byte) (forward bool, unlocked func()) {
	var msg struct {
		ID        int64           `json:"id"`
		Method    string          `json:"method"`
		SessionID string          `json:"sessionId"`
		RawParams json.RawMessage `json:"params"`
		Params    struct {
			FrameID              string `json:"frameId"`
			WorldName            string `json:"worldName"`
			Name                 string `json:"name"`
			ExecutionContextID   int    `json:"executionContextId"`
			ExecutionContextName string `json:"executionContextName"`
			Enabled              bool   `json:"enabled"`
		} `json:"-"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return true, nil
	}
	// Only the methods handled below have parameters in this shape.
	_ = json.Unmarshal(msg.RawParams, &msg.Params)
	s.mu.Lock()
	defer s.mu.Unlock()
	if msg.ID < 0 {
		// A client's negative id is the client's: the shim steps around it
		// while the command is in flight. The one case the two cannot share
		// is an id the shim has out now.
		if _, taken := s.issued[msg.ID]; taken {
			return false, func() { s.refuse(msg.ID, msg.SessionID) }
		}
		s.clientIDs[msg.ID] = struct{}{}
	}
	if s.passthrough[msg.SessionID] {
		return true, nil
	}
	switch msg.Method {
	case "Runtime.enable":
		sess := s.session(msg.SessionID)
		sess.enabled, sess.enabling = true, true
		shimLog("Runtime.enable session=%.8s worker=%v", msg.SessionID, sess.worker)
		go s.enable(msg.ID, msg.SessionID, append([]byte(nil), payload...))
		return false, nil
	case "Runtime.runIfWaitingForDebugger":
		// A worker paused at start must not run before the error listener is
		// in place. A paused frame cannot be held the same way: it does not
		// answer the commands that describe it until it runs.
		if sess := s.sessions[msg.SessionID]; sess != nil && sess.enabling && sess.worker {
			sess.held = append(sess.held, append([]byte(nil), payload...))
			return false, nil
		}
	case "Runtime.addBinding":
		// Forwarded below, which covers the contexts that exist now. Only a
		// binding meant for every context has to follow into later ones; one
		// aimed at a single context does not.
		if msg.Params.ExecutionContextID == 0 {
			sess := s.session(msg.SessionID)
			sess.removeBinding(msg.Params.Name)
			sess.bindings = append(sess.bindings, shimBinding{name: msg.Params.Name, world: msg.Params.ExecutionContextName})
			if sess.enabled && !sess.worker {
				// Registered before the client's own document-start scripts,
				// which are the ones that may call the binding first.
				name, _ := json.Marshal(msg.Params.Name)
				params := map[string]any{"source": fmt.Sprintf(shimBindingStub, name)}
				if msg.Params.ExecutionContextName != "" {
					params["worldName"] = msg.Params.ExecutionContextName
				}
				unlocked = func() { s.send(msg.SessionID, "Page.addScriptToEvaluateOnNewDocument", params) }
			}
		}
	case "Runtime.removeBinding":
		s.session(msg.SessionID).removeBinding(msg.Params.Name)
	case "Console.enable":
		s.session(msg.SessionID).clientConsole = true
	case "Console.disable":
		sess := s.session(msg.SessionID)
		sess.clientConsole = false
		if sess.enabled && (s.console || s.errors) {
			// Keep the domain on for the shim; answer as the browser would.
			go s.toClient(shimResult{ID: msg.ID, SessionID: msg.SessionID})
			return false, nil
		}
	case "Page.enable":
		s.session(msg.SessionID).clientPage = true
	case "Page.disable":
		sess := s.session(msg.SessionID)
		sess.clientPage = false
		if sess.enabled && !sess.worker {
			// The shim still needs the domain; its events are withheld instead.
			go s.toClient(shimResult{ID: msg.ID, SessionID: msg.SessionID})
			return false, nil
		}
	case "Page.setLifecycleEventsEnabled":
		s.session(msg.SessionID).lifecycle = msg.Params.Enabled
	case "Page.addScriptToEvaluateOnNewDocument":
		s.session(msg.SessionID).addWorld(msg.Params.WorldName)
	case "Page.createIsolatedWorld":
		s.session(msg.SessionID).addWorld(msg.Params.WorldName)
		s.clientWorld[msg.ID] = shimWorld{session: msg.SessionID, frameID: msg.Params.FrameID, name: msg.Params.WorldName}
	}
	return true, unlocked
}

var (
	shimIDPrefix        = []byte(`{"id":`)
	shimFrameNavigated  = []byte(`{"method":"Page.frameNavigated"`)
	shimFrameAttached   = []byte(`{"method":"Page.frameAttached"`)
	shimFrameDetached   = []byte(`{"method":"Page.frameDetached"`)
	shimConsoleMessage  = []byte(`{"method":"Console.messageAdded"`)
	shimAttachedTarget  = []byte(`{"method":"Target.attachedToTarget"`)
	shimDetachedSession = []byte(`{"method":"Target.detachedFromTarget"`)
)

var (
	shimPagePrefix    = []byte(`{"method":"Page.`)
	shimSessionMarker = []byte(`,"sessionId":"`)
)

// eventSession reads the session id a browser message ends with.
func eventSession(payload []byte) string {
	tail := payload
	if len(tail) > 160 {
		tail = tail[len(tail)-160:]
	}
	at := bytes.LastIndex(tail, shimSessionMarker)
	if at < 0 {
		return ""
	}
	id := tail[at+len(shimSessionMarker):]
	if end := bytes.IndexByte(id, '"'); end >= 0 {
		return string(id[:end])
	}
	return ""
}

// fromUpstream reports whether a complete browser text frame should be forwarded.
func (s *runtimeShim) fromUpstream(payload []byte) bool {
	if !s.handleUpstream(payload) {
		return false
	}
	if !bytes.HasPrefix(payload, shimPagePrefix) {
		return true
	}
	// Page events exist on this session only because the shim asked for them.
	s.mu.Lock()
	sess := s.sessions[eventSession(payload)]
	hidden := sess != nil && sess.enabled && !sess.worker && !sess.clientPage
	s.mu.Unlock()
	return !hidden
}

func (s *runtimeShim) handleUpstream(payload []byte) bool {
	switch {
	case bytes.HasPrefix(payload, shimIDPrefix):
		return s.response(payload)
	case bytes.HasPrefix(payload, shimConsoleMessage):
		return s.consoleMessage(payload)
	case bytes.HasPrefix(payload, shimFrameNavigated):
		var event struct {
			SessionID string `json:"sessionId"`
			Params    struct {
				Type  string `json:"type"`
				Frame struct {
					ID             string `json:"id"`
					ParentID       string `json:"parentId"`
					LoaderID       string `json:"loaderId"`
					SecurityOrigin string `json:"securityOrigin"`
				} `json:"frame"`
			} `json:"params"`
		}
		if json.Unmarshal(payload, &event) != nil {
			return true
		}
		frame := event.Params.Frame
		root := frame.ParentID == ""
		s.mu.Lock()
		sess := s.sessions[event.SessionID]
		active := sess != nil && sess.enabled
		restored := sess != nil && sess.lifecycle && event.Params.Type == "BackForwardCacheRestore"
		var dropped []shimContext
		if active {
			if root {
				sess.announced = map[int]bool{}
				sess.contexts = map[string][]shimContext{}
				sess.rootFrame = frame.ID
				sess.mainContext = 0
			} else {
				dropped = sess.dropFrame(frame.ID)
			}
		}
		s.mu.Unlock()
		shimLog("frameNavigated session=%.8s frame=%.8s parent=%.8s type=%s active=%v", event.SessionID, frame.ID, frame.ParentID, event.Params.Type, active)
		if restored {
			now := float64(time.Now().UnixNano()) / 1e9
			for _, name := range []string{"init", "commit", "DOMContentLoaded", "load"} {
				s.after = append(s.after, shimEvent{
					Method:    "Page.lifecycleEvent",
					Params:    map[string]any{"frameId": frame.ID, "loaderId": frame.LoaderID, "name": name, "timestamp": now},
					SessionID: event.SessionID,
				})
			}
		}
		if !active {
			return true
		}
		if root {
			s.toClient(shimEvent{Method: "Runtime.executionContextsCleared", Params: struct{}{}, SessionID: event.SessionID})
		}
		s.destroyed(event.SessionID, dropped)
		go s.probeFrame(event.SessionID, frame.ID, frame.SecurityOrigin)
	case bytes.HasPrefix(payload, shimFrameDetached):
		var event struct {
			SessionID string `json:"sessionId"`
			Params    struct {
				FrameID string `json:"frameId"`
			} `json:"params"`
		}
		if json.Unmarshal(payload, &event) != nil {
			return true
		}
		s.mu.Lock()
		var dropped []shimContext
		if sess := s.sessions[event.SessionID]; sess != nil && sess.enabled {
			dropped = sess.dropFrame(event.Params.FrameID)
		}
		s.mu.Unlock()
		s.destroyed(event.SessionID, dropped)
	case bytes.HasPrefix(payload, shimFrameAttached):
		var event struct {
			SessionID string `json:"sessionId"`
			Params    struct {
				FrameID string `json:"frameId"`
			} `json:"params"`
		}
		if json.Unmarshal(payload, &event) != nil {
			return true
		}
		s.mu.Lock()
		sess := s.sessions[event.SessionID]
		active := sess != nil && sess.enabled
		s.mu.Unlock()
		if active {
			go s.probeFrame(event.SessionID, event.Params.FrameID, "")
		}
	case bytes.HasPrefix(payload, shimAttachedTarget):
		var event struct {
			Params struct {
				SessionID  string `json:"sessionId"`
				TargetInfo struct {
					Type string `json:"type"`
				} `json:"targetInfo"`
			} `json:"params"`
		}
		if json.Unmarshal(payload, &event) != nil {
			return true
		}
		shimLog("attachedToTarget session=%.8s type=%s", event.Params.SessionID, event.Params.TargetInfo.Type)
		s.mu.Lock()
		switch event.Params.TargetInfo.Type {
		case "page", "iframe":
		case "worker", "service_worker", "shared_worker":
			s.session(event.Params.SessionID).worker = true
		default:
			s.passthrough[event.Params.SessionID] = true
		}
		s.mu.Unlock()
	case bytes.HasPrefix(payload, shimDetachedSession):
		var event struct {
			Params struct {
				SessionID string `json:"sessionId"`
			} `json:"params"`
		}
		if json.Unmarshal(payload, &event) == nil {
			s.mu.Lock()
			delete(s.sessions, event.Params.SessionID)
			delete(s.passthrough, event.Params.SessionID)
			s.mu.Unlock()
		}
	}
	return true
}

// destroyed tells the client that contexts it was told about are gone.
func (s *runtimeShim) destroyed(sessionID string, contexts []shimContext) {
	for _, context := range contexts {
		s.toClient(shimEvent{
			Method:    "Runtime.executionContextDestroyed",
			Params:    map[string]any{"executionContextId": context.id, "executionContextUniqueId": context.uniqueID},
			SessionID: sessionID,
		})
	}
}

// flushAfter sends what fromUpstream queued behind the frame it was handling.
func (s *runtimeShim) flushAfter() {
	for _, event := range s.after {
		s.toClient(event)
	}
	s.after = nil
}

func (s *runtimeShim) response(payload []byte) bool {
	end := len(shimIDPrefix)
	if end < len(payload) && payload[end] == '-' {
		end++
	}
	for end < len(payload) && payload[end] >= '0' && payload[end] <= '9' {
		end++
	}
	id, err := strconv.ParseInt(string(payload[len(shimIDPrefix):end]), 10, 64)
	if err != nil {
		return true
	}
	s.mu.Lock()
	_, issued := s.issued[id]
	delete(s.issued, id)
	call, own := s.calls[id]
	delete(s.calls, id)
	world, isWorld := s.clientWorld[id]
	delete(s.clientWorld, id)
	delete(s.clientIDs, id)
	s.mu.Unlock()
	if issued && !own {
		// A reply that outlived its caller, or to a command nothing waits on.
		// A client fails on a reply to a command it never sent.
		return false
	}
	if own {
		var msg struct {
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		reply := shimReply{}
		if err := json.Unmarshal(payload, &msg); err != nil {
			reply.err = err
		} else if msg.Error != nil {
			reply.err = errors.New(msg.Error.Message)
		} else {
			reply.result = msg.Result
		}
		call <- reply
		return false
	}
	if isWorld {
		var msg struct {
			Result struct {
				ExecutionContextID int `json:"executionContextId"`
			} `json:"result"`
		}
		if json.Unmarshal(payload, &msg) == nil && msg.Result.ExecutionContextID != 0 {
			// The browser reports a new context before it answers the command.
			// This runs on the reader, so it must not wait for a browser reply.
			go s.announce(world.session, msg.Result.ExecutionContextID, world.frameID, "", world.name, "")
		}
	}
	return true
}

// consoleMessage turns a Console-domain message into the Runtime event the
// client expects. The original is forwarded only to a client that enabled the
// Console domain itself.
func (s *runtimeShim) consoleMessage(payload []byte) bool {
	var event struct {
		SessionID string `json:"sessionId"`
		Params    struct {
			Message struct {
				Level  string `json:"level"`
				Text   string `json:"text"`
				URL    string `json:"url"`
				Line   int    `json:"line"`
				Column int    `json:"column"`
			} `json:"message"`
		} `json:"params"`
	}
	if json.Unmarshal(payload, &event) != nil {
		return true
	}
	s.mu.Lock()
	sess := s.sessions[event.SessionID]
	if sess == nil || !sess.enabled {
		s.mu.Unlock()
		return true
	}
	forward, contextID, nonce, worker := sess.clientConsole, sess.mainContext, sess.nonce, sess.worker
	s.mu.Unlock()

	message := event.Params.Message
	now := float64(time.Now().UnixMilli())
	if report, ok := strings.CutPrefix(message.Text, shimErrorPrefix); ok {
		// Every session on a page installs its own listener; each reports once.
		if report, ok = strings.CutPrefix(report, nonce); ok && !s.bubbledFromWorker(report, worker) {
			s.exception(event.SessionID, contextID, report, now)
		}
		return false
	}
	if !s.console {
		return forward
	}
	// Chrome's position is 1-based here and 0-based in a stack frame.
	frame := map[string]any{
		"functionName": "", "scriptId": "0", "url": message.URL,
		"lineNumber": max(message.Line-1, 0), "columnNumber": max(message.Column-1, 0),
	}
	s.toClient(shimEvent{
		Method: "Runtime.consoleAPICalled",
		Params: map[string]any{
			"type":               message.Level,
			"args":               []any{map[string]any{"type": "string", "value": message.Text}},
			"executionContextId": contextID,
			"timestamp":          now,
			"stackTrace":         map[string]any{"callFrames": []any{frame}},
		},
		SessionID: event.SessionID,
	})
	return forward
}

// bubbledFromWorker reports whether a page's error report repeats one a worker
// just made: an error a worker does not handle is raised again on its page.
func (s *runtimeShim) bubbledFromWorker(report string, worker bool) bool {
	const window = 2 * time.Second
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, seen := range s.workerErrors {
		if now.Sub(seen) > window {
			delete(s.workerErrors, key)
		}
	}
	if worker {
		s.workerErrors[report] = now
		return false
	}
	if _, ok := s.workerErrors[report]; ok {
		delete(s.workerErrors, report)
		return true
	}
	return false
}

func (s *runtimeShim) exception(sessionID string, contextID int, report string, now float64) {
	var details struct {
		Message   string          `json:"m"`
		URL       string          `json:"u"`
		Line      int             `json:"l"`
		Column    int             `json:"c"`
		Rejection bool            `json:"p"`
		Kind      string          `json:"k"`
		Name      string          `json:"n"`
		Value     json.RawMessage `json:"v"`
	}
	if json.Unmarshal([]byte(report), &details) != nil {
		return
	}
	text := "Uncaught"
	var exception map[string]any
	switch {
	case !details.Rejection:
		description := strings.TrimPrefix(details.Message, "Uncaught ")
		if details.URL != "" {
			description += fmt.Sprintf("\n    at %s:%d:%d", details.URL, details.Line, details.Column)
		}
		exception = map[string]any{"type": "object", "subtype": "error", "className": "Error", "description": description}
	case details.Kind == "error":
		text = "Uncaught (in promise)"
		description := details.Name
		if details.Message != "" {
			description += ": " + details.Message
		}
		exception = map[string]any{"type": "object", "subtype": "error", "className": details.Name, "description": description}
	case len(details.Value) > 0:
		text = "Uncaught (in promise)"
		exception = map[string]any{"type": details.Kind, "value": details.Value}
	case details.Kind == "undefined":
		text = "Uncaught (in promise)"
		exception = map[string]any{"type": "undefined"}
	case details.Kind == "null":
		text = "Uncaught (in promise)"
		exception = map[string]any{"type": "object", "subtype": "null", "value": nil}
	default:
		// An object that could not be inspected without the page noticing.
		text = "Uncaught (in promise)"
		exception = map[string]any{"type": "object", "className": "Object", "description": "Object"}
	}
	s.mu.Lock()
	s.exceptionID++
	id := s.exceptionID
	s.mu.Unlock()
	s.toClient(shimEvent{
		Method: "Runtime.exceptionThrown",
		Params: map[string]any{
			"timestamp": now,
			"exceptionDetails": map[string]any{
				"exceptionId": id, "text": text, "url": details.URL,
				"lineNumber": max(details.Line-1, 0), "columnNumber": max(details.Column-1, 0),
				"executionContextId": contextID, "exception": exception,
			},
		},
		SessionID: sessionID,
	})
}

func (s *runtimeShim) call(sessionID, method string, params any) (json.RawMessage, error) {
	reply := make(chan shimReply, 1)
	id := s.commandID()
	s.mu.Lock()
	s.calls[id] = reply
	s.mu.Unlock()
	payload, err := json.Marshal(struct {
		ID        int64  `json:"id"`
		Method    string `json:"method"`
		Params    any    `json:"params,omitempty"`
		SessionID string `json:"sessionId,omitempty"`
	}{id, method, params, sessionID})
	if err == nil {
		err = writeFrameToConn(s.b.upstream, &s.b.upstreamMu, 0x1, payload, true, true)
	}
	if err != nil {
		s.mu.Lock()
		delete(s.calls, id)
		s.mu.Unlock()
		return nil, err
	}
	select {
	case r := <-reply:
		return r.result, r.err
	case <-time.After(s.callTimeout):
		s.mu.Lock()
		delete(s.calls, id)
		s.mu.Unlock()
		return nil, fmt.Errorf("%s timed out", method)
	}
}

// refuse answers a client command that cannot be forwarded under its id.
func (s *runtimeShim) refuse(id int64, sessionID string) {
	type failure struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	s.toClient(struct {
		ID        int64   `json:"id"`
		Error     failure `json:"error"`
		SessionID string  `json:"sessionId,omitempty"`
	}{id, failure{-32600, "Command id is in use"}, sessionID})
}

// commandID reserves the id of a command the shim issues.
func (s *runtimeShim) commandID() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	for {
		s.nextID--
		if s.nextID < shimLastID {
			s.nextID = -1
		}
		_, issued := s.issued[s.nextID]
		_, client := s.clientIDs[s.nextID]
		if !issued && !client {
			s.issued[s.nextID] = struct{}{}
			return s.nextID
		}
	}
}

// send issues a command without waiting; its reply is dropped by id.
func (s *runtimeShim) send(sessionID, method string, params any) {
	payload, err := json.Marshal(struct {
		ID        int64  `json:"id"`
		Method    string `json:"method"`
		Params    any    `json:"params,omitempty"`
		SessionID string `json:"sessionId,omitempty"`
	}{s.commandID(), method, params, sessionID})
	if err == nil {
		_ = writeFrameToConn(s.b.upstream, &s.b.upstreamMu, 0x1, payload, true, true)
	}
}

type shimEvent struct {
	Method    string `json:"method"`
	Params    any    `json:"params"`
	SessionID string `json:"sessionId,omitempty"`
}

type shimResult struct {
	ID        int64    `json:"id"`
	Result    struct{} `json:"result"`
	SessionID string   `json:"sessionId,omitempty"`
}

func (s *runtimeShim) toClient(v any) {
	payload, err := json.Marshal(v)
	if err != nil {
		return
	}
	_ = writeFrameToConn(s.b.client, &s.b.clientMu, 0x1, payload, false, true)
}

type shimFrameTree struct {
	Frame struct {
		ID             string `json:"id"`
		SecurityOrigin string `json:"securityOrigin"`
	} `json:"frame"`
	ChildFrames []shimFrameTree `json:"childFrames"`
}

// enable answers the client's Runtime.enable after reporting the contexts the
// session already has, then lets a target that was paused at start run.
func (s *runtimeShim) enable(id int64, sessionID string, original []byte) {
	s.mu.Lock()
	sess := s.session(sessionID)
	worker, nonce := sess.worker, sess.nonce
	s.mu.Unlock()

	var err error
	if worker {
		err = s.enableWorker(sessionID)
	} else {
		err = s.enableFrames(sessionID)
	}
	if err != nil {
		// Not a target this can describe: let the browser handle it as usual.
		shimLog("session=%.8s passthrough: %v", sessionID, err)
		s.mu.Lock()
		s.passthrough[sessionID] = true
		s.mu.Unlock()
		_ = writeFrameToConn(s.b.upstream, &s.b.upstreamMu, 0x1, original, true, true)
		s.resume(sessionID, true)
		return
	}
	if s.errors {
		prefix, _ := json.Marshal(shimErrorPrefix + nonce)
		source := fmt.Sprintf(shimErrorScript, prefix)
		if worker {
			_, err = s.call(sessionID, "Runtime.evaluate", map[string]any{"expression": source})
		} else {
			_, err = s.call(sessionID, "Page.addScriptToEvaluateOnNewDocument", map[string]any{"source": source, "runImmediately": true})
		}
		if err != nil {
			shimLog("error listener session=%.8s failed: %v", sessionID, err)
		}
	}
	if s.console || s.errors {
		if _, err := s.call(sessionID, "Console.enable", nil); err != nil {
			shimLog("Console.enable session=%.8s failed: %v", sessionID, err)
		}
	}
	s.toClient(shimResult{ID: id, SessionID: sessionID})
	s.resume(sessionID, false)
}

// resume forwards the resume commands held back while the session was set up.
func (s *runtimeShim) resume(sessionID string, forget bool) {
	s.mu.Lock()
	var held [][]byte
	if sess := s.sessions[sessionID]; sess != nil {
		held, sess.held, sess.enabling = sess.held, nil, false
		if forget {
			delete(s.sessions, sessionID)
		}
	}
	s.mu.Unlock()
	for _, payload := range held {
		_ = writeFrameToConn(s.b.upstream, &s.b.upstreamMu, 0x1, payload, true, true)
	}
}

func (s *runtimeShim) enableFrames(sessionID string) error {
	raw, err := s.call(sessionID, "Page.getFrameTree", nil)
	if err != nil {
		return err
	}
	if _, err := s.call(sessionID, "Page.enable", nil); err != nil {
		return err
	}
	var tree struct {
		FrameTree shimFrameTree `json:"frameTree"`
	}
	if err := json.Unmarshal(raw, &tree); err != nil {
		return err
	}
	s.mu.Lock()
	s.session(sessionID).rootFrame = tree.FrameTree.Frame.ID
	s.mu.Unlock()

	var walk func(node shimFrameTree)
	walk = func(node shimFrameTree) {
		s.probeFrame(sessionID, node.Frame.ID, node.Frame.SecurityOrigin)
		for _, child := range node.ChildFrames {
			walk(child)
		}
	}
	walk(tree.FrameTree)
	return nil
}

// enableWorker reports a worker's only context, read from its global object.
func (s *runtimeShim) enableWorker(sessionID string) error {
	raw, err := s.call(sessionID, "Runtime.evaluate", map[string]any{"expression": "self"})
	if err != nil {
		return err
	}
	var evaluated struct {
		Result struct {
			ObjectID string `json:"objectId"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &evaluated); err != nil {
		return err
	}
	contextID, isolate, err := contextIDFromObjectID(evaluated.Result.ObjectID)
	if err != nil {
		return err
	}
	s.release(sessionID, evaluated.Result.ObjectID)
	s.announce(sessionID, contextID, "", "", "", isolate)
	return nil
}

func (s *runtimeShim) createWorld(sessionID, frameID, name string) (int, error) {
	raw, err := s.call(sessionID, "Page.createIsolatedWorld", map[string]any{
		"frameId": frameID, "worldName": name, "grantUniveralAccess": true,
	})
	if err != nil {
		return 0, err
	}
	var world struct {
		ExecutionContextID int `json:"executionContextId"`
	}
	if err := json.Unmarshal(raw, &world); err != nil {
		return 0, err
	}
	return world.ExecutionContextID, nil
}

// probeFrame reports the main world and every client-registered world of one frame.
func (s *runtimeShim) probeFrame(sessionID, frameID, origin string) {
	s.mu.Lock()
	sess := s.sessions[sessionID]
	if sess == nil || !sess.enabled {
		s.mu.Unlock()
		return
	}
	worlds := append([]string(nil), sess.worlds...)
	s.mu.Unlock()

	probeName := shimProbeWorld
	if len(worlds) > 0 {
		probeName = worlds[0]
	}
	probe, err := s.createWorld(sessionID, frameID, probeName)
	if err != nil {
		shimLog("probe frame=%.8s world failed: %v", frameID, err)
		return
	}
	mainID, isolate, err := s.mainWorld(sessionID, probe)
	if err == nil {
		s.announce(sessionID, mainID, frameID, origin, "", isolate)
	} else {
		shimLog("probe frame=%.8s main world failed: %v", frameID, err)
	}
	for i, name := range worlds {
		id := probe
		if i > 0 {
			if id, err = s.createWorld(sessionID, frameID, name); err != nil {
				continue
			}
		}
		s.announce(sessionID, id, frameID, origin, name, isolate)
	}
}

// mainWorld finds a frame's main-world context id, and the isolate both worlds
// belong to, from one of the frame's isolated worlds.
func (s *runtimeShim) mainWorld(sessionID string, isolated int) (int, string, error) {
	raw, err := s.call(sessionID, "Runtime.evaluate", map[string]any{"expression": "document", "contextId": isolated})
	if err != nil {
		return 0, "", err
	}
	var evaluated struct {
		Result struct {
			ObjectID string `json:"objectId"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &evaluated); err != nil || evaluated.Result.ObjectID == "" {
		return 0, "", errors.New("document unavailable")
	}
	defer s.release(sessionID, evaluated.Result.ObjectID)
	raw, err = s.call(sessionID, "DOM.describeNode", map[string]any{"objectId": evaluated.Result.ObjectID})
	if err != nil {
		return 0, "", err
	}
	var described struct {
		Node struct {
			BackendNodeID int `json:"backendNodeId"`
		} `json:"node"`
	}
	if err := json.Unmarshal(raw, &described); err != nil {
		return 0, "", err
	}
	// Without a context id the node resolves in its frame's main world.
	raw, err = s.call(sessionID, "DOM.resolveNode", map[string]any{"backendNodeId": described.Node.BackendNodeID})
	if err != nil {
		return 0, "", err
	}
	var resolved struct {
		Object struct {
			ObjectID string `json:"objectId"`
		} `json:"object"`
	}
	if err := json.Unmarshal(raw, &resolved); err != nil {
		return 0, "", err
	}
	defer s.release(sessionID, resolved.Object.ObjectID)
	return contextIDFromObjectID(resolved.Object.ObjectID)
}

func (s *runtimeShim) release(sessionID, objectID string) {
	go func() { _, _ = s.call(sessionID, "Runtime.releaseObject", map[string]any{"objectId": objectID}) }()
}

// contextIDFromObjectID reads the context and isolate from "<isolate>.<context>.<object>".
func contextIDFromObjectID(objectID string) (int, string, error) {
	parts := strings.Split(objectID, ".")
	if len(parts) != 3 {
		return 0, "", fmt.Errorf("unexpected object id %q", objectID)
	}
	id, err := strconv.Atoi(parts[1])
	return id, parts[0], err
}

// bind installs one binding in one context, then delivers the calls its
// stand-in collected before the browser replaced it.
func (s *runtimeShim) bind(sessionID string, contextID int, name string) {
	quoted, _ := json.Marshal(name)
	queue := ""
	raw, err := s.call(sessionID, "Runtime.evaluate", map[string]any{
		"contextId":  contextID,
		"expression": fmt.Sprintf("(() => { const stub = globalThis[%s]; return stub && stub.queue && stub.queue.length ? stub.queue : undefined; })()", quoted),
	})
	if err == nil {
		var evaluated struct {
			Result struct {
				ObjectID string `json:"objectId"`
			} `json:"result"`
		}
		if json.Unmarshal(raw, &evaluated) == nil {
			queue = evaluated.Result.ObjectID
		}
	}
	if _, err := s.call(sessionID, "Runtime.addBinding", map[string]any{"name": name, "executionContextId": contextID}); err != nil {
		shimLog("binding %q ctx=%d failed: %v", name, contextID, err)
		return
	}
	if queue == "" {
		return
	}
	if _, err := s.call(sessionID, "Runtime.callFunctionOn", map[string]any{
		"objectId":            queue,
		"functionDeclaration": fmt.Sprintf("function() { for (const payload of this) globalThis[%s](payload); }", quoted),
	}); err != nil {
		shimLog("binding %q ctx=%d queue failed: %v", name, contextID, err)
	}
	s.release(sessionID, queue)
}

// announce reports one context to the client once, then gives it the client's
// bindings. The browser's own unique id is not readable while the
// domain is off, so one is derived from the isolate and context: it stays the
// same for every session that observes the context. It waits for the browser,
// so it must not run on the goroutine that reads browser replies.
func (s *runtimeShim) announce(sessionID string, contextID int, frameID, origin, world, isolate string) {
	s.mu.Lock()
	sess := s.sessions[sessionID]
	if sess == nil || !sess.enabled || sess.announced[contextID] {
		s.mu.Unlock()
		return
	}
	sess.announced[contextID] = true
	uniqueID := fmt.Sprintf("%s.%d", isolate, contextID)
	sess.contexts[frameID] = append(sess.contexts[frameID], shimContext{id: contextID, uniqueID: uniqueID})
	if world == "" && frameID == sess.rootFrame {
		sess.mainContext = contextID
	}
	var bindings []string
	for _, binding := range sess.bindings {
		if binding.world == "" || binding.world == world {
			bindings = append(bindings, binding.name)
		}
	}
	s.mu.Unlock()
	shimLog("announce session=%.8s frame=%.8s ctx=%d world=%q bindings=%d", sessionID, frameID, contextID, world, len(bindings))

	kind := "default"
	if world != "" {
		kind = "isolated"
	}
	s.toClient(shimEvent{
		Method: "Runtime.executionContextCreated",
		Params: map[string]any{"context": map[string]any{
			"id":       contextID,
			"origin":   origin,
			"name":     world,
			"uniqueId": uniqueID,
			"auxData":  map[string]any{"isDefault": world == "", "type": kind, "frameId": frameID},
		}},
		SessionID: sessionID,
	})
	// After the report: a client ignores a binding call from a context it has
	// not been told about, and the queued calls are delivered here.
	for _, name := range bindings {
		s.bind(sessionID, contextID, name)
	}
}
