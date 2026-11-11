import {randomUUID} from 'node:crypto';
import {ACCESS_COOKIE,verifyAccessCookie} from '@/lib/access-code';
import {onlineEnter,onlineCall,onlineChat,onlineClasses,DEVICE_COOKIE,cookie,sameOrigin,uuid,StudentError} from '@/lib/sql-online';
export const runtime='nodejs';export const maxDuration=120;
const studentWebPaused=process.env.SQL_STUDENT_WEB_PAUSED!=='false';
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
async function handle(request:Request,context:{params:Promise<{endpoint:string}>}){try{
 if(studentWebPaused)return Response.json({error:'学生线上版暂缓开放，请使用教师发放的机房客户端。',code:'STUDENT_WEB_PAUSED'},{status:503,headers});
 const code=process.env.ACCESS_CODE;if(!code||!await verifyAccessCookie(cookie(request,ACCESS_COOKIE),code))return Response.json({error:'请先打开线上入口输入网站访问码。',code:'ACCESS_REQUIRED'},{status:401,headers});
 const {endpoint}=await context.params;
 if(request.method==='GET'&&endpoint==='classes')return Response.json(await onlineClasses(),{headers});
 const suppliedDevice=cookie(request,DEVICE_COOKIE),device=uuid(suppliedDevice)?suppliedDevice:randomUUID();let input:Record<string,unknown>={};
 if(request.method==='POST'){sameOrigin(request);if(Number(request.headers.get('content-length')??0)>1200000)throw new StudentError('提交内容过大。',413);const body=await request.text();if(body.length>1200000)throw new StudentError('提交内容过大。',413);const parsed=JSON.parse(body);if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')throw new StudentError('输入格式无效。');input=parsed;}
 if(endpoint==='enter'&&request.method==='POST'){const data=await onlineEnter(device,input);const response=Response.json(data,{headers});response.headers.append('Set-Cookie',`${DEVICE_COOKIE}=${device}; Path=/api/sql-student; HttpOnly; SameSite=Lax; Max-Age=31536000${process.env.NODE_ENV==='production'?'; Secure':''}`);return response;}
 if(!uuid(suppliedDevice))throw new StudentError('本机身份失效，请重新登录。',401);
 const participant=request.headers.get('x-participant')??'',token=request.headers.get('x-participant-session')??'';
 if(endpoint==='chat'&&request.method==='POST')return Response.json(await onlineChat(device,participant,token,input),{headers});
 if(endpoint==='questions'&&request.method==='GET'){const url=new URL(request.url);input={kind:url.searchParams.get('kind')??'pretest',round_id:url.searchParams.get('round_id')};}
 if(!((request.method==='GET'&&['state','questions'].includes(endpoint))||(request.method==='POST'&&['action','refresh'].includes(endpoint))))throw new StudentError('未找到接口。',404);
 return Response.json(await onlineCall(device,participant,token,endpoint,input),{headers});
 }catch(e){const message=e instanceof StudentError?e.message:'请求暂未完成，请稍后重试。';if(!(e instanceof StudentError))console.error('sql.online.failure',{kind:e instanceof Error?e.name:'unknown'});return Response.json({error:message},{status:e instanceof StudentError?e.status:503,headers});}}
export const GET=handle;export const POST=handle;
