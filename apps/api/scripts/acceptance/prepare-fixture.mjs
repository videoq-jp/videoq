/** Offline credential/seed generation. Does not provision or mutate any cloud resource. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,existsSync,chmodSync} from 'node:fs';
import {hashPassword} from 'better-auth/crypto';
const directory=process.env.ACCEPTANCE_PRIVATE_DIR;if(!directory)throw Error('ACCEPTANCE_PRIVATE_DIR required');
mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
assert(!existsSync(directory+'/private.json'),'Existing private state must not be overwritten');
const state={password:randomBytes(24).toString('hex'),authSecret:randomBytes(32).toString('hex'),notificationToken:randomBytes(32).toString('hex')};
const template=readFileSync(new URL('./fixture.sql.template',import.meta.url),'utf8');assert.equal(template.split('__GENERATED_PASSWORD_HASH__').length,2);
const sql=template.replace('__GENERATED_PASSWORD_HASH__',await hashPassword(state.password));
writeFileSync(directory+'/private.json',JSON.stringify(state),{mode:0o600});writeFileSync(directory+'/seed.sql',sql,{mode:0o600});
console.log(JSON.stringify({generated:true,credentialValuesWithheld:true,next:'Copy isolated configs, provision/migrate, deploy both fixture Workers, configure-fixture, seed-fixture, then sign-in'}));
