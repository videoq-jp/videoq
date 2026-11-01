declare module "cloudflare:test" {
  // Declaration merging extends the environment supplied by cloudflare:test.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ProvidedEnv extends CloudflareBindings {}
}
