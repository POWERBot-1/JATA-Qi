{{/*
Common labels.
*/}}
{{- define "jataqi.labels" -}}
app.kubernetes.io/name: jataqi
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{/*
Selector labels.
*/}}
{{- define "jataqi.selectorLabels" -}}
app.kubernetes.io/name: jataqi
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
