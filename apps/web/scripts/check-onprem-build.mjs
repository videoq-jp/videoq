import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const directory = resolve(process.argv[2] || 'dist');
const html = readFileSync(resolve(directory, 'index.html'), 'utf8');
assert.match(html, /noindex, nofollow/);
assert.doesNotMatch(html, /fonts\.google|videoq\.jp|application\/ld\+json|Get started for free/);
for (const file of readdirSync(resolve(directory, 'assets'))) {
  assert.doesNotMatch(file, /LandingPage|TryPage|PricingPage|LegalPage|SignupPage|SignupCompletePage|SignupCheckEmailPage|ForgotPasswordPage|VerifyEmailPage|EmailChangeConfirmPage|GuideIndexPage|GuidePage/);
}
for (const file of ['demo', 'app-shell.html', 'sitemap.xml', 'llms.txt', 'og-image.png', 'og-image-v2.png']) assert.equal(existsSync(resolve(directory, file)), false, file);
assert.equal(readFileSync(resolve(directory, 'robots.txt'), 'utf8'), 'User-agent: *\nDisallow: /\n');
console.log('On-prem web artifact contains no SaaS pages, public demo assets, or remote font requests.');
