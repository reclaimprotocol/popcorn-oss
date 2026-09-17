# Android emulator session runtime for Popcorn.
#
# The image is x86_64 on purpose. GCE offers nested virtualization on Intel
# hosts only, so an arm64 guest on Arm nodes has no KVM and falls back to
# software CPU emulation. That also means every app a provider pins must have
# an x86 build - see the README.
#
# The AVD is created at build time and its system image baked in, so a pod
# boots a device rather than downloading one.

# ---------------------------------------------------------------- runtime js
FROM node:24-bookworm-slim AS runtime-build
WORKDIR /build
COPY package.json package-lock.json* tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY web ./web
RUN npm run build && npm prune --omit=dev

# ------------------------------------------------------------------- android
FROM debian:bookworm-slim

ARG ANDROID_API=34
ARG ANDROID_TAG=google_apis
ARG ANDROID_ABI=x86_64
ARG CMDLINE_TOOLS_VERSION=13114758
ARG AVD_NAME=popcorn
ARG AVD_DEVICE=pixel_6
ARG NODE_MAJOR=24

ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    ANDROID_AVD_HOME=/opt/android-avd \
    ANDROID_AVD_NAME=${AVD_NAME} \
    PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/emulator:/usr/local/bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip openjdk-17-jre-headless \
      libpulse0 libnss3 libxcomposite1 libxcursor1 libxi6 libxtst6 \
      libasound2 libdrm2 libgbm1 libxdamage1 libxrandr2 libglu1-mesa \
      procps \
  && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# SDK, emulator and the system image the AVD is built from.
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools ${ANDROID_AVD_HOME} \
  && curl -fsSL -o /tmp/tools.zip \
     "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip" \
  && unzip -q /tmp/tools.zip -d ${ANDROID_HOME}/cmdline-tools \
  && mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
  && rm /tmp/tools.zip \
  && yes | sdkmanager --licenses > /dev/null \
  && sdkmanager --install \
       "platform-tools" \
       "emulator" \
       "system-images;android-${ANDROID_API};${ANDROID_TAG};${ANDROID_ABI}" > /dev/null \
  && echo no | avdmanager create avd \
       --name "${AVD_NAME}" \
       --device "${AVD_DEVICE}" \
       --package "system-images;android-${ANDROID_API};${ANDROID_TAG};${ANDROID_ABI}" \
  && rm -rf ${ANDROID_HOME}/.temp

# Apps a provider pins must be present before the session starts, because the
# pod installs nothing at runtime. Drop APKs into apks/ to have them baked in.
COPY apks/ /opt/apks/
RUN if ls /opt/apks/*.apk >/dev/null 2>&1; then \
      echo "APKs staged for first-boot install: $(ls /opt/apks)"; \
    fi

WORKDIR /app
COPY --from=runtime-build /build/node_modules ./node_modules
COPY --from=runtime-build /build/dist ./dist
COPY --from=runtime-build /build/web ./web
COPY --from=runtime-build /build/package.json ./package.json
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# 6080 is the live view Popcorn's gateway expects; 3000 is the automation API
# published through a session extension.
EXPOSE 6080 3000

ENV ANDROID_SERIAL=emulator-5554 \
    ANDROID_GPU_MODE=swiftshader_indirect \
    LIVEVIEW_PORT=6080 \
    AUTOMATION_PORT=3000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
