import { expect,it,vi } from 'vitest';
import { recoveryRequest } from '../scripts/search-workflow-recovery';
it('pins credentials and operation to the explicit API origin with redirects rejected',async()=>{
 const request=vi.fn<typeof fetch>(async()=>Response.json({result:{data:{inspection:'safe'}}}));
 expect(await recoveryRequest('https://isolated.example','secret-session',{job:{job_id:'job'}},false,false,request)).toEqual({inspection:'safe'});
 const [url,init]=request.mock.calls[0];expect(String(url)).toContain('https://isolated.example/api/trpc/admin.inspectSearchRecovery?');
 expect(init).toMatchObject({redirect:'error',method:'GET',headers:{cookie:'secret-session'}});
 await recoveryRequest('https://isolated.example','secret-session',{inspection:'digest'},true,false,request);
 expect(String(request.mock.calls[1][0])).toBe('https://isolated.example/api/trpc/admin.restartSearchWorkflow');
});
it.each(['http://remote.example','https://user:password@example.test','https://example.test/other','https://example.test/?token=secret'])('rejects ambiguous or insecure target %s',async target=>{
 const request=vi.fn<typeof fetch>();await expect(recoveryRequest(target,'secret',{},true,false,request)).rejects.toThrow('RECOVERY_INVALID_TARGET');expect(request).not.toHaveBeenCalled();
});
it('redacts remote response failures',async()=>{
 await expect(recoveryRequest('https://isolated.example','secret',{},true,false,async()=>new Response('private database error',{status:500}))).rejects.toThrow('RECOVERY_REQUEST_FAILED');
});
