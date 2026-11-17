// Load only the repository's locked operations dependencies; never install or
// select a caller-supplied module, parser, or password hasher.
const path=require('node:path'),{createRequire}=require('node:module');
async function loadIsolatedSmokeTools(root){
 const requireTools=createRequire(path.join(root,'.github/operations-tools/package.json'));
 const {hashPassword}=await import(requireTools.resolve('better-auth/crypto'));
 const {createParser}=requireTools('eventsource-parser');
 if(typeof hashPassword!=='function'||typeof createParser!=='function')throw Error('ISOLATED_SMOKE_DEPENDENCIES_REQUIRED');return{hashPassword,createParser};
}
module.exports={loadIsolatedSmokeTools};
