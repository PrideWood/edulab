// Starts only local services. No provider key is copied or returned.
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {writeFile,mkdir,chmod,readFile} from 'node:fs/promises';
import {createConnection} from 'node:net';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {existsSync} from 'node:fs';
const root=dirname(fileURLToPath(import.meta.url));
const bundledRepo=resolve(root,'../..');
const edulab=resolve(process.argv[2]||process.env.EDULAB_PROJECT||(existsSync(resolve(bundledRepo,'package.json'))?bundledRepo:'/Users/chai/Documents/ChatGPT/EduLab'));
try {
 const launch=JSON.parse(await readFile(resolve(root,'data/launch.json'),'utf8'));
 const url=new URL(launch.url),key=new URLSearchParams(url.hash.slice(1)).get('key');
 const response=await fetch(url.origin+'/api/health',{headers:{'X-Local-Key':key},signal:AbortSignal.timeout(1500)});
 if(response.ok&&(await response.json()).application==='sql-teachable-mvp/1'){
  console.log('SQL本机服务已经运行，请使用：'+launch.url);
  if(!process.env.SQL_MVP_NO_BROWSER)spawn(process.env.EDULAB_SQL_PYTHON||'python3',['-m','webbrowser',launch.url],{stdio:'ignore'});
  process.exit(0);
 }
}catch(error){
 const code=error.cause?.code||error.code;
 if(code&&!['ENOENT','ECONNREFUSED','ECONNRESET'].includes(code)){
  console.error('无法核实已有本机服务，未修改连接文件。请在可访问本机网络的终端启动。');
  process.exit(1);
 }
}
async function occupied(port){return new Promise((resolve,reject)=>{
 const socket=createConnection({host:'127.0.0.1',port});
 socket.setTimeout(1000);
 socket.once('connect',()=>{socket.destroy();resolve(true);});
 socket.once('error',error=>error.code==='ECONNREFUSED'?resolve(false):reject(error));socket.once('timeout',()=>{socket.destroy();reject(new Error('port_probe_timeout'));});
});}
let portsBusy;
try{portsBusy=await occupied(47850)||await occupied(3005);}catch{
 console.error('无法检查本机端口，未修改连接文件。请在本机终端启动。');process.exit(1);
}
if(portsBusy){
 console.error('本机测试端口已被其他服务使用。请使用原预览窗口，或先关闭原SQL/EduLab启动窗口再重开；现有数据与连接未改变。');
 process.exit(1);
}
const token=randomBytes(32).toString('hex');
await mkdir(resolve(root,'.private'),{recursive:true,mode:0o700});
await writeFile(resolve(root,'.private/bridge.json'),JSON.stringify({base_url:'http://127.0.0.1:3005/api/sql-local',
 token,model:'EduLab共享连接',source:'edulab-local-bridge'}),{mode:0o600});
await chmod(resolve(root,'.private/bridge.json'),0o600);
const next=spawn(process.execPath,[resolve(edulab,'node_modules/next/dist/bin/next'),'dev','--hostname','127.0.0.1','--port','3005'],{
 cwd:edulab,env:{...process.env,SQL_LOCAL_BRIDGE_TOKEN:token},stdio:'inherit'});
const python=process.env.EDULAB_SQL_PYTHON||'python3';
const args=[resolve(root,'server.py'),...(process.env.SQL_MVP_NO_BROWSER?['--no-browser']:[])];
const local=spawn(python,args,{cwd:root,stdio:'inherit'});
let closing=false;
function close(){if(closing)return;closing=true;next.kill('SIGTERM');local.kill('SIGINT');}
process.on('SIGINT',close);process.on('SIGTERM',close);
next.on('exit',()=>{if(!closing)console.error('EduLab转接服务已退出；SQL本地保存仍可用，真实AI和云备份需重启转接。');});
local.on('exit',()=>{close();});
