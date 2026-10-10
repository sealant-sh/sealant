{{- define "sealant.name" -}}sealant{{- end -}}
{{- define "sealant.tag" -}}{{ .Values.image.tag | default .Chart.AppVersion }}{{- end -}}
{{- define "sealant.image" -}}{{ .root.Values.image.namespace }}/sealant-{{ .name }}:{{ include "sealant.tag" .root }}{{- end -}}
{{- define "sealant.workspaceNamespace" -}}{{ .Values.workspaces.namespace | default .Release.Namespace }}{{- end -}}
{{- define "sealant.labels" -}}
app.kubernetes.io/name: sealant
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}
{{- define "sealant.component" -}}
app.kubernetes.io/name: sealant
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .name }}
{{- end -}}
{{- define "sealant.databaseUrl" -}}
{{- if .Values.postgres.enabled -}}
postgresql://sealant:$(SEALANT_DB_PASSWORD)@{{ .Release.Name }}-postgres:5432/sealant_control_plane
{{- else -}}
{{ required "postgres.externalUrl is required when postgres.enabled=false" .Values.postgres.externalUrl }}
{{- end -}}
{{- end -}}
{{- define "sealant.registryBaseUrl" -}}
{{- if .Values.registry.enabled -}}http://{{ .Release.Name }}-registry:5000{{- else -}}{{ required "registry.external.baseUrl" .Values.registry.external.baseUrl }}{{- end -}}
{{- end -}}
{{- define "sealant.pushRegistry" -}}
{{- if .Values.registry.enabled -}}{{ .Release.Name }}-registry.{{ .Release.Namespace }}.svc:5000{{- else -}}{{ required "registry.external.pushRegistry" .Values.registry.external.pushRegistry }}{{- end -}}
{{- end -}}
{{- define "sealant.registryInsecure" -}}
{{- if .Values.registry.enabled -}}true{{- else -}}{{ .Values.registry.external.insecure }}{{- end -}}
{{- end -}}
{{- define "sealant.issuerName" -}}{{ .Values.certManager.issuerRef.name | default (printf "%s-internal-ca" .Release.Name) }}{{- end -}}
{{- define "sealant.issuerKind" -}}{{ .Values.certManager.issuerRef.kind | default "ClusterIssuer" }}{{- end -}}
{{/* Env shared by every control-plane process that reads sealantd over WSS. */}}
{{- define "sealant.controlTlsEnv" -}}
- name: SEALANT_CONTROL_CLIENT_CERT_PATH
  value: /etc/sealant/control-tls/tls.crt
- name: SEALANT_CONTROL_CLIENT_KEY_PATH
  value: /etc/sealant/control-tls/tls.key
- name: SEALANT_CONTROL_CA_PATH
  value: /etc/sealant/control-tls/ca.crt
{{- end -}}
{{- define "sealant.secretEnv" -}}
- name: SEALANT_DB_PASSWORD
  valueFrom: { secretKeyRef: { name: {{ .Values.secrets.existingSecret }}, key: SEALANT_DB_PASSWORD, optional: true } }
- name: SEALANT_CREDENTIALS_KEY
  valueFrom: { secretKeyRef: { name: {{ .Values.secrets.existingSecret }}, key: SEALANT_CREDENTIALS_KEY, optional: true } }
- name: GITHUB_APP_PRIVATE_KEY
  valueFrom: { secretKeyRef: { name: {{ .Values.secrets.existingSecret }}, key: GITHUB_APP_PRIVATE_KEY, optional: true } }
- name: REGISTRY_USERNAME
  valueFrom: { secretKeyRef: { name: {{ .Values.secrets.existingSecret }}, key: REGISTRY_USERNAME, optional: true } }
- name: REGISTRY_PASSWORD
  valueFrom: { secretKeyRef: { name: {{ .Values.secrets.existingSecret }}, key: REGISTRY_PASSWORD, optional: true } }
{{- end -}}
{{- define "sealant.volumeMappings" -}}
{{- $out := list -}}
{{- $roots := list -}}
{{- range .Values.workspaces.volumeMappings -}}
{{- $out = append $out (dict "logicalRoot" .logicalRoot "claimName" .claimName) -}}
{{- $roots = append $roots .logicalRoot -}}
{{- end -}}
{{- if and .Values.workspaces.staging.claimName (not (has .Values.workspaces.staging.logicalRoot $roots)) -}}
{{- $out = append $out (dict "logicalRoot" .Values.workspaces.staging.logicalRoot "claimName" .Values.workspaces.staging.claimName) -}}
{{- end -}}
{{ toJson $out }}
{{- end -}}
{{- define "sealant.allowedRoots" -}}
{{- $roots := list -}}
{{- range .Values.workspaces.volumeMappings -}}{{- $roots = append $roots .logicalRoot -}}{{- end -}}
{{ join ":" $roots }}
{{- end -}}
{{- /*
What workspace images are built for: `workspaces.imagePlatform`, else the architecture
`workspaces.nodeSelector` selects (`kubernetes.io/arch`), else empty, and the worker takes its own
node's. Rendered into the API and the worker alike, so both plan the same image.
*/ -}}
{{- define "sealant.workspaceImagePlatform" -}}
{{- $pinned := .Values.workspaces.imagePlatform | default "" -}}
{{- $arch := index (.Values.workspaces.nodeSelector | default dict) "kubernetes.io/arch" | default "" -}}
{{- if and $pinned (not (has $pinned (list "linux/amd64" "linux/arm64"))) -}}
{{- fail (printf "workspaces.imagePlatform must be linux/amd64 or linux/arm64, not %s" $pinned) -}}
{{- end -}}
{{- if and $arch (not (has $arch (list "amd64" "arm64"))) -}}
{{- fail (printf "workspaces.nodeSelector selects kubernetes.io/arch=%s; workspace images are built for amd64 and arm64" $arch) -}}
{{- end -}}
{{- if and $pinned $arch (ne $pinned (printf "linux/%s" $arch)) -}}
{{- fail (printf "workspaces.imagePlatform is %s but workspaces.nodeSelector selects kubernetes.io/arch=%s" $pinned $arch) -}}
{{- end -}}
{{- if $pinned -}}{{ $pinned }}{{- else if $arch -}}linux/{{ $arch }}{{- end -}}
{{- end -}}
