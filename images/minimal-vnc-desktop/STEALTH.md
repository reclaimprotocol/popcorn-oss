# Stealth — Tilion Fortress in minimal-vnc-desktop

This image runs **Tilion Fortress** (`tilion/fortress`, a stealth stock-Chromium
149 fork with C++ persona patches) as the **sole browser**, so it presents as a
regular **Windows Chrome** session to bot classifiers (Akamai BMP, Cloudflare
Bot Management, reCAPTCHA v3/Enterprise, DataDome) rather than
headless-Chrome-on-Linux. Real users drive it over VNC, so the behavioral layer
(mouse/keyboard timing) is genuinely human.

Build/engine specifics — pinned digest, the `--uxr-*` persona, amd64-only, the
GPU-coherence caveat — live in **`FORTRESS-INTEGRATION.md`**. This doc is the
threat-model + verification view: what the persona claims, how fonts are made
coherent, and the current probe scoreboard.

## The persona (what Fortress claims)

The `/opt/tilion/tilion` launcher wraps `/opt/tilion/chrome` with a default
Windows persona via `--uxr-*` flags:

- **OS/UA**: `--uxr-platform=Win32`, `--uxr-ua-platform=Windows`,
  `--uxr-ua-os="Windows NT 10.0; Win64; x64"` — UA, `navigator.platform`,
  `userAgentData`, and Sec-CH-UA-Platform all say Windows. It **strips**
  `--user-agent` (preserves Client Hints) and `--enable-automation`.
- **Hardware**: `--uxr-hw-concurrency=16`, `--uxr-device-memory=8`,
  `--uxr-screen-{width,height}=1920/1080`.
- **WebRTC**: `--uxr-webrtc-policy=disable_non_proxied_udp` (no local-IP leak).
- **Anti-tracking noise**: per-session Canvas / AudioContext / DOMRect jitter so
  those fingerprints aren't a stable cross-site ID. This is what CreepJS reports
  as "lies" (see scoreboard) — a *privacy* signature shared with Brave/Firefox
  RFP, **not** an identity contradiction.
- **Timezone/locale**: `TILION_TZ` (also sets process `TZ`, coherent from the
  first tick) and `TILION_LANG`, wired from `CLOAK_TIMEZONE`/`CLOAK_LOCALE` in
  `start-chromium`. Align these with the egress IP the site sees (see
  multi-region note below).

## Font coherence (Windows-only enumerable set)

A real Windows box exposes a specific set of font families; a "Windows" browser
that enumerates DejaVu / Liberation / Noto / Lohit / WenQuanYi is an instant
Linux tell. Fortress bundles only ~11 Latin Windows faces, so out of the box
non-Latin scripts rendered as **tofu** *and* filling that gap naïvely (adding
`/usr/share/fonts`) leaked Linux family names into the JS font fingerprint.

The image resolves both at build time (see the Dockerfile font blocks):

1. **Curate, don't expose.** The needed Noto script faces are copied into a
   private `/usr/local/share/fonts-intl`, and the bulky `fonts-noto-*` source
   packages are then **purged**. Chromium (via Fortress's `FONTCONFIG_FILE`)
   only ever sees Fortress's dir + this curated dir — never `/usr/share/fonts`.
2. **Rename to the real Windows font.** Each Noto face is `scan`-renamed in
   fontconfig to the font a real Windows machine uses for that script:

   | Script(s) | Enumerated as |
   |---|---|
   | Devanagari, Bengali, Gujarati, Gurmukhi, Kannada, Malayalam, Oriya, Tamil, Telugu, Sinhala | **Nirmala UI** |
   | Arabic, Hebrew | **Segoe UI** (Fortress's Arial/Segoe/Tahoma already carry real Arabic/Hebrew glyphs) |
   | Thai, Lao, Khmer | **Leelawadee UI** |
   | Myanmar | **Myanmar Text** |
   | Georgian, Armenian | **Sylfaen** |
   | Ethiopic | **Nyala** |
   | Tibetan | **Microsoft Himalaya** |
   | Mongolian | **Mongolian Baiti** |
   | Cherokee, Canadian Aboriginal | **Gadugi** |
   | Syriac | **Estrangelo Edessa** |
   | Thaana | **MV Boli** |
   | N'Ko, Vai, Adlam, Osmanya, Tifinagh | **Ebrima** |
   | Yi | **Microsoft Yi Baiti** |
   | Ogham, Runic | **Segoe UI Historic** |
   | Math alphanumerics | **Cambria Math** |
   | Symbols, dingbats, braille | **Segoe UI Symbol** |
   | CJK (by page lang) | zh→**Microsoft YaHei**, zh-TW/HK→**Microsoft JhengHei**, ja→**Yu Gothic UI**, ko→**Malgun Gothic** |
   | Emoji | **Segoe UI Emoji** (Fortress bundle, colour CBDT/CBLC) |

   The four Noto CJK faces share every Han glyph, so `lang`-preference rules pick
   the region-correct font per page language.

Result: every web-relevant script **renders**, the enumerable font list is a
coherent ~34-family inbox-Windows set, and **zero** Linux family names leak.
Emoji is covered by Fortress's own colour font, so `fonts-noto-color-emoji` and
25 other packs were dropped (image −430 MB, from 2.24 GB → 1.81 GB).

## Probe scoreboard (verified 2026-07-10, `fonttest` build)

Run over the full CDP proxy against the live image; **desktop** and the
**mobile-touch** profile (narrow viewport + touch, `mobile:false` — the coherent
Windows touch device used with magnify):

| Probe | Desktop | Mobile-touch | Notes |
|---|---|---|---|
| fingerprint | ✅ PASS | ✅ PASS | Win32, `webdriver=false`, no `cdc_`/automation globals, plugins present; mobile shows `maxTouch=5, ontouchstart, pointer:coarse, inner=390×780` |
| bot.sannysoft.com | ✅ PASS | ✅ PASS | no failed rows |
| CreepJS | ℹ️ 6 lies | ℹ️ 6 lies | all Canvas/Audio/DOMRect anti-tracking noise — **no identity lies**; identical with/without mobile |
| reCAPTCHA v3 (antcpt) | ✅ 0.9 | ✅ 0.9 | |
| Cloudflare (nowsecure.nl) | ✅ PASS | ✅ PASS | no challenge |

The font overhaul is **stealth-neutral** — scores are identical to the
pre-font-work baseline. reCAPTCHA/Cloudflare weight **egress IP reputation**
heavily; a low score there reflects the IP (attach a clean sticky
residential/mobile proxy), not the fingerprint.

## Running the probes

```bash
cd scripts
./stealth-test.sh --run            # start a container, run all probes (desktop)
./stealth-test.sh --run --mobile   # coherent mobile-touch profile
CDP_HOST=127.0.0.1:9226 python3 stealth_probe.py fingerprint recaptcha
```

Needs `python3` + `websockets` and the **full** CDP proxy (9226); the restricted
proxy (9222) filters the Runtime/Page commands the probes need. See
`stealth-tests/` for the heavier Node/Playwright suite.

## Caveats

- **IP reputation dominates.** Empirically (see `FORTRESS-INTEGRATION.md`), the
  browser is not what blocks Netflix/Taj-class reCAPTCHA Enterprise flows — the
  exit IP is. Fortress fixes coherence, not IP.
- **Incoherent GPU persona (stable-149).** The default persona claims an RTX 3060
  (`--uxr-webgl-renderer="ANGLE (NVIDIA … RTX 3060 …, D3D11)"`) while rendering
  through SwiftShader — the hardware-GPU-on-software-renderer tell strict
  detectors (DataDome) cross-check. For strict flows override the GPU `--uxr`
  flags via `CHROMIUM_FLAGS` to match SwiftShader, or launch
  `TILION_NO_DEFAULTS=1` with a hand-built coherent persona.
- **Full CDP (9226) is internal-only.** It is an unauthenticated, fully
  controllable browser — never expose it publicly; never enter real credentials
  on a public tunnel.
- **amd64-only.** Fortress has no arm64 manifest.
