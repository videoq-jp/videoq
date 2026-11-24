# Terraform work

Use HashiCorp's official Terraform MCP Server (`hashicorp/terraform-mcp-server`)
for provider documentation and capability discovery. Use the official skills in
`hashicorp/agent-skills`: `terraform-style-guide`, `terraform-search-import`, and
`terraform-test` when tests are appropriate. Keep their source official when
installing or updating them. Do not substitute third-party Terraform skills or
MCP servers. Read the installed skill before applying it.

Retrieve documentation for the provider version selected by the lock file.
Check Search/list and import support before choosing an adoption method.
See `CLOUDFLARE-PROVIDER-GAPS.md` for the pinned Cloudflare provider's limitations.

Use `node infra/bin/terraform-r2.cjs -chdir=...` for live Terraform operations.
See `TERRAFORM.md` for backend keys, credential separation, snapshots and recovery.
Keep state, plans, credentials and provider responses out of commits and public
CI artifacts. Preserve existing production resource identities when adopting
infrastructure and verify plans before applying changes.
