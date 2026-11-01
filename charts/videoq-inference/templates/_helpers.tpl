{{- define "inference.fullname" -}}
{{- default (printf "%s-%s" .Release.Name .Chart.Name) .Values.fullnameOverride | trunc 48 | trimSuffix "-" -}}
{{- end -}}
{{- define "inference.labels" -}}
app.kubernetes.io/name: videoq-inference
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- define "inference.image" -}}
{{- if .image.digest -}}
{{ .image.repository }}@{{ .image.digest }}
{{- else if .root.Values.requireImageDigests -}}
{{- fail (printf "%s.image.digest is required when requireImageDigests=true" .component) -}}
{{- else -}}
{{ .image.repository }}:{{ .image.tag }}
{{- end -}}
{{- end -}}
{{- define "inference.security" -}}
allowPrivilegeEscalation: false
capabilities:
  drop: [ALL]
{{- end -}}
{{- define "inference.gpuResource" -}}
{{- if eq .accelerator "amd" -}}amd.com/gpu{{- else -}}nvidia.com/gpu{{- end -}}
{{- end -}}
{{- define "inference.validateGpu" -}}
{{- $accelerator := default .root.Values.vllm.accelerator .accelerator -}}
{{- $selected := include "inference.gpuResource" (dict "accelerator" $accelerator) -}}
{{- $other := ternary "nvidia.com/gpu" "amd.com/gpu" (eq $selected "amd.com/gpu") -}}
{{- $limits := default dict .resources.limits -}}
{{- $requests := default dict .resources.requests -}}
{{- $count := int (default 0 (index $limits $selected)) -}}
{{- $requested := $count -}}
{{- if hasKey $requests $selected -}}
{{- $requested = int (index $requests $selected) -}}
{{- end -}}
{{- $otherCount := max (int (default 0 (index $limits $other))) (int (default 0 (index $requests $other))) -}}
{{- if .gpu -}}
{{- if or (lt $count 1) (ne $count $requested) (gt $otherCount 0) (and .exactlyOne (ne $count 1)) -}}
{{- fail (printf "%s requires matching %s requests/limits (%s); do not mix GPU vendors" .component $selected (ternary "exactly one GPU" "at least one GPU" .exactlyOne)) -}}
{{- end -}}
{{- else if or (gt $count 0) (gt $requested 0) (gt $otherCount 0) -}}
{{- fail (printf "%s CPU backend must not reserve NVIDIA or AMD GPUs" .component) -}}
{{- end -}}
{{- end -}}
