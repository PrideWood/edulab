import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { NextRequest, NextResponse } from 'next/server.js';
import nextTesting from 'next/experimental/testing/server.js';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

const compile = async file => ts.transpileModule(await readFile(file,'utf8'), {
  compilerOptions:{ module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX },
}).outputText;
const [accessSource,proxySource,homeSource,logoSource] = await Promise.all([
  compile('lib/access-code.ts'),compile('proxy.ts'),compile('app/page.tsx'),compile('app/brand-logo.tsx'),
]);
function evaluate(source,modules={},env={}) {
  const exports = {};
  vm.runInNewContext(source,{ exports,URL,TextEncoder,crypto:webcrypto,process:{env},
    require:name => { if (!(name in modules)) throw new Error(`Unexpected dependency: ${name}`); return modules[name]; },
  });
  return exports;
}
const access = evaluate(accessSource);
const code = 'synthetic-classroom-access';
const guard = configured => evaluate(proxySource,{
  'next/server':{NextRequest,NextResponse},'@/lib/access-code':access,
},{ACCESS_CODE:configured});
const request = (path,cookie) => new NextRequest(`https://school.example${path}`,{
  headers:cookie ? {cookie:`${access.ACCESS_COOKIE}=${cookie}`} : {},
});
const matches = (config,url) => nextTesting.unstable_doesMiddlewareMatch({config,nextConfig:{},url});
const studentPaths = ['/api/sessions','/api/sessions/resume','/api/sessions/draft','/api/sessions/checkpoint',
  '/api/sessions/complete','/api/sessions/reset','/api/messages','/api/conversations','/api/participant-profile'];

test('bare domain renders only teacher-link guidance and never loads the experiment or database', () => {
  const logo = evaluate(logoSource,{'react/jsx-runtime':jsxRuntime,'next/image':{default:props => jsxRuntime.jsx('img',{src:props.src,alt:props.alt,width:props.width,height:props.height,className:props.className}),__esModule:true}});
  const home = evaluate(homeSource,{'react/jsx-runtime':jsxRuntime,'./brand-logo':logo});
  const html = renderToStaticMarkup(home.default());
  assert.match(html,/请使用教师提供的实验链接进入/);
  assert.doesNotMatch(html,/<form|<input|<textarea|首次参加实验|继续之前的实验/);
  const {config} = guard(code);
  for (const url of ['/','/?participant=P001&access=old-link-signature','/admin','/access']) assert.equal(matches(config,url),false);
});

test('every direct group link requires access verification and preserves its exact return URL', async () => {
  const {proxy,config} = guard(code);
  for (const path of ['/join/abcd','/join/qrst','/join/ABCD?participant=P001','/join/abcd-2345']) {
    assert.equal(matches(config,path),true);
    const response = await proxy(request(path));
    assert.equal(response.status,307);
    const location = new URL(response.headers.get('location'));
    assert.equal(location.pathname,'/access');
    assert.equal(location.searchParams.get('next'),path);
  }
  for (const path of studentPaths) {
    assert.equal(matches(config,path),true);
    const response = await proxy(request(`${path}?entry=abcd`));
    assert.equal(response.status,401);
    assert.equal((await response.json()).error.code,'ACCESS_REQUIRED');
  }
});

test('correct access verification admits group links; wrong, tampered or obsolete credentials cannot bypass it', async () => {
  const {proxy} = guard(code);
  assert.equal(await access.verifySubmittedAccessCode('wrong',code),false);
  assert.equal(await access.verifySubmittedAccessCode(code,code),true);
  const cookie = await access.createAccessCookieValue(code);
  for (const path of ['/join/abcd','/join/qrst']) {
    const admitted = await proxy(request(path,cookie));
    assert.equal(admitted.headers.get('x-middleware-next'),'1');
    for (const invalid of ['untrusted',`${cookie}tampered`,await access.createAccessCookieValue('previous-code')]) {
      assert.equal((await proxy(request(path,invalid))).status,307);
    }
  }
});

test('even verified browsers cannot access student APIs without a group entry', async () => {
  const {proxy} = guard(code);
  const cookie = await access.createAccessCookieValue(code);
  for (const path of studentPaths) {
    for (const suffix of ['','?entry=','?entry=%20%20']) {
      const response = await proxy(request(path+suffix,cookie));
      assert.equal(response.status,400);
      assert.equal((await response.json()).error.code,'ENTRY_REQUIRED');
    }
    const admitted = await proxy(request(`${path}?entry=abcd`,cookie));
    assert.equal(admitted.headers.get('x-middleware-next'),'1');
  }
});

test('missing access-code configuration fails closed for group pages and student APIs', async () => {
  const {proxy} = guard(undefined);
  const cookie = await access.createAccessCookieValue(code);
  const page = await proxy(request('/join/abcd',cookie));
  assert.equal(page.status,307);
  assert.equal(new URL(page.headers.get('location')).searchParams.get('configuration'),'missing');
  const api = await proxy(request('/api/sessions?entry=abcd',cookie));
  assert.equal(api.status,503);
  assert.equal((await api.json()).error.code,'ACCESS_CODE_NOT_CONFIGURED');
});
