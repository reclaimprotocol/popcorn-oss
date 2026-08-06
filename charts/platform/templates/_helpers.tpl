{{- define "popcorn-platform.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "popcorn-platform.fullname" -}}
{{- printf "%s" (include "popcorn-platform.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "popcorn-platform.controlPlaneDatabaseSsl" -}}
{{- $controlPlane := .Values.controlPlane -}}
{{- if kindIs "bool" $controlPlane.databaseSsl -}}
{{- ternary "true" "false" $controlPlane.databaseSsl -}}
{{- else -}}
{{- $controlPlane.databaseSsl -}}
{{- end -}}
{{- end -}}

{{- define "popcorn-platform.podScheduling" -}}
{{- $root := .root -}}
{{- with $root.Values.imagePullSecrets }}
imagePullSecrets:
{{ toYaml . | nindent 2 }}
{{- end }}
{{- with $root.Values.nodeSelector }}
nodeSelector:
{{ toYaml . | nindent 2 }}
{{- end }}
{{- with $root.Values.tolerations }}
tolerations:
{{ toYaml . | nindent 2 }}
{{- end }}
{{- with $root.Values.affinity }}
affinity:
{{ toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{- define "popcorn-platform.otelHeaderEnvName" -}}
{{- printf "POPCORN_OTEL_EXPORTER_HEADER_%s" (regexReplaceAll "[^A-Za-z0-9]" (upper .) "_") -}}
{{- end -}}

{{- define "popcorn-platform.validateOtelHeaders" -}}
{{- $headers := .Values.otel.exporter.headers | default dict -}}
{{- $secretName := default "" .Values.otel.exporter.headersSecretName -}}
{{- if and (gt (len $headers) 0) (eq $secretName "") -}}
{{- fail "otel.exporter.headers maps OTLP header names to Secret keys; set otel.exporter.headersSecretName so header values are not rendered into ConfigMaps or Pod specs" -}}
{{- end -}}
{{- range $headerName, $secretKey := $headers -}}
{{- if not (regexMatch "^[A-Za-z0-9._-]+$" (toString $secretKey)) -}}
{{- fail (printf "otel.exporter.headers[%s] must be a Kubernetes Secret key name, not a literal header value" $headerName) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "popcorn-platform.otelHeaderSecretEnvVars" -}}
{{- $secretName := .Values.otel.exporter.headersSecretName -}}
{{- range $headerName, $secretKey := .Values.otel.exporter.headers }}
- name: {{ include "popcorn-platform.otelHeaderEnvName" $headerName }}
  valueFrom:
    secretKeyRef:
      name: {{ $secretName | quote }}
      key: {{ $secretKey | quote }}
{{- end -}}
{{- end -}}

{{- define "popcorn-platform.otelHeadersEnvValue" -}}
{{- $headers := list -}}
{{- range $headerName, $_ := .Values.otel.exporter.headers -}}
{{- $headers = append $headers (printf "%s=$(%s)" ($headerName | urlquery) (include "popcorn-platform.otelHeaderEnvName" $headerName)) -}}
{{- end -}}
{{- join "," $headers -}}
{{- end -}}
