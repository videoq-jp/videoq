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

{{/* Shared requests must never silently become exclusive or CPU workloads. */}}
{{- define "inference.validateSharing" -}}
{{- if not .root.Values.gpuSharing.enabled }}
{{- range $kind := list "requests" "limits" }}
{{- if hasKey (index $.resources $kind | default dict) "nvidia.com/gpu.shared" }}
{{- fail "nvidia.com/gpu.shared requires gpuSharing.enabled=true" }}
{{- end }}
{{- end }}
{{- end }}
{{- if .root.Values.gpuSharing.enabled }}
{{- if and (ne .engine "vllm") (not (and (eq .engine "embeddinggemma2") (eq (default "cpu" .device) "cuda"))) }}
{{- fail "GPU sharing requires CUDA engines (vllm or embeddinggemma2 with device=cuda)" }}
{{- end }}
{{- if or (ne (int .root.Values.whisper.maxSequences) 1) (ne (int .root.Values.whisper.maxConcurrentRequests) 1) (ne (int .root.Values.whisper.upstreamParallelism) 1) }}
{{- fail "shared GPU speech concurrency and maxSequences must be one" }}
{{- end }}
{{- $sum := 0.0 }}
{{- range $fraction := .root.Values.gpuSharing.memoryFractions }}
{{- $sum = addf $sum $fraction }}
{{- end }}
{{- if gt $sum 0.85 }}
{{- fail "shared GPU memory fractions must total at most 0.85; leave driver/runtime headroom" }}
{{- end }}
{{- range $kind := list "requests" "limits" }}
{{- $resources := index $.resources $kind | default dict }}
{{- if or (ne (float64 (default 0 (index $resources "nvidia.com/gpu.shared"))) 1.0) (hasKey $resources "nvidia.com/gpu") }}
{{- fail "GPU sharing requires exactly one nvidia.com/gpu.shared request and limit per engine, and no exclusive GPU" }}
{{- end }}
{{- end }}
{{- range $arg := .extraArgs }}
{{- if regexMatch "^--(gpu-memory-utilization|kv-cache-memory-bytes|cpu-offload-gb|swap-space|device|tensor-parallel-size|pipeline-parallel-size|max-num-seqs|dtype|max-model-len|enforce-eager)(=|$)" (replace "_" "-" $arg) }}
{{- fail "shared GPU capacity arguments are managed by the chart, not extraArgs" }}
{{- end }}
{{- end }}
{{- end }}
{{- end -}}

{{- define "inference.sharedWait" -}}
{{- $custom := eq (default "" .root.Values.servers.embedding.engine) "embeddinggemma2" }}
{{- if not (and $custom (eq .role "whisper")) }}
{{- $peer := ternary "embedding" "whisper" (eq .role "whisper") }}
{{- if and $custom (eq .role "embedding") }}
{{- $peer = "chat" }}
{{- end }}
{{- $port := ternary 8000 8080 (or (eq .role "whisper") (eq .role "embedding")) }}
- name: wait-for-{{ $peer }}
  image: {{ include "inference.image" (dict "root" .root "image" .root.Values.whisper.image "component" "whisper") | quote }}
  imagePullPolicy: {{ .root.Values.whisper.image.pullPolicy }}
  command: [python, -c]
  args:
    - |
      import time, urllib.request, urllib.error
      opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
      deadline = time.monotonic() + 1800
      while time.monotonic() < deadline:
          try:
              with opener.open("http://{{ include "inference.fullname" .root }}-{{ $peer }}:{{ $port }}/health", timeout=5) as response:
                  if response.status == 200:
                      break
          except (OSError, urllib.error.URLError):
              pass
          time.sleep(2)
      else:
          raise SystemExit("Shared GPU peer did not become healthy")
  securityContext:
    {{- include "inference.security" .root | nindent 4 }}
    readOnlyRootFilesystem: true
  resources: { requests: { cpu: 10m, memory: 32Mi }, limits: { cpu: 100m, memory: 128Mi } }
{{- end }}
{{- end -}}
