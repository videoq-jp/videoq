import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { consentAllows, refreshConsentPlan } from '../src/domain/identity/oauth-consent';
import { usernameSeed, usernameCandidate, fallbackUsername } from '../src/domain/identity/username';
it('identity decisions have no async/await orchestration', () => {
  const root=new URL('../src/domain/identity/',import.meta.url);
  for (const name of readdirSync(root).filter(name=>name.endsWith('.ts'))) {
    const source=ts.createSourceFile(name,readFileSync(new URL(name,root),'utf8'),ts.ScriptTarget.Latest,true);
    function visit(node:ts.Node) {
      expect(node.kind,`${name}: application owns asynchronous I/O`).not.toBe(ts.SyntaxKind.AsyncKeyword);
      expect(ts.isAwaitExpression(node),name).toBe(false);
      ts.forEachChild(node,visit);
    }
    visit(source);
  }
});
it('makes consent and candidate decisions using only supplied facts', () => {
  expect(consentAllows(['read'],{scopes:['read']})).toBe(true);
  expect(consentAllows(['write'],{scopes:['read']})).toBe(false);
  expect(consentAllows([],null)).toBe(false);
  expect(refreshConsentPlan({revoked:false,userId:'u',clientId:'c',scopes:['read']},undefined)).toEqual({kind:'check',userId:'u',clientId:'c',scopes:['read']});
  const seed=usernameSeed('Alice.Bob@example.com');
  expect(usernameCandidate(seed,0)).toBe('alice_bob');
  expect(usernameCandidate(seed,1)).toBe('alice_bob_1');
  expect(fallbackUsername('12345678-1234-1234-1234-123456789abc')).toBe('user_123456781234');
});
