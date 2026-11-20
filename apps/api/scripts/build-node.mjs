import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const bundle = await build({
  entryPoints: { "provision-user": "scripts/provision-user.ts", node: "src/runtime/node.ts", "migrate-database": "scripts/migrate-database.ts" },
  outdir: "dist", outExtension: { ".js": ".mjs" },
  metafile: true,
  bundle: true, platform: "node", target: "node22", format: "esm",
  // Workspace sources must be bundled; production dependencies stay external.
  external: Object.keys(pkg.dependencies).filter(name => !["@videoq/trpc", "@videoq/domain"].includes(name)),
});

// A workspace's source exports are TypeScript. Production entries must carry
// their compiled implementation instead of loading workspace source at runtime.
for (const output of Object.values(bundle.metafile.outputs)) {
  const unresolved = output.imports.find(dependency => dependency.external && dependency.path.startsWith('@videoq/'));
  if (unresolved) throw new Error(`Workspace dependency was not bundled: ${unresolved.path}`);
}
