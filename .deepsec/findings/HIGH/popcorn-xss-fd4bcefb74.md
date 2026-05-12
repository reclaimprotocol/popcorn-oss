# [HIGH] Markdown emoji rule injects unsanitized user input into a runtime Vue template

**File:** [`popcorn-images/images/chromium-headful/client/src/components/markdown.ts`](https://github.com/reclaimprotocol/popcorn/blob/main/popcorn-images/images/chromium-headful/client/src/components/markdown.ts#L61-L267) (lines 61, 204, 216, 217, 267)
**Project:** popcorn
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `xss`

## Finding

The markdown renderer enables `escapeHTML`, which protects ordinary text, but `htmlTag()` concatenates attribute values without escaping. The custom emoji rule accepts any non-whitespace, non-colon characters as `node.id` and inserts it into `data-emoji` and `v-tooltip.top-center` attributes. The final HTML is then passed into Vue's runtime template compiler. Chat messages are remote-user controlled and rendered through this component, so a crafted emoji token can break out of attributes or inject Vue/template/HTML event handlers, resulting in XSS in other users' browser sessions.

## Recommendation

Escape all attribute values in `htmlTag()` with `md.sanitizeText` or a dedicated HTML attribute encoder, restrict emoji IDs to a strict allowlist such as `/^[a-z0-9_+-]+$/i`, and avoid compiling user-derived HTML as a Vue template. Prefer rendering sanitized HTML with `domProps.innerHTML` only after robust sanitization, or construct VNodes directly.
