# [OUT OF SCOPE] Proxy extension page-message bridge requires product policy


**File:** [`popcorn-images/extensions/proxy/content.js`](https://github.com/reclaimprotocol/popcorn/blob/main/popcorn-images/extensions/proxy/content.js#L16-L38) (lines 16, 20, 26, 31, 38)
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


The content script accepts any same-window postMessage whose type starts with PCN_PROXY_ and direction is to-extension, then forwards message.config to chrome.runtime.sendMessage. The extension manifest runs this bridge on <all_urls>, and the background script handles PCN_PROXY_SET/CLEAR/GET by changing chrome.proxy.settings. A malicious site visited in the isolated browser can therefore reconfigure or clear the browser-wide proxy without an origin allowlist or capability check, enabling traffic redirection, denial of service, and interception of plaintext traffic or proxy metadata.

## Recommendation

Restrict the content script and web_accessible_resources to trusted Popcorn origins, validate event.origin against an explicit allowlist before forwarding, and have the background script verify sender.url/origin before honoring proxy-changing messages. Prefer a nonce/capability known only to the trusted controller page if page-level control is required.
