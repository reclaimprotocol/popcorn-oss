# [OUT OF SCOPE] Proxy extension injected API requires product policy


**File:** [`popcorn-images/extensions/proxy/injected.js`](https://github.com/reclaimprotocol/popcorn/blob/main/popcorn-images/extensions/proxy/injected.js#L40-L60) (lines 40, 45, 51, 54, 57, 60)
**Project:** popcorn
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `other-extension-privilege-escalation`


## Triage update

Confirmed concern, but out of scope for the current DeepSec remediation pass.
The correct fix requires a product decision about which origins/pages are
trusted to control the browser proxy, or what per-session capability should be
issued to that controller. A fail-closed origin allowlist was prototyped in
PR #212 / popcorn-images#12 and intentionally closed because it would break
current flows until trusted origins/capability plumbing is defined.

Do not reopen as a quick code-only fix without product input. Revisit when the
proxy-control trust boundary is specified.

## Original finding


The injected script installs window.__pcn with set, clear, and get methods in the page's main world and sends PCN_PROXY_* messages with targetOrigin '*'. Because this script is exposed on all URLs, any page script can call __pcn.set(...) to ask the extension to change the browser proxy. The message bridge has no origin allowlist or unguessable capability, so untrusted web content receives extension-level proxy control.

## Recommendation

Do not inject this API into arbitrary pages. Limit injection to trusted origins and require an unguessable per-session capability in every request and response before proxy changes are accepted.
