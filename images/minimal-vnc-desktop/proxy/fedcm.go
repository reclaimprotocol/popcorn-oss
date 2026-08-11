package main

import (
	"encoding/json"
	"sync"
)

// FedCM account chooser interception.
//
// FedCM's chooser is BROWSER UI (like a JS dialog, like the GTK <select> popup),
// laid out against the real window rather than the emulated viewport. Measured on
// a Pixel 7 profile (412x915): the sheet overflows and the Continue button is
// clipped off the right edge. Since Continue is the only way to complete the flow,
// Google sign-in is simply impossible at mobile width — worse than the alert case,
// where you could at least dismiss.
//
// There is no customization route: FedCM branding belongs to the IdP (Google), not
// to us as the relying party, so nothing can be restyled, resized or repositioned.
// Interception is the only option.
//
// What this is NOT: a reimplementation of the consent surface. Our sheet is a
// REMOTE CONTROL for Chrome's real dialog — the token exchange, origin checks and
// consent bookkeeping all still happen inside Chrome's own FedCM machinery, and we
// only relay which account the user picked. That is what makes re-rendering a
// security surface acceptable rather than a forgery.
//
// COOLDOWN. Dismissing a FedCM prompt makes Chrome suppress FedCM for that site on
// an exponential backoff — hours, growing to weeks. Two consequences:
//
//  1. A dismiss is sent ONLY on an explicit user cancel, never as an error path or
//     cleanup, or a bug in our sheet would lock the user out of Google sign-in on a
//     site long after the bug was fixed.
//  2. Even that cancel passes triggerCooldown:false. The default is TRUE, and it
//     cost a real testing session: one tap on Cancel made the chooser
//     un-invokable and looked like the feature had broken. Chrome's cooldown exists
//     to stop SITES nagging users with One Tap prompts; here the user is dismissing
//     OUR re-rendered sheet, usually to retry, and they have no way to discover that
//     recovery means digging through browser settings. FedCm.resetCooldown() is the
//     escape hatch if a session is already suppressed.
type fedcmState struct {
	mu       sync.Mutex
	session  string // CDP session whose dialog is open ("" when none)
	dialogID string // FedCM's own dialog id, required by selectAccount
	seq      uint64 // our identifier, so a stale reply can't answer a newer dialog
	accounts int    // account count, to bound the index a viewer may send
	onDialog func(payload []byte, open bool)
}

func (f *fedcmState) setSink(fn func(payload []byte, open bool)) {
	f.mu.Lock()
	f.onDialog = fn
	f.mu.Unlock()
}

func (f *fedcmState) sink() func([]byte, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.onDialog
}

func (f *fedcmState) note(sessionID, dialogID string, accounts int) uint64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.seq++
	f.session = sessionID
	f.dialogID = dialogID
	f.accounts = accounts
	return f.seq
}

// forget clears state without touching the dialog. Used when the target goes away
// or Chrome reports the dialog closed — deliberately NOT a dismiss.
func (f *fedcmState) forget(sessionID string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.session == "" || (sessionID != "" && f.session != sessionID) {
		return false
	}
	f.session, f.dialogID, f.accounts = "", "", 0
	return true
}

// fedcmAccount is the SUBSET of Chrome's account payload we publish. Deliberately
// no pictureUrl: rendering it would make the viewer fetch from
// lh3.googleusercontent.com, which leaks the viewer's IP to Google and may be
// CSP-blocked. Name and email are enough to identify an account, and they are
// exactly what the user is about to share with the site anyway.
type fedcmAccount struct {
	AccountID string `json:"accountId"`
	Name      string `json:"name"`
	Email     string `json:"email"`
}

// dialogPayload builds the viewer message for a shown chooser. The disclosure text
// and its two links are carried through because for a first-time account
// (loginState "SignUp") this dialog is a CONSENT moment — dropping the terms and
// privacy links would quietly downgrade it to a styled button.
func fedcmDialogPayload(seq uint64, title, dialogType, loginState string, accounts []fedcmAccount, tos, privacy string) ([]byte, error) {
	return json.Marshal(map[string]any{
		"dialog": map[string]any{
			"open": true, "seq": seq, "type": "fedcm",
			"fedcmType": dialogType, "title": title, "loginState": loginState,
			"accounts": accounts, "termsOfServiceUrl": tos, "privacyPolicyUrl": privacy,
			// Routed back in the reply: the JS-dialog paths keep their own sequence
			// counters, so a flag (not seq) says which mechanism to resolve.
			"fedcm": true,
		},
	})
}

// answer applies the user's choice. accept+index selects; !accept dismisses, which
// is a REAL user cancellation and the only case where the cooldown is acceptable.
// An out-of-range index is dropped rather than clamped — picking a different
// account than the user tapped would be worse than doing nothing.
func (e *emulator) answerFedcm(seq uint64, accept bool, accountIndex int) bool {
	e.fedcm.mu.Lock()
	if e.fedcm.session == "" || seq != e.fedcm.seq {
		e.fedcm.mu.Unlock()
		return false
	}
	if accept && (accountIndex < 0 || accountIndex >= e.fedcm.accounts) {
		e.fedcm.mu.Unlock()
		return false
	}
	sid, did := e.fedcm.session, e.fedcm.dialogID
	e.fedcm.mu.Unlock()

	// State is held until the command is actually queued. Dropping it first meant a
	// saturated CDP queue could swallow the selection while the viewer's sheet was
	// already gone, leaving Chrome's own chooser on screen with nothing able to
	// answer it. FedCm.dialogClosed clears the state for real.
	cmd := cdpCmd{
		method:  "FedCm.selectAccount",
		params:  map[string]any{"dialogId": did, "accountIndex": accountIndex},
		session: sid,
	}
	if !accept {
		cmd = cdpCmd{
			method: "FedCm.dismissDialog",
			// triggerCooldown:false — see the note above. Cancelling our sheet must not
			// suppress FedCM for the site.
			params:  map[string]any{"dialogId": did, "triggerCooldown": false},
			session: sid,
		}
	}
	return e.enqueuePriority(cmd, dialogEnqueueWait)
}
