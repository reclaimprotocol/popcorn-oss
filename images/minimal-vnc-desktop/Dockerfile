# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
ARG GOLANG_IMAGE=docker.io/golang:1.26@sha256:5f3787b7f902c07c7ec4f3aa91a301a3eda8133aa32661a3b3a3a86ab3a68a36
ARG UBUNTU_IMAGE=docker.io/ubuntu:22.04@sha256:962f6cadeae0ea6284001009daa4cc9a8c37e75d1f5191cf0eb83fe565b63dd7
# Tilion Fortress is the browser engine: a stealth stock-Chromium fork with
# C++ persona patches, distributed as an OCI image. It fully replaces stock
# chromium (the xtradeb chromium debs are not installed); the chromium
# runtime-library closure it links against is supplied by the pinned apt
# packages in locks/apt-packages.txt.
#
# Pinned by digest to the STABLE channel (150). **amd64-only** — Fortress
# publishes no arm64 manifest, so this whole image is amd64-only: build and run
# it on a native amd64 host, since Chromium SIGTRAPs under QEMU emulation.
# To confirm the version in a built image read /json/version over CDP; do NOT
# trust /opt/*/README.txt, whose banner carries a stale generic string.
#
# 150 is built from CURRENT STABLE Chrome, which matters on its own: version-database
# detectors read an older build as out-of-date, and a version that does not publicly
# exist as generic "Chromium". This release also carries the fixes from upstream's
# cycle (tiliondev/fortress#25 and the 150 notes):
#   - per-clone canvas/audio divergence — the noise seed is applied correctly, so two
#     instances no longer share one un-noised fingerprint
#   - explicit --uxr-* flags now WIN over the generated persona (previously --uxr-ua-os /
#     --uxr-ua-platform were overwritten, so a UA override silently stayed Windows and
#     the resulting UA-vs-platform mismatch read as tampering)
#   - the launcher honours the documented TILION_* env names, not only TILLION_*
#   - geo-matched persona: timezone/locale derived from the egress IP, since a timezone
#     disagreeing with the IP reads as VPN
#   - coherent OS voices, and the completed WebGL parameter spoof under software render
ARG FORTRESS_IMAGE=docker.io/tilion/fortress@sha256:b4f331693d3db25d70d814a99ed0da6be433d884e18d5af1cf3e6f3a2969569b

FROM ${GOLANG_IMAGE} AS proxy-builder
WORKDIR /src
ARG TARGETARCH
ARG TARGETOS
ARG SOURCE_DATE_EPOCH=0
COPY proxy/go.mod proxy/go.sum ./
COPY proxy/*.go ./
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
    go build -buildvcs=false -trimpath -ldflags="-s -w -buildid=" -o /out/novnc-proxy .

FROM ${UBUNTU_IMAGE} AS ubuntu-snapshot
ARG UBUNTU_SNAPSHOT=20260624T000000Z
ARG SOURCE_DATE_EPOCH=0
RUN --mount=from=proxy-builder,source=/etc/ssl/certs/ca-certificates.crt,target=/tmp/ca-certificates.crt,ro \
    set -eux; \
    rm -f /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list; \
    mkdir -p /etc/ssl/certs /etc/apt/apt.conf.d; \
    install -m0644 /tmp/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt; \
    printf '%s\n' \
        "deb https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}/ jammy main restricted universe multiverse" \
        "deb https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}/ jammy-updates main restricted universe multiverse" \
        "deb https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}/ jammy-backports main restricted universe multiverse" \
        "deb https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}/ jammy-security main restricted universe multiverse" \
        >/etc/apt/sources.list; \
    printf 'Acquire::Check-Valid-Until "false";\nAcquire::Retries "3";\n' >/etc/apt/apt.conf.d/99snapshot; \
    touch -h -d "@${SOURCE_DATE_EPOCH}" \
        /etc \
        /etc/apt \
        /etc/apt/apt.conf.d \
        /etc/apt/apt.conf.d/99snapshot \
        /etc/apt/sources.list \
        /etc/ssl \
        /etc/ssl/certs \
        /etc/ssl/certs/ca-certificates.crt

FROM ${FORTRESS_IMAGE} AS fortress

FROM ubuntu-snapshot AS runtime
ARG TARGETARCH
ARG TARGETOS
ARG SOURCE_DATE_EPOCH=0
ARG CACHEIDPREFIX=${TARGETOS:-linux}-${TARGETARCH:-amd64}-minimal-vnc
ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY_NUM=1
ENV WIDTH=1920
ENV HEIGHT=1080
ENV DEPTH=24
ENV VNC_PORT=5900
ENV NOVNC_PORT=6080
ENV CDP_INTERNAL_PORT=9223
ENV CHROME_REMOTE_DEBUGGING_PORT=9223
ENV CDP_RESTRICTED_PORT=9222
ENV CDP_FULL_PORT=9226
ENV MVD_EMULATOR_OFF=0
ENV APP_COMMAND=/usr/local/bin/run-chromium-managed
ENV APP_URL=
ENV READY_FILE=/tmp/minimal-vnc-ready
ENV READY_TIMEOUT=30
ENV LOG_DIR=/var/log/app
ENV HOME=/home/kernel
ENV XDG_CONFIG_HOME=/home/kernel/.config
ENV XDG_CACHE_HOME=/home/kernel/.cache

COPY locks/apt-packages.txt /tmp/apt-packages.txt
COPY locks/chromium-artifacts.tsv /tmp/chromium-artifacts.tsv
COPY locks/novnc.lock /tmp/novnc.lock

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked,id=$CACHEIDPREFIX-apt-cache \
    --mount=type=cache,target=/var/lib/apt,sharing=locked,id=$CACHEIDPREFIX-apt-lib \
    --mount=from=minimal-vnc-artifacts,source=/artifacts,target=/mnt/artifacts,ro \
    set -eux; \
    touch_start="$(date -u +'%Y-%m-%d %H:%M:%S')"; \
    rm -f /etc/apt/apt.conf.d/docker-clean; \
    echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' >/etc/apt/apt.conf.d/keep-cache; \
    package_args="$(grep -vE '^[[:space:]]*(#|$)' /tmp/apt-packages.txt | tr '\n' ' ')"; \
    apt-get update; \
    apt-get --no-install-recommends -y install ${package_args}; \
    arch="${TARGETARCH:-amd64}"; \
    case "$arch" in amd64|arm64) ;; *) echo "unsupported target arch: $arch" >&2; exit 1 ;; esac; \
    mkdir -p /tmp/chromium-artifacts; \
    cp -a /mnt/artifacts/debs/. /tmp/chromium-artifacts/; \
    awk -F '\t' -v arch="$arch" 'NF == 5 && $1 == arch { print $2 "\t" $3 "\t" $4 "\t" $5 }' /tmp/chromium-artifacts.tsv | \
    while IFS="$(printf '\t')" read -r name filename url sha256; do \
        echo "verifying ${name} (${filename}) from prepared artifact context"; \
        test -f "/tmp/chromium-artifacts/${filename}"; \
        echo "${sha256}  /tmp/chromium-artifacts/${filename}" | sha256sum -c -; \
    done; \
    apt-get --no-install-recommends -y install /tmp/chromium-artifacts/*.deb; \
    novnc_version="$(awk -F '=' '$1 == "version" { print $2 }' /tmp/novnc.lock)"; \
    novnc_url="$(awk -F '=' '$1 == "url" { print $2 }' /tmp/novnc.lock)"; \
    novnc_sha256="$(awk -F '=' '$1 == "sha256" { print $2 }' /tmp/novnc.lock)"; \
    mkdir -p /tmp/novnc-src /usr/share/novnc; \
    curl --fail --location --retry 5 --retry-all-errors --retry-delay 2 \
         --connect-timeout 15 --speed-limit 4096 --speed-time 20 --max-time 300 \
         --ipv4 --output /tmp/novnc.tar.gz "$novnc_url"; \
    echo "${novnc_sha256}  /tmp/novnc.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/novnc.tar.gz --strip-components=1 -C /tmp/novnc-src; \
    cp -a /tmp/novnc-src/core /tmp/novnc-src/vendor /usr/share/novnc/; \
    cp -a /tmp/novnc-src/LICENSE.txt "/usr/share/novnc/LICENSE.noVNC-${novnc_version}.txt"; \
    apt-get purge -y --auto-remove xz-utils; \
    rm -rf /tmp/chromium-artifacts /tmp/novnc-src /tmp/novnc.tar.gz /tmp/apt-packages.txt /tmp/chromium-artifacts.tsv /tmp/novnc.lock; \
    useradd -m -s /bin/bash kernel; \
    mkdir -p /home/kernel/user-data /home/kernel/.config/openbox /home/kernel/.cache /tmp/.X11-unix /var/log/app; \
    ln -sfn /var/log/app /var/log/minimal-vnc; \
    printf '<openbox_config xmlns="http://openbox.org/3.4/rc"><applications /></openbox_config>\n' >/home/kernel/.config/openbox/rc.xml; \
    chown -R kernel:kernel /home/kernel /var/log/app; \
    chown -h kernel:kernel /var/log/minimal-vnc; \
    chmod 1777 /tmp /tmp/.X11-unix; \
    # Curate the international-script faces we actually need out of Noto into a
    # private dir (renamed to Windows font names downstream in the Fortress
    # layer), then PURGE the bulky Noto packages. Chromium reads only the curated
    # dir via Fortress's fontconfig, so Noto is pure build-time weight. Missing
    # faces are tolerated (|| true) so a snapshot reshuffle can't break the build.
    mkdir -p /usr/local/share/fonts-intl; \
    _n=/usr/share/fonts/truetype/noto; _o=/usr/share/fonts/opentype/noto; \
    for f in Devanagari Bengali Gujarati Gurmukhi Kannada Malayalam Oriya Tamil Telugu \
             Arabic Hebrew Thai Lao Khmer Myanmar Georgian Armenian Ethiopic Mongolian \
             Sinhala Cherokee Syriac Thaana Symbols Symbols2 \
             NKo Vai AdlamUnjoined Osmanya TifinaghAzawagh CanadianAboriginal Yi \
             Ogham Runic Math; do \
      for w in Regular Bold; do cp "$_n/NotoSans${f}-${w}.ttf" /usr/local/share/fonts-intl/ 2>/dev/null || true; done; \
    done; \
    for w in Regular Bold; do cp "$_n/NotoSerifTibetan-${w}.ttf" /usr/local/share/fonts-intl/ 2>/dev/null || true; done; \
    for w in Regular Bold; do cp "$_o/NotoSansCJK-${w}.ttc" /usr/local/share/fonts-intl/ 2>/dev/null || true; done; \
    apt-get purge -y fonts-noto-core fonts-noto-cjk; \
    rm -f /etc/machine-id /var/lib/dbus/machine-id /var/cache/ldconfig/aux-cache /run/systemd/resolve/stub-resolv.conf; \
    rm -rf /var/cache/debconf/* /var/cache/fontconfig/* /var/lib/apt/lists/*; \
    find /usr/local/share/fonts /usr/share/fonts -name '.uuid' -delete 2>/dev/null || true; \
    find /var/log -mindepth 1 ! -path /var/log/app ! -path /var/log/app/\* ! -path /var/log/minimal-vnc -delete; \
    find /etc /home /run /tmp /usr /var -xdev \
        \( -path /etc/hosts -o -path /etc/hostname -o -path /etc/resolv.conf -o -path /var/cache/apt -o -path /var/cache/apt/\* -o -path /var/lib/apt -o -path /var/lib/apt/\* \) -prune -o \
        -newerct "$touch_start" \
        -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +

# Tillion Fortress (stable stealth Chromium 150) — the only browser in the image.
# /opt/tilion/tilion is a bash launcher that applies a Windows persona + bundled
# fonts + its own SwiftShader ICD around /opt/tilion/chrome (the patched Chromium
# whose C++-level patches produce a real-Chrome TLS/JS fingerprint). The shared
# libs it links against come from the chromium runtime-lib block in
# locks/apt-packages.txt. `chromium`/`chromium-browser` are symlinked to the
# launcher so anything invoking `chromium` gets the persona-wrapped browser.
# Own layer so the ~326MB copy caches independently.
# Copy /opt wholesale rather than a fixed subdirectory: the 151 image renamed
# /opt/tilion/tilion to /opt/tillion/tillion (double L). Normalising to a stable
# /opt/tilion/tilion below means the rest of the image — the symlinks, start-chromium's
# CHROME_BIN, the fonts template patch — is unaffected by upstream renaming, and the
# build fails loudly rather than silently launching nothing if the layout changes again.
COPY --from=fortress /opt /opt
RUN set -eux; \
    touch_start="$(date -u +'%Y-%m-%d %H:%M:%S')"; \
    if [ -d /opt/tillion ] && [ ! -e /opt/tilion ]; then ln -s tillion /opt/tilion; fi; \
    if [ -x /opt/tilion/tillion ] && [ ! -e /opt/tilion/tilion ]; then ln -s tillion /opt/tilion/tilion; fi; \
    test -x /opt/tilion/tilion; test -x /opt/tilion/chrome; \
    ln -sf /opt/tilion/tilion /usr/bin/chromium; \
    ln -sf /opt/tilion/tilion /usr/bin/chromium-browser; \
    # Fortress points Chromium at a fontconfig (fonts.conf.template) listing ONLY
    # its ~11 Latin Windows fonts, so every non-Latin script renders as tofu. Add
    # the curated /usr/local/share/fonts-intl dir (built in the runtime layer) and
    # scan-rename each Noto face to the font a REAL Windows box uses for that
    # script (Nirmala UI for all Indic+Sinhala, Segoe UI for Arabic/Hebrew,
    # Microsoft YaHei/JhengHei/Yu Gothic/Malgun for CJK, Leelawadee UI, Sylfaen,
    # Ebrima, …). Net: everything renders AND the enumerable font list is a
    # coherent inbox-Windows set — zero Linux family names (Noto/DejaVu/Lohit)
    # leak into the fingerprint. Patch the TEMPLATE (the launcher regenerates the
    # live conf from it each boot). Idempotent.
    tmpl=/opt/tilion/fonts/fonts.conf.template; \
    if [ -f "$tmpl" ] && ! grep -q 'fonts-intl' "$tmpl"; then \
      sed -i 's#\(<dir>@FONTDIR@</dir>\)#\1\n  <dir>/usr/local/share/fonts-intl</dir>#' "$tmpl"; \
      sed -i 's#</fontconfig>##' "$tmpl"; \
      add() { printf '  <match target="scan"><test name="family"><string>%s</string></test><edit name="family" mode="assign"><string>%s</string></edit></match>\n' "$1" "$2" >> "$tmpl"; }; \
      for s in Devanagari Bengali Gujarati Gurmukhi Kannada Malayalam Oriya Tamil Telugu Sinhala; do add "Noto Sans $s" "Nirmala UI"; done; \
      add "Noto Sans Arabic" "Segoe UI"; add "Noto Sans Hebrew" "Segoe UI"; \
      for s in Thai Lao Khmer; do add "Noto Sans $s" "Leelawadee UI"; done; \
      add "Noto Sans Myanmar" "Myanmar Text"; \
      add "Noto Sans Georgian" "Sylfaen"; add "Noto Sans Armenian" "Sylfaen"; \
      add "Noto Sans Ethiopic" "Nyala"; \
      add "Noto Serif Tibetan" "Microsoft Himalaya"; \
      add "Noto Sans Mongolian" "Mongolian Baiti"; \
      add "Noto Sans Cherokee" "Gadugi"; add "Noto Sans Canadian Aboriginal" "Gadugi"; add "Noto Sans CanAborig" "Gadugi"; \
      add "Noto Sans Syriac" "Estrangelo Edessa"; \
      add "Noto Sans Thaana" "MV Boli"; \
      add "Noto Sans NKo" "Ebrima"; add "Noto Sans Vai" "Ebrima"; add "Noto Sans Adlam Unjoined" "Ebrima"; add "Noto Sans Osmanya" "Ebrima"; add "Noto Sans Tifinagh Azawagh" "Ebrima"; \
      add "Noto Sans Yi" "Microsoft Yi Baiti"; \
      add "Noto Sans Ogham" "Segoe UI Historic"; add "Noto Sans Runic" "Segoe UI Historic"; \
      add "Noto Sans Math" "Cambria Math"; \
      add "Noto Sans Symbols" "Segoe UI Symbol"; add "Noto Sans Symbols2" "Segoe UI Symbol"; \
      add "Noto Sans CJK SC" "Microsoft YaHei"; \
      add "Noto Sans CJK TC" "Microsoft JhengHei"; add "Noto Sans CJK HK" "Microsoft JhengHei"; \
      add "Noto Sans CJK JP" "Yu Gothic UI"; \
      add "Noto Sans CJK KR" "Malgun Gothic"; \
      add "Noto Sans Mono CJK SC" "SimSun"; \
      add "Noto Sans Mono CJK TC" "MingLiU"; add "Noto Sans Mono CJK HK" "MingLiU"; \
      add "Noto Sans Mono CJK JP" "MS Gothic"; \
      add "Noto Sans Mono CJK KR" "Gulim"; \
      # The four CJK faces share every Han glyph, so a bare charset match can't
      # tell them apart. Match on page lang (as real Windows/Chrome do) so Han
      # renders with the region-correct Windows font: zh->YaHei, zh-TW/HK->JhengHei,
      # ja->Yu Gothic, ko->Malgun. Later prepends win, so region rules follow "zh".
      pref() { printf '  <match target="pattern"><test name="lang" compare="contains"><string>%s</string></test><edit name="family" mode="prepend" binding="strong"><string>%s</string></edit></match>\n' "$1" "$2" >> "$tmpl"; }; \
      pref "zh" "Microsoft YaHei"; \
      pref "ja" "Yu Gothic UI"; \
      pref "ko" "Malgun Gothic"; \
      pref "zh-tw" "Microsoft JhengHei"; \
      pref "zh-hk" "Microsoft JhengHei"; \
      pref "zh-mo" "Microsoft JhengHei"; \
      printf '</fontconfig>\n' >> "$tmpl"; \
    fi; \
    find /opt /usr/bin /usr/local/share/fonts-intl -xdev -newerct "$touch_start" \
        -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +

COPY --from=proxy-builder /out/novnc-proxy /usr/local/bin/novnc-proxy
COPY --chmod=0755 entrypoint.sh /usr/local/bin/minimal-vnc-entrypoint
COPY --chmod=0755 start-chromium /usr/local/bin/start-chromium
COPY --chmod=0755 run-chromium-managed /usr/local/bin/run-chromium-managed
COPY liveview.html /usr/share/novnc/liveview.html
COPY kbd-autofocus.js /usr/share/novnc/kbd-autofocus.js
COPY kbd /usr/share/novnc/kbd
COPY viewer.js /usr/share/novnc/viewer.js
COPY --from=trusted-liveview bootstrap.js noise.js /usr/share/novnc/e2e/
COPY locks/esbuild.lock /tmp/esbuild.lock
COPY locks/noble.lock /tmp/noble.lock

# Bundle the viewer (noVNC core/* + the kbd/* IME layer + viewer.js) and inline it
# into liveview.html as one <script type="module">. The point is removing the SECOND
# REQUEST: in ~4% of sessions the document arrives fine and the separate bundle
# request then hangs indefinitely with no status and no error event, so onerror
# never fires and only a watchdog notices. Inlined, there is nothing left to hang.
# Stays --format=esm because noVNC's core/util/browser.js uses top-level await,
# which the iife format cannot express (it fails the build outright).
# esbuild is a standalone Go binary — no Node — pinned by sha256 exactly like noVNC.
# Full --minify (mangles identifiers too). Measured on the real v1.6.0 bundle:
#   whitespace+syntax  392.9K raw  108.1K gz  91.0K br
#   --minify           294.8K raw   94.6K gz  79.7K br   ← -12.4% brotli
# This used to stop at --minify-whitespace/--minify-syntax to keep the BUILD_TAG
# string greppable, but mangling renames identifiers and leaves string LITERALS
# alone: 'bundle-80' still appears verbatim in the output and still logs correctly.
# The real cost is function names in stack traces, which inlining already reduced
# to liveview.html:<line>. Reverting is one word if a stack trace ever needs them.
# esbuild's output is deterministic (no embedded timestamps), preserving reproducibility.
RUN set -eux; \
    mkdir -p /usr/share/novnc/node_modules/@noble; \
    while IFS="$(printf '\t')" read -r noble_name noble_version noble_url noble_sha256; do \
      case "$noble_name" in \#*|'') continue ;; esac; \
      noble_archive="/tmp/noble-${noble_name}.tgz"; \
      curl --fail --location --retry 5 --retry-all-errors --retry-delay 2 \
           --connect-timeout 15 --speed-limit 4096 --speed-time 20 --max-time 300 \
           --ipv4 --output "$noble_archive" "$noble_url"; \
      echo "${noble_sha256}  ${noble_archive}" | sha256sum -c -; \
      mkdir -p "/usr/share/novnc/node_modules/@noble/${noble_name}"; \
      tar -xzf "$noble_archive" --strip-components=1 \
          -C "/usr/share/novnc/node_modules/@noble/${noble_name}"; \
    done < /tmp/noble.lock; \
    esb_url="$(awk -F '=' '$1 == "url" { print $2 }' /tmp/esbuild.lock)"; \
    esb_sha256="$(awk -F '=' '$1 == "sha256" { print $2 }' /tmp/esbuild.lock)"; \
    curl --fail --location --retry 5 --retry-all-errors --retry-delay 2 \
         --connect-timeout 15 --speed-limit 4096 --speed-time 20 --max-time 300 \
         --ipv4 --output /tmp/esbuild.tgz "$esb_url"; \
    echo "${esb_sha256}  /tmp/esbuild.tgz" | sha256sum -c -; \
    mkdir -p /tmp/esbuild-src; \
    tar -xzf /tmp/esbuild.tgz --strip-components=1 -C /tmp/esbuild-src package/bin/esbuild; \
    /tmp/esbuild-src/bin/esbuild /usr/share/novnc/viewer.js --bundle --format=esm \
        --minify \
        --outfile=/tmp/viewer.inline.js; \
    rm -rf /tmp/esbuild.tgz /tmp/esbuild-src /tmp/esbuild.lock /tmp/noble-*.tgz /tmp/noble.lock; \
    # Escape a literal closing script tag before inserting generated JavaScript.
    sed 's#</[sS][cC][rR][iI][pP][tT]#<\\/script#g' /tmp/viewer.inline.js > /tmp/viewer.inline.safe.js; \
    awk -v bundle=/tmp/viewer.inline.safe.js '/<!-- VIEWER_BUNDLE -->/ { print "  <script type=\"module\">"; while ((getline line < bundle) > 0) print line; close(bundle); print "  </script>"; next } { print; }' /usr/share/novnc/liveview.html > /tmp/liveview.html; \
    mv /tmp/liveview.html /usr/share/novnc/liveview.html; \
    # The no-store document is large after inlining; keep a deterministic gzip
    # sibling so clients that accept gzip transfer the compressed representation.
    gzip -9 -n -k -f /usr/share/novnc/liveview.html; \
    brotli -q 11 -k -f /usr/share/novnc/liveview.html; \
    ls -l /usr/share/novnc/liveview.html /usr/share/novnc/liveview.html.gz /usr/share/novnc/liveview.html.br; \
    rm -f /tmp/viewer.inline.js /tmp/viewer.inline.safe.js

COPY third-party/fortress /usr/share/doc/popcorn/third-party/fortress
COPY --chown=kernel:kernel extensions/proxy /home/kernel/extensions/proxy
COPY --chown=kernel:kernel policies/managed/policy.json /etc/chromium/policies/managed/policy.json
COPY --chown=kernel:kernel policies/variants/policy.reclaim-portal.json /etc/chromium/policy-variants/policy.reclaim-portal.json

RUN set -eux; \
    chown -R kernel:kernel /etc/chromium/policies /etc/chromium/policy-variants; \
    touch -h -d "@${SOURCE_DATE_EPOCH}" \
        /usr/local/bin/novnc-proxy \
        /usr/local/bin/minimal-vnc-entrypoint \
        /usr/local/bin/start-chromium \
        /usr/local/bin/run-chromium-managed \
        /usr/share/novnc/liveview.html \
        /usr/share/novnc/liveview.html.gz \
        /usr/share/novnc/liveview.html.br \
        /usr/share/novnc/kbd-autofocus.js \
        /usr/share/novnc/viewer.js; \
    find /usr/share/novnc/kbd /home/kernel/extensions /etc/chromium/policies /etc/chromium/policy-variants /usr/share/doc/popcorn -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +

USER kernel
EXPOSE 6080 9222 9226
ENTRYPOINT ["/usr/local/bin/minimal-vnc-entrypoint"]
