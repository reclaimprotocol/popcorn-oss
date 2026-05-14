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
