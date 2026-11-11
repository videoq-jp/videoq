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

{{- define "inference.vllmAudioInit" -}}
{{- $lock := .root.Files.Get "files/vllm-audio-wheels.json" | fromJson -}}
{{- $image := printf "%s@%s" .root.Values.vllm.image.repository .root.Values.vllm.image.digest -}}
{{- if ne $image $lock.image -}}
{{- fail "vllm.image must match the reviewed files/vllm-audio-wheels.json image" -}}
{{- end -}}
- name: provision-audio
  image: {{ include "inference.image" (dict "root" .root "image" .root.Values.whisper.image "component" "whisper") | quote }}
  imagePullPolicy: {{ .root.Values.whisper.image.pullPolicy }}
  command: [python, provision_audio.py]
  args:
    - --manifest
    - /etc/videoq-audio/wheels.json
    - --cache
    - /models
    - --destination
    - /opt/videoq-audio
    {{- if .root.Values.downloadModels }}
    - --download
    {{- end }}
  securityContext: {{ include "inference.security" .root | nindent 4 }}
  resources: { requests: { cpu: 100m, memory: 128Mi }, limits: { memory: 512Mi } }
  volumeMounts:
    - { name: models, mountPath: /models }
    - { name: vllm-audio, mountPath: /opt/videoq-audio }
    - { name: vllm-audio-lock, mountPath: /etc/videoq-audio, readOnly: true }
{{- end -}}

{{- define "inference.vllmAudioVolumes" -}}
- name: vllm-audio
  emptyDir: { sizeLimit: 1Gi }
- name: vllm-audio-lock
  configMap:
    name: {{ include "inference.fullname" . }}-vllm-audio
{{- end -}}
