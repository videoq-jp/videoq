// Production uploads have one owner: the reviewed main GitHub workflow.
const {spawnSync}=require('node:child_process');
const foundation=process.argv[2]==='foundation';
console.log('Requesting the Terraform deployment of reviewed main through GitHub Actions.');
const result=spawnSync('gh',['workflow','run',foundation?'cloudflare-infrastructure.yml':'cd.yml','--repo','videoq-jp/videoq','--ref','main',...(foundation?['-f','apply=true']:[])],{stdio:'inherit'});
if(result.error)console.error('GitHub CLI authentication is required to request the production deployment.');
process.exitCode=result.status??1;
