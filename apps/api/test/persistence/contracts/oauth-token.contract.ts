import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
const base='https://oauth-persistence.example.test',resource=base+'/api/mcp';
const verifier='database-contract-pkce-verifier-with-at-least-43-characters';
const password='Isolated-OAuth-contract-password-2026';
export const oauthTokenUserId='20000000-0000-4000-8000-000000000001';
export {password as oauthTokenPassword};
export type OAuthTokenFixture={
 auth:{handler(request:Request):Promise<Response>};
 ban(value:boolean):Promise<void>;
 counts():Promise<{refresh:number;access:number}>;
 refreshTokens():Promise<Array<{token:string;revoked:boolean}>>;
 dispose():Promise<void>;
};
export const oauthTokenSettings={ENVIRONMENT:'production',BETTER_AUTH_URL:base,FRONTEND_URL:base,CORS_ALLOW_ORIGIN:base,
 BETTER_AUTH_SECRET:'isolated-database-oauth-contract-secret-01234567890123456789'};
export function oauthTokenContract(name:string,create:()=>Promise<OAuthTokenFixture>){describe(name,()=>{
 let f:OAuthTokenFixture;
 beforeEach(async()=>{f=await create();});afterEach(async()=>{await f?.dispose();});
 const post=(path:string,body:unknown,cookie='')=>f.auth.handler(new Request(base+'/api/auth'+path,{method:'POST',headers:{'content-type':'application/json',origin:base,'cf-connecting-ip':'192.0.2.10',...(cookie?{cookie}:{})},body:JSON.stringify(body)}));
 const token=(clientId:string,params:Record<string,string>,withResource=true)=>f.auth.handler(new Request(base+'/api/auth/oauth2/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','cf-connecting-ip':'192.0.2.11'},body:new URLSearchParams({client_id:clientId,...(withResource?{resource}:{}),...(params.grant_type==='authorization_code'?{redirect_uri:'http://127.0.0.1:54321/callback'}:{}),...params})}));
 async function connect(withResource=true){
  const login=await post('/sign-in/username',{username:'oauthcontract',password});expect(login.status,await login.clone().text()).toBe(200);
  const cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
  const registered=await post('/oauth2/register',{client_name:'Database contract',application_type:'native',token_endpoint_auth_method:'none',redirect_uris:['http://127.0.0.1:54321/callback'],grant_types:['authorization_code','refresh_token']});expect(registered.status,await registered.clone().text()).toBe(201);
  const {client_id:clientId}=await registered.json<{client_id:string}>();
  const query=new URLSearchParams({client_id:clientId,redirect_uri:'http://127.0.0.1:54321/callback',response_type:'code',scope:'openid profile email offline_access videoq.read',...(withResource?{resource}:{}),code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',state:'isolated-state'});
  const authorized=await f.auth.handler(new Request(base+'/api/auth/oauth2/authorize?'+query.toString(),{headers:{cookie,'cf-connecting-ip':'192.0.2.12'}}));expect(authorized.status,await authorized.clone().text()).toBe(302);
  let redirect=new URL(authorized.headers.get('location')!,base);
  if(redirect.pathname==='/consent'){const consent=await post('/oauth2/consent',{accept:true,oauth_query:redirect.search.slice(1)},cookie);expect(consent.status,await consent.clone().text()).toBe(200);redirect=new URL((await consent.json<{url:string}>()).url);}
  const code=redirect.searchParams.get('code');expect(code).toBeTruthy();
  const response=await token(clientId,{grant_type:'authorization_code',code:code!,code_verifier:verifier},withResource);expect(response.status,await response.clone().text()).toBe(200);
  const issued=await response.json<{access_token:string;refresh_token:string;id_token:string;expires_in:number}>();
  return {clientId,code:code!,...issued};
 }
 it.each([true,false])('exchanges PKCE, rotates and rejects reuse with resource=%s',async withResource=>{
  const issued=await connect(withResource);expect(issued.expires_in).toBe(300);expect(issued.id_token).toBeTruthy();expect(issued.access_token.includes('.')).toBe(withResource);
  const rows=await f.refreshTokens();expect(rows).toHaveLength(1);expect(rows[0].token).not.toBe(issued.refresh_token);
  const refreshed=await token(issued.clientId,{grant_type:'refresh_token',refresh_token:issued.refresh_token},withResource);expect(refreshed.status,await refreshed.clone().text()).toBe(200);
  const next=await refreshed.json<{access_token:string;refresh_token:string}>();expect(next.refresh_token).not.toBe(issued.refresh_token);
  const userinfo=await f.auth.handler(new Request(base+'/api/auth/oauth2/userinfo',{headers:{authorization:'Bearer '+next.access_token,'cf-connecting-ip':'192.0.2.13'}}));expect(userinfo.status,await userinfo.clone().text()).toBe(200);expect(await userinfo.json()).toMatchObject({sub:oauthTokenUserId,email:'oauth-contract@example.test'});
  for(const refreshToken of [issued.refresh_token,next.refresh_token]){const replay=await token(issued.clientId,{grant_type:'refresh_token',refresh_token:refreshToken},withResource);expect(replay.status,await replay.clone().text()).toBe(400);expect(await replay.json()).toMatchObject({error:'invalid_grant'});}
 },30000);
 it('rejects authorization-code reuse and invalidates its issued refresh credentials',async()=>{
  const issued=await connect();
  expect((await token(issued.clientId,{grant_type:'authorization_code',code:issued.code,code_verifier:verifier})).status).toBe(400);
  const rejected=await token(issued.clientId,{grant_type:'refresh_token',refresh_token:issued.refresh_token});
  expect(rejected.status).toBe(400);expect(await rejected.json()).toMatchObject({error:'invalid_grant'});
 },30000);
 it('allows at most one winner for concurrent refresh of the same token',async()=>{
  const issued=await connect();const request={grant_type:'refresh_token',refresh_token:issued.refresh_token};
  const responses=await Promise.all([token(issued.clientId,request),token(issued.clientId,request)]);expect(responses.map(r=>r.status).sort()).toEqual([200,400]);
  expect(await responses.find(r=>r.status===400)!.json()).toMatchObject({error:'invalid_grant'});
  expect((await f.refreshTokens()).length).toBeLessThanOrEqual(2);
  expect((await token(issued.clientId,request)).status).toBe(400);
 },30000);
 it('rejects a banned owner before creating replacement credentials',async()=>{
  const issued=await connect();const before=await f.counts();await f.ban(true);
  const rejected=await token(issued.clientId,{grant_type:'refresh_token',refresh_token:issued.refresh_token});expect(rejected.status,await rejected.clone().text()).toBe(400);expect(await rejected.json()).toMatchObject({error:'invalid_grant'});expect(await f.counts()).toEqual(before);
 },30000);
});}
