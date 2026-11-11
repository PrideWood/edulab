import 'server-only';
import {createHmac,createHash} from 'node:crypto';
const sha1=(value:string)=>createHash('sha1').update(value).digest('hex');
const hmac=(key:string,value:string)=>createHmac('sha1',key).update(value).digest('hex');
export function cosConfig(){
 const bucket=process.env.COS_BUCKET??'',region=process.env.COS_REGION??'';
 const prefix=process.env.COS_KEY_PREFIX??'sql-practice/';
 const id=process.env.COS_SECRET_ID??'',secret=process.env.COS_SECRET_KEY??'';
 if(!/^[a-z0-9-]+-[0-9]+$/.test(bucket)||!/^[-a-z0-9]+$/.test(region)||!/^([a-zA-Z0-9_-]+\/)+$/.test(prefix)||!id||!secret)throw Error('COS_NOT_CONFIGURED');
 return {bucket,region,prefix,id,secret};
}
// Tencent COS XML signing: SignKey is the hexadecimal HMAC string, not raw bytes.
export function cosUrl(method:'PUT'|'GET'|'HEAD',suffix:string,now=Math.floor(Date.now()/1000),extra:Record<string,string>={}){
 const c=cosConfig();
 if(!/^[a-f0-9/-]+\.(jpg|png)$/.test(suffix))throw Error('INVALID_OBJECT');
 const host=c.bucket+'.cos.'+c.region+'.myqcloud.com',path='/'+c.prefix+suffix,time=(now-30)+';'+(now+300);
 const signed:Record<string,string>={...extra,host},keys=Object.keys(signed).sort();
 const http=method.toLowerCase()+'\n'+path+'\n\n'+keys.map(k=>encodeURIComponent(k)+'='+encodeURIComponent(signed[k])).join('&')+'\n';
 const sign=hmac(hmac(c.secret,time),'sha1\n'+time+'\n'+sha1(http)+'\n');
 const q=new URLSearchParams({'q-sign-algorithm':'sha1','q-ak':c.id,'q-sign-time':time,'q-key-time':time,'q-header-list':keys.join(';'),'q-url-param-list':'','q-signature':sign});
 return 'https://'+host+path+'?'+q;
}
export async function verifiedCosImage(row:{object_suffix:string;sha256:string;size_bytes:number;mime:string}){
 const r=await fetch(cosUrl('GET',row.object_suffix),{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000)});
 if(!r.ok||!r.body||Number(r.headers.get('content-length'))!==row.size_bytes)throw Error('IMAGE_NOT_READY');
 const reader=r.body.getReader(),chunks:Uint8Array[]=[];let total=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>row.size_bytes||total>2097152)throw Error('IMAGE_SIZE');chunks.push(value);}}finally{await reader.cancel();}
 const bytes=Buffer.concat(chunks);
 if(bytes.length!==row.size_bytes||createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw Error('IMAGE_HASH');
 if(!(row.mime==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):bytes[0]===255&&bytes[1]===216&&bytes[2]===255))throw Error('IMAGE_TYPE');
}
