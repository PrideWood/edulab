import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';

const source=ts.transpileModule(await readFile('lib/access-verification.ts','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2017},
}).outputText;
const apiSource=ts.transpileModule(await readFile('lib/client-api.ts','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2017},
}).outputText;
function load(fetch) {
  const exports={},api={};
  const timeout={timeoutSignal:()=>new AbortController().signal};
  const globals={fetch,Error,TypeError,setTimeout:callback=>{callback();return 0;}};
  vm.runInNewContext(apiSource,{...globals,exports:api,require:()=>timeout});
  vm.runInNewContext(source,{...globals,exports,
    require:name=>{if(name==='@/lib/client-api')return api;assert.equal(name,'@/lib/timeout-signal');return timeout;}});
  return exports.verifyAccessCode;
}

test('an HTML gateway response retries the same access verification and succeeds only on confirmed JSON',async()=>{
  const calls=[],retries=[];
  const verify=load(async(url,options)=>{calls.push({url,...options});return calls.length===1
    ? new Response('<html>Gateway Timeout</html>',{status:504}):Response.json({verified:true});});
  await verify('synthetic-code',attempt=>retries.push(attempt));
  assert.deepEqual(retries,[2]);assert.equal(calls.length,2);
  assert.ok(calls.every(call=>call.url==='/api/access/verify'&&call.body===JSON.stringify({accessCode:'synthetic-code'})));
  assert.ok(calls.every(call=>call.redirect==='error'&&call.credentials==='same-origin'&&call.cache==='no-store'));
});

test('persistent HTML, truncated JSON and invalid success payloads never authorize entry or expose syntax errors',async()=>{
  for(const makeResponse of [()=>new Response('<html>busy</html>',{status:200}),
    ()=>new Response('{"verified":', {status:200}),()=>Response.json({verified:false}),()=>Response.json({saved:true}),
    ()=>Response.json({verified:'true'})]) {
    let count=0;
    const verify=load(async()=>{count++;return makeResponse();});
    await assert.rejects(()=>verify('synthetic-code',()=>{}),error=>!error.message.includes('Unexpected token')&&!error.message.includes('JSON')&&error.status===502);
    assert.equal(count,3);
  }
});

test('wrong codes, forbidden origins, missing routes and absent configuration are not retried',async()=>{
  for(const [status,code] of [[401,'INVALID_ACCESS_CODE'],[403,'INVALID_ORIGIN'],[404,'NOT_FOUND'],[503,'ACCESS_CODE_NOT_CONFIGURED']]) {
    let count=0,retries=0;
    const verify=load(async()=>{count++;return Response.json({error:{code,message:'可读的服务端提示'}},{status});});
    await assert.rejects(()=>verify('synthetic-code',()=>retries++),error=>error.code===code&&error.message==='可读的服务端提示');
    assert.equal(count,1);assert.equal(retries,0);
  }
});

test('HTML missing-route errors remain readable and never bypass the access gate',async()=>{
  let count=0;
  const verify=load(async()=>{count++;return new Response('<html>Not found</html>',{status:404});});
  await assert.rejects(()=>verify('synthetic-code',()=>{}),error=>error.status===404&&!error.message.includes('<html>'));
  assert.equal(count,1);
});

test('temporary network failures and old-browser timeouts retry with bounded attempts',async()=>{
  for(const name of ['TypeError','AbortError','TimeoutError']) {
    let count=0;
    const verify=load(async()=>{if(++count===1)throw Object.assign(new Error('raw browser network failure'),{name});return Response.json({verified:true});});
    await verify('synthetic-code',()=>{});assert.equal(count,2);
    const offline=load(async()=>{throw Object.assign(new Error('raw browser network failure'),{name});});
    await assert.rejects(()=>offline('synthetic-code',()=>{}),/连接中断或超时/);
  }
});

test('rate limits retry without forwarding the password to a redirected destination',async()=>{
  let calls=0;
  const verify=load(async(_url,options)=>{
    calls++;assert.equal(options.redirect,'error');
    return calls===1 ? Response.json({error:{code:'RATE_LIMIT'}},{status:429}):Response.json({verified:true});
  });
  await verify('synthetic-code',()=>{});assert.equal(calls,2);
});

const formSource=ts.transpileModule(await readFile('app/access/access-code-form.tsx','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2017,jsx:ts.JsxEmit.ReactJSX},
}).outputText;
function formHarness(verify,configured=true) {
  const hooks=[],navigations=[],exports={};let cursor=0;
  const modules={
    react:{useState:initial=>{const index=cursor++;if(!(index in hooks))hooks[index]=initial;return [hooks[index],value=>{hooks[index]=value;}];},
      useRef:initial=>{const index=cursor++;if(!(index in hooks))hooks[index]={current:initial};return hooks[index];}},
    'react/jsx-runtime':jsx,'@/lib/access-verification':{verifyAccessCode:verify},
    '../fullscreen-controller':{requestExperimentFullscreen:()=>new Promise(()=>{})},'../brand-logo':{BrandLogo:()=>null},
  };
  vm.runInNewContext(formSource,{exports,Error,window:{location:{replace:path=>navigations.push(path)}},
    require:name=>{assert.ok(name in modules,name);return modules[name];}});
  function render(){cursor=0;return exports.AccessCodeForm({configured,nextPath:'/join/abcd'});}
  function find(type,node=render()) {
    if(!node||typeof node!=='object')return null;
    if(node.type===type)return node;
    for(const child of [node.props?.children].flat(Infinity)){if(child===undefined)continue;const found=find(type,child);if(found)return found;}
    return null;
  }
  return {find,navigations,enter:code=>find('input').props.onChange({target:{value:code}}),submit:()=>find('form').props.onSubmit({preventDefault(){}})};
}

test('the real form verifies despite a pending fullscreen request and ignores duplicate submit clicks',async()=>{
  let respond,calls=0;
  const form=formHarness(load(async()=>{calls++;return new Promise(resolve=>{respond=resolve;});}));
  form.enter('synthetic-code');
  const first=form.submit();await form.submit();
  assert.equal(calls,1);assert.equal(form.find('button').props.disabled,true);
  assert.deepEqual(form.navigations,[]);
  respond(Response.json({verified:true}));await first;
  assert.deepEqual(form.navigations,['/join/abcd']);
});

test('the real form retains the access code and permits retry after persistent HTML responses',async()=>{
  const form=formHarness(load(async()=>new Response('<html>Gateway error</html>',{status:502})));
  form.enter('synthetic-code');await form.submit();
  assert.equal(form.find('input').props.value,'synthetic-code');
  assert.equal(form.find('button').props.disabled,false);assert.deepEqual(form.navigations,[]);
  const error=form.find('p',form.find('form'));
  assert.equal(error.props.role,'alert');assert.match(error.props.children,/访问验证服务/);
  assert.doesNotMatch(error.props.children,/Unexpected token|JSON|<html>/);
});

test('the real form keeps incorrect-code errors editable and configuration absence cannot authorize entry',async()=>{
  let calls=0;
  const verify=load(async()=>{calls++;return Response.json({error:{code:'INVALID_ACCESS_CODE',message:'访问码不正确，请重新输入。'}},{status:401});});
  const form=formHarness(verify);form.enter('wrong');await form.submit();
  assert.equal(calls,1);assert.equal(form.find('input').props.value,'wrong');assert.equal(form.find('button').props.disabled,false);
  const unconfigured=formHarness(verify,false);unconfigured.enter('synthetic-code');await unconfigured.submit();
  assert.equal(calls,1);assert.equal(unconfigured.find('input').props.disabled,true);
  assert.deepEqual(unconfigured.navigations,[]);
});
