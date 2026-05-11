{{- define "popcorn-platform.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "popcorn-platform.fullname" -}}
{{- printf "%s" (include "popcorn-platform.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "popcorn-platform.analyticsDatabaseSsl" -}}
{{- if kindIs "bool" .Values.analytics.databaseSsl -}}
{{- ternary "true" "false" .Values.analytics.databaseSsl -}}
{{- else -}}
{{- .Values.analytics.databaseSsl -}}
{{- end -}}
{{- end -}}
